import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import { MessageList, buildResendPrompt } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import { registerAgentMeta, ensureChipStyles } from "../src/quick-invoke/tokens";

beforeEach(() => {
  useSessionStore.setState({ messagesBySession: {}, streamingBySession: {} });
  useProjectsStore.setState({ sessions: [] });
  useProvidersStore.setState({ providers: [] });
  useComposerPrefsStore.setState({ bySession: {} });
  useToastStore.setState({ toasts: [] });
});

// 构造助手消息的便捷工厂：AssistantMessage 需要 content/model/stopReason/timestamp 完整字段
function assistantMsg(timestamp: number, content: any[], agentName: SessionMessage["agentName"] = "product"): SessionMessage {
  return { agentName, message: { role: "assistant", content, model: "pi-test", stopReason: "end_turn", timestamp } };
}

test("用户消息靠右、agent 消息靠左（flex-row-reverse）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "你好", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "收到" }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const userRow = screen.getByTestId("msg-s1-1");
  const agentRow = screen.getByTestId("msg-s1-2");
  expect(userRow.className).toContain("flex-row-reverse");
  expect(agentRow.className).toContain("flex");
  expect(userRow.className.includes("flex-row-reverse")).toBeTruthy();
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByText("收到")).toBeTruthy();
});

test("assistant 消息按 content block 渲染 thinking + text + toolCall", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "thinking", thinking: "我在想" },
          { type: "text", text: "答案" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // text block 立即可见
  expect(screen.getByText("答案")).toBeTruthy();
  // thinking 默认折叠（不可见），点击展开后可见
  expect(screen.queryByText("我在想")).toBeNull();
  fireEvent.click(screen.getByTestId("thinking-panel-header"));
  expect(screen.getByText("我在想")).toBeTruthy();
  // 单个 toolCall 直接渲染单卡（不成组），未完成时默认展开
  expect(screen.queryByTestId("toolcall-group")).toBeNull();
  expect(screen.getByTestId("toolcall-c1-header").textContent).toContain("read");
  // executingMode 下无 result 默认展开
  expect(screen.getByTestId("toolcall-c1-body")).toBeTruthy();
});

test("toolResult 按 toolCallId 关联到前一个 assistant 消息，不单独成行", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }]),
        {
          agentName: "product",
          message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "文件内容" }], isError: false, timestamp: 2 },
        },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolResult 不单独成行：只有 1 个 MessageRow（msg-s1-1），无 msg-s1-2
  expect(screen.getByTestId("msg-s1-1")).toBeTruthy();
  expect(screen.queryByTestId("msg-s1-2")).toBeNull();
  // toolCall 单卡默认折叠，展开后可见结果
  fireEvent.click(screen.getByTestId("toolcall-c1-header"));
  expect(screen.getByText("文件内容")).toBeTruthy();
});

test("成功的 toolCall（result 且非 isError）→ ✓ 图标 + 绿色（success）样式 + 弱化", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "ok1", name: "read", arguments: { path: "/a" } }]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "ok1", toolName: "read", content: [{ type: "text", text: "内容" }], isError: false, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 成功的 toolCall：✓ 图标 + meta「完成」+ success tone + 弱化
  const card = screen.getByTestId("toolcall-ok1");
  const header = screen.getByTestId("toolcall-ok1-header");
  expect(header.textContent).toContain("✓");
  expect(header.textContent).toContain("完成");
  expect(header.textContent).not.toContain("✗");
  const iconBox = header.querySelector("span")!;
  expect(iconBox.getAttribute("style")).toContain("var(--success)");
  expect(card.getAttribute("data-muted")).toBe("true");
});

test("失败的 toolCall（result.isError）→ ✗ 图标 + 红色（danger）样式 + 弱化", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "e1", name: "bash", arguments: { command: "bad" } }]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "e1", toolName: "bash", content: [{ type: "text", text: "命令失败" }], isError: true, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 失败的 toolCall：✗ 图标 + meta「失败」+ danger tone + 弱化
  const card = screen.getByTestId("toolcall-e1");
  const header = screen.getByTestId("toolcall-e1-header");
  expect(header.textContent).toContain("✗");
  expect(header.textContent).toContain("失败");
  const iconBox = header.querySelector("span")!;
  expect(iconBox.getAttribute("style")).toContain("var(--danger)");
  expect(card.getAttribute("data-muted")).toBe("true");
});

test("intercom toolCall 渲染 DelegateCard（委派卡片）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "d1", name: "intercom", arguments: { action: "ask", to: "pm", message: "需求?" } },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // intercom toolCall 和普通 toolCall 一样渲染 ToolCallCard（非 delegate 名），无专门 delegate card
  expect(screen.queryByTestId("delegate-d1")).toBeNull();
  expect(screen.getByTestId("toolcall-d1-header").textContent).toContain("intercom");
});

// 时间线渲染：被普通 toolCall 隔开的两段 text 保持为独立气泡，按出现顺序排列
test("text → toolCall → text（无 delegate）→ 两个文本气泡按时序排列", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "text", text: "前面这段" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
          { type: "text", text: "后面这段" },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 两段 text 都应可见
  expect(screen.getByText("前面这段")).toBeTruthy();
  expect(screen.getByText("后面这段")).toBeTruthy();
  // 关键断言：按时间线保留两个文本气泡，而不是跨 toolCall 聚合成一个
  const bubbles = screen.getAllByTestId("text-bubble");
  expect(bubbles).toHaveLength(2);
  expect(bubbles[0].textContent).toContain("前面这段");
  expect(bubbles[1].textContent).toContain("后面这段");
});

// delegate 仍是切割锚点；普通 toolCall 按时间线切割 text，不再跨 toolCall 聚合
test("text → toolCall → text → delegate → text → toolCall → text → delegate → text → 按时间线保留四个文本气泡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "text", text: "委派前" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
          { type: "toolCall", id: "d1", name: "delegate", arguments: { agent: "Explore", task: "搜" } },
          { type: "text", text: "委派后1" },
          { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "委派后2" },
          { type: "toolCall", id: "d2", name: "delegate", arguments: { agent: "Plan", task: "规划" } },
          { type: "text", text: "最后" },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 时间线顺序：
  // [text:委派前][toolCalls:t1][delegate:d1][text:委派后1][toolCalls:t2][text:委派后2][delegate:d2][text:最后]
  // → 4 个文本气泡，且顺序保持不变
  const bubbles = screen.getAllByTestId("text-bubble");
  expect(bubbles).toHaveLength(4);
  expect(bubbles[0].textContent).toContain("委派前");
  expect(bubbles[1].textContent).toContain("委派后1");
  expect(bubbles[2].textContent).toContain("委派后2");
  expect(bubbles[3].textContent).toContain("最后");
});

test("只有 toolCall 的 assistant 消息不渲染空白文字气泡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolCall 单卡直接可见（不成组）
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  // 不应有文字 block 容器
  expect(screen.queryByTestId("text-block")).toBeNull();
});

test("空字符串 text block 不渲染空白文字气泡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "   " },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolCall 单卡直接可见（不成组）
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.queryByTestId("text-block")).toBeNull();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});

test("AI 消息名称旁显示发送时间（今天）", () => {
  const ts = new Date();
  ts.setHours(10, 31, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "你好" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^dev · 10:31$/)).toBeTruthy();
});

test("用户消息旁显示名称和发送时间（今天）", () => {
  const ts = new Date();
  ts.setHours(14, 22, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hello", timestamp: ts.getTime() } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^我 · 14:22$/)).toBeTruthy();
});

test("昨天的消息显示「昨天」前缀", () => {
  const ts = new Date();
  ts.setDate(ts.getDate() - 1);
  ts.setHours(9, 5, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "昨天的消息" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^dev · 昨天 09:05$/)).toBeTruthy();
});

test("更早的消息显示月日和时间", () => {
  const ts = new Date();
  ts.setMonth(ts.getMonth() - 2);
  ts.setDate(3);
  ts.setHours(8, 7, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "更早的消息" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  const month = String(ts.getMonth() + 1).padStart(2, "0");
  const day = String(ts.getDate()).padStart(2, "0");
  expect(screen.getByText(new RegExp(`^dev · ${month}-${day} 08:07$`))).toBeTruthy();
});

// ── 自动滚动测试 ──

function setScrollMetrics(el: HTMLElement, { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

// ── 自动滚动：仅在 AI 回复（streaming）时跟随；平时不抢滚动 ──

test("AI 回复（streaming）中且停在底部 → 自动跟随滚动到底部", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 }); // 停在底部
  fireEvent.scroll(list);

  // AI 开始回复
  useSessionStore.setState({
    streamingBySession: {
      s1: { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "回复" }], model: "m", stopReason: "stop", timestamp: 2 } },
    },
  });

  await waitFor(() => {
    expect(list.scrollTop).toBe(1000);
  }, { timeout: 1000 });
});

test("AI 回复中用户向上翻阅 → 不自动跟随（不阻碍用户阅读）", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
  fireEvent.scroll(list); // stickBottom=true

  // AI 回复并跟随到底
  useSessionStore.setState({
    streamingBySession: {
      s1: { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "回复" }], model: "m", stopReason: "stop", timestamp: 2 } },
    },
  });
  await waitFor(() => expect(list.scrollTop).toBe(1000), { timeout: 1000 });

  // 用户向上翻阅离开底部
  list.scrollTop = 300;
  fireEvent.scroll(list); // stickBottom=false

  // 回复内容继续增长
  useSessionStore.setState({
    streamingBySession: {
      s1: { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "更长的回复内容" }], model: "m", stopReason: "stop", timestamp: 2 } },
    },
  });

  // 等待一帧，确认未被抢回底部
  await new Promise(r => setTimeout(r, 50));
  expect(list.scrollTop).toBe(300);
});

test("非回复时（停在底部）新增消息 → 不自动滚动", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 }); // 停在底部
  fireEvent.scroll(list);

  // 新增一条非流式消息（无 streaming）
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });

  await new Promise(r => setTimeout(r, 50));
  expect(list.scrollTop).toBe(700); // 未被拉到底（1000）
});

// ── 滚动到底部浮动按钮 ──

test("不在底部时显示「滚动到底部」浮动按钮", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
  fireEvent.scroll(list); // 离开底部
  expect(screen.getByTestId("scroll-bottom-s1")).toBeTruthy();
});

test("停在底部时不显示浮动按钮", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
  fireEvent.scroll(list); // 在底部
  expect(screen.queryByTestId("scroll-bottom-s1")).toBeNull();
});

test("点击浮动按钮 → 滚动到底部并隐藏", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
  fireEvent.scroll(list);

  fireEvent.click(screen.getByTestId("scroll-bottom-s1"));
  expect(list.scrollTop).toBe(1000);
  expect(screen.queryByTestId("scroll-bottom-s1")).toBeNull();
});

// ── 切换会话：自动滚到最新回复（一次性，非「平时抢滚动」）──

test("切换会话 → 自动滚到最新回复", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "s1 reply" }]),
      ],
      s2: [
        { agentName: undefined, message: { role: "user", content: "yo", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "s2 reply" }]),
      ],
    },
  });
  const { rerender } = render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  // s1 停在非底部
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 100 });
  fireEvent.scroll(list);

  // 切换到 s2
  rerender(<MessageList sessionId="s2" />);

  await waitFor(() => {
    expect(list.scrollTop).toBe(1000); // 自动滚到最新回复
  }, { timeout: 1000 });
});

// ── 重新发送按钮 ──

test("buildResendPrompt: 有会话+模型+文本 → 返回 agent:prompt 负载", () => {
  const p = buildResendPrompt({
    session: { projectId: "p1", primaryAgent: "dev" },
    sessionId: "s1", text: "你好", model: "deepseek-chat", thinking: "high",
  });
  expect(p).not.toBeNull();
  expect(p!.type).toBe("agent:prompt");
  expect(p!.projectId).toBe("p1");
  expect(p!.agentName).toBe("dev");
  expect(p!.model).toBe("deepseek-chat");
  expect(p!.thinking).toBe("high");
  expect(p!.text).toBe("你好");
});

test("buildResendPrompt: 缺会话/模型/空文本 → 返回 null（不发送）", () => {
  const base = { sessionId: "s1", text: "hi", model: "m" as string | null, thinking: "high" as const };
  expect(buildResendPrompt({ ...base, session: undefined })).toBeNull();
  expect(buildResendPrompt({ ...base, session: { projectId: "p1", primaryAgent: "dev" }, model: null })).toBeNull();
  expect(buildResendPrompt({ ...base, session: { projectId: "p1", primaryAgent: "dev" }, text: "   " })).toBeNull();
});

test("最后一条为失败 assistant → 其前一条用户消息下方出现「重新发送」", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "失败的那条", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "⚠️ 模型调用失败" }], model: "system", stopReason: "error", timestamp: 2 } },
      ],
    },
    streamingBySession: {},
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("resend-s1-1")).toBeTruthy();
});

test("最后一条为正常 assistant → 无「重新发送」按钮", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "m", stopReason: "stop", timestamp: 2 } },
      ],
    },
    streamingBySession: {},
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("resend-s1-1")).toBeNull();
});

test("正在流式生成时（streaming 存在）→ 不显示「重新发送」", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [], model: "m", stopReason: "error", timestamp: 2 } },
      ],
    },
    streamingBySession: { s1: { agentName: "dev", message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 3 } } },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("resend-s1-1")).toBeNull();
});

test("点击「重新发送」→ 原地重试：裁掉失败回合（用户消息+错误），不叠加", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "失败的那条", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "⚠️ 模型调用失败" }], model: "system", stopReason: "error", timestamp: 2 } },
      ],
    },
    streamingBySession: {},
  });
  useProjectsStore.setState({ sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev" }] as any });
  useProvidersStore.setState({
    providers: [
      { id: "prov-ds", name: "deepseek", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });
  useComposerPrefsStore.setState({ bySession: { s1: { model: "deepseek/deepseek-chat", thinking: "high", attachments: [] } } });
  render(<MessageList sessionId="s1" />);
  fireEvent.click(screen.getByTestId("resend-s1-1"));
  const s = useSessionStore.getState();
  // 失败回合被裁掉，立即乐观重建用户消息（不叠加，仍 1 条）+ loading 占位
  expect(s.messagesBySession["s1"]).toHaveLength(1);
  expect((s.messagesBySession["s1"][0].message as any).role).toBe("user");
  expect(s.streamingBySession["s1"]).toBeTruthy();
});

test("过期 model（provider 已删除）→ 点「重新发送」不裁剪、不重发", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "失败的那条", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "⚠️ 模型调用失败" }], model: "system", stopReason: "error", timestamp: 2 } },
      ],
    },
    streamingBySession: {},
  });
  useProjectsStore.setState({ sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev" }] as any });
  // providers 为空，prefs 残留已删除 provider 的 model
  useProvidersStore.setState({ providers: [] });
  useComposerPrefsStore.setState({ bySession: { s1: { model: "my-deepseek/deepseek-chat", thinking: "high", attachments: [] } } });
  render(<MessageList sessionId="s1" />);
  fireEvent.click(screen.getByTestId("resend-s1-1"));
  const s = useSessionStore.getState();
  // 原消息保留（不裁剪）、不产生新的乐观消息和 loading 占位
  expect(s.messagesBySession["s1"]).toHaveLength(2);
  expect(s.streamingBySession["s1"]).toBeFalsy();
});

// ── AI loading 气泡（乐观占位 / 首字到达前）──

test("streaming 占位（空 content）→ 渲染 loading 气泡「正在思考…」", () => {
  useSessionStore.setState({
    streamingBySession: {
      s1: { message: { role: "assistant", content: [], model: "pending", stopReason: "pending", timestamp: 1 }, agentName: "dev" },
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("loading-s1")).toBeTruthy();
  expect(screen.getByText("正在思考…")).toBeTruthy();
});

test("streaming 有内容 → 不显示 loading，正常渲染流式消息", () => {
  useSessionStore.setState({
    streamingBySession: {
      s1: { message: { role: "assistant", content: [{ type: "text", text: "部分回复" }], model: "m", stopReason: "stop", timestamp: 1 }, agentName: "dev" },
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("loading-s1")).toBeNull();
  expect(screen.getByText("部分回复")).toBeTruthy();
});

// ── 多 block 回合：流式期间全程只有一个机器人头像 ──
// SDK 对同 turn 的每个 block（thinking/text/toolCall）发独立 message_start/end。
// block N（如 thinking）message_end 后已定稿进 messages，block N+1（如 text）message_start
// 又把 streaming 填满——若各行其道会渲染出「已提交 assistant 行 + 流式 assistant 行」两个头像。
// 期望：同 agent 同回合的流式增量并入最后一条已定稿 assistant 行，全程一个头像。

test("同 agent 多 block 回合流式中：已提交 thinking 行 + 流式 text 行 → 合并为单行（仅一个头像）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "你好", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "thinking", thinking: "我先想想" }], model: "m", stopReason: "end_turn", timestamp: 2 } },
      ],
    },
    streamingBySession: {
      s1: { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "正在回答" }], model: "m", stopReason: "stop", timestamp: 3 } },
    },
  });
  render(<MessageList sessionId="s1" />);
  // 只有一个机器人头像
  expect(screen.getAllByText("🤖")).toHaveLength(1);
  // 已提交 thinking（折叠面板按钮）与流式 text 同处一行，均可见
  expect(screen.getByText("正在回答")).toBeTruthy();
  expect(screen.getByTestId("thinking-panel")).toBeTruthy();
});

// ── 同一回合合并：历史加载/工具调用把一个回合拆成多条 assistant（中间夹 toolResult）──
// 一个 agent 回合（中间没有用户消息）无论被 SDK/历史拆成多少条 assistant，都应聚合成一行/一个头像。
// toolResult 不单独成行（preprocess 已把它挂到前一个 assistant），但会隔断相邻 assistant 的合并——
// 这里验证渲染层跨过 toolResult 把同一 agent 的连续 assistant 合并。

test("同一 agent 回合被 toolResult 拆成两条 assistant（中间无用户消息）→ 合并为单行（一个头像）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "查一下", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "好的" }, { type: "toolCall", id: "c1", name: "search", arguments: { q: "x" } }], model: "m", stopReason: "tool_use", timestamp: 2 } },
        { agentName: "dev", message: { role: "toolResult", toolCallId: "c1", toolName: "search", content: [{ type: "text", text: "结果" }], isError: false, timestamp: 3 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "答案是" }], model: "m", stopReason: "end_turn", timestamp: 4 } },
      ],
    },
    streamingBySession: {},
  });
  render(<MessageList sessionId="s1" />);
  // 同一回合只渲染一个机器人头像（不应被 toolResult 隔断成两行）
  expect(screen.getAllByText("🤖")).toHaveLength(1);
  // 两段 assistant 文本都在同一行可见
  expect(screen.getByText("好的")).toBeTruthy();
  expect(screen.getByText("答案是")).toBeTruthy();
});

test("不同 agent 的连续 assistant 不合并（各自一个头像）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "dev 说" }], model: "m", stopReason: "end_turn", timestamp: 1 } },
        { agentName: "product", message: { role: "assistant", content: [{ type: "text", text: "product 说" }], model: "m", stopReason: "end_turn", timestamp: 2 } },
      ],
    },
    streamingBySession: {},
  });
  render(<MessageList sessionId="s1" />);
  // 不同 agent = 不同回合，各自一个头像
  expect(screen.getAllByText("🤖")).toHaveLength(2);
});

// ── 复制按钮 ──

test("assistant 文字消息显示「复制」按钮", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(1, [{ type: "text", text: "这是回答" }])],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("copy-s1-1")).toBeTruthy();
});

test("无文字内容的 assistant 消息不显示「复制」按钮", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(1, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }])],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("copy-s1-1")).toBeNull();
});

test("点击「复制」将回答文本写入剪贴板并提示成功", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: (text: string) => { copied = text; return Promise.resolve(); } },
    writable: true,
    configurable: true,
  });
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(1, [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }])],
    },
  });
  render(<MessageList sessionId="s1" />);
  fireEvent.click(screen.getByTestId("copy-s1-1"));
  await waitFor(() => expect(copied).toBe("第一段\n\n第二段"));
  expect(useToastStore.getState().toasts.some(t => t.message === "已复制到剪贴板")).toBe(true);
});

// === 技能块格式化测试 ===

test("用户消息中的 <skill> XML 块显示为技能名而非完整内容", () => {
  const skillBlock = `<skill name="speech-recognition" location="/path/SKILL.md">\nReferences are relative to /path.\n\n# 通用语音识别\n一大串技能内容...\n</skill>`;
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: `${skillBlock} 帮我识别录音`, timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const bubble = screen.getByTestId("msg-s1-1").querySelector("p")!;
  const text = bubble.textContent ?? "";
  // 应显示技能名
  expect(text).toContain("⚡ speech-recognition");
  // 应显示用户附加文本
  expect(text).toContain("帮我识别录音");
  // 不应显示技能正文内容
  expect(text).not.toContain("通用语音识别");
  expect(text).not.toContain("一大串技能内容");
});

test("用户消息中的多个 <skill> 块都被格式化", () => {
  const skill1 = `<skill name="brainstorming" location="/a/SKILL.md">\n内容A\n</skill>`;
  const skill2 = `<skill name="pdf-tools" location="/b/SKILL.md">\n内容B\n</skill>`;
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: `${skill1} ${skill2} 帮我处理`, timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const text = screen.getByTestId("msg-s1-1").querySelector("p")!.textContent ?? "";
  expect(text).toContain("brainstorming");
  expect(text).toContain("pdf-tools");
  expect(text).not.toContain("内容A");
  expect(text).not.toContain("内容B");
});

test("用户消息中 <skill> 块后跟 \\n\\n 再跟文本 → 技能名与文本同一行（不换行）", () => {
  // 真实数据结构：SDK 把 /skill:xxx 展开成 <skill>...</skill>，用户输入的文本追加在后面，
  // 中间隔着 \n\n。formatSkillBlocks 把 <skill> 替换为 ⚡ name 后，
  // 不应在技能名和后续文本间保留空行（\n\n 被 textToHtml 转成 <br><br> 会显示为空行）。
  const skillBlock = `<skill name="speech-recognition" location="/path/SKILL.md">\n内容\n</skill>`;
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: `${skillBlock}\n\nsss`, timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const bubble = screen.getByTestId("msg-s1-1").querySelector("p")!;
  const text = bubble.textContent ?? "";
  expect(text).toContain("⚡ speech-recognition");
  expect(text).toContain("sss");
  // 关键：DOM 里不应有 <br>（\n\n 会被 textToHtml 转成 <br><br> 产生空行）
  expect(bubble.querySelectorAll("br").length).toBe(0);
});
// 真实数据来自 ~/.wa-pi/sessions/*.jsonl 经 Pi SDK 加载后的 sdkSession.messages：
//   {role:"custom", customType:"subagent-notification", content:"<task-notification>...", display:true, ...}
// 之前的渲染逻辑用 m.type 判断 custom，但 SDK 内存消息字段是 m.role，导致掉到 assistant 分支
// 渲染出空气泡（content 是字符串、Array.isArray 返回 false → blocks=[]）。

test("Pi SDK custom 消息（role=custom + subagent-notification）→ 不渲染（与 DelegateCard 信息重复）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        {
          agentName: "技术实现",
          message: {
            role: "custom",
            customType: "subagent-notification",
            content: "<task-notification>\n<task-id>78916613</task-id>\n<status>Done</status>\n<summary>子智能体完成</summary>\n</task-notification>",
            display: true,
            details: { id: "78916613" },
            timestamp: 1,
          } as any,
        },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 不应渲染任何 msg 行（不应出现空气泡）
  expect(screen.queryAllByText(/技术实现/)).toHaveLength(0);
  // 不应泄露 task-notification XML 文本
  expect(screen.queryByText(/task-notification/)).toBeNull();
  expect(screen.queryByText(/78916613/)).toBeNull();
});

test("前端构造的 custom 消息（type=custom + agent_switch）→ 仍渲染为居中分隔行（兼容不破坏）", () => {
  // AgentSwitcher.tsx 用 type:"custom" 构造占位消息，必须保持兼容
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        {
          agentName: undefined,
          message: {
            type: "custom",
            customType: "agent_switch",
            content: "已切换为 质量验收",
            timestamp: 1,
          } as any,
        },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("custom-s1-1")).toBeTruthy();
  expect(screen.getByText(/已切换为 质量验收/)).toBeTruthy();
});

test("Pi SDK custom 消息 content 是字符串 → 不应掉到 assistant 分支渲染空气泡", () => {
  // 关键回归防护：content 字符串不应被 Array.isArray 判定为 [] 后渲染空 assistant 行
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        {
          agentName: "技术实现",
          message: {
            role: "custom",
            customType: "subagent-notification",
            content: "任何字符串内容都不应渲染成空气泡",
            display: true,
            timestamp: 1,
          } as any,
        },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // 不应出现 assistant 风格的气泡（左对齐 🤖 + agent 名 + 空白）
  expect(screen.queryAllByText(/技术实现/)).toHaveLength(0);
  // 不应出现 msg testid（assistant 气泡才有）
  expect(screen.queryByTestId("msg-s1-1")).toBeNull();
});

// ── 历史用户消息中 @[智能体] 渲染为 chip（与技能 chip 一致的特殊样式）──
// 现状：用户消息走纯文本 <p>{displayText}</p>，@[项目管理] 显示为字面文本，
//   不像技能（/skill:xxx 经 SDK 展开成 <skill> XML 后由 formatSkillBlocks 渲染为 ⚡ 名）那样有特殊样式。
// 期望：把用户消息文本经 textToHtml 处理，@[xxx] 渲染为 .chip-agent span（与 ComposerTextarea 一致）。

test("历史用户消息中 @[智能体名称] 渲染为 chip 样式（非字面文本）", () => {
  // 注册智能体头像信息（与 MessageList useEffect 中一致）
  ensureChipStyles();
  registerAgentMeta("项目管理", { avatar: "📋", avatarColor: "#5B5BD6" });

  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "@[项目管理] hi", timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);

  // 应该有 chip-agent 元素
  const chip = document.querySelector(".chip-agent");
  expect(chip).toBeTruthy();
  // chip 显示文本只含名称（不含 @ 触发符）
  expect(chip?.textContent).toContain("项目管理");
  expect(chip?.textContent).not.toContain("@项目管理");
  // chip 应保留 data-token 属性（原始 token）
  expect(chip?.getAttribute("data-token")).toBe("@[项目管理]");
  // chip 应包含注册的头像
  expect(chip?.querySelector(".chip-agent-avatar")?.textContent).toBe("📋");
});

test("历史用户消息中非 token 文本仍正常显示（chip 与正文共存）", () => {
  registerAgentMeta("项目管理", { avatar: "📋" });

  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "@[项目管理] 帮我排期", timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);

  // chip 部分
  expect(document.querySelector(".chip-agent")).toBeTruthy();
  // 正文部分
  const bubble = screen.getByTestId("msg-s1-1");
  expect(bubble.textContent).toContain("帮我排期");
});

// ── 组件挂载时自动注册 agentsStore 中的智能体 meta ──
// 现状：registerAgentMeta 只能由测试手动调用；生产环境用户消息中的 @[xxx] chip
//   找不到头像信息，chip 仍然渲染但不带头像（视觉缺失）。
// 期望：MessageList 挂载时把 useAgentsStore.list 的所有智能体注册到 registerAgentMeta。

test("组件挂载时自动注册 agentsStore 中的智能体 meta（chip 渲染能查到头像）", async () => {
  // 准备：agentsStore 放入两个智能体配置
  const { useAgentsStore } = await import("../src/store/agents");
  useAgentsStore.setState({
    list: [
      { name: "项目管理", displayName: "项目管理", avatar: "📋", avatarColor: "#5B5BD6" } as any,
      { name: "质量验收", displayName: "质量验收", avatar: "🛡️", avatarColor: "#DC2626" } as any,
    ],
  });

  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "@[项目管理] hi", timestamp: 1 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);

  // 组件挂载后 useEffect 应自动注册 → chip 应包含头像 📋（waitFor 等 effect 执行）
  await waitFor(() => {
    const avatar = document.querySelector(".chip-agent .chip-agent-avatar");
    expect(avatar?.textContent).toBe("📋");
  });
});

// ── 过程块 ProcessCard 迁移：自动折叠 / 弱化 ──

test("流式中 thinking 块默认展开", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [] },
    streamingBySession: {
      s1: assistantMsg(10, [{ type: "thinking", thinking: "让我想想" }]),
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("thinking-panel-body").textContent).toContain("让我想想");
});

test("已完成的 thinking 块不会因新 thinking 流式到达而重新展开", () => {
  // 模拟：第一段 thinking 已完成在消息历史中，第二段 thinking 正在流式
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(1, [{ type: "thinking", thinking: "第一段思考" }])],
    },
    streamingBySession: {
      s1: assistantMsg(2, [{ type: "thinking", thinking: "第二段思考中" }]),
    },
  });
  render(<MessageList sessionId="s1" />);
  // 两个 thinking 段各自独立成卡
  const cards = screen.getAllByTestId("thinking-panel");
  expect(cards).toHaveLength(2);
  // 第一段（已完成）：折叠 + 半透明
  expect(cards[0].getAttribute("data-muted")).toBe("true");
  expect(cards[0].querySelector("[data-testid=thinking-panel-body]")).toBeNull();
  // 第二段（流式中）：展开 + 不透明
  expect(cards[1].getAttribute("data-muted")).toBeNull();
  expect(cards[1].querySelector("[data-testid=thinking-panel-body]")).toBeTruthy();
});

test("流式中工具调用块默认展开，完成后（历史）折叠且弱化", () => {
  const tc = { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } };
  const tr = { role: "toolResult" as const, toolCallId: "tc1", toolName: "bash", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: 11 };
  // 历史：非流式 → 折叠 + muted
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [tc]), { agentName: "product", message: tr }] },
  });
  const { unmount } = render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("toolcall-tc1-body")).toBeNull();
  expect(screen.getByTestId("toolcall-tc1").getAttribute("data-muted")).toBe("true");
  unmount();
  // 流式中同一块 → 展开
  useSessionStore.setState({
    messagesBySession: { s1: [] },
    streamingBySession: { s1: assistantMsg(10, [tc]) },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("toolcall-tc1-body")).toBeTruthy();
});

test("用户点击折叠的卡片后内容展开（尊重手动选择）", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [{ type: "thinking", thinking: "历史思考" }])] },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("thinking-panel-body")).toBeNull();
  fireEvent.click(screen.getByTestId("thinking-panel-header"));
  expect(screen.getByTestId("thinking-panel-body").textContent).toContain("历史思考");
});

// 宽度稳定性（展开/收起工具卡片不跳变）：含过程卡片的消息列固定 78%，
// 纯文本消息保持内容驱动（max-w-[78%] shrink-wrap）
// 注：class 断言按空格切词精确匹配，避免 "max-w-[78%]" 子串误命中 "w-[78%]"
test("含工具卡片的消息列固定 78% 宽（展开/收起宽度一致）", () => {
  const tc = { type: "toolCall", id: "tcw", name: "bash", arguments: { command: "ls" } };
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [{ type: "text", text: "好" }, tc])] },
  });
  render(<MessageList sessionId="s1" />);
  const row = screen.getByTestId("msg-s1-10");
  const column = row.children[1] as HTMLElement; // 头像后的内容列
  expect(column.className.split(" ")).toContain("w-[78%]");
  // 展开后列宽 class 不变（宽度不随卡片开合变化）
  fireEvent.click(screen.getByTestId("toolcall-tcw-header"));
  expect((row.children[1] as HTMLElement).className.split(" ")).toContain("w-[78%]");
});

test("纯文本消息列保持内容驱动（max-w-[78%]，不固定宽）", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [{ type: "text", text: "好" }])] },
  });
  render(<MessageList sessionId="s1" />);
  const column = screen.getByTestId("msg-s1-10").children[1] as HTMLElement;
  expect(column.className.split(" ")).toContain("max-w-[78%]");
  expect(column.className.split(" ")).not.toContain("w-[78%]");
});

test("含 thinking 卡片的消息列固定 78% 宽", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [{ type: "thinking", thinking: "想" }])] },
  });
  render(<MessageList sessionId="s1" />);
  const column = screen.getByTestId("msg-s1-10").children[1] as HTMLElement;
  expect(column.className.split(" ")).toContain("w-[78%]");
});
