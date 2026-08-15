// AutomationSidebar 组件测试（bun:test，匹配本项目既有组件测试约定）。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	act,
} from "@testing-library/react";
import { AutomationSidebar } from "../AutomationSidebar";

// 把 store 替换成返回固定任务列表的假实现，断言组件渲染与交互。
// records 提供每任务最近执行状态（t1=success / t2=failed），供 TaskCard 状态点渲染。
const selectTaskMock = mock();
const startCreateMock = mock();
const loadTasksMock = mock();
const setViewMock = mock();
const deleteTaskMock = mock(async () => {});
const runTaskNowMock = mock(async () => {});
const loadRecordsMock = mock(async () => {});

const baseTasks = () => [
	{
		id: "t1",
		name: "每日报表",
		schedule: { type: "daily", time: "09:30" },
		enabled: true,
		prompt: "test",
	},
	{
		id: "t2",
		name: "下载清理",
		schedule: { type: "daily", time: "18:30" },
		enabled: false,
		prompt: "test",
	},
];

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => ({
		tasks: baseTasks(),
		records: [
			{
				id: "r1",
				taskId: "t1",
				taskName: "每日报表",
				status: "success",
				startedAt: 3,
			},
			{
				id: "r0",
				taskId: "t1",
				taskName: "每日报表",
				status: "failed",
				startedAt: 1,
			},
			{
				id: "r2",
				taskId: "t2",
				taskName: "下载清理",
				status: "failed",
				startedAt: 2,
			},
		],
		selectedTaskId: "t1",
		selectTask: selectTaskMock,
		startCreate: startCreateMock,
		loadTasks: loadTasksMock,
		setView: setViewMock,
		deleteTask: deleteTaskMock,
		runTaskNow: runTaskNowMock,
		loadRecords: loadRecordsMock,
	}),
}));

beforeEach(() => {
	selectTaskMock.mockReset();
	startCreateMock.mockReset();
	loadTasksMock.mockReset();
	setViewMock.mockReset();
	deleteTaskMock.mockReset();
	runTaskNowMock.mockReset();
	loadRecordsMock.mockReset();
	cleanup();
});

describe("AutomationSidebar", () => {
	test("渲染任务列表：显示所有任务名", () => {
		render(<AutomationSidebar />);
		expect(screen.getByText("每日报表")).toBeTruthy();
		expect(screen.getByText("下载清理")).toBeTruthy();
	});

	test("点击任务卡片调用 selectTask(taskId)", () => {
		render(<AutomationSidebar />);
		fireEvent.click(screen.getByText("下载清理"));
		expect(selectTaskMock).toHaveBeenCalledWith("t2");
	});

	test("点击新建按钮调用 startCreate", () => {
		render(<AutomationSidebar />);
		fireEvent.click(screen.getByTestId("automation-new-btn"));
		expect(startCreateMock).toHaveBeenCalled();
	});

	test("工具栏无「执行记录」按钮", () => {
		render(<AutomationSidebar />);
		expect(screen.queryByTestId("automation-records-btn")).toBeNull();
	});

	test("任务卡显示最近执行状态：t1 成功绿✓（取该任务最新记录），t2 失败红✕", () => {
		render(<AutomationSidebar />);
		const card1 = screen.getByTestId("automation-task-t1");
		const card2 = screen.getByTestId("automation-task-t2");
		// r1(success, startedAt:3) 晚于 r0(failed, startedAt:1) → t1 取 success
		expect(
			card1.querySelector('[data-testid="task-last-status-t1"]')?.textContent,
		).toBe("✓");
		expect(
			card2.querySelector('[data-testid="task-last-status-t2"]')?.textContent,
		).toBe("✕");
	});

	test("右键任务卡弹出上下文菜单（不直接弹删除确认）", () => {
		render(<AutomationSidebar />);
		fireEvent.contextMenu(screen.getByText("每日报表"));
		const menu = screen.getByTestId("task-context-menu");
		expect(menu).toBeTruthy();
		// 菜单项：立即执行 / 删除
		expect(menu.textContent).toContain("立即执行");
		expect(menu.textContent).toContain("删除");
		// 未点删除前不出现确认框
		expect(screen.queryByTestId("confirm-dialog")).toBeNull();
	});

	test("菜单点「立即执行」调用 runTaskNow 并关菜单", () => {
		render(<AutomationSidebar />);
		fireEvent.contextMenu(screen.getByText("每日报表"));
		fireEvent.click(screen.getByTestId("task-menu-run"));
		expect(runTaskNowMock).toHaveBeenCalledWith("t1");
		expect(screen.queryByTestId("task-context-menu")).toBeNull();
	});

	test("菜单点「删除」弹确认框，确认后调用 deleteTask", () => {
		render(<AutomationSidebar />);
		fireEvent.contextMenu(screen.getByText("每日报表"));
		fireEvent.click(screen.getByTestId("task-menu-delete"));
		expect(screen.getByText(/确定删除「每日报表」/)).toBeTruthy();
		fireEvent.click(screen.getByTestId("confirm-ok"));
		expect(deleteTaskMock).toHaveBeenCalledWith("t1");
	});

	test("点菜单外任意处关闭菜单", async () => {
		render(<AutomationSidebar />);
		fireEvent.contextMenu(screen.getByText("每日报表"));
		expect(screen.getByTestId("task-context-menu")).toBeTruthy();
		// 关闭监听延迟 0ms 注册（防右键当次事件误关）：先冲刷定时器再点外部
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		fireEvent.click(document.body);
		expect(screen.queryByTestId("task-context-menu")).toBeNull();
	});
});
