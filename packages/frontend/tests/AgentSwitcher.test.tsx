import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { emitEventForTesting, disconnectEvents } from "../src/events";

// 捕获 REST API 调用，替代已删除的 ws-instance send。
const apiCalls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { apiCalls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { apiCalls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { apiCalls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string) => { apiCalls.push({ method: "del", path }); return Promise.resolve({}); },
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

import { AgentSwitcher } from "../src/components/AgentSwitcher";
import { MessageList } from "../src/components/MessageList";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

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
  disconnectEvents();
  apiCalls.length = 0;
  useSessionStore.setState({ messagesBySession: {} });
  seed();
});

afterEach(() => {
  cleanup();
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
  expect(apiCalls.filter(c => c.method === "post" && c.path === "/api/sessions/s1/set-agent")).toHaveLength(0);
  expect(screen.queryByTestId("switcher-confirm")).toBeNull();
});

test("确认后才发送 set-agent 请求", () => {
  render(<AgentSwitcher sessionId="s1" />);
  fireEvent.click(screen.getByTestId("agent-switcher"));
  fireEvent.click(screen.getByTestId("switcher-item-代码审查"));
  expect(screen.getByTestId("switcher-confirm")).toBeTruthy();
  expect(apiCalls.filter(c => c.method === "post" && c.path === "/api/sessions/s1/set-agent")).toHaveLength(0);
  fireEvent.click(screen.getByTestId("switcher-confirm-ok"));
  expect(apiCalls.some(c => c.method === "post" && c.path === "/api/sessions/s1/set-agent" && c.body?.agentName === "代码审查")).toBe(true);
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
  expect(apiCalls.filter(c => c.method === "post" && c.path === "/api/sessions/s1/set-agent")).toHaveLength(0);
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
    emitEventForTesting({ type: "session:updated", sessionId: "s1", primaryAgent: "代码审查" } as any);
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
