import "./mock-composer-db";
import { test, expect, beforeEach, mock, afterEach } from "bun:test";
import { render, screen, waitFor, act, fireEvent, cleanup } from "@testing-library/react";
import { SYSTEM_PROJECT_ID, type SessionMessage } from "@wa-pi/shared";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { disconnectEvents } from "../src/events";

// 记录所有 REST API 调用，替代原 WebSocket sentEvents。
const apiCalls: { method: string; path: string; body?: any }[] = [];

// 控制 /messages GET 的异步解析，用于验证加载指示的显隐。
let messagesDeferred: {
  promise: Promise<{ messages: SessionMessage[] }>;
  resolve: (value: { messages: SessionMessage[] }) => void;
  reject: (reason?: any) => void;
} | null = null;

function deferMessages() {
  let resolve!: (value: { messages: SessionMessage[] }) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<{ messages: SessionMessage[] }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  messagesDeferred = { promise, resolve, reject };
  return messagesDeferred;
}

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      apiCalls.push({ method: "get", path });
      if (path.includes("/messages")) {
        return messagesDeferred?.promise ?? Promise.resolve({ messages: [] });
      }
      return Promise.resolve({});
    },
    post: (path: string, body?: any) => {
      apiCalls.push({ method: "post", path, body });
      return Promise.resolve({});
    },
    put: (path: string, body?: any) => {
      apiCalls.push({ method: "put", path, body });
      return Promise.resolve({});
    },
    del: (path: string) => {
      apiCalls.push({ method: "del", path });
      return Promise.resolve({});
    },
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
  disconnectEvents();
  apiCalls.length = 0;
  messagesDeferred = null;

  // composer-db 默认值重置，避免 Composer 异步加载覆盖测试状态。
  composerDbDefaults.model = "openai/gpt-4o";
  composerDbDefaults.thinking = "disabled";
  for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];

  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useSessionStore.setState({ messagesBySession: {} });
  // 重置 composer-prefs 和 providers，防止测试间状态泄漏
  useComposerPrefsStore.setState({ bySession: {}, defaults: { model: null, thinking: "disabled" } });
  useProvidersStore.setState({ providers: [] });
});

// 渲染并等待异步 effect（composer-prefs loadSession、api.get 等）落定，
// 减少 React act 警告。
async function renderSessionView(sessionId: string) {
  const result = render(<SessionView sessionId={sessionId} />);
  await act(async () => {});
  return result;
}

test("渲染 header 标题 + 项目目录", async () => {
  await renderSessionView("s1");
  expect(screen.getByText("测试")).toBeTruthy();
  expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("header 状态显示中文「空闲」，不暴露英文枚举", async () => {
  await renderSessionView("s1");
  expect(screen.getByText(/· 空闲/)).toBeTruthy();
  expect(screen.queryByText(/· idle/)).toBeNull();
  // 状态点：idle 成功绿
  expect((screen.getByTestId("session-status-dot") as HTMLElement).style.background.toLowerCase()).toBe("#34a853");
});

test("header 状态跟随会话运行态显示「思考中」", async () => {
  useSessionStore.setState({ statusBySession: { s1: "thinking" } });
  await renderSessionView("s1");
  expect(screen.getByText(/· 思考中/)).toBeTruthy();
  expect(screen.queryByText(/· thinking/)).toBeNull();
  // 状态点：thinking 靛蓝
  expect((screen.getByTestId("session-status-dot") as HTMLElement).style.background.toLowerCase()).toBe("#5b5bd6");
});

test("有 pending ask 时 header 状态显示「等待回复」", async () => {
  const askCall = { type: "toolCall", id: "tc-ask-2", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } };
  useSessionStore.getState().setMessages("s1", [
    { agentName: "dev", message: { role: "assistant", content: [askCall], model: "pi-test", stopReason: "tool_use", timestamp: 1 } as any },
  ]);
  await renderSessionView("s1");
  expect(screen.getByText(/· 等待回复/)).toBeTruthy();
  expect(screen.queryByText(/· blocked/)).toBeNull();
  // 状态点：blocked 警告橙
  expect((screen.getByTestId("session-status-dot") as HTMLElement).style.background.toLowerCase()).toBe("#b45309");
});

test("收到 session:messages 响应后填充历史消息", () => {
  // 直接测 store 的 setMessages（SessionView 收到 GET /messages 响应后调它）
  // SessionMessage 形态：message 为 Pi 原生消息（带 role/timestamp），非旧 ChatMessage
  const history: SessionMessage[] = [
    { agentName: undefined, message: { role: "user", content: "历史问题", timestamp: 1 } },
    { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "历史回复" }], model: "pi-test", stopReason: "end_turn", timestamp: 2 } },
  ];
  useSessionStore.getState().setMessages("s1", history);
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  expect(msgs).toHaveLength(2);
  const first = msgs[0].message as any;
  expect(first.role).toBe("user");
  expect(first.content).toBe("历史问题");
});

test("首次进入会话历史未到时显示加载指示，响应到达后消失", async () => {
  const deferred = deferMessages();
  await renderSessionView("s1");
  // 发出 GET /messages 后、历史未到 → 对话区显示 loading
  await screen.findByTestId("history-loading-s1");

  // 模拟 REST 响应：解析延迟的 messages promise
  const history: SessionMessage[] = [
    { agentName: undefined, message: { role: "user", content: "历史问题", timestamp: 1 } },
  ];
  await act(async () => {
    deferred.resolve({ messages: history });
  });

  // 响应到达 → 加载消失、历史消息出现
  await waitFor(() => {
    expect(screen.queryByTestId("history-loading-s1")).toBeNull();
    expect(screen.getByText("历史问题")).toBeTruthy();
  });
  // store 标志同步清掉
  expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(false);
});

test("会话已有消息时进入不显示历史加载（避免刷新闪烁）", async () => {
  // 预置 s1 已有历史消息（模拟再次进入已访问过的会话）
  useSessionStore.getState().setMessages("s1", [
    { agentName: undefined, message: { role: "user", content: "已存在", timestamp: 1 } },
  ]);
  await renderSessionView("s1");
  // 有消息则即便 loading 标志为 true 也不显示加载指示
  await waitFor(() => {
    expect(screen.queryByTestId("history-loading-s1")).toBeNull();
    expect(screen.getByText("已存在")).toBeTruthy();
  });
});

test("运行中时排队消息隐藏「立即」按钮，保留「引导」按钮", async () => {
  useSessionStore.setState({
    statusBySession: { s1: "thinking" },
    queueBySession: { s1: { steering: [], followUp: ["排队消息"] } },
  });
  await renderSessionView("s1");
  expect(screen.getByTestId("btn-promote")).toBeTruthy();
  expect(screen.queryByTestId("btn-immediate")).toBeNull();
});

test("空闲时排队消息显示「立即」按钮", async () => {
  useSessionStore.setState({
    statusBySession: { s1: "idle" },
    queueBySession: { s1: { steering: [], followUp: ["排队消息"] } },
  });
  await renderSessionView("s1");
  expect(screen.getByTestId("btn-immediate")).toBeTruthy();
  expect(screen.getByTestId("btn-promote")).toBeTruthy();
});

test("点击引导按钮发送 steer 请求 + 乐观更新", async () => {
  useSessionStore.setState({
    statusBySession: { s1: "idle" },
    queueBySession: { s1: { steering: [], followUp: ["消息A", "消息B"] } },
  });
  await renderSessionView("s1");

  const btn = screen.getAllByTestId("btn-promote")[0];
  await act(async () => { btn.click(); });

  // API 调用：新版仅发 text，不含 remainingTexts
  const calls = apiCalls.filter(c => c.method === "post" && c.path === "/api/sessions/s1/steer");
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ text: "消息A" });

  // 乐观更新：消息从排队区移到引导区
  const state = useSessionStore.getState();
  expect(state.queueBySession["s1"]!.steering).toContain("消息A");
  expect(state.queueBySession["s1"]!.followUp).toEqual(["消息B"]);
});

test("点击立即按钮发送 steer:immediate 请求", async () => {
  useSessionStore.setState({
    statusBySession: { s1: "idle" },
    queueBySession: { s1: { steering: [], followUp: ["消息A", "消息B"] } },
  });
  await renderSessionView("s1");
  const btn = screen.getAllByTestId("btn-immediate")[0];
  await act(async () => { btn.click(); });
  const calls = apiCalls.filter(c => c.method === "post" && c.path === "/api/sessions/s1/steer/immediate");
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ text: "消息A" });
});

test("点击清空排队按钮立即清空 followUp 列表", async () => {
  useSessionStore.setState({
    statusBySession: { s1: "idle" },
    queueBySession: { s1: { steering: ["引导中消息"], followUp: ["排队1", "排队2"] } },
  });
  await renderSessionView("s1");

  // 清空前：排队消息可见
  expect(screen.getByText("排队 2 条")).toBeTruthy();

  const clearBtn = screen.getByTestId("btn-clear-queue");
  await act(async () => { clearBtn.click(); });

  // 乐观更新：followUp 立即清空，steering 不受影响
  const state = useSessionStore.getState();
  expect(state.queueBySession["s1"]!.followUp).toEqual([]);
  expect(state.queueBySession["s1"]!.steering).toEqual(["引导中消息"]);
});
test("切换会话后思考计时显示对应会话的已思考时长（不重置、不沿用旧会话）", async () => {
  const now = Date.now();
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [
      { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t1", createdAt: 0, lastActivity: 0, piSessionFile: "" },
      { id: "s2", projectId: "p1", primaryAgent: "dev", title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" },
    ],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useSessionStore.setState({
    statusBySession: { s1: "thinking", s2: "thinking" },
    thinkingSinceBySession: { s1: now - 5000, s2: now - 10000 },
  });

  const { rerender } = await renderSessionView("s1");
  // s1 已思考约 5s
  expect(await screen.findByText(/思考中 · (5|6)s/)).toBeTruthy();

  // 切换到 s2：应显示 s2 的约 10s，而不是沿用 s1 的 5s 或重置成 0
  rerender(<SessionView sessionId="s2" />);
  expect(await screen.findByText(/思考中 · (10|11)s/)).toBeTruthy();
});

test("有 pending ask 时渲染 AskDock 且 composer 禁用", async () => {
  // 预置一条带 ask_user_question toolCall 的 assistant 消息（无 toolResult）
  const askCall = { type: "toolCall", id: "tc-ask-1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } };
  const history: SessionMessage[] = [
    { agentName: "dev", message: { role: "assistant", content: [askCall], model: "pi-test", stopReason: "tool_use", timestamp: 1 } as any },
  ];
  useSessionStore.getState().setMessages("s1", history);

  await renderSessionView("s1");
  // dock 渲染
  expect(screen.getByTestId("ask-dock-s1")).toBeTruthy();
  // 表单卡片渲染
  expect(screen.getByTestId("ask-card-tc-ask-1")).toBeTruthy();
  // composer contenteditable 禁用（ask 阻塞）
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')! as HTMLElement;
  expect(textbox.isContentEditable).toBe(false);
});

test("无 pending ask 时不渲染 AskDock", async () => {
  // 预置普通消息（非 ask toolCall）
  const history: SessionMessage[] = [
    { agentName: undefined, message: { role: "user", content: "普通问题", timestamp: 1 } },
  ];
  useSessionStore.getState().setMessages("s1", history);

  await renderSessionView("s1");
  // dock 不存在
  expect(screen.queryByTestId("ask-dock-s1")).toBeNull();
  // composer contenteditable 未禁用
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]')! as HTMLElement;
  expect(textbox.isContentEditable).toBe(true);
});

test("默认工作区会话 header 显示友好文案", async () => {
  // 默认工作区会话：不暴露内部 cwd，显示「默认工作区 · 工作目录」
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
    ],
    sessions: [
      {
        id: "s1", projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev",
        title: "设计海报", createdAt: 1721000000000, lastActivity: Date.now(),
        piSessionFile: "",
      },
    ],
    currentProjectId: SYSTEM_PROJECT_ID, currentSessionId: "s1",
  });
  await renderSessionView("s1");
  // header 显示友好文案，不暴露 /tmp/workdir
  expect(screen.getByText(/默认工作区/)).toBeTruthy();
  expect(screen.getByText(/工作目录/)).toBeTruthy();
  expect(screen.queryByText(/\/tmp\/workdir/)).toBeNull();
});

// === 文件树面板（ExplorerPanel）===
// explorer store 状态在测试间共享，需手动重置
const { useExplorerStore } = await import("../src/store/explorer");

test("header 含文件树按钮，点击后展开右侧面板", async () => {
  useExplorerStore.getState().setOpen(false);
  await renderSessionView("s1");
  expect(screen.getByTestId("btn-explorer")).toBeTruthy();

  // 初始面板收起
  expect(screen.queryByTestId("explorer-aside")).toBeNull();

  // 点击展开
  await act(async () => { fireEvent.click(screen.getByTestId("btn-explorer")); });
  expect(screen.getByTestId("explorer-aside")).toBeTruthy();

  // 再次点击收起
  await act(async () => { fireEvent.click(screen.getByTestId("btn-explorer")); });
  expect(screen.queryByTestId("explorer-aside")).toBeNull();
});

test("普通项目会话 header 仍显示 project.cwd（不回归）", async () => {
  // 普通项目会话：header 显示真实 cwd，差异化逻辑不影响老行为
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 }],
    sessions: [{
      id: "s1", projectId: "p1", primaryAgent: "dev",
      title: "会话", createdAt: 0, lastActivity: Date.now(),
      piSessionFile: "",
    }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  await renderSessionView("s1");
  // 与现有「渲染 header 标题 + 项目目录」测试一致，用 regex 匹配 cwd 子串
  expect(screen.getByText(/\/work\/wa-pi/)).toBeTruthy();
});

test("token 胶囊：有 usage 时显示 ↑↓/累计/缓存", () => {
  useSessionStore.setState({
    lastUsageBySession: { s1: { input: 3200, output: 1100, cacheRead: 1500, cacheWrite: 200 } },
    tokenTotals: { s1: { input: 6400, output: 2100 } },
  });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "/tmp/s1.jsonl" }],
    projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
  });
  render(<SessionView sessionId="s1" />);
  expect(screen.getByTestId("token-capsules")).toBeTruthy();
  expect(screen.getByText(/本轮: ↑3\.2K\/↓1\.1K/)).toBeTruthy();
  expect(screen.getByText(/累计 8\.5K/)).toBeTruthy();
  // cacheRead/(input+cacheRead+cacheWrite) = 1500/(3200+1500+200) ≈ 30.61% → 30.6%
  expect(screen.getByText(/缓存 30\.6%/)).toBeTruthy();
});

test("token 胶囊：有模型时累计胶囊显示进度条", () => {
  // 设置 providers（模型含 contextWindow=128000）
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test",
      api: "openai-completions" as const,
      models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
    }],
  });
  // 设置当前会话的模型选择（与 provider 匹配）
  useComposerPrefsStore.setState({
    bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    defaults: { model: "openai/gpt-4o", thinking: "disabled" },
  });
  // token 累计 8500 / 128000 ≈ 6.64% → 进度条宽度 7%
  useSessionStore.setState({
    lastUsageBySession: { s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 } },
    tokenTotals: { s1: { input: 6400, output: 2100 } },
  });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "/tmp/s1.jsonl" }],
    projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
  });

  render(<SessionView sessionId="s1" />);

  expect(screen.getByTestId("token-capsules")).toBeTruthy();
  // 进度条存在且宽度为 7%（8500/128000 四舍五入）
  const progress = screen.getByTestId("token-progress");
  expect(progress).toBeTruthy();
  const fill = progress.querySelector(".token-progress-fill") as HTMLElement;
  expect(fill.style.width).toBe("7%");
});

test("token 胶囊：无模型时累计胶囊不显示进度条", () => {
  // 不设置 provider 和 model → contextWindow 不可得 → 不显示进度条
  useSessionStore.setState({
    lastUsageBySession: { s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 } },
    tokenTotals: { s1: { input: 6400, output: 2100 } },
  });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "/tmp/s1.jsonl" }],
    projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
  });

  render(<SessionView sessionId="s1" />);

  // 胶囊组仍显示（有 lastUsage），进度条不应存在
  expect(screen.getByTestId("token-capsules")).toBeTruthy();
  expect(screen.getByText(/本轮: ↑3\.2K\/↓1\.1K/)).toBeTruthy();
  expect(screen.queryByTestId("token-progress")).toBeNull();
});

test("token 胶囊：进度条极小占比也有最小可见宽度", () => {
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test",
      api: "openai-completions" as const,
      models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }],
    }],
  });
  useComposerPrefsStore.setState({
    bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    defaults: { model: "openai/gpt-4o", thinking: "disabled" },
  });
  // 累计 100 / 128000 ≈ 0.078%，round 后为 0%
  useSessionStore.setState({
    lastUsageBySession: { s1: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
    tokenTotals: { s1: { input: 100, output: 0 } },
  });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "/tmp/s1.jsonl" }],
    projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
  });

  render(<SessionView sessionId="s1" />);

  expect(screen.getByTestId("token-capsules")).toBeTruthy();
  // 进度条存在且宽度 > 0（有最小可见宽度兜底）
  const progress = screen.getByTestId("token-progress");
  const fill = progress.querySelector(".token-progress-fill") as HTMLElement;
  expect(parseFloat(fill.style.width)).toBeGreaterThan(0);
});

test("token 胶囊：无 usage 时不显示", () => {
  useSessionStore.setState({
    lastUsageBySession: {},
    tokenTotals: {},
  });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "/tmp/s1.jsonl" }],
    projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
  });
  render(<SessionView sessionId="s1" />);
  expect(screen.queryByTestId("token-capsules")).toBeNull();
});
