// session-history.ts — 从 pi 会话 JSONL 文件直读历史消息（不启动 pi 进程）
//
// 背景：session:messages 旧路径要 ensureStarted 拉起完整 pi rpc 进程才能拿历史，
// 冷启动数秒。pi 会话文件（version 3）是 append-only JSONL 日志，每行一个事件：
//   {"type":"session","version":3,"id":<sessionUuid>,...}        文件头（不进事件树）
//   {"type":"model_change"|"thinking_level_change"|..., id, parentId, timestamp, ...}
//   {"type":"message", id, parentId, timestamp, message: AgentMessage}
// id/parentId 构成事件树（重试/编辑会产生分支）；「当前分支」= 从最新叶子沿 parentId
// 回溯到根（append-only 日志最新操作总在文件末尾）。本模块只取当前分支上
// type==="message" 的条目，返回 message 字段序列——与 RPC get_messages 同语义。
//
// 只读解析，容错：坏行跳过；文件不存在/无任何有效行时抛错，由调用方回退进程路径。

import { readFile } from "node:fs/promises";
import { reconcileDanglingAsks } from "./ask-tool";
import { isTransientErrorMessage } from "./sdk-errors";
import type { AgentMessage } from "@wa-pi/shared";
import { KernelError } from "./kernel-error";

interface SessionLogEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: unknown;
	/** compaction 节点：压缩后保留的第一条 entry id（与 pi buildContextEntries 语义对齐） */
	firstKeptEntryId?: string;
	/** compaction 节点：压缩摘要文本 */
	summary?: string;
	/** compaction 节点：压缩前上下文 token 估算 */
	tokensBefore?: number;
}

/**
 * 判断一条历史消息是否为「应过滤的 transient 错误消息」。
 * 仅匹配 assistant 角色 + stopReason:error + 网络类 errorMessage 的条目。
 */
function isTransientAssistantError(message: any): boolean {
	if (!message || typeof message !== "object") return false;
	if (message.role !== "assistant" || message.stopReason !== "error")
		return false;
	return isTransientErrorMessage(message.errorMessage ?? "");
}

/**
 * 判断一条历史消息是否为「失败的 assistant 回复」（任意 error，含 transient + fatal）。
 */
function isFailedAssistant(message: any): boolean {
	return (
		!!message &&
		typeof message === "object" &&
		message.role === "assistant" &&
		message.stopReason === "error"
	);
}

/**
 * 判断位置 i 处是否为一个「失败回合」的起点（user 消息，且下一条是 error assistant）。
 */
function isFailedTurnStart(msgs: any[], i: number): boolean {
	return (
		msgs[i]?.role === "user" &&
		i + 1 < msgs.length &&
		isFailedAssistant(msgs[i + 1])
	);
}

/** 提取 user 消息的文本内容，用于判断是否为重发（相同文本）。 */
function userText(m: any): string {
	if (!m || m.role !== "user") return "";
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text ?? "")
			.join("");
	}
	return "";
}

/**
 * 失败回合去重：重发导致的连续「user + error assistant」失败对折叠到只剩最后一组。
 *
 * 重发失败消息时 pi 每次都 append 进 jsonl，刷新后出现多条相同的 user 发送记录。
 * 折叠规则：一对失败回合，若下一对也是失败回合且 user 文本相同（重发），则折叠当前这组。
 * 这样既消除重发堆积，又保留：
 *   - 最后一组失败回合（fatal error 需提示用户改配置）
 *   - 连续失败后成功的场景（前面失败组被折叠，只剩成功回合）
 *   - 非连续的不同问题失败（各自保留）
 */
function dedupeConsecutiveFailedTurns(msgs: any[]): any[] {
	const result: any[] = [];
	for (let i = 0; i < msgs.length; i++) {
		// 当前是失败回合起点，且下一对也是失败回合且是相同文本的重发 → 折叠当前组
		// 或下一对是同文本 user 后跟成功（重发后成功）→ 也折叠当前失败组
		if (isFailedTurnStart(msgs, i)) {
			const nextUser = msgs[i + 2];
			if (
				nextUser?.role === "user" &&
				userText(nextUser) === userText(msgs[i])
			) {
				i++; // 跳过 user + error assistant 两条
				continue;
			}
		}
		result.push(msgs[i]);
	}
	return result;
}

/**
 * 轮级耗时注入（纯读推算，零写入）：按 user 消息切轮，对"成功完成"的轮
 * （该轮最后一条 assistant 的 stopReason !== "error"）计算
 * turnElapsedMs = 最后 assistant 行落盘时刻 − user 行落盘时刻，注入到该轮最后一条
 * assistant 消息。失败回合（error 结尾）/无 user/无 assistant 结束的轮不注入。
 * 用行级 _lineTs（jsonl 每行落盘 timestamp）而非 message.timestamp——
 * Pi 单块轮 assistant 消息对象在 prompt 时预创建，message.timestamp ≈ user 时刻
 * （差 <1s），真实耗时只有落盘时刻可靠。旧 jsonl 无字段时前端自然降级为无时长。
 */
function injectTurnElapsedMs(msgs: AgentMessage[]): AgentMessage[] {
	let turnUserTs: number | undefined;
	let lastAsstIdx = -1;
	let lastAsstError = false;
	const settleTurn = () => {
		if (turnUserTs !== undefined && lastAsstIdx >= 0 && !lastAsstError) {
			const a = msgs[lastAsstIdx] as any;
			// 行级 timestamp 缺失/无法解析时 _lineTs 为 undefined/NaN——直接相减会注入 NaN
			// （前端显示 NaN 分 NaN 秒），此时不注入，前端自然降级为无时长。
			if (Number.isFinite(a._lineTs) && Number.isFinite(turnUserTs)) {
				a.turnElapsedMs = a._lineTs - turnUserTs;
			}
		}
	};
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i] as any;
		if (m?.role === "user") {
			settleTurn();
			turnUserTs = m._lineTs;
			lastAsstIdx = -1;
			lastAsstError = false;
		} else if (m?.role === "assistant") {
			lastAsstIdx = i;
			lastAsstError = m.stopReason === "error";
		}
	}
	settleTurn();
	// 清理注入用的临时字段，避免泄漏到前端
	for (const m of msgs) delete (m as any)._lineTs;
	return msgs;
}

/**
 * 解析 pi 会话文件，返回当前分支的历史消息（含 reconcileDanglingAsks 对账）。
 * @param opts.isSessionActive 当 session 仍在活跃运行时跳过 dangling ask 对账
 * @throws 文件不可读或没有任何有效 JSON 行（格式变更/损坏）——调用方应回退进程路径。
 */
export async function readSessionHistory(
	file: string,
	opts?: { isSessionActive?: boolean },
): Promise<AgentMessage[]> {
	const raw = await readFile(file, "utf8"); // ENOENT 等直接抛 → 回退
	const entries: SessionLogEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e === "object") entries.push(e as SessionLogEntry);
		} catch {
			// 坏行跳过（写入中途截断等）
		}
	}
	if (entries.length === 0) throw new KernelError("session.noValidLines", undefined, file);

	const byId = new Map<string, SessionLogEntry>();
	for (const e of entries) {
		if (typeof e.id === "string" && e.type !== "session") byId.set(e.id, e);
	}

	// 从叶子沿 parentId 回溯，收集当前分支的 message 条目（根→叶顺序）
	const collectFrom = (leaf: SessionLogEntry | undefined): unknown[] => {
		const chain: SessionLogEntry[] = [];
		const visited = new Set<string>();
		let cur = leaf;
		while (cur && typeof cur.id === "string" && !visited.has(cur.id)) {
			visited.add(cur.id);
			chain.push(cur);
			cur =
				typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
		}
		chain.reverse();

		// 压缩感知：与 pi buildContextEntries 同语义——沿链找最新 compaction 节点，
		// 若存在，被压缩的旧消息省略，上下文 = [compaction 摘要] + [firstKeptEntryId 之后
		// 的旧消息] + [compaction 之后的新消息]。否则旧消息全部保留（未压缩会话）。
		// pi 压缩是 append-only（compaction 节点后旧消息仍在链上），不感知的话
		// 直读 jsonl 会把压缩前的全部 usage 累加进 token 累计、历史列表也不变。
		let compaction: SessionLogEntry | undefined;
		for (const e of chain) {
			if (e.type === "compaction") compaction = e;
		}
		let visible = chain;
		if (compaction) {
			const cIdx = chain.findIndex((e) => e.id === compaction.id);
			if (cIdx >= 0) {
				const keptId = compaction.firstKeptEntryId;
				const kept: SessionLogEntry[] = [];
				let foundKept = false;
				for (let i = 0; i < cIdx; i++) {
					const e = chain[i];
					if (typeof keptId === "string" && e.id === keptId) foundKept = true;
					if (foundKept) kept.push(e);
				}
				visible = [compaction, ...kept, ...chain.slice(cIdx + 1)];
			}
		}

		const msgs = visible
			.filter(
				(e): e is SessionLogEntry & { message: any; timestamp?: string } =>
					e.type === "message" && e.message != null,
			)
			// 浅拷贝 + 附加行级落盘时刻（Pi 单块轮 assistant 消息在 prompt 时预创建，
			// message.timestamp 不可靠 ≈ user 时刻；真实耗时在 jsonl 每行的落盘 timestamp）
			.map((e) => ({
				...(e.message as any),
				_lineTs: e.timestamp ? Date.parse(e.timestamp) : undefined,
			}));
		// 压缩节点转摘要消息（与 pi createCompactionSummaryMessage 对齐：role=compactionSummary）
		if (compaction && typeof (compaction as any).summary === "string") {
			const c = compaction as any;
			msgs.unshift({
				role: "compactionSummary",
				summary: c.summary,
				tokensBefore: c.tokensBefore,
				timestamp: c.timestamp ? Date.parse(c.timestamp) : undefined,
				_lineTs: c.timestamp ? Date.parse(c.timestamp) : undefined,
			});
		}
		// 过滤 transient error（网络/超时类临时错误）：这类错误是临时性的，
		// 不应作为历史消息残留进对话流（刷新后会重新出现并堆积）。
		// pi 已将其落盘，这里在读出时剔除——仅前端展示层过滤，JSONL 原文不动。
		// fatal error（鉴权/配额）保留，需提示用户改配置。
		let filtered = msgs.filter((m: any) => !isTransientAssistantError(m));
		// 失败回合去重：连续的「user + error assistant」失败对，只保留最后一组。
		// 根因：重发失败消息时 pi 每次都 append 进 jsonl，刷新后出现多条相同 user
		// 发送记录。去重规则——若一对失败回合（user + 紧跟的 error assistant）后面
		// 紧接着又是失败回合，则前一对折叠掉。fatal error 仍保留（最后一组）。
		filtered = dedupeConsecutiveFailedTurns(filtered);
		return filtered;
	};

	// 叶子候选 1：文件末尾向前找第一个事件树节点
	let leaf: SessionLogEntry | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (typeof e.id === "string" && e.type !== "session") {
			leaf = e;
			break;
		}
	}
	let messages = collectFrom(leaf);

	// 极端情况：叶子链上没有 message（如末尾是非消息事件且链断裂），
	// 但文件里确实有 message → 以最后一条 message 为叶子重来
	if (
		messages.length === 0 &&
		entries.some((e) => e.type === "message" && e.message != null)
	) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message != null) {
				leaf = e;
				break;
			}
		}
		messages = collectFrom(leaf);
	}

	// 重启兜底：对「无 result 的 ask 调用」注入 cancelled（若 session 活跃则跳过，避免误杀 pending ask）
	// 解析器仅产出有效 message 条目（见上方 filter），这里收窄为 AgentMessage[]。
	return injectTurnElapsedMs(
		reconcileDanglingAsks(messages, {
			isSessionActive: opts?.isSessionActive,
		}) as AgentMessage[],
	);
}

/** 全会话 token 累计统计（含缓存读取/写入、压缩前的历史消耗）。 */
export interface SessionUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** computeSessionUsage 的返回：主代理 / 子代理拆分。 */
export interface SessionUsageSplit {
	/** 主代理：assistant message usage + compaction/branch_summary 生成消耗（对齐官方 totals） */
	main: SessionUsageSummary;
	/** 子代理：toolResult.usage（delegate/fleet 结果携带的子进程 LLM 消耗） */
	subagent: SessionUsageSummary;
}

/**
 * 计算整个会话累计消耗的 token 数，按主/子代理拆分（供 UI「累计 xxx k」胶囊使用）。
 *
 * 与 readSessionHistory 的关键区别：readSessionHistory 为历史列表显示做压缩感知过滤
 * （被压缩的旧消息省略），token 累计若基于它会丢失压缩前的消耗、看起来像
 * 「当前上下文窗口占用」而非「累计消耗」；本函数扫描 jsonl 中全部条目
 * （不做压缩过滤、不做分支过滤），口径对齐 pi RPC get_session_stats：
 * - assistant message.usage → main
 * - compaction / branch_summary 条目的 usage（摘要生成消耗）→ main
 * - toolResult message.usage（工具内嵌 LLM 消耗，即 delegate/fleet 子代理）→ subagent
 *
 * usage 为 0 的条目（error 消息、pending 占位等）自然被跳过。
 *
 * @throws 文件不可读或没有任何有效 JSON 行——调用方应回退进程路径或返回空统计。
 */
export async function computeSessionUsage(
	file: string,
): Promise<SessionUsageSplit> {
	const raw = await readFile(file, "utf8"); // ENOENT 等直接抛 → 调用方降级
	const main = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const subagent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let sawAny = false;
	const add = (
		acc: { input: number; output: number; cacheRead: number; cacheWrite: number },
		u: any,
	) => {
		acc.input += u.input ?? 0;
		acc.output += u.output ?? 0;
		acc.cacheRead += u.cacheRead ?? 0;
		acc.cacheWrite += u.cacheWrite ?? 0;
	};
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // 坏行跳过（与 readSessionHistory 一致）
		}
		if (!e || typeof e !== "object") continue;
		// compaction / branch_summary 条目：摘要生成的 LLM 消耗计入主代理（对齐官方 totals）
		if (
			(e.type === "compaction" || e.type === "branch_summary") &&
			e.usage
		) {
			sawAny = true;
			add(main, e.usage);
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message;
		if (!m) continue;
		if (m.role === "assistant" && m.usage) {
			sawAny = true;
			add(main, m.usage);
		} else if (m.role === "toolResult" && m.usage) {
			// 工具内嵌 LLM 消耗（delegate/fleet 子代理）：计入子代理拆分
			sawAny = true;
			add(subagent, m.usage);
		}
	}
	if (!sawAny && raw.trim().length === 0) {
		throw new KernelError("session.noValidLines", undefined, file);
	}
	const withTotal = (a: typeof main): SessionUsageSummary => ({
		...a,
		total: a.input + a.output + a.cacheRead + a.cacheWrite,
	});
	return { main: withTotal(main), subagent: withTotal(subagent) };
}
