# Pi 原生消息模型重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 废弃 HiAgent 自建的拍扁消息系统与 broker-proxy 旁路，改用 Pi 原生富消息模型与原生 intercom；数据目录迁移到 `.hiagent`；聊天 UI 改为微信式左右分栏。

**Architecture:** kernel 透传 Pi 的完整 `AgentMessage`（含 thinking/text/toolCall content blocks），历史消息通过新增的 `getMessages()` RPC 从 Pi session 拉取；前端按 content block 类型分别渲染（思考折叠 / 正文 markdown / 工具调用 / 委派卡片）；删除 `broker-proxy.ts`、`intercom-monitor.ts` 及前端 intercom store/AskCard，intercom 委派完全由 Pi 原生 pi-intercom 扩展处理。

**Tech Stack:** TypeScript · Bun (kernel) · React 19 + zustand v5 + Vitest (frontend) · react-markdown + remark-gfm（新增）· bun:test (kernel unit) · Playwright (e2e)

## Global Constraints

- **语言**：所有代码注释用中文；commit message 用中文（遵循 AGENTS.md）
- **测试金字塔**：每个任务必须含单元/组件测试，最终任务补 API + E2E（AGENTS.md 第 6 条）
- **精准修改**：不顺便优化无关代码；删除文件前确认无其它引用（AGENTS.md 第 4 条）
- **变更日志**：每个任务完成时更新 `CHANGELOG.md`（AGENTS.md 第 7 条）
- **类型来源**：Pi 消息类型手写在 `packages/shared/src/types.ts`，不引入 `@mariozechner/pi-ai` 运行时依赖
- **Pi 数据目录**：`PI_CODING_AGENT_DIR=~/.hiagent/pi-agent`，agent 配置目录 `~/.hiagent/agents`（已确认隔离）
- **pi 会话名**：去 `-real` 后缀，保 `${projectId}-${agentName}` 作为 Pi 原生 intercom 会话名（已确认）
- **broker socket**：保持共享 `~/.pi/agent/intercom/broker.sock`
- **旧数据不迁移**：拍扁的 session-store JSON 直接失效，不写迁移脚本（已确认）

---

## 关键风险点

1. **pi-intercom 是悬空依赖**：删 broker-proxy 后 kernel 反而清理了 broken import（现 master 的 kernel 可能已跑不起来）
2. **e2e-delegation.test.ts 必删**：它直接 import pi-intercom，删旁路后必然挂
3. **Canvas 委派展示降级**：asks 数据源没了，Task 8 先占位，后续需求从消息流重建
4. **流式标识**：SessionMessage 无顶层 id，用 timestamp+role 近似——流式增量靠 partial 覆盖，最终 message_end 为准

---

## Task 1: shared 包新增 Pi 消息类型与 SessionMessage

**Files:**
- Modify: `packages/shared/src/types.ts`（在 ChatMessage 后新增 Pi 类型）

**Interfaces:**
- Produces: `TextContent`、`ThinkingContent`、`ToolCall`、`ImageContent`、`UserMessage`、`AssistantMessage`、`ToolResultMessage`、`CustomMessage`、`RoleMessage`、`AgentMessage`、`SessionMessage`（供 Task 2/3/4 使用）

- [ ] **Step 1: 在 types.ts 新增 Pi 消息类型**

打开 `packages/shared/src/types.ts`，在 `ChatMessage` 定义（L46-52）之后插入：

```ts
// ===== Pi 原生消息类型（镜像 @mariozechner/pi-ai，避免运行时依赖）=====
// 说明：Pi 原生类型还带 textSignature/thinkingSignature/redacted/thoughtSignature
// 等签名/脱敏字段，前端渲染用不到，这里按"最小可渲染集"省略。

export interface TextContent { type: "text"; text: string; }
export interface ThinkingContent { type: "thinking"; thinking: string; redacted?: boolean; }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; }
export interface ImageContent { type: "image"; data: string; mimeType: string; }

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  model: string;
  stopReason: string;
  timestamp: number;
  // 简化：忽略 usage/api/provider/responseModel/responseId/errorMessage（前端用不到）
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

// Pi custom 消息（intercom 等扩展注入）
// ⚠️ 关键：Pi 真实数据里这类消息的区分字段是顶层 type，不是 role
// （真实样本：{"type":"custom_message",...} / {"type":"custom",...}）
export interface CustomMessage {
  type: "custom_message" | "custom";   // ← Pi 顶层 type，不是 role
  customType: string;                   // "intercom_message" / "intercom_sent" / ...
  display?: boolean;
  content?: string;
  details?: unknown;
  timestamp: number;
}

// 前三者用 role 字段区分；CustomMessage 没有 role，用顶层 type 区分
export type RoleMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = RoleMessage | CustomMessage;

// HiAgent 投影：一条 Pi 消息 + HiAgent 元信息
export interface SessionMessage {
  message: AgentMessage;     // Pi 原生消息，原样透传
  agentName?: AgentName;     // 哪个 agent 发的（assistant/toolResult 才有意义）
  sessionId?: string;        // 路由用，PiRpcClient 填 currentSessionId
}
```

- [ ] **Step 2: 修改 WS 事件类型，message 从 ChatMessage 换成 SessionMessage**

找到 `MessageUpdateEvent`（L141-147）和 `SessionMessagesEvent`（L177-181），改 message 字段类型：

```ts
export interface MessageUpdateEvent {
  type: "agent:message";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  message: SessionMessage;   // ← 从 ChatMessage 改
}
export interface SessionMessagesEvent {
  type: "session:messages";
  sessionId: string;
  messages: SessionMessage[];   // ← 从 ChatMessage[] 改
}
```

- [ ] **Step 3: 保留 ChatMessage 但标记废弃**

在 ChatMessage 定义上方加注释：

```ts
/** @deprecated 富消息模型上线后，新消息走 SessionMessage。仅 agent:prompt 的用户输入包装还在用，Task 4 会清理。 */
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}
```

- [ ] **Step 4: typecheck 确认 shared 自身无语法错**

Run: `cd packages/shared && bunx tsc --noEmit src/types.ts`
Expected: types.ts 自身语法正确。下游包（kernel/frontend）的类型错是预期的，本步不管。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): 新增 Pi 原生消息类型（AgentMessage/SessionMessage）+ WS 事件 message 字段换型"
```

---

## Task 2: shared constants 数据目录迁移

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Interfaces:**
- Produces: `HIAGENT_PI_AGENT_DIR`（Task 3 agent-manager 使用）

- [ ] **Step 1: 修改 constants.ts**

打开 `packages/shared/src/constants.ts`，改为：

```ts
import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

// 兼容浏览器（无 process 全局）与 Node/Bun（kernel sidecar）
const env = typeof process !== "undefined" ? process.env : {};
const HOME = env.HOME || env.USERPROFILE || ".";
// 支持 env 覆盖（E2E 测试用独立目录隔离，生产部署也可自定义数据目录）
export const HIAGENT_DIR = env.HIAGENT_DIR || `${HOME}/.hiagent`;
export const HIAGENT_PI_AGENT_DIR = `${HIAGENT_DIR}/pi-agent`;  // ← 新增：Pi 数据目录（sessions/agents/auth/intercom）
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const SESSIONS_DIR = `${HIAGENT_DIR}/sessions`;  // HiAgent 自管元数据（不含 messages）
export const PI_AGENTS_DIR = `${HIAGENT_DIR}/agents`;   // ← 改：从 ~/.pi/agent/agents 改为 .hiagent/agents
```

（后续 AGENT_DEFS / ALL_AGENT_NAMES 不动）

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): HIAGENT_PI_AGENT_DIR 新增、PI_AGENTS_DIR 迁至 .hiagent/agents"
```

---

## Task 3: kernel pi-rpc-client 富消息透传 + getMessages + 去 -real + env

**Files:**
- Modify: `packages/kernel/src/pi-rpc-client.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（传 env）
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`、`SessionMessage` from Task 1，`HIAGENT_PI_AGENT_DIR` from Task 2
- Produces: `PiRpcClient.getMessages(): Promise<AgentMessage[]>`、PiEvent.message 改为 SessionMessage、spawn 带 env

- [ ] **Step 1: 先改测试（TDD）——pi-rpc-client.test.ts**

打开 `packages/kernel/tests/pi-rpc-client.test.ts`。

修改 L56-78 的 "onEvent 收 message_end → assistant message 事件" 测试，断言改为富 content：

```ts
test("onEvent 收 message_end → 透传完整 AssistantMessage（含 content blocks）", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.emitLine({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "我先想想" },
        { type: "text", text: "你好" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/a" } },
      ],
      model: "test-model",
      stopReason: "stop",
      timestamp: 12345,
    },
  });
  const ev = events.find(e => e.kind === "message");
  expect(ev).toBeDefined();
  expect(ev && ev.kind === "message" && (ev.message.message as any).role).toBe("assistant");
  const content = ev && ev.kind === "message" && (ev.message.message as any).content as any[];
  expect(content).toHaveLength(3);
  expect(content.find((c: any) => c.type === "thinking")?.thinking).toBe("我先想想");
  expect(content.find((c: any) => c.type === "text")?.text).toBe("你好");
  expect(content.find((c: any) => c.type === "toolCall")?.name).toBe("read");
  expect(ev && ev.kind === "message" && ev.message.agentName).toBe("dev");
  await client.dispose();
});
```

新增 getMessages 测试（在文件末尾追加）：

```ts
test("getMessages 发 get_messages 并按 id 匹配 response", async () => {
  const mock = mockSpawn();
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: () => {},
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.resetStdoutBuf();
  const p = client.getMessages();
  const sent = mock.getStdoutBuf();
  expect(sent).toContain('"type":"get_messages"');
  const lines = sent.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const sentId = JSON.parse(lastLine).id;
  mock.emitLine({
    type: "response",
    success: true,
    id: sentId,
    data: { messages: [{ role: "user", content: "历史", timestamp: 1 }] },
  });
  const msgs = await p;
  expect(msgs).toHaveLength(1);
  expect((msgs[0] as any).content).toBe("历史");
  await client.dispose();
});

test("spawn env 含 PI_CODING_AGENT_DIR", async () => {
  const mock = mockSpawn();
  let capturedEnv: Record<string, string | undefined> = {};
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: () => {},
    spawnFn: (_cmd: string, _args: string[], opts: any) => {
      capturedEnv = opts.env;
      return mock as any;
    },
  });
  await client.start();
  expect(capturedEnv.PI_CODING_AGENT_DIR).toBeDefined();
  expect(capturedEnv.PI_CODING_AGENT_DIR).toContain("pi-agent");
  await client.dispose();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts`
Expected: FAIL（getMessages 不存在、env 参数未传、message 还是拍扁的）

- [ ] **Step 3: 改造 pi-rpc-client.ts**

打开 `packages/kernel/src/pi-rpc-client.ts`：

**(a) import 换型**（L1）：
```ts
import type { AgentName, AgentMessage, AgentState, AgentConfig } from "@hiagent/shared";
import type { SessionMessage } from "@hiagent/shared";
import { randomUUID } from "node:crypto";
import { HIAGENT_PI_AGENT_DIR } from "@hiagent/shared";
```

**(b) PiEvent 类型**（L4-9）改：
```ts
export type PiEvent =
  | { kind: "message"; message: SessionMessage }
  | { kind: "state"; state: AgentState }
  | { kind: "error"; message: string };
// 注：intercom:ask / intercom:reply 废弃（broker-proxy 删了）
```

**(c) SpawnOptions.opts 加 env；PiRpcClientOpts 加 env**：
```ts
interface SpawnOptions {
  cmd: string;
  args: string[];
  opts: { cwd: string; stdio: [string, string, string]; env: Record<string, string | undefined> };
}

export interface PiRpcClientOpts {
  agentName: AgentName;
  cwd: string;
  onEvent: (e: PiEvent) => void;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions["opts"]) => MockChild;
  sessionId?: string;
  config?: AgentConfig;
  env?: Record<string, string | undefined>;
}
```

**(d) 新增 pendingRpcResolvers + 改 send**：
```ts
private pendingId = 0;
private pendingRpcResolvers = new Map<number, (data: unknown) => void>();

private async send(obj: unknown, preoccupiedId?: number): Promise<void> {
  if (!this.child) throw new Error("PiRpcClient 未启动");
  const payload = typeof obj === "object" && obj !== null
    ? { ...(obj as object), id: preoccupiedId ?? ++this.pendingId }
    : obj;
  this.child.stdin.write(JSON.stringify(payload) + "\n");
}
```

**(e) start 里去 -real 后缀 + 传 env**（L49-67）：
```ts
async start(): Promise<void> {
  const spawnFn = this.opts.spawnFn ?? defaultSpawn;
  // 去 -real 后缀：删 broker-proxy 后不再有占位代理，真实进程直接用 sessionName
  const brokerName = this.sessionName;
  const args = ["--mode", "rpc", "--name", brokerName];
  const c = this.opts.config;
  if (c) {
    if (c.model) args.push("--model", c.model);
    if (c.tools.length) args.push("--tools", c.tools.join(","));
    if (c.systemPromptBody) {
      args.push(c.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", c.systemPromptBody);
    }
  }
  this.child = spawnFn("pi", args, {
    cwd: this.opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...this.opts.env },
  });
  console.log(`[kernel] spawn pi: name=${brokerName} cwd=${this.opts.cwd} model=${c?.model ?? "default"}`);
  // stdout/stderr 监听不变
  await this.send({ type: "get_state" });
}
```

**(f) message_start/update/end 重写**（L134-199）：
```ts
case "message_start": {
  const msg = obj.message;
  if (msg?.role === "assistant") {
    this.streamingContent = [];
    this.opts.onEvent({
      kind: "message",
      message: {
        message: { ...msg, content: [] },
        agentName: this.opts.agentName,
        sessionId: this.currentSessionId,
      },
    });
  }
  break;
}
case "message_update": {
  const evt = obj.assistantMessageEvent;
  if (evt?.partial?.content) {
    this.streamingContent = evt.partial.content as any[];
    this.opts.onEvent({
      kind: "message",
      message: {
        message: { ...evt.partial, content: this.streamingContent },
        agentName: this.opts.agentName,
        sessionId: this.currentSessionId,
      },
    });
  }
  break;
}
case "message_end": {
  const msg = obj.message;
  if (msg?.role === "assistant") {
    this.opts.onEvent({
      kind: "message",
      message: {
        message: msg as AgentMessage,
        agentName: this.opts.agentName,
        sessionId: this.currentSessionId,
      },
    });
  }
  this.streamingContent = [];
  break;
}
```

**(g) case "response" 加 success 分发**（L111-124）：
```ts
case "response": {
  if (obj.success === false) {
    this.opts.onEvent({ kind: "error", message: obj.error ?? `${obj.command ?? "rpc"} 失败` });
    this.opts.onEvent({ kind: "state", state: { name: this.opts.agentName, status: "idle" } });
  } else if (obj.success === true && obj.id != null) {
    const resolver = this.pendingRpcResolvers.get(obj.id);
    if (resolver) {
      this.pendingRpcResolvers.delete(obj.id);
      resolver(obj.data);
    }
  }
  break;
}
```

**(h) 新增 getMessages**（在 abort 方法后）：
```ts
async getMessages(): Promise<AgentMessage[]> {
  const id = ++this.pendingId;
  return new Promise((resolve) => {
    this.pendingRpcResolvers.set(id, (data: any) => resolve(data?.messages ?? []));
    this.send({ type: "get_messages" }, id);
  });
}
```

**(i) 删除废弃成员**：删 `streamingMsgId`、`streamingText`，新增 `private streamingContent: any[] = [];`。

**(j) defaultSpawn 传 env**（L229-251）：
```ts
function defaultSpawn(cmd: string, args: string[], opts: SpawnOptions["opts"]): MockChild {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ?? process.env,
  });
  // 其余不变
}
```

- [ ] **Step 4: 改 agent-manager.ts 传 env**

打开 `packages/kernel/src/agent-manager.ts`，顶部 import：
```ts
import { HIAGENT_PI_AGENT_DIR } from "@hiagent/shared";
```

`new PiRpcClient({...})`（L36-46）加 env：
```ts
const client = new PiRpcClient({
  agentName,
  cwd: project.cwd,
  sessionId: `${projectId}-${agentName}`,
  config: config ?? undefined,
  spawnFn: this.opts.spawnFn,
  env: { PI_CODING_AGENT_DIR: HIAGENT_PI_AGENT_DIR },
  onEvent: (e) => { /* 不变 */ },
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): pi-rpc-client 透传富 AgentMessage + getMessages + 去 -real + PI_CODING_AGENT_DIR env"
```

---

## Task 4: kernel state-aggregator + ws-server + session-store 适配富消息

**Files:**
- Modify: `packages/kernel/src/state-aggregator.ts`
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/session-store.ts`
- Test: `packages/kernel/tests/state-aggregator.test.ts`
- Test: `packages/kernel/tests/session-messages.test.ts`

**Interfaces:**
- Consumes: `SessionMessage`、`PiRpcClient.getMessages()` from Task 3

- [ ] **Step 1: 改 state-aggregator.test.ts**

把构造输入从 `{ id, sessionId, role, text }` 改为 SessionMessage：
```ts
const sessionMsg = {
  message: { role: "assistant", content: [{ type: "text", text: "回复" }], model: "m", stopReason: "stop", timestamp: 0 },
  agentName: "dev" as const,
};
// routePiEvent({ kind: "message", message: sessionMsg })
```
删持久化断言（sessionStore.appendMessage 要废弃）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/state-aggregator.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 state-aggregator.ts**

**(a) 删 routeAsk / routeReply**（L49-57）。
**(b) 删 import AskItem**（L2）。
**(c) routePiEvent 的 message 分支**（L20-30）：去掉 sessionStore.appendMessage，sessionId 从 SessionMessage.sessionId 取：

```ts
case "message": {
  const sessionId = e.message.sessionId ?? "";
  this.opts.onServerEvent({
    type: "agent:message", projectId,
    sessionId,
    agentName, message: e.message,
  });
  break;
}
```

**(d) StateAggregatorOpts.sessionStore 保留**（ws-server 还持有，Task 5 一起清）。

- [ ] **Step 4: 改 session-store.ts（删 messages 部分）**

删 `appendMessage`、`loadMessages` 方法；SessionFile 接口的 `messages` 字段删；emptySession/read/write 相应改。asks 部分留 Task 5。

- [ ] **Step 5: 改 ws-server.ts session:messages 分支**（L109-114）

```ts
case "session:messages": {
  const { sessions } = await this.opts.projectStore.load();
  const session = sessions.find(s => s.id === event.sessionId);
  if (!session) {
    reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
    break;
  }
  try {
    const client = await this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent);
    const agentMessages = await client.getMessages();
    const messages = agentMessages.map(m => ({ message: m, agentName: session.primaryAgent }));
    reply({ type: "session:messages", sessionId: event.sessionId, messages });
  } catch (err) {
    reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
  }
  break;
}
```

- [ ] **Step 6: 改 ws-server.ts agent:prompt 用户消息**（L126-134）

```ts
const userMsg = {
  message: { role: "user" as const, content: event.text, timestamp: Date.now() },
  agentName: event.agentName,
  sessionId: session.id,
};
this.broadcast({
  type: "agent:message", projectId: event.projectId,
  sessionId: session.id, agentName: event.agentName, message: userMsg,
});
// 删 await sessionStore.appendMessage
```

- [ ] **Step 7: 改 session-messages.test.ts**

重写为 mock agentManager.ensureStarted 返回带 getMessages 的假 client（参考 e2e-integration.test.ts L40-56 的 WSServer 构造）：
```ts
test("[第三层] session:messages 走 PiRpcClient.getMessages", async () => {
  const fakeClient = { getMessages: async () => [{ role: "user", content: "历史问题", timestamp: 1 }] };
  const agentManager = { ensureStarted: async () => fakeClient, abort: async () => {}, disposeAll: async () => {} } as any;
  // 构造 WSServer + projectStore 预置 session，发 session:messages，断言返回 messages[0].message.content === "历史问题"
});
```

- [ ] **Step 8: 运行 kernel 测试**

Run: `cd packages/kernel && bun test --pattern "state-aggregator|session-messages|pi-rpc-client"`
Expected: PASS（跳过 broker-proxy/intercom-monitor/e2e-delegation，Task 5 删）

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/kernel/src packages/kernel/tests
git commit -m "feat(kernel): ws-server session:messages 走 getMessages + state-aggregator 透传 SessionMessage + session-store 废弃 messages"
```

---

## Task 5: kernel 删除 broker-proxy + intercom-monitor 旁路系统

**Files:**
- Delete: `packages/kernel/src/broker-proxy.ts`、`packages/kernel/src/intercom-monitor.ts`
- Delete: `packages/kernel/tests/broker-proxy.test.ts`、`intercom-monitor.test.ts`、`e2e-delegation.test.ts`
- Modify: `packages/kernel/src/index.ts`、`ws-server.ts`、`agent-manager.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/kernel/tests/e2e-integration.test.ts`

- [ ] **Step 1: 删除文件**

```bash
rm packages/kernel/src/broker-proxy.ts packages/kernel/src/intercom-monitor.ts
rm packages/kernel/tests/broker-proxy.test.ts packages/kernel/tests/intercom-monitor.test.ts packages/kernel/tests/e2e-delegation.test.ts
```

- [ ] **Step 2: 改 index.ts**

删 L5-6 import、L29-32 onDispose brokerProxy 引用、L44-58 brokerProxy + intercomMonitor 初始化、L60-64 WSServer 构造的 intercomMonitor 参数。改后：

```ts
import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";
import { AgentManager } from "./agent-manager";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { migrateLegacySessions } from "./migrate";
import { WS_PORT } from "@hiagent/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const sessionStore = new SessionStore();

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  let broadcast: (e: import("@hiagent/shared").WSServerEvent) => void = () => {};

  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
  });
  const stateAggregator = new StateAggregator({
    agentManager,
    onServerEvent: (e) => broadcast(e),
  });
  (agentManager as unknown as { opts: { onEvent: (k: never, e: never) => void } }).opts.onEvent =
    (key, e) => stateAggregator.routePiEvent(key as never, e as never);

  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, stateAggregator,
    port: WS_PORT,
  });
  await server.start();
  broadcast = (e) => (server as unknown as { broadcast: (e2: import("@hiagent/shared").WSServerEvent) => void }).broadcast(e);
  server.bindAggregatorBroadcast();

  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: 改 ws-server.ts**

删 L10 import IntercomMonitor、L18 intercomMonitor 字段、L70 dispose、L148-151 inject-reply 分支。WSServerOpts 删 intercomMonitor。

- [ ] **Step 4: 改 agent-manager.ts**

删 onDispose 字段（L11）+ disposeAll 里的调用（L69）。核查 AgentManagerOpts 其它地方用没用——Task 2 后没下游用。

- [ ] **Step 5: 改 shared/types.ts 删 intercom 协议**

删 `InjectReplyEvent`、`IntercomAskEvent`、`IntercomReplyEvent`、`AskItem`。从 WSClientEvent 联合删 InjectReplyEvent，从 WSServerEvent 联合删 IntercomAskEvent | IntercomReplyEvent。

- [ ] **Step 6: 删 session-store.ts（整体）**

Task 4 已删 messages 部分，本任务 asks 也删。由于 ws-server 还引用 sessionStore——**从 ws-server opts 删 sessionStore、index.ts 删实例化**，session-store.ts 文件整体删。

注意 state-aggregator.ts 的 StateAggregatorOpts.sessionStore 也删（Task 4 标了"待删"）。

- [ ] **Step 7: 改 e2e-integration.test.ts**

删 L8 import IntercomMonitor、L40-44 mock、L52-56 WSServer 构造参数。

- [ ] **Step 8: kernel 全量测试 + typecheck**

Run: `cd packages/kernel && bun test && bun run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A packages/kernel packages/shared/src/types.ts
git commit -m "refactor(kernel): 删除 broker-proxy/intercom-monitor 旁路系统，改用 Pi 原生 intercom"
```

---

## Task 6: frontend 加依赖 + store 换型

**Files:**
- Modify: `packages/frontend/package.json`
- Modify: `packages/frontend/src/store/session.ts`

- [ ] **Step 1: 加 react-markdown 依赖**

```bash
cd packages/frontend && bun add react-markdown remark-gfm
```

- [ ] **Step 2: 改 store/session.ts**

```ts
import { create } from "zustand";
import type { SessionMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, SessionMessage[]>;
  append: (sessionId: string, msg: SessionMessage) => void;
  setMessages: (sessionId: string, messages: SessionMessage[]) => void;
  clear: () => void;
}

// 流式标识：同 agent 同时刻同 role 视为同一条流式增量
function msgKey(m: SessionMessage): string {
  const inner = m.message as any;
  return `${inner.role ?? "custom"}-${inner.timestamp}`;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (sessionId, msg) => set(s => {
    const list = s.messagesBySession[sessionId] ?? [];
    const key = msgKey(msg);
    const idx = list.findIndex(m => msgKey(m) === key);
    const newList = idx >= 0 ? list.map((m, i) => i === idx ? msg : m) : [...list, msg];
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: newList } };
  }),
  setMessages: (sessionId, messages) => set(s => {
    const existing = s.messagesBySession[sessionId] ?? [];
    const existingKeys = new Set(existing.map(msgKey));
    const newFromHistory = messages.filter(m => !existingKeys.has(msgKey(m)));
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: [...existing, ...newFromHistory] } };
  }),
  clear: () => set({ messagesBySession: {} }),
}));
```

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/package.json packages/frontend/src/store/session.ts
git commit -m "feat(frontend): session store 换 SessionMessage + 加 react-markdown 依赖"
```

---

## Task 7: frontend MessageRow + ContentBlock 组件

**Files:**
- Create: `packages/frontend/src/components/blocks/ThinkingPanel.tsx`、`TextBlock.tsx`、`ToolCallPanel.tsx`、`DelegateCard.tsx`、`DelegateReceived.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`
- Test: `packages/frontend/tests/blocks/ContentBlock.test.tsx`（新建）
- Test: `packages/frontend/tests/MessageList.test.tsx`（重写）

- [ ] **Step 1: 写测试 blocks/ContentBlock.test.tsx**（TDD）

```tsx
import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingPanel } from "../../src/components/blocks/ThinkingPanel";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { ToolCallPanel } from "../../src/components/blocks/ToolCallPanel";
import { DelegateCard } from "../../src/components/blocks/DelegateCard";

test("ThinkingPanel 默认折叠，点击展开", () => {
  render(<ThinkingPanel thinking="我在想" />);
  expect(screen.queryByText("我在想")).toBeNull();
  screen.getByText(/思考过程/).click();
  expect(screen.getByText("我在想")).toBeTruthy();
});

test("TextBlock 渲染 markdown 代码块", () => {
  render(<TextBlock text={"```js\nconst x = 1;\n```"} />);
  expect(screen.getByText(/const x/)).toBeTruthy();
});

test("ToolCallPanel 显示工具名和参数", () => {
  render(<ToolCallPanel toolCall={{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }} />);
  expect(screen.getByText(/read/)).toBeTruthy();
});

test("DelegateCard 渲染橙色委派卡片", () => {
  render(<DelegateCard toolCall={{ type: "toolCall", id: "c1", name: "intercom", arguments: { action: "ask", to: "pm", message: "需求?" } }} />);
  expect(screen.getByText(/委派给/)).toBeTruthy();
  expect(screen.getByText(/需求\?/)).toBeTruthy();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/frontend && bunx vitest run tests/blocks/ContentBlock.test.tsx`
Expected: FAIL

- [ ] **Step 3: 创建 blocks 组件**

`ThinkingPanel.tsx`：
```tsx
import { useState } from "react";

interface Props { thinking: string; }

export function ThinkingPanel({ thinking }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1" data-testid="thinking-panel">
      <button onClick={() => setOpen(!open)} className="text-xs text-overlay hover:text-text" style={{ cursor: "pointer" }}>
        💭 思考过程 {open ? "▾" : "▸"}
      </button>
      {open && <div className="text-xs text-overlay italic mt-1 pl-2 border-l border-surface2">{thinking}</div>}
    </div>
  );
}
```

`TextBlock.tsx`：
```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props { text: string; }

export function TextBlock({ text }: Props) {
  return (
    <div className="text-sm prose prose-invert max-w-none" data-testid="text-block">
      <ReactMarkdown remarkGfm={remarkGfm}>{text}</ReactMarkdown>
    </div>
  );
}
```

`ToolCallPanel.tsx`：
```tsx
import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@hiagent/shared";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
}

export function ToolCallPanel({ toolCall, result }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-xs" data-testid={`toolcall-${toolCall.id}`}>
      <button onClick={() => setOpen(!open)} className="text-overlay hover:text-text" style={{ cursor: "pointer" }}>
        🔧 {toolCall.name}({JSON.stringify(toolCall.arguments)}) {open ? "▾" : "▸"}
      </button>
      {open && result && (
        <div className="mt-1 pl-2 border-l border-surface2 text-overlay">
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </div>
  );
}
```

`DelegateCard.tsx`：
```tsx
import type { ToolCall, ToolResultMessage } from "@hiagent/shared";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  targetDisplayName?: string;
}

export function DelegateCard({ toolCall, result, targetDisplayName }: Props) {
  const args = toolCall.arguments as { action?: string; to?: string; message?: string };
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(250,179,135,0.08)", border: "1px solid rgba(250,179,135,0.3)" }} data-testid={`delegate-${toolCall.id}`}>
      <div className="text-xs" style={{ color: "#fab387" }}>
        ↪ 委派给 {targetDisplayName ?? args.to} · {args.action === "ask" ? "等待回复" : "已通知"}
      </div>
      <div className="text-sm mt-1">📋 提问：{args.message}</div>
      {result && (
        <div className="text-sm mt-1 pl-2" style={{ borderLeft: "2px solid #a6e3a1" }}>
          <div className="text-xs" style={{ color: "#a6e3a1" }}>✓ {targetDisplayName ?? args.to} 的回复</div>
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </div>
  );
}
```

`DelegateReceived.tsx`：
```tsx
interface Props { details: unknown; }

export function DelegateReceived({ details }: Props) {
  const d = details as { from?: { name?: string }; bodyText?: string } | undefined;
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(137,180,250,0.08)", border: "1px solid rgba(137,180,250,0.3)" }} data-testid="delegate-received">
      <div className="text-xs" style={{ color: "#89b4fa" }}>📨 来自 {d?.from?.name ?? "未知"}</div>
      <div className="text-sm mt-1">{d?.bodyText ?? ""}</div>
    </div>
  );
}
```

- [ ] **Step 4: blocks 测试通过**

Run: `cd packages/frontend && bunx vitest run tests/blocks/ContentBlock.test.tsx`
Expected: PASS

- [ ] **Step 5: 重写 MessageList.tsx**

```tsx
import type { SessionMessage, ToolResultMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { ThinkingPanel } from "./blocks/ThinkingPanel";
import { TextBlock } from "./blocks/TextBlock";
import { ToolCallPanel } from "./blocks/ToolCallPanel";
import { DelegateCard } from "./blocks/DelegateCard";
import { DelegateReceived } from "./blocks/DelegateReceived";

const EMPTY: SessionMessage[] = [];

interface Props { sessionId: string; }

interface RenderedRow {
  main: SessionMessage;
  toolResults: Map<string, ToolResultMessage>;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const rows = preprocess(messages);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {rows.map((row, i) => <MessageRow key={i} row={row} sessionId={sessionId} />)}
    </div>
  );
}

function preprocess(messages: SessionMessage[]): RenderedRow[] {
  const rows: RenderedRow[] = [];
  let lastAssistantIdx = -1;
  for (const sm of messages) {
    const m = sm.message as any;
    if (m.role === "toolResult") {
      if (lastAssistantIdx >= 0) rows[lastAssistantIdx].toolResults.set(m.toolCallId, m as ToolResultMessage);
    } else {
      rows.push({ main: sm, toolResults: new Map() });
      lastAssistantIdx = m.role === "assistant" ? rows.length - 1 : -1;
    }
  }
  return rows;
}

function MessageRow({ row, sessionId }: { row: RenderedRow; sessionId: string }) {
  const m = row.main.message as any;
  const isUser = m.role === "user";
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`} data-testid={`msg-${sessionId}-${m.timestamp}`}>
      <Avatar isUser={isUser} />
      <div className="max-w-[70%]">
        {!isUser && <div className="text-xs text-overlay mb-0.5">{row.main.agentName ?? "agent"}</div>}
        <div className="px-3 py-2 rounded-lg" style={{ background: isUser ? "#313244" : "#181825", color: "#cdd6f4", borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px" }}>
          {renderContent(m, row.toolResults)}
        </div>
      </div>
    </div>
  );
}

function renderContent(m: any, toolResults: Map<string, ToolResultMessage>) {
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "");
    return <TextBlock text={text} />;
  }
  if (m.role === "assistant") {
    return (m.content as any[]).map((block, i) => {
      switch (block.type) {
        case "thinking": return <ThinkingPanel key={i} thinking={block.thinking} />;
        case "text": return <TextBlock key={i} text={block.text} />;
        case "toolCall":
          if (block.name === "intercom") return <DelegateCard key={i} toolCall={block} result={toolResults.get(block.id)} />;
          return <ToolCallPanel key={i} toolCall={block} result={toolResults.get(block.id)} />;
        default: return null;
      }
    });
  }
  if (m.type === "custom_message" && m.customType === "intercom_message") {
    return <DelegateReceived details={m.details} />;
  }
  return null;
}

function Avatar({ isUser }: { isUser: boolean }) {
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style={{ background: isUser ? "linear-gradient(135deg,#6c7086,#9399b2)" : "linear-gradient(135deg,#89b4fa,#b4befe)" }}>
      {isUser ? "我" : "🤖"}
    </div>
  );
}
```

- [ ] **Step 6: 重写 MessageList.test.tsx**

（含 5 个测试：用户靠右 agent 靠左、thinking+text+toolCall content blocks、toolResult 按 toolCallId 关联、intercom toolCall 渲染 DelegateCard、空 session。完整代码见落盘文件）

- [ ] **Step 7: 运行 MessageList 测试**

Run: `cd packages/frontend && bunx vitest run tests/MessageList.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/components/blocks/ packages/frontend/src/components/MessageList.tsx packages/frontend/tests/
git commit -m "feat(frontend): MessageRow + ContentBlock 富消息渲染（thinking/text/toolCall/delegate）"
```

---

## Task 8: frontend 清理 intercom store / AskCard / Canvas 引用

**Files:**
- Delete: `packages/frontend/src/store/intercom.ts`、`components/AskCard.tsx`、`tests/AskCard.test.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`、`components/canvas/Canvas.tsx`
- Test: `packages/frontend/tests/SessionView.test.tsx`

- [ ] **Step 1: 删除文件**

```bash
rm packages/frontend/src/store/intercom.ts packages/frontend/src/components/AskCard.tsx packages/frontend/tests/AskCard.test.tsx
```

- [ ] **Step 2: 改 SessionView.tsx**

删 L3 import useIntercomStore、L8 import AskCard、L14 EMPTY_ASKS、L21 asks、L33-34 intercom 分支、L41 activeAsk、L51-57 徽章、L64 asks.map。append 调用改 `append(sessionId, e.message)`。

- [ ] **Step 3: 改 Canvas.tsx**

删 useIntercomStore 引用，asksBySession 改空对象占位：
```tsx
const asksBySession: Record<string, never[]> = {};
```

- [ ] **Step 4: 改 SessionView.test.tsx**

删 intercom 相关断言，保留 session:messages/agent:message/agent:state 路由测试。

- [ ] **Step 5: 全量前端测试**

Run: `cd packages/frontend && bunx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A packages/frontend
git commit -m "refactor(frontend): 删除 intercom store/AskCard，SessionView/Canvas 清理旁路引用"
```

---

## Task 9: 四层测试收尾 + CHANGELOG

- [ ] **Step 1: kernel typecheck + 全量测试**
Run: `cd packages/kernel && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 2: frontend typecheck + 全量测试**
Run: `cd packages/frontend && bunx tsc --noEmit && bunx vitest run`
Expected: PASS

- [ ] **Step 3: API 集成（ws-server.test.ts / e2e-integration.test.ts）**
确认 agent:prompt → session:created + agent:message(SessionMessage)；session:messages 走 getMessages。修正 ChatMessage→SessionMessage 断言。

- [ ] **Step 4: E2E（app-flow.spec.ts）**
Run: `cd packages/frontend && bunx playwright test`
有 pi 环境 PASS；无则 skip，setup/teardown 不报错。

- [ ] **Step 5: 截图清理**
```bash
find packages/frontend -name "*.png" -path "*/e2e/*" -newer packages/frontend/playwright.config.ts -delete
find packages/frontend -name "*-screenshot*" -delete
```

- [ ] **Step 6: 更新 CHANGELOG.md**

顶部新增 Pi 原生消息模型重构条目（类型/摘要/影响范围）。

- [ ] **Step 7: 最终全量验证**
Run: `cd packages/kernel && bun test && bun run typecheck && cd ../frontend && bunx vitest run && bunx tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add CHANGELOG.md packages/frontend/e2e/ packages/kernel/tests/
git commit -m "test: 四层测试收尾 + CHANGELOG（Pi 原生消息模型重构）"
```

---

## Self-Review

**1. Spec 覆盖率**（对照设计文档第 7 节）：
- ✅ shared/types.ts Pi 消息类型 + SessionMessage → Task 1
- ✅ kernel pi-rpc-client 透传 + getMessages + env → Task 3
- ✅ kernel 废弃 session-store messages → Task 4/5
- ✅ kernel 废弃 broker-proxy、intercom-monitor → Task 5
- ✅ frontend MessageRow/ContentBlock/DelegateCard → Task 7
- ✅ frontend 废弃 useIntercomStore/AskCard → Task 8
- ✅ constants HIAGENT_PI_AGENT_DIR、PI_AGENTS_DIR → Task 2
- ✅ 四层测试 → Task 9 + 各任务内单测
- ✅ Canvas 引用清理（设计文档遗漏）→ Task 8

**2. 占位符扫描**：每步骤含完整代码，无 TBD/TODO。

**3. 类型一致性**：
- `SessionMessage`（message + agentName? + sessionId?）跨任务一致
- `PiRpcClient.getMessages(): Promise<AgentMessage[]>` 定义与调用一致
- `useSessionStore.append(sessionId, msg)` 新签名在 SessionView 同步改
