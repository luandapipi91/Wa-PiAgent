// TaskEditForm 组件测试（bun:test）。
// 覆盖：新建模式填写后保存调用 createTask；编辑模式回填字段并调用 updateTask；
// 取消按钮调用 setView("detail")。store 全部 mock，TaskPromptComposer 的 channels
// store 也 mock 成空列表以保持测试隔离。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TaskEditForm } from "../TaskEditForm";
import { useToastStore } from "../../../store/toast";

/** contenteditable 指令输入：设文本并派发 input（extractText → onTextChange 链路） */
function setPrompt(text: string) {
	const el = screen.getByTestId("task-prompt-input") as HTMLElement;
	el.textContent = text;
	fireEvent.input(el);
}

const createTaskMock = mock();
const updateTaskMock = mock();
const setViewMock = mock();

// 共享 scheduler 假对象：editingTask 可在用例中切换以模拟「编辑模式」。
const schedulerState: {
	editingTask: any;
	createTask: typeof createTaskMock;
	updateTask: typeof updateTaskMock;
	setView: typeof setViewMock;
} = {
	editingTask: null,
	createTask: createTaskMock,
	updateTask: updateTaskMock,
	setView: setViewMock,
};

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => schedulerState,
}));

mock.module("../../../store/agents", () => ({
	useAgentsStore: () => ({
		// AgentConfig 以 displayName 为唯一标识（无 id 字段）
		list: [
			{
				displayName: "小助手",
				avatar: "🤖",
				avatarColor: "#aaa #bbb",
				description: "",
				model: null,
				thinking: null,
				tools: [],
				skills: [],
				mcpServers: [],
				partners: {},
			},
			{
				displayName: "研究员",
				avatar: "🔬",
				avatarColor: "#ccc #ddd",
				description: "",
				model: null,
				thinking: null,
				tools: [],
				skills: [],
				mcpServers: [],
				partners: {},
			},
		],
	}),
}));

mock.module("../../../store/projects", () => ({
	useProjectsStore: () => ({
		projects: [{ id: "p1", name: "HiAgent", cwd: "/x", createdAt: 0 }],
	}),
}));

// TaskPromptComposer 子组件依赖 channels store，mock 成空列表保持隔离
mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({ bots: [] }),
}));

beforeEach(() => {
	createTaskMock.mockReset();
	updateTaskMock.mockReset();
	setViewMock.mockReset();
	schedulerState.editingTask = null;
	// 清空 toast store 避免用例间泄露
	useToastStore.setState({ toasts: [] });
	cleanup();
});

describe("TaskEditForm", () => {
	test("渲染表单：任务名、保存按钮、智能体选择器", () => {
		render(<TaskEditForm />);
		expect(screen.getByTestId("task-name-input")).toBeTruthy();
		expect(screen.getByTestId("task-save-btn")).toBeTruthy();
		// 通用智能体选择器（AgentDropdown）：pill 存在，展开后可看到智能体列表
		expect(screen.getByTestId("task-agent-select")).toBeTruthy();
		fireEvent.click(screen.getByTestId("task-agent-select"));
		expect(screen.getByText("小助手")).toBeTruthy();
		expect(screen.getByText("研究员")).toBeTruthy();
	});

	test("新建模式：必填项未填时保存按钮禁用", () => {
		render(<TaskEditForm />);
		expect(
			(screen.getByTestId("task-save-btn") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	test("新建模式：填写名称+智能体+指令后保存调用 createTask", () => {
		render(<TaskEditForm />);
		// 任务名
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "每日报表" },
		});
		// 选择智能体
		// AgentDropdown 收起态：先点 pill 展开菜单再点智能体项
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		// 任务指令
		setPrompt("生成今日报表");
		// 保存
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "每日报表",
				agentId: "小助手",
				prompt: "生成今日报表",
			}),
		);
	});

	test("每分钟：间隔写入 schedule.intervalMinutes", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "监控" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("检查");
		// 计划类型切「每分钟」→ 间隔下拉选 10
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "minute" } });
		fireEvent.change(screen.getByTestId("task-interval-minutes"), {
			target: { value: "10" },
		});
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					type: "minute",
					intervalMinutes: 10,
				}),
			}),
		);
	});

	test("每小时：间隔 + 开始时间写入 schedule", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "整点巡检" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("巡检");
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "hourly" } });
		fireEvent.change(screen.getByTestId("task-interval-hours"), {
			target: { value: "3" },
		});
		fireEvent.change(screen.getByTestId("task-hourly-start"), {
			target: { value: "07:30" },
		});
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					type: "hourly",
					intervalHours: 3,
					startTime: "07:30",
				}),
			}),
		);
	});

	test("编辑模式：回填已有任务字段", () => {
		schedulerState.editingTask = {
			id: "t1",
			name: "旧任务",
			schedule: { type: "weekly", time: "08:00", dayOfWeek: 3 },
			agentId: "研究员",
			prompt: "旧指令",
			projectId: "p1",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		};
		render(<TaskEditForm />);
		expect(
			(screen.getByTestId("task-name-input") as HTMLInputElement).value,
		).toBe("旧任务");
		expect(
			(screen.getByTestId("task-prompt-input") as HTMLElement).textContent,
		).toBe("旧指令");
	});

	test("点击时间输入框任意位置弹出时间选择器（showPicker）", () => {
		render(<TaskEditForm />);
		const timeInput = screen.getByTestId(
			"task-time-input",
		) as HTMLInputElement & {
			showPicker?: () => void;
		};
		const showPicker = mock();
		timeInput.showPicker = showPicker;
		// 点击输入框任意位置（非右侧时钟图标）也应弹出 picker
		fireEvent.click(timeInput);
		expect(showPicker).toHaveBeenCalledTimes(1);
	});

	test("编辑模式：保存调用 updateTask(taskId, data)", () => {
		schedulerState.editingTask = {
			id: "t1",
			name: "旧任务",
			schedule: { type: "daily", time: "08:00" },
			agentId: "研究员",
			prompt: "旧指令",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		};
		render(<TaskEditForm />);
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(updateTaskMock).toHaveBeenCalledWith(
			"t1",
			expect.objectContaining({ name: "旧任务", agentId: "研究员" }),
		);
	});

	test("取消按钮调用 setView('detail')", () => {
		render(<TaskEditForm />);
		fireEvent.click(screen.getByText("取消"));
		expect(setViewMock).toHaveBeenCalledWith("detail");
	});

	test("custom 调度类型未填 cron 时保存按钮禁用，填写后启用", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "测试任务" },
		});
		// AgentDropdown 收起态：先点 pill 展开菜单再点智能体项
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("执行指令");
		// 切到「自定义 Cron」
		const scheduleSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(scheduleSelect, { target: { value: "custom" } });
		expect(
			(screen.getByTestId("task-save-btn") as HTMLButtonElement).disabled,
		).toBe(true);
		// 填写 cron 表达式后启用
		const cronInput = screen.getByPlaceholderText("*/15 * * * *");
		fireEvent.change(cronInput, { target: { value: "0 9 * * *" } });
		expect(
			(screen.getByTestId("task-save-btn") as HTMLButtonElement).disabled,
		).toBe(false);
	});

	test("保存失败时弹出错误 toast", async () => {
		createTaskMock.mockRejectedValue(new Error("network"));
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "测试任务" },
		});
		// AgentDropdown 收起态：先点 pill 展开菜单再点智能体项
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("执行指令");
		fireEvent.click(screen.getByTestId("task-save-btn"));
		// 等待异步 catch 完成
		await new Promise((r) => setTimeout(r, 10));
		expect(createTaskMock).toHaveBeenCalled();
		expect(
			useToastStore
				.getState()
				.toasts.some((t) => t.message.includes("保存任务失败")),
		).toBe(true);
	});
});
