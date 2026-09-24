// SkillSection 只读目录区测试：
// 1. 目录项展示路径 + 范围标签（[全局] / [项目名] / [插件包名]）
// 2. 点击目录项的「打开文件夹」按钮调用 shell 定位（waPiApp.showItemInFolder）
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "./SkillSection";
import { useSkillsStore } from "../../store/skills";

mock.module("../../api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

const showItemInFolder = mock(async () => true);

function seedStore() {
	useSkillsStore.setState({
		allSkills: [],
		skills: [],
		dirs: [
			{ path: "/builtin", type: "builtin" },
			{
				path: "/Users/co/work/Wa-Pi/.pi/skills",
				type: "project",
				projectId: "p1",
				projectName: "Wa-Pi",
			},
			{ path: "/ext/pack/skills", type: "extension", name: "superpowers-zh" },
		],
		disabledSkills: [],
		builtinDir: "/builtin",
		loading: false,
	});
}

beforeEach(() => {
	showItemInFolder.mockClear();
	(window as any).waPiApp = { showItemInFolder };
	seedStore();
});

afterEach(() => {
	delete (window as any).waPiApp;
});

test("目录项显示路径与范围标签", () => {
	render(<SkillSection />);
	expect(screen.getByText("/Users/co/work/Wa-Pi/.pi/skills")).toBeTruthy();
	expect(screen.getByText("/ext/pack/skills")).toBeTruthy();
	expect(screen.getByText("[全局]")).toBeTruthy();
	expect(screen.getByText("[Wa-Pi]")).toBeTruthy();
	expect(screen.getByText("[superpowers-zh]")).toBeTruthy();
});

test("点击目录项的「打开文件夹」在系统文件管理器定位该目录", () => {
	render(<SkillSection />);
	const btn = screen.getByTestId("skill-dir-open-/Users/co/work/Wa-Pi/.pi/skills");
	fireEvent.click(btn);
	expect(showItemInFolder).toHaveBeenCalledWith("/Users/co/work/Wa-Pi/.pi/skills");
});
