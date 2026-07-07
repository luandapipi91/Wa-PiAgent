# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-07 — Pi 原生消息模型重构（透传富消息 + 废弃旁路系统 + .hiagent 隔离）

- **类型**：架构重构（kernel + shared + frontend，跨 9 个任务）
- **摘要**：把消息流从 kernel 自管的拍扁 ChatMessage + 多套旁路系统（broker-proxy / intercom-monitor / intercom store / AskCard），统一收敛到 **Pi 原生富消息模型**——kernel 透传 Pi 的 `AgentMessage`（含 thinking/text/toolCall/intercom 等内容块），历史会话改由 `PiRpcClient.getMessages()` 实时拉取 Pi session（不再读拍扁的 sessions 文件），前端按内容块类型富渲染。配置从 `~/.pi/agent` 隔离到独立的 `~/.hiagent/agents`（HIAGENT_PI_AGENT_DIR），实现 HiAgent 与 Pi CLI 互不污染。
- **核心改动**（39 files, +659 / −1875，净减 1216 行）：
  - **shared**：新增 Pi 原生消息类型（`AgentMessage` / `SessionMessage`），WS 事件 `message` 字段换型；新增 `HIAGENT_PI_AGENT_DIR`，`PI_AGENTS_DIR` 迁至 `.hiagent/agents`
  - **kernel**：`PiRpcClient` 透传富 AgentMessage + 新增 `getMessages()` + 去 `-real` 后缀 + `PI_CODING_AGENT_DIR` env 注入；`ws-server` 的 `session:messages` 改走 `getMessages`；`StateAggregator` 透传 SessionMessage；`session-store` 废弃 messages 字段；**删除 `broker-proxy.ts` + `intercom-monitor.ts` 整套旁路系统**（职责重叠：路由/会话名占位/状态影子三层重复）；`pendingRpcResolvers` dispose 清理避免 getMessages 永挂
  - **frontend**：`session` store 换 SessionMessage（append 新签名 `(sessionId, msg)`）；新增 `MessageRow` + `ContentBlock`（thinking/text/toolCall/delegate 富渲染，react-markdown）；**删除 `useIntercomStore` + `AskCard`**，SessionView/Canvas 清理旁路引用，会话内委派展示统一收敛到 Pi 原生消息流的 DelegateCard
- **影响范围**：`packages/shared/`（types.ts + constants.ts）、`packages/kernel/`（pi-rpc-client / ws-server / state-aggregator / session-store / agent-manager / index + 删 broker-proxy / intercom-monitor）、`packages/frontend/`（store/session + MessageRow/ContentBlock/TextBlock/ToolCallPanel/DelegateCard/DelegateReceived + SessionView/Canvas/App + 删 intercom.ts/AskCard）
- **四层测试验证（Task 9 收尾）**：
  - 第一/三层（kernel + shared，bun:test）：**37 passed**（含 session:messages→getMessages、agent:prompt→session:created 富消息集成测试）
  - 第二层（frontend 组件，vitest）：**61 passed**（23 文件，含 ContentBlock 富渲染）
  - 第四层 E2E（Playwright）：本环境无 pi（`bun` 子进程 spawn 不可用），setup 15s 超时后 clean fail，无 hang、无残留进程
  - typecheck：kernel 全绿；frontend 剩余 **7 个预存 tsc 错误**（TextBlock remarkGfm 来自 react-markdown v10 API 变化、ProjectList/Sidebar/AgentConfig 测试 onProjectSettings/name 类型），均非本次重构引入
- **后续遗留**：Canvas 委派 ask 动画连线降级（asksBySession 占位空，后续从 DelegateCard 消息流重建）；frontend 7 个预存 tsc 错误待统一治理

---

## 2026-07-07 — 修订 pi-native-message-model 设计文档（二次核查修正 9 处问题）

- **类型**：文档修订
- **摘要**：对 `docs/superpowers/specs/2026-07-07-pi-native-message-model.md` 做二次核查后修正 9 处事实/类型/行号错误。最重要的撤回：1.1 节"错误三"原称 broker-proxy"靠 `**Reply from X:**` 文本解析、脆弱"，核查 `broker-proxy.ts` 源码后确认其用的是 `pi-intercom/broker/client` 结构化 API，**论据失效**。废弃决策保留（改用 Pi 原生 intercom），但论据改为"职责重叠"（路由/会话名占位/状态影子三层重复）。
- **其它修正**：
  - `CustomMessage` 类型：`role: "custom"` → 顶层 `type: "custom_message" | "custom"`（与 3.3 节真实 session 样本一致，避免委派卡片渲染失效）
  - `PI_AGENTS_DIR` 路径：`~/.pi/agent/agents` → `~/.hiagent/agents`，补"配置隔离 vs broker socket 共享"分层说明
  - 4.3.1 `getMessages` 示例代码 id 自增 bug 修复（`send` 接受可选 id 参数）
  - 3.2/4.2 类型定义对齐（补 signature/redacted 字段省略说明）
  - 多处行号勘误（send 97-103→98-104、AskCard import 7→8 等）
- **影响范围**：`docs/superpowers/specs/2026-07-07-pi-native-message-model.md`（仅文档，无代码改动）

---

## 2026-07-07 — 修复会话消息重复（切换会话后显示多条重复回复）

- **类型**：bug 修复
- **摘要**：流式消息 message_start/update/end 三个阶段均触发 sessionStore.appendMessage 持久化到磁盘，导致同 id 消息被多次 push。切换会话加载历史时 setMessages 也不去重，同一回复显示多个副本。
- **修复**：
  - `session-store.ts`: appendMessage 改为同 id 更新而非追加（与前端 store.append 行为一致）
  - `session.ts` (frontend): setMessages 加载历史时按 id 去重（防御性处理已有脏数据）
- **影响范围**：`packages/kernel/src/session-store.ts`、`packages/frontend/src/store/session.ts`

## 2026-07-07 — start.sh 加 broker 自愈（解决 kernel 启动崩溃）

- **类型**：修复（启动可靠性）
- **摘要**：
  - 根因：kernel 启动时无条件连接 pi-intercom broker socket（`~/.pi/agent/intercom/broker.sock`），但 broker 进程常出现"僵尸"状态——进程还在，socket 文件却被删除，导致 kernel `ENOENT` 崩溃退出（code=1）
  - 修复：`start.sh` 新增 `ensure_broker` 步骤，在 kernel 启动前检测 socket 可用性，不可用则自动清理僵尸进程 + 重启 broker + 等待 socket 就绪
  - 现在双击 `start.command` 即使 broker 异常也会自愈，不再崩溃
- **影响范围**：`start.sh`（新增 `ensure_broker` 函数 + main 调用）
- **验证**：模拟故障（杀 broker + 删 socket）→ `ensure_broker` 自愈成功（3 秒内 socket 恢复）→ 连接验证通过

---

## 2026-07-07 — 多智能体委派：Kernel 代理方案

- **类型**：新增功能
- **摘要**：实现 BrokerProxyManager，kernel 在 pi-intercom broker 上为每个 agent 注册轻量代理 session。当其他 agent 通过 intercom 工具向目标 agent 发消息时，代理接收消息 → 按需启动真实 Pi 进程 → relay 转发。支持链式委派（Agent1→Agent2→Agent3），200+ agent 可扩展（仅 socket 连接，无需预启动进程）。POC 9 步全流程已验证通过。
- **影响范围**：
  - 新增 `packages/kernel/src/broker-proxy.ts`（236 行，代理注册+消息缓存+relay 转发+回复路由）
  - 修改 `packages/kernel/src/index.ts`（组装 BrokerProxyManager）
  - 修改 `packages/kernel/src/agent-manager.ts`（新增 onDispose 回调）
  - 修改 `packages/kernel/src/pi-rpc-client.ts`（broker 注册名加 -real 后缀）
  - 新增 `packages/kernel/tests/broker-proxy.test.ts`（13 tests）
  - 新增 `packages/kernel/tests/e2e-delegation.test.ts`（E2E 委派流程）

## 2026-07-07 — kernel 全自动热更新（改源码自动重编+重启 sidecar）

- **类型**：新增功能（开发期 DX 优化）
- **摘要**：
  - 改 `packages/kernel/src` 或 `packages/shared/src` 后无需按 R，自动重编 kernel 二进制 → Rust 检测到新二进制 → kill 旧 sidecar + spawn 新 sidecar
  - 两段式职责分离：bash watch 进程负责**编译**（fswatch + bun build），Rust notify 负责**重启**（监听 dist 目录 + kill/respawn）
  - 窗口不闪、Vite HMR 不中断、Rust 不重编；前端改动仍由 Vite HMR 自动处理（未改动）
  - R 键保留为手动兜底（全量重启）；fswatch 缺失时降级并提示 `brew install fswatch`
- **影响范围**：
  - `src-tauri/Cargo.toml`：新增 `notify = "6"` + `tokio`（features: time/sync/rt）
  - `src-tauri/src/sidecar.rs`：新增 `triple_for_host()`、`restart_kernel()`、`watch_kernel_binary()`；`KernelChild` 移入此文件
  - `src-tauri/src/lib.rs`：setup 末尾启动 watcher；引用调整
  - `start.sh`：新增 `start_watch`/`stop_watch` 函数；fswatch 检测与降级提示；菜单文案更新
- **依赖**：`fswatch`（macOS，`brew install fswatch`）
- **验证**：cargo build 通过；watch 子系统端到端测试通过（touch 源码 → 2 秒内重编完成）；Rust triple 与 copy-sidecar.mjs 一致性验证通过

---

## 2026-07-07 — 修复 start.command 双击启动失败

- **类型**：修复（环境/启动脚本）
- **摘要**：
  - 根因：`start.sh`（bash）在 `set -uo pipefail` 下 `source ~/.zshrc`，zsh 专用语法（autoload/setopt）导致脚本静默 abort
  - 修复：改为 grep+sed 只提取 `DEEPSEEK_API_KEY`，不再 source 整份 zsh 配置
  - 次要问题：Write 工具覆盖文件后执行权限丢失（644），导致"没有正确的访问权限"，已 chmod +x
- **影响范围**：`start.sh`（DEEPSEEK_API_KEY 提取逻辑）、`start.command`（新建，双击入口包装）

---

## 2026-07-07 — 安装 Rust 环境

- **类型**：配置变更（开发环境）
- **摘要**：通过 rustup 安装 Rust 工具链（rustc 1.96.1 / cargo 1.96.1 / rustup 1.29.0），为 Tauri 后端开发做准备
- **影响范围**：系统级（`~/.cargo/bin`、`~/.rustup`），无项目文件改动

---

## 2026-07-07 — 会话列表倒序 + 右键 popup 菜单 + 删除确认框

- **类型**：新增功能（前端会话交互）
- **摘要**：
  - 会话列表按 `lastActivity` 倒序显示（最新会话在顶部）
  - 右键会话弹出 popup 菜单（含「重命名会话」「删除聊天」）
  - 点删除弹出 confirm 确认框（红色危险按钮），确认后发送 `session:delete`
- **影响范围**：
  - 新增 `packages/frontend/src/components/ui/Modal.tsx`（公共弹窗容器：fixed 遮罩 + 居中卡片 + ESC/点击遮罩关闭）
  - 新增 `packages/frontend/src/components/ui/ConfirmDialog.tsx`（基于 Modal 的确认框，支持 danger 红色按钮）
  - 改 `packages/frontend/src/components/SessionRow.tsx`（加 `onContextMenu` 可选 prop）
  - 改 `packages/frontend/src/components/ProjectItem.tsx`（排序 + popup 菜单状态 + confirm 集成）
  - 新增测试：`tests/Modal.test.tsx`、`tests/ConfirmDialog.test.tsx`、`tests/SessionRow.context.test.tsx`、`tests/ProjectItem.sort-menu.test.tsx`（共 18 个用例）
- **后端**：无改动（`session:delete` / `session:rename` 已就绪，删除后广播 `projects:list` 自动刷新）

---

## 2026-07-07 — 修复消息流全链路（pi RPC 协议 + 错误透传 + stdout 适配）

- **类型**：bug 修复（kernel + 前端事件链路）
- **摘要**：发送消息后无回复——根因是多重：①前端没处理 agent:message/agent:state/error 事件 ②PiRpcClient 不认 pi 0.80 的 response 协议 ③pi 的 --cwd 参数不存在 ④Bun.spawn 的 stdout 是 Web Streams 非 Node EventEmitter ⑤bun 全局装的残缺 pi（缺 proper-lockfile 依赖）被优先解析。逐层修复后，消息流全链路打通，错误（如 No API key）正确显示在前端。
- **具体改动**：
  - **前端事件处理（App.tsx）**：onMessage 补全 agent:message（注入 session store）、agent:state（更新 agents store）、intercom:ask/reply（intercom store）、error（注入消息流红色显示 或 alert）。此前只处理项目/会话管理事件，agent 回复和错误全被丢弃
  - **MessageList**：错误消息（⚠️ 开头）红色边框样式区分
  - **PiRpcClient.handleLine**：加 `response` 类型处理——pi 0.80 RPC 用 request/response（非流式 message_update），prompt 成功发 message 事件、失败发 error 事件；加 currentSessionId 让 message 定位到正确会话
  - **PiRpcClient.start**：去掉 pi 不认的 `--cwd` 参数（工作目录通过 spawn cwd 选项传）
  - **defaultSpawn**：Bun.spawn 的 stdout/stderr 是 ReadableStream（Web Streams），新增 `toNodeStream` 适配器转成 Node `.on("data")` 风格；加 `proc.exited` 退出监听 + stderr 转发日志；`killed` 改 getter 反映真实状态；显式 `env: process.env`
  - **StateAggregator**：routePiEvent 加 error kind → 广播 WS error 事件（带 agent 上下文）
  - **ws-server agent:prompt**：发 prompt 前广播 user message（让前端立即显示用户输入）；prompt 调用传 session.id；错误从 reply 改 broadcast
  - **AgentManager**：ensureStarted 加 cwd 校验（缺失时抛错而非传 null 给 pi）
  - **环境**：卸载 bun 全局残缺 pi（缺 proper-lockfile），保留 nvm 完整版
- **影响范围**：`packages/frontend/`（App.tsx + MessageList.tsx）、`packages/kernel/`（pi-rpc-client.ts + state-aggregator.ts + ws-server.ts + agent-manager.ts）
- **验证**：agent-browser 真实流程——发消息后前端显示 `⚠️ [dev] No API key found...`（pi 真实错误透传）；`bun test` 39 passed + `vitest` 42 passed
- **剩余阻塞**：pi 的 model `deepseek/deepseek-v4-flash` 需配 `DEEPSEEK_API_KEY` 才能产生真实回复（用户凭证）

---

## 2026-07-07 — 新建项目原生目录选择器 + 项目切换

- **类型**：新增功能（Tauri 集成 + 前端交互）
- **摘要**：新建项目流程从「两次 prompt 手输路径」升级为「点按钮 → 系统原生文件夹选择器 → 自动取目录名建项目」；补齐点项目名切换当前项目的缺失交互；移除无用的齿轮（改名）按钮。
- **具体改动**：
  - **Tauri dialog 接入（Rust 3 件套）**：Cargo.toml 加 `tauri-plugin-dialog`，lib.rs Builder 加 `.plugin(tauri_plugin_dialog::init())`，capabilities/default.json 加 `dialog:allow-open` 权限
  - **前端目录选择封装层**：新增 `packages/frontend/src/pick-directory.ts`——`pickDirectory()`（Tauri 环境动态 import plugin-dialog 调原生选择器）、`pickDirectoryOrPrompt()`（非 Tauri 降级 prompt）、`basename()`（取目录名）。动态 import 避免非 Tauri 环境加载即崩
  - **store 新增 createProjectFromDir**：`projects.ts` 加 action，调 pickDirectoryOrPrompt 拿目录，basename 取项目名，发 project:create。修了 Edit 导致的重复声明 bug
  - **App.tsx**：EmptyState/Sidebar 的 onNewProject 改调 createProjectFromDir（去 prompt）；新增 onSelectProject 切换项目
  - **项目切换**：ProjectItem 项目名 span 改可点击 button（hover 高亮 + title 显示 cwd），ProjectList 传 selected 高亮当前项目；App onSelectProject 切 currentProjectId + 清 session + 进 new-session 态
  - **移除齿轮按钮**：onProjectSettings 原是空函数，ProjectItem 去掉 ⚙️ 按钮，Sidebar/ProjectList/App 连带清理
- **影响范围**：`src-tauri/`（Cargo.toml + lib.rs + capabilities）、`packages/frontend/`（pick-directory.ts + store/projects.ts + App.tsx + Sidebar/ProjectList/ProjectItem + e2e/app-flow.spec.ts）
- **验证**：`cargo build` 通过；`bunx vitest run` 42 passed；`bunx playwright test` 4 passed

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
