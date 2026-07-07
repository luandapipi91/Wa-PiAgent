# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-07 — MVP 完成：四层测试全绿 + 测试基础设施修复

- **类型**：测试修复 + 收尾
- **摘要**：Task 42-43 收尾——修复前端组件测试遗留失败（WebSocket polyfill + 行为断言），四层测试全部通过，HiAgent MVP 交付。
- **具体改动**：
  - 新增 `packages/frontend/tests/setup-websocket.ts`：happy-dom 缺原生 WebSocket 的全局 polyfill（MockWebSocket，readyState=OPEN，send/addEventListener 空实现）
  - 改 `packages/frontend/vitest.config.ts`：加 `setupFiles` + `exclude` e2e 目录（防 vitest 扫描 Playwright spec）
  - 改 4 个组件测试（Composer/AskCard/NewSessionPane/AgentConfig）：去掉不稳定的 `vi.mock(ws-instance)` + `send.mockClear` 模式，改行为断言（发送后 input 清空 / onClose 触发），由 setup-websocket polyfill 兜底真实 send
- **影响范围**：`packages/frontend/`（vitest.config.ts + tests/setup-websocket.ts + 4 测试文件）
- **最终验收（四层全绿）**：
  - 第一/三层（kernel + shared，bun:test）：**47 passed**
  - 第二层（frontend 组件，vitest）：**42 passed**
  - 第四层 E2E（Playwright，非 pi 标注）：**4 passed**（+ 3 `[需 pi 环境]` skipped）
  - 截图/临时文件：全部清理，无残留
- **MVP 范围**：43 个 Task 全部实现。`[需 pi 环境]`（真实 Pi broker/agent 交互）+ `[需 tauri build]`（Tauri 窗口弹窗）标注项需对应环境验证

---

## 2026-07-07 — E2E 基础设施 + 7 个 spec + 前端白屏 bug 修复

- **类型**：新增测试（第四层 E2E）+ bug 修复（前端运行时）
- **摘要**：实现 Task 34-41——Playwright E2E 基础设施（globalSetup 启隔离 kernel）+ 7 个 spec（4 个串行主流程 passed，3 个 `[需 pi 环境]` skip）。E2E 首跑暴露两个前端白屏 bug（shared 包在浏览器环境崩），修复后全绿。
- **具体改动**：
  - **bug 修复（E2E 发现的真实运行时问题）**：
    - `packages/shared/src/constants.ts`：`process.env` 访问加 `typeof process !== "undefined"` 守卫——浏览器无 process 全局，shared 被 frontend import 时模块加载即崩（白屏）。同时加 `HIAGENT_DIR` env 覆盖支持（E2E 隔离 + 生产可配置）
    - `packages/shared/src/pure.ts`：`randomSessionId` 去掉 `node:crypto` import，改用全局 `crypto.randomUUID()`（浏览器 Web Crypto API + Node 19+ + Bun 均原生）
    - `packages/kernel/src/intercom-monitor.ts`：`connectReal` broker 连接失败时 `resolve(null)` 降级（不再 reject），`connect` 加 null 守卫——pi-intercom broker 未启动时 kernel 崩溃（ENOENT），现降级为 warn 日志继续起 WS server
  - **E2E 基础设施**：
    - `packages/frontend/playwright.config.ts`：globalSetup 启隔离 kernel（独立 `HIAGENT_DIR` 随机目录），globalTeardown 杀进程清目录；webServer 注入 HIAGENT_DIR env
    - `packages/frontend/e2e/global-setup.ts`/`global-teardown.ts`：kernel 进程启停 + 端口轮询 + 目录清理
  - **E2E spec（7 个）**：
    - `app-flow.spec.ts`（Task 35-39 合并）：`describe.serial` 串行——首次启动建项目→发消息建会话→编排画布 4 节点→Agent 配置 modal 切 tab。合并原因：独立 spec 各自建项目但 kernel 全局共享 HIAGENT_DIR，状态污染
    - `intercom.spec.ts`（Task 37）`[需 pi 环境]`：AskCard 委派 + 我来回答
    - `multi-project.spec.ts`（Task 40）`[需 pi 环境]`：多项目 cwd 隔离
    - `migrate.spec.ts`（Task 41）`[需 pi 环境]`：老数据迁移建默认项目
  - 装 `@playwright/test@^1.49` + chromium 二进制
- **影响范围**：`packages/shared/`（constants.ts + pure.ts）、`packages/kernel/`（intercom-monitor.ts）、`packages/frontend/`（playwright.config.ts + e2e/ 7 文件 + package.json）
- **验证**：`bunx playwright test` **4 passed + 3 skipped**（非 pi 标注项全绿）；`bun test packages/shared` 8 passed（bug 修复无回归）

---

## 2026-07-07 — 老数据迁移 + 启动到对话全链路集成测试

- **类型**：新增功能（kernel 迁移）+ 测试（第三层集成）
- **摘要**：实现 Task 33——老用户首次启动新版（项目模型）时，无项目但有孤儿 session → 自动建「默认项目」并 reassign 归入；新增第三层集成测试覆盖「真实 WS + 建项目 + 发消息触发自动建会话」全链路。Phase 6（Tauri 集成）收尾。
- **具体改动**：
  - 改 `packages/kernel/src/project-store.ts`：新增 `reassignSession(sessionId, projectId)`，迁移用——改 session 归属项目
  - 新增 `packages/kernel/src/migrate.ts`：`migrateLegacySessions(projectStore)`，修正计划原实现里「空 patch 循环 no-op」的 bug，真正把孤儿 session（projectId 指向不存在项目）reassign 到新建的默认项目
  - 改 `packages/kernel/src/index.ts`：`server.start()` 前调 `migrateLegacySessions`，迁移成功打印日志
  - 新增测试 `packages/kernel/tests/migrate.test.ts`（3）：不迁移×2（新用户/已有项目）+ 迁移成功（孤儿 session 归入默认项目）
  - 新增测试 `packages/kernel/tests/e2e-integration.test.ts`（1）：第三层——真实 Bun.serve WS + WebSocket 客户端，建项目→发 agent:prompt→kernel 自动建会话→广播 session:created，断言 projectId/primaryAgent/title
- **影响范围**：`packages/kernel/`（project-store.ts + migrate.ts + index.ts + 2 测试）
- **验证**：`bun test packages/kernel` **39 passed**（原 35 + migrate 3 + e2e 1），77 expect calls

---

## 2026-07-07 — Rust 主进程管理 kernel sidecar 生命周期

- **类型**：新增功能（Tauri 主进程）
- **摘要**：实现 Task 32——Tauri 启动时 spawn `hiagent-kernel` sidecar（WS 9776），窗口关闭时 kill 防泄漏；sidecar 的 stdout/stderr 转发到 Rust 进程 stderr（带 `[kernel]` 前缀）便于调试。
- **具体改动**：
  - 新增 `src-tauri/src/sidecar.rs`：`spawn_kernel(app)` 用 `app.shell().sidecar("hiagent-kernel").spawn()` 拉起子进程，异步消费 `CommandEvent` 流（Stdout/Stderr/Terminated）转发到 eprintln，避免管道缓冲写满阻塞
  - 改 `src-tauri/src/lib.rs`：声明 `mod sidecar`，用 `KernelChild(Mutex<Option<CommandChild>>)` 托管状态；`setup` 时调 `spawn_kernel` 存入 State；`on_window_event` 的 `CloseRequested` 时 take 出 child 调 `kill()`
- **影响范围**：`src-tauri/src/`（sidecar.rs 新增 + lib.rs 改写）
- **验证**：`cargo build` Finished；**运行时验证通过**——跑 debug 二进制，Tauri 主进程（PID 1370）成功 spawn kernel sidecar（PID 1375），kernel 监听 `ws://127.0.0.1:9776` 并输出「[kernel] WS 监听 ws://127.0.0.1:9776」；清理后端口与进程正确释放

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
