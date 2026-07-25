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

test("完成（非流式）：默认折叠，头部显示「委派给 {agent}」，body 不在 DOM", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} result={result} />);
  const header = screen.getByTestId("delegate-t1-header");
  expect(header.textContent).toContain("委派给 代码审查");
  expect(screen.queryByTestId("delegate-t1-body")).toBeNull();
});

test("流式中（isStreaming + 无 result）：默认展开且 meta 含「执行中」", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} isStreaming />);
  expect(screen.getByTestId("delegate-t1-body")).toBeTruthy();
  const header = screen.getByTestId("delegate-t1-header");
  expect(header.textContent).toContain("执行中");
  // 展开后任务可见
  expect(screen.getByTestId("delegate-t1-body").textContent).toContain("review diff");
});

test("完成后（有 result、非流式）：默认折叠且 data-muted=true", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} result={result} />);
  expect(screen.queryByTestId("delegate-t1-body")).toBeNull();
  expect(screen.getByTestId("delegate-t1").getAttribute("data-muted")).toBe("true");
});

test("失败（result.isError）：meta 含「✗ 失败」，展开后结果文本为 danger 样式", () => {
  const errResult = { ...result, isError: true, content: [{ type: "text" as const, text: "越权：无委派权限" }] };
  render(<DelegateCard sessionId="s1" toolCall={call} result={errResult} />);
  const header = screen.getByTestId("delegate-t1-header");
  expect(header.textContent).toContain("✗ 失败");
  expect(header.textContent).not.toContain("✓ 完成");
  // 展开后结果文本可见且为 danger
  fireEvent.click(header);
  const body = screen.getByTestId("delegate-t1-body");
  expect(body.textContent).toContain("越权：无委派权限");
  expect(body.querySelector(".text-danger")).toBeTruthy();
});

test("展开后子回复经 ReactMarkdown 渲染（code / 列表生成对应标签）", () => {
  const mdResult = { ...result, content: [{ type: "text" as const, text: "结论：用 `delegate` 工具\n\n- 问题一\n- 问题二" }] };
  render(<DelegateCard sessionId="s1" toolCall={call} result={mdResult} />);
  fireEvent.click(screen.getByTestId("delegate-t1-header"));
  const body = screen.getByTestId("delegate-t1-body");
  expect(body.querySelector("code")?.textContent).toBe("delegate");
  expect(body.querySelectorAll("li")).toHaveLength(2);
});

test("MessageList 内联渲染 DelegateCard：无普通 toolCall 时不出现分组，卡片直接可见", () => {
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
  // 内联在消息流中：无需展开任何分组即可见
  expect(screen.getByTestId("delegate-d1")).toBeTruthy();
  expect(screen.queryByTestId("toolcall-d1")).toBeNull();
  // 无普通 toolCall → 不出现工具调用分组
  expect(screen.queryByTestId("toolcall-group")).toBeNull();
});

test("delegate 与普通 toolCall 混合：delegate 内联独立成卡，普通调用为独立工具卡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "d1", name: "delegate", arguments: { agent: "代码审查", task: "review diff" } },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
        ]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "d1", toolName: "delegate", content: [{ type: "text", text: "发现 2 个问题…" }], isError: false, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // delegate 卡片直接可见（内联在消息流中）
  expect(screen.getByTestId("delegate-d1")).toBeTruthy();
  // 单个普通调用 → 独立单卡（不成组）
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.queryByTestId("toolcall-group")).toBeNull();
  // delegate 不嵌在工具卡内，且全文档唯一（不重复显示）
  expect(screen.getByTestId("toolcall-c1").querySelector("[data-testid='delegate-d1']")).toBeNull();
  expect(screen.getAllByTestId("delegate-d1")).toHaveLength(1);
});

test("MessageList 对非 delegate 调用仍渲染 ToolCallCard", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.queryByTestId("delegate-c1")).toBeNull();
});
