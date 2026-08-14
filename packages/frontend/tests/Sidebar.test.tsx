import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { Sidebar, type SidebarTab } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";
import { useChannelsStore } from "../src/store/channels";

const noop = () => {};

/**
 * 有状态包装器：Sidebar 的 tab 现为受控组件（App.tsx 管理），
 * 测试中用 useState 模拟 App 级行为，点击页签可真实切换。
 */
function StatefulSidebar(
	props: Omit<Parameters<typeof Sidebar>[0], "tab" | "onTabChange">,
) {
	const [tab, setTab] = useState<SidebarTab>("tasks");
	return <Sidebar {...props} tab={tab} onTabChange={setTab} />;
}

const renderSidebar = (
	overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
) =>
	render(
		<StatefulSidebar
			onNewSession={noop}
			onMore={noop}
			onSelectSession={noop}
			onNewSessionInProject={noop}
			onSelectProject={noop}
			onNewProject={noop}
			{...overrides}
		/>,
	);

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
	useProjectsStore.setState({
		projects: [],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
});

test("渲染侧边栏基础结构", () => {
	render(
		<StatefulSidebar
			onNewSession={() => {}}
			onMore={() => {}}
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);
	expect(screen.getByTestId("sidebar")).toBeTruthy();
	// 分组标题"智能体"
	expect(screen.getByText("智能体")).toBeTruthy();
	// "项目"区头（含「+」图标按钮）仅在存在用户项目时渲染（ProjectList 的 userProjects.length>0 条件）；
	// 区头「+」按钮与空态「新建项目」按钮共用 new-project-btn testid，二者互斥。
	// 此处 projects 为空 → 渲染空态按钮而非区头，故断言空态按钮出现：
	expect(screen.getByText(/＋ 新建项目/)).toBeTruthy();
});

test("智能体折叠项位于任务/IM 页签之上", () => {
	renderSidebar();
	const agent = screen.getByTestId("agent-collapsed");
	const tabTasks = screen.getByTestId("sidebar-tab-tasks");
	const tabIm = screen.getByTestId("sidebar-tab-im");
	const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
	// 智能体折叠项应在两个页签之前（DOM 顺序更靠上）
	expect(agent.compareDocumentPosition(tabTasks) & FOLLOWING).toBeTruthy();
	expect(agent.compareDocumentPosition(tabIm) & FOLLOWING).toBeTruthy();
});

test("项目/最近分段控件使用虚线样式，选中态为文字粗体无底色，中间有竖线分割", () => {
	renderSidebar();
	const scope = screen.getByTestId("session-scope");
	expect(scope.style.border).toContain("dashed");
	// 默认选中「项目」：文字粗体、无底色
	const projectBtn = screen.getByTestId("session-scope-project");
	expect(projectBtn.style.fontWeight).toBe("bold");
	expect(projectBtn.style.background).toBe("");
	// 项目与最近之间有竖线分割
	const divider = screen.getByTestId("session-scope-divider");
	expect(divider.style.borderLeftStyle).toBe("dashed");
});

test("最近视图的＋新建会话入口透传 onNewSession", () => {
	const fn = mock();
	renderSidebar({ onNewSession: fn });
	// 切到最近视图
	fireEvent.click(screen.getByTestId("session-scope-recent"));
	// 点击＋新建会话入口
	fireEvent.click(screen.getByTestId("recent-new-session"));
	expect(fn).toHaveBeenCalledTimes(1);
});

// 默认工作区渲染位置 + 去重测试已迁移到 ProjectList.test.tsx
// （默认工作区现在由 ProjectList 渲染，而非 Sidebar 直接渲染）

test("任务/IM 页签切换：IM 显示渠道会话列表并可点开会话，切回任务恢复", () => {
	// 防止 ImConversationList mount 时走真实 api：替换 store 的加载方法并注入会话数据
	useChannelsStore.setState({
		loadConversations: async () => {},
		conversations: [
			{
				channelId: "ch_1",
				channelName: "客服机器人",
				channelType: "wecom",
				chatId: "u-1001",
				chatType: "single",
				sessionId: "sess-im-1",
				projectId: "__system__",
				projectName: "默认工作区",
				lastMessagePreview: "你好",
				updatedAt: Date.now(),
			} as any,
		],
	});
	const onSelectSession = mock();
	renderSidebar({ onSelectSession });

	// 默认任务页：项目/最近分段在，IM 列表不在
	expect(screen.getByTestId("session-scope-project")).toBeTruthy();
	expect(screen.queryByTestId("im-conv-list")).toBeNull();

	// 切到 IM 页签：出现渠道会话列表（渠道图标 + 对话标识 + 预览 + 时间）
	fireEvent.click(screen.getByTestId("sidebar-tab-im"));
	expect(screen.queryByTestId("session-scope-project")).toBeNull();
	expect(screen.getByTestId("im-conv-list")).toBeTruthy();
	expect(screen.getByText("u-1001")).toBeTruthy();

	// 点击会话 → 透传 onSelectSession
	fireEvent.click(screen.getByTestId("im-conv-sess-im-1"));
	expect(onSelectSession).toHaveBeenCalledWith("sess-im-1");

	// 切回任务页签恢复
	fireEvent.click(screen.getByTestId("sidebar-tab-tasks"));
	expect(screen.getByTestId("session-scope-project")).toBeTruthy();
});

test("任务视图内分段控件：默认项目视角，切最近渲染 RecentSessionsList", () => {
	renderSidebar();
	const projectBtn = screen.getByTestId("session-scope-project");
	const recentBtn = screen.getByTestId("session-scope-recent");
	expect(projectBtn).toBeTruthy();
	expect(recentBtn).toBeTruthy();
	fireEvent.click(recentBtn);
	expect(screen.getByTestId("recent-sessions-list")).toBeTruthy();
});
