import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RecentSessionsList } from "../src/components/RecentSessionsList";
import { useProjectsStore } from "../src/store/projects";

afterEach(() => cleanup());

beforeEach(() => {
	useProjectsStore.setState({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "", createdAt: 0 },
			{ id: "p1", name: "HiAgent", cwd: "/a", createdAt: 0 },
		],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "a",
				title: "侧边栏重构",
				createdAt: 0,
				lastActivity: Date.now() - 5000,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "__system__",
				primaryAgent: "a",
				title: "登录优化",
				createdAt: 0,
				lastActivity: Date.now() - 90000000,
				piSessionFile: "",
			},
		],
		currentSessionId: "s1",
		currentProjectId: "p1",
	} as any);
});

const renderList = (
	overrides: Partial<Parameters<typeof RecentSessionsList>[0]> = {},
) =>
	render(
		<RecentSessionsList
			onSelectSession={() => {}}
			onNewSession={() => {}}
			{...overrides}
		/>,
	);

test("渲染按天刻度分组 + 项目名标注 + 当前会话高亮选中", () => {
	renderList();
	// 日期刻度
	expect(screen.getByText("今天")).toBeTruthy();
	// 「昨天」可能同时出现在 dayLabel 刻度与 SessionRow 右侧相对时间位（formatRelativeTime 对 24-48h 前返回「昨天」），用 getAllByText 消除歧义
	expect(screen.getAllByText("昨天").length).toBeGreaterThan(0);
	// 会话标题
	expect(screen.getByText("侧边栏重构")).toBeTruthy();
	expect(screen.getByText("登录优化")).toBeTruthy();
	// 项目名标注
	expect(screen.getByText("HiAgent")).toBeTruthy();
	expect(screen.getByText("默认工作区")).toBeTruthy();
	// 当前会话选中（SessionRow 选中态左条）
	const row = screen.getByTestId("session-s1") as HTMLButtonElement;
	expect(row.style.borderLeft).toContain("var(--accent)");
});

test("点击会话行调用 onSelectSession 且传会话 id", () => {
	let selectedId = "";
	const onSelect = (id: string) => {
		selectedId = id;
	};
	renderList({ onSelectSession: onSelect });
	fireEvent.click(screen.getByTestId("session-s2"));
	expect(selectedId).toBe("s2");
});

test("今天刻度始终显示：无会话时也渲染今天刻度与＋新建会话入口", () => {
	useProjectsStore.setState({ sessions: [] } as any);
	renderList();
	expect(screen.getByText("今天")).toBeTruthy();
	expect(screen.getByTestId("recent-new-session")).toBeTruthy();
	expect(screen.getByTestId("recent-sessions-empty")).toBeTruthy();
});

test("点击＋新建会话入口触发 onNewSession", () => {
	const fn = mock();
	renderList({ onNewSession: fn });
	fireEvent.click(screen.getByTestId("recent-new-session"));
	expect(fn).toHaveBeenCalledTimes(1);
});
