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
// 模拟「重启后从持久层恢复出已发送过的草稿 id」：getNewSessionIds 返回残留的 draft-123
mock.module("../store/composer-db", () => ({
	getSessionPrefs: async () => undefined,
	setSessionPrefs: async () => {},
	deleteSessionPrefs: async () => {},
	getDefaults: async () => ({ model: "test-p/m1", thinking: "high" }),
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
		defaults: { model: "test-p/m1", thinking: "high" },
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
