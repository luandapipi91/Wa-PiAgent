// 新建会话发送链路组件测试（第二层）：发送后草稿 sessionId 必须被消费。
// 回归 bug：kernel 对 placeholder 转正走 isNew=false 分支、不广播 session:created，
// 前端若只依赖 App.tsx 的 clearNewSessionId 清除点，草稿 id 永久残留（localStorage 持久化），
// 下次进新建页复用同一 id ——「无论发什么消息都跑到同一个会话」。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

const postMock = mock();
mock.module("../api-client", () => ({
	api: {
		get: mock(async () => ({})),
		post: postMock,
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));
// 模拟「重启后从持久层恢复出已发送过的草稿 id」：getNewSessionIds 返回残留的 draft-123。
// dbDefaults 用可变变量：个别用例需给持久层种入 delegate 默认字段（见底部新建页初始值用例）
let dbDefaults: any = {
	model: "test-p/m1",
	thinkingByModel: { "test-p/m1": "high" },
};
mock.module("../store/composer-db", () => ({
	getSessionPrefs: async () => undefined,
	setSessionPrefs: async () => {},
	deleteSessionPrefs: async () => {},
	getDefaults: async () => dbDefaults,
	setDefaults: async () => {},
	getRecordingPrefs: async () => undefined,
	setRecordingPrefs: async () => {},
	getNewSessionIds: async () => ({ "proj-1": "draft-123" }),
	setNewSessionIds: async () => {},
}));

import { NewSessionPane } from "./NewSessionPane";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useSessionStore } from "../store/session";

beforeEach(() => {
	// 防御：全量运行时其他测试可能替换 globalThis.window（同 AgentGalleryModal-create.test.tsx）
	if (
		typeof window.addEventListener !== "function" &&
		(document as any).defaultView
	) {
		(globalThis as any).window = (document as any).defaultView;
	}
	postMock.mockReset();
	postMock.mockImplementation(async () => ({}));
	dbDefaults = {
		model: "test-p/m1",
		thinkingByModel: { "test-p/m1": "high" },
	};
	useProjectsStore.setState({
		projects: [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }] as any,
		sessions: [],
		currentProjectId: "proj-1",
		currentSessionId: null,
	} as any);
	useAgentsStore.setState({ list: [{ displayName: "dev" }] } as any);
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
		// 模拟残留草稿 id（重启后从 localStorage/IDB 恢复的场景）
		newSessionIds: { "proj-1": "draft-123" },
		defaults: { model: "test-p/m1", thinkingByModel: { "test-p/m1": "high" } },
		bySession: {},
		loadedBySession: {},
	} as any);
});

test("新建会话发送后草稿 id 被消费，不会被下次新建复用", async () => {
	render(<NewSessionPane />);
	// 等 loadDefaults hydration 完成（持久层恢复出 draft-123 并同步到 sessionId state）
	await new Promise((r) => setTimeout(r, 50));
	// ComposerTextarea 是 contentEditable（role=textbox）：直接写 DOM 文本再触发 input
	const editor = await screen.findByRole("textbox");
	editor.textContent = "你好";
	fireEvent.input(editor);
	fireEvent.click(screen.getByTestId("composer-send"));
	await new Promise((r) => setTimeout(r, 0));

	// 消息发往草稿 id 对应的会话（首发复用 draftId 是预期：placeholder 预热记录挂在该 id 上）
	expect(postMock).toHaveBeenCalled();
	const url = postMock.mock.calls[0][0] as string;
	expect(url).toContain("draft-123");

	// 关键断言：发送后草稿 id 必须被消费——
	// newSessionIds 里可以是空（等下次挂载重新生成）或全新随机 id，但绝不能仍是 draft-123
	expect(useComposerPrefsStore.getState().newSessionIds["proj-1"]).not.toBe(
		"draft-123",
	);
});

test("新建会话发送后记录 pendingPromptAt（窗口内显示「会话新建中」加载页）", async () => {
	useSessionStore.setState({ pendingPromptAtBySession: {} } as any);
	render(<NewSessionPane />);
	await new Promise((r) => setTimeout(r, 50));
	const editor = await screen.findByRole("textbox");
	editor.textContent = "你好";
	fireEvent.input(editor);
	fireEvent.click(screen.getByTestId("composer-send"));
	await new Promise((r) => setTimeout(r, 0));
	const sid = useProjectsStore.getState().currentSessionId!;
	expect(sid).toBeTruthy();
	// 发送后立即记录发送时刻戳：窗口内无消息/流式时显示「会话新建中」加载页
	expect(
		useSessionStore.getState().pendingPromptAtBySession[sid],
	).toBeGreaterThan(0);
});

test("api.post 失败时记录 promptError（错误不被吞）", async () => {
	postMock.mockReset();
	postMock.mockRejectedValue(new Error("agent 启动失败: No API key"));
	render(<NewSessionPane />);
	await new Promise((r) => setTimeout(r, 50));
	const textbox = screen.getByRole("textbox");
	fireEvent.input(textbox, { target: { textContent: "你好" } });
	fireEvent.keyDown(textbox, { key: "Enter" });
	await new Promise((r) => setTimeout(r, 20));
	const errs = useSessionStore.getState().promptErrorBySession;
	const values = Object.values(errs).filter((v) => !!v);
	expect(values.length).toBeGreaterThan(0);
	expect(values[0]).toContain("No API key");
});

// 委派接入全局默认层：新建页 delegate 初始值来自 defaults（含异步加载时序）——
// 冷启动时 store defaults 无 delegate 字段，挂载后 loadDefaults 从持久层读回，
// 同步 effect 把值刷进本地两栏；不手动选择直接发送时，请求体应携带 defaults 的委派值
test("新建页 delegate 初始值来自 defaults（异步加载后同步，发送显式携带）", async () => {
	// 冷启动：持久层已有上次手动选择的委派默认，内存 defaults 尚无（beforeEach 已置不带 delegate 的形状）
	dbDefaults = {
		model: "test-p/m1",
		thinkingByModel: { "test-p/m1": "high" },
		delegateModel: "test-p/m1",
		delegateThinking: "max",
	};
	render(<NewSessionPane />);
	// 等 loadDefaults hydration 完成 + 同步 effect 刷本地两栏
	await new Promise((r) => setTimeout(r, 50));

	// UI 回显：委派按钮显示 defaults 的两栏值（厂商/模型 全名 TestP/m1）
	expect(screen.getByTestId("delegate-selector").textContent).toBe(
		"TestP/m1 | max",
	);

	// 不触碰委派直接发送：请求体显式携带 defaults 的初始值
	const editor = screen.getByRole("textbox");
	editor.textContent = "你好";
	fireEvent.input(editor);
	fireEvent.click(screen.getByTestId("composer-send"));
	await new Promise((r) => setTimeout(r, 0));
	expect(postMock).toHaveBeenCalled();
	const payload = postMock.mock.calls[0][1] as any;
	expect(payload.delegateModel).toBe("test-p/m1");
	expect(payload.delegateThinking).toBe("max");
});
