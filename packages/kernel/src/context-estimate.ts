/**
 * 上下文占用估算（内核侧纯函数，无 IO）。
 *
 * 背景：pi 引擎上报的 `contextUsage.tokens` = 最后一条有效 assistant 的 usage +
 * 其后新增消息按「字符数 / 4」估算。该口径对 CJK 严重低估（中文实测约 1.48 tok/字，
 * 估算只有 0.25），长中文会话下内核按 `0.8 × contextWindow` 判定会永远不触发压缩，
 * 而请求实际已越过上游窗口边界 → 上游持续返回 400 且永久卡死。
 *
 * 本模块复刻 pi 的估算口径（compaction.estimateTokens），但把 CJK 字符按 4 个字符
 * 当量计（等价 ≈1 tok/字），让内核侧判定更接近真实占用。仅供「发送前是否需要压缩」
 * 的保守判断使用，不参与任何持久化或展示。
 */

/** CJK 字符当量：汉字/全角标点/假名/韩文按 4 计（÷4 后 ≈1 tok/字） */
export const CJK_CHAR_WEIGHT = 4;
/** 基准换算：每 4 个字符当量 ≈ 1 token（与 pi 的 chars/4 口径一致） */
const CHARS_PER_TOKEN = 4;
/** 图片字符当量：与 pi compaction 的 ESTIMATED_IMAGE_CHARS 对齐 */
export const ESTIMATED_IMAGE_CHARS = 4800;
/** 尾部（锚点之后）估算的安全系数：这部分是估算值，锚点 usage 是精确值，只对尾部放大 */
export const ESTIMATE_SAFETY = 1.15;

/** 判断一个码点是否属于 CJK（汉字 / 全角标点 / 假名 / 韩文） */
function isCjkCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x11ff) || // 韩文字母
		(cp >= 0x2e80 && cp <= 0x2eff) || // CJK 部首补充
		(cp >= 0x3000 && cp <= 0x303f) || // CJK 符号与标点（含全角标点）
		(cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
		(cp >= 0x3130 && cp <= 0x318f) || // 韩文兼容字母
		(cp >= 0x31c0 && cp <= 0x31ef) || // CJK 笔画
		(cp >= 0x3200 && cp <= 0x33ff) || // 带圈 / 方块 CJK 字符
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区（汉字）
		(cp >= 0xac00 && cp <= 0xd7af) || // 韩文音节
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式（全角标点）
		(cp >= 0xff00 && cp <= 0xffef) || // 全角 ASCII / 半角假名
		(cp >= 0x20000 && cp <= 0x2a6df) || // CJK 扩展 B
		(cp >= 0x2a700 && cp <= 0x2ebef) || // CJK 扩展 C/D/E/F
		(cp >= 0x2f800 && cp <= 0x2fa1f) // CJK 兼容补充
	);
}

/** 文本的加权字符当量：CJK 按 CJK_CHAR_WEIGHT 计，其余按 1 计 */
export function charWeighted(text: string): number {
	let weight = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		weight += isCjkCodePoint(cp) ? CJK_CHAR_WEIGHT : 1;
	}
	return weight;
}

/** 文本的 token 估算（= ceil(加权字符数 / 4)） */
export function estimateTextTokens(text: string): number {
	return Math.ceil(charWeighted(text) / CHARS_PER_TOKEN);
}

/** 内容块（string | ContentBlock[]）的加权字符当量：text 按加权计，image 按固定当量计 */
function contentChars(content: unknown): number {
	if (typeof content === "string") return charWeighted(content);
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as any[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			chars += charWeighted(block.text);
		} else if (block?.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 单条消息的 token 估算，复刻 pi compaction.estimateTokens 的分角色口径：
 * - user / custom / toolResult：content（text + image）
 * - assistant：text + thinking + toolCall（name + JSON.stringify(arguments)）
 * - bashExecution / branchSummary / compactionSummary：按 pi 同样纳入口径
 */
export function estimateMessageTokens(message: any): number {
	if (!message || typeof message !== "object") return 0;
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			return Math.ceil(contentChars(message.content) / CHARS_PER_TOKEN);
		case "assistant": {
			let chars = 0;
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") {
					chars += charWeighted(block.text);
				} else if (
					block?.type === "thinking" &&
					typeof block.thinking === "string"
				) {
					chars += charWeighted(block.thinking);
				} else if (block?.type === "toolCall") {
					// 参数序列化后按加权字符计（中文字符参数同样不低估）
					const name = typeof block.name === "string" ? block.name : "";
					chars += charWeighted(name + JSON.stringify(block.arguments ?? {}));
				}
			}
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "system": {
			// pi 0.86+ 系统提示消息：正文在 sections（content 常为空串），漏算会低估占用判定（提前触发压缩）
			let chars = contentChars(message.content);
			const sections = (message.sections ?? {}) as Record<string, string>;
			for (const v of Object.values(sections)) {
				if (typeof v === "string") chars += charWeighted(v);
			}
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "bashExecution":
			return Math.ceil(
				charWeighted(`${message.command ?? ""}${message.output ?? ""}`) /
					CHARS_PER_TOKEN,
			);
		case "branchSummary":
		case "compactionSummary":
			return Math.ceil(charWeighted(`${message.summary ?? ""}`) / CHARS_PER_TOKEN);
		default:
			return 0;
	}
}

/** 从 usage 计算上下文 token（对齐 pi calculateContextTokens：totalTokens 优先，否则各分量求和） */
function contextTokensFromUsage(usage: any): number {
	if (!usage || typeof usage !== "object") return 0;
	const parts =
		(usage.input ?? 0) +
		(usage.output ?? 0) +
		(usage.cacheRead ?? 0) +
		(usage.cacheWrite ?? 0);
	return typeof usage.totalTokens === "number" && usage.totalTokens > 0
		? usage.totalTokens
		: parts;
}

export interface ContextEstimate {
	/** 估算总占用 = usageTokens + trailingTokens */
	tokens: number;
	/** 最后一条有效 assistant usage 的精确 token（无锚点为 0） */
	usageTokens: number;
	/** 锚点之后消息的加权估算（已乘 ESTIMATE_SAFETY；无锚点时为全量估算） */
	trailingTokens: number;
	/** 锚点在 messages 中的下标（无锚点为 null） */
	lastUsageIndex: number | null;
}

/**
 * 估算一组消息的上下文占用。
 *
 * 锚点选择（从后往前找第一条满足条件的 assistant）：stopReason 非 error/aborted、
 * 有 usage 且 usage > 0；若给了 `afterTs`（上次压缩时刻），锚点必须晚于它，否则
 * 不使用锚点（压缩前的 usage 反映的是压缩前的上下文，不可作锚点）。
 *
 * - 有锚点：tokens = 锚点 usage + 其后消息估算 × ESTIMATE_SAFETY（锚点精确，不乘系数）
 * - 无锚点：tokens = 全量消息估算 × ESTIMATE_SAFETY
 *
 * 注意：无锚点时的全量估算假定 messages 是「压缩后的实际上下文」；调用方在压缩完成后
 * 需刷新消息快照（见 agent-manager 的 compaction_end 处理），否则会把压缩前历史重复计入。
 */
export function estimateContextTokens(
	messages: any[],
	opts: { afterTs?: number } = {},
): ContextEstimate {
	const { afterTs } = opts;
	const list = Array.isArray(messages) ? messages : [];

	let lastUsageIndex: number | null = null;
	let usageTokens = 0;
	for (let i = list.length - 1; i >= 0; i--) {
		const msg = list[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
		const tokens = contextTokensFromUsage(msg.usage);
		if (tokens <= 0) continue;
		if (typeof afterTs === "number") {
			// 时间戳乱序（从后往前更早）→ 之后的锚点只会更旧，直接放弃锚点
			if (typeof msg.timestamp !== "number" || msg.timestamp <= afterTs) break;
		}
		lastUsageIndex = i;
		usageTokens = tokens;
		break;
	}

	if (lastUsageIndex === null) {
		let estimated = 0;
		for (const msg of list) estimated += estimateMessageTokens(msg);
		const tokens = Math.ceil(estimated * ESTIMATE_SAFETY);
		return {
			tokens,
			usageTokens: 0,
			trailingTokens: tokens,
			lastUsageIndex: null,
		};
	}

	let trailing = 0;
	for (let i = lastUsageIndex + 1; i < list.length; i++) {
		trailing += estimateMessageTokens(list[i]);
	}
	const trailingTokens = Math.ceil(trailing * ESTIMATE_SAFETY);
	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex,
	};
}
