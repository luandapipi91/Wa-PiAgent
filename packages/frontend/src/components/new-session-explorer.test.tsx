// 新建会话页「文件浏览侧栏」组件测试（第二层）：
// 覆盖侧栏默认收起 / 右上角开关展开收起 / workspaceDir 跟随项目 cwd / 无项目禁用入口。
// 回归目标：新建页加右侧文件树后，不得破坏居中主列的极简布局，且入口开关与会话页 btn-explorer 行为一致。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

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
	getDefaults: async () => ({ model: "test-p/m1", thinking: "high" }),
	setDefaults: async () => {},
	getRecordingPrefs: async () => undefined,
	setRecordingPrefs: async () => {},
	getNewSessionIds: async () => ({}),
	setNewSessionIds: async () => {},
}));
// mock ExplorerPanel：仅渲染 workspaceDir，用于断言 cwd 传递是否正确（文件树本身另有 ExplorerPanel.test.tsx 覆盖）
mock.module("./ExplorerPanel", () => ({
	ExplorerPanel: ({ workspaceDir }: { workspaceDir: string }) => (
		<div data-testid="mock-explorer">{workspaceDir}</div>
	),
}));

import { NewSessionPane } from "./NewSessionPane";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useNewSessionExplorerStore } from "../store/new-session-explorer";

function setupProjects(
	projects: any[] = [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }],
) {
	useProjectsStore.setState({
		projects,
		sessions: [],
		currentProjectId: projects[0]?.id ?? null,
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
		newSessionIds: {},
		defaults: { model: "test-p/m1", thinking: "high" },
		bySession: {},
		loadedBySession: {},
	} as any);
}

beforeEach(() => {
	useNewSessionExplorerStore.setState({ open: false });
	setupProjects();
});

test("默认收起：不渲染文件树侧栏", () => {
	render(<NewSessionPane />);
	expect(screen.queryByTestId("new-session-explorer-aside")).toBeNull();
});

test("点右上角开关展开侧栏，再点折叠按钮收起", () => {
	render(<NewSessionPane />);
	const btn = screen.getByTestId("btn-new-session-explorer");
	fireEvent.click(btn);
	expect(screen.getByTestId("new-session-explorer-aside")).toBeTruthy();
	// 面板标题栏的 › 折叠按钮（title=收起面板）收起
	fireEvent.click(screen.getByTitle("收起面板"));
	expect(screen.queryByTestId("new-session-explorer-aside")).toBeNull();
});

test("展开后 workspaceDir 取当前项目 cwd", () => {
	render(<NewSessionPane />);
	fireEvent.click(screen.getByTestId("btn-new-session-explorer"));
	expect(screen.getByTestId("mock-explorer").textContent).toBe("/p1");
});

test("无项目时开关禁用，无法展开", () => {
	setupProjects([]);
	render(<NewSessionPane />);
	const btn = screen.getByTestId("btn-new-session-explorer");
	expect((btn as HTMLButtonElement).disabled).toBe(true);
});

test("默认工作区项目：展开侧栏显示空态而非列出 workdir 父目录", () => {
	// 默认工作区的 cwd 是 workdir 父目录（存放海量内部会话目录），
	// 一次性列出会卡死 UI —— 修复后走空态，不渲染文件树。
	setupProjects([
		{ id: "__system__", name: "默认工作区", cwd: "/workdir", createdAt: 0 },
	]);
	render(<NewSessionPane />);
	fireEvent.click(screen.getByTestId("btn-new-session-explorer"));
	expect(screen.getByTestId("new-session-explorer-aside")).toBeTruthy();
	expect(screen.queryByTestId("mock-explorer")).toBeNull();
	expect(screen.getByText("未设置工作目录")).toBeTruthy();
});
