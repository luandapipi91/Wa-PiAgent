// pending-messages.ts — 用户消息持久化排队（pending WAL）
//
// 背景（2026-10-08 P0 事故）：pi 子进程空闲回收 → 重生交接窗口内，用户消息投递
// 既不成功也无失败回执（无 LLM 调用、无落盘、无 UI 提示），静默丢失。
// 本模块是 kernel 侧的兜底 WAL：消息在投递给 pi 前先落盘，只有确认 pi 已消费
// （RPC resolve 视为确认）才删除；投递失败保留并计失败次数；进程重启、会话
// 重建后由 agent-manager 自动重投（_createSession 末尾 drain）。
//
// 存储：<WA_PI_DIR>/pending/<sessionId>.jsonl，每行一个 JSON 条目（与
// project-store 的 piSessionFile 同一套 WA_PI_DIR 路径约定）。
// 写盘统一「临时文件 + rename」原子替换，杜绝读方读到半行；
// 读盘逐行 JSON.parse，历史损坏行跳过（不让一行垃圾阻塞整个队列）。
//
// 已知权衡：RPC resolve 之后、ack 写盘之前进程崩溃 → 该条目在重启后被重投一次。
// 消息重复远好于消息丢失，可接受（agent-manager._sendPromptNow 的 ack 注释同步）。
//
// API 为无内存状态的模块函数：每次调用直接读写磁盘，「进程重启后重建 store」
// 天然成立——新进程首次 listAll 即可读出全部未确认条目。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { ImageContent } from "./agent-manager";

/** pending WAL 条目：入队即落盘，ack 后从文件删除 */
export interface PendingEntry {
	/** 唯一 id（enqueue 生成，ack/markFailed 按它定位条目） */
	id: string;
	sessionId: string;
	/** buildPromptContent 转换后的最终文本（重投直接发送，不做二次转换） */
	text: string;
	/** 多模态图片（与 ImageContent 同形），随 prompt 一并重投 */
	images?: ImageContent[];
	/** 入队时刻（ms） */
	createdAt: number;
	/** 投递失败次数（每次投递 reject 后 +1） */
	failures: number;
}

/** 单个会话的 pending WAL 文件路径 */
export function pendingFile(sessionId: string): string {
	return join(WA_PI_DIR, "pending", `${sessionId}.jsonl`);
}

/** 原子写全部条目：临时文件 + rename，防半行 */
async function writeAll(
	sessionId: string,
	entries: PendingEntry[],
): Promise<void> {
	const file = pendingFile(sessionId);
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomUUID()}`;
	const body =
		entries.length > 0
			? entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
			: "";
	await writeFile(tmp, body, "utf8");
	await renameWithRetry(tmp, file);
}

/**
 * Windows 瞬时锁重试的 rename：目标文件被杀毒/索引器/前次句柄短暂占用时
 * rename 报 EPERM/EACCES/EBUSY（实测 bun fs.open('r') 占住目标即 EPERM -4048，
 * 生产 steerMessage 偶发「followUp drain 失败: EPERM」同根因）。短退避重试
 * 吸收瞬时锁（10/20/40/80/160ms，总窗口 ~310ms）；非瞬时错误或耗尽照常抛出，
 * 原子替换语义不变（POSIX 上这些码对 rename 目标几乎不出现，重试不触发）。
 */
async function renameWithRetry(tmp: string, file: string): Promise<void> {
	let delay = 10;
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmp, file);
			return;
		} catch (err: any) {
			const transient =
				err?.code === "EPERM" ||
				err?.code === "EACCES" ||
				err?.code === "EBUSY";
			if (!transient || attempt >= 5) throw err;
			await new Promise((r) => setTimeout(r, delay));
			delay *= 2;
		}
	}
}

/** 入队：生成 id/时间戳并原子落盘，返回完整条目（调用方拿 id 做 ack） */
export async function enqueue(
	sessionId: string,
	entry: { text: string; images?: ImageContent[] },
): Promise<PendingEntry> {
	const full: PendingEntry = {
		id: `pm_${randomUUID()}`,
		sessionId,
		text: entry.text,
		...(entry.images ? { images: entry.images } : {}),
		createdAt: Date.now(),
		failures: 0,
	};
	const list = await listAll(sessionId);
	list.push(full);
	await writeAll(sessionId, list);
	return full;
}

/** 读出该会话全部未确认条目（文件不存在 → 空队列；损坏行跳过） */
export async function listAll(sessionId: string): Promise<PendingEntry[]> {
	let raw: string;
	try {
		raw = await readFile(pendingFile(sessionId), "utf8");
	} catch {
		return []; // 文件不存在（含 ENOENT）→ 空队列
	}
	const out: PendingEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as PendingEntry;
			if (e && typeof e.id === "string") out.push(e);
		} catch {
			// 损坏行跳过：历史半行/脏数据不阻塞整队列
		}
	}
	return out;
}

/** 删除单个条目（按 id）。幂等：条目不存在（可能已删）时静默返回 */
export async function remove(sessionId: string, id: string): Promise<void> {
	const list = await listAll(sessionId);
	const next = list.filter((e) => e.id !== id);
	if (next.length === list.length) return; // 无该 id → 已删/不存在，幂等
	await writeAll(sessionId, next);
}

/** 确认消费（投递成功）：删除对应 WAL 条目。语义化别名，底层复用 remove */
export async function ack(sessionId: string, id: string): Promise<void> {
	return remove(sessionId, id);
}

/** 投递失败：条目保留，失败次数 +1。幂等：条目不存在时静默返回 */
export async function markFailed(sessionId: string, id: string): Promise<void> {
	const list = await listAll(sessionId);
	const entry = list.find((e) => e.id === id);
	if (!entry) return; // 已被 ack（投递成功与失败回调竞态）→ 幂等
	entry.failures += 1;
	await writeAll(sessionId, list);
}

/** 清空该会话的全部 pending（abort 放弃排队消息时调用，与内存队列清空语义对齐） */
export async function clearSession(sessionId: string): Promise<void> {
	await rm(pendingFile(sessionId), { force: true });
}
