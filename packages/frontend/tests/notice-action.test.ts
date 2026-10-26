// 通知点击跳转分发：handleNoticeAction 按 action.type 分发到 browser/projects/settings store
import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionEntity } from "@wa-pi/shared";

// load() 经 api.get("/api/projects") 拉快照，用可变载荷供各用例注入（参照 session-sound.test.ts 模式）
const projectListPayload: { projects: unknown[]; sessions: SessionEntity[] } = {
	projects: [],
	sessions: [],
};

// projects store 顶层 import api-client，mock 掉避免真实请求
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) =>
			path === "/api/projects"
				? Promise.resolve(projectListPayload)
				: Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { useBrowserStore } from "../src/store/browser";
import { handleNoticeAction } from "../src/store/notice";
import { useProjectsStore } from "../src/store/projects";
import { useSettingsStore } from "../src/store/settings";

function session(id: string): SessionEntity {
	return {
		id,
		projectId: "p1",
		primaryAgent: "dev",
		title: `会话${id}`,
		createdAt: 0,
		lastActivity: 0,
		piSessionFile: "",
	};
}

beforeEach(() => {
	projectListPayload.projects = [];
	projectListPayload.sessions = [];
	useProjectsStore.setState({
		projects: [],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	useBrowserStore.setState({ sessionId: null });
	useSettingsStore.setState({ showSettings: false, activeSection: "general" });
});

test("type=session 且会话在列表 → browserStore.activateSession + projectsStore.selectSession 被调，返回 'session'", () => {
	useProjectsStore.setState({ sessions: [session("s1")] });
	const result = handleNoticeAction({ type: "session", sessionId: "s1" });
	expect(result).toBe("session");
	// activateSession(id)：browser store 当前会话切到 s1
	expect(useBrowserStore.getState().sessionId).toBe("s1");
	// selectSession(id)：选中 s1 且跟随其所属项目（证明走了 target 存在分支）
	expect(useProjectsStore.getState().currentSessionId).toBe("s1");
	expect(useProjectsStore.getState().currentProjectId).toBe("p1");
});

test("type=session 会话不在列表 → 先 projectsStore.load() 再 selectSession，返回 'session'", async () => {
	// 模拟 kernel 侧已有该会话但本地列表尚未同步：load() 拉回后才可选中
	projectListPayload.projects = [{ id: "p1", name: "P", cwd: "/tmp/p" }];
	projectListPayload.sessions = [session("s9")];
	const result = handleNoticeAction({ type: "session", sessionId: "s9" });
	expect(result).toBe("session");
	// load → selectSession 是异步链，等微任务排空再断言
	await new Promise((r) => setTimeout(r, 0));
	expect(
		useProjectsStore.getState().sessions.some((x) => x.id === "s9"),
	).toBe(true);
	expect(useProjectsStore.getState().currentSessionId).toBe("s9");
});

test("type=update → settingsStore showSettings=true 且 activeSection==='about'，返回 'settings'", () => {
	const result = handleNoticeAction({ type: "update" });
	expect(result).toBe("settings");
	expect(useSettingsStore.getState().showSettings).toBe(true);
	expect(useSettingsStore.getState().activeSection).toBe("about");
});

test("未知 type → 返回 null，三个 store 均无变化", () => {
	useProjectsStore.setState({ sessions: [session("s1")] });
	const before = {
		browserSessionId: useBrowserStore.getState().sessionId,
		currentSessionId: useProjectsStore.getState().currentSessionId,
		showSettings: useSettingsStore.getState().showSettings,
		activeSection: useSettingsStore.getState().activeSection,
	};
	// 桥来自主进程，类型上仅白名单两种，运行时仍可能出现未知值（前后版本不一致）
	const result = handleNoticeAction({ type: "unknown" } as never);
	expect(result).toBe(null);
	expect(useBrowserStore.getState().sessionId).toBe(before.browserSessionId);
	expect(useProjectsStore.getState().currentSessionId).toBe(
		before.currentSessionId,
	);
	expect(useSettingsStore.getState().showSettings).toBe(before.showSettings);
	expect(useSettingsStore.getState().activeSection).toBe(
		before.activeSection,
	);
});
