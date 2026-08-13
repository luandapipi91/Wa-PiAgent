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
import type { SessionEntity } from "@wa-pi/shared";

// happy-dom 不支持 Web Animations API（element.animate），mock auto-animate 避免触发真实动画报错。
// 组件测试只验证重排逻辑，动画本身不是被测对象。
mock.module("@formkit/auto-animate/react", () => ({
	useAutoAnimate: () => [() => {}, (_enabled: boolean) => {}],
}));

const project = { id: "p1", name: "项目A", cwd: "/a", createdAt: 0 };

const mk = (
	id: string,
	title: string,
	lastActivity: number,
): SessionEntity => ({
	id,
	projectId: "p1",
	primaryAgent: "dev",
	title,
	createdAt: 0,
	lastActivity,
	piSessionFile: "",
});

const sessions = [
	mk("old", "旧会话", 1000),
	mk("mid", "中会话", 2000),
	mk("new", "新会话", 3000),
];

beforeEach(async () => {
	useProjectUiStore.setState({ collapsedProjectIds: [] });
	await act(async () => {
		await useProjectUiStore.persist.rehydrate();
	});
});

afterEach(() => {
	cleanup();
});

const rows = () => screen.getAllByText(/会话$/).map((el) => el.textContent);

test("初始渲染按 lastActivity 倒序", () => {
	render(
		<ProjectItem
			project={project}
			sessions={sessions}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	expect(rows()).toEqual(["新会话", "中会话", "旧会话"]);
});

test("lastActivity 变化但不点击项目名 → 保持稳定顺序", () => {
	const { rerender } = render(
		<ProjectItem
			project={project}
			sessions={sessions}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	expect(rows()).toEqual(["新会话", "中会话", "旧会话"]);

	// 模拟 selectSession 乐观更新：old 的 lastActivity 变为最新
	const updated = sessions.map((s) =>
		s.id === "old" ? { ...s, lastActivity: 5000 } : s,
	);
	rerender(
		<ProjectItem
			project={project}
			sessions={updated}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	// 不点击项目名：保持稳定顺序（old 虽最新但不重排）
	expect(rows()).toEqual(["新会话", "中会话", "旧会话"]);
});

test("点击项目名 → 按最新 lastActivity 重排", () => {
	const { rerender } = render(
		<ProjectItem
			project={project}
			sessions={sessions}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);

	// old 的 lastActivity 变为最新，但先不点击项目名
	const updated = sessions.map((s) =>
		s.id === "old" ? { ...s, lastActivity: 5000 } : s,
	);
	rerender(
		<ProjectItem
			project={project}
			sessions={updated}
			currentSessionId={null}
			selected={false}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
		/>,
	);
	expect(rows()).toEqual(["新会话", "中会话", "旧会话"]);

	// 点击项目名 → 触发重排
	fireEvent.click(screen.getByTestId("project-name-p1"));
	expect(rows()).toEqual(["旧会话", "新会话", "中会话"]);
});
