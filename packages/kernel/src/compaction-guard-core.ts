// compaction-guard.ts —— 压缩守卫的纯逻辑（不依赖 pi 包，便于单测）
//
// 背景：pi 内置压缩摘要的输出预算是 `0.8 × reserveTokens`（默认 16384 → 13107），
// 长会话写详尽摘要必然被输出上限截断；而 pi ≥0.85 把 `stopReason === "length"` 判为
// 失败、整份作废，且输入侧不设上限（会话超窗口后压缩永久失败，见 pi issue #8371/#8196），
// 表现为「每轮都压缩失败」的刷屏死循环。
//
// 本模块给出三条纯函数策略（由 compaction-guard.extension.ts 在 pi 进程内使用）：
//   1. planCompactionBudget：输出预算 = min(期望, 模型输出上限, 窗口剩余空间)，与阈值参数解耦
//   2. trimMessagesToBudget：输入超窗口时丢最旧消息、必要时截断文本尾部
//   3. finalizeSummary：摘要被截断时按上限采用（而非整份作废）

/** 摘要输出预算的默认上限（pi 内置等价值为 13107） */
export const DEFAULT_MAX_SUMMARY_TOKENS = 32_768;
/** 预留给系统提示 / 提示词模板 / 估算误差的空间 */
export const DEFAULT_SAFETY_TOKENS = 2_048;
/** 字符 → token 的保守估算（中文约 1 字/token、英文约 4 字符/token，取 3 折中） */
export const DEFAULT_CHARS_PER_TOKEN = 3;
/** 低于该预算就不接管，交回 pi 内置压缩 */
export const DEFAULT_MIN_SUMMARY_TOKENS = 1_024;
/** 截断文本时给「已省略 N 字符」前缀预留的字符数 */
const NOTE_RESERVE_CHARS = 64;
/** 丢弃消息时最多迭代轮数（每轮按比例大幅收敛，避免逐条重算） */
const MAX_DROP_ROUNDS = 12;

/** 保守估算文本占用的 token 数 */
export function estimateTokens(text: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
	if (!text) return 0;
	return Math.ceil(text.length / charsPerToken);
}

export interface BudgetPlan {
	/** 期望输出（已按窗口一半收敛，供输入预算计算） */
	desiredOutput: number;
	/** 最终输出预算（再受窗口剩余空间约束） */
	maxTokens: number;
	/** 扣掉输入与安全余量后的窗口剩余空间（<=0 表示装不下） */
	remaining: number;
}

/**
 * 自动检查上限：算本次摘要能写多长。
 * - 期望输出先受「模型输出上限」约束，再压到「窗口一半」以内，避免把输入空间挤成负数
 * - 最终预算再取「窗口剩余空间 = contextWindow - 输入 - 安全余量」
 * - contextWindow <= 0（拿不到窗口信息）时，只受期望与模型上限约束
 */
export function planCompactionBudget(input: {
	contextWindow: number;
	modelMaxOutput: number;
	wantOutput: number;
	inputTokens: number;
	safetyTokens?: number;
	minSummaryTokens?: number;
}): BudgetPlan {
	const safety = input.safetyTokens ?? DEFAULT_SAFETY_TOKENS;
	const min = input.minSummaryTokens ?? DEFAULT_MIN_SUMMARY_TOKENS;
	const want = Math.min(input.wantOutput, input.modelMaxOutput);

	if (input.contextWindow <= 0) {
		return { desiredOutput: want, maxTokens: Math.max(min, want), remaining: Number.POSITIVE_INFINITY };
	}

	const desiredOutput = Math.min(want, Math.max(min, Math.floor(input.contextWindow / 2)));
	const remaining = input.contextWindow - input.inputTokens - safety;
	return { desiredOutput, maxTokens: Math.max(min, Math.min(desiredOutput, remaining)), remaining };
}

export interface TrimResult<T> {
	/** 保留下来、将进入摘要输入的消息（顺序不变） */
	messages: T[];
	/** 序列化后的摘要输入文本 */
	text: string;
	/** 因超窗口被丢弃的最旧消息条数 */
	dropped: number;
	/** 单条消息超窗口时被截掉的字符数 */
	charsCut: number;
}

/**
 * 输入保护：让摘要输入装进模型窗口。
 * ① 从最旧的消息开始丢弃（保留最近的上下文）
 * ② 只剩一条仍超预算时，截断文本本身并保留尾部
 * 截断后文本长度保证不超过 inputBudgetTokens 对应的字符额度（前缀占用已预留）。
 */
export function trimMessagesToBudget<T>(
	messages: T[],
	opts: {
		inputBudgetTokens: number;
		serialize: (msgs: T[]) => string;
		charsPerToken?: number;
	},
): TrimResult<T> {
	const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	const budget = Math.max(1, opts.inputBudgetTokens);

	let kept = messages;
	let text = opts.serialize(kept);
	let dropped = 0;
	let charsCut = 0;

	// ① 按比例丢弃最旧的消息
	for (let i = 0; i < MAX_DROP_ROUNDS && kept.length > 1; i++) {
		const est = estimateTokens(text, charsPerToken);
		if (est <= budget) break;
		const keepRatio = Math.max(0.05, budget / Math.max(1, est));
		const keep = Math.max(1, Math.floor(kept.length * keepRatio * 0.9));
		dropped += kept.length - keep;
		kept = kept.slice(kept.length - keep);
		text = opts.serialize(kept);
	}

	// ② 单条也装不下 → 截断文本，保留尾部（最近的上下文更重要）
	if (estimateTokens(text, charsPerToken) > budget) {
		const targetChars = Math.max(1, Math.floor(budget * charsPerToken) - NOTE_RESERVE_CHARS);
		if (text.length > targetChars) {
			const tailChars = Math.max(1, targetChars);
			charsCut = text.length - tailChars;
			text = `(前文因超出模型窗口已省略 ${charsCut} 字符)\n…${text.slice(-tailChars)}`;
		}
	}

	return { messages: kept, text, dropped, charsCut };
}

/**
 * 超出上限就按上限返回：`stopReason === "length"` 表示生成被输出上限截断，
 * 此时采用已生成的部分（并标注），而不是像 pi 内置那样整份作废。
 */
export function finalizeSummary(text: string, stopReason: string | undefined, maxTokens: number): string {
	if (stopReason !== "length") return text;
	const formatted = maxTokens.toLocaleString("en-US");
	return `${text}\n\n> ⚠️ 摘要生成达到输出上限（${formatted} tokens）被截断，末尾内容可能不完整。`;
}

/** 取 assistant 回复里的正文，忽略 thinking 与工具调用 */
export function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type?: string; text?: unknown }>) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** 摘要提示词：固定八段结构，要求保留可追溯的细节 */
export const SUMMARY_INSTRUCTION =
	`上面是一段编码会话记录。请只输出结构化摘要，不要继续对话、不要回答问题。使用以下固定格式：\n\n` +
	`## Goal\n## Constraints & Preferences\n## Progress\n### Done\n### In Progress\n### Blocked\n` +
	`## Key Decisions\n## Next Steps\n## Critical Context\n\n` +
	`要求：保留精确的文件路径、函数名、命令与错误信息原文；已完成项与决策要逐条列出；` +
	`各段保持简洁，不要复述原始对话。`;

/** 扩展侧注入的依赖（序列化函数来自 pi 包，其余均可覆盖以便测试） */
export interface CompactionGuardDeps {
	/** 把待摘要消息序列化为文本（扩展注入 pi 的 serializeConversation(convertToLlm(...))） */
	serialize: (messages: unknown[]) => string;
	/** 期望的摘要输出预算上限，默认 32768 */
	wantOutputTokens?: number;
	safetyTokens?: number;
	minSummaryTokens?: number;
	charsPerToken?: number;
}

/**
 * 构造 pi 的 session_before_compact 处理函数：接管压缩并自己生成摘要。
 * 任一步骤无法可靠完成（窗口装不下 / 摘要为空 / 调用出错 / 被取消）都返回 undefined，
 * 由 pi 回退到内置压缩，不改变原有行为。
 */
export function createCompactionGuardHandler(deps: CompactionGuardDeps) {
	return async function handleSessionBeforeCompact(event: any, ctx: any): Promise<unknown> {
		const preparation = event?.preparation;
		const model = ctx?.model;
		const signal: AbortSignal | undefined = event?.signal;
		if (!preparation || !model) return undefined;

		const {
			messagesToSummarize = [],
			turnPrefixMessages = [],
			firstKeptEntryId,
			tokensBefore,
			previousSummary,
		} = preparation;

		// split turn 的前半段一并纳入本次摘要
		const messages: unknown[] = [...messagesToSummarize, ...turnPrefixMessages];
		if (messages.length === 0) return undefined;

		const notify = (message: string, level: "info" | "warning" | "error") => {
			try {
				ctx?.ui?.notify?.(message, level);
			} catch {
				/* 通知失败不影响压缩 */
			}
		};

		try {
			const charsPerToken = deps.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
			const safetyTokens = deps.safetyTokens ?? DEFAULT_SAFETY_TOKENS;
			const minSummaryTokens = deps.minSummaryTokens ?? DEFAULT_MIN_SUMMARY_TOKENS;
			const contextWindow =
				typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 0;
			const modelMaxOutput =
				typeof model.maxTokens === "number" && model.maxTokens > 0
					? model.maxTokens
					: Number.POSITIVE_INFINITY;
			const wantOutput = Math.min(deps.wantOutputTokens ?? DEFAULT_MAX_SUMMARY_TOKENS, modelMaxOutput);

			// ① 先用期望预算给输入留出空间（窗口一半），据此裁剪输入
			const preliminary = planCompactionBudget({
				contextWindow,
				modelMaxOutput,
				wantOutput,
				inputTokens: 0,
				safetyTokens,
				minSummaryTokens,
			});
			const inputBudgetTokens =
				contextWindow > 0 ? Math.max(1, contextWindow - preliminary.desiredOutput - safetyTokens) : Infinity;
			const trimmed = Number.isFinite(inputBudgetTokens)
				? trimMessagesToBudget(messages, { inputBudgetTokens, serialize: deps.serialize, charsPerToken })
				: { messages, text: deps.serialize(messages), dropped: 0, charsCut: 0 };

			// ② 按裁剪后的真实输入定最终预算
			const inputTokens = estimateTokens(trimmed.text, charsPerToken);
			const budget = planCompactionBudget({
				contextWindow,
				modelMaxOutput,
				wantOutput,
				inputTokens,
				safetyTokens,
				minSummaryTokens,
			});
			if (contextWindow > 0 && budget.remaining < minSummaryTokens) {
				notify("压缩守卫：窗口剩余空间不足以生成摘要，交回默认压缩", "warning");
				return undefined;
			}

			// ③ 组装摘要请求
			const omitted: string[] = [];
			if (trimmed.dropped > 0) omitted.push(`已省略 ${trimmed.dropped} 条早期消息`);
			if (trimmed.charsCut > 0) omitted.push(`已省略 ${trimmed.charsCut} 字符`);
			const truncatedNote =
				omitted.length > 0
					? `\n\n(注意：更早的内容因超出模型窗口未能纳入本次摘要，${omitted.join("，")})`
					: "";
			const previousBlock = previousSummary
				? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` +
					`以上是已有摘要，请在此基础上增量更新：保留仍然有效的信息，把已完成的移入 Done，更新 Next Steps。`
				: "";
			const promptText =
				`<conversation>\n${trimmed.text}\n</conversation>${truncatedNote}${previousBlock}\n\n${SUMMARY_INSTRUCTION}`;

			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: promptText }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: budget.maxTokens, signal, cacheRetention: "none" },
			);

			// ④ 超出上限就按上限返回；空摘要 / 取消则交回内置
			if (response?.stopReason === "aborted" || signal?.aborted) return undefined;
			const text = extractAssistantText(response?.content);
			if (!text.trim()) {
				notify("压缩守卫：摘要为空，交回默认压缩", "warning");
				return undefined;
			}

			const summary = finalizeSummary(text, response?.stopReason, budget.maxTokens);
			if (response?.stopReason === "length") {
				notify(`压缩守卫：摘要被输出上限 ${budget.maxTokens} tokens 截断，已按上限采用`, "warning");
			} else {
				notify(`压缩守卫：已生成摘要（输入≈${inputTokens} / 上限 ${budget.maxTokens} tokens）`, "info");
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response?.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(`压缩守卫失败，交回默认压缩：${message}`, "error");
			return undefined;
		}
	};
}
