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

test("handleSDKEvent: extension_notify 连续同内容不去重，各自插入", () => {
	const sid = "s-notify-2";
	const ev = {
		type: "extension_notify",
		message: "same message",
		notifyType: "warning",
	};
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	expect(messages(sid)).toHaveLength(3);
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

test("handleSDKEvent: extension_ui_reset 清空该会话的扩展 UI（status/widget/title）", () => {
	const sid = "s-reset-1";
	const handle = useSessionStore.getState().handleSDKEvent;
	// 先由旧进程发射三类扩展 UI
	handle(sid, envelope(sid, { type: "extension_status", statusKey: "k1", statusText: "状态" }));
	handle(sid, envelope(sid, { type: "extension_widget", widgetKey: "w1", widgetLines: ["组件"] }));
	handle(sid, envelope(sid, { type: "extension_title", title: "标题" }));
	let st = useSessionStore.getState();
	expect(st.extStatusBySession[sid]).toEqual({ k1: "状态" });
	expect(st.extWidgetBySession[sid]?.w1?.lines).toEqual(["组件"]);
	expect(st.extTitleBySession[sid]).toBe("标题");

	// kernel 重建进程后合成 reset → 全部清空（新进程会重新发射当前 UI）
	handle(sid, envelope(sid, { type: "extension_ui_reset" }));
	st = useSessionStore.getState();
	expect(st.extStatusBySession[sid]).toEqual({});
	expect(st.extWidgetBySession[sid]).toEqual({});
	expect(st.extTitleBySession[sid]).toBeNull();
});
