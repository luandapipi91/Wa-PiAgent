# Task 11: StateAggregator（快照+增量路由）— Report

## 状态
✅ 完成

## Commit
`bf0f598` — `feat(kernel): StateAggregator（Pi 事件 → WS 事件 + 持久化路由）`

## 文件
- `packages/kernel/src/state-aggregator.ts`（新增，StateAggregator 类）
- `packages/kernel/tests/state-aggregator.test.ts`（新增，4 测试）

## 测试摘要
`bun test packages/kernel/tests/state-aggregator.test.ts` → **4 pass, 0 fail**

| 测试 | 结果 |
|---|---|
| routePiEvent message → agent:message + 持久化 | ✅ pass (62ms) |
| routePiEvent state → agent:state | ✅ pass (0.3ms) |
| routeAsk → intercom:ask + 持久化 | ✅ pass (71ms) |
| routeReply → intercom:reply + resolve 持久化 | ✅ pass (131ms) |

## 实现
严格按 brief 实现：
- `routePiEvent(key, e)`：解析 key 得 projectId/agentName；`message` 分支同步推 `agent:message` 事件 + 异步 `sessionStore.appendMessage`；`state` 分支仅推 `agent:state`（不持久化，状态在 AgentManager 内存）
- `routeAsk(ask)`：推 `intercom:ask` + 异步 `appendAsk`
- `routeReply(askMessageId, sessionId)`：推 `intercom:reply` + 异步 `resolveAsk`
- `snapshot()`：最小实现 `return []`（留给 Task 12 WS server 启动时填充）
- 异步持久化均 fire-and-forget（`.catch(() => {})`），不阻塞事件流

依赖：Task 7 SessionStore、Task 10 AgentManager、Task 8 PiEvent、`@hiagent/shared`（WSServerEvent/AgentStateKey/parseAgentStateKey/AskItem/ChatMessage）均已就绪。

## TDD 流程
1. 写测试 → FAIL（Cannot find module '../src/state-aggregator'）
2. 写实现 → 4 passed

## Concerns
- **snapshot() 为空实现**：按 brief 明确"Task 12 的 WS server 启动时调用，此处给最小实现"，返回空数组。Task 12 需补全：应从 SessionStore 载入历史 messages/asks + AgentManager.getAllStates() 聚合返回。
- **fire-and-forget 错误吞掉**：异步持久化失败被 `.catch(() => {})` 静默忽略。MVP 阶段可接受；后续可加日志/错误事件。
- **routePiEvent 不处理 intercom:ask / intercom:reply 分支**：按 brief 设计，这两个 PiEvent kind 由 IntercomMonitor 旁路捕获，经 routeAsk/routeReply 单独路由；switch 无 default 分支（符合 brief 源码）。
- **CRLF 警告**：Git 提示 LF→CRLF（Windows 环境，无影响）。
