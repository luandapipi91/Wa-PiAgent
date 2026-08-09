import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";
import { useChannelsStore } from "../src/store/channels";

const noop = () => {};
const renderSidebar = (overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
  render(<Sidebar onNewSession={noop} onChatWith={noop} onEdit={noop} onMore={noop} onSelectSession={noop} onNewSessionInProject={noop} onSelectProject={noop} onNewProject={noop} {...overrides} />);

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText(/新建会话/)).toBeTruthy();
  // 分组标题改为大写"智能体"
  expect(screen.getByText("智能体")).toBeTruthy();
  // "项目"区头现在仅在存在用户项目时渲染（ProjectList 的 userProjects.length>0 条件）；
  // 此处 projects 为空，故不断言该区头。改成有项目时再验证区头出现：
  expect(screen.queryByText(/^项目$/)).toBeNull();
});

test("透传 onNewSession", () => {
  const fn = mock();
  render(<Sidebar onNewSession={fn} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
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
        channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
        chatId: "u-1001", chatType: "single", sessionId: "sess-im-1",
        projectId: "__system__", projectName: "默认工作区",
        lastMessagePreview: "你好", updatedAt: Date.now(),
      } as any,
    ],
  });
  const onSelectSession = mock();
  renderSidebar({ onSelectSession });

  // 默认任务页：新建会话按钮在，IM 列表不在
  expect(screen.getByTestId("new-session-btn")).toBeTruthy();
  expect(screen.queryByTestId("im-conv-list")).toBeNull();

  // 切到 IM 页签：出现渠道会话列表（渠道图标 + 对话标识 + 预览 + 时间）
  fireEvent.click(screen.getByTestId("sidebar-tab-im"));
  expect(screen.queryByTestId("new-session-btn")).toBeNull();
  expect(screen.getByTestId("im-conv-list")).toBeTruthy();
  expect(screen.getByText("u-1001")).toBeTruthy();

  // 点击会话 → 透传 onSelectSession
  fireEvent.click(screen.getByTestId("im-conv-sess-im-1"));
  expect(onSelectSession).toHaveBeenCalledWith("sess-im-1");

  // 切回任务页签恢复
  fireEvent.click(screen.getByTestId("sidebar-tab-tasks"));
  expect(screen.getByTestId("new-session-btn")).toBeTruthy();
});
