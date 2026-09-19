// MemoryPage 徽标计数测试：
// 回归用例：tab 徽标应反映「当前作用域下的记录数」，而非后端返回的
// 全局+项目混合总数。后端 list() 在有活动项目时一次返回 global+project 全部条目，
// 列表按 memoryScope 过滤，徽标若直接用 memories.length 就会虚高（9 vs 4）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryPage } from "./MemoryPage";
import { useMemoryStore } from "../../store/memory";
import { useProjectsStore } from "../../store/projects";

// 锁定界面语言为中文，让 tab testid（tab-已保存 等）稳定可断言
process.env.WA_PI_LANG = "zh";

const getMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

// 新数据模型（SQLite）：id 为 uuid，条目自带 kind；sourceFile/rawIndex 已废弃
const makeEntry = (
	id: string,
	scope: "global" | "project",
	text: string,
	kind: "profile" | "knowledge" | "execution" = "knowledge",
) => ({
	id,
	text,
	scope,
	kind,
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-08-01T00:00:00.000Z",
});

// 模拟后端返回：全局 4 条 + 项目 5 条（与用户实测 9 vs 4 一致）
const globalMemories = [1, 2, 3, 4].map((i) =>
	makeEntry(
		`1f0a0000-0000-4000-8000-00000000000${i}`,
		"global",
		`全局记忆 ${i}`,
	),
);
const projectMemories = [1, 2, 3, 4, 5].map((i) =>
	makeEntry(
		`2f0a0000-0000-4000-8000-00000000000${i}`,
		"project",
		`项目记忆 ${i}`,
	),
);
// 层分布：全局 g1=画像、g2=执行，其余知识；项目 p1=执行，其余知识
const globalKindMemories = globalMemories.map((m, i) =>
	i === 0
		? { ...m, kind: "profile" as const }
		: i === 1
			? { ...m, kind: "execution" as const }
			: m,
);
const projectKindMemories = projectMemories.map((m, i) =>
	i === 0 ? { ...m, kind: "execution" as const } : m,
);

// 指令文件：全局 2 个 + 项目 1 个（同类计数问题的复现场景）
const makeInstruction = (scope: "global" | "project", path: string) => ({
	path,
	scope,
	content: `# ${path}`,
});

beforeEach(() => {
	getMock.mockReset();
	getMock.mockImplementation(async (url: string) => {
		if (url.includes("/config")) {
			return { config: { reviewEnabled: true, memoryPolicyStyle: "full" } };
		}
		if (url.includes("/instructions")) {
			return {
				instructions: [
					makeInstruction("global", "/g/AGENTS.md"),
					makeInstruction("global", "/g/CLAUDE.md"),
					makeInstruction("project", "/p/AGENTS.md"),
				],
			};
		}
		return {
			memories: [...globalKindMemories, ...projectKindMemories],
			archived: [],
		};
	});
	useProjectsStore.setState({
		currentProjectId: "proj-1",
		projects: [{ id: "proj-1", name: "测试项目", cwd: "/tmp/x", createdAt: 0 }],
	});
	useMemoryStore.setState({
		memoryScope: "global",
		activeTab: "saved",
		scopeFilter: "all",
		kindFilter: null,
		searchQuery: "",
	});
});

test("已保存 tab 徽标显示当前作用域（全局）下的记忆数 4，而非混合总数 9", async () => {
	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		// load() 已把后端 9 条写入 store
		expect(useMemoryStore.getState().memories.length).toBe(9);
	});

	const savedTab = screen.getByTestId("tab-已保存");
	expect(savedTab.textContent).toContain("4");
	expect(savedTab.textContent).not.toContain("9");

	// 列表与徽标同口径：全局作用域下实际渲染 4 张记忆卡片
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(4);
	});
});

test("切换到项目作用域后，徽标与列表同步变为 5（项目记忆数）", async () => {
	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		expect(useMemoryStore.getState().memories.length).toBe(9);
	});

	// 打开作用域下拉，选择项目 proj-1
	fireEvent.click(screen.getByTestId("memory-scope-select"));
	fireEvent.click(screen.getByTestId("memory-scope-option-project-proj-1"));

	const savedTab = screen.getByTestId("tab-已保存");
	await waitFor(() => {
		expect(savedTab.textContent).toContain("5");
	});
	expect(savedTab.textContent).not.toContain("4");
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(5);
	});
});

test("指令文件 tab 徽标随作用域筛选联动：筛选 global 时显示 2 而非 3", async () => {
	render(<MemoryPage />);
	await screen.findByTestId("memory-page");

	// 切到指令文件 tab（触发 loadInstructions）
	fireEvent.click(screen.getByTestId("tab-指令文件"));
	await waitFor(() => {
		expect(useMemoryStore.getState().instructions.length).toBe(3);
	});

	// 点击「全局」筛选 chip（注意：InstructionItem 的 scope 徽标也是「全局」文本，
	// 故用 role=button 精确定位 FilterChip）
	fireEvent.click(screen.getByRole("button", { name: "全局" }));

	const instructionsTab = screen.getByTestId("tab-指令文件");
	await waitFor(() => {
		expect(instructionsTab.textContent).toContain("2");
	});
	expect(instructionsTab.textContent).not.toContain("3");
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="instruction-item-"]').length,
		).toBe(2);
	});
});

// —— 层标签 / 层筛选（任务 14）：数据经真实 load() 路径进入面板 ——
test("记忆卡片带层标签：全局 4 条按 kind 渲染 画像/知识/执行", async () => {
	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		expect(useMemoryStore.getState().memories.length).toBe(9);
	});

	const badges = [
		...document.querySelectorAll('[data-testid="memory-kind-badge"]'),
	].map((el) => el.textContent);
	// 全局作用域渲染 4 张卡片，每张一个层标签
	expect(badges.length).toBe(4);
	expect(badges).toContain("画像");
	expect(badges).toContain("执行");
	expect(badges.filter((b) => b === "知识").length).toBe(2);
});

// —— 归档 tab 类型筛选回归：归档列表必须消费 kindFilter ——
test("归档 tab：类型筛选生效——点「画像」只剩画像条目", async () => {
	// 归档数据：画像 / 执行 / 知识 各一条（全 global，避免作用域干扰断言）
	getMock.mockImplementation(async (url: string) => {
		if (url.includes("/config")) {
			return { config: { reviewEnabled: true, memoryPolicyStyle: "full" } };
		}
		if (url.includes("/instructions")) {
			return { instructions: [] };
		}
		return {
			memories: [],
			archived: [
				{
					...makeEntry(
						"a0000000-0000-4000-8000-000000000001",
						"global",
						"归档画像",
						"profile",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
				{
					...makeEntry(
						"a0000000-0000-4000-8000-000000000002",
						"global",
						"归档执行",
						"execution",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
				{
					...makeEntry(
						"a0000000-0000-4000-8000-000000000003",
						"global",
						"归档知识",
						"knowledge",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
			],
		};
	});

	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		expect(useMemoryStore.getState().archived.length).toBe(3);
	});

	// 切到归档 tab
	fireEvent.click(screen.getByTestId("tab-归档"));

	// 初始：3 张归档卡片
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(3);
	});

	// 点「画像」筛选 chip
	fireEvent.click(screen.getByRole("button", { name: "画像" }));

	// 修复前：列表纹丝不动（仍 3 张）；修复后：只剩 1 张画像卡片
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(1);
	});
	expect(screen.getByText("归档画像")).toBeTruthy();
	expect(screen.queryByText("归档执行")).toBeNull();
	expect(screen.queryByText("归档知识")).toBeNull();

	// 取消筛选后恢复 3 张
	fireEvent.click(screen.getByRole("button", { name: "画像" }));
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(3);
	});
});

test("归档 tab：列表与徽标按作用域过滤——全局作用域下不含项目归档", async () => {
	getMock.mockImplementation(async (url: string) => {
		if (url.includes("/config")) {
			return { config: { reviewEnabled: true, memoryPolicyStyle: "full" } };
		}
		if (url.includes("/instructions")) {
			return { instructions: [] };
		}
		return {
			memories: [],
			archived: [
				{
					...makeEntry(
						"b0000000-0000-4000-8000-000000000001",
						"global",
						"全局归档一",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
				{
					...makeEntry(
						"b0000000-0000-4000-8000-000000000002",
						"global",
						"全局归档二",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
				{
					...makeEntry(
						"b0000000-0000-4000-8000-000000000003",
						"project",
						"项目归档一",
					),
					archivedAt: "2026-09-01T00:00:00.000Z",
				},
			],
		};
	});

	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		expect(useMemoryStore.getState().archived.length).toBe(3);
	});

	// 切到归档 tab
	fireEvent.click(screen.getByTestId("tab-归档"));

	// 全局作用域：只渲染 2 张全局归档卡片（修复前：混入项目归档，3 张）
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(2);
	});
	expect(screen.getByText("全局归档一")).toBeTruthy();
	expect(screen.getByText("全局归档二")).toBeTruthy();
	expect(screen.queryByText("项目归档一")).toBeNull();

	// 徽标口径与列表一致：显示 2 而非全量 3
	const archivedTab = screen.getByTestId("tab-归档");
	expect(archivedTab.textContent).toContain("2");
	expect(archivedTab.textContent).not.toContain("3");

	// 切到项目作用域后：列表与徽标变为 1
	fireEvent.click(screen.getByTestId("memory-scope-select"));
	fireEvent.click(screen.getByTestId("memory-scope-option-project-proj-1"));
	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(1);
	});
	expect(screen.getByText("项目归档一")).toBeTruthy();
	expect(screen.getByTestId("tab-归档").textContent).toContain("1");
});

test("层筛选：全局作用域下点「执行」只剩执行层，徽标仍按作用域计数", async () => {
	render(<MemoryPage />);
	await screen.findByTestId("memory-page");
	await waitFor(() => {
		expect(useMemoryStore.getState().memories.length).toBe(9);
	});

	// 全局 g2 被造为 execution 层
	fireEvent.click(screen.getByRole("button", { name: "执行" }));

	await waitFor(() => {
		expect(
			document.querySelectorAll('[data-testid^="memory-card-"]').length,
		).toBe(1);
	});
	expect(screen.getByText("全局记忆 2")).toBeTruthy();
	expect(screen.queryByText("全局记忆 1")).toBeNull();
	expect(screen.queryByText("项目记忆 1")).toBeNull();

	// tab 徽标口径不变：仍显示当前作用域（全局）下的 4 条
	expect(screen.getByTestId("tab-已保存").textContent).toContain("4");
});
