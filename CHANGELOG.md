# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-07 — Bun sidecar 编译 + Tauri sidecar 配置

- **类型**：新增功能（构建链）
- **摘要**：实现 Task 31——kernel build 改用 `bun build --compile` 产出独立可执行二进制 `hiagent-kernel`（69MB Mach-O），并复制带 Rust target triple 后缀的副本（`hiagent-kernel-x86_64-apple-darwin`）供 Tauri sidecar 解析；tauri.conf.json 加 `bundle.externalBin`，capabilities 加 shell execute/spawn 权限。
- **具体改动**：
  - 改 `packages/kernel/package.json`：build 脚本加 `--compile` + 调 `scripts/copy-sidecar.mjs` 复制 triple 后缀副本；新增 `build:bundle` 保留 JS bundle 产出（Task 33 集成测试用）
  - 新增 `packages/kernel/scripts/copy-sidecar.mjs`：Node arch/platform → Rust target triple 映射（darwin-x64→x86_64-apple-darwin 等），复制 sidecar 副本
  - 改 `src-tauri/tauri.conf.json`：`bundle.externalBin` 指向 `../packages/kernel/dist/hiagent-kernel`
  - 新增 `src-tauri/capabilities/default.json`：core:default + shell:allow-execute/spawn + sidecar scope
- **影响范围**：`packages/kernel/`（package.json + scripts/copy-sidecar.mjs）、`src-tauri/`（tauri.conf.json + capabilities/）
- **验证**：`bun run --filter @hiagent/kernel build` 产出 `dist/hiagent-kernel` + `dist/hiagent-kernel-x86_64-apple-darwin`（可执行，端口占用报错证明功能正常）；`cargo build` Finished；`bun test packages/kernel` 35 passed

---

## 2026-07-07 — Tauri 项目初始化（Cargo + tauri.conf + 空壳窗口）

- **类型**：新增功能（Tauri 壳）
- **摘要**：实现 Task 30——创建 Tauri 2.x 项目骨架，`cargo build` 编译通过，产出可执行的 HiAgent 空壳窗口二进制（Task 32 接管 kernel sidecar 生命周期）。
- **具体改动**：
  - 新增 `src-tauri/Cargo.toml`：包名 `hiagent`，`[lib] name = "hiagent_lib"`（对齐 main.rs 的 `hiagent_lib::run()`，Tauri 2 官方模板约定）；依赖 `tauri 2` + `tauri-plugin-shell 2` + `serde` + `serde_json`
  - 新增 `src-tauri/tauri.conf.json`：devUrl `http://localhost:5173`（对齐 frontend vite server.port），frontendDist 指向 `../packages/frontend/dist`，窗口 1280×800
  - 新增 `src-tauri/build.rs` + `src/main.rs`（`windows_subsystem = windows` 防 release 弹控制台）+ `src/lib.rs`（空壳 `tauri::Builder` + shell plugin，Task 32 填 sidecar）
  - 新增 `src-tauri/icons/`：4 个 RGBA PNG 占位（32/128/128@2x/512），用 Python `zlib`+`struct` 生成（CRC 与 color type 经校验合法；Tauri 要求 RGBA color type 6）
- **影响范围**：`src-tauri/`（全新目录，不影响 packages/*）
- **验证**：`cargo build` Finished，产物 `target/debug/hiagent`（Mach-O 31MB debug）。弹窗 dev `[需交互环境]` 留 Task 32 全链路验证

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
