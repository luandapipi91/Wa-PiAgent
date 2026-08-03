# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-08-03

### 新增

- **feat(kernel+frontend): 插件命令级启停管理**——把“自动扫描决定命令显示”改为“用户手动控制命令启停”：插件页每个插件卡片新增「⌘ 附加命令」按钮，弹窗列出该插件注册的斜杠命令，逐条开关（默认全部关闭）；TUI-only 命令在弹窗中标记“⚠ TUI 命令不被支持”；`/` 菜单只显示已开启的插件命令（prompt/builtin 不受影响）。
  - 内核：删除 `_commandsCache`（5min TTL）与 `scanCache` 两个缓存机制，`getCommands()` 每次实时拉取；`tuiOnlyCommandNames`→`disabledCommandNames`、`isTuiOnlyCommand`→`isCommandDisabled`；发送端用 `_commandsFetched` 标记 + 关闭命令静默降级（加前导空格变普通文本给 LLM）；`filterTuiCommands` 由过滤改为附加 `tuiOnly`/`packageName` 标记全量返回；`session:commands` 与 `extension:commands:list` 统一在 `_fetchCommands` 合并开关状态；settings.json 新增 `waPiCommandToggles`（裸包名 key，缺省关闭）。
  - 新增 API：`GET /api/extensions/commands`（命令列表 + 开关状态 + TUI 标记）、`POST /api/extensions/commands/toggle`（切换并持久化）。
  - 前端：新增 `CommandListModal` 弹窗（逐命令开关 + TUI 徽标 + 乐观更新）；`/` 菜单按 `enabled` 过滤；`extension_notify` 系统消息（如 `—— MCP: 5 servers connected ——`）显示 20s 后自动从聊天界面消失。
  - 影响范围：`packages/shared/src/commands.ts`、`packages/kernel/src/{agent-manager,tui-command-filter,extension-manager,ws-server,routes/extensions}.ts`、`packages/frontend/src/{store/commands,session}.ts`、`packages/frontend/src/components/settings/{CommandListModal,ExtensionSection}`。
  - 验证：kernel 667 pass、shared 94 pass、前端新增用例全绿；tsc 全绿；旧名 `_commandsCache`/`scanCache`/`tuiOnlyCommandNames`/`isTuiOnlyCommand` 代码级零残留（仅 build-kernel-sidecar.ts 注释已同步清理）。

---

## 2026-08-03

### 修复

- **fix(frontend): 卸载插件等待反馈——按钮 loading 态（spinner +「卸载中…」+ disabled）**——卸载是异步操作（等待 kernel 事件终结），此前点击确认后无任何反馈、按钮可重复点击导致重复卸载。修复：store 新增 `uninstalling: Record<string, boolean>` 状态（`uninstallPackage` 置位、`setAll` 重置、`setError` 清除，与升级 `upgrading` 对称）；组件在卸载中渲染 spinner（border 2px var(--danger-soft)、borderTopColor var(--danger)、spin 0.8s linear infinite）+「卸载中…」，按钮 `disabled={uninstalling[pkg.name] === true}` 防重复点击，失败后恢复可点。
  - 影响范围：`packages/frontend/src/store/extensions.ts`、`packages/frontend/src/components/settings/ExtensionSection.tsx`、`packages/frontend/tests/ExtensionSection.test.tsx`、`packages/frontend/tests/extensions-store.test.ts`。
  - 验证：store 单测 + 组件测试（ExtensionSection.test.tsx 18 pass）、frontend typecheck 通过。
- **fix(frontend): 并行派发卡片折叠/展开重叠——展开子任务后整张卡片关不掉**——根因：FleetCard 在 `hasProgress` 时 `open = hasProgress || autoOpen` 恒为 true（卡片被钉死展开），且头部点击被重定向为 `setAllExpanded`（批量展开所有子任务），用户点头部想收卡片实际却在批量展开子任务；同时 `FleetTaskItem` 的 `expanded = forceExpanded || ownExpanded` 一旦被批量展开过，单个子任务行就收不起来了。修复：移除 `allExpanded`/`forceExpanded` 这套与卡片折叠语义冲突的批量交互——头部点击直接切换本地 `cardOpen` 状态折叠/展开整张卡片（有进度时默认展开，统计行仍可见），子任务行各自独立展开/折叠，互不影响。
  - 影响范围：`packages/frontend/src/components/blocks/FleetCard.tsx`、`packages/frontend/tests/FleetCard.test.tsx`。
  - 验证：FleetCard 测试 17 pass（新增「头部点击折叠/展开整张卡片」「子任务详情可单独收起」2 个用例）、DelegateCard 16 pass、frontend typecheck 通过。

---

## 2026-08-03

### 修复

- **fix(frontend): 子任务详情展开时回复闪烁——ReactMarkdown 无 memo 导致反复全量重解析**——根因：`FleetTaskItem` 展开期间 `useLiveElapsed` 每秒 tick（running 时每秒 setDisplay）+ 流式 output 高频更新都会触发组件重渲染；而 react-markdown v10 无内置 memo，每次重渲染都全量重新解析整段回复文本（长回复时阻塞主线程 → 闪烁）。另 `createMarkdownComponents` 每次渲染新建对象，components 引用变化会让 memo 失效。修复：新增 `MemoReplyMarkdown`（与 FileViewer.MarkdownPreview 同模式）——`memo()` 包裹 + 内部 `useMemo` 稳定 components，只接收 text/sessionId 稳定 prop；`FleetTaskItem` 展开区改用之。文本不变时 React 跳过重解析，每秒 tick 只更新耗时小段，不再波及回复区。
  - 影响范围：`packages/frontend/src/components/blocks/FleetCard.tsx`。
  - 验证：FleetCard + DelegateCard 31 pass、frontend typecheck 通过。

---

## 2026-08-03

### 修复

- **fix(frontend+kernel): 并行委托（fleet）结果展示格式重构 + 完成态工具统计持久化**——用户期望每个任务独立成行：任务清单（`任务 N：委派【agent】task`）+ 每任务统计行（执行中 `调用了 X 个工具 成功 Y 失败 Z 执行中 W` / 完成态 `已完成 调用了 X 个工具 … · 点击查看回复`），点开单个任务才显示该任务的完整回复。原实现为无编号任务列表 + 统一摘要行（N 个子智能体：X 运行中/Y 完成/Z 出错）+ 全部 agent 回复聚合在单个 markdown（一个开关同时展开）
  - 前端：重构 FleetCard，新增 `FleetTaskItem`（每任务独立展开/折叠，含工具计数与耗时）；任务清单按 `任务 N：委派【agent】task` 格式化；新增 `extractAgentReplies` 按 `【agent】` 分隔符切分 kernel 聚合结果，完成态逐任务展示各自回复；无法切分（老数据）时降级为原聚合展示；头部点击批量展开/折叠全部任务回复。
  - kernel：工具统计不再只依赖实时 SSE——`subagent-runner` 从 tools 数组计算 `toolStats`（total/done/error/running）加入 `SubagentRunResult`；`delegate-tool` fleet 聚合把各子代理 `toolStats` 写入 toolResult 的 `details.fleet[agent]`，经 pi SDK 原样持久化到会话 JSONL。刷新页面/重载历史会话后完成态统计仍可显示（旧会话无 details 时降级为「已完成 · 点击查看回复」，回复仍可查看）。
  - 影响范围：`packages/frontend/src/components/blocks/FleetCard.tsx`、`packages/frontend/tests/FleetCard.test.tsx`、`packages/kernel/src/subagent-runner.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/shared/src/types.ts`（新增 `ToolStats`、`ToolResultMessage.details`）、`packages/kernel/tests/subagent-runner.test.ts`、`packages/kernel/tests/delegate-tool.test.ts`。
  - 验证：FleetCard 测试 15 pass（新增任务清单格式/统计行格式/完成态按 agent 拆分/details 持久化统计 4 个用例）、DelegateCard 16 pass、kernel 全量 648 pass（新增 fleet 聚合 toolStats 用例 + 正常流程 toolStats 断言）、三个包 typecheck 通过。

---

## 2026-08-03

### 修复

- **fix(desktop): runtime 目录卸载扩展失败——`bun remove` 找不到 pi-mcp-adapter patch 文件**——根因：运行时依赖安装在 `~/.wa-pi/runtime`（RUNTIME_DIR），seed 由 `runtime-deps.cjs` 同步，但 `SEED_FILES` 只含 `kernel.js / package.json / bun.lock / tool-schemas.ts / wa-pi-bridge.extension.ts`，**从未复制 `patches/` 目录**；而 sidecar 的 package.json 声明了 `patchedDependencies: pi-mcp-adapter@2.17.0 → patches/pi-mcp-adapter@2.17.0.patch`。应用内卸载（`NpmPackageService.uninstall` → `bun remove`）重新解析依赖树时会校验 patch 文件存在性，缺文件即报 `Couldn't find patch file: 'patches/pi-mcp-adapter@2.17.0.patch'` 并包装为「卸载失败」。修复：`syncSeed` 增加 patches 目录的递归同步（先清空旧的再整体复制，seed 无 patches 时静默跳过）；同时导出 `syncSeed` 便于测试。首启 `bun install --production` 不受影响（production 模式不校验 patch），卸载/安装路径此前必现失败。
  - 影响范围：`packages/desktop/src/util/runtime-deps.cjs`、新增 `packages/desktop/tests/runtime-deps.test.ts`。
  - 验证：新增单元测试「syncSeed 复制 patches / patches 缺失静默跳过 / 旧 patches 被整体替换」通过；端到端用真实 seed 同步到临时 runtime 后 `bun install` + `bun remove` 成功（此前必报 patch 缺失）；desktop 全量 43 测试 pass、typecheck 通过。

---

## 2026-08-03

### 修复

- **fix(kernel): 新建会话页切换智能体失效——ensureStarted 复用进程不校验 agentName + 会话 primaryAgent 不同步**——根因：新建会话页挂载时 ComposerInput 立即拉取 `/commands`，后端 `getCommands` 兜底分支（无活跃进程时）用**默认智能体**提前创建会话并启动 pi 进程（不广播 session:created，前端无感知）；用户在 dropdown 切到智能体 B 后发送，`agent:prompt` → `ensureStarted` 只按 sessionId 复用已有活跃进程、**不校验 agentName** → 消息被交给旧智能体 A 的进程处理（前端显示 B、实际回复来自 A），且会话记录 primaryAgent 仍为 A（broadcast projects:list 会把 A 覆盖到前端，侧栏显示旧智能体）。修复两层：① `ensureStarted` 命中缓存时校验 `meta.agentName !== agentName` 则拆除旧进程并按新智能体重建（参考 `switchAgent` 行为）；② `agent:prompt` 对已存在会话且 primaryAgent 不一致时 `setSessionAgent` 同步记录并广播 projects:list。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（ensureStarted）、`packages/kernel/src/ws-server.ts`（agent:prompt）、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/composer-attachments.test.ts`（withComposerServer 暴露 ctx）。
  - 验证：新增单元测试「同 sessionId 但 agentName 变化时拆除旧进程并按新 agent 重建」先红后绿；新增集成测试「getCommands 兜底建会话后切换 agent 发送 → 新 agent 进程接管且会话 primaryAgent 同步」先红后绿（覆盖 REST → ws-server → AgentManager 全链路）；kernel 647 pass / 0 fail；kernel typecheck 通过。

---

## 2026-08-03

### 修复

- **fix(build): 生产打包失败——根 package.json 冗余生产依赖与 bun 隔离布局不兼容**——electron-builder 26 检测到 workspace root 后会把根 `dependencies` 纳入依赖收集，但 bun 1.3 隔离安装布局（依赖存放于 `node_modules/.bun/`，非传统 `node_modules/@scope/pkg`）导致收集器报 `Production dependency @amaster.ai/pi-memory not found for package wa-pi`。修复：移除根 package.json 冗余的 `dependencies`（`@amaster.ai/pi-memory`/`pi-open-agents`/`typebox`——三者已分别由 packages/kernel、packages/shared 声明，根代码无直接引用），`bun install` 更新 lockfile 后 electron-builder 依赖收集为空、打包通过。
  - 影响范围：根 `package.json`、`bun.lock`。
  - 验证：`build:mac` 全流程通过（typecheck + 全量测试 + sidecar 组装 + electron-builder 出 dmg/zip）；dmg 挂载验证含 Applications 快捷方式与应用本体。

---

## 2026-08-02

### 新增

- **chore(license): 项目开源许可声明落地**——根与 4 个子包 package.json 补齐 `license: MIT`；新增根 LICENSE（MIT）；新增 THIRD_PARTY_NOTICES.md 归档运行时第三方插件许可（9 个直接依赖全部 MIT/Apache-2.0，零 copyleft）；内置扩展源码（wa-pi-bridge.extension.ts、provider-extension.ts）加 SPDX 头注释

- **feat(frontend): UI 字体接入 MiSans（4 字重）+ 代码字体 JetBrains Mono（中文回退 MiSans）**——告别 Windows 微软雅黑，跨平台统一视觉

### 修复

- **fix(kernel): agent.md 序列化不再写 `thinking: null`，消除 pi 启动的 Agent parse warning**——`makeDefaultAgentConfig` 默认 `thinking: null`，`stringifyAgentMd` 无条件写 `thinking: ${c.thinking}` → 文件出现 `thinking: null`，pi 解析 frontmatter 时把 `"null"` 当字符串（非 off/minimal/low/medium/high/xhigh）→ 启动时连发 9 条 `Agent parse warning`。修复：null thinking 不写该行（wa-pi 读取 undefined → null 语义不变；pi 侧用默认值）；并清理已生成的 9 个 agent 文件中的 `thinking: null` 行。
  - 影响范围：`packages/kernel/src/agent-md.ts`、`packages/kernel/tests/agent-md.test.ts`、`~/.wa-pi/agents/*.md`（9 个内置 subagent 配置）。
  - 验证：agent-md 23 pass；**真实测试**（dev kernel :9776 + 新 pi 进程）发送 `/lens-toggle` 后 `Agent parse warning` 从 9 条 → 0 条，只剩 `pi-lens disabled...` 一条正常 notify。

- **fix(kernel/frontend): pi 扩展 `ctx.ui.notify` 反馈显示在聊天窗口中间，动作型命令不再“无响应”**——`/lens-toggle` 等扩展命令 handler 只用 `ctx.ui.notify` 反馈执行结果（不产生 LLM 回复），在 GUI 下 notify 被 kernel 丢弃 → 用户看不到任何反馈（表现为“发送无响应”）。修复链路：① kernel `handleUiRequest` 对 notify 转发为 `extension_notify` 事件；② 事件经 `AgentManager.onEvent` 包装为 `sdk:event`（event 字段承载原始事件）→ SSE 推送；③ 前端 `session-store.handleSDKEvent` 增加 `extension_notify` case → 插入聊天窗口中间的 custom 系统提示（复用 `customType` 居中渲染：`—— content ——`，与 agent_switch/reload_config 同款；连续同内容去重，防 pi 启动时连发刷屏）。
  - 影响范围：`packages/kernel/src/rpc-client.ts`、`packages/shared/src/extensions.ts`（ExtensionNotifyEvent）、`packages/shared/src/types.ts`（SDKEvent 联合 + WSServerEvent 联合）、`packages/frontend/src/store/session.ts`、`packages/kernel/tests/rpc-client.test.ts`、`packages/frontend/tests/session-extension-notify.test.ts`。
  - 验证：typecheck 全绿（shared/kernel/frontend）；kernel notify 转发测试 + 前端 4 个 store 测试（插入/去重/不同内容/非 notify 不触发）；**完整链路真实测试**（dev kernel :9776 + 真实 pi 0.83.0 + 真实 pi-lens 扩展）：发送 `/lens-toggle` → prompt 200 → SSE 收到 10 次 `extension_notify`（9 parse warning + 1 lens-toggle）→ 前端 store 全部插入聊天窗口中间 custom 消息，lens-toggle 内容为“pi-lens disabled for this session. Run /lens-toggle again to resume.”。

- **fix(kernel): TUI-only 命令改为 kernel 发送端拦截，删除 pi 侧补丁**——`/agent-search` 等 TUI-only 命令在 GUI 发送后无响应的根治：
  - ① 过滤正则支持泛型 + 全部 TUI API：`\bui\.(?:custom|input|select|confirm|editor)(?:\s*<[^>]*>)?\s*\(`，修复 `ui.custom<string | null>(` 泛型漏判；pi-open-agents 的 `/agent-search`、`/agent`、`/agents` 从 `/` 菜单隐藏。
  - ② 删除 `patches/@earendil-works%2Fpi-coding-agent@0.83.0.patch`（PI_TUI_ONLY 补丁），不再依赖 pi 侧 custom() 抛错降级；TUI-only 命令的拦截全部收敛到 kernel `prompt()` 发送端（`isTuiOnlyCommand` → 加前导空格降级为普通文本），不依赖 pi 版本行为与补丁传导。
  - ③ `build-kernel-sidecar.ts` 的 runtime patchedDependencies 只保留 pi-mcp-adapter（exports/类型补丁），移除 pi-coding-agent 条目；顺带修复构建脚本 `shell: true` 命令注入面（bun 命令改走 `process.execPath`）。
  - 影响范围：`packages/kernel/src/tui-command-filter.ts`、`packages/kernel/tests/tui-command-filter.test.ts`、根 `package.json`（patchedDependencies）、`packages/desktop/scripts/build-kernel-sidecar.ts`、`patches/`。
  - 验证：新增失败测试（泛型形式 + 带空格泛型 + ui.input/select/confirm/editor）先红后绿；kernel 84 pass / 0 fail；真实 pi-open-agents 路径过滤生效（`agent-search`/`agent`/`agents` 被过滤，`isTuiOnlyCommand` 返回 true）；bun install 后 pi 0.83.0 恢复原版（PI_TUI_ONLY 0 处）。
  - 注：用户本机 `~/.wa-pi/runtime/node_modules` 需重装（删除 node_modules + `.installed-version` 后重启应用）使 kernel.js（新正则）与依赖同步。

- **fix(frontend): 技能/命令/智能体/文件触发符支持全角符号（￥＄＠＃／ 归一化）**——Windows 中文输入法全角模式输入 ￥ 不再失效。触发符归一化逻辑收敛到 `normalizeTriggerChars`（仅归一化 5 个全角符号，不含全角字母数字/标点），`detectTrigger` / `expandTokens` 入口统一调用；`textToSegments` / `textToHtml` / `segmentsToText` 显示路径不归一化。
  - 影响范围：`packages/frontend/src/quick-invoke/tokens.ts`、`packages/frontend/src/quick-invoke/trigger.ts`；`tests/tokens.test.ts`、`tests/trigger.test.ts`、`tests/ComposerInput.test.tsx`、`e2e/quick-invoke.spec.ts`。
  - 验证：单元测试覆盖 5 个全角符号触发 + 普通文本不动 + 全角 token 展开 + 全角 token 不误触发；组件测试输入 \uFFE5 弹技能面板；E2E 输入 \uFFE5 弹技能面板；frontend 全量 pass。

### 变更

- **内置插件与运行时依赖升级**：
  - `pi-web-access`：打包态 `^0.13.0` → `^0.17.1`（dev `^0.15.0` → `^0.17.1`），网络工具族（web_search / fetch_content / source_check）追赶 2 个 minor。
  - `@earendil-works/pi-coding-agent` / `pi-ai`：打包态 sidecar `^0.80.x` → `^0.83.0`，移除 `overrides` 对 pi-ai 0.80.10 的钉死——dev/打包态版本对齐，消除运行时版本分裂。
  - `pi-mcp-adapter`：dev `2.15.0` → `2.17.0`，patch 同步升级为 `pi-mcp-adapter@2.17.0.patch`（内容实质相同：补 `./mcp-auth.ts` exports 子路径 + `resolveCommandSecretsRecord` 返回类型放宽）；2.17.0 仍未内置该 exports，dev 直接跑 TS 源码依赖 patch（打包态 kernel.js 经 bun build 内联不受影响）。
  - `typebox`：dev `1.1.38` → `^1.3.6`（实际解析 1.3.10，与 sidecar 对齐）。
  - `pi-open-agents` → `0.1.14`、`@amaster.ai/pi-memory` → `0.1.7`（约束范围内升级到最新）。
  - 影响范围：`packages/kernel/package.json`、`packages/shared/package.json`、根 `package.json`（patchedDependencies）、`packages/desktop/scripts/build-kernel-sidecar.ts`（sidecar 依赖清单）、`patches/`（mcp-adapter patch 升级）。
  - 验证：typecheck 全绿；kernel 642 / shared 93 / desktop 40 / frontend 893 全量 pass；重新打包成功；模拟 runtime 首启安装（330 包）版本核对通过（pi-ai/pi-coding-agent 0.83.0、pi-web-access 0.17.1、pi-open-agents 0.1.14、pi-memory 0.1.7、typebox 1.3.10、pi-mcp-adapter 2.17.0）。

### 变更

- **web-search 默认 provider 改为 anysearch（合并覆盖，不再整文件覆盖）**：kernel 启动 `ensureWebSearchConfig` 改为「读现有 web-search.json → 只合并覆盖 `provider`/`workflow` 两个键 → 写回」，保留用户手动配置的其他字段（如各 provider 的 API key）；默认 provider 从 `auto` 改为 `anysearch`（匿名可用、无需 key，开箱即用，避免 auto 无 key 抛 No search provider available）。
  - 影响范围：`packages/kernel/src/index.ts`（ensureWebSearchConfig）。
  - 验证：typecheck 全绿；kernel 全量 642 pass / 0 fail。

### 修复

- **工具白名单清理：移除遗留 `session_search`、补入 `source_check`**：
  - `session_search` 是旧插件 pi-hermes-memory 替换为 `@amaster.ai/pi-memory` 时漏在白名单的孤儿工具名——运行时无任何注册者，agent 调用必失败。已从 `DEFAULT_AGENT_TOOLS` 移除，并新增守卫断言确保不再回归；前端测试 fixture 中的模拟工具名同步清理（dist/构建产物下次构建自动更新，docs 历史文档保留）。
  - `source_check`（pi-web-access 提供的来源核查工具，多引擎检索 + passage 级引用评估）此前已注册但未进白名单——已补入 `DEFAULT_AGENT_TOOLS` 网络工具族，前端「内置」工具列表将正常显示。
  - 影响范围：`packages/shared/src/constants.ts`、`packages/shared/tests/constants.test.ts`、`packages/frontend/tests/store-session.test.ts`（fixture 清理）。
  - 验证：shared 全量 93 pass / 0 fail；kernel 全量 642 pass / 0 fail；frontend store-session 42 pass / 0 fail；typecheck 全绿。

### 变更

- **移除 kernel 每 15s 的诊断心跳日志**：原用于崩溃时判断卡死/OOM 的内存心跳（`[kernel] 心跳 rss=...MB heap=...MB`）每 15 秒刷一条，日常运行刷屏。按用户要求移除，诊断能力由崩溃日志（crash-logger）保留。
  - 影响范围：`packages/kernel/src/index.ts`（心跳 setInterval 与 shutdown 中的 clearInterval）。
  - 验证：kernel 全量 635 pass / 0 fail；typecheck 全绿。

### 新增

- 内核守护增强：kernel sidecar 崩溃改为无限自动重启（移除 3 次上限，固定间隔 2s）；新增端口 9778 健康探活（5s 间隔，连续 3 次失败强杀重启），覆盖「进程存活但端口不可用」场景
- Agent 自我保护提示词：系统提示词新增 self-protection 段（禁止 agent 误杀宿主 kernel / Electron 进程），主会话与子代理均注入；prompts.json schemaVersion 22 → 23（自动迁移补齐新段）

### 修复

- **文件预览窗随流式结束/折叠/组件卸载被自动关闭**：预览开关状态原来在组件本地（FilePill 的 useState + SessionView 的 previewPath），宿主组件（消息行/委派卡/轮级折叠段）随流式结束、折叠、卸载而销毁时预览窗被连带关闭。修复：预览状态提升到全局 session store（`filePreview` + `openFilePreview`/`closeFilePreview`），由 App 根常驻渲染 `FilePreviewModal`，只有用户手动关闭（✕ / ESC / 遮罩点击）才消失；FilePill 点击与 Explorer 双击统一走 `openFilePreview`。
  - 影响范围：`packages/frontend/src/store/session.ts`、新建 `packages/frontend/src/components/blocks/FilePreviewModal.tsx`、`packages/frontend/src/components/blocks/FilePill.tsx`、`packages/frontend/src/App.tsx`、`packages/frontend/src/components/SessionView.tsx`；`tests/FilePill.test.tsx` 两用例适配新架构。
  - 验证：frontend typecheck 全绿；全量 893 pass / 0 fail。

- kernel 被误杀或被安全软件终止后不再因 3 次上限而永久停摆，窗口存活期间持续自动重启
- Windows 下强杀 kernel（taskkill /F 实测 exit code=1 而非 null）也能触发自动重启：崩溃判定由「code=null」放宽为「code=0 才不重启」
- spawn 失败（bun 缺失/ENOENT）不再静默停摆：exit 与 spawn error 统一走 scheduleRespawn 重启入口
- 空 systemPrompt 的子代理也注入自我保护段（原实现空提示词时跳过注入，子代理完全无约束）

- **markdown 预览左右内间距调到 20px**：按用户要求，markdown 预览内容区左右内间距 20px（`px-5`）、上下保持 10px（`py-2.5`）；代码/图片预览维持 10px（`p-2.5`）不变。
  - 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`（markdown 分支）。
  - 验证：浏览器实测计算样式 左/右 20px、上/下 10px；FileViewer 组件测试 7 pass / 0 fail。

- **文件预览内容贴边，无内边距**：FileViewer 内容区（代码/ Markdown / 图片）原为 0 间距直接贴住弹窗边缘，视觉拥挤。修复：内容容器统一加 `p-2.5`（上下左右 10px）内间距；代码预览原有的 `p-2` 移除，避免与容器 padding 叠加成 18px。
  - 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`。
  - 验证：FileViewer 组件测试 7 pass / 0 fail；typecheck 全绿；浏览器实测 `.p-2.5` 四边计算样式均为 10px。

- **文件预览内 markdown 行高太桥**：FileViewer 的 markdown 分支未设 line-height（聊天正文气泡有内联 `lineHeight:1.55`，预览弹窗没有），且项目未装 `@tailwindcss/typography`、`prose` 类不生效 → 段落行高退回浏览器默认值，段落间无间距。修复：`styles.css` 的 `[data-testid="text-block"]` 统一补 `line-height: 1.6` 与 `p + p { margin-top: 0.5em }`（全局生效，聊天正文 / 文件预览 / 卡片 markdown 排版一致）。
  - 影响范围：`packages/frontend/src/styles.css`。
  - 验证：浏览器实测 text-block 行高 25.6px（1.6 × 16px）、段落间距 8px；FileViewer + MessageList 组件测试 82 pass / 0 fail。

- **轮级耗时注入两处边界防御**（审查后 TDD 修复）：
  1. 历史渠道 `session-history`：assistant 行缺行级 timestamp（旧 jsonl）时 `_lineTs` 为 undefined，直接相减会注入 `NaN`（前端显示「NaN 分 NaN 秒」）——`settleTurn` 增加 `Number.isFinite` 守卫，无法可靠计算时不注入，前端自然降级为无时长。
  2. 实时渠道 `agent-manager`：`agent_end` 结算后未重置 `turnUserAt`，下一无 user 轮（如 steer 触发）会误用上一轮旧值算出跨轮时长——结算后重置为 null，无 user 轮不再附加。
  - 影响范围：`packages/kernel/src/session-history.ts`、`packages/kernel/src/agent-manager.ts`；新增回归用例（缺行级 timestamp 不注入 NaN / 结算后无 user 轮不附加跨轮时长），顺手清理 agent_settled 分支重复的 `thinkingSince = null`。
  - 验证：kernel 全量 635 pass / 0 fail（含 2 个新用例）；typecheck 全绿。

---

## 2026-08-01

### 修复

- **部分轮显示「本轮时长 0 秒」**：根因是 Pi SDK 的**单块轮**（无工具调用直接回复）assistant 消息对象在 prompt 发送时**预创建**，`message.timestamp` ≈ user 时刻（实测差 38ms），真实耗时（6.3s）在 jsonl **行级落盘时刻**。此前注入用 `message.timestamp` → 单块轮时长算成 0 秒（多块轮末块恰好创建在完成前，碰巧近似正确）。修复：历史渠道 `session-history` 改用 jsonl 每行行级落盘 timestamp 计算轮耗时；实时渠道 `agent-manager` 改用 kernel 收到 user message_end 的时刻（`turnUserAt`）→ agent_end 到达时刻，与历史同语义（user 落盘 → 回复完成）。
  - 影响范围：`packages/kernel/src/session-history.ts`、`packages/kernel/src/agent-manager.ts`；测试 `session-history`（新增单块轮行级时刻回归用例）/`agent-manager`（真实时间断言）更新。
  - 验证：真实数据 71 条注入全部 >1s（0 秒消失）；用户报告的「123」会话 6325ms（修复前 38ms→0 秒）；kernel 全量 633 pass / 0 fail；typecheck 全绿。

- **历史/实时会话大量无本轮时长（渲染层合并丢字段）**：上一修复（agent_end 从 handle.messages 取起点）后后端注入/写回已正确——每轮末 assistant 带 turnElapsedMs（真实数据验证 26 个标准会话中 22 个有注入），但前端大部分轮仍显示「本轮过程」。根因：渲染层 `collapseSameTurnAssistants` 合并连续 assistant 行（一轮多条 assistant 中间隔 toolResult 时 store 不合并、由渲染层合并）**只拼接 content、不拷贝 turnElapsedMs**——合并后主消息取第一条 assistant（无该字段），轮末的时长在合并时丢失。修复：合并时补拷 turnElapsedMs（与 setMessages 合并一致）。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`（collapseSameTurnAssistants）；测试 `tests/MessageList.test.tsx`（新增「中间隔 toolResult 的多条 assistant 合并行保留时长」回归用例）。
  - 验证：浏览器实测历史会话两轮均正确显示——「本轮时长 4 分 34 秒 · 35 个步骤」「本轮时长 5 分 48 秒 · 53 个步骤」，与后端注入毫秒数（274933/348066）完全吻合；frontend 相关 150 pass / 0 fail（MessageList 75 含新用例）；typecheck 全绿。

- **实时轮没有本轮时长（很多成功会话缺失）**：根因是 `agent_end` 事件的 `messages`（Pi `newMessages`）只含本轮产生的 assistant/toolResult/steering 消息，**不含本轮最初的 user 提问**——kernel 从 `event.messages` 找 user 作起点计算耗时，无 steering 的常规轮找不到 user → 不附加 elapsedMs → 所有实时轮无时长（仅历史刷新后才有）。修复：`agent_end` 改从 `handle.messages`（message_end 时已 push 全部消息的快照）取最后 user / 最后 assistant 计算，与 `session-history` 历史注入同语义（最后 assistant.timestamp − 最后 user.timestamp）；失败回合/无 user 仍不附加。
  - 影响范围：`packages/kernel/src/agent-manager.ts`、`tests/agent-manager.test.ts`（用例改为真实场景：user 经 message_end 入 handle.messages，agent_end.messages 不含 user）。
  - 验证：agent-manager+session-history 97 pass；kernel 全量 632 pass / 0 fail；前端相关 149 pass；`typecheck` 通过。

### 新增

- **记忆写入冒烟评测脚本 `packages/kernel/scripts/eval-memory-write.ts`**（参考 `eval-delegate-trigger.ts` 子模型冒烟模式）：启动真实 pi 进程 + 真实系统提示词 + wa-pi-bridge 扩展（memory 工具注册），用 stub bridge 复用真实 amaster store 写入**隔离目录**（不污染真实记忆），验证「用户记忆（全局 USER.md）」与「项目记忆（项目 MEMORY.md）」能正确写入。用例 16 条：user 4 / project 4 / mixed 2（显式指令）+ **implicit 6（隐形记忆：用户未说「记住」但对话中自然透露偏好/身份/运行环境/项目选型/约定，agent 应自动判断并主动写入）**。判定标准：调用了 memory_add + target 路由正确 + 落盘文件存在非空。用法：`bun run scripts/eval-memory-write.ts [--sample N] [--category user,project,mixed,implicit] [--policy full|compact|none] [--model slug/id] [--mem-root path]`；默认模型优先读 `settings.json` 的 `defaultProvider/defaultModel`（对齐用户日常使用），fallback providers[0]。
  - 影响范围：`packages/kernel/scripts/eval-memory-write.ts`（新增）。
  - 验证：默认模型（deepseek）下全量 16/16 通过（含隐形记忆 6/6）；kernel typecheck 通过。

### 修复

- **日常使用不写记忆（用户记忆/项目记忆均空白）**：根因是系统提示词缺少「记忆写入策略」引导段——agent 有 `memory_add` 工具但不知道何时该主动写入，用户说「记住 X」也只回复文本、从不调用工具（实测 3/3 用例均未调用 memory_add）。修复：系统提示词新增动态段 `memory-policy`（位于 env-constraints 与 memory-snapshot 之间），按 `memoryPolicyStyle` 注入——`full` 注入完整版 `DEFAULT_MEMORY_POLICY_PROMPT`，`compact` 注入精简版 `COMPACT_MEMORY_POLICY_PROMPT`，`none` 不注入。`prompts.json` schemaVersion 21→22，`ensurePromptsConfig` 迁移逻辑改进：已存在段保留用户自定义 content、仅追加缺失段（如 memory-policy），废弃 id 丢弃；`agent-manager.ts` 的 composePrompt 注入 memoryPolicy。
  - **隐形记忆增强**：策略段明确「主动记忆」规则——不必等用户说「记住」，对话中自然透露的稳定信息应自动写入（用户偏好/身份/习惯/运行环境 → target=user；技术选型/项目约定/架构决策 → target=memory），并给出「值得记 vs 不值得记」判断标准（对未来会话仍成立的稳定事实 vs 当前任务一次性细节），减少漏写与过度写入。
  - 影响范围：`packages/kernel/src/system-prompt.ts`、`packages/kernel/src/agent-manager.ts`；测试 `tests/system-prompt.test.ts`（新增 memory-policy 渲染/顺序/空策略用例 + 迁移行为更新）。
  - 验证：修复后评测脚本默认模型下全量 16/16 通过（显式 user→USER.md、project→MEMORY.md、mixed→双写；隐形记忆 implicit 6/6 自动判断主动写入）；kernel 123 相关测试全绿；全仓 typecheck 通过。

---

## 2026-08-01

### 修复

- **ask_user_question 提交后偶发卡死（回答点提交后 UI 永久“提交中…”）**：根因两条独立缺陷——① 后端 `AskRegistry.resolve()` 对未知 `toolCallId` 静默失败（`if (!entry) return`），前端提交到达后端但无任何反馈，永远等不到 toolResult；② 前端 `handleSubmit` 用 `void api.post(...)` 无 catch，请求失败（网络/30s 超时）后 `submitting` 永久为 true。修复：`resolve()/cancel()` 返回 boolean；ws-server `agent:answer` 未命中时 reply 400 错误（前端收到即提示“提问已失效”）；`handleSubmit` 改 async + try/catch，失败恢复按钮并显示错误提示。另加 **double check 机制**：新增 `GET /api/sessions/:sessionId/asks`（返回该 session 真实 pending 的 ask toolCallId 列表，源于 `AskRegistry.pendingToolCallIds`），前端 `AskDock` 渲染时向后端核对，本地消息派生但后端已无的 ask 标 stale（显示“该提问已失效”、禁用提交），从源头避免对失效 ask 提交后卡住。
  - 影响范围：`packages/kernel/src/ask-registry.ts`、`ws-server.ts`、`routes/projects-sessions.ts`、`packages/shared/src/types.ts`（新增 SessionAsksRequest/Event）；`packages/frontend/src/components/ask/AskDock.tsx`、`AskFormCard.tsx`；测试 `tests/ask-registry.test.ts`、`tests/ws-server-ask.test.ts`（新增）、`tests/AskFormCard.test.tsx`、`tests/AskDock.test.tsx`（新增）（TDD 红→绿）。
  - 验证：kernel ask 相关 40 pass / 0 fail；frontend ask 相关 18 pass / 0 fail；shared/kernel typecheck 通过。

---

## 2026-08-01

### 修复

- **长文本流式输出过程中自动滚动中途停止（主消息列表）**：rAF 贴底循环每帧程序化设置 `el.scrollTop = el.scrollHeight`，会异步触发原生 scroll 事件（浏览器在下一帧 scroll steps 派发，早于 rAF 回调）。派发时 scrollTop 仍是上一帧贴底位置、scrollHeight 已随新 token 增长——单帧增长 ≥ `BOTTOM_THRESHOLD`(20px) 时 `isNearBottom()` 误判 false，`handleScroll` 把 `stickBottom` 置 false，effect 重跑取消 rAF 循环，自动滚动永久停止（长文本/代码块/SSE 大块到达时极易触发）。修复：`handleScroll` 不再对所有 scroll 事件一律按 `isNearBottom` 更新 `stickBottom`，改用滚动方向区分——scrollTop 减小（用户上翻，滚轮/键盘/拖拽）且明显离开底部才置 false；程序化贴底（scrollTop 增大/不变）在底部则确认 true；向下但不在底部时保持现状（不置 false），消除竞态误杀。语义不变：用户上翻不抢、回到底部恢复。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`；测试 `tests/MessageList.test.tsx`（新增 1 个回归用例：程序化贴底 scroll 事件 + 内容增长 ≥ 阈值不误判、自动滚动不中断；TDD 红→绿）。
  - 验证：真实浏览器（Chromium）独立页面复现竞态（误判一次后 scrollTop 永久停留在旧位置，内容增长到 11008px 不再跟随）→ 修复后不再出现；MessageList 相关测试 69 pass / 0 fail，typecheck 通过。

- **write 等工具卡片内部长文本预览区不自动滚动到底部**：工具参数中的长文本（write 的 `content`、edit 的 `oldText`/`newText`）以限高代码块（`max-h-60 overflow-auto`）展示，是独立于主消息列表的滚动容器，但没有任何自动滚动逻辑——流式中参数逐段增长时 pre 停在原处，看不到最新写入内容。修复：新增 `AutoScrollPre` 组件（语义与主消息列表一致：停在底部时内容增长自动跟随、上翻不抢、回到底部恢复；首次挂载停在顶部不抢），替换工具卡片所有长文本参数 `<pre>`。
  - 影响范围：`packages/frontend/src/components/blocks/ToolCallCard.tsx`；测试 `tests/ToolCallCard.test.tsx`（新增 3 个用例：流式增长跟随底部、上翻不抢、定稿首次挂载不滚；TDD 红→绿）。
  - 验证：真实浏览器验证跟随/不抢/恢复三态；ToolCallCard 7 pass / 0 fail，typecheck 通过。

---

## 2026-08-01

### 新增功能

- **轮级折叠摘要行 + 整轮耗时**：一轮 agent 调用完成后，中间过程（思考/工具调用/delegate/fleet）二次折叠为一行摘要「本轮时长 X · N 个步骤」（无时长显示「本轮过程 · N 个步骤」），点击展开可见各步骤并可再逐个展开；**只保留最后一段文本回复在外（最终回复），中间过程文字一并折叠进摘要行**。时长从消息时间戳纯读推算（最后 assistant.timestamp − user.timestamp），零写入、刷新后历史轮也能还原；仅成功完成的轮显示时长（失败回合/无 user/旧数据缺字段不显示）。**整轮结束（agent_end）才折叠——进行中的轮即使首个块已定稿也不折叠**，保持逐卡流式渲染。
  - 影响范围：`packages/shared/src/types.ts`（`AssistantMessage.turnElapsedMs?`、`SDKEvent.agent_end.elapsedMs?`）、`packages/kernel`（`session-history.ts` 按轮切分注入、`agent-manager.ts` agent_end 附加 elapsedMs）、`packages/frontend`（store agent_end 写回、`MessageList` 行级折叠、新增 `blocks/TurnSummary.tsx`）。
  - 验证：kernel session-history/agent-manager 新增用例全绿（kernel 621/621）；前端 TurnSummary/MessageList/store-session 新增用例全绿（MessageList 74/0、store-session 42/0、TurnSummary 5/0）；`typecheck` 通过。

## 2026-08-01

### 新增功能

- **FileViewer 打开 .md 文件渲染为 markdown 预览**：此前所有文本文件统一走 Prism 高亮，markdown 源文本按代码显示。本变更让 .md 文件改用 ReactMarkdown（remark-gfm）渲染，复用聊天区的 `createMarkdownComponents`——表格/标题等 GFM 语法、代码块（CodeBlockCard/MermaidBlock）、内联路径（FilePill）、外链新标签页打开全部生效；md 分支不注册 `@path:行号` copy 拦截。接受计划内风险：`FileViewer → markdown-components → FilePill → FileViewer` 循环依赖（ESM 函数声明提升 + 组件引用渲染期才访问，typecheck + 组件测试通过证明可用）。
  - 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`（新增 `sessionId` prop）；`packages/frontend/src/components/blocks/FilePill.tsx`、`packages/frontend/src/components/SessionView.tsx`（透传 `sessionId`）；测试 `packages/frontend/tests/FileViewer.test.tsx`（新增 2 个用例：md 渲染 h1/table/pre 且无 Prism 行号、内联路径渲染 FilePill，TDD 红→绿）。

### 修复

- **FileViewer md 预览流式期间全量重解析 Markdown**：md 分支每次渲染都新建 `<ReactMarkdown components={createMarkdownComponents(sessionId)}>`，react-markdown v10 无内置 memo，components 引用一变就整份重解析（上限 3MB）；FileViewer 挂在 SessionView 下，流式期间每帧重渲染 → 每帧重解析。修复：新增 memo 化 `MarkdownPreview` 子组件（只接收 content/sessionId 两个稳定 prop，不接收 onClose 等新引用），components 用 `useMemo` 按 sessionId 缓存，与聊天区 `MarkdownBlock` 做法一致。同时补组件测试：mermaid 代码块走 MermaidBlock 分支断言、非 md 路径 `[data-line]` 行号容器回归断言、循环依赖代码内注释。
  - 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`、`packages/frontend/src/components/blocks/markdown-components.tsx`（注释）；测试 `packages/frontend/tests/FileViewer.test.tsx`。

- **主 agent 调用普通工具（bash/read/edit 等）期间/工具输出到达时，页面不自动滚动到底部**：滚动 effect 的活跃信号只认 `streaming`（主流流式占位）与 `hasRunningSubagent`（子代理运行）。主 agent 调用普通工具时：toolCall block 的 `message_end` 已清空 `streaming`，工具执行期间 `tool_execution_*` 事件 store 不消费（`session.ts` default 分支），toolResult 定稿只追加 `messagesBySession`（滚动 effect 依赖不含 messages）——三个阶段都没有信号，工具输出（可能很长）到达时页面停在原位。修复：滚动 effect 的 `active` 合并 `statusBySession === "thinking"`（`agent_start`→`agent_end` 期间主 turn 进行中恒为 thinking），工具执行中 / toolResult 到达时 rAF 循环持续贴底；`agent_end` 回 idle 时走既有兜底再滚一次。该信号天然保留「非回复不抢滚动」「上翻阅读不抢」语义（非回复时 status 为 idle）。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`；测试 `tests/MessageList.test.tsx`（新增 2 个用例：thinking 中工具输出到达自动跟随滚动、thinking 中用户上翻不抢；TDD 红→绿）。

- **子代理回复过程中不自动滚动、流式结束尾部可能被裁掉**：子代理（delegate/fleet）的流式内容走 `progressByToolCall` 推送到卡片内部，不走主消息流的 `streamingBySession`，主流滚动 effect 覆盖不到——子代理回复时即使停在底部也不跟随；主流 `message_end` 时 `streaming` 清空、最后一段内容定稿进 messages，但滚动 effect 已停止，尾部可能停在视口下方。修复：①`MessageList` 增加按会话过滤的 `hasRunningSubagent` 选择器（返回布尔，running 期间不随内容更新重渲染），滚动 effect 合并主流 streaming 与子代理运行，rAF 循环每帧贴底一次（合帧）；②由运行态转为结束态时兜底再滚一次，避免尾部裁切；③session store 新增 `progressSessionByToolCall`（toolCallId → sessionId），多会话并存时子代理滚动不串扰。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/store/session.ts`；测试 `tests/MessageList.test.tsx`（新增子代理运行跟随/上翻不抢/流式结束兜底 3 个用例）。

- **子代理计时改为本地推算（当前时间 − 开始时间），完成态冻结为后端终值**：旧 `useLiveElapsed` 以最近一次推送的 `elapsedMs` 为基准、本地每秒推算，但基准更新仍依赖推送节奏。新实现：首次收到有效 `elapsedMs` 时反推子代理在本机时钟上的开始时刻 `startAt`（之后锁死），running 期间只用 `Date.now() - startAt` 推算——与 SSE 推送完全解耦，秒数天然连续、不回跳、静默期不冻结；完成（done/error）时冻结为后端终值，与后端记录一致。
  - 影响范围：`packages/frontend/src/components/blocks/useLiveElapsed.ts`（DelegateCard/FleetCard 共用）；测试 `packages/frontend/tests/DelegateCard.test.tsx`（新增“完成态冻结终值”用例，原静默期推算/不回跳用例保持通过）。

- **流式期间合并行内已定稿 text 段落每帧全量重解析 Markdown**：`CodeBlockCard` memo 已挡住代码块，但合并行里已定稿的普通 text 段每帧整段重跑 `ReactMarkdown/remarkGfm`，超长回复仍是卡顿热点。修复：text 段拆分到 block 级，新增 `MarkdownBlock`（`React.memo`），流式期间只有内容变化的流式末 block 重渲染，已定稿 block（text 引用不变）整块跳过。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`；测试 `tests/MessageList.streaming-render.test.tsx`（渲染计数断言更新：帧 1 只渲染流式新 block、帧 2 累计 +2）。

- **MessageRow 用数组 index 作 key（同 turn 合并时行数位移，展开态可能残留/丢失）**：流式结束合并、`collapseSameTurnAssistants` 会让行数变化、后续行 index 全部位移，key 复用的行可能保留/丢失展开态（如 CodeBlockCard）。修复：改用稳定 key（agentName + message timestamp），合并行沿用首条 timestamp。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`。

- **流式输出期间界面卡顿**：`streamingBySession` 每个流式帧（kernel 50ms 节流）都触发 `MessageList` 全量重渲染——所有历史消息的 `ReactMarkdown` 重新解析、`CodeBlockCard` 的 Prism 高亮重跑，且 `preprocess` 每次重建全部行对象，叠加自动滚动同帧读写 `scrollHeight/scrollTop` 造成 forced reflow。修复：①`preprocess(messages)` 加 `useMemo`（按 messages 引用缓存），历史行引用在流式期间稳定；②`MessageRow` 包 `React.memo`，历史行整行跳过重渲染，只有合并的流式末行/StreamingRow 每帧更新；③`CodeBlockCard` 包 `React.memo`（props 为字符串，流式行内已定稿代码块不再重复高亮）；④流式跟随滚动改 `requestAnimationFrame` 合帧，每帧最多一次 `scrollTop`。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/components/blocks/CodeBlockCard.tsx`；测试 `packages/frontend/tests/MessageList.streaming-render.test.tsx`（新增：流式更新时历史行 Markdown 不重解析的渲染计数回归用例）。

- **点击会话激活后列表保持原位不立即重排（避免点错感）**：上一版修复让 `selectSession` 乐观更新 `lastActivity`，列表在点击瞬间立即重排，用户视觉上像点错了会话。修复：`ProjectItem` 排序时锚定当前激活会话于上次渲染位置——点击时时间显示刷新为“刚刚”、列表不跳动；离开该会话（激活其他项目会话/刷新页面）后按新 `lastActivity` 自然重排。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`；测试 `tests/ProjectList.test.tsx`（点击保持原位 + 离开后重排两个用例，TDD 红→绿）。

- **并行委托卡片（FleetCard）同步流式回复与工具计数**：与 DelegateCard 对齐——①执行中（无 result）时各 agent 的 `progress.output` 直接在回复区用 ReactMarkdown 流式渲染（按 agent 分组、无需展开进度详情），不再藏在 `<pre>` 里等结束一次性给回；完成态仍展开才显示聚合 result。②`AgentProgressItem` 工具展示从逐条名称+状态列表改为计数「共 N 个工具 · 成功 X · 失败 Y · 执行中 Z」。
  - 影响范围：`packages/frontend/src/components/blocks/FleetCard.tsx`；测试 `packages/frontend/tests/FleetCard.test.tsx`（更新 1 个用例，TDD 红→绿）。

- **点击会话激活后列表最后时间不更新、排序不变**：`selectSession` 只设 `currentSessionId`，前端 `sessions` 数组里该会话的 `lastActivity` 保持旧值，`SessionRow` 的相对时间、`ProjectItem` 的倒序排列（以及 `topAgentsByRecency` 智能体最近使用排序）都基于过期数据。后端 ws-server 在 `session:messages` 时虽已 `touchSession` 更新磁盘，但无回传通道，运行中的 UI 永远看不到变化（刷新后才正确）。修复：`selectSession` 激活时乐观更新该会话 `lastActivity = Date.now()`，列表立即重排重渲染；后端 touchSession 继续保证磁盘一致。
  - 影响范围：`packages/frontend/src/store/projects.ts`；测试 `tests/store-projects.test.ts`（新增 selectSession 更新 lastActivity 用例）、`tests/ProjectList.test.tsx`（新增点击激活后列表重排用例，TDD 红→绿）。

- **子代理卡片计时一卡一卡（秒数回跳）**：`subagent:progress` 每次 text_delta/工具事件都推送 `elapsedMs`，它是后端发出时刻的真实流逝值，经 SSE 到前端已滞后（传输延迟）。旧 `useLiveElapsed` 在事件到达时直接 `setDisplay(elapsedMs)`，而本地 interval 已按前端时钟推算（系统性超前），滞后推送值会把已显示的秒数拉回（如 2s → 1s）；同时 interval 依赖 `elapsedMs` 数值，高频事件反复重建定时器，本地推算不稳。修复：推送值只更新基准 ref、不直接覆盖显示，显示始终由本地推算驱动（单调不回退）；interval 只依赖 `running`（及 elapsedMs 从无到有），高频事件不重建定时器。
  - 影响范围：`packages/frontend/src/components/blocks/useLiveElapsed.ts`（DelegateCard/FleetCard 共用）；测试 `packages/frontend/tests/DelegateCard.test.tsx`（新增“滞后推送不回跳”用例，TDD 红灯→绿灯；原“静默期不冻结”用例保持通过）。

- **委托卡片：子代理回复改为流式输出，工具调用只显示计数**：此前 DelegateCard 的执行中 output 只在展开进度详情时以 `<pre>` 展示，最终回复要等子代理 `agent_settled` 后随 toolResult 一次性到达。修复：执行中（无 result）时把 `progress.output`（kernel 每次 text_delta 推送的累积文本）直接在回复区用 ReactMarkdown 流式渲染，与主代理回复体验一致；完成态仍展开才显示最终 result。工具展示从逐条名称+状态列表改为摘要计数「共 N 个工具 · 成功 X · 失败 Y · 执行中 Z」。
  - 影响范围：`packages/frontend/src/components/blocks/DelegateCard.tsx`；测试 `packages/frontend/tests/DelegateCard.test.tsx`（更新 2 个用例，TDD 红→绿）。

- **子代理回复中预览窗口透明（muted 卡 opacity 泄漏）**：`ProcessCard` muted 时对整个子树 `opacity-55`，而 `Modal` 未走 portal、DOM 嵌套在卡片内，导致从委托/并行卡内点开的文件预览窗口（遮罩+内容）整体以 55% 不透明度渲染；主代理气泡无 opacity 故不受影响。修复：`FilePill` 的预览 `Modal` 改用 `createPortal` 渲染到 `document.body`，脱离父容器 opacity stacking context，任何容器内弹出的预览窗口均保持不透明。
  - 影响范围：`packages/frontend/src/components/blocks/FilePill.tsx`；测试 `packages/frontend/tests/FilePill.test.tsx`（新增 portal 到 body 用例）。

- **预览区（markdown 渲染）里的链接点击后当前页面跳转，改为新标签页打开 + 蓝色下划线样式**：所有 `ReactMarkdown` 渲染点都未自定义 `a` 标签，`react-markdown` 默认渲染 `<a href>` 不带 `target`，点击外部链接时浏览器在当前标签页导航，SPA 页面被替换；且链接无视觉样式，看不出可点击。修复：`createMarkdownComponents` 新增 `a` 映射并导出 `MarkdownLink`（`target="_blank" rel="noopener noreferrer"` + `text-accent underline` 蓝色下划线样式）复用，主聊天区 / fleet / delegate 卡片随组件映射一并修复；ask 选项 preview 区域的 `<ReactMarkdown>` 显式传入 `components={{ a: MarkdownLink }}`。
  - 影响范围：`packages/frontend/src/components/blocks/markdown-components.tsx`、`packages/frontend/src/components/ask/AskFormCard.tsx`；测试 `tests/blocks/markdown-links.test.tsx`（新增新标签页 + 样式用例）、`tests/AskFormCard.test.tsx`（新增 preview 链接用例，TDD 红灯→绿灯）。

---

## 2026-08-01

### 修复

- **点击折叠状态的项目不再需要两次：一次点击同时跳转新建会话并展开会话列表**：此前点击项目名时，折叠的项目第一次点击只跳转新建会话、列表仍收着，需再点一次（此时已进入新会话界面且项目选中）才展开。修复：`ProjectItem` 点击逻辑改为折叠优先——项目处于折叠状态时，一次点击同时 `setExpanded(true)` 展开列表并 `onSelectProject` 跳转新建会话；已展开时保持原行为（新会话界面且选中才展开/折叠，否则跳转新建会话）。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`；测试 `packages/frontend/tests/ProjectList.test.tsx`（新增 2 个折叠优先用例，TDD 红灯→绿灯）。

- **切换几个会话后模型自动被重置为列表第一个**：根因是冷加载竞态——本次启动首次切到某个会话时，`loadSession`（IndexedDB 异步读）完成前 `bySession` 无缓存 → Composer 传入 `model=null` → `ModelSelector` 的 auto-select 立即把**列表第一个模型**经 `setSessionPrefs` 写入该会话 prefs（覆盖 DB 存储值）并同步污染全局 `defaults.model`；`loadSession` 完成时因有"不覆盖已有 prefs"守卫反而保住了污染值。每首次访问一个会话就被污染一次，切几个后全部坍缩成第一个模型。修复：store 新增 `loadedBySession` 跟踪，`Composer` 在会话 prefs 加载完成前经 `ComposerInput` → `ModelSelector` 新增 `autoSelectEnabled={false}` 门控禁止 auto-select；加载完成后恢复（全新会话无 model 时 auto-select 职责不变）。已做 TDD 红线验证：门控关闭时新回归用例稳定复现污染，开启后通过。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/components/ui/ModelSelector.tsx`；测试 `tests/composer-prefs.test.ts`（loaded 标记）、`tests/ModelSelector.test.tsx`（门控用例）、`tests/Composer.test.tsx`（冷加载切换回归）。

---

## 2026-08-01

### 修复

- **打包脚本镜像环境变量不生效，electron-builder 回退 GitHub 下载 ETIMEDOUT**：`build.ts` 顶部用 `process.env.ELECTRON_MIRROR ??= …` 设置 npmmirror 镜像，但 Bun(Windows) 的 `spawnSync` 不继承进程启动后新设置的 env（实测子进程 `cmd /c echo %VAR%` 打印字面量），electron-builder 收不到镜像变量仍直连 GitHub（20.205.243.166）下载 Electron 二进制超时。修复：`run()` 的 `spawnSync` 显式传 `env: { ...process.env }`。
  - 影响范围：`packages/desktop/scripts/build.ts`。
  - 验证：修复前 `bun run pack:win` 在步骤 2 ETIMEDOUT；修复后同命令全流程出包成功。

- **Review 修复：幽灵扫描数据目录正则缺结尾边界，同前缀兄弟目录进程会被误杀**：`dirToRegExp` 生成的正则在最后一个路径段后无边界约束，数据目录为 `C:\wa-pi-ghost` 时，`C:\wa-pi-ghost2` / `.wa-pi-backup` 等同前缀兄弟目录的进程会被误判为 seed 并连同子孙链 `taskkill /T /F` 杀掉。修复：正则末尾加边界断言 `(?=$|[\\/])`（下一段必须是路径分隔符或结尾）。
  - 影响范围：`packages/desktop/src/util/port.cjs`、`packages/desktop/tests/port.cjs.test.ts`（新增同前缀兄弟目录不误杀用例，desktop 32 测试全绿）。

- **Review 修复：edit 卡片遇畸形/流式截断参数渲染崩溃**：`EditArgsView` 假设 `edits` 元素必为 `{oldText?, newText?}` 字符串形状，而工具参数来自 LLM 输出，流式中可能是截断/部分解析的 JSON（如 `edits: [null]`、`oldText` 为对象），访问 `e.oldText` 直接 TypeError、非字符串值触发 React "Objects are not valid as a React child"——单张卡片问题升级为整个消息列表渲染崩溃。修复：渲染前校验 edits 形状，不符时降级到对任意输入安全的通用参数视图。
  - 影响范围：`packages/frontend/src/components/blocks/ToolCallCard.tsx`、`packages/frontend/tests/ToolCallCard.test.tsx`（新增畸形参数降级用例）。

---

## 2026-08-01

### 修复

- **子代理运行卡片计时静态不更新**：DelegateCard/FleetCard 纯订阅渲染后端推送的 `elapsedMs`，而 `subagent-runner` 只在工具开始/结束和 text_delta 时发 progress（thinking delta 不计），子代理进入思考阶段或长工具静默执行期时无事件 → 计时冻结在最后一次推送值。修复：新增 `useLiveElapsed` hook——running 期间以最近一次推送的 `elapsedMs` 为基准、本地每秒推算流逝时间，计时连续递增；done/error 后冻结为后端终值。FleetCard 抽 `AgentProgressItem` 子组件承载 hook（多 agent 各自独立计时）。与既有 `ThinkingTimer`/录音计时模式一致，不改后端推送频率。
  - 影响范围：`packages/frontend/src/components/blocks/useLiveElapsed.ts`（新增）、`DelegateCard.tsx`、`FleetCard.tsx`、`tests/DelegateCard.test.tsx`、`tests/FleetCard.test.tsx`（各新增静默期计时递增用例）。
  - 验证：DelegateCard + FleetCard 26 测试全绿、frontend `typecheck` 通过。

---

## 2026-08-01

### 修复

- **工具调用卡片参数渲染：edit 大段代码不再以 JSON 转义糊成一坨，代码块带行号且完整展示**：`ToolCallCard` 展开区此前用 `JSON.stringify(toolCall.arguments, null, 2)` 直接渲染，edit 等携带大段代码参数的工具（oldText/newText 含真实换行/制表符）会被重新转义成 `\n`/`\t` 字面字符，一长串不可读。修复：①edit 工具走专用参数视图——标题显示文件路径 `path`，展开区以带行号的代码块（真实换行缩进、不设高度限制完整展示）呈现新旧内容，兼容 `edits` 数组与平铺两种参数结构；②其他工具走美化后的 JSON 视图——递归渲染参数，多行/长字符串（>60 字符）以带行号的真实文本代码块展示，其余保持 JSON 风格；标题截断逻辑（formatArgs）不变。行号右对齐固定列宽、可选中禁用；去掉原限高 240px 滚动（完整可读）；write 等工具流式长文本仍保留 AutoScrollPre 自动滚动语义。
  - 影响范围：`packages/frontend/src/components/blocks/ToolCallCard.tsx`（新增 `LineNumberedLines` 行号渲染）、`packages/frontend/tests/ToolCallCard.test.tsx`（组件测试：edit 真实代码展示 / 通用长字符串美化 / edit 平铺结构兼容 / 畸形 edits 降级 / 行号递增 / 无限高 / write 自动滚动 3 例）。
  - 验证：ToolCallCard 9 测试全绿，ToolCallCard+MessageList 组合 80 测试全绿，改动文件 `typecheck` 通过；DelegateCard/FleetCard 既有 3 个失败与 MessageList.tsx typecheck 错误为工作区其他进行中改动引入的预先存在问题，与本次改动无关（stash 验证）。

- **delegate 报「bridge 空闲超时 (600000ms 无任何帧)」误杀正常工作的子代理**：昨日空闲超时修复暴露了一个真实静默场景——子代理（deepseek-v4-flash 推理模型，跟随主模型）在长推理阶段只产出 thinking、或慢首 token、或单个长工具调用时，`runSubagentAgent` 只在 tool_execution_start/end 和 text_delta 时发 progress（thinking delta 不计），kernel 侧长时间零帧写出，pi 侧 bridge 空闲超时（600s 无帧）于是误杀。实测案例：代码审查 delegate 00:13:23 发起，600s 零帧后被判死，而子代理可能仍在正常工作。修复：`handleBridgeStream` 在流式执行期间每 15s 写一个 `ping` 心跳帧（无业务含义，消费方忽略但会刷新空闲超时），协议类型 `BridgeStreamFrame` 增加 `ping` 变体。修复后空闲超时只在 kernel 真正卡死（连心跳都写不出）时才触发。
  - 影响范围：`packages/kernel/src/bridge-registry.ts`（心跳定时器 + `heartbeatMs` 测试注入）、`packages/shared/src/types.ts`（`ping` 帧类型）、`packages/kernel/src/wa-pi-bridge.extension.ts`（注释同步，解析逻辑本就跳过非 final 帧无需改动）、`packages/kernel/tests/bridge.test.ts`（新增心跳用例，kernel 616 测试全绿）。

---

## 2026-08-01

### 修复

- **端口 9778 幽灵占用致「重启应用」死循环**：根因是 Bun 的监听 socket 句柄在 Windows 上可继承——kernel/pi 被杀后，存活的子孙进程（pi 子代理、agent 起的后台进程）仍持有继承的 socket，netstat 显示 LISTENING 归属一个已死的 PID（实测 PID 30000 不存在但端口仍被占）。`killPortOccupants` 只会 taskkill netstat 给的（死）PID，杀完端口未释放 → relaunch 回来还是占用 → 无限循环。修复：①taskkill 加 `/T` 连带进程树（子进程持继承句柄时只杀父进程端口不释放），并校验退出码——权限不足/死 PID 不再静默视为成功，失败 PID 与最终端口占用结果一并输出日志；②taskkill 后短轮询（3×200ms，新导出 `waitPortReleased`）确认端口仍占用，才回退 PowerShell 幽灵扫描——按「数据目录特征种子 + 进程树子孙链」圈定我方残留进程：种子要求命令行含本机 wa-pi 数据目录路径（`WA_PI_DIR` 或 `~/.wa-pi`），再沿进程树 BFS 纳入无特征后代（cmd/bun shim、子代理起的后台命令——幽灵 socket 句柄常捏在这类进程手里），显式排除自身进程，被杀 PID 连同命令行摘要经注入的 logFn 落 `logs/desktop.log`；③清理后仍占用（无我方特征的第三方进程持有）时诚实提示「自动清理失败，请手动结束 bun/wa-pi 进程或重启电脑」，不再盲目 relaunch。端口固定不可后移（前端 IndexedDB origin 绑定端口），故不做动态端口兜底。
  - 影响范围：`packages/desktop/src/util/port.cjs`（killPortOccupants 改 async + 幽灵回退扫描 + waitPortReleased）、`packages/desktop/src/main.cjs`（重启前验证端口释放、传入 logFn）、`packages/desktop/tests/port.cjs.test.ts`（新增幽灵回退/误杀防护/子孙链/taskkill 失败/waitPortReleased 用例）。已经真机端到端验证：构造幽灵占用（父死子存）→ 真实 `killPortOccupants` 清理 → 端口释放。
  - 注：句柄可继承本身是 Bun 上游行为，本修复为防御/清理层；若 Bun 后续版本修正（socket 默认不可继承），本逻辑自动退化为空操作。

---

## 2026-07-31

### 修复

- **bridge `timeout:false` 后省略 timeoutMs 将永久挂起**：`callBridge` 的 `timeoutMs` 此前可选且省略时不挂任何计时器——Bun 300s 原生硬超时被 `timeout:false` 关掉后，未来新增工具忘传 timeoutMs 会在 kernel 无响应时永久挂起。改为默认 `DEFAULT_TIMEOUT_MS`（60s 空闲兜底），`<= 0` 保留为显式关闭的逃生门。新增用例：源码变换模拟忘传场景，断言按默认值判死报「空闲超时」。
  - 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`、`packages/kernel/tests/bridge-extension.test.ts`。
  - 验证：kernel 全量 617 pass / 0 fail；`typecheck` 通过。**需重启 kernel 生效**（bridge 扩展在 kernel 启动时复制到 `~/.wa-pi/.generated/`）。

- **delegate/fleet 超 5 分钟必报「bridge 调用失败: The operation timed out.」**：根因不在下午的流式改造——pi 进程运行在 Bun 上，Bun 原生 `fetch` 有 300s 硬超时（`TimeoutError` code 23，与 signal 无关、无法被 AbortSignal 或数值 timeout 延长；Bun 1.3.14 实证 300.6s 触发，会话日志实测 delegate 298s 阵亡）。下午加的 600s 自定义计时器根本轮不到生效。修复：①bridge fetch 加 Bun 专属 `timeout: false` 关闭原生超时（Node/undici 忽略该选项）；②自定义超时改为真·空闲语义——原实现是一次性绝对计时（注释声称"无帧才判死"但代码不刷新），现每收到一个数据块即重置，持续有进度帧的长跑子代理不再被掐断。
  - 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`、`packages/kernel/tests/bridge-extension.test.ts`（新增 timeout:false 断言 + 空闲刷新/空闲判死两个语义用例，kernel 615 测试全绿）。**需重启 kernel 生效**（bridge 扩展在 kernel 启动时复制到 `~/.wa-pi/.generated/`）。

- **停止消息触发内核异常（unhandledRejection：Controller is already closed）**：`/bridge/tool` 流式分支（delegate/fleet NDJSON 流）在消费方中断后未防护——用户停止消息时 pi 侧 abort fetch，Bun cancel 服务端 ReadableStream，但子代理仍在跑并继续产出 progress，`controllerRef.enqueue()` 对已关闭 controller 同步抛 `Invalid state: Controller is already closed`，沿子代理 stdout 回调链冒泡成 unhandledRejection 广播「内核异常」。修复：流增加 `cancel()` 回调与 `closed` 标记，`enqueue`/`close` 收敛为带防护的 `writeLine`/`closeStream`（closed 后跳过 + try 兜底）。
  - 影响范围：`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/bridge.test.ts`（新增「消费方中断后继续 progress/final 不抛 unhandledRejection」回归用例）。

- **kernel 测试污染真实数据目录致线上 Model not found**：`ensureProviderExtensionRegistered` 此前只能写编译期常量 `GENERATED_DIR`（`~/.wa-pi/.generated`），`ws-provider-dirty.test.ts` 的 provider:delete 用例经真实 WSServer 处理器把空壳 extension 写进真实目录，`provider-extension.test.ts` 两个用例也会写/删真实文件——本地跑测试即清空线上 provider 注册，发消息报 `Model not found: <slug>/<model>`。修复：函数新增可选 `generatedDir` 参数（默认 `GENERATED_DIR`），`WSServerOpts` 新增同名透传，相关测试全部改用临时目录。
  - 影响范围：`packages/kernel/src/provider-extension.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/provider-extension.test.ts`、`packages/kernel/tests/ws-provider-dirty.test.ts`。

- **composer 片段附件 reload 后丢失（hydration 竞态）**：根因是 `loadSession` 为异步且 React 子组件 effect 先于父组件执行——Composer 挂载时 ModelSelector 的 auto-select 甚至早于 `loadSession` 发起即触发 `setSessionPrefs({model})`，用 `attachments: []` 初始值覆写 IDB 已存记录；随后 `loadSession` 的 existing 守卫整体跳过恢复，附件/thinking 永久丢失。修复：composer-prefs 增加会话级 hydration 守卫（`loadedSessions` + `gapWrites`）——会话完成首次 `loadSession` 前写入只更新内存并记录显式字段、不写 IDB；`loadSession` 完成时按字段合并（gap 显式字段胜出、未触碰字段以持久层为准）后统一持久化。NewSessionPane 草稿会话同步补上 `loadSession` 调用（守卫前提 + 顺带修复草稿附件 reload 后无人读取的问题）。与 `loadedBySession` 门控（autoSelectEnabled）互补：UI 层禁止加载完成前 auto-select，store 层兜住一切过早写入。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`（守卫 + 合并逻辑）、`packages/frontend/src/components/NewSessionPane.tsx`（草稿会话 loadSession）、`packages/frontend/tests/composer-prefs.test.ts`（新增 2 个竞态复现用例：loadSession 进行中 / auto-select 先于 loadSession 发起）
  - 验证：TDD（两用例先按预期失败再转绿）；composer-prefs 14 pass；前端全量 826 pass / 0 fail；typecheck 通过；E2E composer.spec 4/4 通过（含原失败的「片段附件发送流程」）

### 修复

- **E2E settings-provider 卡片定位 strict 冲突修复**：「快捷选择预设填充表单并保存」用例保存后按模型名 `deepseek-v4-flash` 定位新增卡片，与 chat-blocks.spec 注入的 DeepSeek 卡片撞出 2 个元素（strict mode violation）；改为按唯一 provider 名 "E2E Preset Provider" 定位。同时把 e2e/helpers.ts 的 pollUntil 默认超时 5s → 10s（全量跑时遗留假 provider 会话拖慢 kernel，createProject 轮询 5s 偶发不够）。另对全量 E2E 失败做了根因排查：rpc-session 为隔离环境缺 deepseek 凭证（不硬修），agents#7（agent_missing 弹窗不弹出）与 composer 片段附件（reload 后附件丢失）定位为 kernel/frontend 业务层真 bug，仅报告未改 src。
  - 影响范围：`packages/frontend/e2e/settings-provider.spec.ts`、`packages/frontend/e2e/helpers.ts`。

### 修复

- **E2E 稳定性修复（共享 kernel 下各 spec 互相干扰）**：①composer.spec 预置 provider 显式指定唯一 slug/name（`e2e-composer` / "E2E Composer"）——此前多 spec 都建名为 "E2E" 的 provider，name 派生 slug 撞车加后缀（e2e-2/e2e-3…），导致 selectOption 按 label 选中别家 option；②settings-provider.spec 适配预设选择 UI 改版（preset-select 下拉 → preset-search 搜索 + preset-option 列表），模型添加快捷搜索 `deepseek-v4-flash`（pi-ai 0.83 目录已无旧 deepseek-chat），供应商名改唯一避免与其他 spec 的 DeepSeek 卡片 strict 冲突；③quick-invoke.spec 流式搜索 30 结果超时 10s → 20s（全量跑时遗留假 provider 会话拖慢 kernel 文件搜索）；④skills.spec 适配技能目录默认展开（去掉 toggle 点击）；⑤chat-blocks.spec 移除已下线的「复制路径」按钮断言。
  - 影响范围：`packages/frontend/e2e/`（chat-blocks / composer / quick-invoke / settings-provider / skills 共 5 个 spec）。

- **E2E 测试稳定性改造（kernel 去 WS 化适配）**：①E2E 隔离目录从 `randomUUID()` 改为固定 `~/.wa-pi-e2e`（可用 `WA_PI_E2E_DIR` 覆盖）——原方案下 globalSetup 与各 worker 进程各自加载 config 拿到不同目录，曾导致 session-history ENOENT projects.json；②globalSetup 开头清空重建隔离目录，探活从 WebSocket 改为 HTTP `GET /api/projects`；③新增 `e2e/helpers.ts` REST 辅助层替代旧 spec 的 WS 命令/广播应答模式（写操作走 REST，结果对象用 pollUntil 轮询 GET 端点）；④`workers: 1` 串行执行——所有 spec 共享同一隔离 kernel，SSE 广播会让并行 worker 页面互相干扰。
  - 影响范围：`packages/frontend/playwright.config.ts`、`packages/frontend/e2e/global-setup.ts`、`packages/frontend/e2e/helpers.ts`（新增）及全部 e2e spec。

- **会话标题误用角色名，且兜底创建的会话标题不被更新**：根因有两处。①`agent-manager.ts` 的 `getCommands` 兜底分支创建会话时用 `title: agentName`（角色名）做标题——此时还没有用户消息，但角色名会固化成标题不再更新；②`ws-server.ts` 的 `agent:prompt` 只在新建会话时设标题（`event.text.slice(0,20)`），已有会话（含兜底创建的空/角色名标题）发首条消息时不更新。修复：①兜底创建改用空标题占位（不再用 agentName）；②新增 `fillSessionTitleIfEmpty` 方法，每次发送消息时检查标题，为空则用消息内容前 20 字符填充并广播 `projects:list` 刷新侧栏；已有标题（用户手动命名或已填充）不覆盖。
  - 影响范围：`packages/kernel/src/agent-manager.ts`（兜底 createSession title: agentName → ""）、`packages/kernel/src/project-store.ts`（新增 fillSessionTitleIfEmpty）、`packages/kernel/src/ws-server.ts`（agent:prompt 非 isNew 分支调用 fillSessionTitleIfEmpty）、`packages/kernel/tests/project-store.test.ts`（新增 3 个用例：空标题填充 / 已有标题不覆盖 / 会话不存在）
  - 验证：`bun test` project-store 16 pass；kernel 全量 602 pass；`typecheck` 通过。

- **重发失败消息后刷新页面出现多条重复发送记录**：根因是 pi 把每次 prompt（无论成败）都 append 进 jsonl，重发失败消息时前端只裁了内存（truncate）但 jsonl 原文不动，刷新后从 jsonl 加载就出现多条相同的 user 发送记录。修复：在 `readSessionHistory` 读出历史时新增 `dedupeConsecutiveFailedTurns` 失败回合去重——连续的「user + error assistant」失败对，若下一对是相同文本的重发，则折叠前面那组。既消除重发堆积，又保留：①最后一组失败回合（fatal error 需提示用户改配置）；②连续失败后成功的场景（前面失败组折叠，只剩成功回合）；③非连续不同问题的失败（各自保留）。JSONL 原文不动，仅展示层去重。
  - 影响范围：`packages/kernel/src/session-history.ts`（新增 dedupeConsecutiveFailedTurns + userText + isFailedTurnStart/isFailedAssistant）、`packages/kernel/tests/session-history.test.ts`（新增 4 个去重用例：连续失败去重 / 失败后成功 / 非连续保留 / 单次保留）
  - 验证：用真实会话 jsonl（3 组失败回合）端到端验证去重；kernel 全量 `bun test` 596 pass；`typecheck` 通过。

- **404 确定性错误被误分类为 transient，导致误导性"模型连接异常"状态条 + 卡 loading**：根因是 `sdk-errors.ts` 的 transient 正则用了宽泛的 `5\d\d` 匹配 5xx 状态码，而 404 错误页 HTML（provider 返回的网站页面）里含任意三位数（如像素宽度 "563"）会被误命中；同时 FATAL 正则只覆盖 401/403，漏了 404。结果确定性失败（404 模型/路径不存在）被当成网络重试，既显示误导文案（检查网络）又不结束当前轮次（loading 不消失）。修复：①transient 的 `5\d\d` 收紧为精确 `500|502|503|504|524`，对齐 pi-ai 0.83.0 retry.js 的做法；②FATAL 增加 `404`；③新增 `sanitizeErrorMessage` 清洗 HTML 错误页——provider baseUrl 错误时返回整页 HTML，原样贴到会话流不可读，现提取 HTTP 状态码映射到预设通用提示枚举（如 404 → "接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID"），未枚举的状态码按段位给通用提示（4xx → "请求错误（NNN），请检查请求参数或 Provider 配置"；5xx → "服务端错误（NNN），请稍后重试"），非 HTML 文案原样保留。现在 404 走 fatal 分支 → 清晰的红色错误消息 + 正常结束 loading。
  - 影响范围：`packages/kernel/src/sdk-errors.ts`（TRANSIENT_ERROR_PATTERN 收紧、FATAL_ERROR_PATTERN 加 404、新增 HTTP_STATUS_HINTS 枚举 + sanitizeErrorMessage 含段位兜底）、`packages/kernel/tests/sdk-errors.test.ts`（新增 404 HTML 回归用例 + 明文 500 仍 transient 用例 + HTML 映射枚举用例 + 未枚举 4xx/5xx 段位兜底用例）
  - 验证：用真实 opencode-go provider 404 响应端到端验证分类为 fatal + message 映射到通用提示；`bun test` sdk-errors 33 pass；kernel `typecheck` 通过。

- **预设 provider 保存后报 `Model not found`**：根因是 slug 派生不一致——pi 内置 provider id 是 `opencode-go`，但前端"快捷选择"只把预设的显示名（`OpenCode Zen Go`）填入表单，丢弃了 key（`opencode-go`）。保存后 `slugifyProviderName("OpenCode Zen Go")` → slug `opencode-zen-go`，extension 注册了一个与内置**不同名**的 provider，发消息时 `setModel("opencode-zen-go", ...)` 在 pi 的 `getAvailable()` 里找不到（内置那个叫 `opencode-go` 且无 apiKey），报 `Model not found`。修复：`ModelProvider` 加可选 `slug` 字段；选预设时存 `preset.key`（对齐内置 provider id），extension 注册会**增强**内置 provider（补 apiKey）而非另起一个；非预设/旧数据 slug 为空，fallback 到现有 name 派生（完全向后兼容）。新增 `resolveProviderSlug(provider, usedSlugs)` 统一替换全链路 6 处 slug 派生点。
  - 影响范围：`packages/shared/src/providers.ts`（加 `ModelProvider.slug?` 字段 + `resolveProviderSlug` 纯函数 + `isModelAvailable` 内部改用它）、`packages/kernel/src/provider-extension.ts`（`slugifyProviders` 改用 `resolveProviderSlug`）、`packages/frontend/src/components/settings/ProviderFormModal.tsx`（选预设时 `setSlug(preset.key)` + 保存写入 slug + 编辑模式预填）、`packages/frontend/src/components/ui/ModelSelector.tsx`、`SessionView.tsx`、`AgentConfig.tsx`（3 处 slug 派生改用 `resolveProviderSlug`）
  - 验证：TDD 推进，shared 23 pass / kernel provider-extension 16 pass / frontend ProviderFormModal 23 pass + ModelSelector 9 pass，全绿；旧数据无 slug 字段走 fallback，行为不变。

- **`ws-extension-skill-refresh` SSE 测试随机超时失败**：根因是测试竞态，非 flaky。`ReadableStream.start`（把 write 函数注册到 `SseBus`）是惰性触发的——只有消费者开始 `read()` 时才执行。测试 `connectSse` 拿到 reader 后立即发 HTTP 请求触发 `broadcast skill:changed`，此时 `start` 可能尚未执行、`bus.clients` 仍为空，事件被永久丢弃（SSE 无缓冲、无重放），导致 `waitForSseEvent` 3 秒超时。失败用例每次不同（install/uninstall/upgrade/toggle 随机中招）正是此机制。修复：`connectSse` 返回前先 `await reader.read()` 消费首帧（`: connected` 注释），强制触发 `start → bus.add(write)`，确保后续广播能送达。连跑 8 次全绿。
  - 影响范围：`packages/kernel/tests/ws-extension-skill-refresh.test.ts`（`connectSse` 加首读预热）

### 重构

- **移除 agent 的 `systemPromptMode`（append/replace）配置**：角色提示词正文（systemPromptBody）非空时统一替换默认 base 提示词，不再支持"追加"模式，简化配置心智。前端 AgentConfig 的"模式"切换按钮同步删除。
  - 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/subagent-runner.ts`（`WaPiSpawnConfig` 去掉 systemPromptMode 字段）、`packages/frontend/src/components/AgentConfig.tsx`、kernel 相关测试（agent-md/config-store/delegate-tool/subagent-runner）。
  - 验证：kernel 全量 611 pass / 0 fail；前端 825 pass / 0 fail；`typecheck` 通过。

### 变更

- **升级 `@earendil-works/pi-coding-agent` / `pi-ai` 0.82.1 → 0.83.0**：同步上游 0.83.0 发布（TypeBox 1.3.7、OAuth 提前刷新、流式 stop reason 透传等）。核查后确认：①TypeBox 移除的 `Type.Base`/`Type.Promise` 等废弃 API 本项目扩展代码（`wa-pi-bridge.extension.ts`、`amaster-memory.ts`、`tool-schemas.ts`）均未使用，无影响；②0.83.0 的 `pending` stop reason 不进入 `message_end` 事件，项目 `stopReason === "error"` 错误兜底管线（`sdk-errors.ts`/`session-history.ts`）判定逻辑与上游一致，不受影响；③0.83.0 **未修复** RPC 模式 `ctx.ui.custom()` 静默 no-op 导致会话挂起的问题（`custom()` 仍是 `return undefined`），原 patch 逻辑仍需保留，已用 `bun patch` 针对 0.83.0 dist 重新生成 patch（行号/hash 变更，逻辑不变：同步抛 `PI_TUI_ONLY` + agent-session catch 识别降级为普通 prompt）。
  - 影响范围：`packages/kernel/package.json`（`^0.82.1` → `^0.83.0`）、`package.json`（`patchedDependencies` key 版本号同步 0.82.1→0.83.0）、`patches/@earendil-works%2Fpi-coding-agent@0.83.0.patch`（新增，替换旧 0.82.1 patch）
  - 验证：四包 `typecheck` 全绿；`bun test` kernel 584 pass / shared 92 pass / frontend 单文件跑全绿（全量并发 flaky 与升级无关，属历史遗留 happy-dom 并发竞争）。

- **移除角色「提示词模式」（systemPromptMode）字段**：角色设置里的提示词模式原本有「替换/追加」两个选项，现在彻底移除该字段，全系统恒为「替换」语义——有 `systemPromptBody`（agent.md 正文）时替代默认 base 提示词，无则用默认。字段从 `AgentConfig` 类型、agent.md 解析/序列化、校验、UI、subagent 运行时全部删除。旧 agent.md 文件里残留的 `systemPromptMode:` 行在解析时被静默忽略（不报错），向后兼容。
  - 影响范围：`packages/shared/src/types.ts`（删 `AgentConfig.systemPromptMode`）、`packages/kernel/src/agent-md.ts`（删读取/写出/校验/默认）、`packages/kernel/src/agent-manager.ts`（删内置与命名 subagent 构造里的赋值 + 简化 prompt 组合逻辑）、`packages/kernel/src/subagent-runner.ts`（删 `WaPiSpawnConfig.systemPromptMode`）、`packages/frontend/src/components/AgentConfig.tsx`（删内置 draft 赋值 + 删「模式」UI 行）、相关测试 fixture 与用例同步清理
  - 验证：三包 `typecheck` 通过；`bun test` shared 87 pass / kernel 580 pass / frontend 806 pass，全绿。

- **首次录音默认音源改为系统音频**：原默认为麦克风（mic）。将首次录音（localStorage 无 `wa-pi:recording-prefs` 偏好记录时）的回落默认值从 `mic` 改为 `system`（系统音频）。已录过音的老用户不受影响（localStorage 有上次音源记录，优先用该值）。改动两处硬编码初始值：`RecordButton` 组件本地 state 初始值（挂载后仍会被 localStorage 真实偏好覆盖）、`useRecordingStore` 初始 `source`。系统音频的 Electron loopback 能力早已就绪，无需新增 desktop 代码。
  - 影响范围：`packages/frontend/src/components/ui/RecordButton.tsx`（`useState` 初始值 mic→system）、`packages/frontend/src/store/recording.ts`（store 初始 `source` mic→system）、`packages/frontend/tests/RecordButton.test.tsx`（更新过时标题 + 新增首次默认 system 用例）

### 新增功能

- **流式 bridge + 子代理进度直推前端**：根治子代理委托执行超 5 分钟被 undici idle timeout 砍断的问题（现象：`bridge 调用失败: The operation timed out.`）。根因是 `pi` rpc 进程启动时把全局 undici `headersTimeout`/`bodyTimeout` 设为 5 分钟（`http-dispatcher.js` 的 `DEFAULT_HTTP_IDLE_TIMEOUT_MS=300_000`），而 delegate/fleet 的 bridge 是一次性阻塞 fetch，子代理执行期间无字节流动即被判死。
  - 方案：把 delegate/fleet 的 bridge 改成 NDJSON 流式协议（started→progress→final 三帧），kernel 端点先 return 流式 Response、后台边跑子代理边 flush 进度帧，持续重置 idle timeout；同时接通 `agent-manager.ts` 断点闲置的 `SubagentProgressEvent` 管道，进度经新增的 `onSubagentProgress` 回调 + SSE `subagent:progress` 事件直推前端。
  - 前端体验：DelegateCard/FleetCard 全生命周期默认折叠，只露摘要（状态/耗时/工具数），展开看实时 output 和工具时间线；FleetCard 按 agent 分组。
  - 影响范围：`packages/shared/src/types.ts`（新增 `SubagentProgressEvent`/`BridgeStreamFrame`/`SubagentProgressServerEvent`）、`packages/kernel`（`bridge-registry`/`agent-manager`/`ws-server`/`delegate-tool`/`subagent-runner`/`index`/`wa-pi-bridge.extension`）、`packages/frontend`（`store/session`、`App`、`DelegateCard`、`FleetCard`）。
  - 验证：kernel 全量 611 pass / 0 fail；前端本特性相关 DelegateCard+FleetCard+session-progress 共 24 pass / 0 fail（前端全量里的 mermaid/filepicker 等失败为历史既存 happy-dom 并发 flaky，与本特性无关）。

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

- **历史消息中 `/skill:技能名` 纯文本未渲染为技能样式**：根因是技能在输入框里是 `$[name]` chip，发送时 `expandTokens` 展开为 `/skill:name` 纯文本（供 SDK 识别）；当 SDK 未把它再展开成 `<skill>` XML 时，消息以纯文本命令形式存储。而 `formatSkillBlocks` 只认 `<skill>` XML 块、`textToSegments` 只认 `$[name]` chip 格式，`/skill:xxx` 落在两者盲区，原样显示为纯文本。修复：`formatSkillBlocks` 新增第二条替换规则识别 `/skill:name` 纯文本，且**只有该技能名在已启用技能列表（`skills`）中真实存在时才渲染为 ⚡ 技能名**，避免任意 `/skill:xxx` 文本被误判；尾部多余空格压缩为单个。普通 `/命令`（非 `skill:` 前缀）保持原样。`MessageRow` 通过 `useSkillsStore` 取 `skills` 构造技能名集合传入 `formatSkillBlocks`（用 `useMemo` 缓存 Set 避免每次渲染新建触发无限循环）。
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
