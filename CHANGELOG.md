# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-29

### 修复

- **重启后思考强度被重置为 disabled（hydration 竞态根因，第三次修复）**：前两次修复（`setSessionPrefs` 增量同步、defaults 改用 localStorage）都没解决，因为真正根因是 **stale state 持久化竞态**——`useComposerPrefsStore` 初始内存态 `thinking: "disabled"`，而 `loadDefaults` 是异步的；若在其完成前触发 `setDefaults`/`setSessionPrefs`（用户改 model、附件 auto-select 等），两者内部 `{...s.defaults, ...prefs}` 会拿初始 `disabled` 当"当前 defaults"**无条件写回 localStorage**，覆盖用户上次存的 high/max。`loadDefaults` 姗姗来迟时读到的已是 `disabled`。用户用 F12 实测确认 localStorage 键存在、值确为 disabled，排除了"存不进去"和"读错"。修复：加 hydration guard——`loadDefaults`/`loadSession` 完成后才标记 `defaultsHydrated=true`，此前持久化函数只更新内存、不写回；hydrate 后恢复正常持久化。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/tests/composer-prefs.test.ts`（新增 hydration 竞态回归测试，并修正既有"重启往返"测试补上 hydrate 时序）

- **编辑供应商弹窗：选中快捷供应商后手动输入模型 id，快捷下拉卡住关不掉**：根因是 TagInput 回车/分隔符提交后会清空输入文本并回调 `onInputText("")`，而 ProviderFormModal 把"空搜索"解释为"显示全部预设模型"，导致下拉在添加模型后反而重新弹出全部候选项且无法关闭。修复：TagInput 新增 `onSubmit` 回调（回车/分隔符成功提交且非空白时触发，顺序置于 `onInputText` 之后），ProviderFormModal 在 `onSubmit` 时 `setDropPos(null)` 收起快捷下拉；并补 `onBlur` 延迟收起（点击外部关闭）。同时给 TagInput 的两条提交路径统一了 onInputText→onSubmit 的调用顺序，避免空串回调重新打开下拉。
  - 影响范围：`packages/frontend/src/components/ui/TagInput.tsx`、`packages/frontend/src/components/settings/ProviderFormModal.tsx`、`packages/frontend/tests/TagInput.test.tsx`、`packages/frontend/tests/ProviderFormModal.test.tsx`

- **provider 配置变更后，已运行的会话用旧 extension 导致新增模型 "Model not found"**：`provider:save` / `provider:delete` 会重写 `provider-extension.ts`，但运行中的 pi session 进程仍加载启动时的旧版本 extension，用户新增的模型（含斜杠 id 如 `deepseek-ai/deepseek-v4-pro`）在旧 session 里查无此模型，发消息时报 `Model not found`。修复：这两处在重写 extension 后调用 `agentManager.markAllDirty()`，与 `extension:toggle` 等 extension 变更保持一致——激活会话下次使用时（空闲）自动重建进程、重新加载最新 extension；会话历史不丢。
  - 影响范围：`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/ws-provider-dirty.test.ts`

- **切换会话后思考强度丢失，重启后回到 off**：根因有二：① `setSessionPrefs`（Composer 改 model/thinking 时调用）会把整个 session prefs 覆盖到全局 defaults——切到老会话改 model 时，老会话的 thinking（off）被误写进 defaults，污染新会话默认值；② defaults 持久化用 IndexedDB，在 Electron 打包态下 openDB 可能失败，getDefaults 永远返回兜底的 disabled，导致"只要重启就 off"。修复：① `setSessionPrefs` 只把用户本次显式修改的字段增量同步到 defaults；② defaults/recording/newSessionIds 改用 localStorage 持久化（同步、不依赖 IndexedDB 初始化，Electron 下更可靠），session 级 prefs（含 attachments）仍走 IndexedDB。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/store/composer-db.ts`、`packages/frontend/tests/composer-prefs.test.ts`、`packages/frontend/tests/composer-db.test.ts`

- **打包后固定端口 9778，被占用时启动页提示并支持一键重启**：端口变化会导致前端 IndexedDB origin 改变（`http://127.0.0.1:不同端口`），跨 origin 数据不可见，是多个"打包后状态丢失"问题的隐患源头。改为固定端口：端口空闲直接用；被占用时启动页显示提示 +「重启应用」按钮，点击后自动杀掉占用进程（跨平台 lsof/netstat 查 PID + kill）并 relaunch。
  - 影响范围：`packages/desktop/src/main.cjs`、`packages/desktop/src/preload.cjs`、`packages/desktop/src/util/port.cjs`、`packages/desktop/tests/port.cjs.test.ts`

- **Mermaid 图表在流式生成过程中闪现"Mermaid 渲染失败"**：流式生成时代码块内容频繁变化且中途不完整，mermaid 解析必然失败并立即显示错误。修复：render 失败时对错误做 400ms debounce，期间 code 变化会取消错误并回到"图表渲染中…"占位态；仅当 code 稳定后仍失败才显示真正的错误提示。
  - 影响范围：`packages/frontend/src/components/blocks/MermaidBlock.tsx`、`packages/frontend/tests/blocks/MermaidBlock.test.tsx`

- **打包后新建会话会跳转到列表里的某个旧会话，而非新建**：根因是 `NewSessionPane` 的 `newSessionIds`（按项目持久化的"新建会话候选 id"）在会话发送后未及时清理（依赖 kernel `session:created` 事件触发 `clearNewSessionId`，打包态响应慢或 app 重启后从 IndexedDB 读出残留值），导致下次新建会话时 `sessionId` 复用一个已存在的旧会话 id；`addSession` 因此去重 no-op，`selectSession` 把 `currentSessionId` 设成那个旧 id，表现为"跳到上一个会话"。修复：`handleSend` 检测到当前 `sessionId` 已被占用时，生成全新 id 并回填 `newSessionIds`，确保每次发送都是新会话。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`

- **打包（生产安装包）后复制功能失效，点击复制提示"复制失败"**：根因是 Electron 20+ 默认开启 sandbox，preload 脚本 `require("electron")` 解构出的 `clipboard` 不在 sandbox 白名单模块内，导致 preload 加载失败、`window.waPiClipboard` 未注入，前端回退 `navigator.clipboard` 在打包环境的 HTTP 内核页面下失败。修复：在 splashWindow 与 mainWindow 的 `webPreferences` 显式设置 `sandbox: false`，使 preload 的 `clipboard` 桥接恢复正常；`nodeIntegration` 仍为 `false`、`contextIsolation` 仍为 `true`，安全档位不降。
  - 影响范围：`packages/desktop/src/main.cjs`、新增 `packages/desktop/tests/web-preferences.test.ts`

## 2026-07-30

### 修复

- **委托子智能体报 "No API key found for the selected model"**：「跟随主模型」（override/agent 未单独配 model）实际只传了 `null`，子进程没有 `--model` 回退到 pi 默认模型且无 key；且 spawn 时未加载 provider-extension，自定义 provider 在子进程根本不存在。修复：① prompt 时把主会话当前模型记录到 `SessionHandle.currentModel`，`resolveSpawnConfig` 在 model 为空时自动跟随；② `makeSpawnFn` 新增 `extensionPaths` 透传，spawn 子进程时加载 `provider-extension.ts`（含自定义 provider + apiKey）。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/kernel/tests/agent-manager-subagent-overrides.test.ts`

- **聊天界面未选模型时，默认自动选择第一个可用模型**：`ModelSelector` 组件在 `value` 为 null 且存在可用模型时，自动选中第一个模型，避免发送按钮因未选模型而被禁用（原先显示 disabled placeholder "选择模型"，用户必须手动选择才能发送消息）。该行为每个组件实例仅触发一次，后续可由用户手动切换。
  - 影响范围：`packages/frontend/src/components/ui/ModelSelector.tsx`

### 新增功能

- **新增 README.md**：面向第三方的项目介绍——产品定位、核心特性（多智能体/会话/MCP/模型/技能/插件/记忆/双端）、快速开始、mermaid 架构图、项目结构、开发指南、路线图；配图 3 张真实界面截图（`docs/assets/readme/`：会话界面、MCP 连接器、模型管理）。
- 影响范围：`README.md`（新增）、`docs/assets/readme/`（新增 3 张截图）

## 2026-07-30

### 修复

- **打包后 MCP 连接报 "Executable not found: npx" 和 "-32000 Connection closed"**：
  1. `main.cjs` 的 `ensureRuntimeBinLinks` 新增 npx/npm 包装脚本（透传 `bun x`/`bun`）
  2. 新增 `findSystemNode()` 搜索 Homebrew/nvm/fnm 下的真实 Node.js，优先使用而非 bun 替代（MCP 服务器多为 Node 包，bun 不完全兼容）
  3. Windows 对应 .cmd 包装脚本同步支持
  - 影响范围：`packages/desktop/src/main.cjs`

- **已完成 thinking 块因新 thinking 到达而误展开**：thinking 段不再合并（每段独立成卡）；合并行通过 `streamingStartIdx` 区分 finalized/streaming 内容
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`

- **过程卡片展开/弱化逻辑统一**：`useAutoCollapse` 新增 `executingMode` 参数——该模式下 `autoOpen = !isDone`。所有工具/委托卡片统一规则：未完成→展开不透明；已完成→折叠半透明
  - 影响范围：`useAutoCollapse.ts`、`DelegateCard.tsx`、`FleetCard.tsx`、`ToolCallCard.tsx`

- **全项目重命名 HiAgent → WA PI Agent / wa-pi**：产品展示名改为「WA PI Agent」（窗口标题、侧边栏、托盘、productName）；标识符统一 `wa-pi`（npm 包名 `@hiagent/*` → `@wa-pi/*`、数据目录 `~/.hiagent` → `~/.wa-pi`、项目级 `.hiagent/` → `.wa-pi/`、环境变量 `HIAGENT_*` → `WA_PI_*`、二进制 `hiagent-kernel` → `wa-pi-kernel`、`hiagent-bridge.extension.ts` → `wa-pi-bridge.extension.ts`、代码标识符 HiAgent* → WaPi*、settings 字段 hiagent_packages → waPiPackages 等）。约 290 个文件。不迁移旧数据：`~/.hiagent` 保留但不再读取，WA PI Agent 从全新数据目录启动。
- 未改：cocode-master（内嵌第三方仓库）、CHANGELOG 历史条目、gitee 远端仓库名（需平台侧另行改名）、`.workflow/release.yml` 的 OWNER/REPO（指向 gitee 仓库，待仓库改名后同步）。
- 影响范围：全仓库（详见 git diff）

## 2026-07-30

### 修复

- **已完成 thinking 块因新 thinking 到达而误展开**：多段 thinking 合并为一段 + 合并行内所有 segment 共享 `isStreaming`，导致新的 thinking 流式到达时已完成的 thinking 段也被标记为流式、重新展开。改为：1) thinking 段不再合并（每段独立成卡）；2) 合并行通过 `streamingStartIdx` 区分 finalized/streaming 内容，仅 streaming 段获得 `isStreaming=true`。
- 影响范围：`packages/frontend/src/components/MessageList.tsx`（segmentBlocks + 渲染 + RenderedRow 类型）

- **过程卡片（toolCall/delegate/fleet）展开/弱化逻辑统一**：原逻辑 `autoOpen = isStreaming && !isDone` 导致工具调用、委托在"执行中"阶段（block 已定稿但 result 未返回）自动折叠，用户看不到执行进度。改为 `useAutoCollapse` 支持 `executingMode` 参数——该模式下 `autoOpen = !isDone`，所有卡片统一规则：未完成（无 result 或流式中）→ 展开不透明；已完成（有 result）→ 折叠半透明；手动展开后完成 → 展开半透明。ThinkingCard 保持原逻辑不变（`executingMode=false`）。
- 影响范围：`packages/frontend/src/components/blocks/useAutoCollapse.ts`、`DelegateCard.tsx`、`FleetCard.tsx`、`ToolCallCard.tsx`

---

## 2026-07-29

### 配置变更

- **前后端依赖整体升级**：pi-coding-agent 0.80.10→0.82.1、pi-ai→0.82.1、pi-mcp-adapter 2.13.0→2.15.0、pi-web-access→0.15.0、pi-cache-optimizer→2.6.25、pi-memory→0.1.6、@modelcontextprotocol/sdk→1.30.0、vite 6→8、@vitejs/plugin-react 4→6、electron 33→43、electron-builder 25→26、@playwright/test→1.62 等；两个补丁按新版本重建（pi-coding-agent 0.82.1 的 PI_TUI_ONLY 两个 hunk、pi-mcp-adapter 2.15.0 的 mcp-auth.ts exports hunk——上游仍未原生导出）。typebox 因 pi 系包内嵌 1.1.38，保持 1.1.38 对齐（升 1.3.8 会导致泛型实例化过深 TS2589）。typescript 停留 5.x（TS7 为原生预览版暂不跟进）、tailwind 停留 3.x（v4 配置体系重写另行评估）。pi 0.82 契约变化适配：`AgentToolResult.details` 改必填（hiagent-bridge.extension.ts 类型对齐）。
- 影响范围：各 `package.json`、`bun.lock`、`patches/`、`packages/kernel/src/hiagent-bridge.extension.ts`

## 2026-07-29

### 配置变更

- **pi-coding-agent 补丁移除 bash 默认超时 hunk**：应要求恢复上游行为（bash 工具无默认 120s 超时，超时参数可缺省）。补丁现仅含 RPC `custom()` 抛错（PI_TUI_ONLY）与命令分发降级两个 hunk。注意：长耗时 bash 命令不再被 120s 默认超时打断，若出现挂起类问题需另行评估。
- 影响范围：`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch`

## 2026-07-29

### 修复

- **`/mcp-auth` 在 hiagent 卡死**：pi RPC 模式 `ctx.ui.custom()` 是静默 no-op（renderFn 永不调用），pi-mcp-adapter 的裸 `/mcp-auth` 面板命令 `await new Promise(...)` 永久挂起。根因修复改为两层通用方案（替代原 pi-mcp-adapter 定向补丁，该补丁的 commands.ts 守卫 hunk 已移除，仅保留 `mcp-auth.ts` exports hunk）：
  1. **pi 侧兜底**：`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch` 新增 hunk——RPC 模式 `custom()` 改为同步抛错，任何插件的 TUI 面板命令都快速失败（经 pi 命令分发 catch → emitError），永不挂死会话。
  2. **`/` 菜单静态预扫描屏蔽**：kernel 新增 `tui-command-filter.ts`，`AgentManager.getCommands` 对 pi 返回的 extension 命令按 `sourceInfo.path` 扫描扩展包源码，命中 `ui.custom(` 即判定 TUI-only 并从菜单过滤（按扩展粒度，同扩展非 TUI 命令会被一并隐藏，为已接受的取舍）。
- **手动发送扩展命令后前端永远"思考中"且无法停止**：扩展命令被 pi 拦截后不产生 agent_start/agent_end，前端 `optimisticSend` 的 thinking + loading 占位等不到终态。修复：kernel `_sendPromptNow` 的 50ms 无 agent_start 检查复位 busy 时，合成 `agent_end` 广播让前端退出思考态；前端 `agent_end` 处理同步清理 `stopReason==="pending"` 的乐观占位与回声标记（正常流程为 no-op）。
- **TUI-only 命令降级为大模型普通输入**（最终产品决策，替代中途的"报错横幅"方案——该方案已回退）：两层覆盖——① kernel `prompt()` 发送前检查命令名是否属于已识别的 TUI-only 集合（菜单过滤时记录），命中则加前导空格绕过 pi 的 `/` 命令分发（解决 handler"静默成功"不触发 custom() 时前端什么都看不到的问题）；② pi 补丁中 `_tryExecuteExtensionCommand` 捕获 `PI_TUI_ONLY` 错误时 `return false`（覆盖集合未建立或 handler 运行时才触及 custom() 的路径）。原始 `/xxx` 文本按未知命令的既有路径流入大模型，与"菜单屏蔽=命令不存在"的定位一致。`/mcp-auth <server>` 等不触发 `custom()` 的正常路径不受影响。
- 影响范围：`packages/kernel/src/tui-command-filter.ts`（新增）、`packages/kernel/src/agent-manager.ts`（getCommands 拉取点合并 + 合成 agent_end）、`packages/frontend/src/store/session.ts`（agent_end 清理 pending 占位）、`packages/kernel/tests/tui-command-filter.test.ts`（新增）、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/fixtures/fake-session-client.ts`、`packages/frontend/tests/store-session.test.ts`、`patches/pi-mcp-adapter@2.13.0.patch`、`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch`（原 `patches/@earendil-works/pi-coding-agent@0.80.10.patch` 由 bun 1.3 重生成并改名）

## 2025-08-02

### 修复

- **`/mcp-auth` 卡住**：`RpcClient.handleUiRequest` 中 `UI_DIALOG_METHODS` 缺少 `custom` 方法，导致 pi-mcp-adapter 的 `ctx.ui.custom()` 面板请求无回复，pi 进程永久挂起。将 `custom` 加入对话方法集合，无 handler 时自动回 `cancelled`。
- **数据清理**：`~/.hiagent/subagent-overrides.json` 中测试遗留的 `"test-model"` 无效模型已清除；引用不存在工作目录的过期会话文件 `s-518cb4ab-...jsonl` 已删除。
- 影响范围：`packages/kernel/src/rpc-client.ts`
## 2025-07-28

### 修复

- **思考文本不换行**：ThinkingCard/ThinkingPanel 加 `break-words`，ProcessCard 加 `min-w-0`
- **工具来源标签细化**：`listGlobalTools()` 来源从"扩展"细化为 `内置` / `MCP` / 插件包名
- **打包后启动白屏**：`runtime-deps.cjs` 的 `SEED_FILES` 补上 `tool-schemas.ts` 和 `hiagent-bridge.extension.ts`

## 2026-07-29

### 修复

- **文件预览 ENOENT 自动搜索回退**：文件不存在时从祖先目录递归搜索同名文件
- **文件预览胶囊仅对可解析路径显示**：`FilePill` 异步校验存在性，不存在回退为纯文本
- **切回会话时 ask_user_question 被错误取消**：`reconcileDanglingAsks` 新增 `isSessionActive` 参数，活跃会话跳过对账

### 配置变更

- **web_search 默认参数**：启动时写入配置 `workflow: "auto-summary"`，bridge 拦截器强制 `numResults=8`
- **web_search provider 修复**：provider 从硬编码 `exa` 改为 `auto`

---

## 2026-07-28（晚）

### 修复

- **委托提示词 v14 定稿**：deepseek-v4-flash 无思考模式 60/60 通过，提示词总量约 -60%
- **派发评测脚本加固**：每用例前重新生成扩展文件，启动即退出自动重试，评测改在隔离 worktree

---

## 2026-07-28

### 修复

- **新建会话 `/` 菜单不显示动态插件命令**：`getCommands` 支持新会话场景自动创建 session + 启动 pi 进程
- **`/goal` 等命令执行后界面永久显示"思考中"**：50ms 延迟检查自动复位 busy 状态
- **扩展安装/升级/卸载永久卡"安装中"**：终态事件改为 `broadcast` 而非 `reply`

### 新增功能

- **内联 `/` 命令菜单动态注册 pi 的 slash 命令**：新增 `get_commands` 全链路，支持插件贡献命令

### 修复

- **MCP 连接器永久卡"测试中"**：结果事件改为 `broadcast` 而非 `reply`
- **MCP 工具列表弹窗尺寸**：改为 60vw / 80vh

---

## 2025-01-22

### 新增功能

- **Token 消耗进度条**：百分比胶囊改为进度条，宽度 = 累计 token / 模型 contextWindow

---

## 2026-07-27

### 修复

- **委托提示词 v3 融合版定稿**：A/B 实测驱动，explore 88.9%、simple 0% 误派
- **派发评测脚本扩容**：用例 30→60 条，新增 `--repeat N` 多轮采样

### 新增

- **Mermaid 图表渲染**：mermaid 代码块渲染为可视化图表，支持缩放/拖拽/PNG 导出
- **刷新页面后会话未还原进行中状态**：`setMessages` 自动检测未完成的 assistant 消息
- **工具卡片展开/收起宽度跳变**：含过程卡片的列改为固定 `w-[78%]`
- **Token 显示 6 项缺陷修复**：大小写/箭头方向/缓存/子 agent usage/全 0 跳过/存量无胶囊
- **内置 pi-cache-optimizer**：Token/缓存显示，子 agent usage 累加
- **首次打开存量会话慢（5-10s → ~0.3s）**：`session:messages` 改为直接解析 JSONL 文件
- **高级项目经理 + 会议纪要专家角色**
- **角色设置工具 Tab 一直加载中**：改为读 HTTP 响应体
- **编辑角色时 SkillsTab 崩溃**：防御性 `skills ?? []`
- **`get is not defined` 记忆/指令/配置加载失败**：补 `get` 参数
- **归档记忆删除不掉**：entryId 做 `encodeURIComponent`
- **指令文件扫描对齐 pi 框架**：候选文件名/祖先目录遍历/去重
- **指令文件 Tab 无项目上下文时加载失败**：移除 `activeProjectId` 守卫

---

## 2026-07-26

### 设计

- **排队系统重构设计**：采用 pi 原生 `steer()` + HiAgent 本地列表管理

### 修复

- **流式输出 fallback**：`message_update` 缺失 partial 时用 `event.message` 兜底
- **SSE 事件帧修复**：帧格式从命名事件改为无名事件
- **REST 响应体丢失**：8 个 store 的 `load()` 补上 `.then(data => set(...))`
- **Composer 错误兜底**：失败时 `failTurn()` 复位 UI

### 重构

- **阶段一卡顿修复**：kernel 端 50ms 节流 + 前端 rAF 合帧
- **去 WS 化阶段二**：全量迁移到 HTTP REST + SSE
- **去 WS 化测试迁移**：所有测试适配 HTTP fetch + SSE

---

## 2026-07-25

### 新增

- **智能体编辑窗口放大**：80vw × 80vh，禁用遮罩关闭

### 修复

- **代码块内 markdown 表格逐格竖排**：CSS 作用域防护
- **AI 回复中表格/列表行间距异常**：lineHeight 从 3.1 改为 1.55

---

## 2026-07-25

### 修复

- **动态扩展与 agent 目录双重加载**：动态包优先 runtimeRequire
- **pi-mcp-adapter 升级 2.13.0**：bun patch 补 exports
- **发送按钮因过期模型 prefs 置灰**：自愈逻辑按 id 兜底匹配

---

## 2026-07-24

### 修复

- **角色提示词未注入系统提示词**：replace 模式正文替代默认 base
- **主智能体不主动派发子代理**：恢复 Proactive Delegation / Fleet 两节
- **FilePicker 搜索结果目录无法展开**：搜索态下 `listDir` 加载真实子目录
- **DirTreePicker 搜索切换隐藏目录不触发**：补齐 `showHidden` 依赖
- **工具调用卡弱化时机**：拿到 result 即弱化，不再区分成功/失败
- **阻止加载 Pi 默认 skill 目录**：传 `--no-skills` + 显式 `--skill`
- **聊天界面时间线渲染顺序**：按事件到达顺序交错渲染
- **子代理无效模型导致进程崩溃**：校验 override model 格式
- **pi-lens 双重加载 + 工具被过滤**：路径归属判定 + 白名单放行
- **关系网 tab 开关样式**：改为统一 Switch 组件

### 新增

- **首启预置 7 个专家角色**：前端/后端/PM/测试分析师/数据分析师/代码审查/UX 设计师
- **子代理派发遥测 + 评测脚本**：`subagent-telemetry.jsonl` + `eval-delegate-trigger.ts`
- **聊天界面 cocode 显示模式对齐**：ProcessCard 体系 + 折叠/语法高亮/FilePill
- **系统设置-技能页面优化**：搜索框 + 按钮 icon 化
- **CoCode vs HiAgent 差异对比文档**

### 变更

- **移除 4 个旧默认角色**

### 重构

- **bridge 扩展静态化**：`tool-schemas.ts` 作为唯一真源
- **delegate 工具描述移除硬编码内置类型名**

---

## 2026-07-23

### 修复

- **清理 kernel/tests 残留临时文件**
- **frontend 测试套件 11 个既有失败**：zustand store 污染修复
- **引导消息重复发送**：`_promptLocks` 只覆盖 `ensureStarted`

### 新增

- **RPC 迁移验收 E2E**
- **bridge 扩展层**：pi RPC 子进程架构的宿主工具桥
- **技能触发符支持 ¥**

### 重构

- **kernel 测试套件适配 pi RPC 子进程架构**：6 个测试文件重写
- **kernel 从 pi SDK 内嵌迁移到 pi RPC 子进程架构**：`rpc-client.ts` + `agent-manager.ts` 重写

---

## 2026-07-22

### 修复

- **主智能体不主动调用子智能体**：提示词引导重构（OpenCode 式强制策略）
- **按 R 重启端口冲突**：POSIX 递归杀整棵进程树
- **同一回合文本被拆成多个气泡**：重写 `segmentBlocks`

### 新增

- **内置智能体设置支持保存 model 和思考强度**
- **委派引导可配置化**：AgentConfig 新增 `delegationHints` 字段

### 修复（测试基础设施）

- **测试架构隔离**：kernel 不再被强加 happy-dom
- **store-subagents 测试跨文件 mock 泄漏**
- **SessionView 违反 React Hooks 规则**

### 移除

- **死字段 `partners.askFrom`**
- **死字段 `inheritProjectContext`**

---

## 2026-07-21

### 新增

- **默认工作区虚拟项目**：常驻"🏠 默认工作区"（`id="__system__"`）
- **系统提示词可配置化组装框架**：6 段拼装 + `prompts.json` 配置
- **内置 subagent 类型（general-purpose / Explore / Plan）全链路**
- **@ 智能体 chip 渲染 + 按钮选择器自适应**

### 修复

- **宫格弹窗左键内置 subagent 无效**：改为打开只读详情
- **多行发送换行丢失**：contenteditable 块级元素转 `\n`
- **内置 subagent 无 askTo 时无法调起**：始终注册 delegate/fleet 工具
- **@ 内置 subagent 中文 token 识别失败**：token 改用英文 name

### 设计

- **知识库检索技术方案调研**
- **@ 智能体语义改造 spec**

---

## 2026-07-20

### 新增

- **@ 候选菜单只显示 askTo 名单内**
- **系统提示词加 @[agentName] 委托规则**
- **askTo 非空时同时注册 fleet 工具**

### 重构

- **彻底移除 AgentConfig.name 字段**：displayName 成为唯一标识符
- **Composer 发送路径不剥离 @[xxx]**

### 修复

- **历史消息中 @[智能体] 渲染为 chip**
- **委托后刷新出现空气泡**：兼容 `role: "custom"` 判断

---

## 2026-07-19

### 新增

- **多智能体矩阵重写**：动态增删改查 + 关系网调起 + @/$/# 触发符 + DelegateCard
- **新建会话页智能体选择器**：搜索下拉 + 默认选中最近使用

---

## 2026-07-17

### 修复

- **动态插件升级无反馈**：新增 upgrading 状态 + 进度推送
- **未配置模型也能发送**：闸门改为验证模型真实存在
- **agent 启动失败后会话卡"思考中"**：`failTurn()` 复位状态
- **打包后 `modelRuntime.getModels` 报错**：改用包根动态 import
- **Quick Invoke 菜单过窄**：加宽至 560px + 自动滚入视野
- **quick-invoke E2E 全部不可用**：5 个既有缺陷修复

### 新增

- **@ 文件选择支持文件夹**：📁/📄 图标区分

### 修复

- **记忆页开关失效**：kernel 注入链路补消费点
- **Plugin 技能描述显示为 "|"**：支持 YAML 块标量解析
- **大文件上传超时**：`maxPayloadLength` 参数名修正 + WS 自动重连
- **会话状态点永远显示"空闲"**：改用活的会话级状态
- **业务校验错误崩掉 kernel 进程**：dispatch 边界加 try/catch

---

## 2026-07-16

### 新增

- **Quick Invoke 聊天栏快速调用**：@ 文件选择 + $ 技能选择 + contenteditable
- **模型供应商预设快捷选择**：10 条主流预设

### 修复

- **新会话发送后白屏**：kernel 创建 session 后立即回传用户消息
- **停止/队列按钮无响应**：session 注册时机提前
- **会话列表时间不更新**：`message_end` 也调 `touchSession`

### 变更

- **思考过程合并 + 工具调用分组折叠**：两层折叠面板

---

## 2026-07-15

### 重构

- **MCP 连接器改用直连 MCP SDK**：连接测试/工具列举不再经 Pi agent session

### 修复

- **HTTP MCP 鉴权失败**：url 分支透传 headers
- **已连接 MCP 仍保留连接测试按钮**

### 新增

- **切换 MCP 项目作用域后自动连接测试**
- **MCP 编辑改为模态弹窗**
- **MCP 查看工具加载过渡**

---

## 2026-07-14

### 修复

- **动态插件工具自动发现**：改为遍历扩展的 `.tools` Map
- **SDK 自动发现冲突**：改用自有字段 `hiagent_packages`
- **包管理器鲁棒性**：`process.execPath` 替代 `bun`、自动创建 package.json
- **Dev 模式运行时包解析**：新增 `runtimeRequire` 兜底

---

## 2026-07-13

### 新增

- **动态插件系统**：安装/卸载/升级/启用/禁用 npm 插件

### 重构

- **桌面 shell 从 tray-binary 迁到 Electron**：为录音系统声音铺基座

---

## 2026-07-12

### 重构

- **桌面分发定为文件夹模型**：bun build 打包 kernel.js + node_modules
- **前后端端口支持 `.env` 动态配置**

### 新增

- **ask_user_question 结构化澄清提问工具**
- **agent 系统提示词注入执行环境信息**
- **kernel 可导入 + 可选静态前端伺服**

### 修复

- **pi-lens 双重加载 + 工具白名单过滤**
- **记忆页作用域选择器状态丢失**

---

## 2026-07-11

### 重构

- **FilePicker 手风琴展开 + 限定范围搜索**

### 新增

- **记忆管理**：集成 pi-hermes-memory，增删改查 + 指令文件加载

---

## 2026-07-10

### 修复

- **dev 脚本按 R 重启端口漂移**：`strictPort: true` 固守 5180

### 新增

- **grep/find/ls 与 web_search/fetch_content 工具**

---

## 2026-07-09

### 新增

- **Composer 重构**：胶囊输入 + per-session 偏好持久化 + 模型切换/思考强度/附件
- **技能管理**：目录管理 + 启用/禁用 + 热生效
- **系统设置页 + 模型供应商管理**
- **DirTreePicker 搜索过滤**

---

## 2026-07-08

### 新增

- **Steer 消息队列控制**：followUp 排队 + 引导/立即/取消/清空
- **项目列表右键菜单**：查看文件夹 + 删除项目

### 重构

- **Pi SDK 模式重构**：从 spawn RPC 子进程改为同进程 SDK 直连

### 修复

- **pi-intercom 打包为项目依赖**、**Composer 发送防抖**、**会话列表重复**、**首条消息丢失**、**多 session 共享进程问题**、**dev 端口清理**等多项

---

## 2026-07-07

### 架构重构

- **移除 Rust 窗口层**：bun 一键启动前后端，全 bun:test
- **Pi 原生消息模型重构**：收敛到 Pi 富消息模型，删除 broker-proxy 旁路系统

### 新增

- **编排画布**：React Flow 4 agent 节点 + 连线
- **会话列表交互**：右键菜单 + 删除确认
- **多智能体委派**（后随消息模型重构废弃）

### 修复

- **消息流全链路打通**、**会话消息重复**、**E2E 白屏**等多项

### 测试

- **E2E 基础设施 + 7 spec**
- **MVP 四层测试全绿**：kernel 47 + frontend 42 + E2E 4

---

## 2026-07-06

### 新增

- **前端数据层**：WS 客户端 + 4 个 Zustand store
