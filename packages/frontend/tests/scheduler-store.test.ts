// scheduler store selectTask 行为测试：点选/切换/再点取消选中。
// api-client mock 后直接驱动 store（与 explorer-store.test 同风格）。
import { test, expect, beforeEach, mock } from "bun:test";

mock.module("../src/api-client", () => ({
	api: {
		get: async () => ({ tasks: [] }),
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
	ApiError: class extends Error {},
}));

const { useSchedulerStore } = await import("../src/store/scheduler");

beforeEach(() => {
	useSchedulerStore.setState({
		tasks: [
			{ id: "t1", name: "任务一" },
			{ id: "t2", name: "任务二" },
		] as never,
		selectedTaskId: null,
		view: "detail",
	});
});

test("selectTask 选中任务并切到 detail 视图", () => {
	useSchedulerStore.getState().selectTask("t1");
	expect(useSchedulerStore.getState().selectedTaskId).toBe("t1");
	expect(useSchedulerStore.getState().view).toBe("detail");
});

test("再点同一任务取消选中（selectedTaskId 回 null）", () => {
	useSchedulerStore.getState().selectTask("t1");
	useSchedulerStore.getState().selectTask("t1");
	expect(useSchedulerStore.getState().selectedTaskId).toBeNull();
});

test("点不同任务切换选中", () => {
	useSchedulerStore.getState().selectTask("t1");
	useSchedulerStore.getState().selectTask("t2");
	expect(useSchedulerStore.getState().selectedTaskId).toBe("t2");
});
