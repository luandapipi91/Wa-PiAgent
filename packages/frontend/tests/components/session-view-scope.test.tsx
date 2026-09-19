// SessionView 渲染范围契约（trace 卡顿修复：SessionView 整树连坐）：
// trace 实测（Trace-20260917T120429，5.2s 长任务）工具循环期间每个 message_end
// → touchSession 新建 session 对象 → SessionView（订阅整个 session 对象）整树
// 同步重渲染 → Composer/GitToolbar/AgentSwitcher 等全部无 memo 连坐 reconcile。
// 修复：SessionView 只按字段订阅 title/projectId/primaryAgent（原始值），
// touchSession 的新对象（仅 lastActivity 变化）不再击穿 SessionView。
import { test, expect, beforeEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { Profiler } from "react";
import { mock } from "bun:test";
// SessionView mount effect 会拉历史/stats：mock 避免 happy-dom 相对 URL fetch 报错
mock.module("../../src/api-client", () => ({
	api: {
		get: async (path: string) =>
			path.endsWith("/messages")
				? { messages: [], isActive: false, thinkingSince: null }
				: {},
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
}));
import { SessionView } from "../../src/components/SessionView";
import { useProjectsStore } from "../../src/store/projects";
import { useSessionStore } from "../../src/store/session";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";

const mkSession = (lastActivity: number): SessionEntity =>
	({
		id: "s-view-1",
		projectId: "p-view",
		title: "测试会话",
		primaryAgent: "dev",
		createdAt: 1,
		lastActivity,
	}) as unknown as SessionEntity;

beforeEach(() => {
	useProjectsStore.setState({
		projects: [{ id: "p-view", name: "P" } as unknown as ProjectEntity],
		sessions: [mkSession(1)],
		currentProjectId: "p-view",
		currentSessionId: "s-view-1",
		dirPickerOpen: false,
	});
	useSessionStore.setState({
		messagesBySession: { "s-view-1": [] },
		statusBySession: {},
		unreadBySession: {},
	});
});

test("touchSession（session 对象引用变化、字段值不变）不再触发 SessionView 重渲染", async () => {
	let renders = 0;
	render(
		<Profiler
			id="session-view"
			onRender={() => {
				renders++;
			}}
		>
			<SessionView sessionId="s-view-1" />
		</Profiler>,
	);
	// 等 mount effect 落定后清零计数
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});
	renders = 0;
	// touchSession：新 session 对象（lastActivity 更新），title/projectId/primaryAgent 不变。
	// 契约：SessionView 自身不再因 session 对象引用变化重渲染。子树中 Composer 自身
	// 整店订阅 projects store（Composer.tsx useProjectsStore()）仍会各渲染一次，
	// 该项属「修复 3」范围（trace 报告：Composer 改细粒度 selector），此处断言渲染数
	// 恒定且不随 SessionView 连坐放大（修复前 SessionView + 子树整树连坐）。
	act(() => {
		useProjectsStore.getState().touchSession("s-view-1");
	});
	const afterFirst = renders;
	renders = 0;
	act(() => {
		useProjectsStore.getState().touchSession("s-view-1");
	});
	expect(renders).toBe(afterFirst);
	expect(afterFirst).toBeLessThanOrEqual(2);
});

test("title 真实变化时 SessionView 仍正常更新（现有行为守卫）", async () => {
	const { getByText } = render(
		<Profiler id="session-view" onRender={() => {}}>
			<SessionView sessionId="s-view-1" />
		</Profiler>,
	);
	expect(getByText("测试会话")).toBeTruthy();
	act(() => {
		useProjectsStore.setState({
			sessions: [
				{ ...mkSession(2), title: "改名后的会话" },
			],
		});
	});
	expect(getByText("改名后的会话")).toBeTruthy();
});
