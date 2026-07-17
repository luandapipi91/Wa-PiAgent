import { test, expect, mock, beforeEach } from "bun:test";
import { render } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

// 捕获 App 注册的 onMessage 处理器，便于直接派发 {type:"error"} 事件
let handler: ((e: any) => void) | null = null;
mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: (h: any) => {
    handler = h;
    return () => {
      handler = null;
    };
  },
}));

beforeEach(() => {
  handler = null;
  useProjectsStore.setState({
    projects: [],
    sessions: [],
    currentProjectId: null,
    currentSessionId: null,
  });
  useSessionStore.getState().clear();
});

test("error 事件注入的消息文本不带 ⚠️ 前缀（红色样式由 stopReason=error 承担）", () => {
  // 空项目态即可：App 的 onMessage 在 mount 时无条件注册，无需渲染 SessionView
  // （避免 SessionView 读 AGENT_DEFS 崩溃）。sessionId 由事件本身携带路由到 s1。
  render(<App />);
  expect(handler).toBeTruthy();

  handler!({ type: "error", message: "MCP error -32000: Connection closed", sessionId: "s1" });

  const msgs = useSessionStore.getState().messagesBySession["s1"];
  expect(msgs?.length).toBe(1);
  // content[0] 是联合类型（string | TextContent | ...），测试里必为 text block，断言为 {text}
  const msg = msgs![0]!;
  const content = msg.message.content!;
  const block = content[0] as { type: string; text: string };
  const text = block.text;
  // 文本应等于原始错误，不被加 ⚠️ 前缀（视觉上的错误区分由 stopReason=error 的红色渲染承担）
  expect(text).toBe("MCP error -32000: Connection closed");
  expect(text.startsWith("⚠")).toBe(false);
});

test("error 事件复位 thinking 卡死：agent 启动失败后 status 归 idle、清 streaming 占位", () => {
  render(<App />);
  expect(handler).toBeTruthy();

  // 模拟用户刚发完消息：optimisticSend 置 thinking + streaming 占位
  useSessionStore.getState().optimisticSend("s1", "你好", "dev");
  expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");

  // kernel 广播启动失败（如 No API key）
  handler!({ type: "error", message: "agent 启动失败: No API key for deepseek/deepseek-v4-pro", sessionId: "s1", agentName: "dev" });

  const s = useSessionStore.getState();
  // 状态必须归 idle，否则 UI 永远显示「思考中」且停止按钮无效（agent 从未启动，不会有 agent_end）
  expect(s.statusBySession["s1"]).toBe("idle");
  expect(s.streamingBySession["s1"]).toBeNull();
  expect(s.thinkingSinceBySession["s1"]).toBeNull();
  // 错误消息本身照常注入列表
  expect(s.messagesBySession["s1"]?.some(m => (m.message as any).stopReason === "error")).toBe(true);
});
