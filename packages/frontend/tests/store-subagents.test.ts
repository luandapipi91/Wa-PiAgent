import { test, expect, beforeEach, mock } from "bun:test";

const calls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
    post: () => Promise.resolve({}),
    put: (path: string, body?: any) => { calls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

// 动态 import 确保 mock.module 先生效
const { useSubagentsStore, handleSubagentEvent } = await import("../src/store/subagents");

beforeEach(() => {
  calls.length = 0;
  useSubagentsStore.setState({ subagents: [] });
});

test("load 发送 GET /api/subagents", () => {
  useSubagentsStore.getState().load();
  expect(calls).toEqual([{ method: "get", path: "/api/subagents" }]);
});

test("收到 subagent:list 事件后填充 subagents", () => {
  const fakeList = [
    { name: "Plan", displayName: "规划子智能体", description: "", emoji: "📐",
      gradient: ["#7c3aed", "#a78bfa"] as [string, string], readOnly: true,
      systemPrompt: "long...", builtinToolNames: ["read"] },
  ];
  // 直接调 handleSubagentEvent 验证 store 的消息处理逻辑（生产里由 onMessage 转调）
  handleSubagentEvent({ type: "subagent:list", subagents: fakeList });
  expect(useSubagentsStore.getState().subagents).toEqual(fakeList);
});

test("saveOverride 发送 PUT /api/subagents/override", () => {
  useSubagentsStore.getState().saveOverride({ type: "Plan", model: "glm-4.6" });
  expect(calls).toEqual([{ method: "put", path: "/api/subagents/override", body: { override: { type: "Plan", model: "glm-4.6" } } }]);
});

test("getByName 返回单个 subagent info", () => {
  useSubagentsStore.setState({
    subagents: [{ name: "Plan", displayName: "规划子智能体", description: "",
      emoji: "📐", gradient: ["#7c3aed", "#a78bfa"] as [string, string], readOnly: true,
      systemPrompt: "x", builtinToolNames: [] }],
  });
  const info = useSubagentsStore.getState().getByName("Plan");
  expect(info?.displayName).toBe("规划子智能体");
  expect(useSubagentsStore.getState().getByName("non-exist")).toBeUndefined();
});
