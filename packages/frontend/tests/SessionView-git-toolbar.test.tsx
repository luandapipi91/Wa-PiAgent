// SessionView 接入 GitToolbar 的集成测试：
// 普通项目会话 header 渲染 Git 工具栏；默认工作区（SYSTEM_PROJECT_ID）不渲染。
import "./mock-composer-db";
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { useGitStore } from "../src/store/git";
import { disconnectEvents } from "../src/events";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const apiCalls: string[] = [];

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push(path);
			if (path.endsWith("/git/status"))
				return Promise.resolve({
					isRepo: true,
					branch: "main",
					dirty: false,
					ahead: 0,
					behind: 0,
				});
			if (path.endsWith("/git/branches"))
				return Promise.resolve({ current: "main", branches: ["main"] });
			return Promise.resolve({ messages: [] });
		},
		post: () => Promise.resolve({}),
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

afterEach(() => cleanup());

function setSession(projectId: string) {
	useProjectsStore.setState({
		projects: [{ id: projectId, name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId,
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
		currentProjectId: projectId,
		currentSessionId: "s1",
	});
}

beforeEach(() => {
	disconnectEvents();
	apiCalls.length = 0;
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
	useGitStore.setState({ byProject: {} });
	useSessionStore.setState({
		messagesBySession: {},
		lastUsageBySession: {},
		tokenTotals: {},
		contextUsageBySession: {},
	});
	useComposerPrefsStore.setState({
		bySession: {},
		defaults: { model: null, thinking: "disabled" },
	});
	useProvidersStore.setState({ providers: [] });
});

async function renderSessionView() {
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<SessionView sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	await act(async () => {});
}

test("普通项目会话 header 渲染 Git 工具栏", async () => {
	setSession("p1");
	await renderSessionView();
	await waitFor(() => screen.getByTestId("git-toolbar"));
	// 工具栏位于 header 内
	const header = screen.getByTestId("session-view").querySelector("header");
	expect(header!.contains(screen.getByTestId("git-toolbar"))).toBe(true);
	// 仅分支 chip（无拉取按钮/项目 chip）
	expect(screen.queryByTestId("btn-git-pull")).toBeNull();
	expect(screen.queryByTestId("git-project-chip")).toBeNull();
	expect(screen.getByTestId("branch-chip").textContent).toContain("main");
});

test("默认工作区会话不渲染 Git 工具栏，也不请求 git API", async () => {
	setSession(SYSTEM_PROJECT_ID);
	await renderSessionView();
	await act(async () => {});
	expect(screen.queryByTestId("git-toolbar")).toBeNull();
	expect(apiCalls.some((p) => p.includes("/git/"))).toBe(false);
});
