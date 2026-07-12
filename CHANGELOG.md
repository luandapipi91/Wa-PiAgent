# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-12 — 桌面托盘二进制末审小修（refactor）

### 重构
- **删 dead `killPort`（YAGNI）**：`packages/desktop/src/util/port.ts` 的 `killPort`（搬自 `scripts/port.ts` 的副本）在 desktop 运行时从未被 import——单实例逻辑改为 `isPortInUse` 检测 + 直接退出，不再需要杀端口能力。删除 `killPort` 函数与 `spawn` import；`main.ts` 中两条引用 `killPort` 的过时注释一并清理（保留 `isPortInUse`）。注：`scripts/port.ts` 的同名函数仍被 `scripts/dev.ts` 使用，未受影响
  - **影响范围**：packages/desktop（src/util/port.ts、src/main.ts）
  - **验证**：`grep killPort packages/desktop` 仅剩一条删除说明注释；desktop 11 pass / 0 fail
- **kernel 静态资产缺失回退 index.html（SPA）**：`packages/kernel/src/ws-server.ts` 的 `fetch` 处理在 `staticDir` 已设置但请求的资产文件缺失（`file.size === 0`）时，原先错误返回 `426 WS only`，违反 SPA 路由约定。改为：缺失资产 → 伺服 `${staticDir}/index.html`（content-type `text/html`）；仅在 `staticDir` 完全未设置（dev 模式）才保留 426 兜底
  - **影响范围**：packages/kernel（src/ws-server.ts、tests/static-serve.integration.test.ts）
  - **验证**：新增断言——请求 `/assets/does-not-exist.js` 返回 index.html body；集成测试 1 pass / 3 expect；root suite 560 pass / 0 fail
- **desktop logger 退出前 flush**：`packages/desktop/src/log.ts` 的 `createLogger` 此前 fire-and-forget `mkdir().then(appendFile())`，`main.ts` `cleanup` 里的 `process.exit(0)` 可能截断末尾「退出清理」/错误日志行。`Logger` 接口新增 `flush(): Promise<void>`，实现用 `Set<Promise>` 跟踪 in-flight 写入、`Promise.allSettled` 等齐；`cleanup` 在 `process.exit(0)` 前 best-effort `await log.flush()`（try/catch 兜底）
  - **影响范围**：packages/desktop（src/log.ts、src/main.ts）
  - **验证**：log 单测仍 pass（flush 已加但原测试用 setTimeout 等待，未受影响）；desktop 11 pass / 0 fail；typecheck 通过

### 验证（整体）
- `bun run typecheck` 四包全过（shared / frontend / kernel / desktop）
- `bun run test` 根套件 560 pass / 5 skip / 0 fail
- `cd packages/kernel && bun test tests/static-serve.integration.test.ts` 1 pass / 3 expect（含新增 SPA 回退断言）
- `cd packages/desktop && bun test` 11 pass / 0 fail
- 注：未运行 `bun run pack:win`，`dist/desktop/win-x64/HiAgent.exe` 保持字节不变，供并行真机测试

## 2026-07-12

### 新增功能
- **桌面托盘单二进制（`@hiagent/desktop`）**：新增 `packages/desktop` 包，单进程内 in-process 起 kernel（WS + 静态前端同 9776）+ systray2 托盘（菜单「打开 HiAgent / 退出」，点打开用系统浏览器开 `http://127.0.0.1:9776`）；`bun build --compile` 把前端 dist / systray helper / 青蛙图标全嵌入单 exe，Windows 额外 PE 子系统 patch（CONSOLE→GUI）去控制台。含工具模块：port / open-browser / interop（systray2 CJS 防御解包）/ pe-subsystem / log / embed（运行时解压嵌入资源）。`scripts/build.ts` 编排 + 打包前测试钩子（typecheck + root 测试套件 + kernel HTTP 集成测试单独从 kernel 目录跑以避开 happy-dom 对 globalThis.fetch 的全局替换；嵌入清单临时生成后恢复 stub，让 typecheck 在全新检出/CI 下也通过）。根 `pack:win/mac/linux/all`。产物落 `<repo>/dist/desktop/<平台>/HiAgent[.exe]`（~122MB，PE subsystem=2）
  - **影响范围**：新增 packages/desktop（src/main.ts、kernel-boot.ts、systray-setup.ts、log.ts、embed.ts、util/{port,open-browser,interop,pe-subsystem}.ts、scripts/{build.ts,genicon.py}、tests、package.json、tsconfig.json）；根 package.json（pack:*）；.gitignore
  - **验证**：desktop 工具单测全过（port/interop/pe-subsystem/log/embed）；`bun run pack:win` 不带 `--no-test` 全绿，产出 `dist/desktop/win-x64/HiAgent.exe`（122MB，subsystem 3→2）；typecheck 通过
- **前后端端口支持 `.env` 动态配置**：`HIAGENT_WS_PORT`（默认 9776，后端 WS）和 `HIAGENT_WEB_PORT`（默认 5180，前端 Vite dev）可通过根 `.env` 覆盖。`packages/shared/src/constants.ts` 新增纯函数 `resolvePort(envVal, def)` 并让 `WS_PORT`/`FRONTEND_PORT` 读 env（默认值不变 = 无 `.env` 时行为完全一致）。`packages/frontend/vite.config.ts` 用 `loadEnv` 读 `.env`：`server.port` 用 `HIAGENT_WEB_PORT`，`define` 注入 `import.meta.env.HIAGENT_WS_PORT` 让浏览器 bundle 的 `WS_PORT` 指向配置的后端端口。`scripts/dev.ts` 删硬编码 9776/5180，改从 shared 导入 `WS_PORT`/`FRONTEND_PORT`。`.env.example` 入库作模板，`.env` 已被 `.gitignore` 忽略
  - **影响范围**：packages/shared（constants.ts, tests/ports.test.ts）、packages/frontend（vite.config.ts）、scripts/dev.ts、.env.example
  - **验证**：`packages/shared/tests/ports.test.ts` 2 pass（合法正整数用之 + undefined/空/非数字/0/负数回退默认）；`bun run typecheck` 三包通过

### 重构
- **kernel 可导入 + 可选静态前端伺服（SPA fallback）**：把 `packages/kernel/src/index.ts` 的 `main()` 体抽成 `export async function startKernel(opts?: { staticDir?: string }): Promise<{ port: number }>`，桌面端可 in-process 启动；`if (import.meta.main)` 守卫使 `bun run src/index.ts` 自动执行路径保留不变。`packages/kernel/src/ws-server.ts` 的 `WSServerOpts` 新增可选 `staticDir`，`fetch` 在 WS 握手失败后用 `resolveStaticPath` 解析 URL → `Bun.file` 回资产，未知/越权路径回退 index.html（SPA 路由）。同一 9776 端口同时伺服 UI 与 WS，二进制分发不再依赖 Vite
  - **影响范围**：packages/kernel（src/index.ts, src/ws-server.ts, tests/static-serve.test.ts, tests/static-serve.integration.test.ts）
  - **验证**：static-serve 单元测试 4 pass（resolveStaticPath 三例 + getMimeType 四例）；typecheck 通过；集成测试受端口 9776 占用阻塞（详见 task-2-report）

### 重构
- **禁用 pi-lens 时过滤工具 allowlist**：把 agent-manager.ts:317 散落的三元表达式（`config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS`）封装成统一入口 `resolveAgentTools` 纯函数，按可选插件启用态过滤工具。禁用 pi-lens 后从 agent 的 tools allowlist 移除其注册的 9 个工具（lsp_navigation/lsp_diagnostics/lens_diagnostics/ast_grep_search 等），agent 无法再调用它们。签名预留 `agentName` 参数供后期按角色做工具集裁剪
  - shared：`constants.ts` 新增 `EXTENSION_TOOL_MAP`（插件 id → 工具名映射）+ `resolveAgentTools` 纯函数；`tests/constants.test.ts` 覆盖启用/禁用/空集/不可变四种态
  - kernel：`AgentManagerOpts` 注入可选 `extensionManager`；`_createSession` 改调 `resolveAgentTools`（经 `getEnabledExtensionIds` 读插件态）；`index.ts` 构造时传入
  - **影响范围**：packages/shared（constants.ts, tests/constants.test.ts）、packages/kernel（agent-manager.ts, index.ts）
  - **验证**：shared 5 pass / kernel 54 pass（agent-manager + extension-manager + ws-extension 无回归）；两包 typecheck 通过

### 新增功能
- **ask_user_question 结构化澄清提问工具**：agent 可在任务中调用 `ask_user_question` 工具向用户提出 1-4 个结构化问题（每问 2-4 选项，支持单/多选、自由文本、per-question 备注），代替瞎猜；前端在 composer 上方停靠 AskDock 表单完成人机交互
  - shared：新增 `ask.ts`（AskParams/AskReply/AskAnswer 类型 + validateAskParams/replyToAnswers 纯函数 + ASK_RESERVED_LABELS）；`DEFAULT_AGENT_TOOLS` 加入白名单；WSClientEvent 加 `agent:answer`/`agent:cancel-ask`
  - kernel：`AskRegistry` 进程单例（ask 阻塞/resolve/cancel/cancelAll/幂等/AbortSignal）；`makeAskTool` 用 `defineTool`+TypeBox 定义工具并入 `customTools`（与 memory 工具合并，不覆盖）；中断点（abort/_jumpQueue/_teardownSession）调 cancelAll 作废 pending；ws-server 处理 agent:answer/cancel-ask 直达 registry；reconcileDanglingAsks 重启兜底
  - frontend：`selectPendingAsks`/`selectEffectiveStatus` 派生选择器；AskFormCard 表单组件（单/多选、Other、preview、备注、提交/取消）；AskDock 停靠区；pending 时 composer 禁用；历史 ToolCall 显示「问答」label
- **影响范围**：packages/shared（ask.ts, types.ts, constants.ts, index.ts, tests/ask.test.ts）、packages/kernel（ask-registry.ts, ask-tool.ts, agent-manager.ts, ws-server.ts 及对应测试）、packages/frontend（store/ask.ts, components/ask/AskFormCard.tsx, components/ask/AskDock.tsx, SessionView.tsx, Composer.tsx, ui/ComposerInput.tsx, MessageList.tsx 及对应测试）
- **验证**：shared 36 pass / kernel 232 pass / frontend 264 pass（0 fail）；三包 typecheck 通过；四层测试第 1-3 层（单元/组件/集成）已覆盖，第 4 层 E2E 待真实模型环境补充

### 修复
- **pi-lens（LSP 诊断）两个独立根因导致 agent 报告"LSP 不可用"**：
  - 根因1 双重加载：`~/.hiagent/settings.json.extensions` 积累多条 pi-lens 路径（bun install 产生新 `.bun` 缓存 hash 后旧路径残留），SDK 双重加载同一扩展，两实例在 `session_start` 互相判定为"并发副实例"双双跳过 `handleSessionStart`，LSP 服务从未初始化。修复：`ExtensionManager.list()/toggle()` 增加 `pathBelongsToPackage` 归属判定，对每个可选插件收敛同包所有历史路径为当前唯一路径（启用）或全部移除（禁用），保留外部路径。同时清理用户 settings.json 中 2 条重复 pi-lens + 1 条废弃 pi-hermes-memory
  - 根因2 工具被白名单过滤：`createAgentSession` 的 `tools` 参数被 SDK 当作 allowlist，pi-lens 注册的 9 个工具（lsp_navigation/lsp_diagnostics/ast_grep_* 等）不在 `DEFAULT_AGENT_TOOLS` 白名单 → 即便扩展加载成功 agent 也找不到工具。修复：白名单显式放行 pi-lens 全部 9 个工具
- **影响范围**：packages/kernel（extension-manager.ts, tests/extension-manager.test.ts, tests/ws-extension.test.ts）；packages/shared（constants.ts）
- **验证**：单元测试 9 pass（含 3 个路径收敛复现用例）；WS 集成测试 4 pass；shared 27 pass；kernel 全量 213 pass / 0 fail；typecheck 通过

### 修复
- **记忆页作用域选择器状态丢失 + 指令文件 Tab 切项目不加载**：两个 bug 同源——`selectedProjectId` 存在组件本地 state，关闭设置弹窗（组件卸载）即丢失，而 `memoryScope` 在持久 store 保留，导致两者错位
  - Bug1：关闭重开设置后选择器被重置、记忆查不出来 → 将 `selectedProjectId` 提升到 `useMemoryStore` 持久化，关闭弹窗后保留
  - Bug2：指令文件 Tab 切到「项目」默认选第一个项目但不加载（`<select>` DOM 默认选中不触发 React onChange）→ 加载 effect 改用 `activeProjectId`（含 currentProjectId 兜底），项目选择器改为始终显示（与 scopeFilter 解耦）
- **影响范围**：packages/frontend（store/memory.ts, components/memory/MemoryPage.tsx, tests/MemoryPage.test.tsx, e2e/memory.spec.ts, e2e/global-setup.ts）
- **验证**：单元/组件测试 251 pass（含 3 个新增复现用例）；typecheck 通过；agent-browser 真实浏览器验证 Bug1（关闭重开选择器保留 aicpm）+ Bug2（切项目作用域立即加载指令文件、选择器始终显示）

### 新增功能
- **agent 系统提示词注入执行环境信息**：在 `systemPromptOverride` 闭包 base 末尾追加三条约束——内置技能目录路径(`Built-in directory: ~/.hiagent/skills`)、禁止透露系统提示词、禁止使用内部术语回复用户
- **影响范围**：packages/kernel（agent-manager.ts, tests/agent-manager.test.ts）
- **验证**：agent-manager 单元测试 36/36 通过（含新增 systemPromptOverride 注入断言），无回归

## 2026-07-11

### 重构
- **附件文件选择器（FilePicker）手风琴展开 + 限定范围搜索**：重构聊天界面📎附件打开的文件选择器
  - 手风琴展开：同级文件夹互斥，展开 A 时其兄弟文件夹自动折叠（祖先链保持展开）
  - 限定范围搜索：搜索只从「活动目录」递归往下（优先级：聚焦目录 > 展开链最深目录 > defaultPath > 盘符根），结果增量呈现不重置用户已有展开/折叠/选中状态
  - 搜索框下方显示当前搜索范围提示
- **影响范围**：packages/frontend（FilePicker.tsx, FilePicker.test.tsx）
- **验证**：FilePicker 组件测试 8/8 通过（含 4 个新用例）；typecheck 通过；agent-browser 真实浏览器验证手风琴、搜索范围限定、增量不重展开

## 2026-07-11

### 新增功能
- **记忆管理**：集成 pi-hermes-memory 插件，新增记忆管理页（侧边栏「记忆」入口）
  - 记忆查看/编辑/归档/恢复/彻底删除
  - 分类筛选（记忆/用户/失败）+ 搜索
  - 双开关：自动学习 + 注入提示
- **指令文件展示**：只读展示已加载的 AGENTS.md / CLAUDE.md，支持全局/项目筛选
- **影响范围**：packages/kernel（memory-store, ws-server, extensions）、packages/frontend（MemoryPage, store/memory, App, Sidebar）、packages/shared（memory 类型定义）
- **验证**：kernel 单元测试 169 pass / 0 fail；frontend 组件测试 232 pass（MemoryPage 6/6）；E2E memory.spec.ts 5/5 通过

## 2026-07-10 — dev 脚本按 R 重启时前端端口漂移修复

- **类型**：修复
- **摘要**：修复 `bun run dev` 按 `R` 重启后，Vite 可能换端口但浏览器仍停留在旧端口的问题。`scripts/dev.ts` 改用 `lastOpenedFrontendPort` 追踪最近一次打开的端口，检测到 `Local:` URL 的端口变化时自动重新打开浏览器；`packages/frontend/vite.config.ts` 增加 `strictPort: true`，让 Vite 优先固守 5180 端口。保持端口不变时不重复开新标签页。
- **影响范围**：`scripts/dev.ts`、`packages/frontend/vite.config.ts`
- **验证**：`bun run typecheck` 全通过；`bun run test` 339 pass / 0 fail（DirTreePicker 等前端测试通过）

## 2026-07-10 — 安装 grep/find/ls 与网络搜索抓取工具支持

- **类型**：新增功能
- **摘要**：为 HiAgent agent 扩展默认工具集。`grep` / `find` / `ls` 为 Pi 内置文件工具，直接加入默认 fallback；`web_search` / `fetch_content` / `get_search_content` 由 `pi-web-access` 扩展提供，已作为 `@hiagent/kernel` 依赖打包，并在 kernel 启动时通过 `ensureWebAccessInstalled()` 自动注册到 `~/.hiagent/settings.json`（幂等、支持从旧 `npm:pi-web-access` 格式迁移）。新增 `DEFAULT_AGENT_TOOLS` 常量统一默认工具集，避免多处硬编码。
- **影响范围**：`packages/kernel/package.json`、`packages/kernel/src/index.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/web-access-setup.ts`、`packages/shared/src/constants.ts`、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/web-access-setup.test.ts`、`packages/shared/tests/constants.test.ts`
- **验证**：新增测试覆盖 web-access 自动注册（首次/幂等/迁移/保留其他包）与默认工具集断言；`bun run typecheck` 全通过，`bun test packages/kernel/tests packages/shared/tests` 152 pass / 0 fail

## 2026-07-09 — Composer 重构收尾（composer-redesign Tasks 10-18）

- **类型**：新增功能 / 重构
- **摘要**：完成 Composer 重构主体工作。前端 `Composer` 与 `NewSessionPane` 统一接入可复用 `ComposerInput` 胶囊输入组件与 `composer-prefs` Zustand store，实现模型切换、思考强度（thinking level）开关、附件（图片/文件/文本片段）选择与展示；per-session 偏好与全局默认值通过 IndexedDB 持久化。供应商模型新增 `supportsVision` 开关，kernel `agent:prompt` 支持按请求切换模型与 thinking level，图片附件根据模型 vision 支持能力决定直接作为 images 发送或降级为文本引用；新增 `fs:readFile` WS 接口供前端读取本地文件内容。同步完成四层验收测试：单元测试（frontend/kernel/shared）、组件测试（ComposerInput/NewSessionPane/Composer 等）、API 集成测试（composer-attachments）、E2E 测试（Playwright composer.spec）。
- **影响范围**：`packages/frontend/src/components/{Composer,NewSessionPane}.tsx`、`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/components/settings/ProviderFormModal.tsx`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/index.ts`、`packages/kernel/tests/composer-attachments.test.ts`、`packages/frontend/e2e/composer.spec.ts` 等
- **验证**：`bun test`（frontend 134 pass / 1 skip / 2 fail；kernel + shared 130 pass / 3 skip / 0 fail），其中 frontend 2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关；`bunx playwright test packages/frontend/e2e/composer.spec.ts` 4/4 通过

## 2026-07-09 — 前端 fs-client 新增 readFile（composer-redesign Task 9）

- **类型**：新增功能
- **摘要**：在 `packages/frontend/src/fs-client.ts` 中新增 `readFile(path)` Promise 封装，发送 WS `fs:readFile` 请求并监听对应的 `fs:readFile` 响应；成功返回 `{ content, mimeType }`，失败时按响应的 `error` 字段 reject。新增对应单元测试覆盖成功与错误路径。
- **影响范围**：`packages/frontend/src/fs-client.ts`、`packages/frontend/tests/fs-client.test.ts`
- **验证**：`bun test packages/frontend/tests/fs-client.test.ts` 2/2 通过；`bun test` 全量 130 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — 共用 ComposerInput 胶囊输入组件（composer-redesign Task 8）

- **类型**：新增功能
- **摘要**：新增可复用胶囊输入组件 `packages/frontend/src/components/ui/ComposerInput.tsx`，组合 textarea 自适应高度、附件按钮/文件选择、`ModelSelector`、`ThinkingToggle`、发送按钮以及附件 Chip 列表；选择本地文件后通过 `AttachmentPathModal` 补填绝对路径并生成 `AttachmentDraft`。暴露 `text`/`setText`、`model`/`setModel`、`thinking`/`setThinking`、`attachments`/`setAttachments`、`onSend`、`sendDisabled`、`placeholder` props，供 `Composer` 与 `NewSessionPane` 复用。
- **影响范围**：`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/tests/ComposerInput.test.tsx`
- **验证**：`bun test packages/frontend/tests/ComposerInput.test.tsx` 1/1 通过；`bun test` 全量 128 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — 附件路径补填弹窗（composer-redesign Task 7）

- **类型**：新增功能
- **摘要**：新增 `AttachmentPathModal` 弹窗组件，用于在用户选择本地文件后补填浏览器无法暴露的绝对路径。组件接收 `fileName`、`onConfirm(path)`、`onCancel()` 三个 props，基于现有 `Modal` 容器实现，包含路径输入框、取消/确认按钮；输入为空时确认按钮禁用，点击确认回传 trimmed 后的路径。
- **影响范围**：`packages/frontend/src/components/ui/AttachmentPathModal.tsx`、`packages/frontend/tests/AttachmentPathModal.test.tsx`
- **验证**：`bun test packages/frontend/tests/AttachmentPathModal.test.tsx` 1/1 通过；`bun test` 全量 127 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — AttachmentChip 组件（composer-redesign Task 6）

- **类型**：新增功能
- **摘要**：新增可复用附件 Chip 组件 `packages/frontend/src/components/ui/AttachmentChip.tsx`，接收 `AttachmentDraft` 与 `onRemove` props，根据附件类型渲染不同图标（image → 📷，snippet → 📝，file → 📄），snippet 超长时截断为 20 字符并追加 `…`；移除按钮补充 `type="button"` 与 `aria-label="移除附件"`。
- **影响范围**：`packages/frontend/src/components/ui/AttachmentChip.tsx`、`packages/frontend/tests/AttachmentChip.test.tsx`
- **验证**：`bun test packages/frontend/tests/AttachmentChip.test.tsx` 4/4 通过；`bun test` 全量 126 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — ModelSelector 组件（composer-redesign Task 4）

- **类型**：新增功能
- **摘要**：新增可复用模型选择器组件 `packages/frontend/src/components/ui/ModelSelector.tsx`，从 `useProvidersStore` 读取已配置供应商及其模型，渲染为原生 `<select>` 下拉框；无模型时显示"未配置模型"提示。组件接受 `value`/`onChange`/`disabled` 三个 props。
- **影响范围**：`packages/frontend/src/components/ui/ModelSelector.tsx`、`packages/frontend/tests/ModelSelector.test.tsx`
- **验证**：`bun test packages/frontend/tests/ModelSelector.test.tsx` 4/4 通过；`bun test` 全量 121 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — 补充 composer-prefs 缺失测试（composer-redesign Task 3 fix round）

- **类型**：测试补充
- **摘要**：修复 review 中指出的测试缺口：为 `loadDefaults` 新增从 IndexedDB 加载默认值到 state 的用例；为 `loadSession` 新增读取已存 session 偏好以及无记录时回退到默认值的用例；为 `setDefaults` 新增更新 state 并持久化到 IndexedDB 的用例。`composer-prefs.test.ts` 测试用例由 1 个扩展为 5 个。
- **影响范围**：`packages/frontend/tests/composer-prefs.test.ts`
- **验证**：`bun test packages/frontend/tests/composer-prefs.test.ts` 5/5 通过；`bun test` 全量 117 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — Composer 偏好 Zustand Store（composer-redesign Task 3）

- **类型**：新增功能
- **摘要**：在 Task 2 的 IndexedDB 封装之上新增 `packages/frontend/src/store/composer-prefs.ts`，使用 Zustand 暴露 composer 偏好给 React 组件。提供 `useComposerPrefsStore`，包含 `loadDefaults`、`loadSession`、`setSessionPrefs`、`setDefaults` 四个 action；`setSessionPrefs` 会同时更新 per-session 状态并将 model/thinking 回写为全局默认值，数据通过 `composer-db.ts` 持久化到 IndexedDB。
- **影响范围**：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/tests/composer-prefs.test.ts`
- **验证**：`bun test packages/frontend/tests/composer-prefs.test.ts` 1/1 通过；`bun test` 全量 113 pass / 1 skip / 2 fail，2 个失败为 `store-providers.test.ts` 预存问题，与本次改动无关

## 2026-07-09 — IndexedDB 封装 composer 偏好（composer-redesign Task 2）

- **类型**：新增功能
- **摘要**：新增 `packages/frontend/src/store/composer-db.ts`，使用 `idb` 封装 IndexedDB 读写 per-session composer 偏好（model/thinking/attachments）与全局默认值；暴露 `getSessionPrefs` / `setSessionPrefs` / `deleteSessionPrefs` / `getDefaults` / `setDefaults` 五个接口。由于 Task 1 未导出 `AttachmentDraft`，本次在 `packages/shared/src/types.ts` 补充该类型，供 composer-db 及后续组件使用。前端测试环境通过 `fake-indexeddb` 提供 IndexedDB polyfill。
- **影响范围**：`packages/frontend/src/store/composer-db.ts`、`packages/frontend/tests/composer-db.test.ts`、`packages/frontend/tests/happydom-setup.ts`、`packages/frontend/package.json`、`packages/shared/src/types.ts`
- **验证**：`bun test packages/frontend/tests/composer-db.test.ts` 4/4 通过（含 fix round 补充的 2 个用例）；`bun run test` 通过 230 项，仅存在 2 个与本次改动无关的预失败（`packages/frontend/tests/store-providers.test.ts`）。`bun run --filter @hiagent/shared typecheck` 通过；`@hiagent/frontend` typecheck 仍有既有错误，与本次改动无关。

## 2026-07-09 — 补充 composer-db 缺失测试（composer-redesign Task 2 fix round）

- **类型**：测试补充
- **摘要**：修复 review 中指出的测试缺口：为 `deleteSessionPrefs` 新增删除后读取返回 `undefined` 的用例；为 `getDefaults` 新增 IndexedDB 中无记录时返回 `{ model: null, thinking: "disabled" }` 兜底的用例。`composer-db.test.ts` 测试用例由 2 个扩展为 4 个。
- **影响范围**：`packages/frontend/tests/composer-db.test.ts`
- **验证**：`bun test packages/frontend/tests/composer-db.test.ts` 4/4 通过；全量前端测试仍仅存在 2 个与本次改动无关的预失败（`packages/frontend/tests/store-providers.test.ts`）。

## 2026-07-09 — 扩展共享类型（composer-redesign Task 1）

- **类型**：新增功能
- **摘要**：为重构聊天输入组件扩展共享类型。`PromptEvent` 新增 `model`/`thinking`/`attachments` 可选字段；新增 `AttachmentRef` 联合类型（image/file/snippet）；新增 `FSReadFileRequest`/`FSReadFileResult` WS 事件并加入 `WSClientEvent`/`WSServerEvent` 联合；`ProviderModel` 新增 `supportsVision` 可选字段。
- **影响范围**：`packages/shared/src/types.ts`、`packages/shared/src/providers.ts`、`packages/shared/tests/types.test.ts`
- **验证**：`bun run --filter @hiagent/shared typecheck` 通过；`bun test packages/shared/tests/types.test.ts` 9/9 通过

## 2026-07-09 — DirTreePicker 搜索过滤功能

- **类型**：新增功能
- **摘要**：目录选择器（DirTreePicker）新增搜索框，支持输入关键字过滤已加载的目录树。匹配规则：不区分大小写，匹配目录名中包含关键字的节点；自动保留匹配节点的完整父级链并展开；清空搜索恢复完整树；无匹配时显示"无匹配结果"提示。
- **影响范围**：`packages/frontend/src/components/DirTreePicker.tsx`（新增 searchQuery 状态、filterTreeItems/findParentId 工具函数、搜索输入框 UI、空状态提示）、`packages/frontend/tests/DirTreePicker.test.tsx`（新增 5 个搜索过滤测试用例，更新 mock 数据）

## 2026-07-09 — 技能管理

- **类型**：新增功能
- **摘要**：系统设置页新增「技能」菜单。支持管理技能加载目录（内置 `~/.hiagent/skills/` 不可删 + 用户自定义目录增删）、查看已加载技能列表、单独启用/禁用技能。同名技能去重（内置优先）。配置变更后自动 reload 所有活跃会话热生效。
- **影响范围**：`shared/src/skills.ts`（新增类型+WS事件）、`shared/src/constants.ts`（BUILTIN_SKILLS_DIR）、`shared/src/types.ts`（WS联合扩展）、`kernel/src/skill-manager.ts`（扫描/去重/目录管理/toggle）、`kernel/src/agent-manager.ts`（reloadAllSessions）、`kernel/src/ws-server.ts`+`index.ts`（WS接入+启动注册）、`frontend/src/store/skills.ts`、`frontend/src/components/settings/SkillSection.tsx`、`frontend/src/store/settings.ts`（activeSection扩展）、`frontend/src/components/SettingsModal.tsx`、`frontend/src/App.tsx`

## 2026-07-09 — 系统设置页 + 模型供应商管理

- **类型**：新增功能
- **摘要**：新增「⚙ 系统设置」入口与全屏设置页，提供自定义 LLM 供应商管理。支持增删改查供应商（名称/baseURL/apiKey/API格式/模型列表），模型 ID 通过 tag 录入（| 分隔/回车添加），每个模型可配置上下文窗口与最大输出，支持连通测试。供应商通过 Pi extension 的 `pi.registerProvider()` 注册，会话可用 `<slug>/<modelId>` 引用。
- **影响范围**：`shared/src/providers.ts`（新增类型+WS事件+纯函数）、`shared/src/constants.ts`（PROVIDERS_FILE/GENERATED_DIR）、`shared/src/types.ts`（WS联合扩展）、`kernel/src/provider-store.ts`（持久化）、`kernel/src/provider-extension.ts`（Pi extension生成）、`kernel/src/provider-test.ts`（连通测试）、`kernel/src/ws-server.ts`+`index.ts`（WS接入+启动注册）、`frontend/src/store/{settings,providers}.ts`、`frontend/src/components/{SettingsButton,SettingsModal}.tsx`、`frontend/src/components/settings/*`、`frontend/src/components/ui/TagInput.tsx`、`Sidebar.tsx`、`App.tsx`

## 2026-07-08 — Steer 消息队列控制

- **类型**：新增功能
- **摘要**：实现消息队列控制 — agent 运行中用户消息默认 followUp 排队，支持「引导」升级、「立即」执行、「取消」引导、「清空」排队。新增 4 个 WS steer 协议事件 + queue_update SDKEvent + AgentManager 5 个队列方法。
- **影响范围**：`shared/src/types.ts`（4 个 Steer 事件 + queue_update SDKEvent）、`kernel/src/agent-manager.ts`（prompt 改 followUp + _jumpQueue/promoteToSteer/immediate/clearSteeringQueue/clearFollowUpQueue）、`kernel/src/ws-server.ts`（4 个 steer handler）、`kernel/tests/agent-manager.test.ts`（mock 更新 + 4 个队列测试）
- **验证**：shared typecheck 通过；shared 10/10 + kernel non-SDK 15/15 全绿

---

## 2026-07-08 — pi-intercom 打包为项目依赖，消除运行时 npm install

- **类型**：修复
- **摘要**：将 pi-intercom 从运行时 npm install（通过 `settings.json` 的 `npm:pi-intercom` 触发 `DefaultResourceLoader` → `npm install`）改为作为 `@hiagent/kernel` 的项目依赖打包。`ensureIntercomInstalled()` 现在通过 `import.meta.resolve("pi-intercom")` 解析本地路径写入 settings.json，Pi SDK 以本地路径加载，彻底消除 `npm install pi-intercom --prefix ~/.hiagent/npm --legacy-peer-deps` 及其 code 190 错误。同时支持旧 `npm:pi-intercom` 格式自动迁移。
- **影响范围**：`packages/kernel/package.json`、`packages/kernel/src/intercom-setup.ts`（重写）、`packages/kernel/tests/intercom-setup.test.ts`（重写）

---

## 2026-07-08 — Pi SDK 模式重构

- **类型**：重构
- **摘要**：将 kernel 从 spawn `pi --mode rpc` 子进程 + JSON-RPC 协议改为同进程 `createAgentSession` SDK 直连。AgentManager 用 `Map<sessionId, AgentSession>` 管理多会话，事件用 `sdk:event` 信封全量透传前端。删除 pi-rpc-client.ts 和 state-aggregator.ts。pi-intercom 通过 `session.setSessionName()` + `~/.hiagent/settings.json` packages 配置兼容。
- **影响范围**：`packages/kernel/src/agent-manager.ts`（重写）、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/project-store.ts`、`packages/kernel/src/intercom-setup.ts`（新增）、`packages/shared/src/types.ts`、`packages/shared/src/constants.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`、`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/components/SessionView.tsx`、删除 `pi-rpc-client.ts`/`state-aggregator.ts` 及其测试

---

## 2026-07-08 — Composer / NewSessionPane 发送防抖

- **类型**：修复
- **摘要**：两个组件的 `handleSend` 无防抖保护。React 批量更新 state 导致 `setText("")` 和下一次 Enter/点击之间有竞态窗口 — text 还是旧值，`send()` 被调用两次。修复：加 `sendingRef` 标志位，send 前置 `true`，500ms 后 `setTimeout` 复位，gate 处 `sendingRef.current` 拦截重复发送。
- **影响范围**：`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/NewSessionPane.tsx`

---

## 2026-07-08 — 修复会话列表 UI 重复（session:created 重复广播）

- **类型**：修复
- **摘要**：`agent:prompt` handler 每次都会广播 `session:created`，即使复用已有 session。前端 `addSession` 直接 push 不去重，同一 sessionId 连发多条消息就在侧边栏出现多次。修复：(1) kernel 只在真正新建 session 时广播 `session:created`；(2) 前端 `addSession` 加去重逻辑（兜底）。
- **影响范围**：`packages/kernel/src/ws-server.ts`（`agent:prompt` 加 `isNew` 判断）、`packages/frontend/src/store/projects.ts`（`addSession` 去重）

---

## 2026-07-08 — 修复 NewSessionPane 首条消息用户消息丢失

- **类型**：修复
- **摘要**：`NewSessionPane` 发消息后 kernel 先广播 `session:created`、再广播 `agent:message`（用户消息）。`session:created` 触发前端切到 `SessionView`，但 `SessionView` 的 `onMessage` 订阅在 `useEffect` 中注册，此时 `agent:message` 早已到达并被 `App.tsx` 丢弃（因 App 不处理 `agent:message`）。修复：`App.tsx` 的 `onMessage` 增加 `agent:message` 处理，直接 `append` 到 session store（`append` 靠 msgKey 去重，SessionView 二次处理安全）。
- **影响范围**：`packages/frontend/src/App.tsx`（onMessage 加 `agent:message` case）

---

## 2026-07-08 — 修复 NewSessionPane 连发消息产生多个重复 session 的 bug

- **类型**：修复
- **摘要**：两个层面的问题：(1) `NewSessionPane.handleSend()` 每次调用都 `randomSessionId()` 生成新 ID，快速连发消息导致 kernel 收到多个不同 sessionId；(2) kernel `createSession()` 忽略前端传来的 sessionId，始终用 `randomUUID()` 生成新 ID。连锁反应：每条消息都创建新 session。修复：前端 sessionId 改为 `useState` 生成一次复用；后端 `createSession` 加可选 `id` 参数，`agent:prompt` handler 传入前端 sessionId。
- **影响范围**：`packages/frontend/src/components/NewSessionPane.tsx`（sessionId 生成一次）、`packages/kernel/src/project-store.ts`（`createSession` 加可选 id）、`packages/kernel/src/ws-server.ts`（`agent:prompt` 传入前端 sessionId）

---

## 2026-07-08 — 修复首条消息用户/agent 顺序颠倒 bug

- **类型**：修复
- **摘要**：首条消息场景下存在竞态条件：SessionView 挂载前，kernel 广播的 user `agent:message` 被 App.tsx 丢弃；SessionView 挂载后，Pi 流式 assistant 消息先到达 `append()`，然后 `session:messages` 响应通过 `setMessages()` 把 user 消息追到数组末尾，导致 UI 显示为 assistant 在前、user 在后。修复：`setMessages` 合并后按 timestamp 排序。
- **影响范围**：`packages/frontend/src/store/session.ts`（`setMessages` 加 timestamp 排序）

---

## 2026-07-08 — 项目列表右键菜单：查看文件夹 + 删除项目

- **类型**：新增功能
- **摘要**：项目列表新增项目级右键菜单，支持两个操作：(1) 查看文件夹 — 发送 `project:open-dir` WS 命令，kernel 端用系统文件浏览器（macOS `open` / Windows `start` / Linux `xdg-open`）打开项目目录；(2) 删除项目 — 弹出确认框后发送 `project:delete` 删除项目及其所有会话。kernel 端 `project:delete` 已就绪，仅补充前端 UI。
- **影响范围**：`packages/shared/src/types.ts`（新增 `ProjectOpenDirEvent`）、`packages/kernel/src/ws-server.ts`（新增 `project:open-dir` handler）、`packages/frontend/src/components/ProjectItem.tsx`（新增项目右键菜单 + 删除确认框）、`packages/kernel/tests/ws-server.test.ts`（新增集成测试）

---

## 2026-07-08 — 修复前端 flaky 测试「点击空白处关闭 popup 菜单」

- **类型**：修复
- **摘要**：测试在全量运行时因 DOM 残留和 happy-dom 事件冒泡行为差异导致间歇失败。修复：(1) 组件 `ProjectItem.tsx` 中 `requestAnimationFrame` → `setTimeout(fn,0)`、`window.addEventListener` → `document.addEventListener`，提升测试环境兼容性；(2) 测试文件添加 `afterEach(cleanup)` 清理 DOM 残留；(3) `fireEvent.click(window.document.body)` → `fireEvent.click(window.document)` 直接在 document 上触发 click。
- **影响范围**：`packages/frontend/src/components/ProjectItem.tsx`、`packages/frontend/tests/ProjectItem.sort-menu.test.tsx`

---

## 2026-07-08 — 修复新建会话始终显示相同聊天内容的 bug

- **类型**：修复
- **摘要**：根因是 Pi RPC 协议不支持单进程多会话（`prompt` 和 `get_messages` 都不接受 session 参数），但 AgentManager 以 `(projectId, agentName)` 为 key 让多个 HiAgent 会话共享一个 Pi 进程，导致所有会话操作同一个 Pi 内部会话。修复方案：AgentManager 进程管理粒度改为 `(projectId, agentName, sessionId)`，每个 HiAgent 会话独立一个 Pi 进程。`ws-server.ts` 所有 `ensureStarted`/`abort` 调用同步传入 `sessionId`。
- **影响范围**：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/ws-server.test.ts`、`packages/kernel/tests/session-messages.test.ts`

---

## 2026-07-08 — dev 启动端口清理增强 + Vite 端口变更自适应

- **类型**：修复
- **摘要**：(1) `killPort` kill 后改为轮询等待端口真正空闲（最多 3s，每 200ms 检测），解决 TIME_WAIT 窗口期端口未释放导致启动失败的问题；(2) `dev.ts` 改为从 Vite 输出解析实际端口，Vite 因端口占用自动换端口时浏览器也能正确打开。
- **影响范围**：`scripts/port.ts`（`killPort` 加轮询）、`scripts/dev.ts`（端口检测逻辑）

---

## 2026-07-08 — killPort 兜底清理失败修复

- **类型**：修复
- **摘要**：`killPort` 当 `findPidOnPort` 返回 null 时直接 return，但 `lsof -ti` 有时拿不到 PID（进程僵死/TIME_WAIT），端口实际仍被占用导致启动失败。修复：PID 查不到时加 `isPortInUse` 二次确认 + shell 管道强制清理兜底，并在 kill 后 sleep 200ms 等 OS 释放端口。
- **影响范围**：`scripts/port.ts`（`killPort` 函数）

---

## 2026-07-08 — pi 环境本地化：从全局依赖改为项目本地依赖

- **类型**：配置变更 / 重构
- **摘要**：将 `@earendil-works/pi-coding-agent` 从全局安装改为 `@hiagent/kernel` 的本地 dependency。`defaultSpawn` 改用 `import.meta.resolveSync` 解析本地 `dist/cli.js` 路径，由 `process.execPath` (bun) 执行，彻底消除对全局 `pi` 命令的依赖。`bun install` 自动拉取 pi，支持项目分发后直接使用无需额外安装。
- **影响范围**：`packages/kernel/package.json`（新增 dependency）、`packages/kernel/src/pi-rpc-client.ts`（新增 `resolvePiBin()`，`defaultSpawn` 改为本地路径 + bun 执行）、`bun.lock`（新增 pi 及其传递依赖）

---

## 2026-07-08 — Windows 兼容：pi 进程 spawn 修复

- **类型**：修复
- **摘要**：`defaultSpawn` 中 `Bun.spawn` 未加 `shell: true`，导致 Windows 下无法找到 npm 全局安装的 `pi.cmd` shim（Bun 默认不解析 PATHEXT）。遵循 `scripts/dev.ts` 已有的跨平台 spawn 模式，加 `shell: true` 让 cmd.exe/shell 解析命令路径。POSIX 下此变更无害。
- **影响范围**：`packages/kernel/src/pi-rpc-client.ts`（`defaultSpawn` 函数）

---

## 2026-07-07 — Agent Browser 真实业务测试 + 4 个 bug 修复

- **类型**：测试 + 修复
- **摘要**：使用 Playwright/Agent Browser 对应用进行真实业务测试（新建项目→多轮对话→智能体设置），发现并修复 4 个 bug：(1) ErrorEvent 缺少 agentName 导致前端错误显示为 "dev"；(2) 智能体配置缺失（~/.hiagent/agents/ 不存在）导致设置页永久"加载中..."；(3) 新建项目目录树第二次打开为空（竞态条件）；(4) state-aggregator 错误未传递结构化 agentName。
- **影响范围**：`shared/src/types.ts`（ErrorEvent 加 agentName 可选字段）、`frontend/src/App.tsx`（用事件中的 agentName 替换硬编码 "dev"）、`frontend/src/components/DirTreePicker.tsx`（root 懒加载去重修复竞态）、`kernel/src/ws-server.ts`（error 广播含 agentName + config null 时返回默认配置）、`kernel/src/state-aggregator.ts`（error 事件加 agentName）、`kernel/src/agent-md.ts`（新增 makeDefaultAgentConfig）。
- **验证**：Playwright 实测新建项目、两轮对话、4 个智能体 × 6 tab 全部走通；目录选择器关闭再打开正常显示盘符；目录选择器仅显示目录不显示文件。

---

## 2026-07-07 — 移除 Rust 窗口层 + bun 一键启动 + 全 bun:test + 目录树选择器（整体收尾）

- **类型**：架构重构（跨 18 task，三阶段）
- **摘要**：移除 Tauri/Rust 窗口层，改用 `bun run dev` 一键启动前后端（并行 kernel 9776 WS + frontend 5180 Vite，自动开浏览器，SIGINT 清理）；测试工具链 vitest → bun:test（24 文件迁移，全仓库单一 runner）；新增本地目录树选择器（react-complex-tree + kernel `fs:listDir`/`fs:roots`/`fs:home` WS 接口）替代 Tauri 原生目录选择器。
- **阶段一（启动层）**：`scripts/{port,open-browser,dev}.ts` + 双击入口 `start.command`/`start.bat`；端口 5173→5180；删 `src-tauri/`、`start.sh`；kernel build 去 Tauri sidecar triple 命名。
- **阶段二（测试迁移）**：happy-dom preload + bunfig.toml；22 个 vitest 文件迁 bun:test（含 vi.mock→mock.module、vi.fn→mock、vi.spyOn→defineProperty）；删 vitest 依赖。修 3 个基础设施问题（WebSocket polyfill defineProperty、afterEach DOM 清理、原型方法 spy）。
- **阶段三（目录树）**：kernel `fs:home`/`fs:roots`(Windows 盘符枚举)/`fs:listDir`(列系统任意目录)三 case；前端 `DirTreePicker`(react-complex-tree 异步 DataProvider 懒加载)+ `fs-client` + 接入新建项目流程。**明确不做安全加固**（用户决策）。
- **影响范围**：删 `src-tauri/`、`start.sh`、`packages/kernel/scripts/copy-sidecar.mjs`、`packages/frontend/vitest.config.ts`；新增 `scripts/`、`packages/frontend/src/{fs-client,components/DirTreePicker}`、`packages/frontend/{tests/happydom-setup,bunfig}`；改 `package.json`、`packages/{kernel/src/ws-server,shared/src/types,frontend/src/{store/projects,App,vite.config,playwright}}`。
- **验证**：scripts 5/5、frontend 65/65、kernel+shared 44/44 全绿；`bun run dev` 浏览器实测目录选择器走通（点选盘符→展开→选中→项目创建）。

---

## 2026-07-07 — frontend 测试框架 vitest → bun:test 基础设施 + 迁第一个文件（Task 8+9）

- **类型**：配置变更 / 测试基建
- **摘要**：frontend 组件测试从 vitest 迁到 bun:test 的第一步。新增 `tests/happydom-setup.ts`（preload：注册 happy-dom 全局 + 复用 WebSocket polyfill）与 `bunfig.toml`（`[test] preload`），替代 vitest 的 environment+setupFiles 机制；删 `vitest.config.ts`；迁最简单的 `Composer.test.tsx`（无 `vi.mock`）验证迁移模式可行；`package.json` test 脚本 `vitest run` → `bun test`。验证：`cd packages/frontend && bun test tests/Composer.test.tsx` 1 pass / 0 fail。
- **影响范围**：新增 `packages/frontend/tests/happydom-setup.ts`、`packages/frontend/bunfig.toml`；改 `packages/frontend/tests/Composer.test.tsx`、`packages/frontend/package.json`（+devDep `@happy-dom/global-registrator`、test 脚本）；删 `packages/frontend/vitest.config.ts`。注：其余 23 个测试仍 `import ... from "vitest"`，后续 task 逐个迁移。

---

## 2026-07-07 — 根 dev 脚本 + frontend/playwright 端口 5173→5180（Task 4）

- **类型**：配置变更
- **摘要**：根 `package.json` scripts 最前加 `"dev": "bun run scripts/dev.ts"`（一键起 kernel+frontend+自动开浏览器，指向 Task 3 的 `scripts/dev.ts`）；frontend `vite.config.ts` 端口 5173→5180 避开 Vite 默认冲突；`playwright.config.ts` 的 baseURL + webServer.url 同步改 5180。手动验证：后台跑 `bun run dev`，`[kernel]`/`[web]` 日志正常、浏览器自动开 5180、Ctrl+C 后端口释放无残留。
- **影响范围**：`package.json`、`packages/frontend/vite.config.ts`、`packages/frontend/playwright.config.ts`

---

## 2026-07-07 — 新增跨平台端口清理纯函数（Task 1: scripts/port.ts）

- **类型**：新增功能（scripts 工具）
- **摘要**：实现跨平台端口占用检测与清理纯函数 `findPidOnPort(port)` / `killPort(port)`，供后续 `scripts/dev.ts` 启动前清理 9776/5180 端口占用。Windows 用 `netstat`/`taskkill`，POSIX 用 `lsof`/`kill -9`；无占用静默返回。
- **影响范围**：新增 `scripts/port.ts`、`scripts/__tests__/port.test.ts`（bun:test，2 个用例：空闲端口返回 null、killPort 不抛错）

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
