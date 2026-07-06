# Task 10 报告：AgentManager（双 key spawn/kill）

## 状态
✅ 完成

## 交付
- **Commit**: `524a5ef` — `feat(kernel): AgentManager（双 key spawn，cwd 取自 project）`
- **实现**: `packages/kernel/src/agent-manager.ts` — `AgentManager` 类
  - `ensureStarted(projectId, agentName)`：按 `${projectId}:${agentName}` 双 key 复用 PiRpcClient；cwd 取自 `project.cwd`；sessionId = `${projectId}-${agentName}`
  - `abort(projectId, agentName)`：转发 `client.abort()`
  - `getState(key)` / `getAllStates()`：从 states Map 读
  - `disposeAll()`：逐个 `client.dispose()` 并清空两 Map
  - `onEvent` 包装：`state` 事件存入 `states` Map，所有事件透传给上层回调并附 key
- **测试**: `packages/kernel/tests/agent-manager.test.ts` — 3 个测试

## 测试摘要
```
bun test packages/kernel/tests/agent-manager.test.ts
  (pass) ensureStarted 用 projectId+agentName 双 key [6.47ms]
  (pass) 不同 projectId 是独立进程 [2.25ms]
  (pass) onEvent 携带正确 key [1.42ms]
 3 pass, 0 fail
```
kernel 全量回归 **28 pass / 0 fail**（25 旧 + 3 新），无回归。

TDD 流程：先写测试 → 确认 `Cannot find module '../src/agent-manager'` FAIL → 实现 → 3 passed。

## 测试 mock 调整说明（偏离 brief 原文）
brief 的 `mockSpawn`（stdin.write 为空操作）**无法让 test 3 通过**：`PiRpcClient.start()` 只在收到 stdout `data` 时才回调 `onEvent`，而原 mock 从不 emit，故 `seen` 永远为空，`expect(seen).toContain(...)` 会 FAIL。

**修复**：让 `stdin.write` 解析握手请求，收到 `get_state` 时 `stdout.emit` 一行 `state_change` JSON，模拟真实 pi 行为。这与 `pi-rpc-client.test.ts` 里 `emitLine` 推 state_change 的做法一致，仅是把触发点放在 write 里自动化。三个测试的断言语义（同 key 复用 / 不同 key 独立 / onEvent 带 key）均保留不变。

## Concerns
1. **`abort` 语义**：当前 `abort` 只发 RPC abort，**不销毁进程**（client 留在 agents Map 中，下次 ensureStarted 仍复用）。若期望 abort 后重启进程需在 brief 后续 Task 中明确——当前实现符合「kill 前可继续对话」的直觉。
2. **`disposeAll` 串行 await**：进程数多时 `for...of await` 会串行 dispose。MVP 规模（≤4 agent）无影响；规模化时改 `Promise.all`。
3. **state Map 不会因 `abort`/断连清零**：仅 `disposeAll` 清。若单 agent 进程崩溃其 state 会残留为最后值，需后续 Task（如进程退出监听）补清理。
4. **未对 `getAllStates` 单测**：brief 未给测试用例，按 brief 要求只交付 3 测试；方法已实现（返回 Map 拷贝）。
5. **CRLF 警告**：Git 提示 LF→CRLF（Windows 默认），不影响功能。
