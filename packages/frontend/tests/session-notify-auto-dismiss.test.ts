// Task 8: extension_notify 系统消息插入后 20s 自动从聊天列表消失
// 说明：项目测试栈为 bun:test，fake timers 用 bun:test 导出的 vi（与既有 .tsx 测试一致）。
import { test, expect, beforeEach, afterEach, vi } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@wa-pi/shared";

beforeEach(() => {
	useSessionStore.getState().clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function envelope(sid: string, inner: any): SDKEventEnvelope {
	return {
		type: "sdk:event",
		sessionId: sid,
		projectId: "p-test",
		agentName: "dev",
		event: inner,
	};
}

function notify(sid: string, msg: string) {
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: msg,
			notifyType: "info",
		}),
	);
}

function messages(sid: string) {
	return useSessionStore.getState().messagesBySession[sid] ?? [];
}

test("extension_notify 插入后 20s 内保留，满 20s 自动从 messagesBySession 移除", () => {
	const sid = "s-auto-1";
	notify(sid, "—— MCP: 5 servers connected (234 tools) ——");
	expect(messages(sid)).toHaveLength(1);

	// 19s：仍在
	vi.advanceTimersByTime(19_000);
	expect(messages(sid)).toHaveLength(1);

	// 满 20s：自动消失
	vi.advanceTimersByTime(1_000);
	expect(messages(sid)).toHaveLength(0);
});

test("20s 只移除匹配的 extension_notify，不影响同一会话其他消息", () => {
	const sid = "s-auto-2";
	notify(sid, "notify A");
	// 插入一条普通用户消息
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "message_start",
			message: { role: "user", content: "hello", timestamp: 1 },
		}),
	);
	expect(messages(sid)).toHaveLength(2);

	vi.advanceTimersByTime(20_000);
	const list = messages(sid);
	expect(list).toHaveLength(1);
	expect((list[0].message as any).content).toBe("hello");
});

test("多条不同内容 notify 各自 20s 后按 timestamp 精确移除自己的那条", () => {
	const sid = "s-auto-3";
	notify(sid, "notify A");
	vi.advanceTimersByTime(5_000);
	notify(sid, "notify B");
	expect(messages(sid)).toHaveLength(2);

	// 距 A 插入 20s（距 B 15s）：只移除 A
	vi.advanceTimersByTime(15_000);
	expect(messages(sid)).toHaveLength(1);
	expect((messages(sid)[0].message as any).content).toBe("notify B");

	// 再 5s：B 也被移除
	vi.advanceTimersByTime(5_000);
	expect(messages(sid)).toHaveLength(0);
});

test("去重命中不插入、不调度移除定时器（快进 20s 无副作用）", () => {
	const sid = "s-auto-4";
	notify(sid, "same");
	notify(sid, "same"); // 与最后一条同内容：去重跳过
	expect(messages(sid)).toHaveLength(1);

	vi.advanceTimersByTime(20_000);
	expect(messages(sid)).toHaveLength(0); // 仅首次插入的那条被移除
});

test("消息已被其他操作移除后，20s 回调安全跳过（不报错、不复活）", () => {
	const sid = "s-auto-5";
	notify(sid, "transient");
	expect(messages(sid)).toHaveLength(1);

	// 模拟其他操作提前移除该消息
	useSessionStore.setState({ messagesBySession: { [sid]: [] } });

	vi.advanceTimersByTime(20_000);
	expect(messages(sid)).toHaveLength(0);
});

test("会话切换（sessionId 变化）不影响移除：各会话按自己的列表移除", () => {
	const sidA = "s-auto-a";
	const sidB = "s-auto-b";
	notify(sidA, "in A");
	notify(sidB, "in B");
	expect(messages(sidA)).toHaveLength(1);
	expect(messages(sidB)).toHaveLength(1);

	vi.advanceTimersByTime(20_000);
	expect(messages(sidA)).toHaveLength(0);
	expect(messages(sidB)).toHaveLength(0);
});
