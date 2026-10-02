// packages/kernel/src/subagent-instance-store.ts
// 子代理实例的身份与状态：agentId 生成、路径计算、meta 原子读写。
//
// 布局（规格 §4）：
//   <WA_PI_DIR>/subagents/<parentSessionId>/<agentId>.jsonl      ← pi 直写，完整转录
//   <WA_PI_DIR>/subagents/<parentSessionId>/<agentId>.meta.json  ← 本模块写，身份与状态
//
// 安全：agentId 与 parentSessionId 都参与路径拼接，两者都必须先过白名单校验，
// 否则接口入参可造成路径穿越（规格 §4「路径安全」）。
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { WA_PI_DIR as WA_PI_DIR_CONST } from "@wa-pi/shared";

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted";

export interface SubagentUsageShape {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	costTotal?: number;
}

export interface SubagentMeta {
	agentId: string;
	parentSessionId: string;
	toolCallId: string;
	/** fleet 内序号；单委托为 null */
	taskIndex: number | null;
	subagentType: string;
	requestedAgent: string;
	task: string;
	status: SubagentStatus;
	createdAt: number;
	updatedAt: number;
	resumeCount: number;
	usage?: SubagentUsageShape;
	elapsedMs?: number;
	toolStats?: { total: number; done: number; error: number; running: number };
}

const AGENT_ID_RE = /^a[0-9a-f]{8}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** 与 delegate-tool 的 subagentResultsDir 同款取法：调用时读 env，测试可隔离 */
function root(): string {
	return join(process.env.WA_PI_DIR || WA_PI_DIR_CONST, "subagents");
}

export function newAgentId(): string {
	return `a${randomBytes(4).toString("hex")}`;
}

export function assertAgentId(id: string): void {
	if (!AGENT_ID_RE.test(id)) {
		throw new Error(`非法的 agent id：${id}（期望 a + 8 位小写 hex）`);
	}
}

function assertSessionId(id: string): void {
	// 纯点形式（"." / ".." / "..."）能钻过白名单正则，且 "." 还能绕过下面的 ".." 检查：
	// join(root, ".") 归一化后**就是 root 本身**，会让 cleanupSubagentDir 删掉整个 subagents/ 根目录。
	if (!SESSION_ID_RE.test(id) || /^\.+$/.test(id) || id.includes("..")) {
		throw new Error(`非法的会话 id：${id}`);
	}
}

export function subagentDir(parentSessionId: string): string {
	assertSessionId(parentSessionId);
	return join(root(), parentSessionId);
}

export function jsonlPath(parentSessionId: string, agentId: string): string {
	assertAgentId(agentId);
	return join(subagentDir(parentSessionId), `${agentId}.jsonl`);
}

export function metaPath(parentSessionId: string, agentId: string): string {
	assertAgentId(agentId);
	return join(subagentDir(parentSessionId), `${agentId}.meta.json`);
}

/** 读 meta：不存在 / 坏 JSON 一律返回 null（调用方按「实例不存在」处理） */
export async function readMeta(
	parentSessionId: string,
	agentId: string,
): Promise<SubagentMeta | null> {
	try {
		const raw = await readFile(metaPath(parentSessionId, agentId), "utf8");
		return JSON.parse(raw) as SubagentMeta;
	} catch {
		return null;
	}
}

/**
 * 删除某个父会话的全部子代理转录（父会话被永久删除时级联调用，规格 §10）。
 * - 目录不存在：静默成功（rm 的 force 幂等）
 * - 非法 sessionId：抛错拒绝。校验**在 try 之外**——它是调用方 bug / 脏数据，必须可见，
 *   并且绝不能带着 "../" 之类的入参继续 rm（那就是路径穿越删目录）
 * - fs 失败：只告警不抛 —— 清理是辅助操作，不得阻断父会话的删除流程
 */
export async function cleanupSubagentDir(parentSessionId: string): Promise<void> {
	assertSessionId(parentSessionId);
	// 前缀断言（第二道防线，不依赖 SESSION_ID_RE 的完备性）：归一化后必须**严格位于**
	// <root>/ 之下。只删 root 的子目录，绝不会是 root 本身或 root 之外——将来若放宽 id 规则
	// （例如允许新的字符集），这里仍由结构保证「只删 <root>/<sessionId>/」。
	const rootAbs = resolve(root());
	const dir = resolve(rootAbs, parentSessionId);
	if (!dir.startsWith(rootAbs + sep)) {
		throw new Error(`非法的会话 id：${parentSessionId}`);
	}
	try {
		await rm(dir, { recursive: true, force: true });
	} catch (e) {
		console.warn(`[subagent] 清理子代理转录目录失败（忽略）: ${dir}`, e);
	}
}

/**
 * 批量清理：逐个独立兜错 —— 单个 id 非法（历史脏数据）或 fs 失败都不影响其它 id，
 * 也不向调用方抛错（永久删除会话的主流程不能被清理拖垮）。
 */
export async function cleanupSubagentDirs(
	parentSessionIds: Iterable<string>,
): Promise<void> {
	for (const id of parentSessionIds) {
		try {
			await cleanupSubagentDir(id);
		} catch (e) {
			console.warn(`[subagent] 跳过非法会话 id 的子代理清理: ${id}`, e);
		}
	}
}

/** 原子写 meta：目录按需创建，先写 .tmp 再 rename，避免半截 JSON 被读到 */
export async function writeMeta(meta: SubagentMeta): Promise<void> {
	const dir = subagentDir(meta.parentSessionId);
	await mkdir(dir, { recursive: true });
	const target = metaPath(meta.parentSessionId, meta.agentId);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
	await rename(tmp, target);
}

/**
 * 把「残留的 running 实例」修正为 interrupted（kernel 启动与优雅退出时各扫一次）。
 *
 * **为什么需要**：meta 的 running → 终态只发生在 delegate-tool 的 settle（`spawn` 返回之后）。
 * kernel / 桌面应用整体退出或被强杀时没有任何代码路径收尾，meta 会永远停在 running：
 * 弹窗永远显示「运行中」、卡片状态错，而且该实例**再也 resume 不了**
 * （会被「正在运行，不能并发续聊」拒掉，而用户无法让它停下来）。
 *
 * **为什么安全**：running 的语义是「本 kernel 正在跑这个实例」。子代理是 kernel 的子进程，
 * kernel 重新启动后不可能存在活着的子代理，所以把残留 running 判为中断是准确的。
 * （唯一反例是两个 kernel 共用同一 `WA_PI_DIR` 且同时运行，属非常规用法。）
 * 子进程本身不必在这里回收：kernel 退出时 stdin 关闭，pi 有 EOF 兜底会自行退出。
 *
 * **容错**：root 不存在、坏 JSON、非法目录名、非 meta 文件一律跳过，整体不抛错——
 * 它挂在启动 / 退出流程上，不能拖垮主流程。返回被修正的实例数。
 */
export async function sweepOrphanRunning(reason: string): Promise<number> {
	let sessions: string[];
	try {
		const entries = await readdir(root(), { withFileTypes: true });
		sessions = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return 0; // root 还不存在（首次启动）等：无事可做
	}
	let fixed = 0;
	for (const sessionId of sessions) {
		let files: string[];
		try {
			files = await readdir(subagentDir(sessionId));
		} catch {
			continue; // 非法目录名（assertSessionId 抛错）或读不到：跳过
		}
		for (const file of files) {
			if (!file.endsWith(".meta.json")) continue;
			const agentId = file.slice(0, -".meta.json".length);
			// readMeta 内部会过 assertAgentId 与 JSON.parse，任一失败都返回 null → 跳过
			const meta = await readMeta(sessionId, agentId);
			if (!meta || meta.status !== "running") continue;
			try {
				await writeMeta({ ...meta, status: "interrupted", updatedAt: Date.now() });
				fixed += 1;
			} catch (e) {
				console.warn(
					`[subagent] 修正残留 running 失败（忽略）: ${sessionId}/${agentId}`,
					e,
				);
			}
		}
	}
	if (fixed > 0) {
		console.warn(
			`[subagent] ${reason}：${fixed} 个实例的进程未正常收尾，已把 running 修正为 interrupted`,
		);
	}
	return fixed;
}
