// AutomationMain 组件测试：默认页编排 + 弹窗表单。
// 主区规则：无任务→新建引导页；有任务未选中→执行记录；选中→任务详情；edit→Modal 弹窗。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// 三个子视图 mock 为占位，聚焦 AutomationMain 的编排逻辑本身
mock.module("../TaskDetailView", () => ({
	TaskDetailView: () => <div data-testid="mock-detail" />,
}));
mock.module("../ExecutionRecords", () => ({
	ExecutionRecords: () => <div data-testid="mock-records" />,
}));
mock.module("../TaskEditForm", () => ({
	TaskEditForm: () => <div data-testid="task-edit-form" />,
}));

// 可变 store 状态：各用例按需覆写后重渲染（mock 声明前置供 state 引用）
const setViewMock = mock();
const startCreateMock = mock();
const state: Record<string, unknown> = {
	view: "detail",
	tasks: [],
	selectedTaskId: null,
	editingTask: null,
	setView: setViewMock,
	startCreate: startCreateMock,
};
const useSchedulerStore = (selector?: (s: typeof state) => unknown) =>
	selector ? selector(state) : state;
(useSchedulerStore as any).getState = () => state;
mock.module("../../../store/scheduler", () => ({
	useSchedulerStore,
}));

const { AutomationMain } = await import("../AutomationMain");

afterEach(() => {
	setViewMock.mockReset();
	startCreateMock.mockReset();
	Object.assign(state, {
		view: "detail",
		tasks: [],
		selectedTaskId: null,
		editingTask: null,
	});
	cleanup();
});

test("无任务未选中：默认显示新建引导页，含「+ 新建」按钮直达 startCreate", () => {
	render(<AutomationMain />);
	expect(screen.getByTestId("automation-empty-guide")).toBeTruthy();
	expect(screen.queryByTestId("mock-records")).toBeNull();
	fireEvent.click(screen.getByTestId("automation-guide-new-btn"));
	expect(startCreateMock).toHaveBeenCalled();
});

test("有任务未选中：默认显示执行记录页", () => {
	state.tasks = [{ id: "t1", name: "每日报表" }];
	render(<AutomationMain />);
	expect(screen.getByTestId("mock-records")).toBeTruthy();
	expect(screen.queryByTestId("automation-empty-guide")).toBeNull();
});

test("选中任务：显示任务详情", () => {
	state.tasks = [{ id: "t1", name: "每日报表" }];
	state.selectedTaskId = "t1";
	render(<AutomationMain />);
	expect(screen.getByTestId("mock-detail")).toBeTruthy();
	expect(screen.getByTestId("automation-main-header").textContent).toBe(
		"⚡ 每日报表",
	);
});

test("view=edit：表单以弹窗呈现，主区保持默认页不被替换", () => {
	state.view = "edit";
	render(<AutomationMain />);
	const modal = screen.getByTestId("task-edit-modal");
	expect(modal).toBeTruthy();
	expect(modal.contains(screen.getByTestId("task-edit-form"))).toBe(true);
	expect(screen.getByText("新建自动化")).toBeTruthy();
	// 主区不被替换：无任务 → 引导页仍在
	expect(screen.getByTestId("automation-empty-guide")).toBeTruthy();
});

test("view=edit 编辑任务：弹窗标题为编辑自动化", () => {
	state.view = "edit";
	state.editingTask = { id: "t1", name: "每日报表" };
	state.selectedTaskId = "t1";
	render(<AutomationMain />);
	expect(screen.getByText("编辑自动化")).toBeTruthy();
});

test("view=records：主区显示执行记录", () => {
	state.view = "records";
	render(<AutomationMain />);
	expect(screen.getByTestId("mock-records")).toBeTruthy();
	expect(screen.getByTestId("automation-main-header").textContent).toBe(
		"⚡ 执行记录",
	);
});

test("点弹窗遮罩不关闭：防误触丢输入，仅取消/保存可关", () => {
	state.view = "edit";
	render(<AutomationMain />);
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(setViewMock).not.toHaveBeenCalled();
});
