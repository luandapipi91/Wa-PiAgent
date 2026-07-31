# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-31

### 修复

- **会话标题误用角色名，且兜底创建的会话标题不被更新**：根因有两处。①`agent-manager.ts` 的 `getCommands` 兜底分支创建会话时用 `title: agentName`（角色名）做标题——此时还没有用户消息，但角色名会固化成标题不再更新；②`ws-server.ts` 的 `agent:prompt` 只在新建会话时设标题（`event.text.slice(0,20)`），已有会话（含兜底创建的空/角色名标题）发首条消息时不更新。修复：①兜底创建改用空标题占位（不再用 agentName）；②新增 `fillSessionTitleIfEmpty` 方法，每次发送消息时检查标题，为空则用消息内容前 20 字符填充并广播 `projects:list` 刷新侧栏；已有标题（用户手动命名或已填充）不覆盖。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（兜底 createSession title: agentName → ""）、`packages/kernel/src/project-store.ts`（新增 fillSessionTitleIfEmpty）、`packages/kernel/src/ws-server.ts`（agent:prompt 非 isNew 分支调用 fillSessionTitleIfEmpty）、`packages/kernel/tests/project-store.test.ts`（新增 3 个用例：空标题填充 / 已有标题不覆盖 / 会话不存在）
  - 验证：`bun test` project-store 16 pass；kernel 全量 602 pass；`typecheck` 通过。

- **重发失败消息后刷新页面出现多条重复发送记录**：根因是 pi 把每次 prompt（无论成败）都 append 进 jsonl，重发失败消息时前端只裁了内存（truncate）但 jsonl 原文不动，刷新后从 jsonl 加载就出现多条相同的 user 发送记录。修复：在 `readSessionHistory` 读出历史时新增 `dedupeConsecutiveFailedTurns` 失败回合去重——连续的「user + error assistant」失败对，若下一对是相同文本的重发，则折叠前面那组。既消除重发堆积，又保留：①最后一组失败回合（fatal error 需提示用户改配置）；②连续失败后成功的场景（前面失败组折叠，只剩成功回合）；③非连续不同问题的失败（各自保留）。JSONL 原文不动，仅展示层去重。
  - 影响范围：`packages/kernel/src/session-history.ts`（新增 dedupeConsecutiveFailedTurns + userText + isFailedTurnStart/isFailedAssistant）、`packages/kernel/tests/session-history.test.ts`（新增 4 个去重用例：连续失败去重 / 失败后成功 / 非连续保留 / 单次保留）
  - 验证：用真实会话 jsonl（3 组失败回合）端到端验证去重；kernel 全量 `bun test` 596 pass；`typecheck` 通过。

- **404 确定性错误被误分类为 transient，导致误导性"模型连接异常"状态条 + 卡 loading**：根因是 `sdk-errors.ts` 的 transient 正则用了宽泛的 `5\d\d` 匹配 5xx 状态码，而 404 错误页 HTML（provider 返回的网站页面）里含任意三位数（如像素宽度 "563"）会被误命中；同时 FATAL 正则只覆盖 401/403，漏了 404。结果确定性失败（404 模型/路径不存在）被当成网络重试，既显示误导文案（检查网络）又不结束当前轮次（loading 不消失）。修复：①transient 的 `5\d\d` 收紧为精确 `500|502|503|504|524`，对齐 pi-ai 0.83.0 retry.js 的做法；②FATAL 增加 `404`；③新增 `sanitizeErrorMessage` 清洗 HTML 错误页——provider baseUrl 错误时返回整页 HTML，原样贴到会话流不可读，现提取 HTTP 状态码映射到预设通用提示枚举（如 404 → "接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID"），未枚举的状态码按段位给通用提示（4xx → "请求错误（NNN），请检查请求参数或 Provider 配置"；5xx → "服务端错误（NNN），请稍后重试"），非 HTML 文案原样保留。现在 404 走 fatal 分支 → 清晰的红色错误消息 + 正常结束 loading。
  - 影响范围：`packages/kernel/src/sdk-errors.ts`（TRANSIENT_ERROR_PATTERN 收紧、FATAL_ERROR_PATTERN 加 404、新增 HTTP_STATUS_HINTS 枚举 + sanitizeErrorMessage 含段位兜底）、`packages/kernel/tests/sdk-errors.test.ts`（新增 404 HTML 回归用例 + 明文 500 仍 transient 用例 + HTML 映射枚举用例 + 未枚举 4xx/5xx 段位兜底用例）
  - 验证：用真实 opencode-go provider 404 响应端到端验证分类为 fatal + message 映射到通用提示；`bun test` sdk-errors 33 pass；kernel `typecheck` 通过。

### 变更

- **升级 `@earendil-works/pi-coding-agent` / `pi-ai` 0.82.1 → 0.83.0**：同步上游 0.83.0 发布（TypeBox 1.3.7、OAuth 提前刷新、流式 stop reason 透传等）。核查后确认：①TypeBox 移除的 `Type.Base`/`Type.Promise` 等废弃 API 本项目扩展代码（`wa-pi-bridge.extension.ts`、`amaster-memory.ts`、`tool-schemas.ts`）均未使用，无影响；②0.83.0 的 `pending` stop reason 不进入 `message_end` 事件，项目 `stopReason === "error"` 错误兜底管线（`sdk-errors.ts`/`session-history.ts`）判定逻辑与上游一致，不受影响；③0.83.0 **未修复** RPC 模式 `ctx.ui.custom()` 静默 no-op 导致会话挂起的问题（`custom()` 仍是 `return undefined`），原 patch 逻辑仍需保留，已用 `bun patch` 针对 0.83.0 dist 重新生成 patch（行号/hash 变更，逻辑不变：同步抛 `PI_TUI_ONLY` + agent-session catch 识别降级为普通 prompt）。
  - 影响范围：`packages/kernel/package.json`（`^0.82.1` → `^0.83.0`）、`package.json`（`patchedDependencies` key 版本号同步 0.82.1→0.83.0）、`patches/@earendil-works%2Fpi-coding-agent@0.83.0.patch`（新增，替换旧 0.82.1 patch）
  - 验证：四包 `typecheck` 全绿；`bun test` kernel 584 pass / shared 92 pass / frontend 单文件跑全绿（全量并发 flaky 与升级无关，属历史遗留 happy-dom 并发竞争）。

- **移除角色「提示词模式」（systemPromptMode）字段**：角色设置里的提示词模式原本有「替换/追加」两个选项，现在彻底移除该字段，全系统恒为「替换」语义——有 `systemPromptBody`（agent.md 正文）时替代默认 base 提示词，无则用默认。字段从 `AgentConfig` 类型、agent.md 解析/序列化、校验、UI、subagent 运行时全部删除。旧 agent.md 文件里残留的 `systemPromptMode:` 行在解析时被静默忽略（不报错），向后兼容。
  - 影响范围：`packages/shared/src/types.ts`（删 `AgentConfig.systemPromptMode`）、`packages/kernel/src/agent-md.ts`（删读取/写出/校验/默认）、`packages/kernel/src/agent-manager.ts`（删内置与命名 subagent 构造里的赋值 + 简化 prompt 组合逻辑）、`packages/kernel/src/subagent-runner.ts`（删 `WaPiSpawnConfig.systemPromptMode`）、`packages/frontend/src/components/AgentConfig.tsx`（删内置 draft 赋值 + 删「模式」UI 行）、相关测试 fixture 与用例同步清理
  - 验证：三包 `typecheck` 通过；`bun test` shared 87 pass / kernel 580 pass / frontend 806 pass，全绿。

- **首次录音默认音源改为系统音频**：原默认为麦克风（mic）。将首次录音（localStorage 无 `wa-pi:recording-prefs` 偏好记录时）的回落默认值从 `mic` 改为 `system`（系统音频）。已录过音的老用户不受影响（localStorage 有上次音源记录，优先用该值）。改动两处硬编码初始值：`RecordButton` 组件本地 state 初始值（挂载后仍会被 localStorage 真实偏好覆盖）、`useRecordingStore` 初始 `source`。系统音频的 Electron loopback 能力早已就绪，无需新增 desktop 代码。
  - 影响范围：`packages/frontend/src/components/ui/RecordButton.tsx`（`useState` 初始值 mic→system）、`packages/frontend/src/store/recording.ts`（store 初始 `source` mic→system）、`packages/frontend/tests/RecordButton.test.tsx`（更新过时标题 + 新增首次默认 system 用例）

### 修复

- **预设 provider 保存后报 `Model not found`**：根因是 slug 派生不一致——pi 内置 provider id 是 `opencode-go`，但前端"快捷选择"只把预设的显示名（`OpenCode Zen Go`）填入表单，丢弃了 key（`opencode-go`）。保存后 `slugifyProviderName("OpenCode Zen Go")` → slug `opencode-zen-go`，extension 注册了一个与内置**不同名**的 provider，发消息时 `setModel("opencode-zen-go", ...)` 在 pi 的 `getAvailable()` 里找不到（内置那个叫 `opencode-go` 且无 apiKey），报 `Model not found`。修复：`ModelProvider` 加可选 `slug` 字段；选预设时存 `preset.key`（对齐内置 provider id），extension 注册会**增强**内置 provider（补 apiKey）而非另起一个；非预设/旧数据 slug 为空，fallback 到现有 name 派生（完全向后兼容）。新增 `resolveProviderSlug(provider, usedSlugs)` 统一替换全链路 6 处 slug 派生点。
  - 影响范围：`packages/shared/src/providers.ts`（加 `ModelProvider.slug?` 字段 + `resolveProviderSlug` 纯函数 + `isModelAvailable` 内部改用它）、`packages/kernel/src/provider-extension.ts`（`slugifyProviders` 改用 `resolveProviderSlug`）、`packages/frontend/src/components/settings/ProviderFormModal.tsx`（选预设时 `setSlug(preset.key)` + 保存写入 slug + 编辑模式预填）、`packages/frontend/src/components/ui/ModelSelector.tsx`、`SessionView.tsx`、`AgentConfig.tsx`（3 处 slug 派生改用 `resolveProviderSlug`）
  - 验证：TDD 推进，shared 23 pass / kernel provider-extension 16 pass / frontend ProviderFormModal 23 pass + ModelSelector 9 pass，全绿；旧数据无 slug 字段走 fallback，行为不变。

- **`ws-extension-skill-refresh` SSE 测试随机超时失败**：根因是测试竞态，非 flaky。`ReadableStream.start`（把 write 函数注册到 `SseBus`）是惰性触发的——只有消费者开始 `read()` 时才执行。测试 `connectSse` 拿到 reader 后立即发 HTTP 请求触发 `broadcast skill:changed`，此时 `start` 可能尚未执行、`bus.clients` 仍为空，事件被永久丢弃（SSE 无缓冲、无重放），导致 `waitForSseEvent` 3 秒超时。失败用例每次不同（install/uninstall/upgrade/toggle 随机中招）正是此机制。修复：`connectSse` 返回前先 `await reader.read()` 消费首帧（`: connected` 注释），强制触发 `start → bus.add(write)`，确保后续广播能送达。连跑 8 次全绿。
  - 影响范围：`packages/kernel/tests/ws-extension-skill-refresh.test.ts`（`connectSse` 加首读预热）

### 新增

- **空闲会话子进程定时回收（1 分钟阈值）**：用户切走/闲置的会话背后常驻一个 `pi --mode rpc` 子进程（每个聊天窗口一个），长期不回收会累积内存。新增后端定时器：每 30s 扫描活跃会话，对 `lastActivity` 超过 **1 分钟** 且**非 busy**（未在思考/跑工具）的会话调用 `disposeSession` 回收子进程。回收只杀进程、**保留会话记录与 jsonl 历史**，用户再点开时 `ensureStarted` 从 jsonl 冷启动恢复，不丢消息。busy 会话（正在思考）绝不回收，留待 `agent_settled` 后下一轮处理。
  - **续命点**（重置 1 分钟倒计时）：用户发消息（prompt）、agent 回复完成（message_end）、用户发引导消息（steer）、用户打开会话查看消息（session:messages）。打开会话续命避免"正看着的会话被回收"。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（SessionHandle 新增 `lastActiveAt` 内存字段 + 4 处更新点 + 新增 `reapIdleSessions` 方法）、`packages/kernel/src/ws-server.ts`（`session:messages` 补 `touchSession` 同步磁盘时间）、`packages/kernel/src/index.ts`（注册 30s 定时器 + shutdown 清理）、`packages/kernel/tests/idle-reap.test.ts`（3 个 case：idle 回收 / busy 跳过 / 阈值内跳过）
  - 验证：`bun run typecheck`（kernel）通过；`bun test`（kernel）581 pass / 0 fail（含修复 `ws-extension-skill-refresh` SSE 竞态测试）。

---

## 2026-07-30

### 修复

- **安装版（Electron）交互/滚动掉帧**：根因是 Electron 内置 Chromium 未启用 GPU 硬件加速——实测本机 WA PI Agent 全部进程 GPU 占用为 0（完全 CPU 软件渲染），而独立 Chrome 浏览器走 GPU 合成故流畅。本机为 NVIDIA dGPU + Intel iGPU 双显卡笔记本，Electron 43 默认未正确激活硬件加速。修复：在 `app.whenReady` 前追加 GPU 合成 switches（`enable-gpu-rasterization` / `enable-zero-copy` / `use-angle=d3d11` / `ignore-gpu-blocklist`），并对齐浏览器的合成路径。同时加 GPU 信息诊断日志（`getGPUInfo`）便于后续确认。
  - 影响范围：`packages/desktop/src/main.cjs`（app ready 前 appendSwitch + ready 后 GPU 日志）

### 配置变更

- **打包脚本固化国内镜像**：electron-builder 默认从 GitHub（`20.205.243.166`）下载 Electron 二进制 / winCodeSign / nsis 等，国内直连经常 `ETIMEDOUT`，导致打包 hang 住数分钟甚至失败。在 `build.ts` 启动阶段用 `process.env[...] ??=` 固化 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror，避免联网超时。用 `??=` 尊重已设环境变量（CI 等场景可覆盖）。
  - 影响范围：`packages/desktop/scripts/build.ts`（启动时固化镜像 env）

### 修复

- **历史消息中 `/skill:技能名` 纯文本未渲染为技能样式**：根因是技能在输入框里是 `$[name]` chip，发送时 `expandTokens` 展开为 `/skill:name ` 纯文本（供 SDK 识别）；当 SDK 未把它再展开成 `<skill>` XML 时，消息以纯文本命令形式存储。而 `formatSkillBlocks` 只认 `<skill>` XML 块、`textToSegments` 只认 `$[name]` chip 格式，`/skill:xxx` 落在两者盲区，原样显示为纯文本。修复：`formatSkillBlocks` 新增第二条替换规则识别 `/skill:name` 纯文本，且**只有该技能名在已启用技能列表（`skills`）中真实存在时才渲染为 ⚡ 技能名**，避免任意 `/skill:xxx` 文本被误判；尾部多余空格压缩为单个。普通 `/命令`（非 `skill:` 前缀）保持原样。`MessageRow` 通过 `useSkillsStore` 取 `skills` 构造技能名集合传入 `formatSkillBlocks`（用 `useMemo` 缓存 Set 避免每次渲染新建触发无限循环）。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`（`formatSkillBlocks` 加纯文本分支 + 技能列表过滤；`MessageRow` 接入 `useSkillsStore`）、`packages/frontend/tests/MessageList.test.tsx`（TDD 失败测试先于实现）

### 修复

- **子智能体派发报 "No API key found for deepseek"**：根因是子智能体派发链路盲目信任磁盘上的 `provider-extension.ts`，当该文件与 `providers.json` 不同步（空壳/过时/手动改坏）时，子进程加载空壳导致自定义 provider 未注册，`--model` 查无此 provider 而报错。修复：在 `makeSpawnFn` 派发前加自愈逻辑——从 `config.model`（形如 `provider/model`）解析出所需 provider slug，校验 extension 文件是否覆盖该 slug，未覆盖则调用 `ensureProviderExtensionRegistered` 重新生成。新增纯函数 `extensionCoversProvider` 用于廉价校验。这正是用户"按理说最少跟随主智能体"的直觉所在：主智能体能拿到 provider 配置，子智能体现在也能可靠拿到。
  - 影响范围：`packages/kernel/src/provider-extension.ts`（新增 `extensionCoversProvider`）、`packages/kernel/src/delegate-tool.ts`（`makeSpawnFn` 加 `ensureExtension` 注入点 + 派发前调用）、`packages/kernel/src/agent-manager.ts`（构造 spawnFn 时注入实际自愈实现）、`packages/kernel/tests/provider-extension.test.ts`、`packages/kernel/tests/delegate-tool.test.ts`（TDD 失败测试先于实现）

### 修复

- **修复"delegate/fleet 子代理委托卡死 + 进程泄漏 + 被 macOS SIGKILL"**（TDD 推进）。根因经运行诊断日志精确锁定（`signal=SIGKILL` + 崩溃前必有 `fleet`/`delegate` + 多个 pi 子进程各 ~300MB 累积超内存）。分两点修复：
  - **settled 超时根治泄漏与卡死**：`subagent-runner.ts` 的 `await settled`（等待子代理 pi 发 `agent_settled`）**原本无超时**。子代理 pi 若卡死（不发 settle 也不退出），这里永久阻塞 → finally 不执行 → 子进程不回收 → 累积 → macOS jetsam 发 SIGKILL 杀进程（不可捕获，crash-logger 无效）。修复：`Promise.race([settled, 超时])`，超时值复用 `commandTimeoutMs`（默认 30 分钟，超时后 fail → 走 finally dispose 回收进程）。新增 `tests/fixtures/hang-pi.ts`（永不 settle 的 fake pi）+ 失败测试验证。
  - **fleet 并发上限 6→5**：`delegate-tool.ts` `MAX_SUBAGENT_CONCURRENCY` 由 6 降为 5。每个子代理 pi 进程约占 300MB，6 个 ≈ 1.8GB 必然超 macOS 内存限制被 SIGKILL，5 个 ≈ 1.5GB 留出余量。同步更新 `shared/tool-schemas.ts` 的 FLEET_DESCRIPTION 静态文案（"Concurrency limit is 6"→"5"），保持与运行时 schema 一致（bridge 契约测试）。
  - 影响范围：`packages/kernel/src/subagent-runner.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/shared/src/tool-schemas.ts`、`packages/kernel/tests/{subagent-runner.test.ts,delegate-tool.test.ts,fixtures/hang-pi.ts}`、`packages/kernel/tsconfig.json`（fixtures 排除出 typecheck）
  - 验证（TDD）：卡死超时测试 RED（10s 超时阻塞）→ GREEN（1.5s 超时返回 + 进程回收，无 dangling）；并发上限测试 RED（期望 5 实得 6）→ GREEN。`bun run typecheck` 四包过；`bun run test` 1477 pass / 0 fail（kernel 564 + shared 87 + desktop 26 + frontend 800）；`pack:mac` 出新 dmg。

### 新增

- **种子角色默认全量互联**：`makeSeedAgentConfig` 现在为每个内置专家角色自动填充 `partners.askTo`（除自身外的全部 8 个合作伙伴），首次启动即可使用完整的关系网和 delegate/fleet 委托，无需手动配置。手动新建角色的 `partners.askTo` 仍默认为空，保持灵活性。
  - 影响范围：`packages/kernel/src/default-agent-seeds.ts`（核心逻辑）、`packages/kernel/tests/config-store.test.ts`（更新断言）

- **超大附件降级为路径引用**：Electron 环境下上传超过 50MB 的附件不再报错，改为通过 `webUtils.getPathForFile` 取 File 真实路径，以 `@路径` 引用方式加入附件（与本地文件选择器一致，不上传内容）。非 Electron 环境（浏览器）无此 API，维持原有的超限提示。≤50MB 文件仍正常上传。
  - 影响范围：`packages/desktop/src/preload.cjs`（暴露 getPathForFile）、`packages/frontend/src/components/ui/ComposerInput.tsx`（超大文件降级分流）、`packages/frontend/src/util/clipboard.ts`（waPiApp 类型声明）

### 修复

- **安装/卸载/升级/启停动态插件后自动刷新技能列表**：`ws-server.ts` 中 `extension:install`、`extension:uninstall`、`extension:upgrade`、`extension:toggle` 四个操作成功后，现在会额外调用 `scanSkillsWithExtensions()` 并广播 `skill:changed` SSE 事件。此前仅调了 `markAllDirty()`（保证下一个 pi 子进程重建时加载新技能），但前端技能面板不实时刷新——用户必须手动点刷新或重开设置面板才能看到插件提供的技能。TDD 推进：先写 5 个红灯测试（验证 skill:changed 广播 + scan 调用），绿灯补齐 4 处各 2 行后全绿。
  - 影响范围：`packages/kernel/src/ws-server.ts`（4 处各补 2 行）、`packages/kernel/tests/ws-extension-skill-refresh.test.ts`（新增 5 个测试）

- **修复"发消息后回复部分内容即断开连接"**（TDD 推进 + 崩溃日志跟踪）。根因经运行日志（`退出 code=null`）+ 代码链路确认，分两层修复：
  - **崩溃根因**：`sse-bus.ts` 的 `broadcast` 里 `JSON.stringify(data)` 在 try/catch **之外**。流式输出中某帧 payload 含 BigInt（部分 provider 的 token usage）或循环引用（工具调用结果）时，JSON.stringify 同步抛 TypeError，沿 `rpc-client` stdout 回调 → `onEvent` → `eventThrottle` → `broadcast` 一路无兜底冒泡，被 Bun 视为未捕获异常杀死 kernel 进程（日志仅 `code=null` 无堆栈），SSE 长连接物理断开，前端显示"连接已断开"。完美吻合"回复部分内容后才断"。修复：JSON.stringify 移进 try/catch，失败用 BigInt-safe replacer（`(_,v) => typeof v==="bigint" ? v.toString() : v`）重试，仍失败记 warn 丢帧——绝不让单个坏帧杀进程。
  - **无法自愈**：kernel 崩溃后 `kernel-sidecar.cjs` 只 log 不重启，前端无限重连死端口。
  - 影响范围：`packages/kernel/src/sse-bus.ts`
- **新增 kernel 全局异常兜底 + 崩溃日志**（跟踪用）。新建 `packages/kernel/src/crash-logger.ts`：`createCrashLogger` 把未捕获异常/unhandledRejection 的堆栈追加写入 `~/.wa-pi/logs/kernel-crash.log`（带时间戳，参考 desktop log.cjs 模式）；`installCrashHandlers` 注册 `uncaughtException`/`unhandledRejection` 处理器（写日志 + 广播 error 给前端 + **绝不退出进程**）。`index.ts` 启动时尽早注册（broadcast 在 server 就绪后赋值）。bun 默认对未捕获 rejection 终止进程，这是历史 kernel 被 `code=null` 杀死无堆栈的根治防御。后续任何残留崩溃都会在 `kernel-crash.log` 留痕。
  - 影响范围：`packages/kernel/src/crash-logger.ts`、`packages/kernel/src/index.ts`
- **desktop kernel 崩溃自动重启**。新建 `packages/desktop/src/util/auto-respawn.cjs`（纯决策函数 `shouldRespawn(code, state)`：仅 `code===null`（被信号杀）且未主动 stop() 且未达上限时重启；`MAX_RESPAWN=3`、`RESPAWN_DELAY_MS=2000`）。`kernel-sidecar.cjs` 的 `child.on("exit")` 接入：崩溃时延迟后重新 spawn + waitForPort，重启成功清零计数；用户 `stop()` 置 `stopped` 标志禁止误重启。kernel 重启后前端 SSE 自动重连（events.ts 已有无限退避重试）。
  - 影响范围：`packages/desktop/src/util/auto-respawn.cjs`、`packages/desktop/src/kernel-sidecar.cjs`
- **前端重连后全状态自愈**。`App.tsx` 的 `onReconnect` 回调原仅恢复 projects+messages，补上 mount 时加载的 providers/skills/extensions/agents/subagents，确保 kernel 重启 + SSE 重连后前端全状态对齐，无需手动刷新。
  - 影响范围：`packages/frontend/src/App.tsx`
- **验证**（TDD，每步红→绿）：新增测试 `sse-bus.test.ts`(4)、`crash-logger.test.ts`(4)、`crash-handlers.test.ts`(3)、`auto-respawn.test.ts`(6) 共 17 个；`bun run typecheck` 四包过；`bun run test` 1473 pass / 0 fail（kernel 563 + shared 87 + desktop 26 + frontend 797）；`pack:mac` 出新 dmg。后续若仍复现断开，查 `~/.wa-pi/logs/kernel-crash.log` 的堆栈继续定位。

---

## 2026-07-30

### 修复

- **网络错误后排队与重发按钮**：承接上次「transient 错误改状态条」改动，补齐两个体验缺口。① pi 内部重试期间（busy=true）新消息本就会自动进 followUp 队列（现有机制，无需改）；② pi 重试耗尽后 agent_settled 会自动 drain 队列——但此时网络仍不可用，排队消息会再失败。修复：kernel SessionHandle 新增 `netDegraded` 标记，transient 错误时置 true，agent_settled 跳过 drain（队列保留等用户重发），用户重发（prompt 走 _sendPromptNow）时自动清除标记恢复正常。③ transient 不进对话流导致原「重新发送」按钮（依赖 stopReason:error）永不命中——MessageList 新增 degraded 触发条件：netDegraded 且末条是 user 消息时显示重发按钮，重发同一条不叠加并清除 degraded。④ App.tsx net:status 移除 failTurn，让 pi 的 agent_end 自然复位 thinking（依赖 pi finally 必发 agent_settled，已由源码确认）。
  - 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/index.ts`、`packages/frontend/src/App.tsx`、`packages/frontend/src/components/MessageList.tsx`

### 测试 / 修复

- **修复全量测试套件（kernel/shared/desktop/frontend 四包全部 0 fail）**。此前 `bun run test` 存在两大结构性问题导致大面积失败（单包单独跑通过，全量跑 220+ fail），逐一定位根因后修复。每个失败都判定为以下三类之一：
  1. **测试 case 未跟上代码改动**（产品改名/移除功能后断言过期）：
     - `shared`：`agentDefOf` 测试用已移除的内置 agent「技术实现」，改用现存的「前端开发者」。
     - `desktop`：`buildTrayMenu` 测试期望旧名「打开 WaPi」，产品已改名「打开 WA PI Agent」。
     - `ComposerInput`：`/ 命令菜单`测试断言「compact」「model」，但 `PI_FRAMEWORK_COMMANDS` 已全部注释移除（产品决策不再暴露）；改用 prompt 模板命令验证同一 dispatch 路径。
     - `Sidebar`：「项目」区头改为 `userProjects.length > 0` 条件渲染，空项目测试改为断言区头不出现。
  2. **happy-dom 环境限制**（about:blank 下相对 URL fetch 抛 NotSupportedError）：
     - `store-mcp`/`extensions-store`/`MessageList`/`SkillSection`/`ExtensionSection`/`SettingsModal` 等测试触发真实 `api.get/post`，happy-dom 不支持。给各文件 `mock.module("../src/api-client")`，`SkillSection` 另 mock `fs-client`（DirTreePicker 的 getRoots/listDir）。
     - `App`/`App-agent-missing`/`canvas-removed`：mock 的 `api.get` 返回 `{}`（truthy）触发 `loadAll` 的 `if(data)` 分支异步覆盖测试预设的 store，导致渲染空壳/hooks 错误；改为返回 `null`（falsy，不触发覆盖），`/presets` 等需结构化数据的路径单独返回 `{presets:[]}`。
  3. **bun:test mock.module 跨文件泄漏**（[oven-sh/bun#31316](https://github.com/oven-sh/bun/issues/31316)，进程级注册表不在文件间重置）：frontend 的 test 脚本加 `--isolate`（每文件独立 global object），隔离 mock 副作用。
  - **根 test 脚本重构**：原 `bun test --path-ignore-patternes ...` 的 flag 拼写错误（少个 s，被当 filter 从未生效），且从仓库根递归扫到 `cocode-master/`（vendored 外部项目，502 个无关测试）。改为在各 package 目录分别 `bun run test`，彻底隔离且只跑 wa-pi 自身测试。
  - 影响范围：`packages/shared/tests/types.test.ts`、`packages/desktop/tests/menu.test.ts`、`packages/frontend/{package.json, bunfig.toml, tests/happydom-setup.ts, tests/*.test.tsx}`、根 `package.json`
  - 验证：`bun run test` exit 0（kernel 552 + shared 87 + desktop 20 + frontend 791 = 1450 pass / 0 fail）；`bun run typecheck` 四包全过，无回归。
  - 注：`cocode-master/` 是仓库内独立参考项目，其测试失败与 wa-pi 无关，已从根测试脚本排除。

## 2026-07-30

### 新增功能

- **左右两侧面板支持拖动调整宽度**：左侧会话列表 + 右侧文件预览面板均支持拖拽分隔条调整宽度，范围 200px ~ 视口宽度的 40%，宽度持久化到 localStorage（刷新/重启保持）。分隔条视觉改细（2px，含更宽透明热区便于抓取），拖拽中禁用文本选中。`SidebarResizer` 参数化为通用组件（`side: "left"|"right"` 决定方向，`minWidth`/`maxRatio` 可配）。
  - 影响范围：新增 `packages/frontend/src/store/sidebar.ts`（左侧宽度）、`packages/frontend/src/components/SidebarResizer.tsx`（参数化通用分隔条）；改 `Sidebar.tsx`/`App.tsx`（左侧接入）、`store/explorer.ts`（加 width 字段）、`SessionView.tsx`（右侧面板读 store width + 插入分隔条）

### 修复

- **会话列表不再出现「点进去空白」的孤儿会话**：根因是 `getCommands`（拉取斜杠命令菜单）的兜底分支违背自身 docstring——在无活跃进程可借时调用 `createSession` 写入记录（`title: agentName`）并启动 pi 进程，但全程不发 prompt，pi 不创建 `.jsonl` 消息文件；用户离开后进程退出，记录永久残留，出现在列表点击却读不到消息→空白。修复（TDD）：在 `_onProcessExit`（进程退出钩子）加孤儿回滚——`piSessionFile` 文件不存在（从未 prompt）时删除该 session 记录并经 `onSessionRollback` 回调广播 `projects:list` 刷新前端；正常会话（有消息文件）崩溃不删除。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（`SessionHandle` 加 `piSessionFile`、`_onProcessExit` 加回滚、`AgentManagerOpts` 加 `onSessionRollback`）、`packages/kernel/src/index.ts`（接线广播）、`packages/kernel/tests/agent-manager.test.ts`（2 新测试：孤儿删除/正常不误删；现有崩溃测试补消息文件适配）

### 新增功能

- **移植 cocode 的会话文件树 + 文件预览功能**：会话栏顶部右侧新增「📁」按钮，点击切换右侧文件树面板；双击文件在面板内预览（代码语法高亮+行号 / 图片缩放平移）；文件可拖拽到输入框生成 `@filepath` 提及。功能对齐 cocode desktop 的 explorer + file-viewer。
  - **kernel**：`routes/fs.ts` 的 `checkPreviewable` 放行 `image/*`，read-file 现对 png/jpg/gif/svg 等图片返回 base64（仍受 3MB 上限）。导出 `checkPreviewable` 供单测。
  - **前端组件**：新增 `FileViewer`（代码高亮 + 图片缩放/平移 + 选中复制为 `@path:行号` 引用）、`ExplorerPanel`（扁平数组懒加载 + 5s 轮询 + 展开状态 ref 保持 + 右键菜单 + 拖拽 ghost）；`FilePill` 点击预览由旧 `FilePreviewModal`（纯 `<pre>`）升级为 `FileViewer`；删除已废弃的 `FilePreviewModal`。
  - **前端 store**：新增 `store/explorer.ts`（面板开关，持久化 localStorage）。
  - **接入**：`SessionView` header 加按钮 + 右侧面板挂载；`ComposerInput` 监听 `wa-pi:insert-mention` 事件实现拖拽 @提及插入。
  - 适配差异：cocode 用 Tauri `invoke()` + 自研图标/i18n，HiAgent 复用 `fs-client`（HTTP REST）+ base64 解码 + emoji 图标 + 中文硬编码。
  - 影响范围：`packages/kernel/src/routes/fs.ts`、`packages/frontend/src/components/{SessionView,ExplorerPanel}.tsx`、`packages/frontend/src/components/blocks/{FileViewer,FilePill}.tsx`、`packages/frontend/src/store/explorer.ts`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/styles.css`，及对应测试。
  - 验证：L1 单元（fs-routes 5 项、explorer-store 3 项）+ L2 组件（FileViewer 5、ExplorerPanel 4、FilePill 4、SessionView 23）+ L3 API（curl read-file png/txt 返回 base64）+ L4 E2E（agent-browser 真实浏览器：header 按钮→面板展开→文件树渲染→目录展开→双击文件 FileViewer 预览）。注：Playwright global-setup 存在既有 kernel 启动超时（与本改动无关，既有 spec 同样失败），L4 改用 agent-browser 手动起服务验证。

## 2026-07-30

### 修复

- **会话列表不再出现「点进去空白」的孤儿会话**：根因是 `getCommands`（拉取斜杠命令菜单）的兜底分支违背自身 docstring——在无活跃进程可借时调用 `createSession` 写入 session 记录（`title: agentName`）并启动 pi 进程，但全程不发 prompt，pi 不创建 `.jsonl` 消息文件。用户离开后进程退出，记录永久残留，出现在列表里点击却读不到消息→空白。修复：在 `_onProcessExit`（进程退出钩子）加孤儿回滚——piSessionFile 文件不存在（从未 prompt）时删除该 session 记录并广播 `projects:list` 刷新前端列表；正常会话（有消息文件）崩溃不删除。新增 `AgentManagerOpts.onSessionRollback` 回调，`index.ts` 接线广播。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（`SessionHandle` 加 `piSessionFile` 字段、`_onProcessExit` 加回滚、`AgentManagerOpts` 加 `onSessionRollback`）、`packages/kernel/src/index.ts`（接线广播）、`packages/kernel/tests/agent-manager.test.ts`（2 个新测试 + 1 个现有崩溃测试补消息文件）

### 构建 / 类型修复

- **修复 master 分支长期遗留的 typecheck 全部失败（20+ 处），打通 macOS 生产安装包打包**。此前 `bun run typecheck` 在 shared/kernel/frontend 三个包全部报错（干净 HEAD 即如此，非本次改动引入），导致 `pack:mac` 卡在步骤0 测试钩子无法出包。逐包修复如下（仅改类型层面，不动业务逻辑）：
  - **shared**：`tsconfig.json` 设 `rootDir: "./src"` 并将 `include` 收敛为 `["src"]`，解决 `exports` map + bundler resolution 下的 TS2209「project root ambiguous」。
  - **shared 协议类型补齐**：`types.ts` 新增 `ClearQueueEvent`（client→kernel）、`FSUnsupportedEvent`（kernel→前端），`FSReadFileResult` 增加可选 `resolvedPath`；`mcp.ts` 的 `McpToolsResult` 把 `tools` 改可选并新增 `error?`，覆盖 listTools 失败分支。均接入对应联合类型（`WSClientEvent`/`WSServerEvent`）。
  - **kernel 源码**：`agent-manager.ts` `currentThinking` 类型由 `string | null` 收窄为 `ThinkingLevel | null`；`session-history.ts` `readSessionHistory` 返回类型由 `unknown[]` 改为 `AgentMessage[]`（解析器本就只产有效 message）；`wa-pi-bridge.extension.ts` 作为静态扩展模板从 kernel typecheck 排除（其 `./tool-schemas.ts` 仅运行时复制后存在）。
  - **kernel 第三方 patch**：扩展 `patches/pi-mcp-adapter@2.15.0.patch`，将 `resolveCommandSecretsRecord` 返回类型放宽为 `Record<string, string | undefined> | undefined`（该库发 `.ts` 源码，`skipLibCheck` 不覆盖）。
  - **kernel 测试**：新建 `tests/helpers/http-api-kit.ts`（封装 `withServer/openSse/readSseFrame/stubAgentManager`，`routes-chat.test.ts` 引用但此前缺失）；`routes-mcp.test.ts` 删多余 `type` 字段、补齐 `WSServerOpts` 必填空桩、改用公开 `server.stop()`。
  - **frontend 源码**：`store/session.ts` `SessionState` 接口补 `addTokens` 声明（实现已存在）；`QuickInvokeMenu` `Props.type` 补 `"command"`（对齐 `TriggerType`）；`store/mcp.ts` `setToolsResult` 对失败分支 `data.tools ?? []` 兜底。
  - **frontend 测试**：`store-session.test.ts`、`SessionView.test.tsx`、`ComposerInput.test.tsx` 补齐 mock 必填字段（`createdAt`/`lastActivity`/`durationMs`/`truncated` 等）。
  - 影响范围：`packages/shared/{tsconfig.json,src/types.ts,src/mcp.ts}`、`patches/pi-mcp-adapter@2.15.0.patch`、`packages/kernel/{tsconfig.json,src/agent-manager.ts,src/session-history.ts}`、`packages/kernel/tests/{helpers/http-api-kit.ts,routes-mcp.test.ts}`、`packages/frontend/src/{store/session.ts,store/mcp.ts,components/ui/QuickInvokeMenu.tsx}`、`packages/frontend/tests/{store-session.test.ts,SessionView.test.tsx,ComposerInput.test.tsx}`
  - 验证：`bun run typecheck` 四包全过；`pack:mac` 出包 `WaPi-Setup-0.1.0.dmg`（143M）。改动的相关测试（routes-chat/routes-mcp/store-session addTokens 等）全过；既有失败数与 HEAD 一致，未引入回归。

## 2026-07-30

### 修复

- **流式输出时 Mermaid 图不再反复闪烁重画**：根因是 `MermaidBlock` 的 `useEffect([code])` 对成功渲染路径零节流——流式中 mermaid 源码每个 token 都增长，每次都能解析成功就立刻用新 SVG 替换 DOM 重画整张图（仅错误显示有 400ms debounce，成功路径无）。修复：code 变化后延迟 1000ms 才执行 `mermaid.render()`（流式中 token 间隔远小于 1s，timer 不断重置 → render 不触发 → 图稳定）；即便到期渲染，也用 ref 缓存上次成功 SVG，仅在内容真正变化时才替换 DOM。仅改 `MermaidBlock.tsx`，不动流式数据链路。
  - 影响范围：`packages/frontend/src/components/blocks/MermaidBlock.tsx`、`packages/frontend/tests/blocks/MermaidBlock.test.tsx`

- **放大弹窗内滚轮缩放失效**：`MermaidBlock` 的 wheel 监听 `useEffect` 依赖为 `[]`，在组件挂载时（modal 未打开、viewport 元素不存在）执行一次，`viewportRef.current` 为 null 直接 return，监听器从未绑定——导致放大弹窗打开后滚轮缩放不工作（真实浏览器同样失效，非仅测试问题）。修复：依赖改为 `[modalOpen]`，viewport 元素挂载后才绑定 wheel 监听，关闭时 cleanup 移除。
  - 影响范围：`packages/frontend/src/components/blocks/MermaidBlock.tsx`

- **切换到历史长会话有时不自动滚到底部**：进入会话的一次性滚动 effect 在 messages 进入 store 那一帧执行 `scrollToBottom`，但历史长会话含 ReactMarkdown/代码块/图片等异步布局内容，首帧 `scrollHeight` 偏小，滚动位置停在偏上处，内容撑高后无兜底再滚。修复：滚动后用 `requestAnimationFrame` 校正一次，等下一帧布局撑开后重新贴底。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/tests/MessageList.test.tsx`

- **「滚动到底部」浮动按钮改为水平居中**：原定位在消息区右下角（`right-4`），改为水平居中（`left-1/2 -translate-x-1/2`），垂直仍贴底部。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`

---

## 2026-07-30

### 修复

- **网络错误不再灌入对话流，改用状态条提示**：根因是底层 SDK（`@anthropic-ai/sdk` / `openai`）的 `APIConnectionError`（默认文案 "Connection error."）经 pi-ai 不变形塞进 `message_end{stopReason:"error", errorMessage}`，被 kernel 翻译成 `{type:"error"}` 后前端 append 成红色会话消息，且 pi 落盘到 JSONL 导致重连/重试 N 次堆积 N 条。修复：kernel 侧按错误文案分类——transient（网络/超时/限流/5xx）改广播 `{type:"net:status"}` 驱动顶部「模型连接异常」状态条，不进对话流；fatal（鉴权失败/配额耗尽/模型不可用）保留红色会话消息。同时历史回读过滤掉 transient error，避免刷新后残留。分类正则复用 pi-ai `utils/retry.js` 语义。
  - 影响范围：`packages/kernel/src/sdk-errors.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/session-history.ts`、`packages/shared/src/types.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`

- **每个会话固定自己的思考强度，未设置时回退全局默认**：根因是 `loadSession` 把 defaults.thinking 填进了每个会话的 bySession.thinking，导致无法区分"用户显式设的"和"defaults 填充的"；一旦 defaults 变化，所有未显式设置的会话 thinking 跟着变。修复：`SessionPrefs.thinking` 改为可选，`loadSession` 仅在用户显式设置过时才填 thinking（否则保持 undefined）；Composer/MessageList 读取时回退到 `defaults.thinking` 而非硬编码 "disabled"。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/tests/composer-prefs.test.ts`

- **重启后会话标题丢失（变成角色名）**：根因是 `projectStore.createSession` 无去重，直接 `sessions.push`；`getCommands` 兜底分支用 `title: agentName` 创建已存在的 session 时，push 了重复记录覆盖了正常标题。修复：`createSession` 对同 id 幂等——已存在则返回已有记录，不新增不覆盖。
  - 影响范围：`packages/kernel/src/project-store.ts`、`packages/kernel/tests/project-store.test.ts`

## 2026-07-29

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

- **全项目重命名 HiAgent → WA PI Agent / wa-pi**：产品展示名改为「WA PI Agent」（窗口标题、侧边栏、托盘、productName）；标识符统一 `wa-pi`（npm 包名 `@hiagent/*` → `@wa-pi/*`、数据目录 `~/.hiagent` → `~/.wa-pi`、项目级 `.hiagent/` → `.wa-pi/`、环境变量 `HIAGENT_*` → `WA_PI_*`、二进制 `hiagent-kernel` → `wa-pi-kernel`、`hiagent-bridge.extension.ts` → `wa-pi-bridge.extension.ts`、代码标识符 HiAgent*→ WaPi*、settings 字段 hiagent_packages → waPiPackages 等）。约 290 个文件。不迁移旧数据：`~/.hiagent` 保留但不再读取，WA PI Agent 从全新数据目录启动。
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
