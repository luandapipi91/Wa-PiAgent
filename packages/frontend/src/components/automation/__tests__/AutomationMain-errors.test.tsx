// 自动化面板「配置错误」条目组件测试（bun:test）。
// 集成真实 scheduler store + mock api-client：loadTasks 从 GET /api/scheduled-tasks
// 拿到的 errors 存进 store，AutomationSidebar 渲染错误条目；点击错误条目 → startFixError
// 构造带 id 的草稿 → AutomationMain 弹出编辑表单，保存走 updateTask → PUT upsert 修复坏文件。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { AutomationSidebar } from "../AutomationSidebar";
import { AutomationMain } from "../AutomationMain";

/** contenteditable 指令输入：设文本并派发 input（extractText → onTextChange 链路） */
function setPrompt(text: string) {
	const el = screen.getByTestId("task-prompt-input") as HTMLElement;
	el.textContent = text;
	fireEvent.input(el);
}

// ---- mock api-client：GET /api/scheduled-tasks 返回配置错误，PUT 记录调用 ----
const putMock = mock();
mock.module("../../../api-client", () => ({
	api: {
		get: mock(async () => ({
			tasks: [],
			errors: [
				{
					taskId: "坏任务",
					projectId: "p1",
					file: "/x/坏任务.md",
					error: "缺少 frontmatter",
				},
			],
		})),
		post: mock(async () => ({ task: { id: "t" } })),
		put: putMock,
		del: mock(async () => ({})),
	},
}));

// ---- mock TaskEditForm 依赖的 store（与 TaskEditForm.test.tsx 约定一致）----
mock.module("../../../store/agents", () => ({
	useAgentsStore: () => ({
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
		],
	}),
}));

mock.module("../../../store/projects", () => ({
	useProjectsStore: () => ({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 0 },
			{ id: "p1", name: "HiAgent", cwd: "/x", createdAt: 0 },
		],
		sessions: [],
	}),
}));

const uiPrefsState: { defaultAgent: string | null } = { defaultAgent: null };
mock.module("../../../store/ui-prefs", () => ({
	useUiPrefsStore: (sel?: (s: typeof uiPrefsState) => unknown) =>
		sel ? sel(uiPrefsState) : uiPrefsState,
}));

mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({ bots: [] }),
}));

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

// 真实 scheduler store：loadTasks 会真实调用 api.get 获取 errors
import { useSchedulerStore } from "../../../store/scheduler";
import { useToastStore } from "../../../store/toast";

function renderPanel() {
	// automation-panel 容器：AutomationSidebar + AutomationMain 并排渲染
	return render(
		<div style={{ display: "flex", height: "100vh" }}>
			<AutomationSidebar />
			<AutomationMain />
		</div>,
	);
}

/** 等待组件 useEffect 触发的 loadTasks/loadRecords 等异步副作用完成，避免 act 警告 */
async function flushEffects() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

afterEach(() => {
	putMock.mockReset();
	uiPrefsState.defaultAgent = null;
	useToastStore.setState({ toasts: [] });
	// 重置真实 store 到初始态
	useSchedulerStore.setState({
		tasks: [],
		taskErrors: [],
		records: [],
		selectedTaskId: null,
		view: "detail",
		editingTask: null,
		selectedRecordId: null,
		recordDetailBackTo: "records",
	});
	cleanup();
});

test("任务列表渲染配置错误条目：文件名 + 错误原因 + 标记", async () => {
	renderPanel();
	// 等待组件 useEffect 异步加载 + 手动调用 loadTasks，确保 errors 已入 store
	await flushEffects();
	await act(async () => {
		await useSchedulerStore.getState().loadTasks();
	});
	expect(screen.getByText("⚠ 配置错误")).toBeTruthy();
	expect(screen.getByText("坏任务")).toBeTruthy();
	expect(screen.getByText("缺少 frontmatter")).toBeTruthy();
});

test("点击错误条目进入编辑表单，保存调用 PUT /api/scheduled-tasks/坏任务", async () => {
	renderPanel();
	await flushEffects();
	await act(async () => {
		await useSchedulerStore.getState().loadTasks();
	});
	// 点击错误条目（startFixError 更新 view=edit）
	fireEvent.click(screen.getByText("坏任务"));
	// 编辑表单弹窗出现（startFixError 构造的草稿带 id → 走编辑分支，标题为「编辑自动化」）
	expect(screen.getByTestId("task-edit-modal")).toBeTruthy();
	expect(screen.getByText("编辑自动化")).toBeTruthy();
	// 回填任务名 = taskId
	expect(
		(screen.getByTestId("task-name-input") as HTMLInputElement).value,
	).toBe("坏任务");
	// 草稿 agentId 为空 → 需选智能体并填指令才能保存
	fireEvent.click(screen.getByTestId("task-agent-select"));
	fireEvent.click(screen.getByTestId("task-agent-item-小助手"));
	setPrompt("修复后的指令");
	fireEvent.click(screen.getByTestId("task-save-btn"));
	// 等待 save 后 updateTask 的异步链（PUT + reload）完成，减少 act 警告
	await flushEffects();
	// updateTask → api.put(`/api/scheduled-tasks/坏任务`, data)，url 含 encodeURIComponent
	const putUrl = putMock.mock.calls[0]?.[0];
	expect(putUrl).toContain(encodeURIComponent("坏任务"));
});
