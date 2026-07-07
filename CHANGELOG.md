# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-07 — 编排画布视图切换：App 加 canvas 态 + 返回会话

- **类型**：新增功能（前端）
- **摘要**：实现 Task 29——App 主区 View 类型增加 `"canvas"`，SessionView header 的「编排画布」按钮从空函数接入实际切换；canvas 视图顶部加「← 返回会话」按钮，按当前是否有 session 决定回到 session 还是 new-session 态。
- **具体改动**：
  - 改 `packages/frontend/src/App.tsx`：`View` 类型加 `"canvas"`，新增 canvas 分支（返回按钮 + `<Canvas />`），`onSwitchToCanvas` 由 `() => {}` 改为 `() => setView("canvas")`
  - 新增测试 `packages/frontend/tests/App-canvas.test.tsx`（2）：点编排画布切到 canvas、canvas 点返回会话回到 session。补 happy-dom 缺失的 WebSocket polyfill（既有 App-routing 测试同款报错的根因，本测试自包含解决）
- **影响范围**：`packages/frontend/`（src/App.tsx + tests/App-canvas.test.tsx）
- **验证**：`bunx vitest run tests/App-canvas.test.tsx` 2 passed。注：既有 App-routing 2 failed 为 happy-dom 缺 WebSocket 的遗留问题（stash 验证改动前后一致），非本次回归

---

## 2026-07-07 — 编排画布：Canvas 组件（4 节点 + partners + 活跃 ask 连线）

- **类型**：新增功能（前端）
- **摘要**：实现 Task 28——React Flow 画布，4 个 agent 节点按四角布局，partners 关系画灰色虚线连线，活跃（未 resolved）ask 画橙色动画连线；已 resolved 的 ask 不再产生连线。
- **具体改动**：
  - 新增 `packages/frontend/src/components/canvas/Canvas.tsx`：消费 `useAgentsStore.states`（按 `:${name}` 后缀取首个匹配作节点状态）与 `useIntercomStore.asksBySession`（flat 后过滤 `!resolved`）；节点用 Task 27 的 `CanvasNode`，partners 取默认五条连线常量
  - 新增测试 `packages/frontend/tests/Canvas.test.tsx`（4）：4 节点渲染、默认 partners 连线、活跃 ask 生成橙色动画连线、resolved ask 不连线
- **影响范围**：`packages/frontend/`（src/components/canvas/Canvas.tsx + tests/Canvas.test.tsx）
- **验证**：`bunx vitest run tests/Canvas.test.tsx` 4 passed。注：仓库既有测试（AgentConfig/Composer 等的 `send.mockClear` 报错）为 ws-instance mock 方式的遗留问题，与本次纯增量改动无关

---

## 2026-07-06 — 前端数据层：WS 客户端 + 4 个 Zustand store

- **类型**：新增功能（前端）+ bug 修复（构建配置）
- **摘要**：实现 Task 14 前端数据层——单例 WS 连接 + projects/session/agents/intercom 四个 store，供后续所有组件依赖；顺带修复 Vite alias 相对路径解析 bug。
- **具体改动**：
  - 新增 `packages/frontend/src/ws-instance.ts`：单例 WebSocket，`getWs()` 懒连接 kernel（ws://127.0.0.1:9776），`send(e)` 处理 OPEN/待开两态，`onMessage(cb)` 订阅分发
  - 新增 `store/projects.ts`：useProjectsStore（projects/sessions/currentProjectId/currentSessionId + load/setAll/createProject/addProject/addSession/select×2）
  - 新增 `store/session.ts`：useSessionStore（messagesBySession + append/clear）
  - 新增 `store/agents.ts`：useAgentsStore（states/configs + setState/loadConfig/setConfig/getGlobalState）。getGlobalState 用 get() 读 states，按 `:${name}` 后缀过滤跨项目聚合，调 aggregateAgentState
  - 新增 `store/intercom.ts`：useIntercomStore（asksBySession + addAsk/resolveAsk）
  - 新增测试：store-projects.test.ts（2）、store-agents.test.ts（1）
  - **bug 修复**：`vite.config.ts` / `vitest.config.ts` 的 `@hiagent/shared` alias 原用相对路径字符串（`../../packages/shared/...`），Vite 以引用方文件解析导致 import 解析失败；改为 `fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))` 绝对路径（monorepo 标准写法）。Task 13 render 测试未引用 @hiagent/shared 故未暴露
- **影响范围**：`packages/frontend/`（src/store/ 4 文件 + ws-instance.ts + 2 测试 + 2 config）
- **验证**：`bun run test` 4 passed（store-projects 2 + store-agents 1 + render 1）；`bun run typecheck` 无错误

## 2026-07-06 — 文档同步：hiagent-design 对齐多项目重构

- **类型**：文档修正
- **摘要**：以 `docs/superpowers/specs/2026-07-06-sidebar-projects-design.md`（多项目重构）为基准，回溯修正 `docs/superpowers/specs/2026-07-05-hiagent-design.md` 中已被推翻或扩展的单项目描述，消除两份文档的冲突。
- **具体改动**：
  - 顶部状态行加 2026-07-06 多项目变更说明，指向 sidebar-projects-design
  - 6.1 启动页 + sidebar 重写：原"角色/会话历史/底部状态条"三区 → "新建会话/我的智能体/项目管理"四区；启动页改为主区三态（empty / new-session / session）之一；底部 intercom 状态条按方案 C 移到会话 header
  - 6.2 视图清单"启动页"行改为"新建会话面板"
  - 第七节 mermaid UI1 节点 / MVP 必做边界 / 功能依赖链、8.2 前端模块表、11.1 第一条共 5 处"启动页"改为"新建会话面板"（review 补）
  - 第五节新增 5.4 项目与会话实体（三层模型、类型定义、持久化布局、AgentState 维度变化）
  - 8.1 AgentManager 职责改为 `(projectId, agentName)` 双 key + cwd 取自 project
  - 9.1 数据流 WS 协议字段加 projectId + sessionId，列出新增 WS 事件
  - 11.2 多项目从"MVP 暂不包含"标记为已转入实施
  - 6.2 / 6.4 / 11.2 Intercom 时间线全屏视图标记为"已不纳入设计"——方案 C 移除 sidebar 底部状态条后该视图失去入口，intercom 信息改由会话 header 徽标 + 内联委派卡片呈现（review 补，纠正首轮"入口待定"误判）
  - 14.3 待确认多项目标记已确认；新增 14.4 React/Vue 技术栈矛盾待确认
- **影响范围**：仅文档 `docs/superpowers/specs/2026-07-05-hiagent-design.md`（未触碰代码）
