// packages/kernel/src/subagent-instance-store.ts
// 子代理实例的身份与状态：agentId 生成、路径计算、meta 原子读写。
//
// 布局（规格 §4）：
//   <WA_PI_DIR>/subagents/<parentSessionId>/<agentId>.jsonl      ← pi 直写，完整转录
//   <WA_PI_DIR>/subagents/<parentSessionId>/<agentId>.meta.json  ← 本模块写，身份与状态
//
// 安全：agentId 与 parentSessionId 都参与路径拼接，两者都必须先过白名单校验，
// 否则接口入参可造成路径穿越（规格 §4「路径安全」）。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
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
	if (!SESSION_ID_RE.test(id) || id.includes("..")) {
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
	const dir = subagentDir(parentSessionId);
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
