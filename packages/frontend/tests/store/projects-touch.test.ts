// touchSession 引用稳定性契约（trace 卡顿修复 ③）：
// 根因链——SSE message_end → touchSession 无条件 map 生成新 sessions 数组（哪怕
// 目标会话不在侧栏列表）→ ProjectList（修复前整店订阅）→ ProjectItem/SessionRow
// 全量连坐重渲染（trace 实测 SessionRow 33% + ProjectItem 16% 主线程热点）。
// 修复：目标会话不在列表时返回原 state，不再制造假引用变化。
import { test, expect, beforeEach } from "bun:test";
import { useProjectsStore } from "../../src/store/projects";
import type { SessionEntity } from "@wa-pi/shared";

const sess = (id: string): SessionEntity =>
	({
		id,
		projectId: "p1",
		title: `会话${id}`,
		createdAt: 1,
		lastActivity: 1,
	}) as unknown as SessionEntity;

beforeEach(() => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P1" } as any],
		sessions: [sess("a"), sess("b")],
		currentProjectId: null,
		currentSessionId: null,
		dirPickerOpen: false,
	});
});

test("touchSession：目标会话不在列表时，sessions 引用不变（不触发列表重渲染）", () => {
	const before = useProjectsStore.getState().sessions;
	useProjectsStore.getState().touchSession("不在列表的id");
	expect(useProjectsStore.getState().sessions).toBe(before);
});

test("touchSession：目标会话在列表时，刷新 lastActivity 且生成新数组（现有行为守卫）", () => {
	const before = useProjectsStore.getState().sessions;
	useProjectsStore.getState().touchSession("a");
	const after = useProjectsStore.getState().sessions;
	// 新数组（列表排序/时间显示依赖引用变化感知更新）
	expect(after).not.toBe(before);
	expect(after.find((x) => x.id === "a")!.lastActivity).toBeGreaterThan(1);
	// 未 touch 的会话对象引用保持稳定（下游 memo 依赖此语义）
	expect(after.find((x) => x.id === "b")).toBe(before.find((x) => x.id === "b"));
});
