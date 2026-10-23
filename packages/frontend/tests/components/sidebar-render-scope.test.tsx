// 侧边栏渲染范围契约（trace 卡顿修复 ①②）：
// trace 实测（Trace-20260917T113215）一次 store 更新把整个应用树同步重渲染：
// SessionRow 33% + ProjectItem 16% 主线程热点，300ms 长任务期间点击无响应。
// 修复：①ProjectList 按字段 selector 订阅（无关字段 set 不再触发重渲染）；
// ②SessionRow/ProjectItem memo 化（父级重渲染时 props 不变的行整块跳过）。
import { test, expect, beforeEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { Profiler } from "react";
import { SessionRow } from "../../src/components/SessionRow";
import { ProjectItem } from "../../src/components/ProjectItem";
import { ProjectList } from "../../src/components/ProjectList";
import { useProjectsStore } from "../../src/store/projects";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";

const project = { id: "p1", name: "项目P1" } as unknown as ProjectEntity;
const session = {
	id: "s1",
	projectId: "p1",
	title: "会话S1",
	createdAt: 1,
	lastActivity: 1,
} as unknown as SessionEntity;

const listProps = {
	onSelectSession: () => {},
	onNewSessionInProject: () => {},
	onSelectProject: () => {},
	onNewProject: () => {},
};

beforeEach(() => {
	useProjectsStore.setState({
		projects: [project],
		sessions: [session],
		currentProjectId: null,
		currentSessionId: null,
		dirPickerOpen: false,
	});
});

test("SessionRow 是 memo 组件", () => {
	expect((SessionRow as any).$$typeof).toBe(Symbol.for("react.memo"));
});

test("ProjectItem 是 memo 组件", () => {
	expect((ProjectItem as any).$$typeof).toBe(Symbol.for("react.memo"));
});

test("ProjectList：无关字段（dirPickerOpen）变化不触发重渲染", () => {
	let renders = 0;
	render(
		<Profiler
			id="project-list"
			onRender={() => {
				renders++;
			}}
		>
			<ProjectList {...listProps} />
		</Profiler>,
	);
	// 挂载渲染不计入
	renders = 0;
	// store 无关字段 set：修复前整店订阅 → 重渲染（renders=1）；修复后 → 0
	act(() => {
		useProjectsStore.setState({ dirPickerOpen: true });
	});
	expect(renders).toBe(0);
});

test("ProjectList：订阅的 sessions 引用变化仍正常更新（现有行为守卫）", () => {
	let renders = 0;
	const { getByText } = render(
		<Profiler
			id="project-list"
			onRender={() => {
				renders++;
			}}
		>
			<ProjectList {...listProps} />
		</Profiler>,
	);
	expect(getByText("会话S1")).toBeTruthy();
	renders = 0;
	const renamed = { ...session, title: "改名S1" };
	act(() => {
		useProjectsStore.setState({ sessions: [renamed] });
	});
	expect(getByText("改名S1")).toBeTruthy();
	expect(renders).toBeGreaterThan(0);
});
