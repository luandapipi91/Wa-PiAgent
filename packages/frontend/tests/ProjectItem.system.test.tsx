import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	cleanup,
	act,
} from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { SYSTEM_PROJECT_ID, type SessionEntity } from "@wa-pi/shared";

// mock api-client：捕获 REST 调用，必要时断言请求被正确发出。
// bun 的 mock.module 在 import 解析时注册 mock，factory 闭包可引用本模块作用域的 calls。
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
		put: (path: string, body?: any) => {
			calls.push({ method: "put", path, body });
			return Promise.resolve({});
		},
		del: (path: string) => {
			calls.push({ method: "del", path });
			return Promise.resolve({});
		},
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

const systemProject = {
	id: SYSTEM_PROJECT_ID,
	name: "默认工作区",
	cwd: "/tmp/workdir",
	createdAt: 0,
};
const normalProject = { id: "p1", name: "WaPi", cwd: "/work", createdAt: 0 };

beforeEach(() => {
	calls.length = 0;
	// 默认 expanded（空 collapsedProjectIds 表示全部展开）
	useProjectUiStore.setState({ collapsedProjectIds: [] });
});

// 每个测试后清理 DOM，避免残留元素（特别是 createPortal 到 body 的右键菜单）干扰后续测试
afterEach(() => {
	cleanup();
});

test("项目图标基础尺寸 18px 且随 --font-scale 缩放", () => {
	render(
		<ProjectItem
			project={systemProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	const toggle = screen.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`);
	const icon = toggle.querySelector(
		'[data-testid="project-icon-home"]',
	) as SVGElement | null;
	expect(icon).toBeTruthy();
	// 尺寸用 em：相对父元素字体（基础 18px × var(--font-scale)），字体缩放时图标同步缩放
	expect(icon!.getAttribute("width")).toBe("1em");
	expect(icon!.getAttribute("height")).toBe("1em");
	expect(toggle.className).toContain("text-[calc(18px*var(--font-scale))]");
});

test("系统项目始终显示 🏠（不论展开/折叠）", () => {
	// 折叠状态
	useProjectUiStore.setState({ collapsedProjectIds: [SYSTEM_PROJECT_ID] });
	const { rerender } = render(
		<ProjectItem
			project={systemProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 图标已由 emoji 改为 Icon(home)；按 testId 断言图标类型，不受 svg 无 textContent 影响
	expect(
		screen
			.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`)
			.querySelector('[data-testid="project-icon-home"]'),
	).toBeTruthy();

	// 展开状态（清空 collapsedProjectIds）
	act(() => {
		useProjectUiStore.setState({ collapsedProjectIds: [] });
	});
	rerender(
		<ProjectItem
			project={systemProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 展开后图标仍是 home（不能变成 folder-open，否则失去默认工作区辨识度）
	expect(
		screen
			.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`)
			.querySelector('[data-testid="project-icon-home"]'),
	).toBeTruthy();
	expect(screen.queryByTestId("project-icon-folder-open")).toBeNull();
});

test("系统项目右键菜单不显示'删除项目'", () => {
	render(
		<ProjectItem
			project={systemProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 右键项目名（header 内的 button，handler 挂在 header div 上，事件会冒泡触发）
	act(() => {
		fireEvent.contextMenu(
			screen.getByTestId(`project-name-${SYSTEM_PROJECT_ID}`),
		);
	});
	expect(screen.queryByTestId("menu-delete-project")).toBeNull();
	// "查看文件夹" 仍然显示
	expect(screen.getByTestId("menu-open-dir")).toBeTruthy();
});

test("系统项目下会话右键菜单有'打开工作目录'项", () => {
	const session: SessionEntity = {
		id: "s1",
		projectId: SYSTEM_PROJECT_ID,
		primaryAgent: "dev",
		title: "会话",
		createdAt: 1721000000000,
		lastActivity: Date.now(),
		piSessionFile: "",
	};
	render(
		<ProjectItem
			project={systemProject}
			sessions={[session]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	act(() => {
		fireEvent.contextMenu(screen.getByText("会话"));
	});
	expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
	// 点击"打开工作目录"应调用 POST /api/projects/{projectId}/open-dir，携带 sessionId
	act(() => {
		fireEvent.click(screen.getByTestId("menu-open-session-dir"));
	});
	const openDirCalls = calls.filter(
		(c) =>
			c.method === "post" &&
			c.path ===
				`/api/projects/${encodeURIComponent(SYSTEM_PROJECT_ID)}/open-dir`,
	);
	expect(openDirCalls).toHaveLength(1);
	expect(openDirCalls[0].body).toEqual({ sessionId: "s1" });
});

test("普通项目折叠时图标用 📁（行为不变）", () => {
	useProjectUiStore.setState({ collapsedProjectIds: ["p1"] });
	render(
		<ProjectItem
			project={normalProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 图标已由 emoji 📁 改为 Icon(folder)；按 testId 断言
	expect(
		screen
			.getByTestId("project-toggle-p1")
			.querySelector('[data-testid="project-icon-folder"]'),
	).toBeTruthy();
});

test("普通项目右键菜单有'删除项目'（行为不变）", () => {
	render(
		<ProjectItem
			project={normalProject}
			sessions={[]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 右键项目名（header 内的 button，handler 挂在 header div 上，事件会冒泡触发）
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	expect(screen.getByTestId("menu-delete-project")).toBeTruthy();
});

test("普通项目下会话右键菜单无'打开工作目录'（行为不变）", () => {
	const session: SessionEntity = {
		id: "s1",
		projectId: "p1",
		primaryAgent: "dev",
		title: "会话",
		createdAt: 0,
		lastActivity: Date.now(),
		piSessionFile: "",
	};
	render(
		<ProjectItem
			project={normalProject}
			sessions={[session]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	act(() => {
		fireEvent.contextMenu(screen.getByText("会话"));
	});
	expect(screen.queryByTestId("menu-open-session-dir")).toBeNull();
});

test("删除会话时调用 removeSessionPrefs 清理草稿", () => {
	useComposerPrefsStore.setState({
		bySession: {
			"s-del": {
				model: "m",
				thinking: "disabled",
				attachments: [],
				text: "草稿",
			},
		},
		loadedBySession: { "s-del": true },
	});
	const session: SessionEntity = {
		id: "s-del",
		projectId: "p1",
		primaryAgent: "dev",
		title: "会话",
		createdAt: 0,
		lastActivity: 0,
		piSessionFile: "",
	};

	render(
		<ProjectItem
			project={normalProject}
			sessions={[session]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);

	// 右键打开会话菜单 → 删除聊天 → 确认
	fireEvent.contextMenu(screen.getByTestId(`session-s-del`));
	fireEvent.click(screen.getByTestId("menu-delete"));
	fireEvent.click(screen.getByTestId("confirm-ok"));

	// 删除请求已发出
	expect(
		calls.some((c) => c.method === "del" && c.path.includes("/sessions/s-del")),
	).toBe(true);
	// composer 草稿已从 store 清理
	expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeUndefined();
});
