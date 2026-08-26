import "./mock-composer-db";
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	act,
	cleanup,
} from "@testing-library/react";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import type { AgentConfig } from "@wa-pi/shared";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const sent: { path: string; body?: any }[] = [];
const composerDbNewSessionIds: Record<string, string> = {};

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: (path: string, body?: any) => {
			sent.push({ path, body });
			return Promise.resolve({});
		},
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
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

// mock-composer-db 未持久化 newSessionIds，这里再包一层，让切换新建会话的测试能复用同一 sessionId
mock.module("../src/store/composer-db", () => ({
	getDefaults: async () => ({ ...composerDbDefaults }),
	setDefaults: async () => {},
	getSessionPrefs: async (sessionId: string) => composerDbSessions[sessionId],
	setSessionPrefs: async () => {},
	deleteSessionPrefs: async () => {},
	getRecordingPrefs: async () => ({}),
	setRecordingPrefs: async () => {},
	getNewSessionIds: async () => ({ ...composerDbNewSessionIds }),
	setNewSessionIds: async (ids: Record<string, string>) => {
		for (const k of Object.keys(composerDbNewSessionIds))
			delete composerDbNewSessionIds[k];
		Object.assign(composerDbNewSessionIds, ids);
	},
}));

import { disconnectEvents } from "../src/events";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useBrowserStore } from "../src/store/browser";
import { useProvidersStore } from "../src/store/providers";
import { useRecordingStore } from "../src/store/recording";
import { _setRecordingManager } from "../src/recording/recorder";
import { useSkillsStore } from "../src/store/skills";

const agentCfg = (displayName: string): AgentConfig => ({
	displayName,
	avatar: "",
	avatarColor: "",
	description: "",
	model: "m",
	thinking: "medium",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
});

function typeIntoComposer(value: string) {
	const textbox = screen
		.getByTestId("composer-input")
		.querySelector('[role="textbox"]') as HTMLElement;
	textbox.textContent = value;
	fireEvent.input(textbox);
	return textbox;
}

function lastPrompt() {
	return sent.filter((s) => s.path.includes("/prompt")).at(-1)?.body;
}

const originalFetch = globalThis.fetch;

function mockFetch(path: string) {
	globalThis.fetch = mock(() =>
		Promise.resolve({ ok: true, json: () => Promise.resolve({ path }) }),
	) as any;
}

describe("NewSessionPane", () => {
	afterEach(() => cleanup());

	beforeEach(() => {
		composerDbDefaults.model = null;
		composerDbDefaults.thinking = "disabled";
		for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
		for (const k of Object.keys(composerDbNewSessionIds))
			delete composerDbNewSessionIds[k];

		sent.length = 0;
		disconnectEvents();
		mockFetch("/a/.wa-pi/uploads/note.txt");

		useProjectsStore.setState({
			projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
			sessions: [],
			currentProjectId: "p1",
			currentSessionId: null,
		});
		useComposerPrefsStore.setState({
			defaults: { model: null, thinking: "disabled" },
			bySession: {},
			newSessionIds: {},
		});
		useAgentsStore.setState({
			list: [
				agentCfg("需求设计"),
				agentCfg("项目管理"),
				agentCfg("技术实现"),
				agentCfg("质量验收"),
			],
		});
		useRecordingStore.setState({
			status: "idle",
			source: "mic",
			owningProjectId: "",
			owningSessionId: "",
			ownerLabel: "",
			startedAt: 0,
			elapsedMs: 0,
			error: undefined,
		});
		_setRecordingManager({
			start: async () => {},
			pause: () => {},
			resume: () => {},
			stop: async () => ({ path: "", size: 0, durationMs: 0 }),
		});
		useSkillsStore.setState({
			skills: [],
			allSkills: [],
			dirs: [],
			disabledSkills: [],
			builtinDir: "",
			loading: false,
			load: () => {},
			setAll: () => {},
			toggleSkill: () => {},
			addDir: () => {},
			removeDir: () => {},
		});
	});

	afterEach(() => {
		useSkillsStore.setState(useSkillsStore.getInitialState(), true);
		globalThis.fetch = originalFetch;
	});

	it("renders project and agent selects", () => {
		render(<NewSessionPane />);
		expect(screen.getByTestId("project-select")).toBeTruthy();
		expect(screen.getByTestId("agent-select")).toBeTruthy();
	});

	it("顶部有预览浏览器图标：点击后打开浏览器预览并归属到新建会话锚点", () => {
		render(<NewSessionPane />);
		const btn = screen.getByTestId("btn-browser-preview");
		expect(btn).toBeTruthy();
		fireEvent.click(btn);
		// 打开预览：browser store 置 open=true，归属到新建会话锚点 sessionId（按会话记忆）
		const st = useBrowserStore.getState();
		expect(st.open).toBe(true);
		expect(st.sessionId).not.toBeNull();
	});

	it("切回新建会话页时恢复此前打开的预览（按会话记忆）", () => {
		// 固定新建页锚点 sessionId：与 composer 草稿同一持久化机制
		const anchor = "draft-session-anchor";
		composerDbNewSessionIds["p1"] = anchor;
		useComposerPrefsStore.setState({ newSessionIds: { p1: anchor } });
		// 预设：该锚点此前打开过预览（切走时被记忆）
		useBrowserStore.setState({
			open: false,
			path: null,
			sessionId: null,
			bySession: {
				[anchor]: { open: true, path: "/a/index.html", minimized: false },
			},
		});

		render(<NewSessionPane />);
		expect(useBrowserStore.getState().open).toBe(true);
		expect(useBrowserStore.getState().path).toBe("/a/index.html");
		expect(useBrowserStore.getState().sessionId).toBe(anchor);
	});

	it("新建页开预览→切走→切回：预览应恢复（卸载-重挂载真实序列）", () => {
		const anchor = "draft-session-anchor";
		composerDbNewSessionIds["p1"] = anchor;
		useComposerPrefsStore.setState({ newSessionIds: { p1: anchor } });

		// 1) 新建页挂载，打开带 path 的 html 预览并归属到本页锚点 sessionId
		//    （等价修复后文件树双击 openBrowser(path, sessionId)）。
		const { unmount } = render(<NewSessionPane />);
		useBrowserStore.getState().openBrowser("/a/index.html", anchor);
		expect(useBrowserStore.getState().open).toBe(true);
		expect(useBrowserStore.getState().sessionId).toBe(anchor);

		// 2) 切走：卸载新建页，模拟 activateSession 到真实会话
		unmount();
		useBrowserStore.getState().activateSession("A");
		expect(useBrowserStore.getState().open).toBe(false); // 切到 A（无预览）关闭

		// 3) 切回新建页：重新挂载 → 应恢复锚点预览（含 path）
		render(<NewSessionPane />);
		expect(useBrowserStore.getState().open).toBe(true);
		expect(useBrowserStore.getState().path).toBe("/a/index.html");
		expect(useBrowserStore.getState().sessionId).toBe(anchor);
	});

	it("clears text after sending", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);
		await waitFor(() => {
			expect(useComposerPrefsStore.getState().defaults.model).toBe(
				"openai/gpt-4o",
			);
		});
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});
		const textbox = typeIntoComposer("你好");
		expect(textbox.textContent).toBe("你好");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.click(screen.getByTestId("composer-send"));
		await waitFor(() => {
			expect(textbox.textContent).toBe("");
		});
	});

	it("sends first prompt with model and thinking", async () => {
		composerDbDefaults.model = "claude-sonnet";
		composerDbDefaults.thinking = "high";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "anthropic",
					api: "anthropic-messages",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "claude-sonnet", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		useComposerPrefsStore.setState({
			defaults: { model: null, thinking: "disabled" },
			bySession: {},
		});

		render(<NewSessionPane />);

		await waitFor(() => {
			expect(useComposerPrefsStore.getState().defaults.model).toBe(
				"anthropic/claude-sonnet",
			);
		});
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("anthropic/claude-sonnet");
		});

		typeIntoComposer("hello");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.click(screen.getByTestId("composer-send"));

		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({
				agentName: useAgentsStore.getState().list[0].displayName,
				text: "hello",
				model: "anthropic/claude-sonnet",
				thinking: "high",
			});
		});
		const req = sent.find((s) => s.path.includes("/prompt"));
		expect(req?.path).toMatch(/^\/api\/agents\/p1\/[^/]+\/prompt$/);
	});

	it("sends prompt with attachments", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);

		await waitFor(() => {
			expect(useComposerPrefsStore.getState().defaults.model).toBe(
				"openai/gpt-4o",
			);
		});
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});

		const fileInput = screen
			.getByTestId("composer-input")
			.querySelector("input[type=file]")!;
		const file = new File(["content"], "note.txt", { type: "text/plain" });
		fireEvent.change(fileInput, { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.getByTestId("attachment-list")).toBeTruthy();
		});

		typeIntoComposer("with attachment");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.click(screen.getByTestId("composer-send"));

		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({
				agentName: useAgentsStore.getState().list[0].displayName,
				text: "with attachment",
				attachments: [
					expect.objectContaining({
						kind: "file",
						name: "note.txt",
						path: "/a/.wa-pi/uploads/note.txt",
					}),
				],
			});
		});
	});

	it("@提及智能体：primaryAgent 仍为 dropdown 默认 agent，@[xxx] 原样发（新会话也走委托）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});

		const defaultAgent = useAgentsStore.getState().list[0].displayName;

		typeIntoComposer("@[项目管理] 帮我看看需求");
		fireEvent.click(screen.getByTestId("composer-send"));

		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({
				agentName: defaultAgent,
				text: "@[项目管理] 帮我看看需求",
			});
		});
		const session = useProjectsStore.getState().sessions[0];
		expect(session.primaryAgent).toBe(defaultAgent);
		expect(screen.queryByTestId("mention-confirm")).toBeNull();
	});

	it("@ 菜单选中 agent 不切换 dropdown（主智能体不变）", async () => {
		useAgentsStore.setState({
			list: [
				{ ...agentCfg("需求设计"), partners: { askTo: ["项目管理"] } },
				agentCfg("项目管理"),
				agentCfg("技术实现"),
				agentCfg("质量验收"),
			],
		});
		render(<NewSessionPane />);
		const defaultAgent = useAgentsStore.getState().list[0].displayName;
		expect(screen.getByTestId("agent-select").textContent).toContain(
			defaultAgent,
		);

		typeIntoComposer("@项");
		const menuItem = await waitFor(() => screen.getByText("项目管理"));
		fireEvent.click(menuItem);

		expect(screen.getByTestId("agent-select").textContent).toContain(
			defaultAgent,
		);
		expect(screen.getByTestId("agent-select").textContent).not.toContain(
			"项目管理",
		);
	});

	it("新会话开始录音、切换会话再回来后停止，附件仍回到当前新建会话", async () => {
		_setRecordingManager({
			start: async () => {},
			pause: () => {},
			resume: () => {},
			stop: async () => ({
				path: "/a/.wa-pi/uploads/recording.webm",
				size: 100,
				durationMs: 5000,
			}),
		});
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";

		const { unmount } = render(<NewSessionPane />);
		await waitFor(() => {
			expect(useComposerPrefsStore.getState().defaults.model).toBe(
				"openai/gpt-4o",
			);
		});
		await act(async () => {});

		fireEvent.click(screen.getByTestId("record-button"));
		await waitFor(() =>
			expect(useRecordingStore.getState().status).toBe("recording"),
		);
		const owningSessionId = useRecordingStore.getState().owningSessionId;
		expect(owningSessionId).toBeTruthy();

		unmount();
		render(<NewSessionPane />);
		await act(async () => {});

		await act(async () => {
			await useRecordingStore.getState().stop();
		});

		await waitFor(() => {
			expect(screen.getByTestId("attachment-list")).toBeTruthy();
		});
		const list = screen.getByTestId("attachment-list");
		expect(list.textContent).toContain("录音 0:05.webm");
		expect(
			useComposerPrefsStore.getState().bySession[owningSessionId]?.attachments
				?.length,
		).toBeGreaterThanOrEqual(1);
	});

	it("默认选中最近使用的智能体（按名下会话 lastActivity 最大），而非列表第一项", () => {
		useProjectsStore.setState({
			projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
			sessions: [
				{
					id: "old1",
					projectId: "p1",
					primaryAgent: "pm",
					title: "t",
					createdAt: 0,
					lastActivity: 100,
					piSessionFile: "",
				},
				{
					id: "recent",
					projectId: "p1",
					primaryAgent: "dev",
					title: "t",
					createdAt: 0,
					lastActivity: 999,
					piSessionFile: "",
				},
			],
			currentProjectId: "p1",
			currentSessionId: null,
		});
		render(<NewSessionPane />);
		const pillText = screen.getByTestId("agent-select").textContent ?? "";
		expect(pillText).toContain("技术实现");
		expect(pillText).not.toContain("需求设计");
	});

	it("无会话历史时默认回退列表第一项", () => {
		render(<NewSessionPane />);
		expect(screen.getByTestId("agent-select").textContent).toContain("需求设计");
	});

	it("agent 下拉来自 agents store，pendingAgent 预选", () => {
		useAgentsStore.setState({
			list: [agentCfg("需求设计"), agentCfg("代码审查")],
		});
		render(<NewSessionPane pendingAgent="代码审查" />);
		expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
		fireEvent.click(screen.getByTestId("agent-select"));
		expect(screen.getByTestId("agent-item-需求设计")).toBeTruthy();
		expect(screen.getByTestId("agent-item-代码审查")).toBeTruthy();
	});

	it("pendingAgent 变化时同步到下拉（已挂载新建页再点智能体）", () => {
		useAgentsStore.setState({
			list: [agentCfg("技术实现"), agentCfg("代码审查")],
		});
		const { rerender } = render(<NewSessionPane />);
		expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
		rerender(<NewSessionPane pendingAgent="代码审查" />);
		expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
	});

	it("agents list 为空时 pill 显示占位，展开下拉提示无智能体", () => {
		useAgentsStore.setState({ list: [] });
		render(<NewSessionPane />);
		expect(screen.getByTestId("agent-select").textContent).toContain(
			"选择智能体",
		);
		fireEvent.click(screen.getByTestId("agent-select"));
		expect(screen.getByText(/无智能体/)).toBeTruthy();
	});

	it("agent:list 空转非空时回填选中项为列表第一项，发送解禁", async () => {
		useAgentsStore.setState({ list: [] });
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});
		typeIntoComposer("hello");
		const btn = screen.getByTestId("composer-send") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		act(() => {
			useAgentsStore.setState({
				list: [agentCfg("技术实现"), agentCfg("质量验收")],
			});
		});
		expect(btn.disabled).toBe(false);
		expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
	});

	it("空智能体列表：无有效选中值且发送被阻止（不回退到死智能体 dev）", async () => {
		useAgentsStore.setState({ list: [] });
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});
		expect(screen.getByTestId("agent-select").textContent).toContain(
			"选择智能体",
		);
		typeIntoComposer("hello");
		const btn = screen.getByTestId("composer-send") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		fireEvent.click(btn);
		expect(sent.some((s) => s.path.includes("/prompt"))).toBe(false);
	});

	it("项目下拉出现默认工作区选项且不带 cwd", () => {
		useProjectsStore.setState({
			projects: [
				{
					id: SYSTEM_PROJECT_ID,
					name: "默认工作区",
					cwd: "/tmp/workdir",
					createdAt: 0,
				},
				{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
			],
			sessions: [],
			currentProjectId: null,
			currentSessionId: null,
		});
		render(<NewSessionPane />);
		const select = screen.getByTestId("project-select") as HTMLSelectElement;
		const sysOption = Array.from(select.options).find(
			(o) => o.value === SYSTEM_PROJECT_ID,
		);
		expect(sysOption).toBeDefined();
		expect(sysOption!.textContent).toContain("默认工作区");
		expect(sysOption!.textContent).not.toContain("/tmp/workdir");
		const normalOption = Array.from(select.options).find((o) => o.value === "p1");
		expect(normalOption).toBeDefined();
		expect(normalOption!.textContent).toContain("/work/wa-pi");
	});

	it("首次进入时默认选中默认工作区", () => {
		useProjectsStore.setState({
			projects: [
				{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
				{
					id: SYSTEM_PROJECT_ID,
					name: "默认工作区",
					cwd: "/tmp/workdir",
					createdAt: 0,
				},
			],
			sessions: [],
			currentProjectId: null,
			currentSessionId: null,
		});
		render(<NewSessionPane />);
		const select = screen.getByTestId("project-select") as HTMLSelectElement;
		expect(select.value).toBe(SYSTEM_PROJECT_ID);
	});

	it("发送后确保导航到新建的会话（不复用已存在的旧会话 id）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});

		// 模拟打包态真实场景：存在一个旧会话，且 newSessionIds 残留了它的 id（session:created 未及时清除 / app 重启后从 IndexedDB 读出）
		const staleId = "s-old-session";
		useProjectsStore.setState({
			sessions: [
				{
					id: staleId,
					projectId: "p1",
					primaryAgent: "dev",
					title: "旧会话",
					createdAt: 0,
					lastActivity: 0,
					piSessionFile: "",
				},
			],
		});
		composerDbNewSessionIds["p1"] = staleId;
		useComposerPrefsStore.setState({ newSessionIds: { p1: staleId } });

		render(<NewSessionPane />);
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});

		typeIntoComposer("全新会话");
		fireEvent.click(screen.getByTestId("composer-send"));

		// 关键断言：必须创建一个全新的会话（新 id），而不是复用 staleId 跳到旧会话
		await waitFor(() => {
			const state = useProjectsStore.getState();
			expect(state.currentSessionId).not.toBe(staleId);
			expect(
				state.sessions.some((s) => s.id !== staleId && s.title === "全新会话"),
			).toBe(true);
		});
	});

	it("恢复新建页草稿文本（切走再回来不丢）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		composerDbNewSessionIds["p1"] = "draft-session-1";
		// 同步预置内存态：NewSessionPane 挂载时 sessionId-sync effect 先于 loadDefaults 的异步读执行，
		// 若内存态为空会生成全新随机 id 并回写 db（覆盖上面的映射）；与既有用例「发送后确保导航…」同一套路。
		useComposerPrefsStore.setState({
			newSessionIds: { p1: "draft-session-1" },
		});
		composerDbSessions["draft-session-1"] = {
			model: "gpt-4o",
			thinking: "disabled",
			attachments: [],
			text: "新建页草稿",
		};
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});

		render(<NewSessionPane />);
		const textbox = screen
			.getByTestId("composer-input")
			.querySelector('[role="textbox"]') as HTMLElement;
		await waitFor(() => {
			expect(textbox.textContent).toBe("新建页草稿");
		});
	});

	it("新建页输入防抖写回草稿", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		composerDbNewSessionIds["p1"] = "draft-session-2";
		// 同步预置内存态（同「恢复新建页草稿」用例）：确保 sessionId 可预测为 draft-session-2
		useComposerPrefsStore.setState({
			newSessionIds: { p1: "draft-session-2" },
		});
		composerDbSessions["draft-session-2"] = {
			model: "gpt-4o",
			thinking: "disabled",
			attachments: [],
		};
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});

		render(<NewSessionPane />);
		typeIntoComposer("新建页输入");
		await new Promise((r) => setTimeout(r, 350));
		const sid =
			useComposerPrefsStore.getState().newSessionIds["p1"] ?? "draft-session-2";
		expect(useComposerPrefsStore.getState().bySession[sid]?.text).toBe(
			"新建页输入",
		);
	});

	it("新建页切换模型后发送：会话级 prefs 记录所选模型（聊天界面显示与所选一致）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [
						{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 },
						{ id: "gpt-5", contextWindow: 128000, maxTokens: 4096 },
					],
				},
			],
		});

		render(<NewSessionPane />);

		// 初始默认模型 gpt-4o
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});

		// 用户在新建页把模型切换为 gpt-5
		// happy-dom 对受控 select 的 value 变化检测有兼容问题：首次 fireEvent.change 不触发
		// React onChange（value tracker 未感知 DOM 变化），第二次才生效。真实浏览器无此问题。
		fireEvent.change(screen.getByTestId("model-selector"), {
			target: { value: "openai/gpt-5", selectedIndex: 2 },
		});
		fireEvent.change(screen.getByTestId("model-selector"), {
			target: { value: "openai/gpt-5", selectedIndex: 2 },
		});
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-5");
		});

		typeIntoComposer("hello");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.click(screen.getByTestId("composer-send"));

		// 发送的 prompt 用的是用户选择的模型
		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({ model: "openai/gpt-5" });
		});

		// 关键断言：发送后会话级 prefs 必须是用户刚选的模型 gpt-5
		// （进入会话后 Composer/ModelSelector 读的是 bySession[sessionId].model）
		const sid = useProjectsStore.getState().currentSessionId!;
		expect(useComposerPrefsStore.getState().bySession[sid]?.model).toBe(
			"openai/gpt-5",
		);
	});

	it("existed 分支：草稿 id 残留旧会话时，发送后模型应落到新会话 id（不再依赖 defaults 回退）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [
						{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 },
						{ id: "gpt-5", contextWindow: 128000, maxTokens: 4096 },
					],
				},
			],
		});

		// 模拟草稿 id 残留：newSessionIds 残留一个已发送的旧会话 id（existed 分支）
		const staleId = "s-old-session";
		useProjectsStore.setState({
			sessions: [
				{
					id: staleId,
					projectId: "p1",
					primaryAgent: "dev",
					title: "旧会话",
					createdAt: 0,
					lastActivity: 0,
					piSessionFile: "",
				},
			],
		});
		composerDbNewSessionIds["p1"] = staleId;
		useComposerPrefsStore.setState({ newSessionIds: { p1: staleId } });

		render(<NewSessionPane />);
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});

		// 切模型为 gpt-5
		fireEvent.change(screen.getByTestId("model-selector"), {
			target: { value: "openai/gpt-5", selectedIndex: 2 },
		});
		fireEvent.change(screen.getByTestId("model-selector"), {
			target: { value: "openai/gpt-5", selectedIndex: 2 },
		});
		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-5");
		});

		typeIntoComposer("hello");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.click(screen.getByTestId("composer-send"));

		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({ model: "openai/gpt-5" });
		});

		const sid = useProjectsStore.getState().currentSessionId!;
		expect(sid).not.toBe(staleId); // 确认 existed 分支：finalId 分叉

		// 关键断言：finalId 的会话级 prefs 应记录用户选的 gpt-5（详情页 Composer 读它，而非回退 defaults 显示旧模型）
		expect(useComposerPrefsStore.getState().bySession[sid]?.model).toBe(
			"openai/gpt-5",
		);
	});

	it("未传 onSendSteer 时 Ctrl+Enter 仍发送（回归：NewSessionPane 不因新分支拦截而无动作）", async () => {
		composerDbDefaults.model = "gpt-4o";
		composerDbDefaults.thinking = "disabled";
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "openai",
					api: "openai-completions",
					baseUrl: "",
					apiKey: "",
					models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
				},
			],
		});
		render(<NewSessionPane />);

		await waitFor(() => {
			expect(
				(screen.getByTestId("model-selector") as HTMLSelectElement).value,
			).toBe("openai/gpt-4o");
		});
		const textbox = typeIntoComposer("Ctrl+Enter 也要发送");
		await waitFor(() => {
			expect(
				(screen.getByTestId("composer-send") as HTMLButtonElement).disabled,
			).toBe(false);
		});
		fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

		// NewSessionPane 未传 onSendSteer：Ctrl+Enter 回退普通发送 → 仍调 /prompt 并清空文本
		// （改动前 Ctrl+Enter 落入普通 Enter 分支同样发送，此处验证行为未回归）
		await waitFor(() => {
			expect(lastPrompt()).toMatchObject({
				agentName: useAgentsStore.getState().list[0].displayName,
				text: "Ctrl+Enter 也要发送",
				model: "openai/gpt-4o",
			});
		});
		await waitFor(() => {
			expect(textbox.textContent).toBe("");
		});
	});
});
