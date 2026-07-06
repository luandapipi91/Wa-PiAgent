# Task 21 报告：App 三态路由（empty/new-session/session）

## 状态
✅ 完成

## Commit
- Hash: `ab4c82d`
- Message: `feat(frontend): App 三态路由（empty/new-session/session）`（含占位处理 + 测试说明的详尽正文）
- Branch: `master`（未建新分支）

## 交付物
- **改** `packages/frontend/src/App.tsx` — 由占位 `<div>` 替换为三态路由组合：`<Sidebar>` + main 区按 `view` 渲染 `EmptyState` / `NewSessionPane` / `SessionView`，外加 `AgentConfig` 弹层。
- **新建** `packages/frontend/src/components/EmptyState.tsx` — 无项目引导（brief Step 1 原样）。
- **新建（占位）** `packages/frontend/src/components/SessionView.tsx` — Task 25 将实现的真正版本；当前为最小占位（接收 `sessionId` / `onSwitchToCanvas`，渲染 `data-testid="session-view"`），仅为让 App 的 session 分支可编译/通过测试。
- **新建（占位）** `packages/frontend/src/components/AgentConfig.tsx` — Task 26 将实现；当前占位（接收 `agentName` / `onClose`）。
- **新建** `packages/frontend/tests/App-routing.test.tsx` — 2 用例（empty / new-session）。
- **改** `packages/frontend/tests/render.test.tsx` — 旧用例断言「HiAgent 占位」文案，App 改造后必失败；又因 App 现会调用 `getWs()`/`onMessage()`，需 mock ws-instance。已更新为 mock + 断言 empty 态，保留其为「App 能渲染」冒烟用例（仍 1 用例，不增减总数）。

## 关键决策
- **stale-closure 规避（brief 已含正确实现，严格沿用）**：
  - 订阅只取渲染所需最小状态：`useProjectsStore(s => s.projects)` / `s => s.currentSessionId`。
  - `useEffect`（空依赖 `[]`）内 `load()` 与 `onMessage` 回调均通过 `useProjectsStore.getState()` 取最新 action，**未把任何 action 解构进闭包**。
  - Sidebar 的 `onSelectSession` / `onNewSessionInProject` / `onNewProject`、EmptyState 的 `onNewProject` 回调同样用 `getState()` 取最新 action。
  - 派生 view 的 `useEffect` 依赖 `[projects.length, currentSessionId]`，正确触发三态切换。
- **SessionView / AgentConfig 占位处理（约束中明示的做法）**：两个组件按 brief 的 import 语句原样引用；因未实现，按约束创建最小占位组件（带 `data-testid` 便于后续测试），并在文件头部注释标明「PLACEHOLDER，由 Task 25/26 整体替换」。**未注释掉 App 中的分支**——保持 brief 三态结构完整，session 分支 `currentSessionId && <SessionView .../>` 可被路由测试覆盖（当前测试未触发 session 态，但编译链路完整）。commit message 已注明占位。
- **测试 vi 导入**：brief 的 test 文件 import 行缺 `vi`（但用到 `vi.mock`），已补全为 `import { test, expect, vi, beforeEach } from "vitest"`（与现有 Sidebar/NewSessionPane 测试一致；vitest `globals:true` 下 `vi` 全局可用，显式 import 更稳）。

## 测试摘要
```
Test Files  11 passed (11)
     Tests  23 passed (23)
  ✓ tests/App-routing.test.tsx (2)  ← 本次新增
  ✓ tests/render.test.tsx (1)        ← 改写（仍 1 用例）
```
- 前序 21（Task 20 后）+ 本次 App-routing 2 = **23 passed**，符合预期（21+2）。render.test 改写不增减用例，总数仍为 23。

## Concerns（非阻断）
- **占位组件**：SessionView/AgentConfig 为功能性占位，真实交互（消息流、canvas、agent 配置）待 Task 25/26。当对应 Task 落地时应整体替换两个文件（接口签名已与 App 调用一致，替换时无需改 App）。
- **继承警告**：SessionRow `<tbody> nested <button>` 警告依旧（Task 18 遗留），与本任务无关，不阻断。
- **工作区残留**：`packages/kernel/tests/ws-proj.json*`（2 个临时 JSON）为既有 kernel WS 测试生成的临时文件，未被 gitignore、未追踪、**未纳入本次 commit**（git add 仅含 6 个明确 frontend 路径）。建议后续清理或加 gitignore，但不属本任务范围。
- **Windows autocrlf**：commit 时 LF→CRLF 警告，与既有文件一致，不影响功能。
- **`onProjectSettings={() => {}}` 空实现**：Sidebar 的项目设置回调暂为空函数（brief 原样），待后续 Task 接项目设置面板。
