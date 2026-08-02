import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@wa-pi/shared";

beforeEach(() => {
	useSessionStore.getState().clear();
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

function messages(sid: string) {
	return useSessionStore.getState().messagesBySession[sid] ?? [];
}

test("handleSDKEvent: extension_notify 插入聊天窗口中间的系统提示（custom 消息）", () => {
	const sid = "s-notify-1";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "pi-lens enabled for this session.",
			notifyType: "info",
		}),
	);
	const list = messages(sid);
	expect(list).toHaveLength(1);
	const m = list[0].message as any;
	expect(m.type).toBe("custom");
	expect(m.customType).toBe("extension_notify");
	expect(m.content).toBe("pi-lens enabled for this session.");
	expect(m.timestamp).toBeTypeOf("number");
});

test("handleSDKEvent: extension_notify 连续同内容去重", () => {
	const sid = "s-notify-2";
	const ev = {
		type: "extension_notify",
		message: "same message",
		notifyType: "warning",
	};
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	expect(messages(sid)).toHaveLength(1);
});

test("handleSDKEvent: 不同内容 notify 各自插入", () => {
	const sid = "s-notify-3";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "msg A",
			notifyType: "info",
		}),
	);
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "msg B",
			notifyType: "info",
		}),
	);
	expect(messages(sid)).toHaveLength(2);
});

test("handleSDKEvent: 非 extension_notify 事件不插入提示", () => {
	const sid = "s-notify-4";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "agent_end",
			messages: [],
			willRetry: false,
		}),
	);
	expect(messages(sid)).toHaveLength(0);
});
