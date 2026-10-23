// SkillSection 只读目录区测试：
// 1. 目录区默认折叠，展开后目录项展示路径 + 范围标签（[全局] / [项目名] / [插件包名]）
// 2. 点击目录项的「打开文件夹」按钮调用 shell 定位（waPiApp.showItemInFolder）
// 3. 展开态只列「所选项目自己的目录 + 全局/插件目录」，其它项目目录不出现
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "./SkillSection";
import { useSkillsStore } from "../../store/skills";
import { useProjectsStore } from "../../store/projects";

mock.module("../../api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

const showItemInFolder = mock(async () => true);
const originalProjects = useProjectsStore.getState().projects;

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
		selectedProjectId: "p1",
	});
}

beforeEach(() => {
	showItemInFolder.mockClear();
	(window as any).waPiApp = { showItemInFolder };
	seedStore();
});

afterEach(() => {
	delete (window as any).waPiApp;
	useProjectsStore.setState({ projects: originalProjects });
});

test("展开后目录项显示路径与范围标签", () => {
	render(<SkillSection />);
	// 目录区默认折叠，先展开
	fireEvent.click(screen.getByTestId("skill-dir-toggle"));
	expect(screen.getByText("/Users/co/work/Wa-Pi/.pi/skills")).toBeTruthy();
	expect(screen.getByText("/ext/pack/skills")).toBeTruthy();
	expect(screen.getByText("[全局]")).toBeTruthy();
	expect(screen.getByText("[Wa-Pi]")).toBeTruthy();
	expect(screen.getByText("[superpowers-zh]")).toBeTruthy();
});

test("点击目录项的「打开文件夹」在系统文件管理器定位该目录", () => {
	render(<SkillSection />);
	fireEvent.click(screen.getByTestId("skill-dir-toggle"));
	const btn = screen.getByTestId("skill-dir-open-/Users/co/work/Wa-Pi/.pi/skills");
	fireEvent.click(btn);
	expect(showItemInFolder).toHaveBeenCalledWith("/Users/co/work/Wa-Pi/.pi/skills");
});

test("选中项目后列出该项目技能 + 全局/插件技能，他项目技能不出现", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "Wa-Pi", cwd: "/tmp/Wa-Pi", createdAt: 0 }],
	});
	useSkillsStore.setState({
		selectedProjectId: "p1",
		allSkills: [
			{ name: "g-skill", description: "", path: "/b/g", source: { type: "builtin" } },
			{
				name: "e-skill",
				description: "",
				path: "/x/e",
				source: { type: "extension", name: "pack" },
			},
			{
				name: "p-skill",
				description: "",
				path: "/p/p",
				source: { type: "project", projectId: "p1", projectName: "Wa-Pi" },
			},
			{
				name: "other-skill",
				description: "",
				path: "/o/o",
				source: { type: "project", projectId: "p2", projectName: "其它项目" },
			},
		],
	});
	render(<SkillSection />);
	expect(screen.getByTestId("skill-row-p-skill")).toBeTruthy();
	expect(screen.getByTestId("skill-row-g-skill")).toBeTruthy();
	expect(screen.getByTestId("skill-row-e-skill")).toBeTruthy();
	expect(screen.queryByTestId("skill-row-other-skill")).toBeNull();
});

test("范围选择器在技能目录行内且 DOM 顺序早于刷新按钮", () => {
	render(<SkillSection />);
	const header = screen.getByTestId("skill-dir-header");
	const scope = screen.getByTestId("skill-scope-select");
	const refresh = screen.getByTestId("skill-refresh-btn");
	expect(header.contains(scope)).toBe(true);
	expect(header.contains(refresh)).toBe(true);
	const order = Array.from(
		header.querySelectorAll(
			'[data-testid="skill-scope-select"],[data-testid="skill-refresh-btn"]',
		),
	).map((el) => el.getAttribute("data-testid"));
	expect(order).toEqual(["skill-scope-select", "skill-refresh-btn"]);
});
