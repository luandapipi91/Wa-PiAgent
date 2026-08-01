# 轮级折叠摘要行 + 整轮耗时设计

- **日期：** 2026-08-01
- **状态：** 待实现
- **作者：** brainstorming 协作产出

## 背景与问题

一轮 agent 调用完成后，中间过程（思考 / 工具调用 / delegate / fleet）可能很长——单块虽有折叠（`useAutoCollapse`），但整轮仍然占据大片消息流。用户希望：**一轮调用完成后，把中间过程二次折叠成一行摘要**，只保留时长与步骤数；点击展开才看到原来的过程，展开后每个步骤还能再逐个展开（保持现有卡片级折叠）。

同时要求摘要行显示**整轮时长**，且**刷新页面后历史轮也能还原时长**。

## 目标

1. 一轮（agent 回合）完成后，中间过程（thinking / toolCalls / delegate / fleet）折叠为一行摘要
2. 摘要行显示「本轮时长 + 步骤数」，秒/分钟自动切换
3. 点击摘要行展开整轮过程；各过程卡片保持现有折叠规则，可再逐个展开
4. 最终文本回复始终完整保留在摘要行之外
5. **刷新后历史轮也还原时长**——采用「纯读推算」：从 jsonl 消息时间戳计算，零写入、不侵入 pi 文件
6. 流式中（轮未完成）不折叠，保持现有逐卡流式渲染

## 非目标（YAGNI）

- 不改 `segmentBlocks` / `mergeStreamingIntoLast`（时间线已正确）
- 不在 store 层加折叠状态（视图偏好，组件内 state 即可）
- 不持久化用户的展开偏好（切走再回来按派生默认值重置）
- 不写 jsonl / 不写旁路元数据文件（纯读推算，历史数据天然可还原）
- 不做 per-tool-call 粒度计时（只计整轮总耗时）
- 不做回合分隔行（TURN 分隔）或回合导航（cocode 对齐项，明确不做）

## 视觉规格（已与用户确认）

折叠态为**居中分隔行**（灰色小字、两侧分隔线、整行可点击）：

| 场景 | 摘要行内容 |
| --- | --- |
| 有时长（实时轮完成 / 历史轮经推算） | `—— 本轮时长 2 分 15 秒 · 3 个步骤 ——` |
| 无时长（旧 jsonl 缺字段 / 该轮无 user / 合成 agent_end） | `—— 本轮过程 · 3 个步骤 ——` |

> 注：历史轮经纯读推算后通常**有**时长（jsonl 里本就含消息时间戳）；仅当该轮找不到 user 边界或字段缺失时才退化为「本轮过程」。时长判定只看消息 `turnElapsedMs` 是否存在，与实时/历史来源无关。

- 时长格式化：`< 60s` → `"45 秒"`；`>= 60s` → `"2 分 15 秒"`（秒/分钟自动切换）
- 步骤数 = 过程段数量（thinking 段 + toolCalls 组 + delegate 段 + fleet 段；text 段不计）
- 整行可点击：`role="button"` + `aria-expanded`，点击在折叠/展开间切换
- 展开态：显示该轮全部过程卡片（各自保持现有折叠规则，可再逐个展开）
- 最终文本回复（text 段）始终在摘要行之外完整显示

## 整轮耗时：纯读推算（用户已确认）

**语义：** 「用户发送 → 回复完成」总时长 = 该轮最后一条 assistant 消息 `timestamp` − 该轮 user 消息 `timestamp`（含排队/启动，更贴近用户感知；历史与实时一致）。

**零写入：** jsonl 是 pi 子进程 append-only 写入，kernel 不写任何文件；消息 `timestamp` 本就随消息存在，历史数据天然可还原（旧会话刷新后也能显示时长）。

### 历史渠道（kernel 注入）

`packages/kernel/src/session-history.ts` `readSessionHistory()`：

- 复用现有 parentId 树回溯得到的消息序列（`AgentMessage[]`）
- 按 `role === "user"` 切轮边界；对每轮：`turnElapsedMs = 最后一条 assistant.timestamp − 该轮 user.timestamp`
- 注入到该轮**最后一条 assistant 消息**的 `turnElapsedMs` 字段（`AssistantMessage` 新增可选字段）
- 边界：无 user / 非 assistant 结尾的轮 → 不注入；旧 jsonl 无字段 → 前端自动降级为无时长

### 实时渠道（agent_end 事件）

`packages/kernel/src/agent-manager.ts` `_onSessionEvent()` 新增 `case "agent_end"`：

- 从事件自带 `event.messages`（该轮完整消息列表）计算同样语义的 `elapsedMs`（最后 assistant.timestamp − user.timestamp；找不到 user 则不附加）
- 附加到透传事件 `SDKEvent.agent_end.elapsedMs?`（可选字段，向后兼容；合成 agent_end 如进程崩溃/命令拦截路径不附加）
- 事件仍走现有 `onEvent` → SSE 广播链路

## 核心行为规则

**折叠触发（前端渲染层）：** 对"已完成（非流式、已定稿）且含过程段（thinking/toolCalls/delegate/fleet 至少一个）"的 assistant 行生效。

| 条件 | 行为 |
| --- | --- |
| 已完成 + 含过程段 | 过程段折叠为摘要行（默认折叠） |
| 流式中（未完成） | 不折叠，保持逐卡流式渲染 |
| 纯文本轮（无过程段） | 无摘要行，正常显示 |
| text 段 | 始终保留在摘要行之外 |

**用户优先：** 摘要行折叠状态为组件内 state，用户点击后固定为用户选择（`userToggled` 模式，与 `useAutoCollapse` 一致），自动逻辑不再覆盖。

## 架构与组件改动

### shared 类型

`packages/shared/src/types.ts`：

```ts
// AssistantMessage 加字段（历史注入 + 前端回写共用）
export interface AssistantMessage {
 // ...既有字段
 turnElapsedMs?: number;
}

// SDKEvent.agent_end 加字段（实时传输）
| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean; elapsedMs?: number }
```

### 前端 store（session.ts）

- `agent_end` 分支（现 L430-450）：取事件 `elapsedMs`，**写回 `messagesBySession[sessionId]` 中该轮最后一条 assistant 消息的 `turnElapsedMs`**（实时轮立即有值）
- 历史加载（`setMessages`）的消息自带 `turnElapsedMs`（kernel 注入），无需额外状态
- **渲染唯一数据源：消息 `turnElapsedMs`**——实时/历史路径统一，不新增旁路 store 字段

### MessageList.tsx（行级折叠）

- `MessageRow` 渲染 assistant 行时：`segmentBlocks(blocks)` 后，若该行已完成且存在过程段，则把过程段包进可折叠容器
- 折叠容器折叠态渲染 `<TurnSummary>`，展开态渲染原过程段（`ThinkingCard` / `ToolGroupCard` / `DelegateCard` / `FleetCard`）
- text 段不进入容器
- 行的"已完成"判定：复用现有流式机制（行不在 streaming 中、段全部定稿）

### 新增 TurnSummary 组件

`packages/frontend/src/components/blocks/TurnSummary.tsx`：

```tsx
interface TurnSummaryProps {
  steps: number;          // 过程段数量
  elapsedMs?: number;     // 本轮时长（undefined = 历史轮/无时长）
  open: boolean;
  onToggle: () => void;
}
```

- 居中分隔行：`role="button"` + `aria-expanded`，`onClick={onToggle}`
- 时长格式化 helper：`formatElapsed(ms)`（秒/分自动切换）
- 文案：有时长 → `本轮时长 {formatElapsed} · {steps} 个步骤`；无时长 → `本轮过程 · {steps} 个步骤`
- 分隔线：flex 两侧 `1px` hairline + 中间文字（原型 B 已确认）

## 边界情况

1. **合成 agent_end（进程崩溃/命令拦截）：** 无 user 消息可算 → 不附加 elapsedMs → 前端按历史轮处理（无时长，折叠照常）
2. **该轮只有 assistant 无 user（罕见）：** 不附加/不注入
3. **旧 jsonl / 无字段：** 无时长，折叠行为不变（显示「本轮过程 · N 个步骤」）
4. **失败回合（error assistant）：** 也按轮计算（若 user 存在），时长正常显示；transient 错误过滤/失败去重逻辑不变，只对最终序列切轮
5. **连续多轮：** 每轮独立切分，各自摘要行；步骤数各自计算
6. **会话切换/刷新：** 历史加载消息自带 turnElapsedMs → 时长还原；折叠状态重置为折叠
7. **展开态下过程卡片：** 已定稿，`isStreaming=false`，按完成态渲染（成功绿/失败红、各自折叠），可再逐个展开

## 测试策略

遵循 AGENTS.md 四层验收标准。

### 第 1 层 · 单元测试（kernel，bun:test）

- `session-history` 推算：正常轮 / 无 user / 连续多轮 / 旧 jsonl 无字段 / 失败回合轮
- `agent-manager` agent_end 附加 elapsedMs（含找不到 user 不附加、合成路径不附加）

### 第 2 层 · 组件测试（Vitest + RTL）

- `TurnSummary.test.tsx`（新增）：时长格式（秒/分切换）、无时长文案、步骤数、点击展开/折叠切换、aria-expanded
- `MessageList.test.tsx`（改）：已完成行折叠过程段 + text 保留；流式中不折叠；纯文本行无摘要行；展开后过程卡可见且可再展开
- `session` store 测试（改）：agent_end 带 elapsedMs → 写回最后一条 assistant 消息 turnElapsedMs；不带 → 不写

### 第 3/4 层 · API 接口 / E2E

- 无新 REST 端点（`session:messages` 响应形态不变，仅消息字段多一个可选值）
- E2E（可选）：真实会话完成后摘要行出现，点击展开可见过程，刷新后时长保留——若已有会话类 E2E 基建则补一条，否则注明跳过

## 改动文件清单

| 文件 | 操作 | 说明 |
| --- | --- | --- |
| `packages/shared/src/types.ts` | 改 | `AssistantMessage.turnElapsedMs?` + `agent_end.elapsedMs?` |
| `packages/kernel/src/session-history.ts` | 改 | 切轮推算 + 注入 turnElapsedMs |
| `packages/kernel/src/agent-manager.ts` | 改 | agent_end 分支计算并附加 elapsedMs |
| `packages/kernel/tests/session-history.test.ts` | 改 | 推算用例 |
| `packages/kernel/tests/agent-manager.test.ts`（或对应文件） | 改 | agent_end 事件断言 |
| `packages/frontend/src/store/session.ts` | 改 | agent_end 写回 turnElapsedMs |
| `packages/frontend/src/components/MessageList.tsx` | 改 | 行级折叠逻辑 |
| `packages/frontend/src/components/blocks/TurnSummary.tsx` | 新增 | 摘要行 + 可折叠容器 |
| `packages/frontend/tests/TurnSummary.test.tsx` | 新增 | 组件测试 |
| `packages/frontend/tests/MessageList.test.tsx` | 改 | 折叠行为用例 |
| `packages/frontend/tests/session.test.ts`（或对应 store 测试） | 改 | agent_end 写回用例 |
| `CHANGELOG.md` | 改 | 记录本次变更 |
