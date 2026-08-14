// AutomationSidebar 组件测试（bun:test，匹配本项目既有组件测试约定）。
// 注：简报原文使用 vitest + jest-dom，但本仓库未安装 vitest，14 个既有组件测试
// 均用 bun:test + @testing-library/react；这里沿用仓库约定，断言用 toBeTruthy。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AutomationSidebar } from "../AutomationSidebar";

// 把 store 替换成返回固定任务列表的假实现，断言组件渲染与交互。
const selectTaskMock = mock();
const startCreateMock = mock();
const loadTasksMock = mock();

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => ({
		tasks: [
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
		],
		selectedTaskId: "t1",
		selectTask: selectTaskMock,
		startCreate: startCreateMock,
		loadTasks: loadTasksMock,
	}),
}));

beforeEach(() => {
	selectTaskMock.mockReset();
	startCreateMock.mockReset();
	loadTasksMock.mockReset();
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
		fireEvent.click(screen.getByText(/新建/));
		expect(startCreateMock).toHaveBeenCalled();
	});
});
