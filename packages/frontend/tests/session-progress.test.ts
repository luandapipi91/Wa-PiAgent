// Task 8: store/session.ts — subagent:progress 消费的 store 单测。
// 说明：项目测试栈为 bun:test（非 vitest），按项目既有规范编写。
// 验证 progressByToolCall 采用 map 套 map 结构（[toolCallId][agent]），
// 以同时支持 delegate（单 agent）与 fleet（多 agent 共享同一 toolCallId）。
import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SubagentProgressEvent } from "@wa-pi/shared";

beforeEach(() => {
  // 每个 case 前清空进度表，避免相互污染
  useSessionStore.setState({ progressByToolCall: {} });
});

// 构造进度事件的便捷工厂
function progress(agent: string, overrides: Partial<SubagentProgressEvent> = {}): SubagentProgressEvent {
  return {
    agent,
    status: "running",
    output: `out-${agent}`,
    tools: [],
    elapsedMs: 1,
    ...overrides,
  };
}

// ── delegate：单 agent 写入并按 toolCallId→agent 取出 ──

test("handleSubagentProgress：delegate 单 agent 存入并按 [toolCallId][agent] 索引", () => {
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a"));
  const byAgent = useSessionStore.getState().progressByToolCall["tc1"];
  expect(byAgent["agent-a"].output).toBe("out-agent-a");
  // delegate 取值约定：内层 map 取首个 value
  expect(Object.values(byAgent)[0].agent).toBe("agent-a");
});

// ── 同一 toolCallId 重复写入：按 agent 更新而非整体覆盖 ──

test("handleSubagentProgress：同 toolCallId 同 agent 二次写入 = 更新（而非追加）", () => {
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a", { output: "v1" }));
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a", { output: "v2" }));
  const byAgent = useSessionStore.getState().progressByToolCall["tc1"];
  expect(Object.keys(byAgent)).toHaveLength(1);
  expect(byAgent["agent-a"].output).toBe("v2");
});

// ── fleet：同一 toolCallId 下多 agent 并存 ──

test("handleSubagentProgress：fleet 多 agent 共享同一 toolCallId 并存", () => {
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a"));
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-b"));
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-c"));
  const byAgent = useSessionStore.getState().progressByToolCall["tc1"];
  expect(Object.keys(byAgent).sort()).toEqual(["agent-a", "agent-b", "agent-c"]);
  expect(byAgent["agent-b"].output).toBe("out-agent-b");
});

// ── 不同 toolCallId 之间互不干扰 ──

test("handleSubagentProgress：不同 toolCallId 隔离", () => {
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a"));
  useSessionStore.getState().handleSubagentProgress("s1", "tc2", progress("agent-b"));
  const state = useSessionStore.getState().progressByToolCall;
  expect(state["tc1"]["agent-a"]).toBeDefined();
  expect(state["tc2"]["agent-b"]).toBeDefined();
  expect(state["tc1"]).not.toHaveProperty("agent-b");
});

// ── clearSubagentProgress：清掉某 toolCallId 全部 agent ──

test("clearSubagentProgress：清除指定 toolCallId 下全部进度，不影响其他", () => {
  useSessionStore.getState().handleSubagentProgress("s1", "tc1", progress("agent-a"));
  useSessionStore.getState().handleSubagentProgress("s1", "tc2", progress("agent-b"));
  useSessionStore.getState().clearSubagentProgress("tc1");
  const state = useSessionStore.getState().progressByToolCall;
  expect(state["tc1"]).toBeUndefined();
  expect(state["tc2"]["agent-b"]).toBeDefined();
});
