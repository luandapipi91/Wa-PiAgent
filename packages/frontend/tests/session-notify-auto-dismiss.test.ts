// extension_notify 系统消息插入后永久保留：不自动消退、不去重。
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

test("extension_notify 插入后永久保留，不自动消退", () => {
	const sid = "s-auto-1";
	notify(sid, "MCP: 5 servers connected");
	expect(messages(sid)).toHaveLength(1);

	// 快进 60s：仍在
	vi.advanceTimersByTime(60_000);
	expect(messages(sid)).toHaveLength(1);
});

test("多条同内容 notify 不去重，各自保留", () => {
	const sid = "s-auto-2";
	notify(sid, "same");
	notify(sid, "same");
	expect(messages(sid)).toHaveLength(2);

	// 快进 60s：两条都仍在
	vi.advanceTimersByTime(60_000);
	expect(messages(sid)).toHaveLength(2);
});
