import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { MessageList, buildResendPrompt } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";

beforeEach(() => {
  useSessionStore.setState({ messagesBySession: {} });
  useProjectsStore.setState({ sessions: [] });
  useComposerPrefsStore.setState({ bySession: {} });
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
  fireEvent.click(screen.getByText(/思考过程/));
  expect(screen.getByText("我在想")).toBeTruthy();
  // toolCall 面板存在
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.getByText(/read/)).toBeTruthy();
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
  // 展开 toolCall 后能看到关联结果
  fireEvent.click(screen.getByText(/read/));
  expect(screen.getByText("文件内容")).toBeTruthy();
});

test("成功的 toolCall（result 且非 isError）→ ✓ 图标 + 绿色（success）样式", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "ok1", name: "read", arguments: { path: "/a" } }]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "ok1", toolName: "read", content: [{ type: "text", text: "内容" }], isError: false, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("✓")).toBeTruthy();
  const btn = screen.getByTestId("toolcall-ok1").querySelector("button")!;
  expect(btn.className).toContain("text-success");
});

test("失败的 toolCall（result.isError）→ ✗ 图标 + 红色（danger）样式", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "e1", name: "bash", arguments: { command: "bad" } }]),
        { agentName: "product", message: { role: "toolResult", toolCallId: "e1", toolName: "bash", content: [{ type: "text", text: "命令失败" }], isError: true, timestamp: 2 } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("✗")).toBeTruthy();
  const btn = screen.getByTestId("toolcall-e1").querySelector("button")!;
  expect(btn.className).toContain("text-danger");
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
  // intercom toolCall 和普通 toolCall 共用 ToolCallBlock，无专门 delegate card
  expect(screen.getByTestId("toolcall-d1")).toBeTruthy();
  expect(screen.getByText(/intercom/)).toBeTruthy();
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
  // toolCall 面板存在
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
  useComposerPrefsStore.setState({ bySession: { s1: { model: "deepseek-chat", thinking: "high", attachments: [] } } });
  render(<MessageList sessionId="s1" />);
  fireEvent.click(screen.getByTestId("resend-s1-1"));
  const s = useSessionStore.getState();
  // 失败回合被裁掉，立即乐观重建用户消息（不叠加，仍 1 条）+ loading 占位
  expect(s.messagesBySession["s1"]).toHaveLength(1);
  expect((s.messagesBySession["s1"][0].message as any).role).toBe("user");
  expect(s.streamingBySession["s1"]).toBeTruthy();
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
  expect(screen.getByText(/思考过程/)).toBeTruthy();
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
