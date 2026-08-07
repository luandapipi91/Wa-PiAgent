import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiCalls: { method: string; path: string; body?: any }[] = [];
// 保存失败开关：测试用例置为 Error 即可让 api.post 抛错
let postError: Error | null = null;
	mock.module("../src/api-client", () => ({
		api: {
			get: async (path: string) => {
				if (path === "/api/channels") return { channels: [] };
				if (path === "/api/channel-conversations") return { conversations: [] };
				if (path === "/api/skills") return { skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "" };
				if (path === "/api/projects")
					return {
						projects: [
							{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 1 },
							{ id: "p1", name: "hiagent", cwd: "/y", createdAt: 2 },
						],
						sessions: [],
					};
				return {};
			},
		post: async (path: string, body: any) => {
			apiCalls.push({ method: "POST", path, body });
			if (postError) throw postError;
			return { channels: [{ id: "ch_new", ...body.channel }] };
		},
		put: async (path: string, body: any) => {
			apiCalls.push({ method: "PUT", path, body });
			return { channels: [] };
		},
		del: async (path: string) => {
			apiCalls.push({ method: "DELETE", path });
			return { channels: [] };
		},
	},
}));

const { BotsSection } = await import("../src/components/settings/BotsSection");
const { useChannelsStore } = await import("../src/store/channels");
const { useAgentsStore } = await import("../src/store/agents");
const { useToastStore } = await import("../src/store/toast");
const { useProjectsStore } = await import("../src/store/projects");

beforeEach(() => {
	apiCalls.length = 0;
	postError = null;
	useToastStore.setState({ toasts: [] });
	useChannelsStore.setState({ bots: [], conversations: [] });
	useProjectsStore.setState({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 1 },
			{ id: "p1", name: "hiagent", cwd: "/y", createdAt: 2 },
		],
		sessions: [],
	} as any);
	useAgentsStore.setState({
		list: [
			{ displayName: "前端开发者", model: "p/m" },
			{ displayName: "后端架构师", model: null },
		] as any,
	});
});
afterEach(() => cleanup());

test("空列表渲染 + 新建按钮打开渠道选择弹层", () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	expect(screen.getByTestId("new-bot-dialog")).toBeTruthy();
	// 企微可选，其余置灰
	expect(screen.getByTestId("channel-chip-wecom").getAttribute("data-disabled")).toBe("false");
	expect(screen.getByTestId("channel-chip-feishu").getAttribute("data-disabled")).toBe("true");
});

test("选择企微后填写表单并保存 → POST 正确载荷", async () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人" } });
	fireEvent.change(screen.getByTestId("bot-botid-input"), { target: { value: "ww123" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec456" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	// handleSave 是异步的，等待 api 调用发生
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.length).toBe(1));
	expect(apiCalls[0].path).toBe("/api/channels");
	expect(apiCalls[0].body.channel).toMatchObject({
		type: "wecom",
		name: "客服机器人",
		credentials: { botId: "ww123", secret: "sec456" },
		replyGranularity: "standard",
		enabled: true,
	});
});

test("关联智能体已删除 → 显示降级警告条", () => {
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1", type: "wecom", name: "老机器人", enabled: false,
				credentials: { botId: "b", secret: "****" },
				agentName: "已被删除的智能体", model: null,
				extraSystemPrompt: "", replyGranularity: "simple", createdAt: 1,
				status: "disconnected",
			} as any,
		],
	});
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	expect(screen.getByTestId("bot-agent-missing-warning")).toBeTruthy();
});

/** 在列表里放一个已连接的机器人 */
function seedBot() {
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1", type: "wecom", name: "客服机器人", enabled: true,
				credentials: { botId: "ww1", secret: "****" },
				agentName: "前端开发者", model: null,
				extraSystemPrompt: "", replyGranularity: "standard", createdAt: 1,
				status: "connected",
			} as any,
		],
	});
}

test("回复粒度：可切换为 minimal 并保存 → 载荷携带 replyGranularity=minimal", async () => {
	seedBot();
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	fireEvent.change(screen.getByTestId("bot-granularity-select"), { target: { value: "minimal" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "PUT")).toBe(true));
	expect(apiCalls.find((c) => c.method === "PUT")!.body.channel.replyGranularity).toBe("minimal");
});

test("编辑：改名后保存 → PUT 正确载荷（secret 留空不修改）", async () => {
	seedBot();
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	// 表单回填原值
	expect((screen.getByTestId("bot-name-input") as HTMLInputElement).value).toBe("客服机器人");
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人2" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "PUT")).toBe(true));
	const put = apiCalls.find((c) => c.method === "PUT")!;
	expect(put.path).toBe("/api/channels/ch_1");
	expect(put.body.channel.name).toBe("客服机器人2");
	// secret 留空 → credentials 只带 botId（kernel 侧保留原 secret）
	expect(put.body.channel.credentials).toEqual({ botId: "ww1" });
});

test("删除：确认弹窗确认后 → DELETE 对应渠道", async () => {
	seedBot();
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	fireEvent.click(screen.getByTestId("bot-delete-btn"));
	expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
	fireEvent.click(screen.getByTestId("confirm-ok"));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "DELETE")).toBe(true));
	expect(apiCalls.find((c) => c.method === "DELETE")!.path).toBe("/api/channels/ch_1");
});

test("列表项内联启停开关：点击即 PUT enabled，且不打开编辑表单", async () => {
	seedBot();
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-toggle-ch_1"));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "PUT")).toBe(true));
	const put = apiCalls.find((c) => c.method === "PUT")!;
	expect(put.path).toBe("/api/channels/ch_1");
	expect(put.body.channel).toEqual({ enabled: false });
	// stopPropagation：没有进入编辑态
	expect(screen.queryByTestId("bot-name-input")).toBeNull();
});

test("关联智能体：通用搜索下拉选择后保存 → PUT 载荷含新 agentName", async () => {
	seedBot(); // 原 agentName = 前端开发者
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	// pill 展开带搜索框的下拉
	fireEvent.click(screen.getByTestId("bot-agent-select"));
	fireEvent.change(screen.getByTestId("bot-agent-search"), { target: { value: "后端" } });
	// 搜索过滤后只剩后端架构师，且顶部有「系统默认」固定项之外的项被过滤
	expect(screen.queryByTestId("bot-agent-item-前端开发者")).toBeNull();
	fireEvent.click(screen.getByTestId("bot-agent-item-后端架构师"));
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "PUT")).toBe(true));
	expect(apiCalls.find((c) => c.method === "PUT")!.body.channel.agentName).toBe("后端架构师");
});

test("保存失败 → 用 toast 提示错误，按钮旁不再出现 inline 文本", async () => {
	postError = new Error("Secret 不合法");
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人" } });
	fireEvent.change(screen.getByTestId("bot-botid-input"), { target: { value: "ww123" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec456" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));

	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => {
		// 1. toast store 出现一条 error 条目，文案为后端错误
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(useToastStore.getState().toasts[0].type).toBe("error");
		expect(useToastStore.getState().toasts[0].message).toBe("Secret 不合法");
	});
	// 2. 保存按钮旁不再渲染 inline 报错
	expect(screen.queryByTestId("bot-save-error")).toBeNull();
});

test("新建草稿：默认工作目录默认选中「默认工作区」，允许切换默认不勾", () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));

	const select = screen.getByTestId("bot-default-project-select") as HTMLSelectElement;
	expect(select.value).toBe("__system__");
	expect(select.textContent).toContain("默认工作区");
	expect(
		(screen.getByTestId("bot-allow-switch-toggle") as HTMLInputElement).checked,
	).toBe(false);
});

test("新建保存：勾选允许切换 + 选择其他工作区 → POST 载荷含两字段", async () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人" } });
	fireEvent.change(screen.getByTestId("bot-botid-input"), { target: { value: "ww123" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec456" } });
	// 默认工作目录切到 hiagent，勾选允许切换
	fireEvent.change(screen.getByTestId("bot-default-project-select"), { target: { value: "p1" } });
	fireEvent.click(screen.getByTestId("bot-allow-switch-toggle"));
	fireEvent.click(screen.getByTestId("bot-save-btn"));

	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.some((c) => c.method === "POST")).toBe(true));
	const post = apiCalls.find((c) => c.method === "POST")!;
	expect(post.path).toBe("/api/channels");
	expect(post.body.channel.defaultProjectId).toBe("p1");
	expect(post.body.channel.allowProjectSwitch).toBe(true);
});

test("编辑回填：旧数据（无两个新字段）→ 回退 __system__ 且不勾选", () => {
	// 构造不含 defaultProjectId/allowProjectSwitch 的旧格式 bot
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1", type: "wecom", name: "旧机器人", enabled: true,
				credentials: { botId: "ww1", secret: "****" },
				agentName: "前端开发者", model: null,
				extraSystemPrompt: "", replyGranularity: "standard", createdAt: 1,
				status: "connected",
			} as any,
		],
	});
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));

	expect(
		(screen.getByTestId("bot-default-project-select") as HTMLSelectElement).value,
	).toBe("__system__");
	expect(
		(screen.getByTestId("bot-allow-switch-toggle") as HTMLInputElement).checked,
	).toBe(false);
});
