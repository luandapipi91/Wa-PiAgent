import { test, expect, mock, describe } from "bun:test";
import type { AgentConfig, SessionEntity } from "@hiagent/shared";

// 注意：不要静态 import store/agents——各测试用 mock.module 替换 ws-instance 后
// 动态 import，静态 import 会让模块提前缓存导致 send mock 失效（同 store-skills.test.ts）。

const agent = (name: string): AgentConfig => ({
  displayName: name, avatar: "🤖", avatarColor: "#000-#111", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",

  tools: [], skills: [], mcpServers: [], partners: { askTo: [] }, triggerKeywords: [],
});

const sess = (agentName: string, lastActivity: number): SessionEntity => ({
  id: Math.random().toString(), projectId: "p", primaryAgent: agentName,
  title: "", createdAt: 0, lastActivity, piSessionFile: "",
});

describe("topAgentsByRecency", () => {
  test("按最近会话时间倒序取前 n，无会话的排最后（按名称序）", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("a"), agent("b"), agent("c"), agent("d")];
    const sessions = [sess("b", 100), sess("c", 300), sess("b", 200)];
    const top = topAgentsByRecency(agents, sessions, 3);
    expect(top.map(a => a.displayName)).toEqual(["c", "b", "a"]);
  });

  test("agents 不足 n 时全返回", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { topAgentsByRecency } = await import("../src/store/agents");
    expect(topAgentsByRecency([agent("x")], [], 3)).toHaveLength(1);
  });

  test("同一 agent 多个会话取最大 lastActivity", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("a"), agent("b")];
    const sessions = [sess("a", 50), sess("b", 100), sess("a", 80)];
    const top = topAgentsByRecency(agents, sessions, 2);
    expect(top.map(x => x.displayName)).toEqual(["b", "a"]);
  });

  test("不修改原数组", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("b"), agent("a")];
    topAgentsByRecency(agents, [sess("a", 1)], 2);
    expect(agents.map(x => x.displayName)).toEqual(["b", "a"]);
  });
});

describe("useAgentsStore", () => {
  test("loadAll 发 agent:list", async () => {
    const sendMock = mock();
    mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().loadAll();
    expect(sendMock).toHaveBeenCalledWith({ type: "agent:list" });
  });

  test("createAgent 发 agent:create", async () => {
    const sendMock = mock();
    mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().createAgent("新助手");
    expect(sendMock).toHaveBeenCalledWith({ type: "agent:create", displayName: "新助手" });
  });

  test("deleteAgent 发 agent:delete", async () => {
    const sendMock = mock();
    mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().deleteAgent("foo");
    expect(sendMock).toHaveBeenCalledWith({ type: "agent:delete", name: "foo" });
  });

  test("setList 更新全量列表", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().setList([agent("a"), agent("b")]);
    expect(useAgentsStore.getState().list.map(a => a.displayName)).toEqual(["a", "b"]);
  });

  test("loadConfig 发 agent:config:get（兼容 AgentConfig 弹窗）", async () => {
    const sendMock = mock();
    mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().loadConfig("foo");
    expect(sendMock).toHaveBeenCalledWith({ type: "agent:config:get", agentName: "foo" });
  });

  test("setConfig 写入 configs", async () => {
    mock.module("../src/ws-instance", () => ({ send: mock(), onMessage: () => () => {} }));
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().setConfig("foo", agent("foo"));
    expect(useAgentsStore.getState().configs["foo"].displayName).toBe("foo");
  });
});
