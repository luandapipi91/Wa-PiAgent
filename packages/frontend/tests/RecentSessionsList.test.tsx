import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	act,
} from "@testing-library/react";
import { RecentSessionsList } from "../src/components/RecentSessionsList";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

// mock api-client：捕获 REST 调用（重命名/删除/打开目录会走 api）
const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			calls.push({ method: "get", path });
			return Promise.resolve({});
		},
		post: (path: string, body?: any) => {
			calls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		del: (path: string) => {
			calls.push({ method: "del", path });
			return Promise.resolve({});
		},
	},
	ApiError: class extends Error {},
}));

afterEach(() => cleanup());

beforeEach(() => {
	calls.length = 0;
	useProjectsStore.setState({
		projects: [
			{ id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "", createdAt: 0 },
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
				projectId: SYSTEM_PROJECT_ID,
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

test("右键会话行弹出菜单（重命名/删除）", () => {
	renderList();
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	expect(screen.getByTestId("session-context-menu")).toBeTruthy();
	expect(screen.getByTestId("menu-rename")).toBeTruthy();
	expect(screen.getByTestId("menu-delete")).toBeTruthy();
});

test("所有会话右键菜单都含「打开目录」", () => {
	renderList();
	// 非系统项目会话 s1（projectId=p1）
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
	// 关闭菜单
	act(() => {
		fireEvent.keyDown(document, { key: "Escape" });
	});
	// 系统项目会话 s2（projectId=__system__）
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s2"));
	});
	expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
});

test("点击「打开目录」调用 open-dir api 并携带 sessionId", () => {
	renderList();
	// 非系统项目会话 s1 → 打开 p1 项目目录
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-open-session-dir"));
	});
	const call1 = calls.find(
		(c) =>
			c.method === "post" &&
			c.path === `/api/projects/${encodeURIComponent("p1")}/open-dir`,
	);
	expect(call1).toBeTruthy();
	expect(call1?.body).toEqual({ sessionId: "s1" });
	// 系统项目会话 s2 → 打开默认工作区目录
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s2"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-open-session-dir"));
	});
	const call2 = calls.find(
		(c) =>
			c.method === "post" &&
			c.path ===
				`/api/projects/${encodeURIComponent(SYSTEM_PROJECT_ID)}/open-dir`,
	);
	expect(call2).toBeTruthy();
	expect(call2?.body).toEqual({ sessionId: "s2" });
});

test("右键重命名：弹窗确认后调用 rename api", () => {
	renderList();
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-rename"));
	});
	expect(screen.getByTestId("rename-dialog")).toBeTruthy();
	fireEvent.change(screen.getByTestId("rename-input"), {
		target: { value: "新名字" },
	});
	act(() => {
		fireEvent.click(screen.getByTestId("rename-ok"));
	});
	const call = calls.find(
		(c) =>
			c.method === "post" &&
			c.path === `/api/sessions/${encodeURIComponent("s1")}/rename`,
	);
	expect(call).toBeTruthy();
	expect(call?.body).toEqual({ title: "新名字" });
});

test("右键删除：确认后调用 del api 并清理草稿", () => {
	useComposerPrefsStore.setState({
		bySession: {
			s1: { model: "m", thinking: "disabled", attachments: [], text: "草稿" },
		},
		loadedBySession: { s1: true },
	} as any);
	renderList();
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-delete"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("confirm-ok"));
	});
	expect(
		calls.some((c) => c.method === "del" && c.path.includes("/sessions/s1")),
	).toBe(true);
	// composer 草稿已从 store 清理
	expect(useComposerPrefsStore.getState().bySession["s1"]).toBeUndefined();
});
