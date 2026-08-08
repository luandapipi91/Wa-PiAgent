# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-08-08

### 变更

- **新增功能(frontend)：侧边栏「新建项目」入口移至「项目」标题行右侧 + 图标**。有用户项目时，新建入口从列表底部文字按钮移到「项目」分组标题行右侧的 + 图标按钮（复用 Icon 组件 plus 图标，title/aria-label 提示「新建项目」，hover 变 brand 色）；无用户项目时保持现状（底部文字按钮、标题行不渲染）。i18n 新增 projectList.newProjectHint 中英文案。新增有项目场景组件测试（+ 图标存在、底部按钮隐藏、点击触发新建），强化无项目场景回归断言。
  - 影响范围：`packages/frontend/src/components/ProjectList.tsx`、`packages/frontend/src/i18n/locales/{en,zh}.ts`、`packages/frontend/tests/ProjectList.test.tsx`。

- **新增功能：桌面版「系统设置 → 关于」应用版本检查与自动更新（Gitee Releases + electron-updater）**。desktop 新增 `updater/` 模块（gitee-api 纯函数层、GiteeProvider 自定义 provider、updater 装配层 NsisUpdater + IPC + 事件翻译），preload 暴露 `waPiUpdater` 桥接，main.cjs 接线 `setupUpdater`；frontend 新增 updater store（Zustand 状态机 + IPC 桥接）+ 设置页「关于」页签（AboutSection 6 状态 UI，全量 i18n 中英双语）；浏览器版经 vite define 注入 package.json 版本号，关于页同样显示版本（桌面版由 app.getVersion() 覆盖）。新增 `scripts/publish-gitee.ts` 发版辅助脚本。四层测试：desktop 单测 18 例、前端组件测试 7 例、E2E 1 例（mock waPiUpdater 完整流程）。
  - 影响范围：`packages/desktop/src/updater/`（gitee-api.cjs/gitee-provider.cjs/updater.cjs + 测试）、`packages/desktop/src/preload.cjs`、`packages/desktop/src/main.cjs`、`packages/frontend/src/store/updater.ts`、`packages/frontend/src/components/settings/AboutSection.tsx`、`packages/frontend/src/components/SettingsModal.tsx`、`packages/frontend/src/i18n/locales/{en,zh}.ts`、`packages/frontend/vite.config.ts`、`packages/frontend/e2e/updater.spec.ts`、`scripts/publish-gitee.ts`。

- **修复(kernel)：会话被清理与后台预热/拉取历史并发时的竞态噪音日志降级**。四个 `console.error`（拉取历史消息失败 / 后台预热会话进程失败 / pi rpc 进程已退出 / 会话已清理）在 `reapIdleSessions` 或 `session:delete` 与冷启动并发时成串打印，视觉上等同崩溃，实为预期关闭流程（jsonl 直读已兜底历史、dispose 只杀进程保留会话记录、下次发消息会重新拉起）。修复：①`agent-manager.ts` `_createSession` 的 `getMessages` catch 中 `disposed.has(sessionId)` 命中（dispose 打断拉取）→ 静默；②「会话已清理」错误加 `code = "SESSION_DISPOSED"` 语义标记；③`ws-server.ts` `prewarm` catch 识别 `SESSION_DISPOSED` → 静默。真异常（进程崩溃、非 dispose 启动失败）仍打 error 便于排障。新增 4 个回归测试（dispose 竞态静默 + 非 dispose 仍打印，agent-manager 与 ws-server 各 2 个）。
  - 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/ws-server-session-prewarm.test.ts`。

- **修复(frontend)：新建页切换模型后发送，聊天界面模型选择器显示旧模型**。`NewSessionPane` 的 `setModel` 回调原来只更新本地 state + 全局 `defaults.model`，未写入会话级 `bySession[sessionId].model`；发送后进入会话 `Composer` 读取会话级 prefs 显示旧模型（用户选的模型 A 变成了旧值 B）。修复：`setModel` 回调同步调用 `setSessionPrefs(sessionId, { model: m })`，与 `Composer.tsx` 行为对齐。新增回归测试 `NewSessionPane.test.tsx`（新建页切换模型后发送 → 会话级 prefs 记录所选模型）。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`。

---

## 2026-08-07

### 变更

- **前端 6 个组件文案接入 i18n（中英双语）**：`NewSessionPane`/`AgentGalleryModal`/`AgentListSection`/`ProjectItem`/`Composer`/`CommandPalette` 的硬编码中文 UI 文案替换为 `t()`。各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `NewSessionPane`：标题/副标题/无项目选项/placeholder 接入 `newSession.*`；placeholder 用 `t("newSession.placeholder", { agent: agentName ?? "研发" })` 保留占位回退。
  - `AgentGalleryModal`：usageHint 改用 `t("agentGallery.usageHint", { count, names })` 拼接前导 `\n`（与原 `\n注意：...` 输出一致）；标题 `全部智能体 N 个` → `agentGallery.titleAllCount`（资源值已含" 个"，断言通过）；placeholder/确定/取消/新建/内置/页脚/右键查看·编辑/删除确认框接入 `agentGallery.*` + `common.*`。`SUBAGENT_TYPES.map(t => ...)` 参数遮蔽翻译函数 `t`，提前算好 `builtinBadge` 常量传入 JSX。
  - `AgentListSection`：usageHint 同 Gallery 模式；区头/更多入口/placeholder/新增/右键编辑·删除/确认框接入 `agentList.*` + `common.*`。
  - `ProjectItem`：prompt 标题、右键重命名/删除聊天/删除项目、ConfirmDialog title/message/confirmText 接入 `projectItem.*` + `common.delete`；`openInFileManagerLabel()` 调用保持不变（util 单独迁移）。
  - `Composer`：placeholder 三态接入 `composerExtra.placeholderBlocked`/`placeholderQueued` + 复用 `newSession.placeholder`。
  - `CommandPalette`：命令/技能分组、系统设置/智能体管理标题及其 hint、placeholder、空态、底部 导航/执行/关闭 接入 `commandPalette.*` + `composer.cmdSettings`/`cmdAgents`/`cmdAgentsDesc` + `common.close`；`commandItems`/`skillItems` 的 useMemo 依赖数组补 `t`。
  - 验证：`bun run test tests/NewSessionPane.test.tsx tests/AgentGalleryModal.test.tsx tests/AgentListSection.test.tsx tests/ProjectItem.system.test.tsx tests/CommandPalette.test.tsx tests/Composer.test.tsx` 81 pass / 0 fail，测试文件未改动。关键断言（搜索技能和命令... / 技能 / 命令 / 系统设置 / 智能体管理 / 没有匹配的结果、更多智能体 (2)、内置 / N 个）全绿。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`AgentGalleryModal.tsx`、`AgentListSection.tsx`、`ProjectItem.tsx`、`Composer.tsx`、`CommandPalette.tsx`。

---

### 变更

- **前端 7 个组件文案接入 i18n（中英双语）**：`ImConversationList`/`ExtensionDialog`/`AgentSwitcher`/`SessionRow`/`AgentMissingModal`/`Sidebar`/`ProjectList` 的硬编码中文 UI 文案替换为 `t()`。各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `ImConversationList`：模块级 `titleOf` 改为组件内函数（依赖 `t`），群聊标题用 `t("im.groupTitle", { chatId, from })`；空态 `im.emptyHint`、菜单 `im.deleteChat`、确认框 `im.deleteConfirmMessage`/`common.delete`。`ImConvRow` 通过 `titleOf` prop 接收组件内函数。
  - `ExtensionDialog`：footer 与 select-only 态取消/确认按钮 → `common.cancel`/`common.confirm`（动态 req 载荷不迁移）。
  - `AgentSwitcher`：`已切换为 ${agentName}` 在写入 message.content 时构造时插值 `t("agentSwitcher.switchedMessage", { agent })`（避免存入模板占位符，保证测试断言 `content==="已切换为 代码审查"`）；确认框 title/message/cancel/confirm 接入 `agentSwitcher.*` + `common.cancel`。`t` 加入 effect 依赖数组。
  - `SessionRow`：`运行中` aria-label → `common.statusRunning`；`有新回复` aria-label 资源无对应 key，按指示保留原文。
  - `AgentMissingModal`：标题/正文/空列表 → `agentMissing.title`/`message`/`empty`。
  - `Sidebar`：tab 文案 `任务`/`IM` → `sidebar.tabTasks`/`tabIm`；tab 循环变量 `t` 重命名为 `tabKey` 以让位翻译函数 `t`（必须改动）。品牌名 WA PI Agent 不迁移。
  - `ProjectList`：区头 `项目` → `projectList.sectionTitle`；`＋ 新建项目` → `projectList.newProject`。
  - 验证：`bun run test tests/ImConversationList.test.tsx tests/ExtensionDialog.test.tsx tests/AgentSwitcher.test.tsx tests/App-agent-missing.test.tsx tests/ProjectList.test.tsx tests/Sidebar.test.tsx` 38 pass / 1 skip / 0 fail，测试文件未改动。关键断言（ImConversationList 群聊(wr_abcde) · lisi / 暂无 IM 会话、AgentSwitcher content==="已切换为 代码审查"、AgentMissingModal 请重新选择智能体后重发消息、ProjectList 项目）全绿。
  - 影响范围：`packages/frontend/src/components/ImConversationList.tsx`、`ExtensionDialog.tsx`、`AgentSwitcher.tsx`、`SessionRow.tsx`、`AgentMissingModal.tsx`、`Sidebar.tsx`、`ProjectList.tsx`。

---

### 变更

- **前端 5 个组件 + platform.ts 文案接入 i18n（中英双语）**：`EmptyState`/`SettingsButton`/`NewSessionButton`/`ExplorerPanel` 硬编码中文 UI 文案替换为 `t()`；`util/platform.ts` 的 `openInFileManagerLabel` 改造为接收可选 `labels` 参数（默认回退中文，行为不变）。
  - 各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `EmptyState`：标题/副标题/新建项目按钮（`emptyState.*`）。
  - `SettingsButton`：`系统设置` 文案 + `aria-label`/`title`（`settings.title`）。
  - `NewSessionButton`：`＋ 新建会话`（`sidebar.newSession`）。
  - `ExplorerPanel`：右键菜单 `复制路径`、toast `打开失败`、占位 `未设置工作目录`/`加载失败：${error}`/`加载中…`（`explorer.*` + `common.loading`）。子组件 `ExplorerContextMenu` 通过 `t` props 接收翻译函数（类型 `TFunction`）。`openInFileManagerLabel()` 调用保持不变（util 改造，组件本轮不改）。
  - `util/platform.ts`：`openInFileManagerLabel` 改为 `openInFileManagerLabel(labels?)`，不传参时回退原中文默认值，保证普通函数调用与单测行为零变化；为后续组件传入 i18n 值预留入口。
  - 验证：`bun run test tests/ExplorerPanel.test.tsx tests/SettingsButton.test.tsx tests/NewSessionButton.test.tsx tests/ProjectItem.system.test.tsx` 14 pass / 0 fail；`bun run typecheck` 通过。关键断言（ExplorerPanel 复制路径/在资源管理器中打开/未设置工作目录、NewSessionButton 含新建会话）全绿，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/EmptyState.tsx`、`SettingsButton.tsx`、`NewSessionButton.tsx`、`ExplorerPanel.tsx`、`packages/frontend/src/util/platform.ts`。

---

## 2026-08-07

### 变更

- **前端 ask 提问卡 + 目录树选择器文案接入 i18n（中英双语）**：`src/components/ask/AskFormCard.tsx` 与 `src/components/DirTreePicker.tsx` 的硬编码中文 UI 文案替换为 `t()`。经门面 import `useTranslation`（ask 目录用 `../../i18n/useTranslation`，根目录 `components/` 用 `../i18n/useTranslation`）并在组件内 `const { t } = useTranslation()`。
  - `AskFormCard`：标题插值（`emoji`+`agent` 回退 `ask.agentFallback`）、`aria-label` 终止、其他选项、自定义答案 placeholder、备注 label、stale/提交失败两处错误文案、取消、提交中/提交按钮全部接入。
  - `DirTreePicker`：`buildSearchTree` 由模块级函数改为接收 `rootName` 参数（由组件传入 `t("filePicker.thisPc")`）；初始 root 占位 `加载中…`、主 tree 根 `此电脑`、标题「选择项目目录」、搜索 placeholder/搜索中/无匹配、treeLabel 目录、显示隐藏目录、取消、选择按钮全部接入；复用 `filePicker.*` 与 `dirPicker.*` key。
  - `AskDock` 经核对无硬编码 UI 文案（仅注释），跳过。
  - 验证：`bun run test tests/AskFormCard.test.tsx tests/AskDock.test.tsx tests/DirTreePicker.test.tsx` 38 pass / 0 fail，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/ask/AskFormCard.tsx`、`packages/frontend/src/components/DirTreePicker.tsx`。

---

## 2026-08-07

### 变更

- **记忆模块 4 个组件文案接入 i18n（中英双语）**：`src/components/memory/` 下 `MemoryPage`/`MemoryCard`/`MemoryEmpty`/`InstructionItem` 全部硬编码中文 UI 文案替换为 `t()`。各组件顶部经门面 `import { useTranslation } from "../../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `MemoryPage`：标题/开关/tab label/筛选 chip/分类 chip/添加按钮/表单 placeholder/取消保存/作用域下拉文案（含 `📁 {{name}}` 插值）。**tab label 资源值保持 `已保存`/`归档`/`指令文件`，`data-testid={tab-${label}}` 自然不变**，5 处单测 + 4 处 E2E 断言零回归；筛选 `filterProject` 中文值保持「项目」满足 E2E `getByRole("button",{name:"项目"})`。
  - `MemoryCard`：模块级 `CATEGORY_STYLE` 常量把中文 `label` 改为 `labelKey`（存 i18n key），组件内用 `t(cat.labelKey)` 渲染；作用域标记/编辑按钮/归档时间（含插值）/操作按钮全部接入。
  - `MemoryEmpty`/`InstructionItem`：空状态标题与提示、作用域徽标/查看/关闭按钮全部接入。
  - 验证：`bun run test tests/MemoryPage.test.tsx` 17 pass / 0 fail。资源 key 中文值与原硬编码值逐一核对一致，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/memory/MemoryPage.tsx`、`MemoryCard.tsx`、`MemoryEmpty.tsx`、`InstructionItem.tsx`。

---

## 2026-08-08

### 变更

- **i18n 修复：补齐英文界面露中文的遗漏点 + 非组件层文案迁移**：
  - **组件层遗漏**：`openInFileManagerLabel()` 4 处调用（ExplorerPanel/ProjectItem×2/FileViewer）补传 i18n labels；FileViewer markdown 头 `title="关闭"` 漏改修复；`main.tsx` ErrorBoundary 兜底页（应用发生错误/重新加载）改用 i18next 实例 t（class 组件不能用 hook，但 ./i18n 已先初始化）。
  - **store/工具层用户可见文案**：`store/session.ts`（压缩上下文 5 处消息 + 扩展错误 toast）、`store/projects.ts`（重复目录提示）、`store/mcp.ts`（连接失败）、`store/recording.ts`（busy 冲突 Error/录音文件名/beforeunload 提示）、`recording/recorder.ts`（已有录音/无音频轨道 Error）、`fs-client.ts`（不支持预览/读取失败/复制失败）全部接入 i18n（统一 `import i18n from "../i18n"` 走门面实例，解决 `bun test --isolate` 下直接 import i18next 实例未初始化的问题）。
  - **耦合判断解耦**：`store/session.ts` 的 `startsWith("已压缩")` 改用结构化 `compactionEnded` 标志判断压缩是否结束（避免 i18n 化后文案判断失效）；`AskFormCard` 的 `message.includes("失效")` 改用 HTTP 400 状态判断。
  - **MermaidBlock** 3 处内部中文 Error 改英文（技术性错误，不直接露界面）。
  - 新增 key：`message.compactionProgress/Aborted/Failed/Done/DoneNoToken`、`message.extensionError`、`store.duplicateProjectCwd/mcpConnectFailed/recordingFile/recordingBusy/recordingNoAudioTrack/unsupportedPreview/readFailed/copyFailedShort`、`common.appError`。
  - 验证：全量单测 1158 pass / typecheck 通过。
  - 影响范围：`packages/frontend`（`src/store/`、`src/recording/`、`src/fs-client.ts`、`src/main.tsx`、`src/components/`、`src/i18n/locales/`）。

- **前端引入国际化（i18n）基础设施，中/英双语支持**：引入 `react-i18next`，搭建 i18n 框架（`src/i18n/`：`index.ts` 模块顶层初始化 i18next 实例、`detect.ts` 首次启动语言检测纯函数、`locales/zh.ts`+`en.ts` 翻译资源）。**首次启动按 `navigator.language` 自动选择**（`zh*`→中文，其余→英文，无法访问 navigator 时回退中文；用户显式选择过则尊重 localStorage 持久化值）。扩展 `ui-prefs` store 新增 `language` 字段 + `setLanguage`（同步 i18n 实例 + `<html lang>`），`main.tsx` 在渲染前完成语言决策。
  - **系统设置-通用新增「语言」切换项**（下拉，中文/English，`data-testid=language-select`），即时生效并持久化到 localStorage。
  - 设置弹窗 `SettingsModal`（标题+8 项导航）与 `GeneralSection` 全部文案接入 `t()`；**设置面板全部 8 个分区及子弹窗**完成中英双语；**前端全部组件文案完成中英双语**——核心交互（MessageList/ComposerInput/SessionView/App/AgentConfig/FilePicker）、`blocks/` 全部消息块（11 个）、`ui/` 全部控件（8 个）、`mcp/`（6 个）、`memory/`（4 个）、`ask/`（2 个）、根目录长尾（DirTreePicker/NewSessionPane/AgentGalleryModal/ProjectItem/CommandPalette/Composer/AgentListSection/ExplorerPanel/ImConversationList/ExtensionDialog/AgentSwitcher/SessionRow/AgentMissingModal/Sidebar/ProjectList/EmptyState/SettingsButton/NewSessionButton）及 `util/platform.ts`（openInFileManagerLabel 改为可选参数，默认行为不变）。
  - 测试基建：`happydom-setup.ts` 通过环境变量 `WA_PI_LANG` 锁定组件测试为中文（解决 `bun test --isolate` 下 globalThis 不共享的时序问题），新增 `.env.test` + `bun --env-file=.env.test test` 跨平台加载；引入 `src/i18n/useTranslation.ts` 门面确保每个组件模块图触发 i18next 初始化。新增 `i18n-detect`/`store-ui-prefs-language` 单测、`GeneralSection-language` 组件测试、`language-switch` E2E。全量单测/组件测试不回归。
  - 影响范围：`packages/frontend`（`src/i18n/`、`src/store/ui-prefs.ts`、`src/main.tsx`、`src/components/` 全部、`src/util/platform.ts`、`tests/`、`e2e/`、`.env.test`、`package.json`）。

- **清理已沉淀的设计原型 mockup 与早期差异文档**：删除 `docs/superpowers/mockups/` 下 16 个早期 UI 原型 HTML（其设计已沉淀进 `docs/superpowers/specs/2026-07-05-wa-pi-design.md`）及 `docs/chat-ui-diff-cocode-vs-wa-pi.md`（cocode vs wa-pi 早期 UI 差异对比，已被实际实现取代）。specs 文档附录中的 mockup 索引保留为历史溯源记录。
  影响范围：`docs/superpowers/mockups/`（删除）、`docs/chat-ui-diff-cocode-vs-wa-pi.md`（删除）。
- **新增初始化向导（Onboarding Wizard）设计文档**：
  `docs/superpowers/specs/2026-08-07-onboarding-wizard-design.md`（状态：已确认）。针对首次启动无模型时的硬性阻塞点，设计 2 步初始化向导：①配置模型（复用供应商表单）→ ②设置默认智能体（新建或从 agency-agents-zh 预设库选）。文档含触发时机、步骤流程、关键决策与字段映射。
  影响范围：`docs/superpowers/specs/`（纯设计文档，无运行时代码改动）。
  - *更新*：步骤流程决策调整——两步均不强制（第 1 步未保存模型也可直接进入第 2 步，第 2 步可跳过），简化流程图。原「下一步置灰」机制移除。
- **引入 agency-agents-zh 中文角色智能体参考库（MIT，纯参考资料）**：
  从 [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh)（19k+ Stars）
  下载完整仓库（main 分支 tarball，原文未改动）至 `docs/references/agency-agents-zh/`。
  该库含 **268 个中文角色智能体**（带身份/规则/工作流/交付物的真 agent 定义，非单段提示词），
  覆盖工程/设计/营销/产品/游戏/安全/GIS/金融等 19 个部门。许可证为 MIT（含原英文版与中文翻译双版权声明），
  随附原始 `LICENSE`。**不接入运行时**（不并入 `DEFAULT_AGENT_SEEDS`、不写 `~/.wa-pi/agents/`、不接前端 UI）；
  另生成 `README-INDEX.md`：完整智能体索引 + 与 hiagent 角色 `.md` 格式的字段映射对照
  （`name→displayName` / `emoji→avatar` / 正文→`systemPromptBody` 等），便于将来评估接入。
  影响范围：`docs/references/agency-agents-zh/`（整库 + 新增 `README-INDEX.md`，无运行时代码改动）。

### 修复

- **添加/编辑供应商弹窗点击阴影不再关闭**：`ProviderFormModal` 传入 `closeOnOverlayClick={false}`，防止用户填写表单时误点遮罩丢失已输入内容。ESC、取消按钮仍可关闭。
  - 影响范围：`packages/frontend/src/components/settings/ProviderFormModal.tsx`、`packages/frontend/tests/ProviderFormModal.test.tsx`。

---

## 2026-08-07

### 新增功能

- **编辑智能体弹窗 - 技能 tab 改造**：
  1. 顶部新增「全部勾选」开关，支持在全选↔全不选间切换；逐项取消至全部为空时也自动进入全不选态。
  2. 新增 `AgentConfig.skillsAllOff?: boolean` 字段表达"显式全不选"——此前 `skills:[]` 被复用为"继承全部"，无法表达"不加载任何技能"。kernel 主会话与子代理派发路径均已识别该字段，`skillsAllOff=true` 时 `--skill` 列表为空（`--no-skills` 仍传，运行时确为零技能）。
  3. 技能名不再换行（`whitespace-nowrap`）；技能描述超长省略，点击弹出气泡显示完整描述，再次点击/点击外部关闭（新增轻量内联 `SkillDescBubble` 子组件，不引入第三方库）。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/agent-md.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/frontend/src/components/AgentConfig.tsx` 及对应 kernel/前端测试、`packages/frontend/e2e/agents.spec.ts`。

### 修复

- **角色选择器小窗口下不再超出屏幕**：
  1. `NewSessionPane` 项目下拉（`select`）缺 `min-w-0`，选中项文本撑出 min-content 宽度，把同行角色选择器 pill 挤出可视区——补 `min-w-0` 让其可收缩；
  2. `AgentDropdown` 根节点补 `min-w-0 max-w-full`、pill 按钮补 `w-full`、警示文案补 `truncate`，使 pill 在窄行内可截断收缩；
  3. 下拉菜单新增视口钳制：展开后实测边界，左右任一侧超出可视区 8px 边距即用 `translateX` 平移回屏幕内，并加 `max-w-[calc(100vw-16px)]` 兜底。
  - 影响范围：`packages/frontend/src/components/ui/AgentDropdown.tsx`、`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/AgentDropdown.test.tsx`。
- **委托/工具/思考卡片长文本不再撑破卡片**：`ProcessCard` 基座 body 统一加 `overflow-wrap:anywhere`（可继承，覆盖所有过程卡），长无空格串（路径/base64/URL）任意位置断行；同时修复 `DelegateCard` 任务行 flex 子项因 min-content 不收缩导致的溢出。此前仅 markdown 正文气泡有换行兜底，卡片正文缺失。
  - 影响范围：`packages/frontend/src/components/blocks/ProcessCard.tsx`、`packages/frontend/tests/ProcessCard.test.tsx`。
- **统一「打开系统文件/目录」入口文案，按平台区分**：
  4 处入口文案此前各不相同（「在访达中显示」「在系统查看文件」「查看文件夹」「打开工作目录」），统一为同一句平台相关文案：Windows 显示「在资源管理器中打开」、macOS 显示「在访达中打开」、Linux/其他显示「在文件管理器中打开」。前端此前无平台检测能力，新增 `packages/frontend/src/util/platform.ts`（基于 `navigator.userAgent` 的纯前端客户端检测）。FileViewer unsupported 按钮补 `data-testid="fv-reveal"` 让 E2E 平台无关。后端逻辑（kernel spawn / REST / WS 端点）未改动。
  - 影响范围：`packages/frontend/src/util/platform.ts`（新）、`packages/frontend/src/components/{ExplorerPanel,ProjectItem}.tsx`、`packages/frontend/src/components/blocks/FileViewer.tsx`、`packages/frontend/tests/{platform,ExplorerPanel,FileViewer,ProjectItem.system}.test.tsx`、`packages/frontend/e2e/{explorer.spec,default-workspace.spec,global-setup}.ts`。

### 新增

- **企微机器人默认工作目录 + 切换工作目录开关**：机器人配置新增「默认工作目录」（默认 `__system__`）与「允许切换工作目录」开关（默认关闭）。
  - 动机：原所有 IM 会话硬性落在默认工作区，且 `/use`、`/projects` 对所有机器人无条件开放。
  - 改动：
    - `ChannelConfig` 新增 `defaultProjectId`、`allowProjectSwitch` 字段。
    - `loadChannels` 读取旧数据归一化兜底；`validateChannelInput` 对缺失 `defaultProjectId` 回退默认工作区。
    - `channel-manager` 新建 IM 映射时使用渠道默认工作区；`ensureSession` 对失效 projectId 降级为默认工作区并 warn。
    - `commands.ts` 新增 `CommandContext.allowSwitch`，关闭时 `/use`、`/projects` 返回拒绝回复，`/help` 文案不含这两条。
    - 前端 `BotsSection` 表单新增项目下拉与 checkbox。
  - 兼容：旧 `channels.json` 无需迁移，读取时兜底。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/channel-store.ts`、`packages/kernel/src/channel-manager.ts`、`packages/kernel/src/channels/commands.ts`、`packages/kernel/tests/`（channel-store/channel-manager/channel-commands/mock-adapter）、`packages/frontend/src/components/settings/BotsSection.tsx`、`packages/frontend/tests/BotsSection.test.tsx`、`scripts/channels-api-it.sh`、`packages/frontend/e2e/wecom-bot-default-workdir.spec.ts`。

---

## 2026-08-07

### 新增

- **企微群聊会话从「群维度」改「群+用户维度」隔离**：此前同一群里所有用户共享一个会话（A 的上下文 B 可见）；
  现改为同群每个用户各开独立会话（key 从 `channelId:chatId` 升级为 `channelId:chatId:fromUserId`），
  A/B 上下文互不可见，且修复了同群多用户并发流式回复串帧的潜在 bug。
  - 数据结构：`ChannelSessionMapping` 增 `fromUserId`；`ChannelConversationInfo` 增 `fromUserId`。
  - 迁移：`loadChannelMappings` 一次性升级 `schemaVersion` 1→2，单聊无损补 `fromUserId=chatId`，
    群聊旧记录保留在 IM 列表但不再续接（该群用户下次发消息按新维度新建），可右键删除。
  - UI：IM 列表群聊会话标题改为「群聊(群id前8位) · 发送者userid」；会话详情来源文案追加群与发送者。
  - mock 链路：`mockInbound` / `ws-server` / `routes/channels` 透传 `fromUserId`/`chatType`，E2E 可验证群隔离。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/channel-store.ts`（迁移）、
    `packages/kernel/src/channel-manager.ts`（key/find/title/listConversations/mockInbound）、
    `packages/kernel/src/ws-server.ts`、`packages/kernel/src/routes/channels.ts`、
    `packages/frontend/src/components/ImConversationList.tsx`、`packages/frontend/src/App.tsx`、对应测试。

---

## 2026-08-07

### 新增

- **IM `/new` 命令保留历史会话 + IM tab 右键删除**：此前 `/new` 只删除"IM 对话→会话"的映射指针，
  旧会话虽仍在磁盘但从 IM tab 消失、无法查看和删除。
  - `/new` 改为归档当前会话（写入 `historySessionIds`）而非丢弃；旧会话继续在 IM tab 显示，
    新会话作为当前活跃会话，同一 IM 对话下可有多条历史会话。
  - `listConversations` 同时返回当前活跃会话与历史归档会话（实体已删则不显示）。
  - IM tab 会话项新增右键菜单「删除聊天」，确认后走既有 `DELETE /api/sessions/:id`；
    删除时联动清理 IM 映射（当前指针 + 历史归档）并广播刷新。
  - 影响范围：`packages/kernel/src/channel-store.ts`（`ChannelSessionMapping` 增 `historySessionIds`）、
    `packages/kernel/src/channel-manager.ts`（`/new` 归档、`listConversations` 返回历史、新增 `onSessionDeleted`）、
    `packages/kernel/src/ws-server.ts`（`session:delete` 联动调用）、
    `packages/frontend/src/components/ImConversationList.tsx`（右键菜单 + 删除确认）、对应测试。

### 修复

- **IM 消息自动弹出会话打扰工作**：企业微信发消息时，软件界面会自动切到 IM 会话视图，
  打断用户当前工作。
  - 根因：后端新建 IM 会话时广播 `session:created`，前端 `addSession` 无条件把新会话设为
    `currentSessionId`，派生 view effect 检测到后自动 `setView("session")` 弹出。
  - 修复：`addSession` 去掉自动设 `currentSessionId`/`currentProjectId` 的副作用，只 append。
    需要选中会话的调用方（NewSessionPane 用户主动新建）已显式调 `selectSession`，不受影响。
  - 影响范围：`packages/frontend/src/store/projects.ts`（addSession）、
    `packages/frontend/tests/store-projects.test.ts`（回归测试）。

### 新增

- **机器人回复粒度新增「极简」选项**：在原有「标准(正文+文件变更)」「简洁(仅正文)」基础上，
  增加 `minimal`（极简）——只把 Agent **最后一条 assistant 消息的全部文字**发给用户，
  丢弃工具调用前的过程性消息（如「我先检查一下」），适合只关心最终结果的场景。
  - 语义：「最后一条」= 一轮里按消息粒度取最后一条 role=assistant 的消息，拼接其全部 text 块；
    该消息若含多行多段则全部保留。
  - 流式行为：minimal 模式禁用流式增量推送（过程文字不实时显示），等 agent_settled
    一次性发送最后一条 assistant 消息全文，避免过程文字先流式显示再被覆盖。
  - 影响范围：`packages/shared/src/types.ts`（`ReplyGranularity` 扩展为
    `"minimal" | "simple" | "standard"`）、
    `packages/kernel/src/channels/reply-composer.ts`（`composeReply` 新增 minimal 分支 +
    `extractLastAssistantText`）、
    `packages/kernel/src/channel-manager.ts`（`streamUpdate` minimal 模式直接 return 禁流）、
    `packages/kernel/src/channel-store.ts`（校验白名单）、
    `packages/frontend/src/components/settings/BotsSection.tsx`（表单下拉新增选项）、
    对应测试。

### 修复

- **流式回复清空前序内容**：工具调用场景下，一轮产生多条 assistant 消息（文字→工具→文字），
  第二条消息流式时企微里之前已显示的内容被清空。
  - 根因：`streamUpdate` 只取当前 partial 的文本，不含本轮已落地的历史消息文本；
    企微 `replyStream` 是整体替换，新 partial 文本比旧内容短 → 看起来"清空"。
    附带修复节流 bug：挂起期间新 delta 未更新待发文本，只发首个 delta 的旧文本。
  - 修复：流式累计文本 = 本轮已落地 assistant 消息文本 + 当前 partial 文本；
    节流挂起期间更新 pendingText，timer 触发时发最新。
  - 影响范围：`packages/kernel/src/channel-manager.ts`（streamUpdate 文本拼接 + 节流）、
    `packages/kernel/tests/channel-manager.test.ts`（多消息轮流式回归测试）。

### 新增

- **企业微信流式回复**：IM 渠道回复从"整轮生成完才一次性发送"改为 token 级流式增量
  更新——企微里能看到回复像打字机一样实时增长。默认启用，适配器不支持时自动降级为整轮发送。
  - 技术基础：企微 SDK `replyStream(frame, streamId, content, finish)` 同 streamId 复用即可
    增量更新同一条消息；agent 层已有 `message_update`(text_delta) 事件，只是被
    `onSessionEvent` 的 `if (type !== "agent_settled") return` 挡掉了。
  - 改动：
    - `ChannelAdapter` 接口新增可选 `streamReply` 方法（能力探测，不实现则降级 sendText）
    - `WecomAdapter.streamReply` 用 `replyStreamNonBlocking`（背压自动跳帧）
    - `ChannelManager.onSessionEvent` 消费 `message_update`(text_delta) → 500ms 节流推送
      累计文本；`agent_settled` 发 finish=true 终结帧（composeReply 兜底含文件汇总）
    - 工具调用阶段无 text_delta，消息自然停在上一段文字末尾（不会卡住）
  - 兼容：适配器不支持 streamReply 时自动降级 sendText；错误回合始终走 sendText。
  - 影响范围：`packages/kernel/src/channels/{types,wecom-adapter,mock-adapter}.ts`、
    `packages/kernel/src/channel-manager.ts`、各层测试。

### 修复

- **IM 渠道：映射缓存的会话被删除后报"会话不存在"阻断通讯**：用户在 IM 对话中收到
  `处理出错：会话不存在: im-ch_xxx`，无法继续沟通。
  - 根因：`ChannelManager.ensureSession` 只检查 IM 映射里是否缓存了 sessionId，不校验该
    session 在 project-store 中是否还存在。当用户在前端删除会话、或数据文件被清理/迁移后，
    映射与实体不一致——`ensureStarted` 在 project-store 找不到 session 抛错，被入站 catch
    转成错误回复推给用户。
  - 修复：`ensureSession` 命中缓存时先用 `projectStore.load()` 校验 sessionId 存在；失效则
    清除旧映射、兜底新建会话（符合"IM 通讯不应被会话状态问题阻断"的原则）。同步移除遗留的
    `[dbg] ensureSession` 临时调试日志。
  - 影响范围：`packages/kernel/src/channel-manager.ts`（ensureSession 方法）、
    `packages/kernel/tests/channel-manager.test.ts`（新增失效会话兜底回归测试）。

- **IM 渠道会话泄漏到任务列表**：IM 消息创建的会话（`im-` 前缀）会出现在侧边栏"任务"
  页签的默认工作区下，用户感觉"消息进到了普通任务会话而不是 IM"。
  - 根因：`SessionEntity` 没有"类型/来源"字段，任务页签 `ProjectItem` 仅按 `projectId`
    过滤会话，不排除 IM 创建的会话——IM 会话 `projectId` 也是 `__system__`，于是混入
    任务列表。IM 页签（`ImConversationList`）走独立的 `/api/channel-conversations` 数据源，
    与任务页签互不过滤。
  - 修复：`ProjectItem` 会话过滤增加 `!s.id.startsWith("im-")`，让 IM 会话只归属 IM
    页签。最小改动，不改数据模型。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`（过滤条件）、
    `packages/frontend/tests/ProjectList.test.tsx`（新增 IM 会话排除回归测试）。

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
