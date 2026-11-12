import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	act,
	waitFor,
	within,
} from "@testing-library/react";
import type { AgentConfig as AgentConfigType } from "@wa-pi/shared";
import { AgentConfig } from "../src/components/AgentConfig";
import { useAgentsStore } from "../src/store/agents";
import { useSkillsStore } from "../src/store/skills";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useSubagentsStore } from "../src/store/subagents";
import { useToastStore } from "../src/store/toast";

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

	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
	systemPromptBody: "你是工程师",
	...over,
});

// REST API 调用记录（替代已删除的 ws-instance send）
const apiCalls: { method: string; path: string; body?: any }[] = [];
// 竞态用例 gate：置真后 agent config GET 挂起，由用例经 resolveConfigGate 手动放行——
// 复现「mount → 回包晚于用户编辑」的真实时序（异步回包覆盖在途编辑的门卫回归锁）
let gateConfigGet = false;
let resolveConfigGate: ((value: any) => void) | null = null;
// 保存失败注入（S12）：置值后下一次 config PUT 以该状态码/错误体拒绝
// （复现 kernel 400/500：error/message 走 ApiError.message，formatApiError 原样展示）
let saveFailure: { status: number; body: { message?: string; error?: string } } | null =
	null;
// 保存在途 gate：置真后 config PUT 挂起，由用例经 resolvePutGate 放行——
// 用于断言「请求未落定时重复点击不会重复提交」
let gatePut = false;
let resolvePutGate: ((value: any) => void) | null = null;
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			if (gateConfigGet && /\/config$/.test(path)) {
				return new Promise((resolve) => {
					resolveConfigGate = resolve;
				});
			}
			return Promise.resolve({});
		},
		post: (path: string, body?: any) => {
			apiCalls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		put: (path: string, body?: any) => {
			apiCalls.push({ method: "put", path, body });
			if (saveFailure && /\/config$/.test(path)) {
				// 一次性消费：失败后用户再点保存应走正常（成功）路径
				const { status, body: errBody } = saveFailure;
				saveFailure = null;
				const err = new Error(
					errBody.error ?? errBody.message ?? `${status}`,
				) as Error & { status: number };
				err.status = status;
				return Promise.reject(err);
			}
			if (gatePut) {
				return new Promise((resolve) => {
					resolvePutGate = resolve;
				});
			}
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
	gateConfigGet = false;
	resolveConfigGate = null;
	saveFailure = null;
	gatePut = false;
	resolvePutGate = null;
	useToastStore.setState({ toasts: [] });
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

describe("AgentConfig 5 tab", () => {
	test("渲染 5 个 tab：基本/工具/MCP/技能/关系网，无 capabilities", () => {
		renderConfig();
		expect(screen.getByTestId("tab-basic")).toBeTruthy();
		expect(screen.getByTestId("tab-tools")).toBeTruthy();
		expect(screen.getByTestId("tab-mcp")).toBeTruthy();
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

	test("基本 tab：头像颜色选择器已取消，头像改为图标选择按钮", () => {
		renderConfig("dev");
		expect(screen.queryByTestId("cfg-color-1")).toBeNull();
		expect(screen.queryByTestId("cfg-color-2")).toBeNull();
		// 文本输入框已换成头像块按钮（点选图标面板）
		expect(screen.queryByTestId("cfg-avatar-input")).toBeNull();
		expect(screen.getByTestId("cfg-avatar-button")).toBeTruthy();
	});

	test("头像选择器：点击头像弹面板，选图标写入 draft 并保存 icon: 前缀", () => {
		renderConfig("dev");
		// 初始 avatar 是旧 emoji（🤖 命中映射）→ 头像块渲染 svg 图标
		const btn = screen.getByTestId("cfg-avatar-button");
		expect(btn.querySelector("svg")).toBeTruthy();
		// 头部预览同步渲染图标
		expect(
			screen.getByTestId("cfg-avatar-preview").querySelector("svg"),
		).toBeTruthy();

		// 点击弹出分组图标面板
		fireEvent.click(btn);
		const panel = screen.getByTestId("cfg-avatar-panel");
		expect(panel).toBeTruthy();
		// 分组标题存在
		expect(panel.textContent).toContain("研发工程");
		// 图标下方显示中文名（对齐 POC 观感）
		expect(panel.textContent).toContain("机器人");

		// 点选图标 → 面板关闭 + draft 写入 icon: 前缀
		fireEvent.click(screen.getByTestId("avatar-icon-gear"));
		expect(screen.queryByTestId("cfg-avatar-panel")).toBeNull();

		// 重开面板：当前选中高亮
		fireEvent.click(screen.getByTestId("cfg-avatar-button"));
		expect(
			screen
				.getByTestId("cfg-avatar-panel")
				.querySelector("[aria-pressed='true']")
				?.getAttribute("data-testid"),
		).toBe("avatar-icon-gear");
		fireEvent.click(screen.getByTestId("cfg-avatar-panel")); // 点遮罩关闭

		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.avatar).toBe("icon:gear");
		// 保存后头部预览变为新图标
		expect(
			screen.getByTestId("cfg-avatar-preview").querySelector("svg"),
		).toBeTruthy();
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

	test("工具 tab：内置工具显示'内置'标签，动态插件显示插件名；MCP tab：MCP 工具显示'MCP'", async () => {
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
		// MCP 工具已移出工具 tab
		expect(screen.queryByTestId("tool-switch-some-mcp-tool")).toBeNull();

		// 切到 MCP tab：工具名无法解析服务器 → 归入「其他」组，标签仍显示 "MCP"
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const other = await screen.findByTestId("mcp-group-其他");
		// 组默认收起，需先展开组头才能看到组内工具行
		fireEvent.click(screen.getByTestId("mcp-group-toggle-其他"));
		expect(other.textContent).toContain("some-mcp-tool");
		expect(within(other).getByText("MCP")).toBeTruthy();
	});

	test("工具行显示描述，超长描述带 title 全文", async () => {
		// MCP 官方描述可能很长：行内截断，title 保留完整原文供悬停查看
		const longDesc = "查询数据库并返回结果行".repeat(20);
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置", description: "读取文件内容" },
				{ name: "mcp__dbx__query", source: "MCP", description: longDesc },
			],
		});
		// 工具 tab：描述行紧随名称行渲染，title 为完整文本
		const desc = await screen.findByTestId("tool-desc-read");
		expect(desc.textContent).toBe("读取文件内容");
		expect(desc.getAttribute("title")).toBe("读取文件内容");
		// MCP tab：长描述也完整写入 title（行内由 CSS truncate 截断）
		fireEvent.click(screen.getByTestId("tab-mcp"));
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		const mcpDesc = screen.getByTestId("tool-desc-mcp__dbx__query");
		expect(mcpDesc.textContent).toBe(longDesc);
		expect(mcpDesc.getAttribute("title")).toBe(longDesc);
	});

	test("无 description 的工具不渲染描述行", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [{ name: "read", source: "内置" }],
		});
		// 工具行照常渲染，但描述行不存在（不占高度）
		expect(await screen.findByTestId("tool-switch-read")).toBeTruthy();
		expect(screen.queryByTestId("tool-desc-read")).toBeNull();
	});

	test("MCP tab：组内工具显示描述", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "mcp__dbx__query", source: "MCP", description: "执行 SQL 查询" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		// 组默认收起，展开组头后才能看到组内工具行
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		const desc = screen.getByTestId("tool-desc-mcp__dbx__query");
		expect(desc.textContent).toBe("执行 SQL 查询");
	});

	test("工具 tab 与 MCP tab：MCP 入口工具（codemode/tool_search）均不展示", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
				{ name: "codemode", source: "MCP" },
				{ name: "tool_search", source: "MCP" },
			],
		});
		// 普通工具照旧有开关
		expect(
			(await screen.findByTestId("tool-switch-read")).getAttribute("data-on"),
		).toBe("true");
		// 入口工具整块移除：既没有独立区块，也没有开关，更不出现在任何分组里
		expect(screen.queryByTestId("mcp-entry-tools")).toBeNull();
		expect(screen.queryByTestId("mcp-entry-tool-codemode")).toBeNull();
		expect(screen.queryByTestId("tool-switch-codemode")).toBeNull();
		expect(screen.queryByTestId("tool-switch-tool_search")).toBeNull();
		expect(screen.queryByText("codemode")).toBeNull();
		expect(screen.queryByText("tool_search")).toBeNull();
		// MCP tab 里同样不展示入口工具；真正的 MCP 工具照常出现
		fireEvent.click(screen.getByTestId("tab-mcp"));
		expect(screen.queryByTestId("mcp-entry-tools")).toBeNull();
		expect(screen.queryByTestId("tool-switch-codemode")).toBeNull();
		expect(screen.queryByTestId("tool-switch-tool_search")).toBeNull();
		expect(screen.queryByText("codemode")).toBeNull();
		expect(screen.queryByText("tool_search")).toBeNull();
		// 组默认收起，展开后组内只剩真正 MCP 工具
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(screen.getByTestId("mcp-group-dbx").textContent).toContain("query");
	});

	test("工具 tab 不再出现 MCP 工具，MCP 工具只在 MCP tab", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "my-plugin-tool", source: "my-plugin" },
				{ name: "mcp__dbx__query", source: "MCP" },
			],
		});
		expect(await screen.findByTestId("tool-switch-read")).toBeTruthy();
		// 工具 tab：普通工具（内置 + 插件）保留，MCP 工具不在其中
		expect(screen.getByTestId("tool-switch-my-plugin-tool")).toBeTruthy();
		expect(screen.queryByTestId("tool-switch-mcp__dbx__query")).toBeNull();
		// 工具 tab 不再有分组标题
		expect(screen.queryByTestId("tools-group-plain")).toBeNull();
		expect(screen.queryByTestId("tools-group-mcp")).toBeNull();
		// 切到 MCP tab 后存在（组默认收起，需先展开）
		fireEvent.click(screen.getByTestId("tab-mcp"));
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(screen.getByTestId("tool-switch-mcp__dbx__query")).toBeTruthy();
		// 切回工具 tab 依然不显示
		fireEvent.click(screen.getByTestId("tab-tools"));
		expect(screen.queryByTestId("tool-switch-mcp__dbx__query")).toBeNull();
	});

	test("MCP tab：按 MCP 服务器分组，组内显示去掉前缀的短工具名", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
				{ name: "mcp__dbx__dbx_list_tables", source: "MCP" },
				{ name: "mcp__yunxiao__get_current_user", source: "MCP" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const dbx = await screen.findByTestId("mcp-group-dbx");
		// 组头 = 服务器名 + 工具数（收起态即可见）
		expect(dbx.textContent).toContain("dbx");
		expect(dbx.textContent).toContain("2");
		// 组默认收起，展开后组内只显示短名
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(dbx.textContent).toContain("query");
		expect(dbx.textContent).toContain("dbx_list_tables");
		expect(dbx.textContent).not.toContain("mcp__dbx__");
		fireEvent.click(screen.getByTestId("mcp-group-toggle-yunxiao"));
		const yunxiao = screen.getByTestId("mcp-group-yunxiao");
		expect(yunxiao.textContent).toContain("yunxiao");
		expect(yunxiao.textContent).toContain("get_current_user");
		expect(yunxiao.textContent).not.toContain("mcp__yunxiao__");
		// 开关 testId 仍用完整工具名
		expect(screen.getByTestId("tool-switch-mcp__dbx__query")).toBeTruthy();
	});

	test("MCP tab：组开关一键取消该服务器全部工具，且不影响其它工具", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
				{ name: "mcp__dbx__dbx_list_tables", source: "MCP" },
				{ name: "mcp__yunxiao__get_current_user", source: "MCP" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const dbxSwitch = await screen.findByTestId("mcp-group-switch-dbx");
		// 默认全量 = 全勾，组开关 on
		expect(dbxSwitch.getAttribute("data-on")).toBe("true");
		// 组开关在组头，无需展开即可点击；点击后展开断言组内行状态
		fireEvent.click(dbxSwitch);
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(
			screen.getByTestId("tool-switch-mcp__dbx__query").getAttribute("data-on"),
		).toBe("false");
		expect(
			screen
				.getByTestId("tool-switch-mcp__dbx__dbx_list_tables")
				.getAttribute("data-on"),
		).toBe("false");
		fireEvent.click(screen.getByText("保存"));
		const saved = lastSaved("dev").config.tools;
		expect(saved).not.toContain("mcp__dbx__query");
		expect(saved).not.toContain("mcp__dbx__dbx_list_tables");
		// 跨 tab 不误删：普通工具与其它服务器的 MCP 工具仍在
		expect(saved).toContain("read");
		expect(saved).toContain("mcp__yunxiao__get_current_user");
	});

	test("MCP tab：从显式列表点击组开关可批量勾上该服务器全部工具", async () => {
		renderConfig("dev", cfg("dev", { tools: ["read"] }));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
				{ name: "mcp__dbx__dbx_list_tables", source: "MCP" },
				{ name: "mcp__yunxiao__get_current_user", source: "MCP" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const dbxSwitch = await screen.findByTestId("mcp-group-switch-dbx");
		// 显式列表里没有 dbx 工具 → 组开关 off
		expect(dbxSwitch.getAttribute("data-on")).toBe("false");
		fireEvent.click(dbxSwitch);
		expect(dbxSwitch.getAttribute("data-on")).toBe("true");
		fireEvent.click(screen.getByTestId("mcp-group-switch-yunxiao"));
		fireEvent.click(screen.getByText("保存"));
		const saved = lastSaved("dev").config.tools;
		// 三个 MCP 工具全部勾上，原有 read 保留
		expect(saved).toEqual(
			expect.arrayContaining([
				"read",
				"mcp__dbx__query",
				"mcp__dbx__dbx_list_tables",
				"mcp__yunxiao__get_current_user",
			]),
		);
	});

	test("MCP tab：关闭单个工具（同组其它工具仍开）→ 保存的 tools 只去掉该工具", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
				{ name: "mcp__dbx__dbx_list_tables", source: "MCP" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		await screen.findByTestId("mcp-group-toggle-dbx");
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		// 默认 tools=[]（全量默认）→ 两个工具都开；只关掉其中一个
		const off = screen.getByTestId("tool-switch-mcp__dbx__dbx_list_tables");
		expect(off.getAttribute("data-on")).toBe("true");
		fireEvent.click(off);
		expect(off.getAttribute("data-on")).toBe("false");
		// 同组另一个工具不受影响
		expect(
			screen.getByTestId("tool-switch-mcp__dbx__query").getAttribute("data-on"),
		).toBe("true");
		// 组开关随之变为 off（不是全勾）
		expect(
			screen.getByTestId("mcp-group-switch-dbx").getAttribute("data-on"),
		).toBe("false");

		fireEvent.click(screen.getByText("保存"));
		const saved = lastSaved("dev").config.tools;
		expect(saved).not.toContain("mcp__dbx__dbx_list_tables");
		// 只关掉的那一个：同服务器其它工具与普通工具都在白名单里
		expect(saved).toContain("mcp__dbx__query");
		expect(saved).toContain("read");
	});

	test("MCP tab：组默认收起，点组头展开、再点收起", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [{ name: "mcp__dbx__query", source: "MCP" }],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		await screen.findByTestId("mcp-group-dbx");
		// 默认收起：只有组头，不渲染组内工具行
		expect(screen.queryByTestId("mcp-group-body-dbx")).toBeNull();
		expect(screen.queryByTestId("tool-switch-mcp__dbx__query")).toBeNull();
		// 点组头展开
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(screen.getByTestId("mcp-group-body-dbx")).toBeTruthy();
		expect(screen.getByTestId("tool-switch-mcp__dbx__query")).toBeTruthy();
		// 再点收起
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(screen.queryByTestId("mcp-group-body-dbx")).toBeNull();
	});

	test("MCP tab：点组开关只切换勾选，不触发折叠", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				// 带一个非 MCP 工具：避免切到空数组后落回「空=全选」语义
				{ name: "read", source: "内置" },
				{ name: "mcp__dbx__query", source: "MCP" },
			],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const dbxSwitch = await screen.findByTestId("mcp-group-switch-dbx");
		// 收起态点组开关：勾选被取消，但组仍然收起
		fireEvent.click(dbxSwitch);
		expect(screen.queryByTestId("mcp-group-body-dbx")).toBeNull();
		expect(dbxSwitch.getAttribute("data-on")).toBe("false");
		// 展开后组内行开关同步为关
		fireEvent.click(screen.getByTestId("mcp-group-toggle-dbx"));
		expect(
			screen.getByTestId("tool-switch-mcp__dbx__query").getAttribute("data-on"),
		).toBe("false");
	});

	test("MCP tab：组标题使用主题色与放大的字号", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [{ name: "mcp__dbx__query", source: "MCP" }],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		const toggle = await screen.findByTestId("mcp-group-toggle-dbx");
		const cls = toggle.className ?? "";
		expect(cls).toContain("text-brand");
		expect(cls).toContain("13px");
	});

	test("MCP tab：无 MCP 工具时显示空态文案", async () => {
		renderConfig();
		await emitEvent({
			type: "agent:tools:list",
			tools: [{ name: "read", source: "内置" }],
		});
		fireEvent.click(screen.getByTestId("tab-mcp"));
		expect(await screen.findByText("暂无 MCP 工具")).toBeTruthy();
	});

	test("工具 tab：4 个 browser_* 开关渲染且默认勾选，点掉 browser_navigate 后保存为显式白名单", async () => {
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-tools"));
		await emitEvent({
			type: "agent:tools:list",
			tools: [
				{ name: "read", source: "内置" },
				{ name: "bash", source: "内置" },
				{ name: "browser_navigate", source: "内置" },
				{ name: "browser_evaluate", source: "内置" },
				{ name: "browser_screenshot", source: "内置" },
				{ name: "browser_close", source: "内置" },
			],
		});

		// 4 个 browser_* 开关渲染且默认 on（tools:[] 全量默认 → 全部勾选）
		const navSwitch = await screen.findByTestId(
			"tool-switch-browser_navigate",
		);
		expect(navSwitch.getAttribute("data-on")).toBe("true");
		expect(
			screen.getByTestId("tool-switch-browser_evaluate").getAttribute("data-on"),
		).toBe("true");
		expect(
			screen.getByTestId("tool-switch-browser_screenshot").getAttribute("data-on"),
		).toBe("true");
		expect(
			screen.getByTestId("tool-switch-browser_close").getAttribute("data-on"),
		).toBe("true");

		// 点掉 browser_navigate → 转显式白名单：不含 browser_navigate，其余 browser_* 仍在
		fireEvent.click(navSwitch);
		fireEvent.click(screen.getByText("保存"));
		const savedTools = lastSaved("dev").config.tools;
		expect(savedTools).not.toContain("browser_navigate");
		expect(savedTools).toContain("browser_evaluate");
		expect(savedTools).toContain("browser_screenshot");
		expect(savedTools).toContain("browser_close");
		expect(savedTools).toContain("read");
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

	test("技能 tab：描述为块级容器且外层可伸缩（truncate 生效前提）", () => {
		// 回归锁：描述文本原先渲染在 inline <span> 上，overflow/text-overflow 对
		// non-replaced inline 元素不生效 → 超长描述按 nowrap 全宽铺开，撑出内容区横向滚动条
		// （视觉结果由 e2e/agent-config-skill-row-overflow.spec.ts 断言）。
		// happy-dom 无布局引擎，这里只锁住让 truncate 生效的类名组合。
		useSkillsStore.setState({
			allSkills: [{ name: "pdf", description: "超长描述".repeat(50), path: "/p/pdf" }],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		const desc = screen.getByTestId("skill-desc-pdf");
		expect(desc.className).toContain("truncate");
		expect(desc.className).toContain("block");
		// 外层容器必须 flex-1 + min-w-0：占满剩余宽度且允许收缩到比内容更窄
		const wrap = desc.parentElement!;
		expect(wrap.className).toContain("flex-1");
		expect(wrap.className).toContain("min-w-0");
		expect(screen.getByTestId("skill-row-pdf").firstElementChild!.className).toContain(
			"flex-1",
		);
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

	test("点保存触发 onClose", async () => {
		const onClose = mock();
		renderConfig("dev", cfg("dev"), onClose);
		fireEvent.click(screen.getByText("保存"));
		// 保存改为 async（await 回包成功才关窗），断言时序随之后移，语义不变
		await waitFor(() => expect(onClose).toHaveBeenCalled());
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

	test("技能 tab：同名项目技能遮蔽内置时只渲染一行，且不列出他项目技能", () => {
		useProjectsStore.setState({ currentProjectId: "pA" });
		useSkillsStore.setState({
			allSkills: [
				{
					name: "dup-skill",
					description: "项目版本",
					path: "/a/.pi/skills/dup-skill",
					source: { type: "project", projectId: "pA", projectName: "项目A" },
				},
				{
					name: "dup-skill",
					description: "内置版本",
					path: "/builtin/dup-skill",
					source: { type: "builtin" },
					shadowed: true,
				},
				{
					name: "other-proj-skill",
					description: "他项目技能",
					path: "/b/.pi/skills/other-proj-skill",
					source: { type: "project", projectId: "pB", projectName: "项目B" },
				},
			],
			disabledSkills: [],
		});
		try {
			renderConfig();
			fireEvent.click(screen.getByTestId("tab-skills"));
			// 同名只渲染一行（被遮蔽的内置版本不再重复一行，也不再触发 React 重复 key）
			expect(screen.getAllByTestId("skill-row-dup-skill")).toHaveLength(1);
			expect(screen.getByTestId("skill-switch-dup-skill")).toBeTruthy();
			// 他项目技能不在当前项目的可用集合内
			expect(screen.queryByTestId("skill-row-other-proj-skill")).toBeNull();
		} finally {
			useProjectsStore.setState({ currentProjectId: null });
		}
	});

	test("技能 tab：全部勾选开关默认 ON（skills 空数组、非 allOff）", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pdf", description: "PDF 处理", path: "/p/pdf" },
				{ name: "web", description: "网页访问", path: "/p/web" },
			],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		// skills 空数组 = 继承全部 → 全选开关应为 ON
		expect(
			screen.getByTestId("skill-select-all").getAttribute("data-on"),
		).toBe("true");
		// 各技能开关也均为 ON
		expect(
			screen.getByTestId("skill-switch-pdf").getAttribute("data-on"),
		).toBe("true");
		expect(
			screen.getByTestId("skill-switch-web").getAttribute("data-on"),
		).toBe("true");
	});

	test("技能 tab：点击全部勾选开关 → 全不选，保存写入 skillsAllOff: true", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pdf", description: "PDF 处理", path: "/p/pdf" },
				{ name: "web", description: "网页访问", path: "/p/web" },
			],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		// 默认全选 ON，点击 → 全不选
		fireEvent.click(screen.getByTestId("skill-select-all"));
		expect(
			screen.getByTestId("skill-select-all").getAttribute("data-on"),
		).toBe("false");
		// 所有技能开关变 OFF
		expect(
			screen.getByTestId("skill-switch-pdf").getAttribute("data-on"),
		).toBe("false");
		expect(
			screen.getByTestId("skill-switch-web").getAttribute("data-on"),
		).toBe("false");
		// 保存写入 skillsAllOff: true
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.skillsAllOff).toBe(true);
	});

	test("技能 tab：逐项取消至全不选，自动进入全不选态（skillsAllOff: true）", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pdf", description: "PDF 处理", path: "/p/pdf" },
				{ name: "web", description: "网页访问", path: "/p/web" },
			],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		// 逐项取消两个技能
		fireEvent.click(screen.getByTestId("skill-switch-pdf"));
		fireEvent.click(screen.getByTestId("skill-switch-web"));
		// 全选开关变 OFF
		expect(
			screen.getByTestId("skill-select-all").getAttribute("data-on"),
		).toBe("false");
		// 保存：因全部取消，应归一化为 skillsAllOff: true
		fireEvent.click(screen.getByText("保存"));
		expect(lastSaved("dev").config.skillsAllOff).toBe(true);
	});

	test("技能 tab：技能名不换行（whitespace-nowrap）", () => {
		useSkillsStore.setState({
			allSkills: [
				{ name: "pdf", description: "PDF 处理", path: "/p/pdf" },
			],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		const nameEl = screen.getByTestId("skill-name-pdf");
		expect(nameEl.className).toContain("whitespace-nowrap");
	});

	test("技能 tab：描述超长省略，点击弹出气泡显示完整描述；再次点击关闭", () => {
		const longDesc = "这是一段非常长的技能描述用于测试省略与点击气泡展示完整内容的功能".repeat(
			2,
		);
		useSkillsStore.setState({
			allSkills: [{ name: "pdf", description: longDesc, path: "/p/pdf" }],
		});
		renderConfig();
		fireEvent.click(screen.getByTestId("tab-skills"));
		// 初始无气泡
		expect(screen.queryByTestId("skill-desc-bubble-pdf")).toBeNull();
		// 点击描述 → 弹出气泡，显示完整描述
		fireEvent.click(screen.getByTestId("skill-desc-pdf"));
		const bubble = screen.getByTestId("skill-desc-bubble-pdf");
		expect(bubble.textContent).toBe(longDesc);
		// 再次点击 → 关闭
		fireEvent.click(screen.getByTestId("skill-desc-pdf"));
		expect(screen.queryByTestId("skill-desc-bubble-pdf")).toBeNull();
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

	test("内置 subagent 的非 model/thinking 字段只读（pointer-events-none，无 opacity-60）", () => {
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
		// 只读的 pointer-events-none 必须挂在内层内容上：挂到滚动容器上会让内部内容命中穿透，
		// 滚轮事件到不了滚动容器 → 只读面板列表滚不动（e2e/builtin-panel-scroll.spec.ts 覆盖）
		expect(content.className).not.toContain("pointer-events-none");
		const inner = screen.getByTestId("config-tab-inner");
		// 内层 pointer-events-none 禁用全部非 select 控件，仅 model/thinking 的 select 恢复可点
		expect(inner.className).toContain("pointer-events-none");
		expect(inner.className).toContain("[&_select]:pointer-events-auto");
	});

	test("内置 subagent 打开时也会拉取系统工具列表（工具 tab 不显示加载中）", () => {
		apiCalls.length = 0;
		useSubagentsStore.setState({
			subagents: [
				{
					name: "general-purpose",
					displayName: "通用子智能体",
					description: "",
					emoji: "🧭",
					gradient: ["#0891b2", "#06b6d4"] as [string, string],
					readOnly: false,
					systemPrompt: "x",
					builtinToolNames: [],
				},
			],
		});
		render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
		// 内置分支也必须拉取系统工具列表（ToolsTab 依赖 tools prop 渲染，
		// 不拉取则永远停在“加载中...”）
		expect(
			apiCalls.some(
				(c) => c.method === "get" && c.path === "/api/agents/tools",
			),
		).toBe(true);
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

	test("内置 subagent 点保存触发 onClose", async () => {
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
		// 同上：await 保存回包后才关窗
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});
});

describe("审查修复：图标面板 Esc 关闭", () => {
	test("按 Escape 关闭图标面板，且不关闭外层编辑弹窗", () => {
		renderConfig("dev");
		fireEvent.click(screen.getByTestId("cfg-avatar-button"));
		expect(screen.getByTestId("cfg-avatar-panel")).toBeTruthy();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByTestId("cfg-avatar-panel")).toBeNull();
		// 外层弹窗还在
		expect(screen.getByTestId("agent-config")).toBeTruthy();
	});
});

describe("异步回包竞态门卫（draftDirtyRef）", () => {
	// 真实时序：mount 发出 config GET → 用户立刻编辑 → 回包才 resolve。
	// 修复前回包无条件 setDraft，把用户已做的修改静默回滚（E2E 冒烟发现）；
	// 修复后 draftDirtyRef 门卫：仅无在途编辑时才应用回包。
	test("在途编辑时延迟 GET 回包不得覆盖 draft（E2E 冒烟发现的真实竞态）", async () => {
		// store 缓存提供初始 draft（displayName=dev），config GET 挂起
		gateConfigGet = true;
		renderConfig("dev", cfg("dev", { description: "缓存旧简介" }));
		// draft 就绪后用户编辑：改 displayName（handleChange 置 dirty）
		const nameInput = (await waitFor(() =>
			screen.getByTestId("cfg-name-input"),
		)) as HTMLInputElement;
		expect(nameInput.value).toBe("dev");
		fireEvent.change(nameInput, { target: { value: "手动改名" } });
		expect(
			(screen.getByTestId("cfg-name-input") as HTMLInputElement).value,
		).toBe("手动改名");

		// 回包此刻才 resolve（携带不同数据），不得覆盖在途编辑
		await act(async () => {
			resolveConfigGate!({ config: cfg("dev") });
		});
		expect(
			(screen.getByTestId("cfg-name-input") as HTMLInputElement).value,
		).toBe("手动改名");

		// SSE 广播（agent:config）同走门卫：也不得覆盖
		await emitEvent({
			type: "agent:config",
			agentName: "dev",
			config: cfg("dev", { description: "广播数据" }),
		});
		expect(
			(screen.getByTestId("cfg-name-input") as HTMLInputElement).value,
		).toBe("手动改名");
	});

	// 门卫不得破坏原语义（「强制 API 重新加载，覆盖可能过期的 store 缓存」）：
	// 无在途编辑时，回包仍应覆盖 store 缓存 —— 否则重开弹窗永远显示旧数据
	test("无在途编辑时延迟回包仍覆盖 store 缓存（原「重开不显示旧数据」语义保留）", async () => {
		gateConfigGet = true;
		renderConfig("dev", cfg("dev", { description: "缓存旧简介" }));
		const nameInput = (await waitFor(() =>
			screen.getByTestId("cfg-name-input"),
		)) as HTMLInputElement;
		expect(nameInput.value).toBe("dev"); // 未做任何编辑

		await act(async () => {
			resolveConfigGate!({
				config: cfg("dev", { displayName: "研发", description: "磁盘新简介" }),
			});
		});
		expect(
			(screen.getByTestId("cfg-name-input") as HTMLInputElement).value,
		).toBe("研发");
	});
});

// ── S12：保存失败必须可见 ────────────────────────────────────────────────
// 修复前：handleSave 点火式发请求（saveOverride 内部 .catch(() => {}) 吞错）+ 立即 onClose，
// 保存失败被完全吞掉——用户以为绑定已保存，实际改动凭空消失。修复后：await → 成功才关窗，
// 失败 toast 报错并保持弹窗（用户可直接重试或修正）。
const mockSaveConfig = (
	status: number,
	body: { message?: string; error?: string },
) => {
	saveFailure = { status, body };
};

const errorToastMessages = () =>
	useToastStore
		.getState()
		.toasts.filter((t) => t.type === "error")
		.map((t) => t.message);

describe("保存失败可见（S12）", () => {
	test("命名 agent 保存失败：弹窗不关闭且 toast 报错（不再静默丢改动）", async () => {
		const onClose = mock();
		mockSaveConfig(500, { message: "knowledgeBaseIds 无效" });
		renderConfig("研发", cfg("研发"), onClose);
		fireEvent.click(screen.getByTestId("cfg-save"));
		await waitFor(() =>
			expect(errorToastMessages()).toContain("knowledgeBaseIds 无效"),
		);
		expect(onClose).not.toHaveBeenCalled();
	});

	test("内置 subagent 保存失败：saveOverride 抛错 → toast 报错且弹窗不关闭", async () => {
		const onClose = mock();
		const saveOverride = mock(() =>
			Promise.reject(new Error("knowledgeBaseIds 无效")),
		);
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
		render(<AgentConfig agentName="Plan" onClose={onClose} />);
		fireEvent.click(screen.getByTestId("cfg-save"));
		await waitFor(() =>
			expect(errorToastMessages()).toContain("knowledgeBaseIds 无效"),
		);
		expect(onClose).not.toHaveBeenCalled();
	});

	test("保存中禁用保存按钮：请求未落定时重复点击不重复提交", async () => {
		const onClose = mock();
		gatePut = true;
		renderConfig("dev", cfg("dev"), onClose);
		const btn = screen.getByTestId("cfg-save") as HTMLButtonElement;
		fireEvent.click(btn);
		await waitFor(() => expect(btn.disabled).toBe(true));
		fireEvent.click(btn);
		expect(apiCalls.filter((c) => c.method === "put")).toHaveLength(1);
		await act(async () => {
			resolvePutGate!({});
		});
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(errorToastMessages()).toEqual([]);
	});

	// 未绑定知识库的普通保存路径行为不变：成功 → 直接关窗，不发 toast
	test("普通保存成功：仍关窗且不弹错误 toast（原有行为不变）", async () => {
		const onClose = mock();
		renderConfig("dev", cfg("dev"), onClose);
		fireEvent.click(screen.getByTestId("cfg-save"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(errorToastMessages()).toEqual([]);
	});
});

// ── S12 复审修复轮 1 ────────────────────────────────────────────────────
// I-2：失败 → 改字段 → 再保存（成功）这条重试流程此前只有人工验证，无回归锁。
// I-3：内置 subagent 的 draft 由 store 的 subagent:list 广播重算（builtinDraft），
//      effect 顶部的 dirty 复位会把在途编辑标记冲掉 → 广播静默回滚未保存编辑。
const planInfo = {
	name: "Plan",
	displayName: "规划子智能体",
	description: "",
	emoji: "📐",
	gradient: ["#7c3aed", "#a78bfa"] as [string, string],
	readOnly: true,
	systemPrompt: "x",
	builtinToolNames: [],
};

describe("S12 复审修复轮 1", () => {
	test("保存失败后改字段再保存：第二次成功即关窗，载荷含新值", async () => {
		const onClose = mock();
		mockSaveConfig(500, { message: "knowledgeBaseIds 无效" });
		renderConfig("研发", cfg("研发"), onClose);
		fireEvent.click(screen.getByTestId("cfg-save"));
		await waitFor(() =>
			expect(errorToastMessages()).toContain("knowledgeBaseIds 无效"),
		);
		// 失败不关窗：用户还留在弹窗里，可改字段重试
		expect(onClose).not.toHaveBeenCalled();

		// 用户修正字段（改名）后再点保存：mockSaveConfig 是一次性的，这次走成功路径
		fireEvent.change(screen.getByTestId("cfg-name-input"), {
			target: { value: "研发二组" },
		});
		fireEvent.click(screen.getByTestId("cfg-save"));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		const puts = apiCalls.filter((c) => c.method === "put");
		expect(puts).toHaveLength(2);
		expect(puts[1].body.config.displayName).toBe("研发二组");
	});

	test("内置 subagent 编辑中收到 subagent:list 广播：draft 不被覆盖", async () => {
		useSubagentsStore.setState({
			subagents: [
				{ ...planInfo, override: { type: "Plan", thinking: "high" } },
			],
		});
		render(<AgentConfig agentName="Plan" onClose={() => {}} />);
		const thinkingSelect = screen.getByTestId(
			"cfg-thinking-select",
		) as HTMLSelectElement;
		fireEvent.change(thinkingSelect, { target: { value: "max" } });
		expect(thinkingSelect.value).toBe("max");

		// 广播到达：store 换成旧 override（thinking 仍是 high），builtinDraft 随之重算
		await act(async () => {
			useSubagentsStore.setState({
				subagents: [
					{ ...planInfo, override: { type: "Plan", thinking: "high" } },
				],
			});
		});
		expect(
			(screen.getByTestId("cfg-thinking-select") as HTMLSelectElement).value,
		).toBe("max");
	});
});
