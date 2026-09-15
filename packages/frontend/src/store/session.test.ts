import { test, expect } from "bun:test";

const { useSessionStore } = await import("./session");
const { useTuiPanelStore } = await import("./tui-panel");

/** 包一层 sdk:event 信封（前端 SSE 消费的入口形态） */
const sdk = (event: unknown) =>
	({
		type: "sdk:event",
		projectId: "p1",
		sessionId: "s1",
		agentName: "default",
		event,
	}) as any;

test("extension_tui_open/frame/close 事件驱动面板 store（custom 浮窗通道）", () => {
	const { handleSDKEvent } = useSessionStore.getState();
	useTuiPanelStore.setState({ bySession: {} });

	handleSDKEvent(
		"s1",
		sdk({
			type: "extension_tui_open",
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 1,
		}),
	);
	expect(useTuiPanelStore.getState().bySession.s1).toMatchObject({
		panelId: "p1",
		title: "pi-goal-x · Confirm",
		mode: "expanded",
	});

	handleSDKEvent(
		"s1",
		sdk({ type: "extension_tui_frame", panelId: "p1", lines: ["a"], cursor: { row: 0, col: 1 } }),
	);
	expect(useTuiPanelStore.getState().bySession.s1).toMatchObject({
		lines: ["a"],
		cursor: { row: 0, col: 1 },
	});

	handleSDKEvent("s1", sdk({ type: "extension_tui_close", panelId: "p1", reason: "done" }));
	expect(useTuiPanelStore.getState().bySession.s1).toBeUndefined();
});

test("file_changes 事件写入 fileChangesBySession", () => {
	const { handleSDKEvent } = useSessionStore.getState();
	handleSDKEvent("s1", {
		type: "sdk:event",
		projectId: "p1",
		sessionId: "s1",
		agentName: "default",
		event: {
			type: "file_changes",
			files: [{ path: "/a.ts", before: "v0", after: "v1" }],
		},
	} as any);
	expect(useSessionStore.getState().fileChangesBySession["s1"]).toEqual([
		{ path: "/a.ts", before: "v0", after: "v1" },
	]);
});
