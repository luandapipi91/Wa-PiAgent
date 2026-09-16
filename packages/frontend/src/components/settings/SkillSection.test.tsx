// SkillSection 原生能力测试：
// 1. Electron 下「添加技能目录」走系统目录选择对话框，而非内置 DirTreePicker
// 2. 非 Electron 环境回退到内置 DirTreePicker
// 3. 每个目录项的「打开技能文件夹」按钮调用 shell 定位（waPiApp.showItemInFolder）
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "./SkillSection";
import { useSkillsStore } from "../../store/skills";
import { _setFsTransport } from "../../fs-client";

const getMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

// DirTreePicker 回退场景用：注入伪 fs 传输层，避免依赖真实 api-client
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

const addDirMock = mock((_p: string) => {});
const showOpenDirectoryDialog = mock(async () => "/home/co/skills");
const showItemInFolder = mock(async () => true);

function seedStore() {
	useSkillsStore.setState({
		allSkills: [],
		skills: [],
		dirs: ["/builtin", "/user"],
		disabledSkills: [],
		builtinDir: "/builtin",
		loading: false,
		addDir: addDirMock as any,
	});
}

beforeEach(() => {
	getMock.mockImplementation(async () => ({}));
	addDirMock.mockClear();
	showOpenDirectoryDialog.mockClear();
	showItemInFolder.mockClear();
	(window as any).waPiApp = {
		showOpenDirectoryDialog,
		showItemInFolder,
	};
	mockFsTransport();
	seedStore();
});

afterEach(() => {
	delete (window as any).waPiApp;
	_setFsTransport(null);
});

test("Electron 下点击「添加技能目录」调用系统目录选择对话框", async () => {
	render(<SkillSection />);
	fireEvent.click(screen.getByTestId("skill-add-dir-btn"));
	await new Promise((r) => setTimeout(r, 0));

	expect(showOpenDirectoryDialog).toHaveBeenCalledTimes(1);
	expect(addDirMock).toHaveBeenCalledWith("/home/co/skills");
	// 不打开内置 DirTreePicker
	expect(screen.queryByTestId("dir-pick")).toBeNull();
});

test("非 Electron 环境点击「添加技能目录」回退到内置目录选择器", async () => {
	delete (window as any).waPiApp;
	render(<SkillSection />);
	fireEvent.click(screen.getByTestId("skill-add-dir-btn"));

	expect(await screen.findByTestId("dir-pick")).toBeTruthy();
	expect(showOpenDirectoryDialog).not.toHaveBeenCalled();
});

test("点击目录项的「打开技能文件夹」在系统文件管理器定位该目录", async () => {
	render(<SkillSection />);
	const btn = await screen.findByTestId("skill-dir-open-/user");
	fireEvent.click(btn);
	expect(showItemInFolder).toHaveBeenCalledWith("/user");
});
