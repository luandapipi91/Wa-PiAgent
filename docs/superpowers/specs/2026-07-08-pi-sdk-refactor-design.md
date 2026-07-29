# Pi SDK 模式重构设计

- **日期**：2026-07-08
- **类型**：重构
- **摘要**：将 WaPi kernel 从 "spawn `pi --mode rpc` 子进程 + 手写 JSON-RPC 协议" 改为 "同进程 `createAgentSession` SDK 直连"，前端 WS 事件全量对齐 SDK 原生事件。

---

## 1. 背景与动机

### 1.1 当前架构痛点

当前 kernel 通过 `pi-rpc-client.ts` spawn `pi --mode rpc --name <broker>` 子进程，以 stdin/stdout 行式 JSON-RPC 通信：

- 手动维护 `pendingId` / `pendingRpcResolvers` / `streamingContent` 等协议状态
- 手动把 Bun Web Streams 适配成 Node EventEmitter 风格（`toNodeStream`）
- 手动解析 `message_start` / `message_update` / `message_end` 等流式事件
- 因 Pi RPC 不支持单进程多会话，`AgentManager` 被迫按 `(projectId, agentName, sessionId)` 三 key 管理，**每个 WaPi 会话独立一个 Pi 子进程**
- `StateAggregator` 归并 Pi 事件成 WaPi 语义事件，多一层映射

CHANGELOG 记录的一长串竞态修复（消息丢失、顺序颠倒、重复 session、首条消息用户/agent 颠倒）都源于子进程 + RPC 时序复杂度。

### 1.2 SDK 模式优势

`@earendil-works/pi-coding-agent@0.80.3`（当前依赖）已导出 SDK（已验证）：

- `createAgentSession()` 同进程创建 `AgentSession`，`session.subscribe()` 收事件，`session.prompt()` / `session.messages` / `session.abort()` / `session.dispose()` 直接调用
- 天然支持单进程多会话 → 消除"每会话一进程"
- `SessionManager.open(path)` 控制每会话独立 jsonl 持久化
- `DefaultResourceLoader` 提供全套 override 钩子（`systemPromptOverride` / `tools` / `customTools` / `skillsOverride` / `promptsOverride` / `agentsFilesOverride` / `additionalExtensionPaths` / `extensionFactories`），后期工具/技能/提示词自定义只需扩展 `AgentConfig` + 注入对应钩子

### 1.3 已确认的决策

| 决策项 | 选择 |
|---|---|
| 重构范围 | 全栈重构（kernel + 前端协议精简） |
| 会话持久化 | SDK 持久化到 `~/.wa-pi/`（不再有 `pi-agent` 子目录） |
| 多会话管理 | `createAgentSession` + `Map<sessionId, AgentSession>`（并行多会话，不用 `AgentSessionRuntime`） |
| 前端 WS 事件 | 全量透传 SDK 原生事件（后端不归并） |
| Agent 配置过渡 | 保留 `agent.md`，`DefaultResourceLoader` + override 钩子注入 |
| 旧数据兼容 | 干净切换，不兼容旧消息（元数据保留，消息历史从头开始） |
| 架构选型 | 薄封装直连 SDK（方案 A） |

---

## 2. 总体架构与模块边界

### 2.1 模块职责对照

| 模块 | 重构前 | 重构后 |
|---|---|---|
| `pi-rpc-client.ts` | spawn 子进程 + 行式 JSON-RPC + 手动流式解析 | **删除** |
| `agent-manager.ts` | `Map<三key, PiRpcClient>` | `Map<sessionId, AgentSession>`，每会话 `createAgentSession` + `subscribe` |
| `ws-server.ts` | 调 `PiRpcClient.prompt/abort/getMessages` | 调 `session.prompt/abort`，历史从 `session.messages` 同步读 |
| `state-aggregator.ts` | 归并 `PiEvent` → `WSServerEvent` | **删除**（事件全量透传，不再归并） |
| `shared/types.ts` | 自定义 `PiEvent` + 归并后的 `WSServerEvent` | 镜像 SDK `AgentSessionEvent` 联合类型作为 WS 事件 |
| `config-store.ts` + `agent-md.ts` | 自管 `agent.md` | 保留，新增 `toSdkOptions()` 映射 `AgentConfig` → `createAgentSession` options |
| 前端 `store/session.ts` | 处理归并后的 `agent:message` | 处理 SDK 原生事件（`message_update` 增量等） |

### 2.2 数据目录布局

`~/.wa-pi/` 统一作为 SDK 的 `agentDir`，不再有 `pi-agent` 子目录：

| 路径 | 用途 | 管理方 |
|---|---|---|
| `~/.wa-pi/projects.json` | 项目/会话元数据 | WaPi |
| `~/.wa-pi/agents/*.md` | agent 配置（含 partners 等 WaPi 特有字段） | WaPi |
| `~/.wa-pi/sessions/<sessionId>.jsonl` | SDK 持久化消息历史 | SDK |
| `~/.wa-pi/auth.json` | SDK 凭证 | SDK |
| `~/.wa-pi/models.json` | SDK 自定义模型 | SDK |
| `~/.wa-pi/settings.json` | SDK 设置 | SDK |
| `~/.wa-pi/skills/` | SDK 技能目录 | SDK |
| `~/.wa-pi/extensions/` | SDK 扩展目录 | SDK |

SDK 的 `DefaultResourceLoader` 会在 `agentDir` 下找 `AGENTS.md` 作为全局 context file。`~/.wa-pi/AGENTS.md` 若存在会被加载——有利于后期"全局指令"功能，不冲突。

### 2.3 关键简化

- 删除 `state-aggregator.ts`（事件全量透传，无需归并层）
- 删除 `pi-rpc-client.ts`（不再 spawn 子进程）
- `AgentManager` 三 key → 单 key（`sessionId`），SDK 单进程天然支持多会话
- 历史消息从 `session.messages` 同步读，不再异步 RPC `getMessages`

---

## 3. 数据模型与 WS 协议

### 3.1 删除的类型（`shared/types.ts`）

- `PiEvent` 类型（kernel 内部，随 `pi-rpc-client.ts` 删除）
- `ChatMessage` 接口（已废弃，注释标注 Task 4 清理，现在清理）
- `MessageUpdateEvent`、`StateChangeEvent` 等归并后的事件（全量透传，不再归并）

### 3.2 新增类型（`shared/types.ts`）

镜像 SDK 的 `AgentSessionEvent` 联合类型。WaPi 不重新定义事件结构，声明等价类型：

```typescript
// 镜像 SDK AgentEvent + agent_end 扩展，作为 WS 透传事件
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
```

镜像 `@earendil-works/pi-ai` 的 `AssistantMessageEvent`：

```typescript
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

`ToolResultMessage` 已存在于 `shared/types.ts`，无需新增。

### 3.3 WS 事件协议（kernel → 前端）

新增统一的事件信封类型，包裹 sessionId 上下文：

```typescript
export interface SDKEventEnvelope {
  type: "sdk:event";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  event: SDKEvent;             // 原始 SDK 事件，原样透传
}
```

保留不变的 WS 事件：`projects:list`、`project:created`、`session:created`、`session:messages`、`agent:config`、`error`、`fs:*`。这些是 WaPi 自有业务事件，与 SDK 无关。

`session:messages` 事件 payload 不变（`SessionMessage[]`），只是 kernel 获取方式从异步 RPC 改为同步 `session.messages` 属性访问。

### 3.4 SessionEntity 改动

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

`ProjectStore.createSession()` 创建会话时生成 `piSessionFile = ${WA_PI_DIR}/sessions/${id}.jsonl` 并写入。`AgentManager.ensureStarted` 从 `SessionEntity.piSessionFile` 读取路径，传给 `SessionManager.open()`。

### 3.5 WSClientEvent（前端 → kernel）

- `agent:prompt` — 不变（projectId/sessionId/agentName/text）
- `agent:abort` — 不变，但 kernel 实现只需 `sessionId`（不再需要 projectId/agentName）
- `session:messages` — 不变，但 kernel 实现从 `session.messages` 同步读
- 其余项目/fs 操作事件不变

### 3.6 WSServerEvent 联合类型更新

```typescript
export type WSServerEvent =
  | SDKEventEnvelope                    // 新增：替换原 MessageUpdateEvent / StateChangeEvent
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSErrorEvent;
```

删除 `MessageUpdateEvent` 和 `StateChangeEvent`（被 `SDKEventEnvelope` 替代）。

### 3.7 伙伴委托工具（替代 pi-intercom）

WaPi 原依赖 pi-intercom 扩展（独立 broker daemon + Unix socket）实现 agent 间委托。经调研 pi.dev/packages 上的 subagent 类扩展（@gotgenes/pi-subagents 等），均不适配 WaPi 场景——核心硬伤是它们**硬禁止链式委托**（`applyRecursionGuard` 删除子 agent 的委托工具），而 WaPi 要求 A→B→C 链式 + 深度限制。

**改为自研 `delegate` 工具**：用 SDK `defineTool` 注册自定义工具，agent 调用时创建**临时子 session**（inMemory，不落盘，跑完即弃），`prompt` 后取回复返回，`dispose`。天然支持链式（await 嵌套），深度限制防环。

**调研结论**（pi.dev/packages）：

| 扩展 | 链式委托 | session 模型 | 结论 |
|---|---|---|---|
| pi-intercom | 支持（broker 路由） | 独立进程 + socket | 绕路，同进程不需要 |
| @gotgenes/pi-subagents | **硬禁止**（applyRecursionGuard） | 临时子 session | 核心硬伤，fork 改造量大 |
| pi-subagents (nicobailon) | 否 | spawn 子进程 | 与单进程冲突 |
| pi-crew | 否 | worktree 团队 | 模型不匹配 |

**委托工具设计**：

```typescript
// delegate-tool.ts
defineTool({
  name: "delegate",
  label: "委托伙伴",
  description: "向指定伙伴 agent 提问并等待回复",
  parameters: Type.Object({
    to: Type.String({ description: "伙伴 agent 名称（product/pm/dev/test）" }),
    question: Type.String({ description: "要提问的内容" }),
    _depth: Type.Optional(Type.Number({ description: "内部参数，委托深度", default: 0 })),
  }),
  execute: async (toolCallId, params) => {
    // 1. 校验 to 是否在当前 agent 的 partners.askTo 里
    // 2. 深度检查（_depth >= MAX_DEPTH 则拒绝，MAX_DEPTH = 5）
    // 3. 从 ConfigStore 读目标 agent 配置（提示词/模型/工具）
    // 4. 创建临时子 session（SessionManager.inMemory()，不落盘）
    //    - 子 session 也注入 delegate 工具（深度 +1），支持链式 A→B→C
    // 5. await session.prompt(question)
    // 6. 取最后一条 assistant 消息的文本内容
    // 7. session.dispose()，返回工具结果
  }
})
```

**链式委托 A→B→C 机制**：
- A 调 `delegate({ to: "pm", question: "..." })`
- 工具 execute 内 `createAgentSession`（inMemory）创建 pm 的临时子 session
- pm 的子 session 也注入了 `delegate` 工具（`customTools`）
- pm 调 `delegate({ to: "test", question: "...", _depth: 1 })`
- test 的临时子 session 同样有 delegate 工具（`_depth: 2`）
- 深度达 5 时拒绝，返回错误

**深度限制防环**：环允许（A→B→C→A 不报错），但 `_depth >= 5` 时直接拒绝并返回错误消息。`_depth` 通过工具参数自动传递，LLM 不需要手动设置。

**agent 感知伙伴**：系统提示词注入 partners 信息。`ensureStarted` 时在 `systemPromptOverride` 或 `agentsFilesOverride` 里追加：
```
你可以使用 delegate 工具委托以下伙伴：
- pm（项目管理）：[partners.askTo 含 pm 时]
- test（质量验收）：[partners.askTo 含 test 时]
委托时提供伙伴名称和问题，等待回复后继续工作。
```

**临时子 session 配置**：
- `SessionManager.inMemory()`：不落盘，跑完即弃
- 从 ConfigStore 读目标 agent 的 `AgentConfig`（model/tools/systemPromptBody）
- `customTools` 包含 `delegate` 工具（传入目标 agent 的 partners 作为可委托列表）
- 共享 `authStorage` / `modelRegistry`（从 AgentManager 注入）

**删除 pi-intercom 相关代码**：

| 删除项 | 原因 |
|---|---|
| `intercom-setup.ts` | 不再需要 pi-intercom 扩展 |
| `packages/kernel/package.json` 的 `pi-intercom` 依赖 | 不再需要 |
| `~/.wa-pi/settings.json` 的 packages 配置 | 不再需要 |
| `session.setSessionName()` 调用 | 不再需要 intercom 会话名 |
| 前端 `DelegateReceived` 组件 | 进程内委托不产生 `custom_message`，只有 `tool_execution_*` |
| 前端 `MessageList.tsx` 的 `block.name === "intercom"` | 改为 `block.name === "delegate"` |

**前端兼容性**：
- `delegate` 工具调用走标准 `tool_execution_start/update/end` 事件 → 全量透传到前端
- 前端 `DelegateCard` 渲染改为匹配 `block.name === "delegate"`
- `DelegateReceived` 删除（进程内委托不产生入站 `custom_message`）

**验证要点**（实现阶段需验证）：
1. agent 调 `delegate` 工具后，临时子 session 创建并 prompt 成功
2. 链式 A→B→C 正常工作，每层创建独立临时 session
3. 深度达 5 时拒绝并返回错误
4. `partners.askTo` 校验：委托不在列表的 agent 返回错误
5. 子 session 跑完后 dispose，不残留
6. 前端 `DelegateCard` 正确渲染 `delegate` 工具调用

---

## 4. AgentManager 重构细节

### 4.1 核心结构

```typescript
import { createAgentSession, SessionManager, DefaultResourceLoader, AuthStorage, ModelRegistry, resolveCliModel } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private unsubscribers = new Map<string, () => void>();
  private authStorage = AuthStorage.create();
  private modelRegistry = ModelRegistry.create(this.authStorage);

  constructor(private opts: {
    projectStore: ProjectStore;
    configStore: ConfigStore;
    onEvent: (sessionId: string, projectId: string, agentName: AgentName, e: AgentSessionEvent) => void;
  }) {}
}
```

### 4.2 ensureStarted 流程

```typescript
async ensureStarted(projectId: string, agentName: AgentName, sessionId: string): Promise<AgentSession> {
  const existing = this.sessions.get(sessionId);
  if (existing) return existing;

  const project = await this.lookupProject(projectId);
  const config = await this.opts.configStore.getAgent(agentName);
  // piSessionFile 在 createSession 时已写入 SessionEntity（见 3.4）
  const sessionEntity = await this.lookupSession(sessionId);
  const sessionFile = sessionEntity.piSessionFile;

  const loader = await this.buildResourceLoader(config, project.cwd);
  const model = config?.model
    ? resolveCliModel({ cliModel: config.model, modelRegistry: this.modelRegistry }).model
    : undefined;

  const { session } = await createAgentSession({
    cwd: project.cwd,
    agentDir: WA_PI_DIR,
    sessionManager: SessionManager.open(sessionFile),
    resourceLoader: loader,
    model,
    thinkingLevel: config?.thinking ?? "medium",
    tools: config?.tools?.length ? config.tools : ["read", "bash", "edit", "write"],
    authStorage: this.authStorage,
    modelRegistry: this.modelRegistry,
  });

  // 注入 delegate 委托工具（见 3.7 节）
  const delegateTool = createDelegateTool({
    fromAgent: agentName,
    fromConfig: config,
    configStore: this.opts.configStore,
    authStorage,
    modelRegistry,
  });

  const { session } = await createFn({
    cwd: project.cwd,
    agentDir: WA_PI_DIR,
    sessionManager: SessionManager.open(sessionEntity.piSessionFile),
    resourceLoader: loader,
    model,
    thinkingLevel: config?.thinking ?? "medium",
    tools: config?.tools?.length ? config.tools : ["read", "bash", "edit", "write"],
    customTools: [delegateTool],
    authStorage,
    modelRegistry,
  });

  const unsubscribe = session.subscribe((event) => {
    this.opts.onEvent(sessionId, projectId, agentName, event);
  });
  this.sessions.set(sessionId, session);
  this.unsubscribers.set(sessionId, unsubscribe);
  return session;
}
```

### 4.3 buildResourceLoader — AgentConfig → SDK 映射

```typescript
private async buildResourceLoader(config: AgentConfig | null, cwd: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: WA_PI_DIR,
    systemPromptOverride: config?.systemPromptMode === "replace" && config.systemPromptBody
      ? () => config.systemPromptBody!
      : undefined,
    agentsFilesOverride: config?.systemPromptMode === "append" && config.systemPromptBody
      ? (current) => ({
          agentsFiles: [...current.agentsFiles, { path: `/virtual/${config.name}.md`, content: config.systemPromptBody! }],
          diagnostics: current.diagnostics,
        })
      : undefined,
    // 后期扩展点：skillsOverride / promptsOverride / additionalExtensionPaths / extensionFactories
  });
  await loader.reload();
  return loader;
}
```

### 4.4 操作方法

```typescript
async prompt(sessionId: string, text: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`会话未启动: ${sessionId}`);
  await session.prompt(text, { streamingBehavior: "steer" });
}

async abort(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (session) await session.abort();
}

getMessages(sessionId: string): AgentMessage[] {
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
```

### 4.5 ws-server.ts 适配

```typescript
// session:messages handler
// 注意：createAgentSession 只创建会话对象 + 加载历史，不触发 LLM 调用。
// 只有 session.prompt() 才会触发 LLM，所以读取历史消息是安全的。
case "session:messages": {
  const session = sessions.find(s => s.id === event.sessionId);
  if (!session) { reply({ type: "session:messages", sessionId, messages: [] }); break; }
  const sdkSession = await agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id);
  const messages = sdkSession.messages.map(m => ({ message: m, agentName: session.primaryAgent }));
  reply({ type: "session:messages", sessionId, messages });
  break;
}

// agent:prompt handler
case "agent:prompt": {
  // 创建/查找 session 逻辑不变
  const client = await agentManager.ensureStarted(projectId, agentName, session.id);
  // 用户消息广播逻辑保留
  await client.prompt(text, { streamingBehavior: "steer" });
  break;
}

// agent:abort handler
case "agent:abort":
  await agentManager.abort(event.sessionId);
  break;
```

### 4.6 index.ts 简化

```typescript
const agentManager = new AgentManager({
  projectStore, configStore,
  onEvent: (sessionId, projectId, agentName, event) => {
    server.broadcast({ type: "sdk:event", projectId, sessionId, agentName, event });
  },
});
// 删除 StateAggregator 初始化 + bindAggregatorBroadcast
```

### 4.7 删除的文件 / 代码

| 删除项 | 原因 |
|---|---|
| `pi-rpc-client.ts` 整个文件 | 不再 spawn 子进程 |
| `state-aggregator.ts` 整个文件 | 事件全量透传，无需归并 |
| `MockChild` / `toNodeStream` / `resolvePiBin` | 子进程适配代码 |
| `AgentManager` 三 key 逻辑 | SDK 单进程多会话 |
| `PiRpcClientOpts.spawnFn` | 不再需要 mock spawn |
| `index.ts` 里 `StateAggregator` 初始化 + `bindAggregatorBroadcast` | 归并层删除 |

---

## 5. 前端适配

### 5.1 store/session.ts 重写

当前 `onMessage` 处理 `agent:message`（归并后的流式消息）。改为处理 `sdk:event` 信封：

```typescript
case "sdk:event": {
  const { sessionId, event } = data;
  if (sessionId !== currentSessionId) return;

  switch (event.type) {
    case "message_start": {
      const msg = event.message;
      if (msg.role === "user") {
        append({ message: msg, agentName: data.agentName, sessionId });
      } else if (msg.role === "assistant") {
        setStreaming({ message: msg, agentName: data.agentName, sessionId });
      }
      break;
    }
    case "message_update": {
      const partial = event.assistantMessageEvent.partial;
      setStreaming({ message: partial, agentName: data.agentName, sessionId });
      break;
    }
    case "message_end": {
      finalizeStreaming({ message: event.message, agentName: data.agentName, sessionId });
      break;
    }
    case "agent_start": setStatus("thinking"); break;
    case "agent_end": setStatus("idle"); break;
    case "turn_start": case "turn_end":
    case "tool_execution_start": case "tool_execution_update": case "tool_execution_end":
      break;   // 后期扩展工具调用 UI 时再处理
  }
  break;
}
```

删除 `agent:message` case。

### 5.2 流式消息状态管理

当前 `store/session.ts` 用 `append()` 靠 msgKey 去重处理流式消息。重构后区分"流式中"和"定稿"两态：

```typescript
interface SessionState {
  messages: SessionMessage[];               // 已定稿消息
  streamingMessage: SessionMessage | null;  // 当前流式消息
  status: "idle" | "thinking" | "blocked";
}
// message_start(assistant) → streamingMessage = msg
// message_update → streamingMessage.message = partial
// message_end → messages.push(streamingMessage); streamingMessage = null
```

前端渲染层从"渲染 messages 列表"改为"渲染 messages + streamingMessage"。

### 5.3 App.tsx 适配

`App.tsx` 的 `onMessage` 路由删除 `agent:message` 分支，新增 `sdk:event` 分支转发给 session store。`session:created`、`projects:list`、`agent:config`、`error`、`fs:*` 分支不变。

---

## 6. 测试策略（四层）

### 6.1 第一层：单元测试（kernel，`bun:test`）

| 测试文件 | 改动 |
|---|---|
| `agent-manager.test.ts` | 重写：mock `createAgentSession` 返回 fake `AgentSession`，验证 `ensureStarted` / `prompt` / `abort` / `getMessages` / `disposeSession` |
| `pi-rpc-client.test.ts` | **删除** |
| `state-aggregator.test.ts` | **删除** |
| `ws-server.test.ts` | mock `AgentManager`，验证 `session:messages` 同步读、`agent:prompt` 调 `session.prompt`、`sdk:event` 广播 |
| `session-messages.test.ts` | 适配：历史消息从 `session.messages` 读 |
| `project-store.test.ts` / `config-store.test.ts` / `agent-md.test.ts` | 不变 |

### 6.2 第二层：组件测试（frontend，Vitest + @testing-library/react）

| 测试文件 | 改动 |
|---|---|
| `store-projects.test.ts` / `DirTreePicker.test.tsx` / `ProjectItem.sort-menu.test.tsx` | 不变 |
| **新增** `store-session.test.ts` | 测试 `sdk:event` 处理：`message_update` 更新流式、`message_end` 定稿、`agent_end` 置空闲 |

### 6.3 第三层：API 接口测试

`e2e-integration.test.ts` 适配：启动真实 kernel + WS 连接，创建项目 → 发 `agent:prompt` → 收 `sdk:event`（验证事件类型 + payload）→ `session:messages` 验证历史。

### 6.4 第四层：E2E（Playwright / agent-browser）

创建项目 → 选 agent → 发消息 → 验证流式渲染 → 验证历史会话恢复。截图清理规则照旧。

---

## 7. 迁移与清理

| 操作 | 说明 |
|---|---|
| 删除 `pi-rpc-client.ts` | 不再需要 |
| 删除 `state-aggregator.ts` | 不再需要 |
| 删除 `kernel/tests/pi-rpc-client.test.ts` | 对应文件已删 |
| 删除 `kernel/tests/state-aggregator.test.ts` | 对应文件已删 |
| 删除 `intercom-setup.ts` | pi-intercom 扩展不再需要，改为自研 delegate 工具 |
| 删除 `packages/kernel/package.json` 的 `pi-intercom` 依赖 | 不再需要 |
| 前端 `DelegateReceived.tsx` 删除 | 进程内委托不产生入站 custom_message |
| 前端 `MessageList.tsx` 的 `block.name === "intercom"` 改为 `"delegate"` | 工具名变更 |
| `migrate.ts` 保留但简化 | 旧会话元数据保留，`piSessionFile` 字段对旧数据为 undefined（旧消息历史丢失，干净切换） |
| `shared/types.ts` 删除 `ChatMessage`、`PiEvent`、归并事件类型 | 废弃代码清理 |
| `constants.ts` 删除 `WA_PI_PI_AGENT_DIR`、`SESSIONS_DIR` | 改用 `WA_PI_DIR`，sessions 路径由 AgentManager 拼 |
| `ws-server.ts` 删除 RPC 调用、`sessionId` 参数传递 | 简化 |
| `index.ts` 删除 `StateAggregator` 初始化 + `bindAggregatorBroadcast` | 归并层删除 |
| 清理 `kernel/tests/` 下的 `ws-proj.json*` / `ws-sess*` 残留文件 | 测试垃圾文件 |

---

## 8. 后期扩展点（不在本次实现）

`AgentConfig` 类型扩展即可支持自定义工具/技能/提示词，`buildResourceLoader` 里注入对应 override：

```typescript
// 未来 AgentConfig 扩展字段（现在不加）
customTools?: string[];      // → customTools: [defineTool(...)]
customSkills?: string[];     // → skillsOverride
customPrompts?: string[];    // → promptsOverride
customExtensions?: string[]; // → additionalExtensionPaths
```

---

## 9. 验收标准

1. `pi-rpc-client.ts` 和 `state-aggregator.ts` 及其测试文件删除
2. `AgentManager` 用 `Map<sessionId, AgentSession>` 管理，`createAgentSession` + `subscribe` 直连 SDK
3. 前端 `sdk:event` 信封类型透传 SDK 原生事件，`store/session.ts` 消费原生事件
4. `~/.wa-pi/` 作为 SDK `agentDir`，会话 jsonl 存 `~/.wa-pi/sessions/<id>.jsonl`
5. 伙伴委托：`delegate` 工具创建临时子 session（inMemory），链式 A→B→C 正常，深度限制 5 层防环，前端 `DelegateCard` 渲染 `delegate` 工具调用
6. 四层测试全部通过：kernel 单元测试、前端组件测试、API 集成测试、E2E
7. `CHANGELOG.md` 记录本次重构
