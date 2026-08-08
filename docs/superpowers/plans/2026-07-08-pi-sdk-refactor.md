# Pi SDK 模式重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WaPi kernel 从 spawn `pi --mode rpc` 子进程 + JSON-RPC 协议改为同进程 `createAgentSession` SDK 直连，前端 WS 事件全量对齐 SDK 原生事件。

**Architecture:** AgentManager 用 `Map<sessionId, AgentSession>` 管理多会话，每会话 `createAgentSession` + `subscribe` 直连 SDK，事件用 `sdk:event` 信封全量透传前端。删除 pi-rpc-client.ts 和 state-aggregator.ts。

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-coding-agent@0.80.3` SDK (createAgentSession/SessionManager/DefaultResourceLoader/AuthStorage/ModelRegistry), React, Vitest, Playwright

## Global Constraints

- 所有回复和注释使用中文
- `@earendil-works/pi-coding-agent` 版本 `^0.80.0`（当前 0.80.3 已是最高）
- SDK 的 `agentDir` 统一用 `~/.wa-pi/`（即 `WA_PI_DIR`），不再有 `pi-agent` 子目录
- 会话 jsonl 路径：`~/.wa-pi/sessions/<sessionId>.jsonl`
- pi-intercom 会话名格式：`${projectId}-${agentName}-${sessionId}`
- 旧消息历史不兼容，干净切换（projects.json 元数据保留）
- 四层测试全部通过才算完成
- 每个任务完成后更新 `CHANGELOG.md`

**设计文档：** `docs/superpowers/specs/2026-07-08-pi-sdk-refactor-design.md`

---

## Task 1: shared/types.ts — 删除废弃类型，新增 SDK 事件类型

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/types.ts`（类型变更，通过 tsc 验证）

**Interfaces:**
- Produces: `AssistantMessageEvent`、`SDKEvent`、`SDKEventEnvelope` 类型供后续任务使用
- Removes: `ChatMessage`、`PiEvent`（kernel 内部随 pi-rpc-client 删除）、`MessageUpdateEvent`、`StateChangeEvent`

- [ ] **Step 1: 删除废弃类型**

在 `packages/shared/src/types.ts` 中删除以下类型定义：
- `ChatMessage` 接口（约 46-53 行，含 `@deprecated` 注释）
- `MessageUpdateEvent` 接口（约 186-192 行）
- `StateChangeEvent` 接口（约 193-198 行）

- [ ] **Step 2: 新增 AssistantMessageEvent 类型**

在 `packages/shared/src/types.ts` 的 `AgentMessage` 类型定义之后，新增：

```typescript
// 镜像 @earendil-works/pi-ai AssistantMessageEvent（流式增量事件）
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

- [ ] **Step 3: 新增 SDKEvent 和 SDKEventEnvelope 类型**

在 `packages/shared/src/types.ts` 的 WS 事件协议区域，新增：

```typescript
// 镜像 SDK AgentSessionEvent 联合类型，作为 WS 透传事件
export type SDKEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// WS 事件信封：包裹 sessionId 上下文，原始 SDK 事件原样透传
export interface SDKEventEnvelope {
  type: "sdk:event";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  event: SDKEvent;
}
```

- [ ] **Step 4: 更新 WSServerEvent 联合类型**

将 `WSServerEvent` 联合类型中的 `MessageUpdateEvent | StateChangeEvent` 替换为 `SDKEventEnvelope`：

```typescript
export type WSServerEvent =
  | SDKEventEnvelope
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSErrorEvent;
```

- [ ] **Step 5: 更新 SessionEntity，新增 piSessionFile 字段**

```typescript
export interface SessionEntity {
  id: string;
  projectId: string;
  primaryAgent: AgentName;
  title: string;
  createdAt: number;
  lastActivity: number;
  piSessionFile: string;  // 新增：SDK jsonl 文件路径 ~/.wa-pi/sessions/<id>.jsonl
}
```

- [ ] **Step 6: 运行 typecheck 验证**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/shared typecheck 2>&1 | head -20`
Expected: 可能因为 kernel/frontend 还引用了已删除的类型而报错，记录错误供后续任务修复

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "refactor(types): 删除废弃类型，新增 SDKEvent/AssistantMessageEvent/SDKEventEnvelope，SessionEntity 加 piSessionFile"
```

---

## Task 2: constants.ts — 删除 WA_PI_PI_AGENT_DIR，调整路径常量

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Interfaces:**
- Removes: `WA_PI_PI_AGENT_DIR`、`SESSIONS_DIR`（不再需要）
- Produces: `WA_PI_DIR` 作为 SDK agentDir 的唯一来源

- [ ] **Step 1: 删除废弃常量**

在 `packages/shared/src/constants.ts` 中删除：
- `WA_PI_PI_AGENT_DIR` 常量定义（约第 17 行）
- `SESSIONS_DIR` 常量定义（约第 19 行）

- [ ] **Step 2: 运行 typecheck 验证**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/shared typecheck 2>&1 | head -20`
Expected: 可能因为 kernel 还引用 WA_PI_PI_AGENT_DIR 而报错，记录错误供后续任务修复

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "refactor(constants): 删除 WA_PI_PI_AGENT_DIR 和 SESSIONS_DIR，统一用 WA_PI_DIR"
```

---

## Task 3: project-store.ts — createSession 生成 piSessionFile

**Files:**
- Modify: `packages/kernel/src/project-store.ts`
- Test: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Produces: `createSession` 返回的 `SessionEntity` 包含 `piSessionFile` 字段

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/project-store.test.ts` 中新增测试：

```typescript
import { WA_PI_DIR } from "@wa-pi/shared";

test("createSession 生成 piSessionFile 路径", async () => {
  const tmpFile = `/tmp/wa-pi-test-${Date.now()}.json`;
  const store = new ProjectStore(tmpFile);
  const project = await store.createProject({ name: "测试项目", cwd: "/tmp" });
  const session = await store.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "测试会话",
  });
  expect(session.piSessionFile).toBe(`${WA_PI_DIR}/sessions/${session.id}.jsonl`);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/project-store.test.ts --filter "piSessionFile" 2>&1 | tail -5`
Expected: FAIL（piSessionFile 为 undefined）

- [ ] **Step 3: 修改 createSession 生成 piSessionFile**

在 `packages/kernel/src/project-store.ts` 中：

1. import 加上 `WA_PI_DIR`：
```typescript
import { PROJECTS_FILE, WA_PI_DIR } from "@wa-pi/shared";
```

2. `createSession` 方法改为先算出 id 再拼路径：

```typescript
async createSession(input: {
  projectId: string; primaryAgent: AgentName; title: string; id?: string;
}): Promise<SessionEntity> {
  const data = await this.load();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const session: SessionEntity = {
    id, projectId: input.projectId,
    primaryAgent: input.primaryAgent, title: input.title,
    createdAt: now, lastActivity: now,
    piSessionFile: `${WA_PI_DIR}/sessions/${id}.jsonl`,
  };
  data.sessions.push(session);
  await this.save(data);
  return session;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/project-store.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts
git commit -m "feat(project-store): createSession 生成 piSessionFile 路径"
```

---

## Task 4: agent-manager.ts — 重写为 SDK 直连

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`（整体重写）
- Test: `packages/kernel/tests/agent-manager.test.ts`（整体重写）

**Interfaces:**
- Consumes: `WA_PI_DIR` from constants, `AgentConfig` from types, `ProjectStore`, `ConfigStore`
- Produces: `AgentManager` 类，方法 `ensureStarted(projectId, agentName, sessionId) → AgentSession`、`prompt(sessionId, text)`、`abort(sessionId)`、`getMessages(sessionId)`、`disposeSession(sessionId)`、`disposeAll()`

- [ ] **Step 1: 重写 agent-manager.test.ts**

```typescript
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { ConfigStore } from "../src/config-store";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// mock createAgentSession 返回 fake AgentSession
const fakeUnsubscribe = mock(() => {});
const fakeSession: Partial<AgentSession> = {
  prompt: mock(async () => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),
  setSessionName: mock(() => {}),
  subscribe: mock(() => fakeUnsubscribe),
  messages: [],
};

const mockCreateAgentSession = mock(async () => ({
  session: fakeSession as AgentSession,
  extensionsResult: { extensions: [], errors: [], runtime: {} as any },
}));

beforeEach(() => {
  mockCreateAgentSession.mockClear();
  (fakeSession.prompt as any).mockClear();
  (fakeSession.abort as any).mockClear();
  (fakeSession.setSessionName as any).mockClear();
  (fakeSession.subscribe as any).mockClear();
  fakeUnsubscribe.mockClear();
});

test("ensureStarted 创建 AgentSession 并设置 intercom 会话名", async () => {
  const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}.json`;
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const onEvent = mock(() => {});
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent, createAgentSessionFn: mockCreateAgentSession });
  const sdkSession = await am.ensureStarted(project.id, "dev", session.id);

  expect(sdkSession).toBe(fakeSession);
  expect(fakeSession.setSessionName).toHaveBeenCalledWith(`${project.id}-dev-${session.id}`);
  expect(fakeSession.subscribe).toHaveBeenCalledTimes(1);
});

test("ensureStarted 复用已存在的 session", async () => {
  const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}.json`;
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.ensureStarted(project.id, "dev", session.id);

  expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
});

test("prompt 调用 session.prompt", async () => {
  const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}.json`;
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好");

  expect(fakeSession.prompt).toHaveBeenCalledWith("你好", { streamingBehavior: "steer" });
});

test("abort 调用 session.abort", async () => {
  const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}.json`;
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.abort(session.id);

  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
});

test("disposeSession 清理 session 和 unsubscribe", async () => {
  const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}.json`;
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.disposeSession(session.id);

  expect(fakeSession.dispose).toHaveBeenCalledTimes(1);
  expect(fakeUnsubscribe).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/agent-manager.test.ts 2>&1 | tail -10`
Expected: FAIL（AgentManager 构造签名不匹配）

- [ ] **Step 3: 重写 agent-manager.ts**

```typescript
import type { AgentName } from "@wa-pi/shared";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "@wa-pi/shared";

// 可注入的 createAgentSession（测试用 mock，生产用真实 SDK）
type CreateAgentSessionFn = (opts: {
  cwd: string;
  agentDir: string;
  sessionManager: any;
  resourceLoader: any;
  model?: any;
  thinkingLevel?: string;
  tools?: string[];
  authStorage: any;
  modelRegistry: any;
}) => Promise<{ session: AgentSession }>;

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  configStore: ConfigStore | null;
  onEvent: (sessionId: string, projectId: string, agentName: AgentName, e: AgentSessionEvent) => void;
  createAgentSessionFn?: CreateAgentSessionFn;
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private unsubscribers = new Map<string, () => void>();

  constructor(private opts: AgentManagerOpts) {}

  async ensureStarted(projectId: string, agentName: AgentName, sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const { projects, sessions } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);

    const sessionEntity = sessions.find(s => s.id === sessionId);
    if (!sessionEntity) throw new Error(`会话不存在: ${sessionId}`);

    const config = this.opts.configStore ? await this.opts.configStore.getAgent(agentName) : null;

    // 动态导入 SDK（避免类型循环依赖）
    const { createAgentSession, SessionManager, DefaultResourceLoader, AuthStorage, ModelRegistry, resolveCliModel } =
      await import("@earendil-works/pi-coding-agent");

    const createFn = this.opts.createAgentSessionFn ?? createAgentSession as CreateAgentSessionFn;

    // 共享 auth/model（进程级）
    const authStorage = (this as any)._authStorage ??= AuthStorage.create();
    const modelRegistry = (this as any)._modelRegistry ??= ModelRegistry.create(authStorage);

    // AgentConfig → SDK options 映射
    const loader = new DefaultResourceLoader({
      cwd: project.cwd,
      agentDir: WA_PI_DIR,
      systemPromptOverride: config?.systemPromptMode === "replace" && config.systemPromptBody
        ? () => config.systemPromptBody!
        : undefined,
      agentsFilesOverride: config?.systemPromptMode === "append" && config.systemPromptBody
        ? (current: any) => ({
            agentsFiles: [...current.agentsFiles, { path: `/virtual/${config.name}.md`, content: config.systemPromptBody! }],
            diagnostics: current.diagnostics,
          })
        : undefined,
    });
    await loader.reload();

    const model = config?.model
      ? resolveCliModel({ cliModel: config.model, modelRegistry }).model
      : undefined;

    const { session } = await createFn({
      cwd: project.cwd,
      agentDir: WA_PI_DIR,
      sessionManager: SessionManager.open(sessionEntity.piSessionFile),
      resourceLoader: loader,
      model,
      thinkingLevel: config?.thinking ?? "medium",
      tools: config?.tools?.length ? config.tools : ["read", "bash", "edit", "write"],
      authStorage,
      modelRegistry,
    });

    // 设置 pi-intercom 会话名（对齐原 RPC --name 参数）
    session.setSessionName(`${projectId}-${agentName}-${sessionId}`);

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.opts.onEvent(sessionId, projectId, agentName, event);
    });
    this.sessions.set(sessionId, session);
    this.unsubscribers.set(sessionId, unsubscribe);
    return session;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);
    await session.prompt(text, { streamingBehavior: "steer" });
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await session.abort();
  }

  getMessages(sessionId: string): any[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.unsubscribers.get(sessionId)?.();
    this.unsubscribers.delete(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    for (const [id] of this.sessions) await this.disposeSession(id);
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/agent-manager.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "refactor(agent-manager): 重写为 SDK 直连 — Map<sessionId, AgentSession> + createAgentSession + subscribe"
```

---

## Task 5: ws-server.ts — 适配 SDK 调用 + sdk:event 广播

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: `AgentManager.prompt(sessionId, text)`、`AgentManager.abort(sessionId)`、`AgentManager.ensureStarted()` 返回的 `AgentSession.messages`
- Produces: `sdk:event` 广播事件

- [ ] **Step 1: 修改 ws-server.test.ts 适配新接口**

将 `ws-server.test.ts` 里所有 mock `PiRpcClient` 的地方改为 mock `AgentManager`。核心改动：

- `agent:prompt` 测试：验证调 `agentManager.prompt(sessionId, text)`（不再传 projectId/agentName）
- `agent:abort` 测试：验证调 `agentManager.abort(sessionId)`
- `session:messages` 测试：验证从 `ensureStarted` 返回的 session 的 `.messages` 读历史

具体测试代码根据现有 `ws-server.test.ts` 结构调整，保持测试场景不变，只改 mock 粒度。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/ws-server.test.ts 2>&1 | tail -10`
Expected: FAIL

- [ ] **Step 3: 修改 ws-server.ts 的 handle 方法**

核心改动点：

1. `session:messages` handler：从 `ensureStarted` 返回的 session 同步读 `messages`

```typescript
case "session:messages": {
  const { sessions } = await this.opts.projectStore.load();
  const session = sessions.find(s => s.id === event.sessionId);
  if (!session) {
    reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
    break;
  }
  try {
    const sdkSession = await this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id);
    const messages = sdkSession.messages.map(m => ({ message: m, agentName: session.primaryAgent }));
    reply({ type: "session:messages", sessionId: event.sessionId, messages });
  } catch {
    reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
  }
  break;
}
```

2. `agent:prompt` handler：调 `agentManager.prompt(sessionId, text)`

```typescript
case "agent:prompt": {
  const { sessions } = await this.opts.projectStore.load();
  const existing = sessions.find(s => s.id === event.sessionId);
  const isNew = !existing;
  const session = existing ?? await this.opts.projectStore.createSession({
    projectId: event.projectId, primaryAgent: event.agentName,
    title: event.text.slice(0, 20),
    id: event.sessionId,
  });
  if (isNew) this.broadcast({ type: "session:created", session });
  await this.opts.projectStore.touchSession(session.id);
  // 广播用户消息（让前端立即显示用户输入）
  const userMsg = {
    message: { role: "user" as const, content: event.text, timestamp: Date.now() },
    agentName: event.agentName,
    sessionId: session.id,
  };
  this.broadcast({
    type: "sdk:event", projectId: event.projectId,
    sessionId: session.id, agentName: event.agentName,
    event: { type: "message_start", message: userMsg.message },
  });
  try {
    const client = await this.opts.agentManager.ensureStarted(event.projectId, event.agentName, session.id);
    await client.prompt(event.text, { streamingBehavior: "steer" });
  } catch (err) {
    this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}`, agentName: event.agentName });
  }
  break;
}
```

3. `agent:abort` handler：调 `agentManager.abort(sessionId)`

```typescript
case "agent:abort": {
  await this.opts.agentManager.abort(event.sessionId);
  break;
}
```

4. `session:delete` handler：新增 `agentManager.disposeSession` 调用清理 SDK session

```typescript
case "session:delete": {
  await this.opts.agentManager.disposeSession(event.sessionId);
  await this.opts.projectStore.deleteSession(event.sessionId);
  const data = await this.opts.projectStore.load();
  this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
  break;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/ws-server.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts
git commit -m "refactor(ws-server): 适配 SDK 调用 — session.prompt/abort/messages + sdk:event 广播"
```

---

## Task 6: index.ts — 删除 StateAggregator，简化初始化

**Files:**
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Removes: `StateAggregator` 初始化、`bindAggregatorBroadcast` 调用
- Produces: `AgentManager.onEvent` 直接广播 `sdk:event`

- [ ] **Step 1: 重写 index.ts**

```typescript
import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { AgentManager } from "./agent-manager";
import { WSServer } from "./ws-server";
import { migrateLegacySessions } from "./migrate";
import { WS_PORT } from "@wa-pi/shared";
import type { WSServerEvent } from "@wa-pi/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();

  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  const server = new WSServer({
    configStore, projectStore,
    agentManager: null as any,  // 占位，下面赋值
    port: WS_PORT,
  });

  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: (sessionId, projectId, agentName, event) => {
      const e: WSServerEvent = { type: "sdk:event", projectId, sessionId, agentName, event };
      (server as any).broadcast(e);
    },
  });
  (server as any).opts.agentManager = agentManager;

  await server.start();
  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行 kernel 启动验证**

Run: `cd /path/to/WaPi && timeout 5 bun run --filter @wa-pi/kernel dev 2>&1 | head -10`
Expected: 看到 `[kernel] WS 监听 ws://127.0.0.1:9776`（不崩溃）

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/index.ts
git commit -m "refactor(index): 删除 StateAggregator 初始化，AgentManager.onEvent 直接广播 sdk:event"
```

---

## Task 7: 删除 pi-rpc-client.ts 和 state-aggregator.ts

**Files:**
- Delete: `packages/kernel/src/pi-rpc-client.ts`
- Delete: `packages/kernel/src/state-aggregator.ts`
- Delete: `packages/kernel/tests/pi-rpc-client.test.ts`
- Delete: `packages/kernel/tests/state-aggregator.test.ts`

- [ ] **Step 1: 删除文件**

```bash
rm packages/kernel/src/pi-rpc-client.ts
rm packages/kernel/src/state-aggregator.ts
rm packages/kernel/tests/pi-rpc-client.test.ts
rm packages/kernel/tests/state-aggregator.test.ts
```

- [ ] **Step 2: 清理残留引用**

搜索并清理代码中对已删除文件的引用：

```bash
cd /path/to/WaPi && grep -rn "pi-rpc-client\|state-aggregator\|PiRpcClient\|StateAggregator\|PiEvent" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test."
```

修复所有引用点（主要是 `agent-manager.ts` 的 import、`ws-server.ts` 的 import）。

- [ ] **Step 3: 运行 typecheck 验证**

Run: `cd /path/to/WaPi && bun run typecheck 2>&1 | head -20`
Expected: 无 pi-rpc-client / state-aggregator 相关错误

- [ ] **Step 4: 清理测试垃圾文件**

```bash
cd /path/to/WaPi && rm -f packages/kernel/tests/ws-proj.json* packages/kernel/tests/ws-sess*
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(kernel): 删除 pi-rpc-client.ts 和 state-aggregator.ts 及其测试"
```

---

## Task 8: 前端 store/session.ts — 处理 sdk:event，流式消息两态管理

**Files:**
- Modify: `packages/frontend/src/store/session.ts`
- Create: `packages/frontend/tests/store-session.test.ts`

**Interfaces:**
- Consumes: `SDKEventEnvelope` from shared/types
- Produces: session store 处理 `sdk:event`，管理 `messages`（定稿）+ `streamingMessage`（流式中）

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/store-session.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@wa-pi/shared";

describe("store/session sdk:event 处理", () => {
  beforeEach(() => {
    useSessionStore.setState({ messagesBySession: {}, streamingBySession: {}, statusBySession: {} });
  });

  it("message_start(user) 添加用户消息到 messages", () => {
    const envelope: SDKEventEnvelope = {
      type: "sdk:event", projectId: "p1", sessionId: "s1", agentName: "dev",
      event: { type: "message_start", message: { role: "user", content: "你好", timestamp: 1 } },
    };
    useSessionStore.getState().handleSDKEvent("s1", envelope);
    expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
    expect(useSessionStore.getState().messagesBySession["s1"][0].message).toEqual({ role: "user", content: "你好", timestamp: 1 });
  });

  it("message_start(assistant) 设置 streamingMessage", () => {
    const envelope: SDKEventEnvelope = {
      type: "sdk:event", projectId: "p1", sessionId: "s1", agentName: "dev",
      event: { type: "message_start", message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 } },
    };
    useSessionStore.getState().handleSDKEvent("s1", envelope);
    expect(useSessionStore.getState().streamingBySession["s1"]).toBeTruthy();
  });

  it("message_end 把 streamingMessage 移到 messages 并清空 streaming", () => {
    // 先设 streaming
    useSessionStore.setState({
      streamingBySession: { s1: { message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 }, agentName: "dev" } },
    });
    const envelope: SDKEventEnvelope = {
      type: "sdk:event", projectId: "p1", sessionId: "s1", agentName: "dev",
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "回复" }], model: "m", stopReason: "stop", timestamp: 2 } },
    };
    useSessionStore.getState().handleSDKEvent("s1", envelope);
    expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
    expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
  });

  it("agent_start 设置 status=thinking", () => {
    const envelope: SDKEventEnvelope = {
      type: "sdk:event", projectId: "p1", sessionId: "s1", agentName: "dev",
      event: { type: "agent_start" },
    };
    useSessionStore.getState().handleSDKEvent("s1", envelope);
    expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
  });

  it("agent_end 设置 status=idle", () => {
    useSessionStore.setState({ statusBySession: { s1: "thinking" } });
    const envelope: SDKEventEnvelope = {
      type: "sdk:event", projectId: "p1", sessionId: "s1", agentName: "dev",
      event: { type: "agent_end", messages: [], willRetry: false },
    };
    useSessionStore.getState().handleSDKEvent("s1", envelope);
    expect(useSessionStore.getState().statusBySession["s1"]).toBe("idle");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/frontend test -- --run store-session 2>&1 | tail -10`
Expected: FAIL（handleSDKEvent 方法不存在）

- [ ] **Step 3: 修改 store/session.ts**

在 `packages/frontend/src/store/session.ts` 中：

1. 新增 `streamingBySession` 和 `statusBySession` 状态
2. 新增 `handleSDKEvent(sessionId, envelope)` 方法处理 `sdk:event`
3. 删除原 `agent:message` 处理逻辑

核心代码结构：

```typescript
interface SessionState {
  messagesBySession: Record<string, SessionMessage[]>;
  streamingBySession: Record<string, SessionMessage | null>;
  statusBySession: Record<string, "idle" | "thinking" | "blocked">;
  // ... 原有方法
  handleSDKEvent: (sessionId: string, envelope: SDKEventEnvelope) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  messagesBySession: {},
  streamingBySession: {},
  statusBySession: {},
  // ... 原有方法保留

  handleSDKEvent: (sessionId, envelope) => {
    const { event } = envelope;
    switch (event.type) {
      case "message_start": {
        const msg = event.message as any;
        if (msg.role === "user") {
          set(state => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: [...(state.messagesBySession[sessionId] ?? []), { message: msg, agentName: envelope.agentName }],
            },
          }));
        } else if (msg.role === "assistant") {
          set(state => ({
            streamingBySession: { ...state.streamingBySession, [sessionId]: { message: msg, agentName: envelope.agentName } },
          }));
        }
        break;
      }
      case "message_update": {
        const partial = (event as any).assistantMessageEvent.partial;
        set(state => ({
          streamingBySession: { ...state.streamingBySession, [sessionId]: { message: partial, agentName: envelope.agentName } },
        }));
        break;
      }
      case "message_end": {
        const msg = event.message as any;
        set(state => ({
          streamingBySession: { ...state.streamingBySession, [sessionId]: null },
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: [...(state.messagesBySession[sessionId] ?? []), { message: msg, agentName: envelope.agentName }],
          },
        }));
        break;
      }
      case "agent_start":
        set(state => ({ statusBySession: { ...state.statusBySession, [sessionId]: "thinking" } }));
        break;
      case "agent_end":
        set(state => ({ statusBySession: { ...state.statusBySession, [sessionId]: "idle" } }));
        break;
      // tool_execution_* / turn_* 暂不处理
    }
  },
}));
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/frontend test -- --run store-session 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/store-session.test.ts
git commit -m "refactor(frontend/store): 处理 sdk:event — 流式消息两态管理（streaming/定稿）"
```

---

## Task 9: 前端 App.tsx — onMessage 路由适配

**Files:**
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useSessionStore.handleSDKEvent` from Task 8

- [ ] **Step 1: 修改 App.tsx 的 onMessage**

在 `packages/frontend/src/App.tsx` 的 WS `onMessage` 处理中：

1. 删除 `case "agent:message"` 分支
2. 新增 `case "sdk:event"` 分支，调用 `useSessionStore.getState().handleSDKEvent`

```typescript
case "sdk:event": {
  useSessionStore.getState().handleSDKEvent(data.sessionId, data);
  break;
}
```

- [ ] **Step 2: 运行前端测试验证不报错**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/frontend test -- --run 2>&1 | tail -10`
Expected: 现有测试 PASS（store-projects、DirTreePicker、ProjectItem 不受影响）

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/App.tsx
git commit -m "refactor(frontend/App): onMessage 新增 sdk:event 路由，删除 agent:message"
```

---

## Task 10: 前端 MessageList.tsx — 渲染 streamingMessage

**Files:**
- Modify: `packages/frontend/src/components/MessageList.tsx`

**Interfaces:**
- Consumes: `useSessionStore.streamingBySession` from Task 8

- [ ] **Step 1: 修改 MessageList 渲染逻辑**

在 `packages/frontend/src/components/MessageList.tsx` 中，渲染 messages 列表后追加渲染 streamingMessage：

```typescript
export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const streaming = useSessionStore(s => s.streamingBySession[sessionId] ?? null);
  const rows = preprocess(messages);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {rows.map((row, i) => <MessageRow key={i} row={row} sessionId={sessionId} />)}
      {streaming && <MessageRow row={{ main: streaming, toolResults: new Map() }} sessionId={sessionId} />}
    </div>
  );
}
```

- [ ] **Step 2: 运行前端测试验证**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/frontend test -- --run 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/MessageList.tsx
git commit -m "refactor(frontend/MessageList): 渲染 streamingMessage 流式消息"
```

---

## Task 11: pi-intercom 扩展安装迁移

**Files:**
- Modify: `packages/kernel/src/index.ts`（首次启动检查 + 安装）
- Create: `packages/kernel/src/intercom-setup.ts`（intercom 安装逻辑）

**Interfaces:**
- Produces: `ensureIntercomInstalled()` 函数，检查 `~/.wa-pi/settings.json` 并安装 pi-intercom

- [ ] **Step 1: 创建 intercom-setup.ts**

```typescript
import { readFile, writeFile, mkdir, existsSync } from "node:fs/promises";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

const INTERCOM_PACKAGE = "npm:pi-intercom";

/** 确保 pi-intercom 扩展已安装到 ~/.wa-pi/ */
export async function ensureIntercomInstalled(): Promise<void> {
  const settingsPath = join(WA_PI_DIR, "settings.json");
  let settings: { packages?: string[] } = {};

  // 读取现有 settings.json
  try {
    const raw = await readFile(settingsPath, "utf8");
    settings = JSON.parse(raw);
  } catch {
    // 文件不存在，用空对象
  }

  // 检查 packages 是否已包含 pi-intercom
  if (settings.packages?.includes(INTERCOM_PACKAGE)) {
    return;  // 已配置
  }

  // 写入 packages 配置
  settings.packages = [...(settings.packages ?? []), INTERCOM_PACKAGE];
  await mkdir(WA_PI_DIR, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`[kernel] 已写入 settings.json packages: [${INTERCOM_PACKAGE}]`);

  // 注意：实际的扩展安装（pi install）由 Pi SDK 的 DefaultResourceLoader 在首次加载时自动处理
  // settings.json 的 packages 字段会触发 SDK 从 npm 拉取并安装到 ~/.wa-pi/npm/
}
```

- [ ] **Step 2: 在 index.ts 中调用**

在 `packages/kernel/src/index.ts` 的 `main()` 开头调用：

```typescript
import { ensureIntercomInstalled } from "./intercom-setup";

async function main() {
  await ensureIntercomInstalled();  // 确保 pi-intercom 已配置
  // ... 其余初始化
}
```

- [ ] **Step 3: 写单元测试**

在 `packages/kernel/tests/intercom-setup.test.ts` 中：

```typescript
import { test, expect } from "bun:test";
import { ensureIntercomInstalled } from "../src/intercom-setup";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

test("ensureIntercomInstalled 写入 packages 配置", async () => {
  const tmpDir = `/tmp/wa-pi-intercom-test-${Date.now()}`;
  process.env.WA_PI_DIR = tmpDir;
  // 重新导入以获取新 WA_PI_DIR
  delete require.cache[require.resolve("../src/intercom-setup")];

  await ensureIntercomInstalled();
  const settings = JSON.parse(await readFile(join(tmpDir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:pi-intercom");

  await rm(tmpDir, { recursive: true });
  delete process.env.WA_PI_DIR;
});

test("ensureIntercomInstalled 幂等（已存在不重复写入）", async () => {
  const tmpDir = `/tmp/wa-pi-intercom-test-${Date.now()}`;
  process.env.WA_PI_DIR = tmpDir;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(tmpDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-intercom"] }));
  delete require.cache[require.resolve("../src/intercom-setup")];

  await ensureIntercomInstalled();
  const settings = JSON.parse(await readFile(join(tmpDir, "settings.json"), "utf8"));
  expect(settings.packages).toHaveLength(1);

  await rm(tmpDir, { recursive: true });
  delete process.env.WA_PI_DIR;
});
```

- [ ] **Step 4: 运行测试**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/intercom-setup.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/intercom-setup.ts packages/kernel/tests/intercom-setup.test.ts packages/kernel/src/index.ts
git commit -m "feat(intercom): 首次启动自动配置 pi-intercom 扩展到 ~/.wa-pi/settings.json"
```

---

## Task 12: session-messages.test.ts 适配

**Files:**
- Modify: `packages/kernel/tests/session-messages.test.ts`

- [ ] **Step 1: 适配测试**

将 `session-messages.test.ts` 里的 mock 从 `PiRpcClient.getMessages()` 改为 mock `AgentSession.messages` 属性。核心改动：

- 不再 mock `PiRpcClient`，改为 mock `createAgentSession` 返回带 `messages` 属性的 fake session
- 验证 `session:messages` 事件从 `session.messages` 读取

- [ ] **Step 2: 运行测试**

Run: `cd /path/to/WaPi && bun test packages/kernel/tests/session-messages.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/tests/session-messages.test.ts
git commit -m "test(session-messages): 适配 SDK — 从 session.messages 读历史"
```

---

## Task 13: 全量 typecheck + 测试 + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 全量 typecheck**

Run: `cd /path/to/WaPi && bun run typecheck 2>&1`
Expected: 无错误

- [ ] **Step 2: kernel 全量测试**

Run: `cd /path/to/WaPi && bun test packages/kernel/ 2>&1 | tail -20`
Expected: 全部 PASS

- [ ] **Step 3: 前端全量测试**

Run: `cd /path/to/WaPi && bun run --filter @wa-pi/frontend test -- --run 2>&1 | tail -20`
Expected: 全部 PASS

- [ ] **Step 4: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 顶部新增：

```markdown
## 2026-07-08 — Pi SDK 模式重构

- **类型**：重构
- **摘要**：将 kernel 从 spawn `pi --mode rpc` 子进程 + JSON-RPC 协议改为同进程 `createAgentSession` SDK 直连。AgentManager 用 `Map<sessionId, AgentSession>` 管理多会话，事件用 `sdk:event` 信封全量透传前端。删除 pi-rpc-client.ts 和 state-aggregator.ts。pi-intercom 通过 `session.setSessionName()` 兼容。
- **影响范围**：`packages/kernel/src/agent-manager.ts`（重写）、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/project-store.ts`、`packages/shared/src/types.ts`、`packages/shared/src/constants.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`、`packages/frontend/src/components/MessageList.tsx`、删除 `pi-rpc-client.ts`/`state-aggregator.ts`
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 记录 Pi SDK 模式重构"
```

---

## Task 14: E2E 验证（需真实 Pi 环境）

**Files:**
- Modify: `packages/frontend/e2e/intercom.spec.ts`（适配新事件类型）

- [ ] **Step 1: 适配 intercom E2E 测试**

`packages/frontend/e2e/intercom.spec.ts` 里等待 `委派给` 文本的逻辑不变，因为前端 `DelegateCard` 渲染逻辑不变。只需确认 `PI_E2E=1` 环境下测试能跑通。

- [ ] **Step 2: 运行 E2E（如有 Pi 环境）**

Run: `cd /path/to/WaPi && PI_E2E=1 bun run --filter @wa-pi/frontend e2e 2>&1 | tail -20`
Expected: intercom 委派流程通过

- [ ] **Step 3: 清理截图**

```bash
cd /path/to/WaPi && find . -name "*.png" -path "*/e2e/*" -delete 2>/dev/null; find . -name "*.png" -path "*/test-results/*" -delete 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(e2e): 验证 intercom 委派在 SDK 模式下兼容"
```
