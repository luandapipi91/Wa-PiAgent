// packages/kernel/src/subagent-delegation-backfill.ts
// 旧 meta（修复前写入、没有 delegations 字段）的历史委派归属回填。
//
// 为什么需要：v0.7.6 起 resume 会把 meta.toolCallId 覆盖为本次委派（本轮弹窗不缺行），
// 历史归属只留在新写入的 delegations 里；修复前落盘的实例没有这个字段，旧那轮弹窗的左栏
// 永远看不到被 resume 走的实例。这里惰性从父会话 jsonl 的 delegate/fleet 工具结果还原归属，
// 只补缺字段的 meta，补一次即落盘（此后列表接口不再读会话日志）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WA_PI_DIR as WA_PI_DIR_CONST } from "@wa-pi/shared";
import { ProjectStore } from "./project-store";
import {
	writeMeta,
	type SubagentDelegation,
	type SubagentMeta,
} from "./subagent-instance-store";

/** 会落子代理转录的工具名（delegate 与旧版 fleet） */
const DELEGATE_TOOLS = new Set(["delegate", "fleet"]);

/**
 * 从会话 jsonl 原文解析 agentId → 参与过的委派（按出现顺序，同一 toolCallId + taskIndex 去重）。
 * 只读工具结果：`details.subagents[]` 是 kernel 自己写的结构化记录（含 resumed 项）。
 * 坏行 / 非 delegate 结果 / 空 agentId 一律跳过，不抛错。
 */
export function parseDelegationsFromSessionLog(
	raw: string,
): Map<string, SubagentDelegation[]> {
	const out = new Map<string, SubagentDelegation[]>();
	for (const line of raw.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		let entry: {
			type?: string;
			message?: {
				role?: string;
				toolCallId?: unknown;
				toolName?: unknown;
				details?: { subagents?: unknown };
			};
		};
		try {
			entry = JSON.parse(text);
		} catch {
			continue;
		}
		const m = entry?.message;
		if (entry?.type !== "message" || m?.role !== "toolResult") continue;
		if (typeof m.toolName !== "string" || !DELEGATE_TOOLS.has(m.toolName)) continue;
		const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
		const subs = m.details?.subagents;
		if (!toolCallId || !Array.isArray(subs)) continue;
		for (const s of subs as Array<{ agentId?: unknown; taskIndex?: unknown }>) {
			const agentId = typeof s?.agentId === "string" ? s.agentId : "";
			if (!agentId) continue;
			const taskIndex = typeof s.taskIndex === "number" ? s.taskIndex : null;
			const list = out.get(agentId) ?? [];
			if (!list.some((d) => d.toolCallId === toolCallId && d.taskIndex === taskIndex)) {
				list.push({ toolCallId, taskIndex });
			}
			out.set(agentId, list);
		}
	}
	return out;
}

/** 与 subagent-instance-store 的 root() 同款取法：调用时读 env，测试可隔离 */
function projectsFilePath(): string {
	return join(process.env.WA_PI_DIR || WA_PI_DIR_CONST, "projects.json");
}

async function resolveSessionFile(sessionId: string): Promise<string | null> {
	try {
		const { sessions } = await new ProjectStore(projectsFilePath()).load();
		return sessions.find((s) => s.id === sessionId)?.piSessionFile ?? null;
	} catch {
		return null;
	}
}

/**
 * 给缺 delegations 的 meta 补历史归属（写盘失败只忽略，列表照常返回内存值）。
 * 已有 delegations 的 meta 不动：回填是辅助操作，不得覆盖修复后写入的准确记录。
 */
export async function backfillDelegations(
	sessionId: string,
	metas: SubagentMeta[],
): Promise<void> {
	const missing = metas.filter((m) => !Array.isArray(m.delegations));
	if (missing.length === 0) return;
	const file = await resolveSessionFile(sessionId);
	if (!file) return;
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return;
	}
	const map = parseDelegationsFromSessionLog(raw);
	for (const m of missing) {
		const hist = map.get(m.agentId) ?? [];
		const self: SubagentDelegation = {
			toolCallId: m.toolCallId,
			taskIndex: m.taskIndex ?? null,
		};
		const hasSelf = hist.some(
			(d) => d.toolCallId === self.toolCallId && d.taskIndex === self.taskIndex,
		);
		const delegations = hasSelf ? hist : [...hist, self];
		m.delegations = delegations;
		try {
			await writeMeta(m);
		} catch {
			/* 回填失败不影响本次列表返回 */
		}
	}
}
