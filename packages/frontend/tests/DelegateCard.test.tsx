import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
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

test("流式中（isStreaming + 无 result）：默认展开、不透明、meta 含「执行中」", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} isStreaming />);
  expect(screen.getByTestId("delegate-t1-body")).toBeTruthy();
  expect(screen.getByTestId("delegate-t1").getAttribute("data-muted")).toBeNull();
  const header = screen.getByTestId("delegate-t1-header");
  expect(header.textContent).toContain("执行中");
  expect(screen.getByTestId("delegate-t1-body").textContent).toContain("review diff");
});

test("完成后（有 result、非流式）：默认折叠且 data-muted=true", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} result={result} />);
  expect(screen.queryByTestId("delegate-t1-body")).toBeNull();
  expect(screen.getByTestId("delegate-t1").getAttribute("data-muted")).toBe("true");
});

test("执行中（无 result、非流式，如 block 已定稿但工具未返回）：默认展开且不透明", () => {
  render(<DelegateCard sessionId="s1" toolCall={call} />);
  // 委托还在执行中，卡片应展开（body 可见）且不弱化
  expect(screen.getByTestId("delegate-t1-body")).toBeTruthy();
  expect(screen.getByTestId("delegate-t1").getAttribute("data-muted")).toBeNull();
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

// ── Task 9：子代理进度展示（默认折叠摘要 + 展开看 output/工具时间线）──
// 进度按二级 map 存储：progressByToolCall[toolCallId][agent] = SubagentProgressEvent。
// DelegateCard 是单 agent 卡片，取 Object.values(agentMap)[0]。
function setProgress(toolCallId: string, agent: string, p: Partial<{ status: string; output: string; tools: any[]; elapsedMs: number }> = {}) {
  useSessionStore.setState({
    progressByToolCall: {
      [toolCallId]: {
        [agent]: {
          agent,
          status: p.status ?? "running",
          output: p.output ?? "",
          tools: p.tools ?? [],
          elapsedMs: p.elapsedMs ?? 0,
        },
      },
    },
  });
}

test("有进度且未完成时：默认折叠显示摘要（状态/耗时/工具数），output 不可见；展开后可见 output 与工具时间线", () => {
  setProgress("tc-prog", "general-purpose", {
    status: "running",
    output: "正在分析代码",
    tools: [
      { id: "t1", name: "Bash", status: "done" },
      { id: "t2", name: "Read", status: "running" },
    ],
    elapsedMs: 12000,
  });
  render(
    <DelegateCard
      sessionId="s1"
      toolCall={{ type: "toolCall", id: "tc-prog", name: "delegate", arguments: { agent: "general-purpose", task: "hi" } }}
    />,
  );
  // 摘要可见：状态「运行中」、耗时 12s、工具数 2
  expect(screen.getByText(/运行中/)).toBeTruthy();
  expect(screen.getByText(/12\s*s/)).toBeTruthy();
  expect(screen.getByText(/2\s*个工具/)).toBeTruthy();
  // 折叠态：实时 output 默认不可见
  expect(screen.queryByText("正在分析代码")).toBeNull();
  // 展开（点击摘要行开关）
  fireEvent.click(screen.getByRole("button", { name: /展开|▶/ }));
  expect(screen.getByText("正在分析代码")).toBeTruthy();
  // 工具时间线：两条工具，含名称与状态
  expect(screen.getByText(/Bash/)).toBeTruthy();
  expect(screen.getByText(/Read/)).toBeTruthy();
});

test("进度态不同 status 映射：done→完成、error→出错", () => {
  setProgress("tc-done", "a", { status: "done", output: "ok", tools: [], elapsedMs: 5000 });
  const { unmount } = render(
    <DelegateCard sessionId="s1" toolCall={{ type: "toolCall", id: "tc-done", name: "delegate", arguments: { agent: "a", task: "x" } }} />,
  );
  expect(screen.getByText(/完成/)).toBeTruthy();
  unmount();

  setProgress("tc-err", "a", { status: "error", output: "boom", tools: [], elapsedMs: 0 });
  render(
    <DelegateCard sessionId="s1" toolCall={{ type: "toolCall", id: "tc-err", name: "delegate", arguments: { agent: "a", task: "x" } }} />,
  );
  expect(screen.getByText(/出错/)).toBeTruthy();
});

test("无进度时不渲染摘要行（保持原有行为）", () => {
  useSessionStore.setState({ progressByToolCall: {} });
  render(
    <DelegateCard sessionId="s1" toolCall={{ type: "toolCall", id: "tc-none", name: "delegate", arguments: { agent: "a", task: "x" } }} />,
  );
  // 无摘要开关与「个工具」字样
  expect(screen.queryByRole("button", { name: /展开|▶/ })).toBeNull();
  expect(screen.queryByText(/个工具/)).toBeNull();
});

test("完成态（result 存在）也有进度摘要开关，可展开看结果详情", () => {
  setProgress("tc-fin", "general-purpose", {
    status: "done",
    output: "已完成分析",
    tools: [{ id: "t1", name: "Bash", status: "done" }],
    elapsedMs: 3000,
  });
  const doneResult = { ...result, toolCallId: "tc-fin" };
  render(
    <DelegateCard
      sessionId="s1"
      toolCall={{ type: "toolCall", id: "tc-fin", name: "delegate", arguments: { agent: "general-purpose", task: "hi" } }}
      result={doneResult}
    />,
  );
  // 完成态默认折叠，但有摘要开关可展开
  expect(screen.getByRole("button", { name: /展开|▶/ })).toBeTruthy();
  expect(screen.getByText(/1\s*个工具/)).toBeTruthy();
  // 折叠时结果详情不可见
  expect(screen.queryByText("发现 2 个问题…")).toBeNull();
  // 展开后可见
  fireEvent.click(screen.getByRole("button", { name: /展开|▶/ }));
  expect(screen.getByText("发现 2 个问题…")).toBeTruthy();
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
