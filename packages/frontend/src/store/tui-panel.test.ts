// 扩展 TUI 面板 store（ctx.ui.custom 三态浮窗）单测。
// 边界：只处理 custom 面板——widget 的帧走既有 extension_widget → ExtWidgetDock 通道（规格 §6.4），
// 因此这里既没有 widget 三态，restoreFrom 也必须过滤掉快照里的 widget 面板。
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionTuiSnapshotResult } from "@wa-pi/shared";
import { useTuiPanelStore } from "./tui-panel";

const meta = {
	panelId: "p1",
	kind: "custom" as const,
	title: "pi-goal-x · Confirm",
	cols: 85,
	rows: 24,
	pending: 1,
};

const snapshot = (
	panels: ExtensionTuiSnapshotResult["panels"],
): ExtensionTuiSnapshotResult => ({ type: "extension:tui:snapshot", panels });

beforeEach(() => {
	useTuiPanelStore.setState({ bySession: {} });
});

describe("useTuiPanelStore", () => {
	test("open 后出现面板，默认展开态", () => {
		useTuiPanelStore.getState().open("s1", meta);
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.title).toBe("pi-goal-x · Confirm");
		expect(v.mode).toBe("expanded");
		expect(v.lines).toEqual([]);
		expect(v.cursor).toBeNull();
	});

	test("setFrame 写入帧与光标", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["a", "b"], { row: 1, col: 0 });
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.lines).toEqual(["a", "b"]);
		expect(v.cursor).toEqual({ row: 1, col: 0 });
	});

	test("setFrame 丢弃 panelId 不匹配的迟到帧（面板已切换）", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().setFrame("s1", "p1", ["old"], null);
		// p1 关闭、p2 打开后，仍可能收到 p1 的迟到帧：不能覆盖 p2 的画面
		useTuiPanelStore.getState().open("s1", { ...meta, panelId: "p2" });
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["late"], { row: 0, col: 0 });
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.panelId).toBe("p2");
		expect(v.lines).toEqual([]);
		expect(v.cursor).toBeNull();
	});

	test("未打开的会话收到帧不报错也不建面板", () => {
		useTuiPanelStore.getState().setFrame("sX", "p1", ["a"], null);
		expect(useTuiPanelStore.getState().bySession.sX).toBeUndefined();
	});

	test("collapse 展开→上次收起态（默认 badge）", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().collapse("s1");
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("badge");
	});

	test("collapseDeeper：badge→pill 并记住级别，collapse 直接到 pill", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().collapseDeeper("s1");
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("pill");
		useTuiPanelStore.getState().expand("s1");
		useTuiPanelStore.getState().collapse("s1");
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("pill");
	});

	test("expand 回到展开态", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().collapse("s1");
		useTuiPanelStore.getState().expand("s1");
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("expanded");
	});

	test("close 移除该会话面板", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().close("s1");
		expect(useTuiPanelStore.getState().bySession.s1).toBeUndefined();
	});

	test("多会话各自独立（面板随会话记忆）", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore
			.getState()
			.open("s2", { ...meta, panelId: "p9", title: "另一个面板" });
		useTuiPanelStore.getState().collapse("s1");
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("badge");
		expect(useTuiPanelStore.getState().bySession.s2!.mode).toBe("expanded");
		expect(useTuiPanelStore.getState().bySession.s2!.title).toBe("另一个面板");
	});

	test("restoreFrom：铺回元数据与最后一帧，且不改变用户当前的三态", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().collapse("s1");
		useTuiPanelStore.getState().restoreFrom(
			"s1",
			snapshot([
				{
					...meta,
					title: "改过的标题",
					lastFrame: { lines: ["x", "y"], cursor: { row: 0, col: 1 } },
				},
			]),
		);
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.title).toBe("改过的标题");
		expect(v.lines).toEqual(["x", "y"]);
		expect(v.cursor).toEqual({ row: 0, col: 1 });
		expect(v.mode).toBe("badge"); // 三态是用户态，快照不含、也不重置
		expect(v.lastCollapsedMode).toBe("badge");
	});

	test("restoreFrom：未收到过帧的面板（lastFrame=null）恢复为空画面", () => {
		useTuiPanelStore
			.getState()
			.restoreFrom("s1", snapshot([{ ...meta, lastFrame: null }]));
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.panelId).toBe("p1");
		expect(v.lines).toEqual([]);
		expect(v.cursor).toBeNull();
		expect(v.mode).toBe("expanded"); // 新面板默认展开
	});

	test("restoreFrom：只消费 custom 面板，widget 不进本 store（规格 §6.4）", () => {
		useTuiPanelStore.getState().restoreFrom(
			"s1",
			snapshot([
				{
					panelId: "w:goal",
					kind: "widget",
					title: "goal",
					cols: 80,
					rows: 10,
					pending: 1,
					widgetKey: "goal",
					lastFrame: { lines: ["w"], cursor: null },
				},
			]),
		);
		expect(useTuiPanelStore.getState().bySession.s1).toBeUndefined();
	});

	test("restoreFrom：快照里没有 custom 面板 → 清掉陈旧状态（前端断开期间面板已关）", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().restoreFrom("s1", snapshot([]));
		expect(useTuiPanelStore.getState().bySession.s1).toBeUndefined();
	});

	test("restoreFrom：面板已换（panelId 变了）→ 按新面板默认展开态", () => {
		useTuiPanelStore.getState().open("s1", meta);
		useTuiPanelStore.getState().collapse("s1");
		useTuiPanelStore
			.getState()
			.restoreFrom(
				"s1",
				snapshot([
					{ ...meta, panelId: "p2", lastFrame: { lines: ["new"], cursor: null } },
				]),
			);
		const v = useTuiPanelStore.getState().bySession.s1!;
		expect(v.panelId).toBe("p2");
		expect(v.lines).toEqual(["new"]);
		expect(v.mode).toBe("expanded");
	});
});
