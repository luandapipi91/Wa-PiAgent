# ask_user_question：agent ↔ 用户结构化问答（设计文档）

- **日期**：2026-07-11
- **状态**：Draft（待评审）
- **参考**：`@juicesharp/rpiv-ask-user-question`（仅作 schema/返回协议参考，**不安装**其 TUI 实现）
- **关联**：与 `docs/superpowers/plans/2026-07-11-memory-project-scope.md` 共用 `createAgentSession({customTools})` 钩子，互不冲突

---

## 1. 背景与目标

让 wa-pi 的 agent（product / pm / dev / test）能在任务中途向用户提出**结构化澄清问题**（单选/多选 + 选项说明 + 预览 + 备注 + 「其他」自由输入），而不是盲目猜测。前端在 **composer 上方**停靠一张完整表单完成人机交互；agent 在用户回答前阻塞当前回合。

### 为什么不直接安装 `@juicesharp/rpiv-ask-user-question`

该包是**终端（TUI）扩展**，在 wa-pi 的**无头内核 + Web 前端**中无法渲染（其返回结构本身就带 `details.error: "no_ui"` 这条「无 UI」错误路径）。直接挂载只会在 agent 调用时产生 `no_ui` 错误。

### 决策

用 Pi SDK 的 `defineTool()` + `createAgentSession({ customTools })` **原生定义** `ask_user_question` 工具，其 **schema 与返回结构与该包完全对齐**（LLM 侧契约等价），问答内容路由到 Web 前端表单。**不安装该 TUI 包。** 这条路径也契合 SDK 官方文档（Custom Tools 节）。

---

## 2. 端到端数据流（复用现有 tool-call / tool-result 管道，server→client 零新增）

1. **Agent 调用** `ask_user_question({ questions: [...] })`，参数为原包 schema。
2. **Pi SDK 调起** `execute(toolCallId, params, signal)`：
   - 校验 `params`，非法直接返回 `{ details: { error } }`（**不弹 UI**）。
   - `await askRegistry.ask(sessionId, toolCallId, params, signal)` —— agent 回合在此**自然阻塞**（Pi 等工具返回）。
3. **问题已随 `sdk:event` 到达前端**：以 assistant 消息里的 `toolCall` block（`name: "ask_user_question"`，`arguments = AskParams`）形式。这是载体，与今天每个工具调用走的路一致，**无需新 server→client 事件**。
4. **前端**：`MessageList` 历史区显示精简 pill（`等待回复…`）；`SessionView` 在 **composer 正上方停靠** `<AskFormCard>`（pending）。会话状态置 `blocked`，composer 禁用。
5. **用户提交** → 前端发新 `WSClientEvent { type: "agent:answer", sessionId, toolCallId, reply }`。
6. **内核** `ws-server` → `askRegistry.resolve(sessionId, toolCallId, reply)`。
7. **工具返回** `{ content: [{ type: "text", text: 摘要 }], details: { answers, cancelled: false } }`（原包结构）。Pi 记录 `toolResult` 并广播 `message_end(toolResult)`。
8. **前端**：停靠卡淡出（answered），历史 pill 变「✓ 已回答」并展开所选答案；状态回到 thinking/idle，agent 带答案继续。

**中断路径**：「取消」按钮 → `agent:cancel-ask` → `cancelled: true`；「停止」/「立即」→ abort `signal` + `registry.cancelAll` → `cancelled: true`。两种情况 agent 都收到 cancelled 并自行决定后续。

---

## 3. 内核：ask-tool + AskRegistry

### 3.1 工具定义 —— `packages/kernel/src/ask-tool.ts`（新）

```ts
defineTool({
  name: "ask_user_question",
  label: "Ask User",
  description: "向用户提出 1–4 个结构化澄清问题（每问 2–4 个选项）…",
  promptGuidelines: "…（与原包一致的 LLM 使用策略）",
  parameters: AskParamsSchema,        // TypeBox，见 §4
  execute: async (toolCallId, params, signal) => {
    const err = validateAskParams(params);          // §3.1 校验
    if (err) return { content: [{type:"text",text:err}], details: { error: err } };
    return askRegistry.ask(sessionId, toolCallId, params, signal);  // await 在 registry 内
  },
});
```

- **校验**（镜像原包 `details.error` 码）：`no_questions | empty_options | too_many_questions | duplicate_question | duplicate_option_label | reserved_label`（保留标签拒绝 `"Other"` 及运行时 sentinels）。
- **sessionId 注入**：`execute` 签名无 sessionId，由 `makeAskTool(sessionId)` 在 `_createSession` 内**闭包**焊入（每个 session 一份工具实例）。registry key 用前端 WS 同一个 wa-pi sessionId。
- **返回结构**：合法回答 → `{ content:[{type:"text",text:摘要}], details:{ answers: AskAnswer[], cancelled:false } }`；取消/中断 → `{ details:{ cancelled:true } }`。

### 3.2 AskRegistry —— `packages/kernel/src/ask-registry.ts`（新，进程级单例）

数据结构：`Map<sessionId, Map<toolCallId, { resolve, removeListeners }>>`（**不设硬超时**，故无 timer）。

- `ask(sessionId, toolCallId, params, signal): Promise<AskToolResult>` —— 建 promise、存 resolver；挂 `signal` 监听（`signal.aborted` → resolve `{details:{cancelled:true}}`）。
- `resolve(sessionId, toolCallId, reply: AskReply)` —— 把 `AskReply` 译成 `AskAnswer[]`（判定 `kind`：单选→`option`、多选→`multi`、含 customText→`custom`），resolve `{details:{answers, cancelled:false}}`。
- `cancel(sessionId, toolCallId)` —— resolve `{details:{cancelled:true}}`。
- `cancelAll(sessionId)` —— 取消该 session 全部 pending（`abort` / `_jumpQueue(interrupt=true)` / `disposeSession` 调用）。
- **幂等**：`resolve` / `cancel` 对未知或已解决的 toolCallId 一律 no-op。

### 3.3 接线点

| 改动 | 位置 |
|---|---|
| `DEFAULT_AGENT_TOOLS` 加 `"ask_user_question"` | [packages/shared/src/constants.ts:43-57](../../../packages/shared/src/constants.ts) |
| `_createSession` 内 `makeAskTool(sessionId)` 并入 `customTools` | [packages/kernel/src/agent-manager.ts:307-318](../../../packages/kernel/src/agent-manager.ts) |
| `abort` / `_jumpQueue(interrupt)` / `disposeSession` **同步**调 `cancelAll`（在 `session.abort()` 之前） | [packages/kernel/src/agent-manager.ts](../../../packages/kernel/src/agent-manager.ts)（abort≈541、_jumpQueue≈414、disposeSession≈576） |
| switch 加 `agent:answer` / `agent:cancel-ask` 分支 | [packages/kernel/src/ws-server.ts:169](../../../packages/kernel/src/ws-server.ts) |

> 与 memory 重构的 memory 工具在 `customTools` 里**合并为同一数组**，互不干扰。

---

## 4. Shared 协议 —— `packages/shared/src/ask.ts`（新）

```ts
export type AskOption   = { label: string; description: string; preview?: string };
export type AskQuestion = { question: string; header: string; options: AskOption[]; multiSelect?: boolean };
export type AskParams   = { questions: AskQuestion[] };                 // = 工具 inputSchema = toolCall.arguments
export type AskAnswer   = { questionIndex: number; question: string;
                            kind: "option" | "custom" | "multi";
                            answer: string | null; selected?: string[];
                            notes?: string; preview?: string };
export type AskReply    = { replies: { questionIndex: number; selected: string[];
                                       customText?: string; notes?: string }[] };
```

- `WSClientEvent`（[types.ts:245-258](../../../packages/shared/src/types.ts)）追加两个 client→server 事件：
  ```ts
  | { type: "agent:answer";     sessionId: string; toolCallId: string; reply: AskReply }
  | { type: "agent:cancel-ask"; sessionId: string; toolCallId: string }
  ```
- [shared/src/index.ts](../../../packages/shared/src/index.ts) 导出 `ask.ts`。
- **不新增 server→client 事件**：问 = `toolCall.arguments`，答 = `toolResult`，都走现有 `sdk:event` 流。
- **v1 不做 `kind:"chat"`**：那是 TUI 专属的「直接对话、不选选项」redirect 行为；我们的「其他」自由输入（产 `kind:"custom"`）已覆盖该需求，工具 schema 本身（questions/options/multiSelect）与原包完全一致。

---

## 5. 前端

### 5.1 选择器与状态 —— `packages/frontend/src/store/session.ts`

- `pendingAsks(sessionId)`：从 `messagesBySession` 选出 `name === "ask_user_question"` 且**无配对 toolResult** 的 toolCall（复用 `MessageList.preprocess` 的 toolCallId 配对逻辑）。`arguments` 即 `AskParams`。
- `effectiveStatus = pendingAsks.length > 0 ? "blocked" : rawStatus`（点亮 [types.ts:23](../../../packages/shared/src/types.ts) 那个预留但一直未用的 `"blocked"` 状态）。

### 5.2 布局 —— `packages/frontend/src/components/SessionView.tsx`

```
<MessageList/>
{pendingAsks.length > 0 && (
  <AskDock>                          {/* 蓝边分隔条锚定，内部 max-height 滚动 */}
    {pendingAsks.map(a => <AskFormCard key={a.toolCallId} toolCallId={a.toolCallId} params={a.arguments}/>)}
  </AskDock>
)}
<Composer disabled={pendingAsks.length > 0}/>
```

### 5.3 表单组件 —— `packages/frontend/src/components/ask/AskFormCard.tsx`（新）

- 每问：`multiSelect` 为真→checkbox 行，否则→radio 行（label + description）。
- 选项带 `preview` 时，选中/聚焦该项用 `react-markdown`（已是依赖）渲染预览：宽屏并排、窄屏堆叠。
- 每问一个「备注(可选)」文本框（**per-question**，简化原包 per-option note，回传 `notes`）。
- 每问一个「其他…」→ 展开文本框；填了即为 `kind:"custom"`（空文本视为未答）。
- 校验：未答完则高亮未答项 + 禁用「提交」。
- 「提交」→ `send({ type:"agent:answer", sessionId, toolCallId, reply })`，按钮短暂「提交中…」并禁用。
- 「取消」→ `send({ type:"agent:cancel-ask", sessionId, toolCallId })`。
- **状态机（按 toolCallId）**：`pending`（可交互、composer 禁用）→ 提交 `submitting` → toolResult 到达 `answered`（停靠区淡出、历史 pill 展开）/ 取消或 abort `cancelled`（淡出、pill「已取消」）。翻转**以 toolResult 事件为准**（非乐观）。

### 5.4 历史区渲染 —— `packages/frontend/src/components/MessageList.tsx`

`name === "ask_user_question"` 的 toolCall **复用现有 `ToolCallBlock`**（无需 per-tool 渲染分支）：pending 显示 `🔧 ask_user_question · 等待回复…`；有 result 后 `✓ 已回答`，展开可见 `details.answers`。样式沿用现有设计 token。

---

## 6. 队列兼容性（ask × steer / followUp）

- **两条独立通道**：`agent:answer` 直达 `AskRegistry.resolve`，**不经 steer/followUp 队列、不调 `session.prompt/steer/followUp`**。回答不会被排到队尾，也不会与排队消息混淆。
- **pending 时已排队消息自然等待**（SDK 原生行为）：当前 turn 在工具上阻塞，队列消息照常等该 turn 结束（ask 被回答/取消）后投递，顺序不变。
- **队列面板（引导/立即/取消/清空/停止）保持可用**：
  - **非中断类**（清空、取消队列项、引导 promote）：只动队列，**不影响** pending ask。
  - **中断类**（立即 immediate、停止 abort）：**同步**触发 `askRegistry.cancelAll(sessionId)` + 工具 `signal` → ask 以 `cancelled:true` 结束，随后 immediate 的消息开新 turn。即用户可用「立即」**覆盖**提问（代价：这次提问作废）。
- **pending 时 composer 禁用**（不能发新 prompt/steer）。逃生气口：ask 卡片「取消」（取消提问→turn 结束→composer 解锁）、或「立即」覆盖。**v1 不支持「提问期间追加 followUp」**，后续可增强为「pending 时 composer 只允许发 followUp 队列项」。
- **状态显示正交**：pending 时 `⏸ 等待回复`，队列计数照常显示（例：「⏸ 等待回复 · 队列 2 条」）。
- **一 turn 内多次 ask**：多卡堆叠，各自按 toolCallId 独立 resolve；turn 在全部 resolve 后才结束，队列随后 drain。

---

## 7. 边界情形

1. **内核重启残留 ask（最高风险）**：registry 是内存态。重启后 Pi resume 若**重跑**该工具 → 表单自然重现、可重答；若**不重跑** → 在 session 启动时扫 `session.messages`，对「无 result 的 ask 调用」注入一条 `cancelled` toolResult 兜底（agent 看到 cancelled 自行重问）。具体走哪条**留到实现期用一个 kill-restart 测试验证**（见 §11）。
2. **前端断线重连**：重连后 `session:messages` 重载 → pending ask 的 toolCall（无 result）重新渲染表单；kernel 侧 registry 按 session 存活（不绑连接），回答照常 resolve，**无丢失**。
3. **重复提交 / 乱序回答**：`resolve`/`cancel` 对未知或已解决 toolCallId **幂等 no-op**；前端提交后立即禁用按钮。
4. **多 agent（product/pm/dev/test）**：registry 按 sessionId 隔离，dev 的提问只在 dev 会话停靠，无串扰。
5. **提交与 abort 竞态**：先到者胜（resolve vs cancelAll），后者幂等 no-op。
6. **表单超高**：停靠卡内部 `max-height` 滚动，不撑乱布局。

---

## 8. 测试计划（TDD，覆盖率 ≥ 80%）

**内核单测**
- `AskRegistry`：register→resolve 返回 answers；register→cancel / abort signal→cancelled；对未知/已解决 id 幂等 no-op；`cancelAll` 清空 session；并发多 toolCallId 互不干扰。
- `ask-tool` 校验：逐个 `details.error` 码命中；合法参数正确进入 registry 阻塞。
- `AskReply → details.answers` 翻译：单选→`option`、多选→`multi`（含 `selected`）、含 customText→`custom`、`notes` 透传。

**前端单测**
- `pendingAsks` 选择器：找出无 result 的 ask、忽略已答、支持多个。
- `AskFormCard`：单/多选切换、「其他」展开、提交前校验禁用、提交发 `agent:answer`（形状正确）、取消发 `agent:cancel-ask`、preview 用 react-markdown 渲染、answered/cancelled 只读态。
- `effectiveStatus`：pending 时为 `blocked`。

**内核集成测（WS）**
- 往返：execute 注册 → 注入 `agent:answer` WS 事件 → resolve → toolResult 落库。
- pending 中 `agent:abort` → `cancelAll` → 工具返回 cancelled。
- 未知 toolCallId 的 `agent:answer` 被忽略。

**E2E（playwright）**
- 起 dev 会话、触发一次 ask（受控 prompt）、填表提交、看到 agent 带答案继续；以及取消路径。

---

## 9. 非目标（v1，YAGNI）

i18n 多语言；Submit-review 审阅 tab；per-option notes（用 per-question）；`kind:"chat"` 重定向；硬超时；主题切换之外的视觉打磨。

---

## 10. 关键文件索引

| 模块 | 文件 |
|---|---|
| 工具定义 | `packages/kernel/src/ask-tool.ts`（新） |
| 阻塞/解决注册表 | `packages/kernel/src/ask-registry.ts`（新） |
| session 创建 / customTools / abort 接线 | `packages/kernel/src/agent-manager.ts` |
| WS 应答事件分发 | `packages/kernel/src/ws-server.ts` |
| 协议类型 | `packages/shared/src/ask.ts`（新）、`packages/shared/src/types.ts`、`packages/shared/src/constants.ts` |
| 停靠表单 | `packages/frontend/src/components/ask/AskFormCard.tsx`（新） |
| 停靠区 + composer 禁用 | `packages/frontend/src/components/SessionView.tsx` |
| pending 选择器 + effectiveStatus | `packages/frontend/src/store/session.ts` |
| 历史 pill 渲染（复用） | `packages/frontend/src/components/MessageList.tsx` |

---

## 11. 实现期待验证项

1. **Pi resume 行为**：进程重启后，对 journal 里「无 result 的 ask 工具调用」，Pi 是否重跑该工具？决定 §7-1 兜底（注入 cancelled toolResult）是否需要。
2. **`defineTool` 的 `execute` 第五参 `ctx`** 是否暴露 sessionId 或 session 句柄——若暴露可省去闭包；当前闭包方案不依赖它。
3. **`session.abort()` 是否把中断透传到工具 `signal`**——无论是否，都用 `cancelAll` 兜底（§3.3）。
4. **WS 断线期间 `agent:answer` 的可达性**——重连后若用户在表单仍 pending 时提交，确认 registry 仍能 resolve（registry 按 session 存活，预期 OK）。
