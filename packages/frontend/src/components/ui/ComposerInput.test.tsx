// ComposerInput 附件选文件原生能力测试：
// 1. Electron 下点击 📎 走系统文件选择对话框（waPiApp.showOpenFileDialog），不打开内置 FilePicker
// 2. 非 Electron 环境回退到内置 FilePicker
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

const getMock = mock();
const postMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { ComposerInput } from "./ComposerInput";
import { useProjectsStore } from "../../store/projects";
import { useProvidersStore } from "../../store/providers";
import { useSkillsStore } from "../../store/skills";
import { useAgentsStore } from "../../store/agents";
import { useCommandsStore } from "../../store/commands";
import { useSessionStore } from "../../store/session";
import { _setFsTransport } from "../../fs-client";

const showOpenFileDialog = mock(async () => [] as string[]);

// FilePicker 回退场景用：注入伪 fs 传输层，避免依赖真实 api-client
function mockFsTransport() {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/roots") return { roots: ["C:\\"] };
			if (path === "/api/fs/home") return { home: "C:\\Users\\co" };
			return {};
		},
		post: async () => ({}),
		del: async () => ({}),
	});
}

function seedStores() {
	useProjectsStore.setState({
		projects: [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }] as any,
		sessions: [],
		currentProjectId: "proj-1",
		currentSessionId: null,
	} as any);
	useProvidersStore.setState({ providers: [] } as any);
	useSkillsStore.setState({
		allSkills: [],
		skills: [],
		dirs: [],
		disabledSkills: [],
		builtinDir: "",
	} as any);
	useAgentsStore.setState({ list: [] } as any);
	useCommandsStore.setState({ commands: [], load: mock(() => {}) } as any);
	useSessionStore.setState({ openFilePreview: mock(() => {}) } as any);
}

function renderComposer() {
	return render(
		<ComposerInput
			text=""
			setText={() => {}}
			model={null}
			setModel={() => {}}
			thinking="high"
			setThinking={() => {}}
			attachments={[]}
			setAttachments={() => {}}
			projectId="proj-1"
			sessionId="s1"
			onSend={() => {}}
			isNewSession
			modelAutoSelectEnabled
		/>,
	);
}

beforeEach(() => {
	getMock.mockImplementation(async () => ({}));
	postMock.mockImplementation(async () => ({ path: "/uploads/x" }));
	showOpenFileDialog.mockClear();
	showOpenFileDialog.mockImplementation(async () => []);
	(window as any).waPiApp = { showOpenFileDialog };
	mockFsTransport();
	seedStores();
});

afterEach(() => {
	delete (window as any).waPiApp;
	_setFsTransport(null);
});

test("Electron 下点击附件按钮调用系统文件选择对话框", async () => {
	renderComposer();
	fireEvent.click(screen.getByTestId("composer-attach-btn"));
	await new Promise((r) => setTimeout(r, 0));

	expect(showOpenFileDialog).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("file-picker")).toBeNull();
});

test("非 Electron 环境点击附件按钮打开内置文件选择器", async () => {
	delete (window as any).waPiApp;
	renderComposer();
	fireEvent.click(screen.getByTestId("composer-attach-btn"));

	expect(await screen.findByTestId("file-picker")).toBeTruthy();
	expect(showOpenFileDialog).not.toHaveBeenCalled();
});

test("附件按钮渲染 SVG 图标而非 emoji", () => {
	renderComposer();
	const btn = screen.getByTestId("composer-attach-btn");
	expect(btn.querySelector("svg")).toBeTruthy();
	expect(btn.textContent).not.toContain("📎");
});
