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
		projects: [
			// 系统项目（默认工作区）：与后端 seed 保持一致，id 为 __system__
			{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 0 },
			{ id: "p1", name: "HiAgent", cwd: "/x", createdAt: 0 },
		],
		sessions: [],
	}),
}));

// ui-prefs 假 store：defaultAgent 可在用例中切换（默认 null = 未设置）
const uiPrefsState: { defaultAgent: string | null } = { defaultAgent: null };
mock.module("../../../store/ui-prefs", () => ({
	useUiPrefsStore: (sel?: (s: typeof uiPrefsState) => unknown) =>
		sel ? sel(uiPrefsState) : uiPrefsState,
}));

// TaskPromptComposer 子组件依赖 channels store，mock 成空列表保持隔离
mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({ bots: [] }),
}));

// providers store：模型下拉数据源（providerSlug/modelId）
mock.module("../../../store/providers", () => {
	const store = {
		providers: [
			{
				id: "p1",
				name: "OpenAI",
				baseUrl: "",
				apiKey: "",
				api: "openai-completions",
				slug: "openai",
				models: [{ id: "gpt-4", contextWindow: 128000, maxTokens: 4096 }],
			},
		],
		load: () => {},
	};
	const useProvidersStore = (sel?: (s: typeof store) => unknown) =>
		sel ? sel(store) : store;
	useProvidersStore.getState = () => store;
	return { useProvidersStore };
});

beforeEach(() => {
	createTaskMock.mockReset();
	updateTaskMock.mockReset();
	setViewMock.mockReset();
	schedulerState.editingTask = null;
	uiPrefsState.defaultAgent = null;
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
		expect(screen.getByTestId("task-agent-item-小助手")).toBeTruthy();
		expect(screen.getByTestId("task-agent-item-研究员")).toBeTruthy();
	});

	test("新建模式：必填项未填时保存按钮禁用", () => {
		render(<TaskEditForm />);
		expect(
			(screen.getByTestId("task-save-btn") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	test("新建模式：默认选中默认智能体（无设置时取列表第一项）", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "任务" },
		});
		setPrompt("执行指令");
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "小助手" }),
		);
	});

	test("新建模式：向导设置了默认智能体时默认选中它", () => {
		uiPrefsState.defaultAgent = "研究员";
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "任务" },
		});
		setPrompt("执行指令");
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "研究员" }),
		);
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

	test("每小时：间隔下拉含「自定义」，选中后显示数字输入框", () => {
		render(<TaskEditForm />);
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "hourly" } });
		// 选「自定义」
		fireEvent.change(screen.getByTestId("task-interval-hours"), {
			target: { value: "custom" },
		});
		expect(screen.getByTestId("task-interval-hours-custom")).toBeTruthy();
	});

	test("每小时：自定义间隔输入 5 小时并保存", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "巡检" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("巡检");
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "hourly" } });
		fireEvent.change(screen.getByTestId("task-interval-hours"), {
			target: { value: "custom" },
		});
		fireEvent.change(screen.getByTestId("task-interval-hours-custom"), {
			target: { value: "5" },
		});
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					type: "hourly",
					intervalHours: 5,
				}),
			}),
		);
	});

	test("每小时：自定义间隔输入非法值（0 / 25）时保存按钮禁用", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "巡检" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("巡检");
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "hourly" } });
		fireEvent.change(screen.getByTestId("task-interval-hours"), {
			target: { value: "custom" },
		});
		const customInput = screen.getByTestId("task-interval-hours-custom");
		const saveBtn = () =>
			screen.getByTestId("task-save-btn") as HTMLButtonElement;
		// 0 非法 → 禁用
		fireEvent.change(customInput, { target: { value: "0" } });
		expect(saveBtn().disabled).toBe(true);
		// 25 超出范围 → 禁用
		fireEvent.change(customInput, { target: { value: "25" } });
		expect(saveBtn().disabled).toBe(true);
		// 合法值 5 → 启用
		fireEvent.change(customInput, { target: { value: "5" } });
		expect(saveBtn().disabled).toBe(false);
	});

	test("每小时：自定义间隔输入非法值时输入框标红（aria-invalid）", () => {
		render(<TaskEditForm />);
		const typeSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(typeSelect, { target: { value: "hourly" } });
		fireEvent.change(screen.getByTestId("task-interval-hours"), {
			target: { value: "custom" },
		});
		const customInput = screen.getByTestId(
			"task-interval-hours-custom",
		) as HTMLInputElement;
		// 默认 1 合法 → 无错误标记
		expect(customInput.getAttribute("aria-invalid")).toBeNull();
		// 输入 0 → 标红
		fireEvent.change(customInput, { target: { value: "0" } });
		expect(customInput.getAttribute("aria-invalid")).toBe("true");
		// 改回合法 5 → 标记消失
		fireEvent.change(customInput, { target: { value: "5" } });
		expect(customInput.getAttribute("aria-invalid")).toBeNull();
	});

	test("编辑模式：intervalHours 不在预设列表时回填为自定义输入", () => {
		schedulerState.editingTask = {
			id: "t1",
			name: "旧任务",
			schedule: { type: "hourly", time: "09:00", intervalHours: 5 },
			agentId: "研究员",
			prompt: "旧指令",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		};
		render(<TaskEditForm />);
		const customInput = screen.getByTestId(
			"task-interval-hours-custom",
		) as HTMLInputElement;
		expect(customInput).toBeTruthy();
		expect(customInput.value).toBe("5");
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

	test("新建模式：工作目录下拉只有「默认工作区」和项目，无「默认」空值项", () => {
		render(<TaskEditForm />);
		const select = screen.getByTestId("task-workdir-select") as HTMLSelectElement;
		// 首项是「默认工作区」（__system__），无空值「默认」占位项
		expect(select.options[0].value).toBe("__system__");
		expect(select.options[0].text).toBe("默认工作区");
		// 下拉不含空值「默认」项
		expect(
			Array.from(select.options).some((o) => o.value === "" && o.text === "默认"),
		).toBe(false);
		// 默认选中「默认工作区」
		expect(select.value).toBe("__system__");
	});

	test("新建模式：默认选中默认工作区，保存 payload projectId = __system__", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "任务" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("执行指令");
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "__system__" }),
		);
	});

	test("编辑模式：无 projectId 的旧任务回填为默认工作区", () => {
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
		const select = screen.getByTestId("task-workdir-select") as HTMLSelectElement;
		expect(select.value).toBe("__system__");
	});

	test("渲染模型下拉：默认「跟随默认」（空值）", () => {
		render(<TaskEditForm />);
		const select = screen.getByTestId("task-model-select") as HTMLSelectElement;
		expect(select).toBeTruthy();
		expect(select.value).toBe("");
		// 含「跟随默认」首项 + 具体模型项
		expect(select.options.length).toBe(2);
		expect(select.options[0].text).toBe("跟随默认");
	});

	test("新建模式：选择模型后保存 → payload 带 model", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "任务" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("执行");
		fireEvent.change(screen.getByTestId("task-model-select"), {
			target: { value: "openai/gpt-4" },
		});
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({ model: "openai/gpt-4" }),
		);
	});

	test("新建模式：不选模型 → payload model 为 null（跟随默认）", () => {
		render(<TaskEditForm />);
		fireEvent.change(screen.getByTestId("task-name-input"), {
			target: { value: "任务" },
		});
		fireEvent.click(screen.getByTestId("task-agent-select"));
		fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
		setPrompt("执行");
		fireEvent.click(screen.getByTestId("task-save-btn"));
		expect(createTaskMock).toHaveBeenCalledWith(
			expect.objectContaining({ model: null }),
		);
	});

	test("编辑模式：回填 model", () => {
		schedulerState.editingTask = {
			id: "t1",
			name: "旧任务",
			schedule: { type: "daily", time: "08:00" },
			agentId: "研究员",
			prompt: "旧指令",
			model: "openai/gpt-4",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		};
		render(<TaskEditForm />);
		expect(
			(screen.getByTestId("task-model-select") as HTMLSelectElement).value,
		).toBe("openai/gpt-4");
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
