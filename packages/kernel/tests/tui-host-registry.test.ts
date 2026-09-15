// tui-host-registry 单测：面板状态、帧缓存、输入队列、订阅者、事件分流
import { describe, expect, test } from "bun:test";
import { createTuiHostRegistry } from "../src/tui-host-registry.ts";

type BroadcastEvent = Record<string, unknown> & { type: string };

function setup() {
	const events: Array<{ sessionId: string; type: string; panelId?: string; event: BroadcastEvent }> = [];
	const reg = createTuiHostRegistry({
		broadcast: (sessionId, event) => {
			events.push({
				sessionId,
				type: event.type as string,
				panelId: (event as { panelId?: string }).panelId,
				event: event as BroadcastEvent,
			});
		},
	});
	return { reg, events, types: () => events.map((e) => e.type) };
}

const meta = {
	panelId: "p1",
	kind: "custom" as const,
	title: "pi-goal-x · Confirm",
	cols: 85,
	rows: 24,
	pending: 1,
};

describe("TuiHostRegistry", () => {
	test("openPanel 后快照包含该面板，并广播 extension_tui_open", () => {
		const { reg, events } = setup();
		reg.openPanel("s1", meta);
		const snap = reg.snapshot("s1");
		expect(snap?.panels).toHaveLength(1);
		expect(snap?.panels[0]?.title).toBe("pi-goal-x · Confirm");
		expect(events.map((e) => e.type)).toEqual(["extension_tui_open"]);
	});

	test("pushFrame 缓存最新帧并广播 extension_tui_frame", () => {
		const { reg, events } = setup();
		reg.openPanel("s1", meta);
		reg.pushFrame("s1", "p1", { lines: ["a"], cursor: null });
		expect(reg.snapshot("s1")?.panels[0]?.lastFrame?.lines).toEqual(["a"]);
		expect(events.map((e) => e.type)).toEqual(["extension_tui_open", "extension_tui_frame"]);
	});

	test("pushFrame 对未打开的面板静默忽略", () => {
		const { reg, events } = setup();
		reg.pushFrame("s1", "p-unknown", { lines: ["a"], cursor: null });
		expect(events).toHaveLength(0);
		expect(reg.snapshot("s1")).toBeNull();
	});

	test("无订阅者时输入入队；attachSubscriber 后立即 flush", () => {
		const { reg } = setup();
		reg.enqueueInput({ sessionId: "s1", panelId: "p1", type: "key", data: "\u001b[A" });
		const lines: string[] = [];
		const detach = reg.attachSubscriber("s1", (l) => lines.push(l));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({ type: "key", panelId: "p1", data: "\u001b[A" });
		detach();
	});

	test("有订阅者时直写不入队", () => {
		const { reg } = setup();
		const lines: string[] = [];
		reg.attachSubscriber("s1", (l) => lines.push(l));
		reg.enqueueInput({ sessionId: "s1", panelId: "p1", type: "cancel" });
		expect(lines).toHaveLength(1);
		const lines2: string[] = [];
		reg.attachSubscriber("s1", (l) => lines2.push(l));
		expect(lines2).toHaveLength(0);
	});

	test("detach 后回到排队模式", () => {
		const { reg } = setup();
		const lines: string[] = [];
		const detach = reg.attachSubscriber("s1", (l) => lines.push(l));
		detach();
		reg.enqueueInput({ sessionId: "s1", panelId: "p1", type: "resize", cols: 100, rows: 30 });
		expect(lines).toHaveLength(0);
		const lines2: string[] = [];
		reg.attachSubscriber("s1", (l) => lines2.push(l));
		expect(lines2).toHaveLength(1);
		expect(JSON.parse(lines2[0]!)).toEqual({ type: "resize", panelId: "p1", cols: 100, rows: 30 });
	});

	test("输入队列有上限，溢出丢最旧（订阅流断开期间不无限增长）", () => {
		const { reg } = setup();
		for (let i = 0; i < 501; i++) {
			reg.enqueueInput({ sessionId: "s1", panelId: "p1", type: "key", data: `k${i}` });
		}
		const lines: string[] = [];
		reg.attachSubscriber("s1", (l) => lines.push(l));
		expect(lines).toHaveLength(500);
		expect(JSON.parse(lines[0]!).data).toBe("k1");
		expect(JSON.parse(lines.at(-1)!).data).toBe("k500");
	});

	test("closePanel 移除面板并广播 close", () => {
		const { reg, events } = setup();
		reg.openPanel("s1", meta);
		reg.closePanel("s1", "p1", "done");
		expect(reg.snapshot("s1")?.panels).toHaveLength(0);
		expect(events.at(-1)?.type).toBe("extension_tui_close");
	});

	test("clearSession 清空面板、输入队列与订阅者", () => {
		const { reg } = setup();
		reg.openPanel("s1", meta);
		const lines: string[] = [];
		reg.attachSubscriber("s1", (l) => lines.push(l));
		reg.clearSession("s1");
		expect(reg.snapshot("s1")).toBeNull();
		reg.enqueueInput({ sessionId: "s1", panelId: "p1", type: "key", data: "a" });
		expect(lines).toHaveLength(0);
	});

	test("clearSession 通知前端收起在开的 custom 面板（会话销毁不留幽灵面板）", () => {
		const { reg, events } = setup();
		reg.openPanel("s1", meta);
		reg.applyFrame("s1", { type: "open", panelId: "w:goal", kind: "widget", widgetKey: "goal" });
		events.length = 0;
		reg.clearSession("s1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sessionId: "s1",
			type: "extension_tui_close",
			panelId: "p1",
			event: { reason: "dispose" },
		});
		expect(reg.sessionIds()).toEqual([]);
	});

	test("sessionIds 列出有状态的会话", () => {
		const { reg } = setup();
		expect(reg.sessionIds()).toEqual([]);
		reg.openPanel("s1", meta);
		reg.enqueueInput({ sessionId: "s2", panelId: "p1", type: "key", data: "a" });
		expect(reg.sessionIds().sort()).toEqual(["s1", "s2"]);
		reg.clearSession("s1");
		expect(reg.sessionIds()).toEqual(["s2"]);
	});

	test("applyFrame 把 open/frame/close 三类帧落到快照与广播", () => {
		const { reg, types } = setup();
		reg.applyFrame("s1", {
			type: "open",
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 2,
		});
		expect(reg.snapshot("s1")?.panels[0]).toMatchObject({
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			pending: 2,
			lastFrame: null,
		});
		reg.applyFrame("s1", { type: "frame", panelId: "p1", lines: ["a"], cursor: { row: 1, col: 2 } });
		expect(reg.snapshot("s1")?.panels[0]?.lastFrame).toEqual({
			lines: ["a"],
			cursor: { row: 1, col: 2 },
		});
		reg.applyFrame("s1", { type: "close", panelId: "p1", reason: "done" });
		expect(reg.snapshot("s1")?.panels).toHaveLength(0);
		expect(types()).toEqual(["extension_tui_open", "extension_tui_frame", "extension_tui_close"]);
	});

	test("applyFrame 忽略 ping（心跳）与缺 panelId 的脏帧", () => {
		const { reg, events } = setup();
		reg.applyFrame("s1", { type: "ping" });
		reg.applyFrame("s1", { type: "frame", lines: ["a"] });
		reg.applyFrame("s1", { type: "unknown-op" });
		expect(events).toHaveLength(0);
		expect(reg.sessionIds()).toEqual([]);
	});

	test("applyFrame：open 帧缺省字段按规格兜底（kind/cols/rows/pending/title）", () => {
		const { reg } = setup();
		reg.applyFrame("s1", { type: "open", panelId: "p9" });
		expect(reg.snapshot("s1")?.panels[0]).toMatchObject({
			panelId: "p9",
			kind: "custom",
			cols: 85,
			rows: 24,
			pending: 1,
		});
	});

	test("widget 帧走既有 extension_widget 通道（含 widgetKey 与 placement），不发 extension_tui_frame", () => {
		const { reg, events, types } = setup();
		reg.applyFrame("s1", {
			type: "open",
			panelId: "w:goal",
			kind: "widget",
			widgetKey: "goal",
			title: "goal",
			placement: "belowEditor",
			cols: 80,
			rows: 10,
		});
		reg.applyFrame("s1", { type: "frame", panelId: "w:goal", lines: ["w1"], cursor: null });
		expect(types()).toEqual(["extension_widget"]);
		expect(events[0]?.event).toEqual({
			type: "extension_widget",
			widgetKey: "goal",
			widgetLines: ["w1"],
			widgetPlacement: "belowEditor",
		});
		expect(reg.snapshot("s1")?.panels[0]?.lastFrame?.lines).toEqual(["w1"]);
	});

	test("widget 帧缺 placement 时按 aboveEditor 广播（与 extension_widget 缺省语义一致）", () => {
		const { reg, events } = setup();
		reg.applyFrame("s1", { type: "open", panelId: "w:goal", kind: "widget", widgetKey: "goal" });
		reg.applyFrame("s1", { type: "frame", panelId: "w:goal", lines: ["w1"] });
		expect(events[0]?.event).toMatchObject({ widgetKey: "goal", widgetPlacement: "aboveEditor" });
	});

	test("widget 的 open/close 只维护注册表状态，不广播浮窗事件（不占用 custom 面板通道）", () => {
		const { reg, events, types } = setup();
		reg.applyFrame("s1", { type: "open", panelId: "w:goal", kind: "widget", widgetKey: "goal" });
		expect(types()).toEqual([]);
		expect(reg.snapshot("s1")?.panels).toHaveLength(1);
		reg.applyFrame("s1", { type: "close", panelId: "w:goal", kind: "widget", widgetKey: "goal", reason: "removed" });
		expect(types()).toEqual([]);
		expect(reg.snapshot("s1")?.panels).toHaveLength(0);
	});

	test("custom 与 widget 同会话共存：各自走各自通道，互不覆盖", () => {
		const { reg, events, types } = setup();
		reg.openPanel("s1", meta);
		reg.applyFrame("s1", { type: "open", panelId: "w:goal", kind: "widget", widgetKey: "goal" });
		reg.applyFrame("s1", { type: "frame", panelId: "w:goal", lines: ["w1"] });
		reg.pushFrame("s1", "p1", { lines: ["a"], cursor: null });
		expect(types()).toEqual(["extension_tui_open", "extension_widget", "extension_tui_frame"]);
		expect(reg.snapshot("s1")?.panels).toHaveLength(2);
		expect(events[1]?.panelId).toBeUndefined();
		expect(events[2]?.panelId).toBe("p1");
	});
});
