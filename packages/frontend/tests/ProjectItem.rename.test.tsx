// ProjectItem 项目重命名测试：验证右键菜单重命名功能 + PATCH API 调用
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
import { SYSTEM_PROJECT_ID, type SessionEntity } from "@wa-pi/shared";

// mock api-client：捕获 REST 调用
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
		patch: (path: string, body?: any) => {
			calls.push({ method: "patch", path, body });
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
	useProjectUiStore.setState({ collapsedProjectIds: [] });
});

afterEach(() => {
	cleanup();
});

test("普通项目右键菜单有'重命名项目'", () => {
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
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	expect(screen.getByTestId("menu-rename-project")).toBeTruthy();
});

test("系统项目右键菜单不显示'重命名项目'", () => {
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
	act(() => {
		fireEvent.contextMenu(
			screen.getByTestId(`project-name-${SYSTEM_PROJECT_ID}`),
		);
	});
	expect(screen.queryByTestId("menu-rename-project")).toBeNull();
});

test("点击重命名项目弹出 Modal 并预填项目名", () => {
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
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-rename-project"));
	});
	expect(screen.getByTestId("rename-dialog")).toBeTruthy();
	expect((screen.getByTestId("rename-input") as HTMLInputElement).value).toBe(
		"WaPi",
	);
});

const testSession: SessionEntity = {
	id: "s1",
	projectId: "p1",
	primaryAgent: "dev",
	title: "测试会话",
	createdAt: 0,
	lastActivity: Date.now(),
	piSessionFile: "",
};

test("确认重命名调用 PATCH /api/projects/:id", () => {
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
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-rename-project"));
	});
	act(() => {
		fireEvent.change(screen.getByTestId("rename-input"), {
			target: { value: "新项目名" },
		});
	});
	act(() => {
		fireEvent.click(screen.getByTestId("rename-ok"));
	});
	const patchCalls = calls.filter(
		(c) =>
			c.method === "patch" &&
			c.path === "/api/projects/p1" &&
			c.body?.name === "新项目名",
	);
	expect(patchCalls).toHaveLength(1);
});

test("右键项目后右键会话，项目菜单应消失（互斥）", () => {
	render(
		<ProjectItem
			project={normalProject}
			sessions={[testSession]}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 右键项目 → 项目菜单显示
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	expect(screen.getByTestId("menu-rename-project")).toBeTruthy();
	// 右键会话 → 项目菜单应消失
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("session-s1"));
	});
	expect(screen.queryByTestId("menu-rename-project")).toBeNull();
	expect(screen.getByTestId("menu-rename")).toBeTruthy();
});

test("重命名 Modal 点击遮罩不关闭（防误操作）", () => {
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
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
	});
	act(() => {
		fireEvent.click(screen.getByTestId("menu-rename-project"));
	});
	expect(screen.getByTestId("rename-dialog")).toBeTruthy();
	// 点击遮罩层 — 弹窗不关闭（防止误操作）
	act(() => {
		fireEvent.click(screen.getByTestId("modal-overlay"));
	});
	expect(screen.getByTestId("rename-dialog")).toBeTruthy();
});

test("右键不同项目时旧菜单消失（跨组件互斥）", () => {
	const projectA = { id: "pa", name: "项目A", cwd: "/a", createdAt: 0 };
	const projectB = { id: "pb", name: "项目B", cwd: "/b", createdAt: 0 };
	render(
		<>
			<ProjectItem
				project={projectA}
				sessions={[]}
				currentSessionId={null}
				selected={false}
				onSelectSession={() => {}}
				onNewSessionInProject={() => {}}
				onSelectProject={() => {}}
			/>
			<ProjectItem
				project={projectB}
				sessions={[]}
				currentSessionId={null}
				selected={false}
				onSelectSession={() => {}}
				onNewSessionInProject={() => {}}
				onSelectProject={() => {}}
			/>
		</>,
	);
	// 右键项目 A → 菜单显示
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-pa"));
	});
	expect(screen.getByTestId("menu-rename-project")).toBeTruthy();
	// 右键项目 B → 只剩一个菜单
	act(() => {
		fireEvent.contextMenu(screen.getByTestId("project-name-pb"));
	});
	expect(screen.getAllByTestId("menu-rename-project")).toHaveLength(1);
});
