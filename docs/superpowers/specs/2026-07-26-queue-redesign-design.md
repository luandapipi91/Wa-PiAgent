# 排队系统重构 — 基于 pi RPC 原生队列

日期: 2026-07-26
版本: 1.0
状态: 设计确认

## 背景

HiAgent 当前在 kernel 层维护了 `steering[]` 和 `followUp[]` 两套队列，与 pi RPC 子进程的内部队列并行存在。两套队列不同步产生三个已确认 Bug：

1. **消息重复发送**（ws-server.ts:466）— `isStreaming=false` 时误走直发而非 followUp 入队，与 steer:promote 配合导致重复
2. **_jumpQueue 竞态**（agent-manager.ts:706）— `abort()` 后置 `busy=false`，但 pi 的 `agent_start` 可能在之后到达重设 `busy=true`，导致 `_sendPromptNow` 被拒绝
3. **UI 卡顿**（agent-manager.ts:747）— `_lockedQueueOp` 串行锁 + 前端 `void api.post()` 无反馈

## 根因

HiAgent 最初基于 pi **SDK** 构建（SDK 有 `clearQueue()` API），迁移到 pi **RPC** 后手动模拟了队列管理。但 pi RPC 本身有完整的 `steer` / `follow_up` / `prompt({streamingBehavior})` 三套队列机制。HiAgent 的自管队列与 pi 内部队列不同步。

源码验证（pi v0.82.1）：
- `AgentSession.clearQueue()` 存在于 SDK 层，但**未暴露给 RPC 协议**
- RPC 命令只有 `steer` / `follow_up` / `abort` / `set_steering_mode` / `set_follow_up_mode`
- `abort()` 不清队列，只中断当前 LLM 调用

## 设计目标

1. 消除引导/排队混淆导致的消息重复和竞态
2. 消除点击按钮的感知卡顿（< 50ms 反馈）
3. 支持跨会话：切换到聊天 B 后，聊天 A 结束后排队消息自动发送
4. 净删代码 ~150 行

## 架构变更

### 当前（两套队列，不同步）

```
HiAgent Kernel                      pi RPC 进程
steering: ["优化代码"]   ← 手动同步 →  内部 steer 队列
followUp: ["写测试","文档"] ← 手动同步 → 内部 followUp 队列

Bug: 两套队列不同步 → 需要 abort + drain 强行对齐
```

### 目标（pi RPC 原生 + 轻量本地补充）

```
HiAgent Kernel              pi RPC
──────┬─────────            ──────
      │                     steer() → pi 管理引导队列
本地列表(排队用)              followUp() → (不使用，排队自己管)
      │                     queue_update 事件 → 前端渲染
      ↓
agent_settled → prompt()

分工：
- 引导 → pi 原生 steer()，turn_end 自动投递
- 排队 → HiAgent 本地列表，agent_settled 逐条 prompt()
- 不重叠，不同步，无冲突
```

## 操作映射

| 用户操作 | 实现 | 耗时 |
|---------|------|------|
| 发送消息（空闲） | `prompt({message})` | 正常 |
| 发送消息（运行中） | 追加到本地排队列表 | 即时 |
| "引导"排队消息 | 从本地列表移除 → `steer({message})` | <10ms |
| "引导"（空闲时） | `prompt({message})`（steer 要求运行中） | 正常 |
| "立即"排队消息 | `abort()` → `steer({message})` | ~abort 耗时 |
| "清空排队" | 清空本地列表 | 0ms（纯前端） |
| 跨会话排队 drain | `agent_settled` → 取本地列表第一条 → `prompt()` | 自动 |

## 前端乐观更新

```
点击"引导" → 立即移动消息位置（乐观更新）→ 后台 api.post → pi steer()
点击"清空排队" → 立即清空列表（乐观更新）→ 后台清本地数组
点击"立即" → 立即移除消息（乐观更新）→ 后台 abort + steer
```

**关键：删除 `_lockedQueueOp` 串行锁** — 这是卡顿的根源。
引导/排队操作不再需要互斥，因为：
- steer() 是 pi 快速命令（无 LLM 调用），可以并发
- 本地列表操作用 zustand 的同步 setState，无竞态

**steer() 降级：** pi 的 `steer()` 要求 agent 正在运行（streaming）。
空闲时调用会报错，需先检查 `get_state().isStreaming`，空闲时降级为 `prompt()`。

## 跨会话行为

每个会话对应独立的 pi RPC 子进程。`_onSessionEvent` 对所有会话生效，不关心当前活跃会话。

```
用户在聊天B界面 → 聊天A的pi继续运行 → agent_settled → 自动drain A的排队 → 用户切回A时已在执行
```

## 要删除的代码

### agent-manager.ts
- `SessionHandle.steering: string[]` 字段
- `SessionHandle.followUp: string[]` 字段
- `_emitQueueUpdate()` 合成事件
- `_jumpQueue()` 方法（~40 行）
- `_lockedQueueOp()` 方法
- `_lockedJumpQueue()` 方法
- `promoteToSteer()` 方法
- `immediate()` 方法
- `clearSteeringQueue()` 方法
- `clearFollowUpQueue()` 方法
- `steerMessage()` 方法
- `prompt()` 中的队列判断逻辑（busy || followUp.length || steering.length）

### ws-server.ts
- `steer:promote` case
- `steer:immediate` case
- `steer:cancel` case
- `steer:clear-queue` case

### routes/chat.ts
- `/api/sessions/:sessionId/steer/promote` 路由
- `/api/sessions/:sessionId/steer/immediate` 路由
- `/api/sessions/:sessionId/steer/cancel` 路由
- `/api/sessions/:sessionId/steer/clear-queue` 路由

### SessionView.tsx
- `handlePromote()` → 改为乐观更新 + steer()
- `handleImmediate()` → 改为乐观更新 + abort + steer()
- `handleCancelSteer()` → 删除（steer 消息由 pi 管理，无需取消）
- `handleClearFollowUp()` → 改为纯本地清空

## 净效果

| | 改前 | 改后 |
|---|------|------|
| 队列代码量 | ~200 行 | ~50 行 |
| 消息重复 Bug | 存在 | 消除 |
| _jumpQueue 竞态 | 存在 | 消除 |
| "引导"卡顿 | 串行锁等待 | 即时 |
| "清空"打断agent | 是 | 否 |
| 跨会话支持 | 已支持 | 保持 |

## 文件改动

| 文件 | 改动类型 |
|------|---------|
| `packages/kernel/src/agent-manager.ts` | 删 ~120 行，新增 ~30 行轻量排队列表 |
| `packages/kernel/src/ws-server.ts` | 删 4 个 steer case，steerMessage 简化为直调 pi |
| `packages/kernel/src/routes/chat.ts` | 删 4 个 /steer/* 路由 |
| `packages/frontend/src/components/SessionView.tsx` | 引导/立即/清空 → 乐观更新 + 简化按钮 |
| `packages/frontend/src/store/session.ts` | 简化 queueBySession 管理 |
