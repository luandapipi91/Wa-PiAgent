# 基于 Pi 原生消息模型的架构重构

- **日期**: 2026-07-07
- **主题**: 废弃 HiAgent 自建的消息系统（拍扁纯文本 + broker-proxy 旁路），改用 Pi 原生富消息模型与原生 intercom；同步迁移数据目录到 `.hiagent`；聊天 UI 改为微信式左右分栏
- **状态**: 已二次核查修订（修正 9 处事实/类型/行号错误；撤回"broker-proxy 靠文本解析"误判，改用"职责重叠"论据）

## 1. 背景与问题

### 1.1 当前架构的根本缺陷

HiAgent 在消息处理上有三个互相加剧的设计错误：

**错误一：把 Pi 的富消息拍扁成纯文本**

Pi 产出的 `AssistantMessage` 本是富容器，`content` 是 `(TextContent | ThinkingContent | ToolCall)[]` 数组，思考、正文、工具调用各占一格。但 kernel 的 `pi-rpc-client.ts:178-181` 这样处理：

```ts
const text = content.filter(c => c.type === "text").map(c => c.text).join("");
```

只挑 `text` 类型，把 thinking 和 toolCall 全 filter 掉，拼成一个字符串。用户在 UI 上永远看不到思考过程和工具调用。

**错误二：重复持久化**

Pi 已经自动把完整 session 存到 `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`（含 user/assistant/toolResult/custom_message 全部消息）。HiAgent 又自建 `session-store.ts`，把拍扁的纯文本再存一份到 `~/.hiagent/sessions/*.json`。两套数据源，信息丢失的那套反而成了 UI 的数据来源。

**错误三：intercom 委派用了与 Pi 原生重叠的旁路系统**

Pi 的 `pi-intercom` 扩展（npm 独立包 `pi-intercom`）已经完整处理了消息路由、turn 触发、session 注册、历史存储。委派关系在 Pi session 数据里完全结构化存在（发送方的 `toolCall(intercom)` + 接收方的 `custom_message(intercom_message)`，见 3.3 节样本）。

HiAgent 自建了 `BrokerProxyManager`（`broker-proxy.ts`，237 行）和 `IntercomMonitor` 两个类做旁路。核查 `broker-proxy.ts` 源码后确认：它**不是靠文本解析**（用的是 `pi-intercom/broker/client` 的结构化 API `IntercomClient`，字段为 `message.content.text` / `replyTo` / `expectsReply`），而是 kernel 作为"中间人代理"——用公开名 `{projectId}-{agentName}` 占据 broker，真实 pi 进程用 `-real` 内部名，代理拦截消息后用 relay client 转发。

**重叠点**（废弃的真实论据）：
1. **路由重复**：broker-proxy.ts:178-207 的 `flushPending` 用 relay client 把消息转发给 `-real` 进程；但 Pi 原生 intercom 本身就具备机器内消息路由能力（broker 自动路由到目标 session 名）。kernel 这层 relay 是在 Pi 已有的路由之上再套一层。
2. **会话名占位重复**：pi-rpc-client.ts:50-52 让真实进程用 `-real` 内部名、kernel 占公开名，是为了让代理能拦截。但 Pi 原生 intercom 的 session 注册机制（`session_joined`/`session_left`）已能让消息直接送达目标 agent。
3. **状态影子重复**：broker-proxy 维护 `pending: Map<key, PendingMessage[]>` 缓存（broker-proxy.ts:31, 140-152）和前端 `AskItem` 影子状态；而 Pi session 文件里 `custom_message(intercom_message)` 已是结构化持久记录。

结论：**broker-proxy 是结构化的、可工作的**，但它做的事 Pi 原生 intercom 已全部覆盖。保留它意味着维护两层等价逻辑，且 `-real` 内部名机制会让 Pi 原生的 `custom_message` 流无法被 HiAgent 直接消费（消息被代理吃掉重发）。因此废弃 broker-proxy、改用 Pi 原生 intercom，让消息直接走 Pi session 的结构化通道。

### 1.2 已验证的 Pi 原生能力

通过阅读 pi-coding-agent / pi-ai / pi-intercom 源码 + 分析真实 session jsonl 文件，确认 Pi 原生提供：

| 能力 | 证据 | HiAgent 是否在用 |
|---|---|---|
| 富消息模型（thinking/text/toolCall content blocks） | pi-ai types.d.ts:75-107, 144-156 | ❌ filter 掉 |
| toolResult 独立消息 + toolCallId 关联 | pi-ai types.d.ts:158-166; 真实 session 样本 | ❌ filter 掉 |
| session 自动持久化到 jsonl | `~/.pi/agent/sessions/**/*.jsonl` 真实文件 | ❌ 自建 session-store 重复 |
| `get_messages` RPC 返回 AgentMessage[] | rpc-mode.js:487-489 | ❌ 完全没用 |
| intercom 委派的结构化存储 | custom_message(customType:"intercom_message", details.from); session-manager.js:171-172 确认进 messages 数组 | ❌ 自建旁路系统 |
| `PI_CODING_AGENT_DIR` 环境变量重定向数据目录 | config.js:359-365 | ❌ 用默认 ~/.pi |

### 1.3 目标

- kernel 透传 Pi 的完整消息，不再拍扁
- 前端按 Pi 的 content block 类型分别渲染（思考折叠 / 正文 markdown / 工具调用折叠+关联结果 / 委派卡片）
- 废弃 HiAgent 自建的 session-store messages 持久化和 intercom 旁路系统
- 数据目录迁移到 `~/.hiagent`，与用户原生 pi 完全隔离
- 聊天布局改为微信式左右分栏，agent 显示角色头像和名字

## 2. 设计决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 消息持久化 | 完全用 Pi session 文件，废弃 session-store 的 messages | Pi 是 source of truth，不重复 |
| ChatMessage 类型 | 复用 Pi 的 Message 联合类型（user/assistant/toolResult）+ HiAgent 加 agentName 元信息 | 忠于 Pi 模型，前端按类型渲染 |
| 历史加载 | 用 `get_messages` RPC 从 Pi session 拉取 | 已验证返回完整 AgentMessage[] |
| intercom 委派 | 完全用 Pi 原生 intercom，废弃 BrokerProxyManager/IntercomMonitor/AskItem | 委派数据已在 session.messages 里结构化 |
| 数据目录 | `PI_CODING_AGENT_DIR=~/.hiagent/pi-agent`，完全隔离 | 用户确认：HiAgent 是独立产品 |
| broker socket | 保持共享 `~/.pi/agent/intercom/broker.sock` | intercom 本就是机器内协作，共享是功能不是 bug |
| 布局 | 微信式左右分栏，头像贴边 | 用户在原型对比中选定 |
| 思考/工具折叠 | 默认折叠，可点击展开 | 不干扰正文阅读 |
| 正文渲染 | 完整 markdown（react-markdown + remark-gfm） | agent 输出常含代码块/表格/列表 |

## 3. Pi 原生数据模型（验证结论）

### 3.1 三种消息类型（pi-ai types.d.ts:139-167）

```ts
UserMessage = {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

AssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];  // ← 富内容数组
  api, provider, model, responseModel?, responseId?;
  usage: Usage;  // token/cost 统计
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?;
  timestamp: number;
}

ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;   // ← 关联到 AssistantMessage.content 里的 ToolCall.id
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?;
  isError: boolean;
  timestamp: number;
}
```

### 3.2 Content block 类型（pi-ai types.d.ts:75-107）

```ts
TextContent      = { type: "text";     text: string; textSignature? }
ThinkingContent  = { type: "thinking"; thinking: string; thinkingSignature?; redacted? }
ToolCall         = { type: "toolCall"; id: string; name: string; arguments: Record<string,any>; thoughtSignature? }
```

### 3.3 intercom 委派的真实数据结构（真实 session 样本验证）

**发送方 session**（dev 调 intercom 问 pm）：

```json
// AssistantMessage 的 content 里有 toolCall block：
{ "type":"toolCall", "id":"call_00_xxx", "name":"intercom",
  "arguments":{ "action":"ask", "to":"pm", "message":"需求问题..." } }

// 紧跟一条独立的 ToolResultMessage（pm 回复后 Pi 自动填）：
{ "role":"toolResult", "toolCallId":"call_00_xxx", "toolName":"intercom",
  "content":[{ "type":"text", "text":"**Reply from pm:**\n需求是 XXX" }],
  "isError":false }
```

**接收方 session**（pm 收到 dev 的 ask，session-manager.js:171-172 确认进 messages 数组）：

```json
// custom_message：收到的委派消息
{ "type":"custom_message", "customType":"intercom_message", "display":true,
  "content":"**📨 From dev** (...)\n\n1+1 等于几？",
  "details":{ "from":{ "name":"dev", "cwd":"...", "id":"..." },
              "message":{ "id":"...", "expectsReply":true, "content":{"text":"..."} },
              "replyCommand":"intercom({ action: \"reply\", ... })",
              "bodyText":"..." } }

// custom：pm 回复后
{ "type":"custom", "customType":"intercom_sent",
  "data":{ "to":"dev", "message":{"text":"2","replyTo":"..."}, "messageId":"...", "timestamp":... } }
```

### 3.4 get_messages RPC（pi 源码 rpc-mode.js:487-489）

```js
case "get_messages": { return success(id, "get_messages", { messages: session.messages }); }
```

`session.messages` 类型是 `AgentMessage[]`（pi-agent-core agent-session.d.ts:284），含上述全部消息类型。

**注意**：这是 Pi 原生支持的能力，但 HiAgent **当前尚未接入**——`pi-rpc-client.ts` 的 `handleLine`（106-223 行）没有 `get_messages` 分支，`send()` 也无等待 response 的机制。本次重构需新增该能力（实现见 4.3.1）。引用的行号来自外部 pi 源码，不在本仓库内，以 pi 当时版本为准。

### 3.5 数据目录重定向（config.js:359-365）

```js
export function getAgentDir() {
    const envDir = process.env.PI_CODING_AGENT_DIR;  // 读环境变量
    if (envDir) return expandTildePath(envDir);
    return join(homedir(), ".pi/agent");  // 默认
}
```

设 `PI_CODING_AGENT_DIR=~/.hiagent/pi-agent` 后，Pi 会把 sessions/agents/auth/intercom 全部存到 `.hiagent` 下。`getSessionsDir()` 跟随 agentDir，无需单独配置。

### 3.6 broker socket（paths.ts:11-20）

```ts
export function getBrokerSocketPath(platform, homeDir) {
  if (platform === "win32") return `\\\\.\\pipe\\pi-intercom-${sanitize(homeDir)}`;
  return join(homeDir, ".pi/agent/intercom/broker.sock");  // ← 硬编码，不读环境变量
}
```

broker socket 不跟随 agentDir，固定在 `~/.pi/agent/intercom/broker.sock`。**这是符合预期的**：intercom 是机器内协作机制，所有 pi 进程（HiAgent 的 + 用户原生 pi 的）共享同一个 broker 网络是功能而非缺陷。

## 4. 架构设计

### 4.1 改造后的数据流

```
用户在 Composer 输入 → WS agent:prompt
  → kernel AgentManager.ensureStarted(projectId, agentName)
      env: { PI_CODING_AGENT_DIR: "~/.hiagent/pi-agent", ...process.env }
  → PiRpcClient.prompt()
  → pi 进程流式输出（事件 + 持久化到 .hiagent/pi-agent/sessions/）：
      message_start → 创建流式消息占位
      message_update(thinking_delta) → 累积 thinking content block
      message_update(text_delta)     → 累积 text content block
      message_update(toolcall_end)   → 记录 toolCall content block
      tool_execution_start/end       → 不再单独处理（结果在 toolResult 消息里）
      message_end → 透传完整 AssistantMessage（含 content blocks 数组）
      [若 stopReason=toolUse] 下一个 turn 的 message_end 是 ToolResultMessage
  → WS agent:message { message: <完整 AgentMessage>, agentName }
  → SessionView onMessage → useSessionStore.append
  → MessageBubble 按 content block 类型渲染

切会话加载历史：
  → WS session:messages { sessionId }
  → kernel PiRpcClient.send({ type:"get_messages" })
  → pi 返回 { messages: AgentMessage[] }
  → WS session:messages 回前端 → store.setMessages
```

### 4.2 数据类型设计（`packages/shared/src/types.ts`）

不再自建 `ChatMessage`，复用 Pi 的 `AgentMessage` 联合类型。由于 Pi 的类型来自 `@mariozechner/pi-ai` 和 `@mariozechner/pi-agent-core`，HiAgent 需要声明这些类型（不引入运行时依赖，只用类型）：

```ts
// 从 pi-ai 镜像的最小类型集（避免运行时依赖 pi-ai）
// 说明：Pi 原生类型还带 textSignature/thinkingSignature/redacted/thoughtSignature 等签名/脱敏字段
// （见 3.2 节）。前端渲染用不到这些字段，这里按"最小可渲染集"省略。
// 严格忠于 Pi 类型时，从 @mariozechner/pi-ai 直接 import type 即可（无运行时开销）。
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
  // 简化：忽略 usage/api/provider/responseModel/responseId/errorMessage 等前端用不到的字段（可后续按需补）
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
// ⚠️ 关键：Pi 真实数据里，这类消息的区分字段是顶层 type，不是 role
// （见 3.3 节真实 session 样本：{"type":"custom_message",...} / {"type":"custom",...}）
// 因此用 'custom_message' | 'custom' 作为 type 字面量，而非 role。
export interface CustomMessage {
  type: "custom_message" | "custom";   // ← Pi 顶层 type，不是 role
  customType: string;                   // "intercom_message" / "intercom_sent" / ...
  display?: boolean;
  content?: string;
  details?: unknown;
  timestamp: number;
}

// AgentMessage 是 Pi 的联合类型。前三者（user/assistant/toolResult）用 role 字段区分；
// CustomMessage 没有 role 字段，用顶层 type 区分（见 3.3 节真实样本）。
// 联合判别时：先判 "type" in msg && msg.type 是 custom* → CustomMessage；否则按 msg.role 分流。
export type RoleMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = RoleMessage | CustomMessage;
```

HiAgent 在 `AgentMessage` 上加一层投影，绑定 HiAgent 自己的元信息（哪个 agent 发的）：

```ts
// HiAgent 投影：一条 Pi 消息 + HiAgent 元信息
export interface SessionMessage {
  message: AgentMessage;     // Pi 原生消息，原样透传
  agentName?: AgentName;     // 哪个 agent 发的（assistant/toolResult 才有）
  // 注意：不再有 text/thinking/toolCalls 字段，全部从 message.content 取
}
```

**向后兼容**：旧 session-store JSON 文件（拍扁的 text）会失效。由于这是架构重构，接受历史数据不兼容（或写一次性迁移脚本把旧 text 包装成 `AssistantMessage{content:[{type:"text",text}]}`，作为可选增强）。

### 4.3 kernel 改造

#### 4.3.1 `pi-rpc-client.ts` —— 透传完整消息

废弃流式累积器的 `streamingText`/`streamingThinking`/`streamingToolCalls` 分离累积，改为**累积完整的 content 数组**：

```ts
private streamingContent: any[] = [];  // 完整 content blocks

// message_update：按 evt.type 追加/更新 content 数组的对应 block
case "message_update": {
  const evt = obj.assistantMessageEvent;
  if (!evt) break;
  // 用 evt.partial（Pi 已累积的完整 partial message）直接覆盖，最简单可靠
  if (evt.partial?.content) {
    this.streamingContent = evt.partial.content;
  }
  this.emitStreamingMessage();
  break;
}

// message_end：透传 Pi 给的完整 message（不再 filter）
case "message_end": {
  const msg = obj.message;
  if (msg?.role === "assistant") {
    this.opts.onEvent({
      kind: "message",
      message: msg,   // ← 原样透传，含完整 content 数组、usage、stopReason
      agentName: this.opts.agentName,
    });
  }
  break;
}
```

**关键简化**：`message_update` 用 `evt.partial.content`（Pi 流式期间维护的完整累积状态）直接覆盖，比手动按 delta 拼接更可靠。`message_end` 直接透传 `obj.message`，零处理。

新增 `getMessages()` 方法供历史加载调用。注意：pi-rpc-client 当前的 stdout 用 `toNodeStream` 封装（handlers 数组模式，非标准 EventEmitter），且 `handleLine` 是统一的行分发入口。实现方式：在 `pendingRpcResolvers: Map<id, resolve>` 注册 resolver，`handleLine` 的 `case "response"`（当前 111-124 行）里按 id 匹配并 resolve。

**关键**：当前 `send()` 方法（pi-rpc-client.ts:98-104 行）会自动 `id: ++this.pendingId`。为避免 getMessages 占一次 id、send 内部又占一次导致 id 不匹配，**让 send 接受可选 id 参数**，getMessages 先占 id 再传给 send：

```ts
// 类成员新增
private pendingRpcResolvers = new Map<number, (data: unknown) => void>();

// send 改造：接受可选 id（getMessages 先占 id 后传入，避免重复自增）
private async send(obj: unknown, preoccupiedId?: number): Promise<void> {
  if (!this.child) throw new Error("PiRpcClient 未启动");
  const payload = typeof obj === "object" && obj !== null
    ? { ...(obj as object), id: preoccupiedId ?? ++this.pendingId }
    : obj;
  this.child.stdin.write(JSON.stringify(payload) + "\n");
}

// handleLine 的 case "response" 扩展（当前 111-124 行只处理 success:false，加 success:true 分发）
case "response": {
  if (obj.success === false) {
    // ... 现有错误处理
  } else if (obj.success === true && obj.id) {
    // 新增：按 id 匹配 pending resolver
    const resolver = this.pendingRpcResolvers.get(obj.id);
    if (resolver) {
      this.pendingRpcResolvers.delete(obj.id);
      resolver(obj.data);
    }
  }
  break;
}

// 新增公开方法
async getMessages(): Promise<AgentMessage[]> {
  const id = ++this.pendingId;  // 先占 id
  return new Promise((resolve) => {
    this.pendingRpcResolvers.set(id, (data: any) => resolve(data?.messages ?? []));
    this.send({ type: "get_messages" }, id);  // 传入已占的 id，send 内不再自增
  });
}
```

`PiEvent` 类型扩展：

```ts
export type PiEvent =
  | { kind: "message"; message: AgentMessage; agentName: AgentName }  // ← 改：原样 AgentMessage + agentName
  | { kind: "state"; state: AgentState }
  | { kind: "intercom:ask"; ask: AskItem }   // ← 废弃（见 4.4）
  | { kind: "intercom:reply"; askMessageId: string }  // ← 废弃
  | { kind: "error"; message: string };
```

#### 4.3.2 数据目录迁移

`agent-manager.ts` spawn pi 时传环境变量：

```ts
const client = new PiRpcClient({
  agentName,
  cwd: project.cwd,
  sessionId: `${projectId}-${agentName}`,
  config,
  spawnFn: this.opts.spawnFn,
  onEvent: ...,
  env: {  // ← 新增
    PI_CODING_AGENT_DIR: HIAGENT_PI_AGENT_DIR,  // ~/.hiagent/pi-agent
  },
});
```

`pi-rpc-client.ts` 的 `defaultSpawn` 把 env 传给 `Bun.spawn`（当前已传 `process.env`，改为合并）。

`shared/constants.ts` 同步：

```ts
export const HIAGENT_DIR = env.HIAGENT_DIR || `${HOME}/.hiagent`;
export const HIAGENT_PI_AGENT_DIR = `${HIAGENT_DIR}/pi-agent`;  // ← 新增：Pi 数据目录（sessions/agents/auth/intercom）
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const SESSIONS_DIR = `${HIAGENT_DIR}/sessions`;  // ← 保留（HiAgent 自管元数据，不含 messages）
export const PI_AGENTS_DIR = `${HIAGENT_DIR}/agents`;  // ← 改：从 ~/.pi/agent/agents 改为 .hiagent/agents（HiAgent 自管的 agent 配置）
```

**配置与数据的分层**（回应"socket 共享但配置隔离"的口径一致性问题）：
- **隔离**：HiAgent 的 agent 配置（`.hiagent/agents/*.md`）、Pi 运行数据（`.hiagent/pi-agent/sessions|auth`）——这些是 HiAgent 这个**独立产品**的私有产物，不污染用户原生 pi。
- **共享**：broker socket（`~/.pi/agent/intercom/broker.sock`）——intercom 是**机器内协作机制**，HiAgent 的 agent 与用户原生 pi 的 agent 共处同一个 broker 网络是功能需求（否则两者无法互相委派）。
- **迁移**：首次启动检测 `~/.pi/agent/agents/*.md` 存在时，提示用户是否复制到 `.hiagent/agents`（可选增强，见风险表）。`ConfigStore`（config-store.ts:8）默认构造改注入 `PI_AGENTS_DIR` 常量。

**首次启动迁移**（kernel 启动时检测）：

```ts
// 若 .hiagent/pi-agent 不存在 且 ~/.pi/agent 存在，提示前端引导用户
// 可选：自动复制 auth.json（不复制 sessions/agents，避免污染）
```

#### 4.3.3 废弃 session-store 的 messages 持久化

`session-store.ts` 的 `messages` 字段废弃。`SessionFile` 只保留 HiAgent 自己的元数据（如果有，如自定义会话标题）。历史消息一律走 `get_messages` RPC。

涉及改动：
- `session-store.ts`：`loadMessages`/`appendMessage` 删除或改为 no-op
- `ws-server.ts`：`session:messages` 请求改为调 `PiRpcClient.getMessages()` 转发
- WS 协议 `SessionMessagesEvent`：`messages: SessionMessage[]`（从 ChatMessage 改）

#### 4.3.4 废弃 intercom 旁路系统（改用 Pi 原生 intercom）

> 承接 1.1 节"错误三"：broker-proxy 是结构化、可工作的，但它做的事 Pi 原生 intercom 已全部覆盖（路由 / session 注册 / 历史持久化）。废弃后消息直接走 Pi session 的结构化通道（`toolCall(intercom)` + `toolResult` + `custom_message`），不再经 kernel relay 转发。

删除：
- `broker-proxy.ts`（整个文件，237 行）
- `intercom-monitor.ts`（整个文件）
- `index.ts` 里对两者的初始化与导入（当前 index.ts:5-6 导入、44-58 初始化、29-32 onDispose 回调里的 `brokerProxy.onAgentOffline`）
- WS 协议：`InjectReplyEvent`、`IntercomAskEvent`、`IntercomReplyEvent`、`AskItem`（shared/types.ts）
- 前端 `store/intercom.ts`（整个文件）
- 前端 `components/AskCard.tsx`（整个文件）
- 前端 `SessionView.tsx` 的清理（共 4 处引用，逐行删）：
  - 第 3 行 `import { useIntercomStore }`
  - 第 8 行 `import { AskCard }`（注：非第 7 行，第 7 行是 `import { Composer }`）
  - 第 21 行 `const asks = useIntercomStore(...)`
  - 第 33-34 行 `onMessage` 里的 `intercom:ask`/`intercom:reply` 分支
  - 第 51-57 行 header 里的 `activeAsk` 徽章
  - 第 64 行 `{asks.map(a => <AskCard .../>)}`

`SessionView` 顶部已有的 `EMPTY_ASKS` 常量（第 14 行）一并删除。

**intercom 功能不丢失**：Pi 的 pi-intercom 扩展仍正常工作（broker 自动起、消息自动路由、custom_message 自动存 session）。用户在 dev 的对话里看到 `toolCall(intercom)` → `toolResult` 就知道委派发生了。

### 4.4 前端 UI

#### 4.4.1 组件结构

```
MessageList
  └─ MessageRow(sessionMsg)              ← 一条 SessionMessage
      ├─ Avatar(isUser, agentName)       ← 头像列，左右贴边
      └─ BubbleBody
          ├─ Header(角色名 · 时间)
          ├─ ContentBlocks 渲染(message.content)  ← 遍历 content 数组
          │   ├─ ThinkingBlock → 折叠面板"思考过程"
          │   ├─ TextBlock → markdown 正文
          │   └─ ToolCallBlock → 委派卡片 或 工具调用折叠面板
          └─ (toolResult 不单独成行，按 toolCallId 关联到上面的 ToolCallBlock 下方)
```

**toolResult 关联逻辑**：`MessageList` 拿到 `SessionMessage[]` 后，预处理成"主消息 + 关联结果"结构：

```ts
interface RenderedMessage {
  main: SessionMessage;                    // user / assistant / custom_message
  toolResults: Map<toolCallId, ToolResultMessage>;  // 按 toolCallId 收集的 toolResult
}
// 遍历 messages 时，toolResult 不独立渲染，而是塞进前一个 assistant 消息的 toolResults map
```

#### 4.4.2 左右分栏（用户在原型中选定的方案 A）

```tsx
const isUser = msg.message.role === "user";
<div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
  <Avatar isUser={isUser} agentName={msg.agentName} />
  <BubbleBody msg={msg} />
</div>
```

#### 4.4.3 头像

```tsx
function Avatar({ isUser, agentName }) {
  if (isUser) return <div style={{background:"linear-gradient(135deg,#6c7086,#9399b2)"}}>我</div>;
  const name = agentName ?? "dev";
  return <div style={{background:agentGradient(name)}}>{agentEmoji(name)}</div>;
}
```

#### 4.4.4 ContentBlocks 渲染

```tsx
function BubbleBody({ msg, toolResults }) {
  const m = msg.message;
  const speakerName = useDisplayName(msg.agentName);
  return (
    <div className="bubble">
      <Header name={isUser ? "我" : speakerName} time={m.timestamp} />
      {m.role === "user" && <UserText content={m.content} />}
      {m.role === "assistant" && m.content.map((block, i) => (
        <ContentBlockRenderer key={i} block={block} toolResults={toolResults} />
      ))}
      {/* CustomMessage 没有 role 字段，用顶层 type 区分（见 4.2 类型定义） */}
      {"type" in m && m.type === "custom_message" && m.customType === "intercom_message" && (
        <DelegateReceived details={m.details} />
      )}
    </div>
  );
}

function ContentBlockRenderer({ block, toolResults }) {
  switch (block.type) {
    case "thinking":
      return <ThinkingPanel thinking={block.thinking} />;
    case "text":
      return <Markdown text={block.text} />;
    case "toolCall":
      if (block.name === "intercom") {
        // intercom 工具调用 → 渲染成委派卡片
        return <DelegateCard toolCall={block} result={toolResults.get(block.id)} />;
      }
      // 其它工具 → 普通工具调用折叠面板
      return <ToolCallPanel toolCall={block} result={toolResults.get(block.id)} />;
  }
}
```

#### 4.4.5 委派卡片（intercom toolCall 专用样式）

```tsx
function DelegateCard({ toolCall, result }) {
  const args = toolCall.arguments;  // { action, to, message }
  const targetName = useDisplayName(args.to as AgentName);
  return (
    <div className="delegate-card" style={{border:"1px solid rgba(250,179,135,0.3)"}}>
      <div className="dc-header" style={{color:"#fab387"}}>
        ↪ 委派给 {targetName} · {args.action === "ask" ? "等待回复" : "已通知"}
      </div>
      <div className="dc-body">
        <div className="ask">📋 提问：{args.message}</div>
        {result && (
          <div className="reply" style={{borderLeft:"2px solid #a6e3a1"}}>
            <div style={{color:"#a6e3a1"}}>✓ {targetName} 的回复</div>
            <ExtractReplyText content={result.content} />
            {/* 说明：这里解析 "Reply from X:\n..." 是 Pi 原生 intercom 在 toolResult.content
                里固化写入的文本约定（见 3.3 节样本），不是 HiAgent 自创的脆弱文本协议。
                与 1.1 节"错误三"批判的"旁路系统文本解析"不同维度：那是解析用户对话正文，
                这是解析 Pi 自己产出的结构化约定文本。 */}
          </div>
        )}
      </div>
    </div>
  );
}
```

#### 4.4.6 新增依赖

```json
"react-markdown": "^9.0.0",
"remark-gfm": "^4.0.0"
```

#### 4.4.7 不改动部分（精准修改）

- `Composer.tsx` / `SessionView` header / Sidebar / Canvas 不动
- agent 配置（AgentConfig 弹窗）不动
- Zustand store 结构基本不动（session store 的 ChatMessage 类型换成 SessionMessage）

## 5. 验收标准（四层测试）

### 5.1 单元测试（kernel, bun:test）

- [ ] `pi-rpc-client` message_end 透传完整 AssistantMessage（含 content blocks，不再 filter）
- [ ] `pi-rpc-client` getMessages() 返回 AgentMessage[]
- [ ] spawn pi 时 env 含 `PI_CODING_AGENT_DIR`
- [ ] `HIAGENT_PI_AGENT_DIR` 常量正确指向 `~/.hiagent/pi-agent`
- [ ] SessionMessage 类型序列化/反序列化

### 5.2 组件测试（前端, Vitest + testing-library）

- [ ] MessageRow user 靠右、assistant 靠左
- [ ] ContentBlockRenderer 按 block.type 渲染对应组件
- [ ] thinking block → 折叠面板默认收起
- [ ] toolCall(intercom) → DelegateCard（橙色），其它 toolCall → ToolCallPanel（蓝色）
- [ ] toolResult 按 toolCallId 关联到对应 toolCall 下方
- [ ] custom_message(intercom_message) 渲染委派接收卡片
- [ ] markdown 正文渲染（代码块/表格）

### 5.3 API 接口测试（curl/WS，需运行服务）

- [ ] WS agent:message 事件携带完整 AgentMessage（content blocks 数组）
- [ ] WS session:messages 返回 get_messages 结果（AgentMessage[]）
- [ ] pi 进程的 session 文件落在 `~/.hiagent/pi-agent/sessions/` 而非 `~/.pi/`

### 5.4 E2E（Playwright）

- [ ] 发送 prompt → 看到 agent 头像/角色名/思考折叠/工具调用折叠
- [ ] 触发 intercom 委派 → 看到橙色委派卡片 + 绿色回复
- [ ] 切换会话 → 历史消息（含思考/工具/委派）正确加载
- [ ] 截图清理：测试截图全部删除

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 历史拍扁数据不兼容 | 旧 session-store JSON 失效 | 接受不兼容；可选写迁移脚本把 text 包装成 AssistantMessage |
| `evt.partial.content` 流式可靠性 | 流式期间 UI 闪烁 | message_end 以最终消息为准；流式期间显示 partial |
| pi-intercom 不在 PATH | broker 起不来，intercom 失效 | 已有降级逻辑（intercom-monitor connectReal 失败时降级），保留降级思路 |
| 删除 broker-proxy/intercom-monitor 影响面 | 索引文件、ws-server 依赖 | 精确删除 + 类型检查保证不漏 |
| `~/.hiagent/pi-agent/auth.json` 首次不存在 | pi 启动失败（无 API key） | 首次启动检测 + 前端引导用户配置 |
| PI_AGENTS_DIR 改路径（`~/.pi/agent/agents` → `~/.hiagent/agents`） | 用户在原生 pi 里已配的 agent.md 不会自动出现在 HiAgent | 首次启动检测 `~/.pi/agent/agents/*.md` 存在时提示复制（可选）；`ConfigStore` 改注入 `PI_AGENTS_DIR` 常量 |
| broker socket 共享 vs 配置隔离口径 | 看似逻辑矛盾 | 实为分层：数据/配置是"独立产品私有"，broker 是"机器内协作共享"，两者维度不同（见 4.3.2 分层说明） |

## 7. 范围边界

**本次包含：**
- shared/types.ts：Pi 消息类型镜像 + SessionMessage
- kernel：pi-rpc-client 透传 + getMessages + PI_CODING_AGENT_DIR env
- kernel：废弃 session-store messages、broker-proxy、intercom-monitor
- frontend：MessageRow/ContentBlockRenderer/DelegateCard 等新组件
- frontend：废弃 useIntercomStore/AskCard
- constants：HIAGENT_PI_AGENT_DIR、PI_AGENTS_DIR 改路径
- 四层测试

**本次不包含：**
- Composer 加 abort 按钮（独立需求）
- 代码块语法高亮（后续按需）
- 旧 session-store JSON 迁移脚本（可选增强，单独任务）
- Canvas / Sidebar 改动
