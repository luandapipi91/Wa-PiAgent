// pending-messages.test.ts — pending WAL（消息持久化排队）单元测试
//
// 背景（2026-10-08 P0 事故）：pi 子进程空闲回收 → 重生交接窗口内，用户消息投递
// 既不成功也无失败回执，静默丢失。pending-messages 提供 kernel 侧兜底：
// 消息投递前先落盘 <WA_PI_DIR>/pending/<sessionId>.jsonl，确认消费（RPC resolve）
// 后才删除；投递失败保留并计失败次数；进程重启后可重读重投。
//
// pending-messages 的 API 是无内存状态的模块函数（每次调用直接读写磁盘），
// 「重建 store 实例（模拟进程重启）」= 重新调用读函数：若实现把消息只留在内存
// 或未写盘，重启后的读操作就读不出来。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	ack,
	enqueue,
	listAll,
	markFailed,
	pendingFile,
} from "../src/pending-messages";

let sessionId: string;
beforeEach(() => {
	sessionId = `s-pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});
afterEach(async () => {
	// 清理该会话的 pending 文件（隔离 WA_PI_DIR 内，不碰生产数据）
	await rm(pendingFile(sessionId), { force: true });
});

test("写入后未确认 → 重建 store 实例（模拟进程重启）后仍能读出该消息", async () => {
	await enqueue(sessionId, { text: "交接窗口消息" });
	// 模拟进程重启：pending-messages 无内存状态，重启后重建的 store 等价于
	// 「重新调用读函数」——它必须从磁盘读出此前写入的条目
	const entries = await listAll(sessionId);
	expect(entries).toHaveLength(1);
	expect(entries[0].text).toBe("交接窗口消息");
	expect(entries[0].sessionId).toBe(sessionId);
	expect(entries[0].id).toBeTruthy();
	expect(typeof entries[0].createdAt).toBe("number");
	expect(entries[0].failures).toBe(0);
});

test("确认消息 id 后条目被删除", async () => {
	const first = await enqueue(sessionId, { text: "第一条" });
	await enqueue(sessionId, { text: "第二条" });
	await ack(sessionId, first.id);
	const rest = await listAll(sessionId);
	expect(rest.map((e) => e.text)).toEqual(["第二条"]);
});

test("投递抛错 → 条目保留且失败次数 +1", async () => {
	const entry = await enqueue(sessionId, { text: "投递会失败的消息" });
	// agent-manager 在投递（client.prompt/steer）reject 的 catch 里调用 markFailed
	await markFailed(sessionId, entry.id);
	const [after] = await listAll(sessionId);
	expect(after.text).toBe("投递会失败的消息"); // 条目保留
	expect(after.failures).toBe(1);
});
