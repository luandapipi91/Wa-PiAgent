import { test, expect, beforeEach, mock } from "bun:test";

const calls: { method: string; path: string; body?: any }[] = [];
// PUT 失败注入：置值后 put 以该错误拒绝（验证 saveOverride 把失败抛给调用方，而不是内部吞掉）
let putFails: Error | null = null;
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
    post: () => Promise.resolve({}),
    put: (path: string, body?: any) => {
      calls.push({ method: "put", path, body });
      return putFails ? Promise.reject(putFails) : Promise.resolve({});
    },
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

// 动态 import 确保 mock.module 先生效
const { useSubagentsStore, handleSubagentEvent } = await import("../src/store/subagents");

beforeEach(() => {
  calls.length = 0;
  putFails = null;
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

// S12：saveOverride 的契约是把失败抛给调用方。
// 回退保护：一旦改回 `.catch(() => {})`，下面第一条就红（此前四条 S12 组件用例都把 action
// stub 成 mock，绕开了真实实现，改回吞错也全绿）。
test("saveOverride 在 PUT 失败时向调用方抛错（不再吞错）", async () => {
  putFails = new Error("knowledgeBaseIds 无效");
  await expect(
    useSubagentsStore.getState().saveOverride({ type: "Plan", model: "glm-4.6" }),
  ).rejects.toThrow("knowledgeBaseIds 无效");
  // 失败也必须真的发出过请求（不能提前吞掉/短路）
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/api/subagents/override");
});

test("saveOverride 成功时不抛错且只发一次 PUT", async () => {
  await useSubagentsStore.getState().saveOverride({ type: "Plan", thinking: "max" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: "put",
    path: "/api/subagents/override",
    body: { override: { type: "Plan", thinking: "max" } },
  });
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
