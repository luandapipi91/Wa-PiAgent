import { test, expect, beforeEach, mock } from "bun:test";

const handlers = new Set<(e: any) => void>();
const sendMock = mock();
mock.module("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: any) => void) => { handlers.add(h); return () => handlers.delete(h); },
}));

// 动态 import 确保 mock.module 先生效
const { useSubagentsStore, handleSubagentEvent } = await import("../src/store/subagents");

beforeEach(() => {
  sendMock.mockClear();
  useSubagentsStore.setState({ subagents: [] });
});

const emit = (e: any) => handlers.forEach(h => h(e));

test("load 发送 subagent:list 事件", () => {
  useSubagentsStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "subagent:list" });
});

test("收到 subagent:list 事件后填充 subagents", () => {
  const fakeList = [
    { name: "Plan", displayName: "规划子智能体", description: "", emoji: "📐",
      gradient: ["#7c3aed", "#a78bfa"] as [string, string], readOnly: true,
      systemPrompt: "long...", builtinToolNames: ["read"] },
  ];
  // 直接调 handleSubagentEvent 验证 store 的消息处理逻辑（生产里由 onMessage 转调），
  // 绕过 mock.module 跨文件失效问题
  handleSubagentEvent({ type: "subagent:list", subagents: fakeList });
  expect(useSubagentsStore.getState().subagents).toEqual(fakeList);
});

test("saveOverride 发送 subagent:save-override 事件", () => {
  useSubagentsStore.getState().saveOverride({ type: "Plan", model: "glm-4.6" });
  expect(sendMock).toHaveBeenCalledWith({
    type: "subagent:save-override",
    override: { type: "Plan", model: "glm-4.6" },
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
