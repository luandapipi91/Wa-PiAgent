# 聊天界面优化设计

- **日期**: 2026-07-07
- **主题**: 聊天界面重构 —— 微信式左右分栏、agent 角色头像、思考过程与工具调用折叠展示
- **状态**: 待评审

## 1. 背景与目标

### 1.1 当前问题

`MessageBubble`(`packages/frontend/src/components/MessageList.tsx`)现状:

1. **无头像** — 仅显示文字 "你"/"agent",项目已有的 `AGENT_DEFS`(emoji + 渐变色)素材未使用
2. **无左右分栏** — user 与 assistant 均靠左 `flex gap-2` 排列
3. **agent 身份不可见** — 一律显示 "agent",不区分 product/pm/dev/test
4. **无思考过程** — kernel `pi-rpc-client.ts:155` 明确跳过 `thinking_delta`,前端永远拿不到
5. **无工具调用** — `message_end` 处理 `filter(c.type === "text")` 丢弃 `tool_use`;前端 0 处涉及 tool_call
6. **纯文本渲染** — `whitespace-pre-wrap`,代码块/列表/表格无样式

### 1.2 用户需求

- agent 回复显示当前角色名和角色头像,而不是 "agent"
- 用户显示 "我" + 默认头像
- 聊天布局为左右结构,类似微信
- agent 的思考过程、工具调用及结果应显示出来,同一次对话所有的思考和工具调用详情可折叠

### 1.3 成功标准

发送一条 prompt 后,在浏览器中能观察到:

- [ ] 用户消息靠右、agent 消息靠左,头像在气泡外侧贴边
- [ ] agent 消息显示对应 emoji 头像和角色名(如 "技术实现")
- [ ] 用户消息显示 "我" 和灰色默认头像
- [ ] agent 回复气泡内有可折叠的"思考过程"和"N 个工具调用"面板
- [ ] 点击展开能看到思考全文和每个工具的 name/args/result
- [ ] markdown 正文(代码块、表格、列表)正确渲染

## 2. 设计决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 改造范围 | 全链路打通(前端 + 数据结构 + kernel) | 思考/工具数据需 kernel 采集,半改无法验证 |
| 布局 | 方案 A · 头像贴边 | 用户在可视化对比中选定,最贴近微信观感 |
| 头像 | agent 用 `AGENT_DEFS` emoji + 渐变色圆形;user 灰色渐变 + "我"字 | 复用现有素材,保持视觉一致 |
| 角色名 | agent 显示 `AgentConfig.displayName`(用户自定义),fallback 到 `AGENT_DEFS.label`;user 显示"我" | 优先尊重用户在 agent.md 里的定制,静态常量兜底保证首屏稳定 |
| 多 agent | 逐消息区分,每条消息按自身 `agentName` 显示 | 体现多 agent 编排价值,委派链路可见 |
| 思考/工具 | 默认折叠,可点击展开 | 不干扰正文阅读 |
| 正文渲染 | 完整 markdown(GFM) | agent 输出常含代码块/表格/列表 |
| 委派标签 | `delegatedFrom` 存在时显示橙色药丸 "↪ 受 X 委派" | 让 intercom 委派关系可见 |

## 3. 架构设计

三层全链路改造,自底向上:

```
┌─ 第 3 层:前端 UI ──────────────────────────────────────────┐
│  MessageList → MessageBubble(左右分栏 + 头像)              │
│    └ Markdown 正文 + CollapsibleSection(thinking/toolCalls) │
└───────────────────────────────────────────────────────────┘
         ▲ WS agent:message 事件(携带 thinking/toolCalls/agentName)
┌─ 第 2 层:kernel 数据采集 ─────────────────────────────────┐
│  pi-rpc-client.handleLine:                                  │
│    message_update: 累积 thinking_delta + 捕获 toolcall_end │
│    tool_execution_start/end: 回填工具 result               │
│    推送时填 agentName                                       │
└───────────────────────────────────────────────────────────┘
         ▲ pi RPC 事件流(thinking_delta / toolcall_end / tool_execution_*)
┌─ 第 1 层:数据结构 ────────────────────────────────────────┐
│  ChatMessage 扩展: agentName / delegatedFrom /             │
│                   thinking / toolCalls[]                    │
│  新增: ToolCallRecord                                       │
└───────────────────────────────────────────────────────────┘
```

## 4. 详细设计

### 4.1 数据结构(`packages/shared/src/types.ts`)

新增工具调用记录类型:

```ts
export interface ToolCallRecord {
  id: string;          // toolCallId,跨 message_update 与 tool_execution_* 关联
  name: string;        // 工具名(如 read_file)
  args: unknown;       // 参数对象
  result?: unknown;    // 执行结果,由 tool_execution_end 回填
  isError?: boolean;   // 是否出错
  startedAt: number;   // tool_execution_start 时间
  endedAt?: number;    // tool_execution_end 时间
}
```

扩展 `ChatMessage`(所有新字段可选,向后兼容):

```ts
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  // 新增字段
  agentName?: AgentName;           // assistant 消息:发言的 agent
  delegatedFrom?: AgentName;       // assistant 消息:委派来源(intercom 场景)
  thinking?: string;               // 思考过程全文
  toolCalls?: ToolCallRecord[];    // 本轮工具调用记录
}
```

**向后兼容**:历史 session JSON 文件没有这些字段,`session-store.ts` 读取时新字段为 `undefined`,`MessageBubble` 按缺省处理(不渲染思考/工具面板)。

### 4.2 kernel 数据采集(`packages/kernel/src/pi-rpc-client.ts`)

#### 4.2.1 流式累积器扩展

当前类成员:

```ts
private streamingMsgId = "";
private streamingText = "";
```

新增:

```ts
private streamingThinking = "";
private streamingToolCalls: ToolCallRecord[] = [];
```

`message_start` 时三者一起重置。

#### 4.2.2 `message_update` 处理改造

当前只处理 `text_delta`,改为:

```ts
case "message_update": {
  const evt = obj.assistantMessageEvent;
  if (!evt) break;
  switch (evt.type) {
    case "text_delta":
    case "text":                          // 兼容旧协议
      this.streamingText += evt.delta ?? "";
      break;
    case "thinking_delta":
      this.streamingThinking += evt.delta ?? "";
      break;
    case "toolcall_end":
      this.streamingToolCalls.push({
        id: evt.toolCall.id,
        name: evt.toolCall.name,
        args: evt.toolCall.input,
        startedAt: Date.now(),
      });
      break;
    // thinking_start/text_start/toolcall_start 等边界事件不处理
  }
  this.emitStreamingMessage();            // 统一推送当前累积状态
  break;
}
```

`emitStreamingMessage()` 封装当前已有的推送逻辑,补上 thinking/toolCalls/agentName 字段。

#### 4.2.3 工具执行事件处理(新增 case)

```ts
case "tool_execution_start":
  // 记录开始时间(若 toolcall_end 已建记录则更新,否则新建占位)
  this.updateToolCall(obj.toolCallId, { startedAt: Date.now() });
  this.emitStreamingMessage();
  break;

case "tool_execution_end":
  this.updateToolCall(obj.toolCallId, {
    result: obj.result,
    isError: obj.isError,
    endedAt: Date.now(),
  });
  this.emitStreamingMessage();
  break;
```

`updateToolCall(id, patch)`:按 id 匹配 `streamingToolCalls`,存在则合并 patch,不存在则插入新记录。

#### 4.2.4 `message_end` 处理

最终推送从 `content` 提取时,同时保留流式累积的 thinking/toolCalls(若 content 里有 thinking/toolCall block,优先用流式累积值,因为更完整):

```ts
case "message_end": {
  const msg = obj.message;
  if (msg?.role !== "assistant") break;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const text = content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
  this.emitFinalMessage(text || this.streamingText);
  // 重置所有累积器
  this.streamingMsgId = "";
  this.streamingText = "";
  this.streamingThinking = "";
  this.streamingToolCalls = [];
  break;
}
```

#### 4.2.5 agentName 与 delegatedFrom 注入

- **`agentName`**:PiRpcClient 在构造每条 message 时填入 `this.opts.agentName`。一个 PiRpcClient 实例对应一个 agent,天然满足。
- **`delegatedFrom`**:intercom 委派场景下,当 agent 通过 `intercom:inject-reply` 回复一个 ask 时,该 agent 随后产生的 assistant 消息应标记委派来源。实现方式:
  - `IntercomMonitor.injectReply()`(`intercom-monitor.ts:72`)返回时,记录 `pendingDelegation: Map<askMessageId, fromAgent>`(`fromAgent` 从 `allAsks.get(askMessageId).from` 取得)
  - 在 PiRpcClient 上新增 `setDelegationFrom(from: AgentName)`:设置一个临时标记,下一次 `message_start` 创建的流式消息带上 `delegatedFrom = from`,message_end 后清除标记
  - 调用链:`ws-server.ts:151` 收到 `intercom:inject-reply` → 调用 `injectReply()` → 同时调用目标 agent 的 PiRpcClient `setDelegationFrom(ask.from)` → 之后该 agent 的流式回复自动带 `delegatedFrom`
  - **若实现复杂度超预期**:首版可先不做 delegatedFrom(仅显示 agentName),作为后续增强项

### 4.3 前端 UI(`packages/frontend/src/components/MessageList.tsx`)

#### 4.3.1 组件结构

```
MessageList
  └─ MessageBubble(msg)
      ├─ Avatar                              // 头像列,左右贴边
      └─ BubbleBody
          ├─ Header(角色名 · 时间 · ↪委派标签)
          ├─ Markdown(text)                  // 正文
          └─ CollapsibleSection              // 默认折叠
              ├─ thinking("▸ 思考过程 · 8s")
              └─ toolCalls("▸ N 个工具调用")
```

#### 4.3.2 左右分栏

```tsx
const isUser = msg.role === "user";
<div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
  <Avatar isUser={isUser} agentName={msg.agentName} />
  <BubbleBody msg={msg} isUser={isUser} />
</div>
```

#### 4.3.3 头像组件

```tsx
function Avatar({ isUser, agentName }: { isUser: boolean; agentName?: AgentName }) {
  if (isUser) {
    return (
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold"
           style={{ background: "linear-gradient(135deg, #6c7086, #9399b2)", color: "#cdd6f4" }}>
        我
      </div>
    );
  }
  const name = agentName ?? "dev";   // 兜底
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg"
         style={{ background: agentGradient(name) }}>
      {agentEmoji(name)}
    </div>
  );
}
```

#### 4.3.4 BubbleBody 与折叠面板

角色名优先取用户在 agent.md 配置的 `AgentConfig.displayName`,fallback 到静态 `AGENT_DEFS.label`。displayName 通过 `useAgentsStore` 获取(组件 mount 时触发 `loadConfig` 已有的预加载逻辑):

```tsx
function useDisplayName(name?: AgentName): string {
  const config = useAgentsStore(s => name ? s.configs[name] : undefined);
  if (!name) return "agent";
  return config?.displayName || AGENT_DEFS[name].label;
}

function BubbleBody({ msg, isUser }: { msg: ChatMessage; isUser: boolean }) {
  const hasThinking = !!msg.thinking;
  const toolCount = msg.toolCalls?.length ?? 0;
  const speakerName = useDisplayName(msg.agentName);
  const delegatorName = useDisplayName(msg.delegatedFrom);
  return (
    <div className="max-w-[78%] px-3.5 py-2" style={{ /* 气泡背景/圆角 */ }}>
      {/* Header:角色名 · 时间 · 委派标签 */}
      <div className="text-xs text-overlay mb-1 flex items-center gap-2">
        <span>{isUser ? "我" : speakerName}</span>
        {!isUser && msg.delegatedFrom && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px]"
                style={{ background: "rgba(250,179,135,0.15)", color: "#fab387" }}>
            ↪ 受 {delegatorName} 委派
          </span>
        )}
      </div>
      {/* 正文 markdown */}
      <div className="text-sm prose prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
      </div>
      {/* 折叠面板:仅 assistant 且有内容时渲染 */}
      {!isUser && (hasThinking || toolCount > 0) && (
        <CollapsibleSection thinking={msg.thinking} toolCalls={msg.toolCalls} />
      )}
    </div>
  );
}
```

#### 4.3.5 CollapsibleSection

```tsx
function CollapsibleSection({ thinking, toolCalls }: { thinking?: string; toolCalls?: ToolCallRecord[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      {thinking && (
        <details className="rounded-lg border border-overlay/20 bg-overlay/5">
          <summary className="px-2.5 py-1 text-xs text-blue cursor-pointer">思考过程</summary>
          <div className="px-3 py-2 text-xs text-subtext whitespace-pre-wrap border-t border-overlay/10">
            {thinking}
          </div>
        </details>
      )}
      {(toolCalls?.length ?? 0) > 0 && (
        <details className="rounded-lg border border-overlay/20 bg-overlay/5">
          <summary className="px-2.5 py-1 text-xs text-blue cursor-pointer">
            {toolCalls!.length} 个工具调用
          </summary>
          <div className="px-3 py-2 space-y-1.5 border-t border-overlay/10">
            {toolCalls!.map(tc => <ToolCallRow key={tc.id} tc={tc} />)}
          </div>
        </details>
      )}
    </div>
  );
}
```

#### 4.3.6 工具调用行

```tsx
function ToolCallRow({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const resultStr = tc.result != null ? formatResult(tc.result) : "(执行中…)";
  return (
    <div className="text-xs">
      <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-2 w-full text-left">
        <span className="text-green font-mono">{tc.name}</span>
        <span className="text-overlay font-mono text-[11px]">{truncate(JSON.stringify(tc.args), 60)}</span>
        {tc.isError && <span className="text-red">✗</span>}
      </button>
      {expanded && (
        <pre className="mt-1 p-2 bg-base rounded text-[11px] overflow-x-auto">
          {resultStr}
        </pre>
      )}
    </div>
  );
}

// result 超过 2000 字符截断,末尾加 "...(已截断,共 N 字符)"
function formatResult(r: unknown): string {
  const s = typeof r === "string" ? r : JSON.stringify(r, null, 2);
  return s.length > 2000 ? s.slice(0, 2000) + `\n...(已截断,共 ${s.length} 字符)` : s;
}
```

#### 4.3.7 新增依赖

```json
// packages/frontend/package.json
"react-markdown": "^9.0.0",
"remark-gfm": "^4.0.0"
```

代码块语法高亮暂不引入 `react-syntax-highlighter`(避免 +150KB bundle),用 `<pre>` + Catppuccin 配色背景即可,后续按需加。

### 4.4 不改动的部分(精准修改原则)

- `Composer.tsx` / `SessionView.tsx` header / `AskCard` / Sidebar / Canvas 全部不动
- `store/session.ts` 的 `append` upsert 逻辑已有,天然支持增量字段更新(同 id 合并)
- 错误消息仍用 `⚠️` 前缀判定(本次不动)
- `MessageList.test.tsx` 现有断言会随组件改造同步更新(属于本次改动范围)

## 5. 数据流(改造后)

```
用户在 Composer 输入 → WS agent:prompt
  → kernel PiRpcClient.prompt()
  → pi 进程流式输出:
      agent_start → state:thinking
      message_start → 创建 streamingMsgId,推空消息占位
      message_update(thinking_delta) → 累积 thinking,推送(含 thinking 字段)
      message_update(text_delta)     → 累积 text,推送(含 text 字段)
      message_update(toolcall_end)   → 记录 toolCall,推送(含 toolCalls)
      tool_execution_start           → 回填 startedAt,推送
      tool_execution_end             → 回填 result/isError,推送
      message_end                    → 推送最终完整消息,重置累积器
      turn_end → state:idle
  → WS agent:message(每条带 agentName/thinking/toolCalls)
  → SessionView onMessage → useSessionStore.append(upsert 同 id)
  → MessageBubble 重渲染(头像/角色名/markdown/折叠面板实时更新)
```

## 6. 验收标准(四层测试)

### 6.1 单元测试(kernel, `bun:test`)

- [ ] `pi-rpc-client` 处理 `thinking_delta` 事件 → message 事件携带累积的 thinking
- [ ] `pi-rpc-client` 处理 `toolcall_end` → toolCalls 含 name/args
- [ ] `pi-rpc-client` 处理 `tool_execution_end` → 对应 toolCall 回填 result/isError/endedAt
- [ ] `message_end` 推送的消息含所有累积字段(thinking/toolCalls/agentName)
- [ ] `ChatMessage` 新字段序列化/反序列化(`session-store` 往返)

### 6.2 组件测试(前端, Vitest + testing-library)

- [ ] `MessageBubble` user 消息靠右、assistant 靠左(class 断言)
- [ ] assistant 头像渲染对应 emoji(`AGENT_DEFS[name].emoji`)
- [ ] 角色名显示 `AGENT_DEFS[name].label`,user 显示"我"
- [ ] `delegatedFrom` 存在时渲染委派药丸,不存在时不渲染
- [ ] thinking/toolCalls 默认折叠(`<details>` 无 `open` 属性)
- [ ] 点击 summary 展开 thinking/toolCalls
- [ ] markdown 正文渲染(`<pre><code>` 出现)

### 6.3 API 接口测试(curl, 需运行服务)

- [ ] WS `agent:message` 事件 payload 含 `thinking`/`toolCalls`/`agentName` 字段
- [ ] `session:messages`(加载历史)返回的消息含新字段
- [ ] 旧 session JSON(无新字段)加载不报错,字段为 undefined

### 6.4 E2E(Playwright + agent-browser)

- [ ] 创建项目+会话 → 发送 prompt → agent 头像/角色名出现
- [ ] 等待回复完成 → 折叠面板出现 → 点击展开看到思考过程
- [ ] 触发工具调用场景 → 工具调用面板出现 → 展开看到 name/args/result
- [ ] 截图清理:E2E 产生的截图在测试结束后删除

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `react-markdown` 增加 bundle 体积(~80KB) | Tauri 桌面应用影响小 | 可接受;后续可换轻量自写解析 |
| 历史 session JSON 无新字段 | 旧消息缺思考/工具面板 | 所有新字段可选,缺省不渲染面板 |
| `tool_execution_end.result` 可能极大(整文件内容) | DOM 卡顿 | result 超 2000 字符截断 + 展开按钮 |
| markdown XSS(agent 输出恶意脚本) | 安全风险 | `react-markdown` 默认不执行 HTML,仅渲染 markdown 语法 |
| pi 协议字段假设与实际不符 | kernel 解析失败 | 单元测试用真实事件结构 mock;运行时 try/catch 容错 |

## 8. 范围边界

**本次包含:**
- `ChatMessage`/`ToolCallRecord` 类型扩展
- kernel `pi-rpc-client` 数据采集改造
- 前端 `MessageList`/`MessageBubble` 重构(左右分栏+头像+折叠面板+markdown)
- 四层测试

**本次不包含(避免范围蔓延):**
- Composer 加 abort 按钮 / 自动增高(独立需求)
- 代码块语法高亮(后续按需)
- 错误消息改用 status 字段(独立重构)
- Canvas / Sidebar 改动
