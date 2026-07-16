# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-16

### 新增
- **Quick Invoke 聊天栏快速调用**：输入 `@` 触发文件选择面板（选中文件以橙色 chip 内联插入，发送时展开为 `@相对路径`）；输入 `$` 触发技能选择面板（靛蓝 chip → `$技能名`）。新增 `ComposerTextarea`（原生 textarea → contenteditable，半受控光标）与 `QuickInvokeMenu` 组件；extension-manager 新增 `getEnabledExtensionSkillPaths()` 自动发现已启用扩展包中的 skills/；`SkillInfo` 加 `source`（builtin/user/extension）字段；提取 `skill-utils` 共享模块供 extension-manager 与 skill-manager 复用，`scan()` 支持 builtin + user + extension 三类来源。
  - 影响：shared(skills.ts)；kernel(skill-utils 新建 + skill-manager/extension-manager/ws-server/agent-manager)；frontend(quick-invoke/ 新建 + ComposerTextarea/QuickInvokeMenu 新建 + ComposerInput/Composer 改造)

### 修复
- **新会话发送后白屏 + 连续发送队列面板即时显示**：kernel 创建 session 后立即经 `reply({ type: "session:echo_user" })` 回传用户消息（不等耗时 5-10s 的 `ensureStarted`），前端 `App.tsx` 收到调 `optimisticSend` 秒显示（`NewSessionPane` 仅 `addSession` 导航，不重复调）。kernel `_promptLocks` session 级串行锁防并发竞态。**连续发送排队**：`Composer` 在 agent 运行中发送时调 `appendLocalFollowUp` 立即追加文本到本地 `queueBySession.followUp`，顶部队列面板秒显排队消息；后续 kernel `queue_update` 回声覆盖为权威列表。影响：frontend(session.ts appendLocalFollowUp + Composer.tsx)。
- **停止/队列按钮无响应 + 清空竞态**：① `ensureStarted` 期间 SDK session 未注册导致按钮静默失败 → `createFn()` 后立即注册到 map，提前可用。② session 未就绪时 `historyLoading=true`，清空按钮置灰禁用。③ 清空队列时先发 `agent:abort` 中断当前 agent，再 `steer:clear-queue` 清空，避免 agent 刚从队列取出下一条消息时清空操作无效导致前端与 kernel 状态不一致。影响：kernel(agent-manager.ts) + frontend(SessionView.tsx)。
- **会话列表时间不更新**：`lastActivity` 原仅在 `agent:prompt` 更新，agent 回复完成不更新。现 `message_end` 事件也调 `touchSession`，会话列表时间反映最后一次活动（含 agent 回复）。影响：kernel(index.ts)。

### 变更
- **思考过程合并 + 工具调用分组折叠**：同一 assistant 消息中多个连续 thinking block 合并为一个折叠面板；流式思考时按钮显示 spinner +「努力思考中…」，完成恢复「💭 思考过程 已完成」；同一消息工具调用合并为「🔧 工具调用记录 (N)」折叠面板（含成功/失败/待执行计数摘要），展开后单项可独立再展开。两层折叠：分组 → 单项详情。影响：frontend(MessageList.tsx 新增 ToolCallGroup + ThinkingBlock isStreaming prop)。

---

## 2026-07-15

### 重构
- **MCP 连接器改用直连 MCP SDK**：连接测试/查看工具/清除授权原拉起临时 Pi agent session 发 `/mcp reconnect` 等斜杠命令，但扩展命令经 `pi.sendMessage()` 自管理、`prompt()` 立即 resolve 且不产生事件 → 前端永远等不到结果（30s 超时「无反应」）。新增 `mcp-connector.ts` 用 `@modelcontextprotocol/sdk` 的 `Client` + Stdio/HTTP transport 直连，握手后列举工具（与 pi-mcp-adapter 内部 `McpServerManager.createConnection` 同逻辑，不深导入以免重依赖进内核 bundle）。`McpTestResult` 新增 `status`（connected/needs_auth/error/disconnected）与 `toolCount`；`mcp:listTools` 改为实时连接列举（原读 mcp-cache.json 几乎总空）。设计上：配置管理 + 连接测试归内核，MCP 工具运行时仍由 pi-mcp-adapter 在 agent 会话内承载。
  - 影响：kernel(mcp-connector.ts 新建 + ws-server/mcp-store/tsconfig)；shared(mcp.ts)；frontend(store/mcp + McpPage/McpCard)

### 修复
- **HTTP MCP 服务器连接测试报 Zod invalid_union**：`mcp-connector.ts` 的 url 分支 `new StreamableHTTPClientTransport(url)` 丢了 `config.headers` → 需鉴权 HTTP MCP（如智谱 web-reader/web-search-prime/zread）收不到 Authorization 头，返回非 JSON-RPC 错误信封 → SDK `JSONRPCMessageSchema.parse` 抛 Zod。修复：url 分支经 `requestInit.headers` 透传；新增 `isJsonRpcSchemaError` 识别校验失败返回可读提示替代原始 Zod JSON。
- **已连接 MCP 服务器保留「连接测试」按钮**：`McpCard` 原在 connected 时隐藏该按钮，现始终显示（测试中禁用），可随时重测。

### 新增
- **切换 MCP 项目作用域后自动连接测试**：作用域列表加载完成后自动对每个服务器逐个发起 `mcp:test`，卡片即时显示连通状态；用 `autoTestedProject` 记账避免重复自动测试；`testingServer`（单槽位）重构为 `testingServers`（Record）支持并行测试。
- **新增/编辑 MCP 服务器改为模态弹窗**：原页面内联常驻表单改为居中 `McpFormModal`（复用 Modal，支持遮罩/✕/ESC 关闭，编辑预填）。
- **查看工具加载过渡**：首次 `mcp:listTools` 时弹窗显示 loading 而非误导性的空态；新增 per-server `loadingTools` 标记。

---

## 2026-07-14

### 修复
- **动态插件工具自动发现**：`extractRuntimeToolNames` 读取 SDK 结构错误（`runtime.tools` 不存在；每个扩展独立持有 `.tools` Map），改为遍历 `getExtensions().extensions[].tools` + 兜底 `getAllTools()`；`resolveAgentTools` 新增 `harvestedTools` 参数合并动态发现的工具进 allowlist（去重）。解决「装了 pi-hypa 但 agent 看不到 hypa_* 工具」。
- **SDK 自动发现冲突**：SDK 的 `SettingsManager.getPackages()` 读 `settings.json.packages` 自动安装到 `~/.hiagent/npm/`，与 HiAgent 经 `additionalExtensionPaths` 注入产生双重加载 → 工具注册冲突。改用自有字段 `hiagent_packages`/`hiagent_disabledPackages`（SDK 不读），首次读取时自动迁移旧字段并删除。扩展加载改为单轨（仅 additionalExtensionPaths）。
- **包管理器鲁棒性**：`Bun.spawn(["bun",...])` 在 desktop 下 PATH 不含 bun → ENOENT，改用 `process.execPath`；`bun remove` 在无 package.json 时报错 → 构造函数自动创建；`uninstall` 检查 node_modules 存在性。
- **Dev 模式运行时包解析**：dev 模式下 `require.resolve` 从 repo 解析找不到 `~/.hiagent/runtime/node_modules/` 动态包，新增 `runtimeRequire` 兜底。
- 影响：shared(constants.ts)；kernel(extensions.ts/extension-manager.ts/agent-manager.ts/npm-package-service.ts)

---

## 2026-07-13

### 新增
- **动态插件系统**：设置面板支持安装/卸载/升级/启用/禁用 npm 插件；扩展加载双轨制（核心扩展走 additionalExtensionPaths，动态插件走 packages 字段）；移除 OPTIONAL_EXTENSIONS 硬编码与 migrateSettingsPackages()。新增 `npm-package-service.ts`。影响：kernel(extension-manager/extensions/index/ws-server)、shared、frontend(ExtensionSection/store/extensions)。

### 重构
- **桌面 shell 从 tray-binary 迁到 Electron**：为录音系统声音（spec B）铺基座。Electron main（单实例锁 + BrowserWindow + 生命周期 + 托盘）+ kernel 解释 sidecar（`bun.exe run kernel.js` + node_modules，放 resources/kernel/；编译 exe 已证伪——pi SDK jiti 撞 bun compile 虚拟 FS → agent 创建挂）+ electron-builder 打包。前端零改动（BrowserWindow load 9776）。**录音系统声音 Win 真机 POC 已过**（`setDisplayMediaRequestHandler` + `audio:'loopback'` 去框抓系统声音）。影响：packages/desktop 整体改写为 Electron。已知：Win 首启 Defender 扫未签名 exe 要数分钟（代码签名=后续）；macOS=phase 2。

---

## 2026-07-12

### 重构
- **桌面分发定为文件夹模型**：实测「编译单 exe」路线 agent 创建失败——pi SDK jiti 在编译二进制里把 `require("pi-intercom/package.json")` 解析到 bun compile 虚拟 FS 而非磁盘 node_modules（磁盘回退不覆盖 jiti 解析器）。改用文件夹模型：launcher exe + `bun.exe` + `kernel.js`（`bun build src/desktop-server.ts --target bun` 打包 2923 模块为 12MB JS bundle，解释运行）+ `node_modules`（`bun install --production` 装 506 包，排除已内联的 workspace 包）+ `web/`；解释运行时 jiti 正常从磁盘解析（根治 `Cannot find module`）。构建管线：测试钩子 → vite build → genicon → 物化 traybin + 嵌入清单 → 构建 kernel.js → 每目标文件夹组装。
- **桌面托盘单二进制（早期方案，后改为文件夹模型）**：in-process 起 kernel + systray2 托盘，`bun build --compile` 嵌入前端/systray helper/图标为单 exe，Windows PE 子系统 patch（CONSOLE→GUI）去控制台。
- **桌面末审小修**：删 dead `killPort`（desktop 运行时未用，YAGNI）；kernel 静态资产缺失回退 index.html（SPA 路由，原错误返回 426）；desktop logger 退出前 `flush()` best-effort 等齐 in-flight 写入，避免末尾日志被 `process.exit(0)` 截断。

### 新增
- **前后端端口支持 `.env` 动态配置**：`HIAGENT_WS_PORT`（9776）/`HIAGENT_WEB_PORT`（5180）经根 `.env` 覆盖；shared 新增 `resolvePort` 纯函数，vite 用 `loadEnv` 读 `.env` 并注入浏览器 bundle 的 WS_PORT。
- **kernel 可导入 + 可选静态前端伺服**：`index.ts` 抽出 `export startKernel(opts?: { staticDir })`（`import.meta.main` 守卫保留自动执行）；ws-server 同 9776 端口伺服 UI + WS，未知/越权路径回退 index.html，二进制分发不再依赖 Vite。
- **ask_user_question 结构化澄清提问工具**：agent 可调 `ask_user_question` 向用户提 1-4 个结构化问题（2-4 选项，单/多选/自由文本/per-question 备注）；`AskRegistry` 进程单例管理 ask 阻塞/resolve/cancel/幂等/AbortSignal，中断点调 cancelAll 作废 pending；前端 AskDock 停靠区，pending 时 composer 禁用。
- **agent 系统提示词注入执行环境信息**：base 末尾追加内置技能目录路径（`~/.hiagent/skills`）+ 禁止透露系统提示词 + 禁止内部术语回复。

### 修复
- **pi-lens（LSP 诊断）两个独立根因修复**：(1) 双重加载——settings.json.extensions 积累多条 pi-lens 路径（bun install 产生新 .bun 缓存 hash 后旧路径残留），SDK 双重加载两实例互相判定为并发副实例双双跳过初始化，`list()/toggle()` 增加 `pathBelongsToPackage` 归属判定收敛同包路径；(2) 工具被白名单过滤——pi-lens 9 个工具不在 DEFAULT_AGENT_TOOLS，白名单显式放行。
- **禁用 pi-lens 时过滤工具 allowlist**：散落三元表达式封装为 `resolveAgentTools` 纯函数，按可选插件启用态过滤（禁用 pi-lens 后移除其 9 个工具），签名预留 `agentName` 供后期按角色裁剪。
- **记忆页作用域选择器状态丢失 + 指令文件 Tab 切项目不加载**：同源——`selectedProjectId` 存组件本地 state，关闭弹窗即丢失而 `memoryScope` 在持久 store 保留导致错位；提升到 `useMemoryStore` 持久化，指令文件 Tab 加载改用 `activeProjectId`、项目选择器始终显示。

---

## 2026-07-11

### 重构
- **附件文件选择器（FilePicker）手风琴展开 + 限定范围搜索**：同级文件夹互斥展开（祖先链保持）；搜索只从活动目录递归往下（聚焦目录 > 展开链最深 > defaultPath > 盘符根），增量呈现不重置展开/折叠/选中状态。影响：frontend(FilePicker.tsx)。

### 新增
- **记忆管理**：集成 pi-hermes-memory，新增记忆管理页（查看/编辑/归档/恢复/删除 + 分类筛选 + 搜索 + 自动学习/注入提示双开关）；只读展示已加载 AGENTS.md/CLAUDE.md（全局/项目筛选）。影响：kernel(memory-store/ws-server/extensions)、frontend(MemoryPage/store/memory)、shared。

---

## 2026-07-10

### 修复
- **dev 脚本按 R 重启时前端端口漂移**：Vite 换端口但浏览器停留旧端口；`dev.ts` 用 `lastOpenedFrontendPort` 追踪端口变化自动重开，vite 加 `strictPort: true` 固守 5180，端口不变不重复开标签页。

### 新增
- **grep/find/ls 与网络搜索抓取工具**：`grep`/`find`/`ls` 为 Pi 内置工具直接加默认 fallback；`web_search`/`fetch_content`/`get_search_content` 由 pi-web-access 扩展提供，kernel 启动时 `ensureWebAccessInstalled()` 自动注册到 settings.json（幂等 + 支持从旧 `npm:pi-web-access` 格式迁移）；新增 `DEFAULT_AGENT_TOOLS` 常量统一默认工具集。

---

## 2026-07-09

### 新增
- **Composer 重构（Tasks 1-18 收尾）**：`Composer`/`NewSessionPane` 统一接入可复用 `ComposerInput` 胶囊输入组件与 `composer-prefs` Zustand store——模型切换、思考强度开关、附件（图片/文件/文本片段）选择与展示；per-session 偏好 + 全局默认值经 IndexedDB（`composer-db.ts` 封装 idb）持久化。供应商模型新增 `supportsVision`，kernel `agent:prompt` 支持按请求切换模型与 thinking level，图片附件按模型 vision 支持决定直接作为 images 发送或降级为文本引用；新增 `fs:readFile` WS 接口。配套子组件：ModelSelector/ThinkingToggle/AttachmentChip/AttachmentPathModal/ComposerTextarea。
  - 影响：frontend(Composer/NewSessionPane/composer-prefs/composer-db + ui/* 多组件)、kernel(agent-manager/ws-server/index)、shared(types.ts/providers.ts)
- **技能管理**：系统设置页新增「技能」菜单——管理技能加载目录（内置 `~/.hiagent/skills/` 不可删 + 用户自定义目录增删）、查看已加载技能列表、单独启用/禁用，同名去重（内置优先），配置变更后自动 reload 所有活跃会话热生效。
- **系统设置页 + 模型供应商管理**：新增「⚙ 系统设置」入口与全屏设置页，自定义 LLM 供应商管理（增删改查：名称/baseURL/apiKey/API 格式/模型列表，模型 ID 经 tag 录入，每模型可配上下文窗口与最大输出，支持连通测试）；供应商经 Pi extension 的 `pi.registerProvider()` 注册，会话用 `<slug>/<modelId>` 引用。
- **DirTreePicker 搜索过滤**：目录选择器新增搜索框，不区分大小写匹配目录名，保留匹配节点完整父级链并展开，清空恢复完整树，无匹配显示提示。

---

## 2026-07-08

### 新增
- **Steer 消息队列控制**：agent 运行中用户消息默认 followUp 排队，支持「引导」升级、「立即」执行、「取消」引导、「清空」排队；4 个 WS steer 事件 + queue_update SDKEvent + AgentManager 5 个队列方法。
- **项目列表右键菜单**：查看文件夹（`project:open-dir`，系统文件浏览器打开项目目录）+ 删除项目（确认框后 `project:delete` 删除项目及所有会话）。

### 重构
- **Pi SDK 模式重构**：kernel 从 spawn `pi --mode rpc` 子进程 + JSON-RPC 改为同进程 `createAgentSession` SDK 直连；AgentManager 用 `Map<sessionId, AgentSession>` 管理多会话，事件用 `sdk:event` 信封全量透传前端；删除 pi-rpc-client.ts 和 state-aggregator.ts。

### 修复
- **pi-intercom 打包为项目依赖**：从运行时 npm install（settings.json `npm:pi-intercom` 触发 DefaultResourceLoader）改为 `@hiagent/kernel` 本地依赖，经 `import.meta.resolve` 解析路径写入 settings.json，消除运行时 `npm install` 及 code 190 错误；支持旧格式自动迁移。
- **Composer/NewSessionPane 发送防抖**：React 批量更新导致 `setText("")` 与下次 Enter 间有竞态窗口 send 被调两次；加 `sendingRef` 标志位 500ms 复位 gate。
- **会话列表 UI 重复**：`agent:prompt` handler 每次广播 `session:created`（即使复用 session），前端 `addSession` 不去重 → 重复；kernel 仅新建时广播 + 前端去重兜底。
- **NewSessionPane 首条用户消息丢失**：`session:created` 触发切 SessionView，但 SessionView onMessage 订阅在 useEffect 注册时 `agent:message` 已到达被 App 丢弃；App onMessage 增加 `agent:message` 处理直接 append（靠 msgKey 去重）。
- **NewSessionPane 连发产生多个重复 session**：前端每次 `randomSessionId()` + kernel 忽略前端 sessionId；前端 sessionId 改 useState 生成一次复用，后端 `createSession` 加可选 id 参数。
- **首条消息用户/agent 顺序颠倒**：SessionView 挂载前 user message 被 App 丢弃，挂载后 assistant 先 append、`session:messages` 把 user 追到末尾；setMessages 合并后按 timestamp 排序。
- **新建会话显示相同聊天内容**：Pi RPC 不支持单进程多会话（prompt/get_messages 不接受 session 参数），AgentManager 以 `(projectId, agentName)` 为 key 让多会话共享一个 Pi 进程；进程管理粒度改为 `(projectId, agentName, sessionId)`，每会话独立 Pi 进程。
- **dev 启动端口清理增强**：`killPort` kill 后改轮询等待端口真正空闲（最多 3s，解决 TIME_WAIT 窗口期未释放）；`dev.ts` 从 Vite 输出解析实际端口；`killPort` PID 查不到时加 `isPortInUse` 二次确认 + 强制清理兜底。

### 配置变更
- **pi 环境本地化 + Windows 兼容**：`@earendil-works/pi-coding-agent` 从全局依赖改为 `@hiagent/kernel` 本地 dependency，`defaultSpawn` 用 `import.meta.resolveSync` 解析本地 dist/cli.js 由 bun 执行；`Bun.spawn` 加 `shell: true` 让 cmd.exe 解析 PATHEXT 找 npm 全局 pi.cmd shim（POSIX 无害）。

---

## 2026-07-07

（整体为 MVP 构建，跨 43 Task 三阶段交付）

### 架构重构
- **移除 Rust 窗口层 + bun 一键启动 + 全 bun:test + 目录树选择器**：移除 Tauri/Rust 窗口层，改用 `bun run dev` 一键启动前后端（并行 kernel 9776 WS + frontend 5180 Vite，自动开浏览器，SIGINT 清理）；测试工具链 vitest → bun:test（24 文件迁移，全仓库单一 runner）；新增本地目录树选择器（react-complex-tree + kernel `fs:listDir`/`fs:roots`/`fs:home`）替代 Tauri 原生目录选择器。
- **Pi 原生消息模型重构**（39 files, +659 / −1875，净减 1216 行）：消息流从 kernel 自管拍扁 ChatMessage + 多套旁路系统（broker-proxy / intercom-monitor / intercom store / AskCard）统一收敛到 **Pi 原生富消息模型**——kernel 透传 Pi 的 `AgentMessage`（含 thinking/text/toolCall/intercom 等内容块），历史会话改由 `getMessages()` 实时拉取 Pi session（不再读拍扁 sessions 文件），前端按内容块类型富渲染（react-markdown）；配置从 `~/.pi/agent` 隔离到 `~/.hiagent/agents`（HiAgent 与 Pi CLI 互不污染）。删除 broker-proxy.ts + intercom-monitor.ts 整套旁路系统 + 前端 useIntercomStore/AskCard。
- **Tauri 项目骨架（后随架构重构移除）**：Cargo + tauri.conf + 空壳窗口；Bun sidecar 编译（`bun build --compile` 产出 hiagent-kernel + Rust target triple 后缀副本）；Rust 主进程管理 kernel sidecar 生命周期（spawn + 窗口关闭 kill）；kernel 全自动热更新（fswatch 重编 + Rust notify 监听 dist 重启 sidecar，前端改动仍由 Vite HMR）。

### 新增
- **编排画布**：React Flow Canvas 组件（4 agent 节点四角布局，partners 灰色虚线连线，活跃 ask 橙色动画连线，resolved 不连线）；App 加 canvas 视图态 + 「← 返回会话」。
- **会话列表交互**：列表按 `lastActivity` 倒序 + 右键 popup 菜单（重命名/删除）+ 删除确认框（红色危险按钮）；新增公共 Modal/ConfirmDialog 组件。
- **新建项目原生目录选择器**：Tauri dialog 接入 + `pickDirectory()` 封装（非 Tauri 降级 prompt）+ basename 取名建项目 + 点项目名切换当前项目。
- **老数据迁移**：老用户首启无项目但有孤儿 session → 自动建「默认项目」并 reassign 归入。
- **多智能体委派（BrokerProxyManager，后随消息模型重构废弃）**：kernel 在 pi-intercom broker 为每个 agent 注册轻量代理 session，其他 agent 经 intercom 工具发消息时代理接收 → 按需启动真实 Pi 进程 → relay 转发，支持链式委派，200+ agent 可扩展（仅 socket 连接，无需预启动进程）。

### 修复
- **消息流全链路打通**：发送无回复——根因多重：①前端没处理 agent:message/agent:state/error 事件 ②PiRpcClient 不认 pi 0.80 的 response 协议 ③pi 的 `--cwd` 参数不存在 ④Bun.spawn stdout 是 Web Streams 非 Node EventEmitter ⑤bun 全局装残缺 pi（缺 proper-lockfile）被优先解析。逐层修复后错误（如 No API key）正确透传前端。
- **会话消息重复**：流式 message_start/update/end 三阶段均触发 appendMessage 持久化 → 同 id 多次 push；改为同 id 更新 + 前端 setMessages 加载历史按 id 去重。
- **start.sh broker 自愈**：kernel 启动无条件连 broker socket，broker 僵死（进程在 socket 删）→ ENOENT 崩溃；`ensure_broker` 检测 socket 不可用自动清理重启。
- **start.command 双击启动失败**：`start.sh` 在 `set -uo pipefail` 下 source ~/.zshrc，zsh 专用语法（autoload/setopt）静默 abort；改 grep+sed 只提取 `DEEPSEEK_API_KEY`。
- **E2E 暴露前端白屏**：shared `process.env` 访问加 `typeof process !== "undefined"` 守卫（浏览器无 process 全局，import 即崩白屏）+ `HIAGENT_DIR` env 覆盖；`randomSessionId` 去 node:crypto 改全局 `crypto.randomUUID()`；intercom-monitor broker 连接失败 `resolve(null)` 降级。
- **Agent Browser 真实业务测试修 4 bug**：ErrorEvent 缺 agentName（前端错误显示为 "dev"）、智能体配置缺失（~/.hiagent/agents/ 不存在）致设置页永久加载中、新建项目目录树第二次打开为空（root 懒加载竞态）、state-aggregator 错误未传结构化 agentName。
- **flaky 测试「点击空白处关闭 popup」**：`requestAnimationFrame` → `setTimeout(fn,0)`、`window.addEventListener` → `document.addEventListener`，测试加 `afterEach(cleanup)`。

### 测试
- **E2E 基础设施 + 7 spec**：Playwright globalSetup 启隔离 kernel（独立 HIAGENT_DIR 随机目录 + globalTeardown 杀进程清目录）+ 7 spec（4 串行主流程 passed，3 需 pi 环境 skip）。
- **MVP 四层测试全绿**：kernel + shared 47 passed、frontend 42 passed、E2E 4 passed + 3 skipped。

### 文档
- **pi-native-message-model 设计文档二次核查**：修正 9 处事实/类型/行号错误；撤回 broker-proxy「靠 `**Reply from X:**` 文本解析、脆弱」论据（核查源码确认其用结构化 API），废弃决策保留但论据改为「职责重叠」（路由/会话名占位/状态影子三层重复）。
- **hiagent-design 对齐多项目重构**：以 sidebar-projects-design 为基准回溯修正单项目描述（启动页/视图清单/AgentManager 双 key/WS 协议字段等）。

---

## 2026-07-06

### 新增
- **前端数据层**：单例 WS 客户端（`ws-instance.ts`，懒连接 kernel 9776）+ projects/session/agents/intercom 四个 Zustand store，供后续所有组件依赖；顺带修复 Vite alias 相对路径解析 bug（原相对字符串，Vite 以引用方文件解析失败，改 `fileURLToPath` 绝对路径）。

### 文档
- **hiagent-design 对齐多项目重构**：以 `2026-07-06-sidebar-projects-design.md` 为基准，消除两份设计文档冲突。
