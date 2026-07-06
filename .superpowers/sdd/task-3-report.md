# Task 3 Report — shared 类型包

## 状态
DONE

## 文件清单
**创建：**
- `packages/shared/src/types.ts` — 全局类型定义（AgentName/AgentConfig/ProjectEntity/SessionEntity/ChatMessage/AskItem/AgentState/AgentStateKey + 全部 WS 协议事件类型 WSClientEvent/WSServerEvent/WSEvent）
- `packages/shared/src/constants.ts` — 常量（WS_PORT/PREVIEW_PORT/HIAGENT_DIR/PROJECTS_FILE/SESSIONS_DIR/PI_AGENTS_DIR/AGENT_DEFS + AgentDef 接口）
- `packages/shared/src/pure.ts` — 纯函数（formatRelativeTime/aggregateAgentState/makeAgentStateKey/parseAgentStateKey/randomSessionId）
- `packages/shared/tests/types.test.ts` — 类型测试（4）
- `packages/shared/tests/pure.test.ts` — 纯函数测试（4）

**修改：**
- `packages/shared/src/index.ts` — 改为 barrel（`export *` from types/constants/pure），覆盖 Task 2 占位的 `HIAGENT_VERSION`

**删除：**
- `packages/shared/tests/scaffold.test.ts` — Task 2 脚手架测试，断言 `HIAGENT_VERSION`，barrel 化后该导出已移除，保留会让测试失败（见"偏离 brief 处"）

## `bun test packages/shared` 输出
```
 8 pass
 0 fail
 17 expect() calls
Ran 8 tests across 2 files. [40.00ms]
```
（types 4 + pure 4，符合 brief 期望）

## typecheck 结果
```
@hiagent/shared typecheck: Exited code 0
```
根级 `bun run typecheck`（kernel/frontend/shared 三包）全部 Exited code 0。

## commit hash
`246fc28ec4556a6e625af56460e26c9a49e9d81c`

## 偏离 brief 处及原因
1. **删除 `packages/shared/tests/scaffold.test.ts`**（brief 未提及，但隐含必要）：
   - Task 2 的 scaffold.test.ts 断言 `HIAGENT_VERSION === "0.0.0"`。
   - Step 8 把 index.ts 改为 barrel，移除了 `HIAGENT_VERSION` 导出。
   - 若保留 scaffold.test.ts，`bun test packages/shared` 会变成 9 个测试且其中 1 个 FAIL，违反 brief "8 passed" 的期望。
   - 因此删除它，使测试总数精确为 8（types 4 + pure 4）。

2. **TDD 红相位处类型模块的"假绿"现象（说明，非偏离）**：
   - types.test.ts 用 `import type`，在运行时被完全擦除，因此即使 types.ts 不存在，`bun test` 仍报 4 pass。
   - 真正的"红"体现在 typecheck（`error TS2307: Cannot find module '../src/types'`）。
   - 已用 `bun run --filter @hiagent/shared typecheck` 确认写 types.ts 前后从 FAIL→PASS，TDD 红绿循环成立。

## 问题
无。
