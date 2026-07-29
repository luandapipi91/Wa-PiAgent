import { test, expect, mock, describe } from "bun:test";
import type { AgentConfig, SessionEntity } from "@wa-pi/shared";

const agent = (name: string): AgentConfig => ({
  displayName: name, avatar: "🤖", avatarColor: "#000-#111", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",
  tools: [], skills: [], mcpServers: [], partners: { askTo: [] },
});

const sess = (agentName: string, lastActivity: number): SessionEntity => ({
  id: Math.random().toString(), projectId: "p", primaryAgent: agentName,
  title: "", createdAt: 0, lastActivity, piSessionFile: "",
});

describe("topAgentsByRecency", () => {
  test("按最近会话时间倒序取前 n，无会话的排最后（按名称序）", async () => {
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("a"), agent("b"), agent("c"), agent("d")];
    const sessions = [sess("b", 100), sess("c", 300), sess("b", 200)];
    const top = topAgentsByRecency(agents, sessions, 3);
    expect(top.map(a => a.displayName)).toEqual(["c", "b", "a"]);
  });

  test("agents 不足 n 时全返回", async () => {
    const { topAgentsByRecency } = await import("../src/store/agents");
    expect(topAgentsByRecency([agent("x")], [], 3)).toHaveLength(1);
  });

  test("同一 agent 多个会话取最大 lastActivity", async () => {
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("a"), agent("b")];
    const sessions = [sess("a", 50), sess("b", 100), sess("a", 80)];
    const top = topAgentsByRecency(agents, sessions, 2);
    expect(top.map(x => x.displayName)).toEqual(["b", "a"]);
  });

  test("不修改原数组", async () => {
    const { topAgentsByRecency } = await import("../src/store/agents");
    const agents = [agent("b"), agent("a")];
    topAgentsByRecency(agents, [sess("a", 1)], 2);
    expect(agents.map(x => x.displayName)).toEqual(["b", "a"]);
  });
});

describe("useAgentsStore", () => {
  function mockApi() {
    const calls: { method: string; path: string; body?: any }[] = [];
    const apiMock = {
      get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
      post: (path: string, body?: any) => { calls.push({ method: "post", path, body }); return Promise.resolve({}); },
      put: () => Promise.resolve({}),
      del: (path: string) => { calls.push({ method: "del", path }); return Promise.resolve({}); },
    };
    mock.module("../src/api-client", () => ({ api: apiMock, ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } } }));
    return calls;
  }

  test("loadAll 发 GET /api/agents", async () => {
    const calls = mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().loadAll();
    expect(calls).toEqual([{ method: "get", path: "/api/agents" }]);
  });

  test("createAgent 发 POST /api/agents", async () => {
    const calls = mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().createAgent("新助手");
    expect(calls).toEqual([{ method: "post", path: "/api/agents", body: { displayName: "新助手" } }]);
  });

  test("deleteAgent 发 DELETE /api/agents/:name", async () => {
    const calls = mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().deleteAgent("foo");
    expect(calls).toEqual([{ method: "del", path: "/api/agents/foo" }]);
  });

  test("setList 更新全量列表", async () => {
    mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().setList([agent("a"), agent("b")]);
    expect(useAgentsStore.getState().list.map(a => a.displayName)).toEqual(["a", "b"]);
  });

  test("loadConfig 发 GET /api/agents/:name/config", async () => {
    const calls = mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.getState().loadConfig("foo");
    expect(calls).toEqual([{ method: "get", path: "/api/agents/foo/config" }]);
  });

  test("setConfig 写入 configs", async () => {
    mockApi();
    const { useAgentsStore } = await import("../src/store/agents");
    useAgentsStore.setState({ list: [], configs: {} });
    useAgentsStore.getState().setConfig("foo", agent("foo"));
    expect(useAgentsStore.getState().configs["foo"].displayName).toBe("foo");
  });
});
