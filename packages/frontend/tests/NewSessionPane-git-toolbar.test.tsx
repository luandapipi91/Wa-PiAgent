// NewSessionPane 接入 GitToolbar 的集成测试：
// 新建会话页选中普通项目时渲染 Git 工具栏；选中默认工作区（SYSTEM_PROJECT_ID）时不渲染也不请求 git API。
import "./mock-composer-db";
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useGitStore } from "../src/store/git";
import { useRecordingStore } from "../src/store/recording";
import { useSkillsStore } from "../src/store/skills";
import { _setRecordingManager } from "../src/recording/recorder";
import { disconnectEvents } from "../src/events";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import type { AgentConfig } from "@wa-pi/shared";

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
			return Promise.resolve({});
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

afterEach(() => cleanup());

function setProjects(currentProjectId: string) {
	useProjectsStore.setState({
		projects: [
			{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 },
			{
				id: SYSTEM_PROJECT_ID,
				name: "默认工作区",
				cwd: "/sys",
				createdAt: 0,
			},
		],
		sessions: [],
		currentProjectId,
		currentSessionId: null,
	});
}

beforeEach(() => {
	disconnectEvents();
	apiCalls.length = 0;
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
	useGitStore.setState({ byProject: {} });
	useComposerPrefsStore.setState({
		bySession: {},
		defaults: { model: null, thinking: "disabled" },
		newSessionIds: {},
	});
	useAgentsStore.setState({ list: [agentCfg("dev")] });
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

async function renderPane() {
	render(<NewSessionPane />);
	await act(async () => {});
}

test("新建会话页选中普通项目时渲染 Git 工具栏", async () => {
	setProjects("p1");
	await renderPane();
	await waitFor(() => screen.getByTestId("git-toolbar"), {
		timeout: 3000,
	});
	// 工具栏位于新建会话面板内
	const pane = screen.getByTestId("new-session-pane");
	expect(pane.contains(screen.getByTestId("git-toolbar"))).toBe(true);
	expect(screen.queryByTestId("git-project-chip")).toBeNull();
	expect(screen.getByTestId("branch-chip").textContent).toContain("main");
	// 与会话页一致靠右放置（右上角浏览器预览/文件树按钮的左侧）
	const wrapper = screen.getByTestId("git-toolbar").parentElement!;
	expect(wrapper.className).toContain("right-");
	expect(wrapper.className).not.toContain("left-");
});

test("选中默认工作区时不渲染 Git 工具栏，也不请求 git API", async () => {
	setProjects(SYSTEM_PROJECT_ID);
	await renderPane();
	await act(async () => {});
	expect(screen.queryByTestId("git-toolbar")).toBeNull();
	expect(apiCalls.some((p) => p.includes("/git/"))).toBe(false);
});
