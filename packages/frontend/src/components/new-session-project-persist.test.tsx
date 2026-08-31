// 新建会话项目选择持久性：用户在新建页下拉手动选择项目后，
// currentProjectId 变化（侧栏点击/导航）不得覆盖用户选择。
// 回归 bug：useEffect 无条件 setProjectId(currentProjectId)，用户选 HiAgent 却归旧项目。
import { test, expect, beforeEach, mock } from "bun:test";
import { act, render, screen, fireEvent } from "@testing-library/react";

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

import { NewSessionPane } from "./NewSessionPane";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";

const projects = [
	{ id: "proj-hlk", name: "hlk", cwd: "/Users/pipi/work/hlk", createdAt: 0 },
	{ id: "proj-hia", name: "HiAgent", cwd: "/Users/pipi/work/HiAgent", createdAt: 0 },
	{ id: "proj-other", name: "other", cwd: "/tmp/other", createdAt: 0 },
] as any;

function seed(currentProjectId: string) {
	useProjectsStore.setState({
		projects,
		sessions: [],
		currentProjectId,
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
	if (
		typeof window.addEventListener !== "function" &&
		(document as any).defaultView
	) {
		(globalThis as any).window = (document as any).defaultView;
	}
	seed("proj-hlk");
});

test("用户手动选择项目后，currentProjectId 变化不覆盖选择", async () => {
	render(<NewSessionPane />);
	const select = screen.getByTestId("project-select") as HTMLSelectElement;
	// 用户在新建页手动把项目从默认（hlk）改成 HiAgent
	fireEvent.change(select, { target: { value: "proj-hia" } });
	expect(select.value).toBe("proj-hia");
	// 侧栏/导航导致 currentProjectId 变化（切到 other）——不得覆盖用户选择
	await act(async () => {
		useProjectsStore.setState({ currentProjectId: "proj-other" } as any);
	});
	expect(select.value).toBe("proj-hia");
});

test("用户未手动选择时，currentProjectId 变化仍同步", async () => {
	render(<NewSessionPane />);
	const select = screen.getByTestId("project-select") as HTMLSelectElement;
	expect(select.value).toBe("proj-hlk");
	// 未手动选择：点项目旁 + 号等场景应跟随 currentProjectId
	await act(async () => {
		useProjectsStore.setState({ currentProjectId: "proj-other" } as any);
	});
	expect(select.value).toBe("proj-other");
});
