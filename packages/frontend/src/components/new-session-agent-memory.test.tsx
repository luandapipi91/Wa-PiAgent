// 新建会话默认角色记忆（第二层组件测试）：
// ① 下拉选择的角色立即写入 ui-prefs.lastAgent（持久化，下次新建页默认用它）；
// ② 从已有会话进入新建页时，沿用该会话的角色（覆盖 lastAgent）；
// ③ pendingAgent 在面板已挂载时变化也要被应用并消费，不能残留钉住下次默认角色。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";

mock.module("../api-client", () => ({
	api: {
		get: mock(async () => ({})),
		post: mock(async () => ({})),
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));
mock.module("../store/composer-db", () => ({
	getSessionPrefs: async () => undefined,
	setSessionPrefs: async () => {},
	deleteSessionPrefs: async () => {},
	getDefaults: async () => ({
		model: "test-p/m1",
		thinkingByModel: { "test-p/m1": "high" },
	}),
	setDefaults: async () => {},
	getRecordingPrefs: async () => undefined,
	setRecordingPrefs: async () => {},
	getNewSessionIds: async () => ({}),
	setNewSessionIds: async () => {},
}));

import { NewSessionPane } from "./NewSessionPane";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useUiPrefsStore } from "../store/ui-prefs";

const AGENTS = [
	{ displayName: "高级项目经理", avatar: "📋", avatarColor: "#D97706-#F59E0B" },
	{ displayName: "产品经理", avatar: "📝", avatarColor: "#2563EB-#3B82F6" },
	{ displayName: "代码审查员", avatar: "🔍", avatarColor: "#059669-#10B981" },
] as any;

beforeEach(() => {
	// 防御：全量运行时其他测试可能替换 globalThis.window（同 AgentGalleryModal-create.test.tsx）
	if (
		typeof window.addEventListener !== "function" &&
		(document as any).defaultView
	) {
		(globalThis as any).window = (document as any).defaultView;
	}
	useProjectsStore.setState({
		projects: [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }] as any,
		sessions: [
			{ id: "s-old", projectId: "proj-1", primaryAgent: "高级项目经理" },
		] as any,
		currentProjectId: "proj-1",
		currentSessionId: null,
	} as any);
	useAgentsStore.setState({ list: AGENTS } as any);
	useProvidersStore.setState({
		providers: [
			{
				id: "p1",
				name: "TestP",
				slug: "test-p",
				baseUrl: "",
				apiKey: "",
				api: "openai-completions",
				models: [{ id: "m1", name: "m1" }],
			},
		],
	} as any);
	useComposerPrefsStore.setState({
		newSessionIds: {},
		defaults: { model: "test-p/m1", thinkingByModel: { "test-p/m1": "high" } },
		bySession: {},
		loadedBySession: {},
	} as any);
	useUiPrefsStore.setState({ lastAgent: null, defaultAgent: null } as any);
});

/** 当前 pill 上显示的角色名 */
function selectedAgent() {
	return screen.getByTestId("agent-select").textContent ?? "";
}

test("下拉选择角色后立即写入 lastAgent 并落到 localStorage", async () => {
	render(<NewSessionPane />);
	await new Promise((r) => setTimeout(r, 20));

	fireEvent.click(screen.getByTestId("agent-select"));
	fireEvent.click(screen.getByTestId("agent-item-产品经理"));

	expect(useUiPrefsStore.getState().lastAgent).toBe("产品经理");
	expect(selectedAgent()).toContain("产品经理");
	// 持久化：zustand persist 同步写 localStorage
	const raw = window.localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toContain("产品经理");
});

test("默认选中 lastAgent（优先于最近活跃）", async () => {
	useUiPrefsStore.setState({ lastAgent: "产品经理" } as any);
	render(<NewSessionPane />);
	await new Promise((r) => setTimeout(r, 20));
	expect(selectedAgent()).toContain("产品经理");
});

test("从已有会话进入新建页：沿用该会话的角色，覆盖 lastAgent", async () => {
	useUiPrefsStore.setState({ lastAgent: "产品经理" } as any);
	useProjectsStore.setState({
		sessions: [
			{
				id: "s-cur",
				projectId: "proj-1",
				primaryAgent: "代码审查员",
				title: "旧会话",
				createdAt: 1,
				lastActivity: 1,
			},
		] as any,
		currentSessionId: "s-cur",
	} as any);
	render(<NewSessionPane />);
	await new Promise((r) => setTimeout(r, 20));
	expect(selectedAgent()).toContain("代码审查员");
});

test("面板已挂载时 pendingAgent 变化：应用该角色并消费（不残留）", async () => {
	const consumed: string[] = [];
	const { rerender } = render(
		<NewSessionPane
			pendingAgent={null}
			onConsumePendingAgent={() => consumed.push("x")}
		/>,
	);
	await new Promise((r) => setTimeout(r, 20));
	expect(selectedAgent()).toContain("高级项目经理");

	await act(async () => {
		rerender(
			<NewSessionPane
				pendingAgent="产品经理"
				onConsumePendingAgent={() => consumed.push("x")}
			/>,
		);
	});
	expect(selectedAgent()).toContain("产品经理");
	// 关键：已挂载场景也必须消费，否则 App 侧 pendingAgent 残留、下次进新建页钉死旧角色
	expect(consumed.length).toBe(1);
});
