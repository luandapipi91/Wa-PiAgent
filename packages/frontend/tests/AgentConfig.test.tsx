import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	act,
	waitFor,
} from "@testing-library/react";
import type { AgentConfig as AgentConfigType } from "@wa-pi/shared";
import { AgentConfig } from "../src/components/AgentConfig";
import { useAgentsStore } from "../src/store/agents";
import { useSkillsStore } from "../src/store/skills";
import { useProvidersStore } from "../src/store/providers";
import { useSubagentsStore } from "../src/store/subagents";

const cfg = (
	name: string,
	over: Partial<AgentConfigType> = {},
): AgentConfigType => ({
	displayName: name,
	avatar: "🤖",
	avatarColor: "#111111-#222222",
	description: `${name} 简介`,
	model: "glm-4.6",
	thinking: "high",
	systemPromptMode: "replace",

	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
	systemPromptBody: "你是工程师",
	...over,
});

// REST API 调用记录（替代已删除的 ws-instance send）
const apiCalls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			return Promise.resolve({});
		},
		post: (path: string, body?: any) => {
			apiCalls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		put: (path: string, body?: any) => {
			apiCalls.push({ method: "put", path, body });
			return Promise.resolve({});
		},
		del: (path: string) => {
			apiCalls.push({ method: "del", path });
			return Promise.resolve({});
		},
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

// SSE 事件总线 mock：避免真实 EventSource 连接，测试通过 emitEventForTesting 注入事件
const eventHandlers = new Set<(e: any) => void>();
let emitEventForTesting: (e: any) => void;
mock.module("../src/events", () => ({
	onMessage: (cb: any) => {
		eventHandlers.add(cb);
		return () => eventHandlers.delete(cb);
	},
	onEventType: () => () => {},
	connectEvents: () => {},
	disconnectEvents: () => {
		eventHandlers.clear();
	},
	onReconnect: () => () => {},
	emitEventForTesting: (e: any) => {
		emitEventForTesting(e);
	},
}));

emitEventForTesting = (e: any) => {
	eventHandlers.forEach((h) => h(e));
};

const emitEvent = async (e: any) => {
	await act(async () => {
		emitEventForTesting(e);
	});
};

beforeEach(() => {
	apiCalls.length = 0;
	eventHandlers.clear();
	useAgentsStore.setState({ list: [], configs: {} });
	useSkillsStore.setState({ allSkills: [] });
	useProvidersStore.setState({ providers: [] });
	useSubagentsStore.setState({ subagents: [] });
});

// 个别测试会把 subagents store 的 saveOverride stub 成 mock，zustand store 是进程级单例，
// 不还原会泄漏给后面跑的测试文件（如 store-subagents.test.ts）——恢复初始 state（含原始 action）
afterEach(() => {
	useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
	cleanup();
});

function renderConfig(name = "dev", config = cfg(name), onClose = () => {}) {
	useAgentsStore.setState({ configs: { [name]: config } });
	return render(<AgentConfig agentName={name} onClose={onClose} />);
}

const configSaveCall = (agentName: string) =>
	apiCalls.find(
		(c) =>
			c.method === "put" &&
			c.path === `/api/agents/${encodeURIComponent(agentName)}/config`,
	);
const lastSaved = (agentName: string) => configSaveCall(agentName)!.body;

describe("AgentConfig 4 tab", () => {
	test("渲染 4 个 tab：基本/工具/技能/关系网，无 capabilities", () => {
		renderConfig();
		expect(screen.getByTestId("tab-basic")).toBeTruthy();
		expect(screen.getByTestId("tab-tools")).toBeTruthy();
		expect(screen.getByTestId("tab-skills")).toBeTruthy();
		expect(screen.getByTestId("tab-partners")).toBeTruthy();
		expect(screen.queryByTestId("tab-capabilities")).toBeNull();
	});

	test("弹窗标题显示 displayName", () => {
		renderConfig("dev", cfg("dev", { displayName: "研发" }));
		expect(screen.getByText("研发")).toBeTruthy();
	});

	test("基本 tab：思考档位含'跟随当前'，选 null 保存", () => {
		renderConfig("dev", cfg("dev", { thinking: "high" }));
		const sel = screen.getByTestId("cfg-thinking-select") as HTMLSelectElement;
		expect(sel.value).toBe("high");
		// 含"跟随当前"选项（值为空串）
		const opts = Array.from(sel.options);
		const followOpt = opts.find((o) => o.value === "");
		expect(followOpt).toBeTruthy();
		expect(followOpt!.text).toContain("跟随当前");
		fireEvent.change(sel, { target: { value: "" } });
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.thinking).toBeNull();
	});

	test("基本 tab：模型下拉来自 providers，含'默认（跟随全局）'可选", () => {
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "E2E",
					api: "openai",
					baseUrl: "https://e",
					apiKey: "k",
					models: [{ id: "m1", contextWindow: 1, maxTokens: 1 }],
				} as any,
			],
		});
		renderConfig("dev", cfg("dev", { model: null }));
		const sel = screen.getByTestId("cfg-model-select") as HTMLSelectElement;
		expect(sel.value).toBe("");
		// 含"默认（跟随全局）"option，且 enabled
		const opts = Array.from(sel.options);
		const defOpt = opts.find((o) => o.value === "");
		expect(defOpt).toBeTruthy();
		expect(defOpt!.text).toContain("默认");
		expect(defOpt!.disabled).toBe(false);
		// 选具体模型保存
		fireEvent.change(sel, { target: { value: "e2e/m1" } });
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.model).toContain("m1");
	});

	test("基本 tab：头像颜色选择器已取消（无 cfg-color-1/2，仅留 emoji 输入）", () => {
		renderConfig("dev");
		expect(screen.queryByTestId("cfg-color-1")).toBeNull();
		expect(screen.queryByTestId("cfg-color-2")).toBeNull();
		expect(screen.getByTestId("cfg-avatar-input")).toBeTruthy();
	});

	test("关系网 tab：搜索过滤 + 自身置灰不可选 + 勾选写入 askTo", () => {
		useAgentsStore.setState({
			list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")],
		});
		renderConfig("dev");
		fireEvent.click(screen.getByTestId("tab-partners"));
		expect(screen.getByTestId("partner-switch-代码审查")).toBeTruthy();
		// 自身行置灰且禁用（SwitchButton data-on=false 且行 opacity-50）
		const selfSwitch = screen.getByTestId("partner-switch-dev") as HTMLElement;
		expect(
			selfSwitch.closest(".opacity-50, [aria-disabled='true']"),
		).toBeTruthy();
		expect(selfSwitch.getAttribute("data-on")).toBe("false");
		// 搜索过滤
		fireEvent.change(screen.getByTestId("partner-search"), {
			target: { value: "审查" },
		});
		expect(screen.queryByTestId("partner-switch-质量验收")).toBeNull();
		expect(screen.getByTestId("partner-switch-代码审查")).toBeTruthy();
		// 勾选写入 partners.askTo 并保存
		fireEvent.click(screen.getByTestId("partner-switch-代码审查"));
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.partners.askTo).toEqual(["代码审查"]);
	});

	test("工具 tab：空数组展示为全勾，取消勾选后保存为非空列表", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "bash", source: "内置" },
			],
		});
		const readSwitch = await screen.findByTestId("tool-switch-read");
		const bashSwitch = await screen.findByTestId("tool-switch-bash");
		// tools 为空 = 全量默认 → 展示态全部启用
		expect(readSwitch.getAttribute("data-on")).toBe("true");
		expect(bashSwitch.getAttribute("data-on")).toBe("true");
		fireEvent.click(bashSwitch);
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.tools).toEqual(["read"]);
	});

	test("工具 tab：内置工具显示'内置'标签，动态插件显示插件名，MCP 显示'MCP'", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "web_search", source: "内置" },
				{ name: "my-plugin-tool", source: "my-plugin" },
				{ name: "some-mcp-tool", source: "MCP" },
			],
		});

		// 内置工具标签应显示"内置"
		const builtinBadges = screen.getAllByText("内置");
		expect(builtinBadges.length).toBeGreaterThanOrEqual(2);

		// 插件工具标签应显示具体插件名，而非泛化"扩展"
		expect(screen.getByText("my-plugin")).toBeTruthy();
		expect(screen.queryByText("扩展")).toBeNull();

		// MCP 工具标签应显示 "MCP"
		expect(screen.getByText("MCP")).toBeTruthy();
	});

	test("技能 tab：勾选写入 skills", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pdf", description: "PDF 处理", path: "/p/pdf" },
				{ name: "web", description: "网页访问", path: "/p/web" },
			],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		const pdfSwitch = screen.getByTestId("skill-switch-pdf");
		expect(pdfSwitch.getAttribute("data-on")).toBe("true");
		fireEvent.click(screen.getByTestId("skill-switch-web"));
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.skills).toEqual(["pdf"]);
	});

	test("新角色：默认 tools/skills 为空数组 → 所有开关应默认 ON", () => {
		// 不传 config override，使用 cfg() 默认值（tools:[], skills:[]）
		renderConfig("新角色");

		// 工具 tab
		fireEvent.click(screen.getByTestId("tab-tools"));
		// 默认空数组 = 全选，所有开关应为 ON
		// （tools 列表从 SSE agent:tools:list 加载，测试用 emitEvent 模拟）

		// 技能 tab
		useSkillsStore.setState({
			allSkills: [
				{ name: "s1", description: "S1", path: "/s1" },
				{ name: "s2", description: "S2", path: "/s2" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-skills"));
		const s1 = screen.getByTestId("skill-switch-s1");
		const s2 = screen.getByTestId("skill-switch-s2");
		// skills 空数组 = 全量继承，所有开关应为 ON
		expect(s1.getAttribute("data-on")).toBe("true");
		expect(s2.getAttribute("data-on")).toBe("true");
	});

	test("改名保存：载荷 config.displayName 更新，agentName 保持原名", () => {
		renderConfig("技术实现", cfg("技术实现"));
		fireEvent.change(screen.getByTestId("cfg-name-input"), {
			target: { value: "新名字" },
		});
		fireEvent.click(screen.getByText("保存"));
		const call = configSaveCall("技术实现")!;
		expect(call.path).toBe(
			`/api/agents/${encodeURIComponent("技术实现")}/config`,
		);
		expect(call.body.config.displayName).toBe("新名字");
	});

	test("重名时显示错误且禁用保存（不发出 agent:config:save）", () => {
		// store 里已有另一个 "代码审查"
		useAgentsStore.setState({ list: [cfg("代码审查")] });
		renderConfig("技术实现", cfg("技术实现"));
		// 改成已存在的 "代码审查"
		fireEvent.change(screen.getByTestId("cfg-name-input"), {
			target: { value: "代码审查" },
		});
		// 显示重名错误
		expect(screen.getByTestId("cfg-name-error").textContent).toContain(
			"已被占用",
		);
		// 保存按钮禁用
		const saveBtn = screen.getByTestId("cfg-save");
		expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
		// 点击保存也不发出请求
		fireEvent.click(saveBtn);
		expect(configSaveCall("技术实现")).toBeUndefined();
	});

	test("改为自身原名不视为重名（可正常保存）", () => {
		useAgentsStore.setState({ list: [cfg("技术实现")] });
		renderConfig("技术实现", cfg("技术实现"));
		// 不改名，直接保存
		fireEvent.click(screen.getByTestId("cfg-save"));
		expect(configSaveCall("技术实现")).toBeDefined();
	});

	test("displayName 为空时禁用保存", () => {
		renderConfig("技术实现", cfg("技术实现"));
		fireEvent.change(screen.getByTestId("cfg-name-input"), {
			target: { value: "" },
		});
		const saveBtn = screen.getByTestId("cfg-save");
		expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
	});

	test("点保存触发 onClose", () => {
		const onClose = mock();
		renderConfig("dev", cfg("dev"), onClose);
		fireEvent.click(screen.getByText("保存"));
		expect(onClose).toHaveBeenCalled();
	});

	test("技能 tab：全局禁用的技能显示为灰色并标注「全局禁用」", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pi-lens", description: "Lens 主技能", path: "/p/pi-lens" },
				{
					name: "pi-lens-ast-grep",
					description: "AST Grep 子技能",
					path: "/p/pi-lens-ast-grep",
				},
				{ name: "web", description: "网页访问", path: "/p/web" },
			],
			disabledSkills: ["pi-lens"],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));

		// pi-lens 全局禁用，应显示禁用标签
		const piLensRow = screen.getByTestId("skill-row-pi-lens");
		expect(piLensRow.style.opacity).toBe("0.5");
		expect(screen.getByTestId("skill-disabled-label-pi-lens")).toBeTruthy();

		// pi-lens-ast-grep 未被全局禁用，正常显示
		const astGrepRow = screen.getByTestId("skill-row-pi-lens-ast-grep");
		expect(astGrepRow.style.opacity).toBe("1");
		expect(
			screen.queryByTestId("skill-disabled-label-pi-lens-ast-grep"),
		).toBeNull();

		// web 未被全局禁用，正常显示
		const webRow = screen.getByTestId("skill-row-web");
		expect(webRow.style.opacity).toBe("1");
	});
});

describe("AgentConfig 内置 subagent（可保存 model/thinking）", () => {
	test("打开 general-purpose 显示内置提示和保存按钮", () => {
		render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
		expect(screen.getByTestId("cfg-builtin-notice")).toBeTruthy();
		expect(screen.getByTestId("cfg-builtin-notice").textContent).toContain(
			"内置",
		);
		// 有保存按钮
		expect(screen.getByTestId("cfg-save")).toBeTruthy();
		expect(screen.getByText("关闭")).toBeTruthy();
	});

	test("内置 subagent 不发送 agent:config:get（避免 kernel 报错）", () => {
		render(<AgentConfig agentName="Explore" onClose={() => {}} />);
		const getConfigCall = apiCalls.find(
			(e) =>
				e.method === "get" &&
				e.path === `/api/agents/${encodeURIComponent("Explore")}/config`,
		);
		expect(getConfigCall).toBeUndefined();
	});

	test("内置 subagent 显示中文显示名（需先设置 store）", () => {
		useSubagentsStore.setState({
			subagents: [
				{
					name: "general-purpose",
					displayName: "通用子智能体",
					description: "",
					emoji: "🤖",
					gradient: ["#4b5563", "#6b7280"] as [string, string],
					readOnly: false,
					systemPrompt: "",
					builtinToolNames: [],
				},
			],
		});
		render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
		expect(screen.getByTestId("agent-config").textContent).toContain(
			"通用子智能体",
		);
	});

	test("内置 subagent 的非 model/thinking 字段只读（opacity-60 + pointer-events-none）", () => {
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Explore",
					displayName: "探索子智能体",
					description: "",
					emoji: "🔍",
					gradient: ["#0891b2", "#06b6d4"] as [string, string],
					readOnly: true,
					systemPrompt: "test prompt",
					builtinToolNames: ["read"],
				},
			],
		});
		render(<AgentConfig agentName="Explore" onClose={() => {}} />);
		const content = screen.getByTestId("config-tab-content");
		// 只禁用 checkboxes/buttons/textarea，不禁用 select（model/thinking 可编辑）
		expect(content.className).toContain("pointer-events-none");
		expect(content.className).toContain("[&_textarea]");
	});

	test("内置 subagent 显示真实 systemPrompt（来自 useSubagentsStore）", async () => {
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Explore",
					displayName: "探索子智能体",
					description: "",
					emoji: "🔍",
					gradient: ["#0891b2", "#06b6d4"] as [string, string],
					readOnly: true,
					systemPrompt:
						"# CRITICAL: READ-ONLY MODE - real prompt from pi-subagents",
					builtinToolNames: ["read", "bash", "grep", "find", "ls"],
				},
			],
		});
		render(<AgentConfig agentName="Explore" onClose={() => {}} />);
		await waitFor(() =>
			expect(screen.getByTestId("agent-config").textContent).toContain(
				"探索子智能体",
			),
		);
		expect(screen.getByTestId("agent-config").textContent).toContain(
			"CRITICAL: READ-ONLY",
		);
	});

	test("内置 subagent 的 model 改变时不自动保存，点保存按钮才调 saveOverride", async () => {
		const saveOverride = mock();
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai" as any,
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Plan",
					displayName: "规划子智能体",
					description: "",
					emoji: "📐",
					gradient: ["#7c3aed", "#a78bfa"] as [string, string],
					readOnly: true,
					systemPrompt: "x",
					builtinToolNames: [],
				},
			],
			saveOverride,
		});
		render(<AgentConfig agentName="Plan" onClose={() => {}} />);
		const modelSelect = screen.getByTestId(
			"cfg-model-select",
		) as HTMLSelectElement;
		// 修改 model：不应立即调 saveOverride
		fireEvent.change(modelSelect, { target: { value: "openai/gpt-4o" } });
		expect(saveOverride).not.toHaveBeenCalled();
		// 点保存按钮才调 saveOverride
		fireEvent.click(screen.getByTestId("cfg-save"));
		expect(saveOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "Plan",
				model: "openai/gpt-4o",
			}),
		);
		// 不应发送 agent:config:save
		expect(
			apiCalls.some(
				(c) => c.method === "put" && c.path.startsWith("/api/agents/"),
			),
		).toBe(false);
	});

	test("内置 subagent 的 model/thinking 选择控件不置灰（可点）", () => {
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Plan",
					displayName: "规划子智能体",
					description: "",
					emoji: "📐",
					gradient: ["#7c3aed", "#a78bfa"] as [string, string],
					readOnly: true,
					systemPrompt: "x",
					builtinToolNames: [],
				},
			],
		});
		render(<AgentConfig agentName="Plan" onClose={() => {}} />);
		const modelSelect = screen.getByTestId("cfg-model-select");
		const thinkingSelect = screen.getByTestId("cfg-thinking-select");
		expect(modelSelect.className).not.toContain("pointer-events-none");
		expect(thinkingSelect.className).not.toContain("pointer-events-none");
		expect(screen.getByTestId("cfg-builtin-notice")).toBeTruthy();
	});

	test("内置 subagent 的 thinking 改变时不自动保存", async () => {
		const saveOverride = mock();
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Plan",
					displayName: "规划子智能体",
					description: "",
					emoji: "📐",
					gradient: ["#7c3aed", "#a78bfa"] as [string, string],
					readOnly: true,
					systemPrompt: "x",
					builtinToolNames: [],
				},
			],
			saveOverride,
		});
		render(<AgentConfig agentName="Plan" onClose={() => {}} />);
		const thinkingSelect = screen.getByTestId(
			"cfg-thinking-select",
		) as HTMLSelectElement;
		fireEvent.change(thinkingSelect, { target: { value: "max" } });
		// 不应自动保存
		expect(saveOverride).not.toHaveBeenCalled();
		// 点保存才调
		fireEvent.click(screen.getByTestId("cfg-save"));
		expect(saveOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "Plan",
				thinking: "max",
			}),
		);
	});

	test("内置 subagent 点保存触发 onClose", () => {
		useSubagentsStore.setState({
			subagents: [
				{
					name: "Plan",
					displayName: "规划子智能体",
					description: "",
					emoji: "📐",
					gradient: ["#7c3aed", "#a78bfa"] as [string, string],
					readOnly: true,
					systemPrompt: "x",
					builtinToolNames: [],
				},
			],
		});
		const onClose = mock();
		render(<AgentConfig agentName="Plan" onClose={onClose} />);
		fireEvent.click(screen.getByTestId("cfg-save"));
		expect(onClose).toHaveBeenCalled();
	});
});
