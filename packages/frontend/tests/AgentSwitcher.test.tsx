import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentSwitcher } from "../src/components/AgentSwitcher";
import { MessageList } from "../src/components/MessageList";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

// ws-instance mock：send 捕获载荷，onMessage 暴露触发器模拟 kernel 广播（同 SessionView.test 模式）。
// bun mock.module 不 hoist，但 factory 闭包可引用模块作用域变量。
const mockHandlers = { list: [] as Array<(e: any) => void> };
const sentEvents: any[] = [];
mock.module("../src/ws-instance", () => ({
  send: (e: any) => { sentEvents.push(e); },
  onMessage: (cb: any) => { mockHandlers.list.push(cb); return () => {}; },
}));

function cfg(name: string, extra: Record<string, any> = {}) {
  return {
    name,
    displayName: name,
    avatar: "🤖",
    avatarColor: "#06b6d4-#3b82f6",
    description: `${name}简介`,
    model: "m",
    thinking: "disabled",
    systemPromptMode: "replace",


    tools: [],
    skills: [],
    mcpServers: [],
    partners: { askTo: [] },
    ...extra,
  } as any;
}

function seed(primaryAgent = "dev") {
  useAgentsStore.setState({ list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")] });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p", primaryAgent, title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
    projects: [{ id: "p", name: "p", cwd: "/x", createdAt: 0 }],
  } as any);
}

beforeEach(() => {
  mockHandlers.list = [];
  sentEvents.length = 0;
  useSessionStore.setState({ messagesBySession: {} });
  seed();
});

test("显示当前智能体，点击展开带搜索的列表并过滤", () => {
  render(<AgentSwitcher sessionId="s1" />);
  fireEvent.click(screen.getByTestId("agent-switcher"));
  expect(screen.getByTestId("switcher-search")).toBeTruthy();
  expect(screen.getByTestId("switcher-item-代码审查")).toBeTruthy();
  fireEvent.change(screen.getByTestId("switcher-search"), { target: { value: "验收" } });
  expect(screen.queryByTestId("switcher-item-代码审查")).toBeNull();
  expect(screen.getByTestId("switcher-item-质量验收")).toBeTruthy();
});

test("选择非当前项先弹缓存失效确认框，取消不发送", () => {
  render(<AgentSwitcher sessionId="s1" />);
  fireEvent.click(screen.getByTestId("agent-switcher"));
  fireEvent.click(screen.getByTestId("switcher-item-代码审查"));
  expect(screen.getByTestId("switcher-confirm")).toBeTruthy();
  fireEvent.click(screen.getByTestId("switcher-confirm-cancel"));
  expect(sentEvents.filter(e => e.type === "session:set-agent")).toHaveLength(0);
  expect(screen.queryByTestId("switcher-confirm")).toBeNull();
});

test("确认后才发送 session:set-agent", () => {
  render(<AgentSwitcher sessionId="s1" />);
  fireEvent.click(screen.getByTestId("agent-switcher"));
  fireEvent.click(screen.getByTestId("switcher-item-代码审查"));
  expect(screen.getByTestId("switcher-confirm")).toBeTruthy();
  expect(sentEvents.filter(e => e.type === "session:set-agent")).toHaveLength(0);
  fireEvent.click(screen.getByTestId("switcher-confirm-ok"));
  expect(sentEvents.some(e => e.type === "session:set-agent" && e.sessionId === "s1" && e.agentName === "代码审查")).toBe(true);
  // 确认后菜单与弹窗都关闭
  expect(screen.queryByTestId("switcher-confirm")).toBeNull();
  expect(screen.queryByTestId("switcher-search")).toBeNull();
});

test("选择当前项不弹确认框直接关闭", () => {
  render(<AgentSwitcher sessionId="s1" />);
  fireEvent.click(screen.getByTestId("agent-switcher"));
  fireEvent.click(screen.getByTestId("switcher-item-dev"));
  expect(screen.queryByTestId("switcher-confirm")).toBeNull();
  expect(screen.queryByTestId("switcher-search")).toBeNull();
  expect(sentEvents.filter(e => e.type === "session:set-agent")).toHaveLength(0);
});

test("primaryAgent 不在列表中（已删除）时显示警示条，点击仍可展开列表", () => {
  seed("已删除者");
  render(<AgentSwitcher sessionId="s1" />);
  expect(screen.getByTestId("switcher-missing")).toBeTruthy();
  fireEvent.click(screen.getByTestId("agent-switcher"));
  expect(screen.getByTestId("switcher-search")).toBeTruthy();
  // 重选同样走确认框
  fireEvent.click(screen.getByTestId("switcher-item-dev"));
  expect(screen.getByTestId("switcher-confirm")).toBeTruthy();
});

test("收到 session:updated 后更新会话主智能体并追加分隔行 custom 消息", async () => {
  render(<AgentSwitcher sessionId="s1" />);
  await act(async () => {
    mockHandlers.list.forEach(h => h({ type: "session:updated", sessionId: "s1", primaryAgent: "代码审查" }));
  });
  const sess = useProjectsStore.getState().sessions.find(x => x.id === "s1")!;
  expect(sess.primaryAgent).toBe("代码审查");
  const msgs = useSessionStore.getState().messagesBySession["s1"] ?? [];
  const last = msgs[msgs.length - 1]?.message as any;
  expect(last.type).toBe("custom");
  expect(last.customType).toBe("agent_switch");
  expect(last.content).toBe("已切换为 代码审查");
});

test("MessageList 把 agent_switch custom 消息渲染为居中灰字分隔行", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "问", timestamp: 1 } as any },
        { message: { type: "custom", customType: "agent_switch", content: "已切换为 代码审查", timestamp: 2 } as any },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("—— 已切换为 代码审查 ——")).toBeTruthy();
});
