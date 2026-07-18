import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useSessionStore.setState({ messagesBySession: {} });
  useProjectsStore.setState({ sessions: [] });
  useComposerPrefsStore.setState({ bySession: {} });
  useToastStore.setState({ toasts: [] });
});

const call = { type: "toolCall" as const, id: "t1", name: "delegate", arguments: { agent: "代码审查", task: "review diff" } };
const result = { role: "toolResult" as const, toolCallId: "t1", toolName: "delegate", content: [{ type: "text" as const, text: "发现 2 个问题…" }], isError: false, timestamp: 0 };

function assistantMsg(timestamp: number, content: any[], agentName: SessionMessage["agentName"] = "product"): SessionMessage {
  return { agentName, message: { role: "assistant", content, model: "pi-test", stopReason: "end_turn", timestamp } };
}

test("执行中：显示委派对象与任务，无结果区", () => {
  render(<DelegateCard toolCall={call} />);
  const el = screen.getByTestId("delegate-t1");
  expect(el.textContent).toContain("委派给");
  expect(el.textContent).toContain("代码审查");
  expect(el.textContent).toContain("review diff");
  expect(el.textContent).toContain("执行中");
  expect(screen.queryByTestId("delegate-expand")).toBeNull();
  expect(screen.queryByTestId("delegate-full-t1")).toBeNull();
});

test("完成：显示结果摘要，可展开/收起完整回复", () => {
  render(<DelegateCard toolCall={call} result={result} />);
  const el = screen.getByTestId("delegate-t1");
  expect(el.textContent).toContain("✓ 完成");
  expect(el.textContent).toContain("发现 2 个问题");
  expect(screen.queryByTestId("delegate-full-t1")).toBeNull();
  // 展开
  fireEvent.click(screen.getByTestId("delegate-expand"));
  expect(screen.getByTestId("delegate-full-t1").textContent).toContain("发现 2 个问题…");
  expect(screen.getByTestId("delegate-expand").textContent).toContain("收起");
  // 收起
  fireEvent.click(screen.getByTestId("delegate-expand"));
  expect(screen.queryByTestId("delegate-full-t1")).toBeNull();
  expect(screen.getByTestId("delegate-expand").textContent).toContain("展开完整回复");
});

test("完成：超过 120 字的结果摘要被截断，展开后显示完整文本", () => {
  const longText = "很长的回复".repeat(50); // 250 字
  const longResult = { ...result, content: [{ type: "text" as const, text: longText }] };
  render(<DelegateCard toolCall={call} result={longResult} />);
  expect(screen.getByTestId("delegate-t1").textContent).not.toContain(longText);
  fireEvent.click(screen.getByTestId("delegate-expand"));
  expect(screen.getByTestId("delegate-full-t1").textContent).toBe(longText);
});

test("MessageList 对 delegate 调用渲染 DelegateCard 而非 ToolCallBlock", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "d1", name: "delegate", arguments: { agent: "代码审查", task: "review diff" } },
        ]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "d1", toolName: "delegate", content: [{ type: "text", text: "发现 2 个问题…" }], isError: false, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolCall 默认折叠在分组中，展开分组后可见
  fireEvent.click(screen.getByTestId("toolcall-group").querySelector("button")!);
  expect(screen.getByTestId("delegate-d1")).toBeTruthy();
  expect(screen.queryByTestId("toolcall-d1")).toBeNull();
});

test("MessageList 对非 delegate 调用仍渲染 ToolCallBlock", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  fireEvent.click(screen.getByTestId("toolcall-group").querySelector("button")!);
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.queryByTestId("delegate-c1")).toBeNull();
});
