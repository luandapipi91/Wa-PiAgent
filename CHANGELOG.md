# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

## 2026-08-15 — refactor(kernel/frontend)!: 自动化任务 @im-push-to 标记与技能 chip 重构

### 变更

- **联系人标记函数式化（功能未发布，无兼容负担）**：任务指令中 IM 推送标记由裸 `@ct_xxx`/`@bot_xxx` 改为 `@im-push-to(ch_xxx,ct_xxx)`（第一段为联系人所属渠道 id，信息性保留，路由以联系人自身 channelId 为准）。带 `@` 前缀与 `@agentName`（delegate 智能体引用）区分，工具描述与系统提示文案均含「不要对其调用 delegate」澄清。
- **kernel 链路**：`robot-push.ts` 重写（`parseImPushMentions` 只认函数式标记；`buildSchedulerPrompt(prompt, contactIds)` 新签名；`createImPushTool` 工具名 `im_push_to`、参数 `contact`、仅走 `pushToContact`）；`agent-manager.ts` `RobotPushInjection`→`ImPushInjection`（`channels`→`targets`）、env `WA_PI_ROBOT_PUSH_CHANNELS`→`WA_PI_IM_PUSH_TARGETS`、handleTool 分发/受限白名单同步；`wa-pi-bridge.extension.ts` 注册段同步；**移除渠道绑定链路**（`pushToChannel`、`parseChannelMentions`、`pushMessage` 外旧分支）；`PushResult.channelId/channelName`→`targetId/targetName`。
- **技能标记 kernel 侧展开**：executeTask 对含 `$` 的提示词调 `channelManager.loadSkillContents()`（改 public）+ `expandSkillTokens`，`$[技能名]` 任意位置生效（SDK 只展开消息开头的 `/skill:`，定时任务不受限）。
- **前端 chip 化（复用聊天 chip 机制）**：新建 `automation/prompt-tokens.ts`（标记解析 + `toPromptHtml` chip 渲染，联系人 chip = 人形图标 + 人名（Icon 表无人形图标，模块私有 SVG 自造），失效联系人灰化显示 id 不报错）；`ComposerTextarea` 加 `toHtml`/`testId` 可选 prop 零侵入复用；`TaskPromptComposer` 重写为 contenteditable（联系人/技能双 chip + 双弹窗 `contact-picker`/`skill-picker`，**技能弹窗列表体复用聊天通用 `QuickInvokeMenu`**（新增 `positionClassName` 定位覆写 prop，键盘 ↑↓/Enter 导航与聊天输入框一致），插入走末尾替换模式，存储形态 `@im-push-to(...)`/`$[名]`）；`TaskDetailView` 四宫格「推送渠道」→「推送联系人」（人名解析），prompt 渲染改用 `toPromptHtml`（chip 与输入框一致，不再手写原文高亮）；`AutomationSidebar.hasIM` 改 `HAS_IM_PUSH_RE`；删除 `utils/channel-mentions.ts`。tokens.ts 新增 `.chip-im`/`.chip-im-invalid` 样式。
- 测试：kernel robot-push 重写至新契约（parseImPushMentions 6 + 工具定义/execute 5 + 会话注入 5 + buildSchedulerPrompt 2）、bridge.test im_push_to 注册断言；frontend 新增 prompt-tokens 9 + TaskPromptComposer 重写 10 + TaskDetailView 新契约 + TaskEditForm 适配 contenteditable 交互；e2e automation.spec testid 同步。
- 影响范围：`kernel/src/{tools/robot-push,agent-manager,channel-manager,index,wa-pi-bridge.extension}.ts`、`shared/src/types.ts`、`frontend/src/components/automation/{prompt-tokens(新),TaskPromptComposer,TaskDetailView,AutomationSidebar}.tsx`、`frontend/src/quick-invoke/tokens.ts`、`frontend/src/components/ui/ComposerTextarea.tsx`、删除 `frontend/src/utils/channel-mentions{,.test}.ts`。

## 2026-08-15 — feat(kernel): extension:repair 事件链路（ws + HTTP 路由 + 广播）

### 变更

- **shared 事件类型**：`packages/shared/src/extensions.ts` 新增 `ExtensionRepairEvent`（前端→kernel，全量重建依赖目录）、`ExtensionRepairProgressEvent`（修复日志行）、`ExtensionRepairDoneEvent`（成功终态），并同步补入 `types.ts` 的 import 区、`WSClientEvent` 与 `WSServerEvent` 两个 union。
- **ExtensionManager.repair()**：封装任务 1 的 `NpmPackageService.repair(onProgress?)`，签名与 install/upgrade 的进度回调一致。
- **ws-server case "extension:repair"**：progress 经 reply（callApi 自动 SSE 广播）、成功后广播 `extension:changed` → `extension:repair:done` → `skill:changed`（含 markAllDirty + 重扫技能），失败广播 `extension:error`（name=repair，fire-and-forget 语义）。
- **HTTP 路由**：`POST /api/extensions/repair` → `callApi({ type: "extension:repair" })`，前端将来可直接触发。
- 测试：新建 `ws-extension-repair.test.ts`（真实服务模式，2 用例：成功帧序列/失败 error 广播）；修复参考 helper `readSseFrame` 的残留帧缺陷（buffer 提为 WeakMap 跨调用共享 + 先解析残留帧再 read，否则密集帧场景挂死超时）；补齐 `extension-manager.test.ts` 两处 pkgService stub 缺失的 `repair`（任务 1 遗留的类型破坏）。
- 影响范围：`packages/shared/src/extensions.ts`、`types.ts`，`packages/kernel/src/extension-manager.ts`、`ws-server.ts`、`routes/extensions.ts`，`packages/kernel/tests/ws-extension-repair.test.ts`（新）、`extension-manager.test.ts`；kernel 全量 1020 测试全过、shared 97 全过、四包 typecheck 0 错。

---

### 扩展区「修复依赖」一键自愈 + E2E

- **UI 调整**：修复依赖按钮从安装区下方独立行移至底部提示条（「安装、卸载、升级操作在当前对话立即生效…」）右侧右对齐；进度文案独立显示在按钮正下方（右对齐）——按钮「修复中…」与进度行「正在修复依赖…」拆分 i18n key（repairingBtn/repairing），消除修复中双「正在修复依赖…」重复显示；真实修复流程 22s 复现验证设置窗口全程存活（无代码路径关闭）；组件测试 5/5 + E2E 2/2 回归通过。
- **新增功能**：设置面板扩展区新增「修复依赖」动作（extension:repair）——全量重建扩展依赖目录（删 node_modules + bun.lock 后按 package.json 重装），为版本漂移/半安装导致的扩展硬崩溃提供一键自愈。背景：pi-tui 0.82.1 与其余 @earendil-works 包 0.84.1 错配导致 /goal 崩溃，且现有链路无任何依赖树检查。涉及 kernel（NpmPackageService.repair + ws 事件 + HTTP 路由）、shared（3 个事件类型）、frontend（store 修复态 + ExtensionSection 按钮/确认弹窗/进度 + i18n）。
- **E2E 测试**：新增 `packages/frontend/e2e/extension-repair.spec.ts`（2 用例：确认弹窗流程——取消不发请求/确认后发出 POST /api/extensions/repair（route 拦截，SSE 终态由组件/单测层覆盖）；按钮存在且可见）。导航照抄 plugin-command-toggles 既有路径（假 provider 规避 onboarding 弹窗 + 按钮文本「插件」精确匹配），语言用 addInitScript 预置 wa-pi-ui-prefs 锁定中文（language-switch.spec.ts 同款，规避 E2E chromium 默认 en-US 导致的文案断言漂移）。本机真实 kernel 占用 9776 时用 WA_PI_E2E_WS_PORT/WA_PI_E2E_WEB_PORT/WA_PI_WEB_PORT 偏移端口运行。

---

## 2026-08-15 — feat(kernel/frontend): 任务指令 @ 改为选联系人 + kernel 主动推送能力

### 变更

- **业务修正**：任务指令 `@` 原来选 IM 渠道本身（`@bot_xxx`）——但渠道是被动回复（`sendText(null)` 需要进站帧），且无法指定接收人，任务结果根本推不到具体的人（用户反馈）。改为 `@` 选**渠道通讯录里的人**（`@ct_xxx` 联系人 id），任务执行时主动推送到该联系人。
- **kernel 主动推送能力（新）**：`ChannelAdapter` 新增 `pushMessage?(chatId, markdown)`（主动发送，无需进站 replyFrame）；wecom-adapter 用 SDK `client.sendMessage(chatId, {msgtype:'markdown', markdown:{content}})`（aibot_send_msg 主动通道），mock-adapter 记录 outbox（含 chatId）。`ChannelManager.pushToContact(contactId, message)`：按联系人 id 查通讯录 → person 用 userId（单聊）/group 用 chatId（群）→ 经所属渠道 adapter 主动推送；联系人/渠道不存在、adapter 不支持主动推送均抛错。
- **@ 解析扩展**：`robot-push.ts` 新增 `parseContactMentions`（解析 `@ct_xxx`）；`createRobotPushTool` 支持联系人目标（`ct_` 前缀走 pushToContact，`bot_` 走 pushToChannel），deps 增加 `availableContactIds`；`index.ts` executeTask 同时解析渠道+联系人注入 robot_push。
- **前端选择器改为联系人**：TaskPromptComposer `@` 数据源从 `useChannelsStore().bots`（渠道）换成 `useContactsStore().contacts`（通讯录），弹窗按渠道分组展示 person 联系人（渠道名 + remark||userId），选中插入 `@ct_xxx`；群聊联系人（kind=group）不展示；空态提示「暂无联系人（先在 IM 里发起会话后自动收录）」；打开时主动 `loadContacts()`（新联系人采集无广播兜底）。触发改为派生状态（value 末尾 `@` 时显示，Escape/外点/滚动 dismiss，继续输入自动收起），修复旧实现 fill 后不关闭的问题。文案同步：「@ 关联 IM 渠道」→「@ 选择联系人」。
- 测试：kernel robot-push 26 例（parseContactMentions 3 + execute ct_ 2）、channel-manager 31 例（pushToContact 2）、mock-adapter 2 例（pushMessage）全绿；kernel 全量 1023 pass；frontend TaskPromptComposer 6 例全绿、全量 1519 pass（2 fail 既有）；E2E automation 4/4（test2 真实浏览器验证 @ 联系人选择器弹出/自动收起）。
- 影响范围：`kernel/src/channels/{types,wecom-adapter,mock-adapter}.ts`、`channel-manager.ts`、`tools/robot-push.ts`、`index.ts`、`frontend/src/components/automation/{TaskPromptComposer,TaskEditForm}.tsx`、对应测试、`e2e/automation.spec.ts`。

---

## 2026-08-15 — feat/fix(frontend): 新建文案改自动化 + 表单居中 + 任务指令 $ 技能窗口

### 变更

- **文案统一「自动化」**：新建/编辑弹窗标题 `新建定时任务`→`新建自动化`、`编辑定时任务`→`编辑自动化`；侧边栏与空态引导页的「+ 新建」按钮 →「+ 新建自动化」。分组名「定时任务」保留。
- **新建弹窗表单居中**：TaskEditForm 顶层 `max-w-[560px]` 加 `mx-auto`——在 Modal 内容区（640 宽 − 32 padding = 608px）里由靠左改水平居中，左右留白对称。
- **任务指令输入框 $ 技能窗口（复用公共组件）**：初版手搓技能弹窗（absolute 定位被 Modal 裁剪、portal 化后仍自维护）→ 用户反馈「太大、透明背景、参考机器设置用公用组件」→ 改为直接复用公共组件 `SkillSuggestTextarea`（设置页 BotsSection 同款）：输入框本体 + $ 技能弹窗全部内建（portal 挂 body、fixed 定位、`background: var(--surface)` 不透明、宽度=输入框宽、maxHeight 240、方向键导航、token 替换）。TaskPromptComposer 只保留 @ 渠道职责（keyup 冒泡到容器 div 检测 @，渠道弹窗 portal 挂 body 锚定容器矩形，背景补齐 `var(--surface)` + `boxShadow`）。行为差异：公共组件用 `s.skills`（仅启用技能）、技能为空不渲染弹窗——比初版更合理。
- **E2E 预置技能**：公共组件仅技能非空时渲染弹窗，E2E 独立 WA_PI_DIR 无技能 → global-setup 预置 `skills/e2e-skill/SKILL.md`（frontmatter 格式匹配 kernel skill-utils 扫描），真实浏览器验证 $ 弹窗（`skill-suggest-list`）。
- **新建/编辑弹窗仅取消/保存可关**：Modal 默认点阴影关闭，新建自动化表单误点阴影会丢输入 → AutomationMain 传 `closeOnOverlayClick={false}`，点阴影不再关闭（ESC 仍可关），只有「取消/保存」按钮关闭。测试：AutomationMain 用例改为「点遮罩不关闭」；取消按钮关闭由 TaskEditForm 既有用例覆盖。
- 测试/已知：前端全量 1518 pass（2 fail 既有：maxEntries/项目名折叠）；automation 组件 50 例全绿（TaskPromptComposer 保留 5 例 @渠道职责，$ 由 SkillSuggestTextarea 自带测试覆盖）；typecheck 0 错；E2E automation+agents 12/12（automation test2 真实浏览器验证公共组件 $ 技能弹窗 `skill-suggest-list`：fill "整理一下 $" → 可见 → fill 正式指令 → 收起）。
- 影响范围：`automation/{AutomationMain,AutomationSidebar,TaskEditForm,TaskPromptComposer}.tsx`、`e2e/automation.spec.ts`、对应测试。

---

## 2026-08-15 — fix(frontend): 原生控件（时间选择/滚动条）跟随深浅主题

### 变更

- **根因**：styles.css 从未设置 `color-scheme`。应用用 `<html data-theme>` 切深浅主题，但由 UA 绘制的原生控件（`<input type="time">` 的时钟图标、日期/时间选择器、滚动条、select 箭头等）默认跟随 OS `prefers-color-scheme`，不跟随应用 `data-theme`——应用手动切深色（或 OS 与 app 不一致）时，深色背景上是浅色 UA 的深色图标，看不见。
- **修复**：浅色 `:root` 补 `color-scheme: light`，深色 `:root[data-theme="dark"]` 补 `color-scheme: dark`。UA 用与 `data-theme` 一致的颜色方案渲染所有原生控件，时间 icon 等自动跟随主题。TaskEditForm 新建自动化表单的时间输入即受益。仓库内无内联 `colorScheme` 与此冲突；表单输入均已显式覆盖背景/文字色，不受 UA 默认色影响。
- 影响范围：仅 `src/styles.css`（两个根块加声明）。验证：前端全量 1517 pass（3 fail 既有）、E2E automation+agents 12/12 无回归。

---

## 2026-08-15 — fix(frontend): 任务卡右键菜单 + 最近执行状态点 + AgentDropdown 弹窗内裁剪

### 变更

- **右键菜单（对齐会话列表模式）**：任务卡右键不再直接弹删除确认，改弹上下文菜单（createPortal + fixed z-50 + useClampMenu 视口钳制，复用 ProjectItem 导出 hook）：菜单项「▶ 立即执行」「🗑 删除」，点删除才弹 ConfirmDialog 二次确认；点外部/ESC 关菜单（setTimeout(0) 延迟注册防误关）；project-menu-close 跨组件菜单互斥。
- **最近执行状态点**：任务卡右上角显示该任务最近一次执行结果（✓ 绿成功 / ✕ 红 / ⟳ 蓝执行中，颜色映射与执行记录页一致），由 records 按 startedAt 取每任务最新一条推导；侧栏挂载时同步 loadRecords()。执行记录页/详情页原有状态展示不变。
- **AgentDropdown 弹窗内裁剪**：菜单从组件内 absolute 改 createPortal 挂 body（fixed z-50）——逃逸新建任务弹窗内容区（overflow-y-auto + maxHeight 70vh）的 overflow 裁剪；按 pill 矩形定位（左对齐/顶部+4px），底部溢出向上翻转，右溢出左移钳制（取代原 translateX 方案）；外点关闭补 menuRef 判定（portal 后菜单不在 rootRef 子树）。NewSessionPane/AgentSwitcher/TaskEditForm 三个使用方同时受益。
- **AgentDropdown 滚动收起修复**：初版「捕获阶段监听任意 scroll 即关菜单」误伤菜单自身列表滚动（智能体多时一滚就收起）；改为 scroll target 在 menuRef 内部不关闭、仅外部容器滚动关闭（防 fixed 脱锚）。补 2 用例（内滚不关/外滚关闭）。
- 测试：AutomationSidebar 重写 9 用例（右键菜单/立即执行/删除确认链/外点关闭/状态点推导）；AgentDropdown 定位 3 用例重写到 fixed 定位契约（含新增向上翻转用例，mock 需同时覆盖 button+div 两类原型）；E2E automation test4 改右键菜单流程。⚠️ automation.spec 中途被并行格式化改过，edit 工具 oldText 匹配失败 → python 字节级替换完成。
- 影响范围：`automation/AutomationSidebar.tsx`、`ui/AgentDropdown.tsx`、对应测试、`e2e/automation.spec.ts`。验证：AgentDropdown 14 例 + Sidebar 9 例全绿、前端全量 1515 pass（3 fail 既有）、typecheck 0 错、E2E automation+agents 12/12（真实浏览器验证菜单/下拉/翻转）。

---

## 2026-08-15 — fix(kernel/frontend): 定时任务执行会话隔离，不进侧栏会话列表

### 变更

- **根因**：executeTask 创建的 sched 会话直接写入 projects.json，无任何隔离标记，loadActive 不过滤、前端只排 im- 前缀 → 出现在项目列表与最近会话列表（本机实测存有 1 条泄漏会话）。
- **shared**：`SessionEntity` 新增可选 `source?: "im" | "scheduler"` 字段，显式化会话来源（原靠 id 前缀隐式约定）；`createSession` 入参透传。
- **kernel**：① executeTask 传 `source: "scheduler"`，IM ensureSession 传 `source: "im"`（收编前缀约定）；② `loadActive` 过滤 `source === "scheduler"` + 存量 `sched-` 前缀兑底；③ IM 会话列表数据源（channel-sessions mapping）经查与 projects.json 独立，sched 会话不会写入，无需防御。
- **前端防御**：`ProjectItem` / `recentSessions` 过滤条件补 `!startsWith("sched-")`（kernel 未升级/事件竞态时自洽）。
- 执行记录独立性：`ExecutionRecord.sessionId` 已回填，会话查看走 `load()` 不受 loadActive 过滤影响，TaskDetailView 执行记录仍可正常查看。
- 测试：project-store 新增 3 用例（scheduler 过滤+存量兑底、load 全量保留、IM source=im 不过滤）；真实数据实证（本机 projects.json 存量 sched 会话 loadActive 过滤为 0）；kernel channel-manager/routes 45 例回归全过；前端 16 例 + E2E recent-sessions 过；三包 typecheck 0 错。
- 影响范围：`shared/src/types.ts`、`kernel/src/{project-store,index,channel-manager}.ts`、`frontend/src/{components/ProjectItem,util/recentSessions}.ts`。

---

## 2026-08-15 — feat(frontend): 自动化默认页规则 + 点选切换 + 通用智能体选择器 + 右键删除

### 变更

- **默认页规则**（AutomationMain store 驱动化，props 全部内化）：选中任务→详情；有任务未选中→默认执行记录页；无任务→新建引导页（⚡ + 暂无文案 + 「+ 新建」直达按钮）。App.tsx 调用简化为 `<AutomationMain />`，删除四个孤立 store 订阅。
- **点选切换**：`selectTask` 改 toggle——再点同一张卡片取消选中（selectedTaskId 回 null，主区回默认页），点不同卡片切换。新增 `tests/scheduler-store.test.ts` 3 用例。
- **通用智能体选择器**：TaskEditForm 执行角色从自研按钮组换成 `ui/AgentDropdown`（AgentSwitcher/NewSessionPane 同款：搜索 + 头像 + 描述 + 视口钳制），pill/列表 testid 前缀 task-agent。
- **右键删除**：TaskCard onContextMenu 弹 `ui/ConfirmDialog`（danger 红色确认，任务名回显），确认调 deleteTask，SSE 驱动列表刷新。
- 测试：AutomationMain.test 重写为 7 用例（引导页/默认记录页/详情/弹窗/遮罩关闭）；AutomationSidebar 补右键删除确认+取消 2 用例；TaskEditForm 4 用例适配 AgentDropdown 交互；E2E automation.spec 重构——test1 引导页断言、test2 AgentDropdown 交互+保存后默认记录页、test3 详情后再点取消、test4 右键删除 UI 流程（替代 REST 删除，SSE 链路同验）。
- 影响范围：`automation/{AutomationMain,AutomationSidebar,TaskEditForm}.tsx`、`store/scheduler.ts`、`App.tsx`、`tests/scheduler-store.test.ts`（新）、e2e/automation.spec.ts。验证：automation 组件 44 例 + store 3 例全绿、前端全量 1511 pass（3 fail 既有）、typecheck 0 错、E2E 4/4（偏移端口 9876/5280）。

---

## 2026-08-15 — refactor(frontend): 新建/编辑任务弹窗化 + 侧栏去「执行记录」按钮

### 变更

- **新建任务弹窗化**：`AutomationMain` 从 App.tsx 移入 `automation/AutomationMain.tsx` 并弹窗化——edit 态不再整页替换主区，改用 `ui/Modal`（width 640，内容区 maxHeight 70vh 滚动）叠加表单，主区始终保持任务详情。关闭路径统一：ESC/遮罩/取消/保存均走 `setView("detail")`（取消与保存已有行为不变，ESC/遮罩免费获得）。弹窗标题区分新建/编辑。App.tsx 同步清理三个孤立 import。
- **侧栏去「执行记录」按钮**：工具栏只留「+ 新建」。执行记录仍可从任务详情页查看（每任务最近 3 条）；ExecutionRecords 全量视图暂无 UI 入口（按需求移除，后续如需可从详情页加链接）。
- **测试**：新增 `AutomationMain.test.tsx`（5 用例：弹窗呈现/主区不被替换、编辑标题、detail 无弹窗、records 视图、遮罩关闭回 detail）；AutomationSidebar 补「无执行记录按钮」断言；E2E automation.spec 适配——test2 改弹窗断言（弹窗标题+主区 header 保持），删除引用已删按钮的执行记录用例（4 用例 serial 连贯流）。⚠️ 仓库裸跑 `bun test` 有 mock.module 跨文件串扰（automation 目录 26 fail 系既有现象，与本次无关），须用官方 `bun --env-file=.env.test test --isolate`。
- 影响范围：`App.tsx`、`automation/AutomationMain.tsx`（新）、`AutomationSidebar.tsx`、`__tests__/AutomationMain.test.tsx`（新）、`__tests__/AutomationSidebar.test.tsx`、`e2e/automation.spec.ts`。验证：automation 40 例全绿、前端全量 1504 pass（3 fail 为既有）、typecheck 0 错、E2E 4/4（偏移端口 9876/5280）。

---

## 2026-08-15 — fix(frontend): 通讯录侧滑面板覆盖式定位 + 行内编辑回填/按钮溢出修复

### 变更

- **覆盖式定位**：原 `ContactsPanel` 根节点是普通文档流元素（`w-64` 无定位），作为 `BotsSection` 横向 flex 行的第三个子项参与空间分配，打开后把右侧编辑表单挤窄 256px。改为全仓库浮层范式（Modal/FilePicker 均 fixed/absolute + z-index）——根改 `absolute inset-y-0 right-0 z-40`（低于 Modal 的 z-50，不遮删除确认弹窗）+ 不透明背景 `var(--surface)` + `var(--shadow-lg)`；`BotsSection` 根容器补 `relative` 作定位上下文。
- **行内编辑回填与替换**：点击人/群名展开编辑时，原为 `setValue(c.remark ?? "")`，remark 为空时输入框空白且名字行仍占位（叠加两行）。改为：① 回填当前显示名 `label(c)`（人→userId，群→chatId 前 8 位）；② 编辑态用输入框行**替换**名字行（三元切换，非叠加），取消/保存后名字行恢复；③ `label` 返回类型收紧为 `string`（`userId` 可选字段 `?? ""`）。
- **保存/取消按钮溢出**：行内编辑 input 为 `flex-1` 但无 `min-w-0`，flex item 默认 `min-width:auto` 使 input 固有宽度（~200px）不可收缩，256px 面板内 input+两按钮总宽溢出~50px，按钮被外层 `overflow-auto` 裁剪不可见。input 补 `min-w-0` 允许收缩，按钮恒在视口内。
- 测试：新增 5 个契约/行为用例（覆盖定位、人名回填、编辑态行内替换+取消恢复、群名回填、input 可收缩），既有用例 + BotsSection 12 例回归全过。
- 影响范围：`packages/frontend/src/components/settings/ContactsPanel.tsx`、`BotsSection.tsx`、`ContactsPanel.test.tsx`。

---

## 2026-08-15 — fix(scheduler): 审查终修复——robot_push 真实注入 + 触发即返回 + 入口校验 + 原子读改写

### 变更

- **C1 robot_push 工具真实注入（不再 TODO）**：复用 bridge 扩展机制——`wa-pi-bridge.extension.ts` 读 `WA_PI_ROBOT_PUSH_CHANNELS` env 条件注册第 8 个工具（普通会话不设 env 不注册，零污染）；`agent-manager.ensureStarted` 新增 `robotPush` opts（spawn 注入 env + 受限 agent 白名单并入 robot_push + `bridgeCtx.handleTool` 分发）；`index.ts executeTask` 解析到 @bot_xxx 时用 `createRobotPushTool` 构造执行体，pushResults 回填执行记录，prompt 追加推送引导。
- **I1 run 触发即返回**：POST /:id/run 不再 await 执行链（旧实现最长挂 5 分钟被 idleTimeout 255s 掐断），改 fire-and-forget + catch 记错；前端「立即执行」成功后 toast「已触发执行」（失败弹错误提示）。
- **I2 入口校验 + 容错**：POST/PUT 校验 name/agentId/prompt 非空、schedule.type 限 5 合法值、time 限 HH:MM（含 00-23/00-59 范围）、custom 必填 cronExpression，不合法 400；ws-server 的 onTaskChanged 调度注册失败 try-catch（不再假 500，记日志 + 广播）；`scheduled-task:error` 事件补入 WSServerEvent 联合类型，App.tsx 处理（toast + 刷新列表）。
- **I4/M14 原子读改写**：`scheduler-store.mutateScheduledTasks(fn)` 把 load→改→save 整体入写队列，routes 的 POST/PUT/DELETE 全部改走；`saveExecutionRecords` 同模式入队。
- **M2/M5 顺手修**：store/scheduler.ts 恒等三元删除；两处 formatSchedule monthly 分支 `dayOfMonth ?? 1`。
- 影响范围：kernel（agent-manager/index/ws-server/routes/scheduler-store/bridge 扩展）、shared types、前端（App/TaskDetailView/AutomationSidebar/store）；kernel 全量 994 测试全过、前端 automation 35 例全过、三包 typecheck 0 错。

---

## 2026-08-15 — test(scheduler): 定时任务 E2E 完整流程测试 + 补执行记录 UI 入口

### 变更

- **E2E 测试**：新增 `packages/frontend/e2e/automation.spec.ts`（5 用例 serial 连贯流）——切 automation 页签验证列表/空态、新建完整流程（填表单+选每周计划+选「研发」角色+保存→列表展示）、任务卡片→详情四宫格与指令、「执行记录」入口→空态渲染→点卡片回详情、REST 删除→SSE 驱动列表恢复空态（顺带验证 scheduled-tasks:changed 刷新链路）。环境前置：假 provider 规避首启 onboarding 弹窗；本机真实 kernel/dev 占用 9776/5180 时用 WA_PI_E2E_WS_PORT/WA_PI_E2E_WEB_PORT/WA_PI_WEB_PORT 偏移端口；npx 会解析到全局 1.59.1 与项目 1.62.1 混载报错，须用 `./node_modules/.bin/playwright`。
- **补 UI 缺口（TDD 驱动）**：E2E 发现 ExecutionRecords 视图无任何 UI 入口（store 的 view=records 无组件可达，死代码）。`AutomationSidebar` 工具栏补「执行记录」按钮（`automation-records-btn`，setView("records")），点任务卡片自然回 detail（selectTask 已置 view）。组件测试补「点击执行记录按钮调用 setView(records)」用例。
- 影响范围：`packages/frontend/e2e/automation.spec.ts`（新增）、`AutomationSidebar.tsx`、`AutomationSidebar.test.tsx`；四层验证全过——kernel scheduler 相关 30 例（scheduler-store/scheduler/routes-scheduler）、automation 组件 33 例、typecheck 三包 0 错、E2E 5/5。

---

## 2026-08-15 — feat(scheduler): 主内容区视图路由 + SSE 事件 + kernel 调度集成

### 变更

- **主内容区自动化路由**：`Sidebar.tsx` 的 tab（tasks/im/automation）由内部 state 改为受控 props（`SidebarTab` 类型导出），状态提升到 `App.tsx`；`App.tsx` 在 `sidebarTab === "automation"` 时渲染 `AutomationMain`（新增内联组件），按 `useSchedulerStore.view` 切换 TaskEditForm / ExecutionRecords / TaskDetailView，header 显示对应标题。
- **SSE 事件监听**：`App.tsx` 新增 `scheduled-tasks:changed`（重拉任务列表）与 `scheduled-task:completed`（重拉任务 + 记录）处理；初始连接回调中同步 `loadTasks` + `loadRecords`。
- **SSE 事件类型**：`packages/shared/src/types.ts` 新增 `ScheduledTasksChangedEvent` / `ScheduledTaskCompletedEvent` 并挂入 `WSServerEvent` 联合类型。
- **kernel 调度集成**：`index.ts` 创建 `TaskScheduler` 实例并 `server.setScheduler()` 注入；`executeTask` 实现：写 running 态执行记录 → 创建会话（默认工作区先 mkdir workdir 子目录，与 agent:prompt 行为一致）→ `ensureStarted` → 解析默认模型（取首个供应商首模型，缺失则 fail）→ `prompt` → 轮询 `isSessionBusy`（500ms 间隔，5 分钟超时 abort）→ 收集末条 assistant 文本为摘要（截 500 字）→ `updateExecutionRecord` 回写终态；shutdown 时 `scheduler.stopAll()`。
- **scheduler 扩展**：`TaskScheduler.runTaskNow()` 手动立即执行（REST run 端点委托）；`scheduler-store.updateExecutionRecord()` 按 id 回写记录（不存在退化追加）。
- **ws-server 路由回调接通**：scheduler 路由的 onSchedule/onCancel 回调现在同时广播 `scheduled-tasks:changed`；onRunNow 委托 `scheduler.runTaskNow`（原占位）。
- **附带修复（agent-manager）**：`switchAgent` 中把 `setSessionAgent` 持久化移到 `_teardownSession` 之前，消除「teardown 后、starting.set 前」异步竞态窗口——否则切换角色后立即发消息会触发并发 `ensureStarted` 二次创建 pi 进程导致 jsonl 冲突。新增专项测试覆盖（挂起 setSessionAgent 期间 sessions 不为空）。
- 与简报的关键偏差：① 主内容区路由在 `App.tsx` 而非 `Sidebar.tsx`（架构上主内容区本就由 App 渲染，Sidebar 仅侧栏）；② 简报的 `scheduled-task:started` 事件未实现，running 态记录创建时广播 `scheduled-tasks:changed` 替代（shared types 未定义 started 事件，保持类型自洽）；③ robot_push 工具注入仍为 TODO（简报即标注 TODO，待 bridge 扩展机制实现）。
- 影响范围：前端 App/Sidebar/store、kernel index/scheduler/scheduler-store/ws-server/routes、shared types、agent-manager 竞态修复；kernel 977 测试全过、前端相关组件测试全过（2 个预先存在的失败与本次无关，基线复现）。

---

## 2026-08-15 — feat(kernel): 记忆字符上限放宽 user 1800 / memory 3200

### 变更

- amaster-memory 的 `createStore` 构造 `MemoryStore` 时覆盖默认上限（user 1375 / memory 2200）→ **user 1800 / memory 3200**：实际使用常触顶导致 `memory_add` 被拒，放宽后全局与项目 store 统一生效。
- 影响范围：amaster-memory.ts（createStore 传 userCharLimit/memoryCharLimit）、amaster-memory.test.ts（+1 用例：1400 字符 user / 2300 字符 memory 写入成功验证覆盖生效）。

---

## 2026-08-15 — feat(scheduler): TaskDetailView 任务详情视图 + ExecutionRecords 执行记录列表

### 变更

- 新建 `packages/frontend/src/components/automation/TaskDetailView.tsx`：任务详情视图。选中任务时渲染四宫格信息（计划时间/执行角色/推送渠道/工作目录）+ 任务指令（`$/skill` 渲染为紫色标签、`@bot_xxx` 渲染为绿色标签）+ 最近执行记录（该任务前 3 条）；未选中时显示空态提示；含「立即执行」「编辑」操作按钮，分别调用 `runTaskNow`/`startEdit`；选中任务变化时 `useEffect` 拉取该任务的 `loadRecords(taskId)`。
- 新建 `packages/frontend/src/components/automation/ExecutionRecords.tsx`：执行记录列表。顶部筛选栏（按天/周/月时间筛选 + 任务下拉 + 状态下拉），记录卡片显示状态图标（✓/✕/⟳）、taskName、耗时、推送标记、错误信息；空态友好提示；挂载时 `loadRecords()` 拉取全部记录。
- 新建 `packages/frontend/src/utils/channel-mentions.ts`：前端版 `parseChannelMentions` 纯函数，从 prompt 提取 `@bot_xxx` 并去重返回 bot ID 列表，与后端 `packages/kernel/src/tools/robot-push.ts` 保持相同契约。
- 新增测试：`channel-mentions.test.ts`（7 例单元测试，镜像后端用例）、`TaskDetailView.test.tsx`（8 例组件测试）、`ExecutionRecords.test.tsx`（8 例组件测试），均用 bun:test + @testing-library/react，mock 全部 store。
- 与简报的关键偏差（均已校正）：① CSS 变量 `--border-color` 在 styles.css 中不存在，项目用 `--hairline`，按钮/下拉框边框已替换；② `React.ReactNode` 在 `jsx: react-jsx` 下需显式导入，改用 `import type { ReactNode }`；③ 移除未使用的 `setView` 解构；④ `RecordRow` 的 `record` 参数用 `ExecutionRecord` 类型替代 `any`。
- 影响范围：纯新增 3 个源文件 + 3 个测试文件，不改已有业务逻辑；组件尚未挂载到父视图（挂载属后续任务）。

## 2026-08-15 — fix(scheduler): TaskEditForm + TaskPromptComposer 审查修复 3 项

### 变更

- **渠道选择器可关闭**：`TaskPromptComposer.tsx` 增加 `onKeyDown` 处理 Escape 关闭 + `useEffect` + `document.mousedown` 监听点击外部关闭（containerRef 判断），新增 `containerRef`。原先用户误按 @ 后唯一关闭方式是选中渠道，现支持 Escape 和点击外部。
- **handleSave 错误处理**：`TaskEditForm.tsx` 的 `handleSave` 包 try-catch，网络失败时调用 `useToastStore.getState().add("保存任务失败，请稍后重试", "error")` 提示用户，避免 unhandled promise rejection。
- **custom cron 校验**：`canSave` 增加条件 `scheduleType !== "custom" || cronExpression.trim() !== ""`，选「自定义 Cron」但未填表达式时保存按钮禁用。
- 测试新增 4 例：Escape 关闭渠道选择器、点击外部关闭、custom 未填 cron 禁用/填写启用、保存失败弹出错误 toast。
- 影响范围：仅修改 2 个组件文件 + 2 个测试文件，不改已有业务逻辑。

## 2026-08-15 — feat(scheduler): TaskPromptComposer + TaskEditForm 任务编辑表单

### 变更

- 新建 `packages/frontend/src/components/automation/TaskPromptComposer.tsx`：任务指令富文本输入框。按下 `@` 键弹出已连接 IM 渠道列表（从 `useChannelsStore` 的 bots 按 status=="connected" 过滤），选中后把光标前最近一个 `@` 替换为 `@botId`（与后端 `@bot_xxx` 解析约定一致）；`$ 插入技能` / `@ 关联 IM 渠道` 提示行。
- 新建 `packages/frontend/src/components/automation/TaskEditForm.tsx`：定时任务新建/编辑完整表单。editingTask===null 为新建、否则回填字段；含任务名、计划时间（daily/weekdays/weekly/monthly/custom 五种调度 + 对应 time/dayOfWeek/dayOfMonth/cron 控件）、执行角色（智能体，从 `useAgentsStore.list` 渲染，选中态高亮）、任务指令（内嵌 TaskPromptComposer）、工作目录（从 `useProjectsStore.projects` 渲染）；必填项（名称/智能体/指令）齐全后保存按钮才启用；保存调用 store 的 createTask/updateTask，取消调用 setView("detail")。
- 新建测试 `TaskPromptComposer.test.tsx`（3 例）、`TaskEditForm.test.tsx`（6 例）：bun:test + @testing-library/react，mock 全部 store，覆盖渲染、@ 弹渠道、选中插入、新建/编辑保存、禁用态、取消。
- 与简报的关键偏差（均已校正）：① 简报用 `useAgentsStore().agents` + `agent.id`，实际 store 字段为 `list` 且 `AgentConfig` 以 `displayName` 为唯一标识（无 id），故 agentId 取 `agent.displayName`；② CSS 变量 `--border-color`/`--accent-bg` 在 styles.css 中不存在，项目用 `--hairline`/`--accent-soft`，已替换；③ 简报测试用 vitest+jest-dom，本仓库统一 bun:test，沿用 AutomationSidebar.test.tsx 约定；④ 工作目录 select 简报为占位，实际接入 `useProjectsStore`。
- 影响范围：纯新增两个组件 + 测试，不改已有业务逻辑；组件尚未挂载到父视图（挂载属后续任务）。

## 2026-08-14 — fix(kernel): 切换智能体后立即发消息报「会话未启动」

### 变更

- 根因：`switchAgent` 里 `_teardownSession`（删除 sessions 条目）之后、`starting.set`（并发创建锁）之前，夹着 `await setSessionAgent` 的异步文件 I/O。该窗口内 sessions/starting 均为空，用户切换角色后立即发消息会触发 `ensureStarted` 启动第二个 `_createSession`，两个 pi 进程并发创建同一 jsonl 冲突失败，最终 `prompt` 报「会话未启动」。
- 修复：把 `setSessionAgent` 移到 `_teardownSession` 之前，使 teardown → `_createSession` → `starting.set` 成为连续同步段（原子），并发 `ensureStarted` 命中 `starting` 复用同一创建 promise。
- 影响范围：`agent-manager.ts`（switchAgent 顺序调整）、`agent-manager.test.ts`（+1 竞态回归用例）。

---

## 2026-08-14 — feat(scheduler): 侧边栏自动化 Tab + AutomationSidebar 任务列表组件

### 变更

- 修改 `packages/frontend/src/components/Sidebar.tsx`：tab 类型从 `"tasks" | "im"` 扩展为 `"tasks" | "im" | "automation"`；分段控件由 2 个按钮改为遍历 3 个 tabKey 渲染（testid 统一为 `sidebar-tab-${tabKey}`）；条件渲染新增 `tab === "automation"` 分支挂载 `<AutomationSidebar />`。
- 新建 `packages/frontend/src/components/automation/AutomationSidebar.tsx`：紧凑任务卡片列表组件。useEffect 调用 `loadTasks` 拉取任务；工具栏显示任务数 + 「+ 新建」按钮（startCreate）；列表项为 TaskCard（选中态高亮、启用/禁用圆点、调度文案、含 @bot_ 的任务显示 📨 角标）；空态「暂无定时任务」；`formatSchedule` 支持 daily/weekdays/weekly/monthly/custom 五种调度文案。全部走项目既有 CSS 变量设计 token。
- 新建 `packages/frontend/src/components/automation/__tests__/AutomationSidebar.test.tsx`：3 个组件测试（渲染任务列表、点击卡片调用 selectTask、点击新建调用 startCreate）。注：简报原文用 vitest + jest-dom，本仓库统一用 bun:test（14 个既有组件测试约定）且未装 jest-dom，故断言改用 `toBeTruthy()`。
- 修改 `packages/frontend/src/i18n/locales/{zh,en}.ts`：新增 `sidebar.tabAutomation`（中文「自动化」/ 英文「Automation」），与既有 tabTasks/tabIm 结构一致。
- 修复 `AutomationSidebar.tsx` CSS 变量名（代码审查反馈）：`--accent-bg` → `--accent-soft`、`--success-bg` → `--success-soft`，与项目设计 token 一致（styles.css 定义的是 `*-soft` 后缀，`*-bg` 不存在会导致选中态高亮与 IM 角标背景回退 transparent）。
- 影响范围：定时任务系统的前端入口；纯新增组件 + Sidebar 加一个 tab + 两条 i18n key，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): robot_push 工具 + @channel 解析 + ChannelManager.pushToChannel

### 变更

- 新建 `packages/kernel/src/tools/robot-push.ts`：`parseChannelMentions(prompt)` 纯函数（正则 `/@bot_[a-zA-Z0-9_-]+/g` 提取 @bot_xxx 渠道 ID、去重、不误匹配邮箱）+ `createRobotPushTool(deps)` 工厂（构建 robot_push 工具定义，动态填充 channel enum；execute 校验渠道、调用 pushToChannel、经 onPushResult 回调上报结果）。
- 修改 `packages/kernel/src/channel-manager.ts`：新增 `pushToChannel(botId, message)` 方法——按 credentials.botId 反查 channelId 再取 adapter，主动推送 sendText 的 replyFrame 传 null。
- 新建 `packages/kernel/tests/robot-push.test.ts`：16 个测试覆盖 parseChannelMentions（单/多/去重/邮箱/连字符下划线）、工具定义（name/description/enum/required）、execute（成功/渠道不存在/推送失败）、pushToChannel 集成（replyFrame=null/botId 不存在/渠道未连接）。
- 影响范围：定时任务系统的主动推送能力；纯新增工具 + ChannelManager 新增方法，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): REST API 路由（CRUD + 立即执行 + 执行记录查询）

### 变更

- 新建 `packages/kernel/src/routes/scheduler.ts`：闭包工厂 `createSchedulerRoutes(tasksFile, recordsFile, onTaskChanged, onTaskDeleted, onRunNow)` 返回 `RouteRegistrar`，注册 6 个端点（GET/POST/PUT/DELETE `/api/scheduled-tasks`、POST `/:id/run`、GET `/api/execution-records`）。直接读写 scheduler-store JSON 文件，不走 callApi 适配器（scheduler 域无 WSClientEvent）。GET records 支持 taskId/status 筛选、startedAt 倒序、最多 200 条。
- 修改 `packages/kernel/src/ws-server.ts`：导入常量与 createSchedulerRoutes；新增 `scheduler: TaskScheduler | null` 属性（后续任务注入实例）；在 `registerRoutes()` 中注册路由，回调使用可选链（`this.scheduler?.`），scheduler 为 null 时 CRUD 仍正常（数据持久化不受影响），仅跳过 cron 同步。清理两个预存未使用导入（AgentName / WA_PI_DIR）。
- 新建 `packages/kernel/tests/routes-scheduler.test.ts`：7 个测试覆盖空列表、完整 CRUD、404、三个回调触发、执行记录筛选/倒序/200 上限。
- 影响范围：定时任务 REST API 层；纯新增路由 + ws-server 注册，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): 定时任务类型定义 + 数据持久化层 + Bun.cron 调度引擎

### 变更

- 新增定时任务核心类型（ScheduledTask / TaskSchedule / ExecutionRecord / ExecutionStatus / PushResult）于 `packages/shared/src/types.ts`。
- 新增路径常量 `SCHEDULED_TASKS_FILE` / `EXECUTION_RECORDS_FILE` 于 `packages/shared/src/constants.ts`（参照 CHANNELS_FILE 模式，带 WA_PI_DIR 前缀）。
- 新建 `packages/kernel/src/scheduler-store.ts`：JSON 文件读写持久化层（load/save scheduledTasks + executionRecords，appendExecutionRecord），参照 channel-store.ts 的 readJson/writeJson 模式，文件缺失/损坏回退空值不抛错。
- 新建 `packages/kernel/tests/scheduler-store.test.ts`：6 个测试覆盖空文件回退、往返一致、追加记录。
- 新建 `packages/kernel/src/scheduler.ts`：调度引擎。`toCronExpression` 将 TaskSchedule 转标准 5 字段 cron 表达式（`.map(Number)` 归一化前导零）；`TaskScheduler` 类封装 Bun.cron 任务的注册/取消/停止，handler 内捕获执行异常并广播 `scheduled-task:completed` 事件。
- 新建 `packages/kernel/tests/scheduler.test.ts`：14 个测试覆盖 toCronExpression 五种类型 + TaskScheduler 注册/取消/重新调度/批量停止/启动加载/disabled 跳过/执行成功与失败广播。
- 影响范围：定时任务系统基础层与调度引擎（后续任务的地基）；纯新增，不改已有业务逻辑。

## 2026-08-14 — fix(frontend): 任务 7 审查修复（onReconnect 补 loadContacts + titleOf 复用 remarkOf + 补测试）

### 变更

- `App.tsx` 的 `onReconnect` 回调补 `useContactsStore.getState().loadContacts()`，对齐「mount 加载集 == 重连刷新集」不变量，避免 SSE 断线期间 contacts:changed 丢失导致重连后备注名陈旧。
- `ImConversationList.titleOf` 复用 `store/contacts` 的 `remarkOf` 纯函数，删除内联重复的 `.find(...)`。
- 新增 `ImConversationList.test.tsx`，覆盖单聊命中 remark / 群聊命中 remark / 未命中回退三场景。
- 影响范围：App.tsx、ImConversationList.tsx、ImConversationList.test.tsx（新增）。

---

## 2026-08-14 — feat(frontend): IM 会话列表备注名回显 + contacts:changed SSE 刷新

### 变更

- `ImConversationList` 的 `titleOf` 改为备注名优先：单聊按 person(userId=fromUserId)、群聊按 group(chatId=chatId) 查找对应 `ContactEntity` 的 remark，命中则显示备注名，否则回退原逻辑（群聊「群聊(chatId前8)·发送者」/ 单聊 userid）。
- `App.tsx` 启动加载 effect 补 `loadContacts()`（供会话列表回显）；`onMessage` switch 在 `channel-conversations:changed` 后新增 `contacts:changed` case，触发重拉通讯录。
- 影响范围：ImConversationList.tsx（titleOf + import useContactsStore）、App.tsx（启动加载 + SSE case）。

---

## 2026-08-14 — fix(frontend): ContactsPanel 打开时加载通讯录 + 补充备注名优先/失败 toast 测试

### 变更

- `ContactsPanel` 新增 `useEffect`，打开面板（或 channelId 变化）时调用 `loadContacts()`，修复 store 初始为空导致面板恒显示「暂无对话过的人/群」的问题（此前 `loadContacts` 解构后从未调用）。
- `ContactsPanel.test.tsx` 补两个用例：「备注名优先显示（remark 覆盖原始 userId）」与「重命名失败 toast 收到 error 消息」；新增 `useToastStore` 的 `mock.module` 以便断言失败 toast。
- 影响范围：ContactsPanel.tsx（+useEffect）、ContactsPanel.test.tsx（+2 用例 + toast mock）。

---

## 2026-08-14 — feat(frontend): 通讯录滑出面板 + 行内展开重命名 + BotsSection 入口

### 变更

- 新增 `ContactsPanel` 组件：通讯录滑出面板，按 channelId 过滤当前机器人的联系人，分「人/群」两类展示；点击行内展开输入框，保存调用 `renameContact(id, remark)`，失败用 toast 提示。
- `BotsSection` 集成：编辑表单顶部新增「通讯录」按钮（`contactsOpen` state），选中机器人时打开对应面板。
- 新增组件测试 `ContactsPanel.test.tsx`（mock `useContactsStore`，覆盖渲染人/群两类 + 行内展开重命名保存）。
- 影响范围：ContactsPanel.tsx（新增）、BotsSection.tsx（+4 处）、ContactsPanel.test.tsx（新增）。

---

## 2026-08-14 — fix(kernel): contacts:rename 空值保护 + 事件级测试

### 变更

- ws-server `contacts:rename` 去除 `channelManager!` 非空断言：channelManager 为 null 时返回 error + 400「通讯录未启用」，对齐 channels 写操作的空值兜底，避免 `PUT /api/contacts/:id` 在通讯录未启用时 500。
- 新增 ws-server 事件级测试 `ws-server-contacts.test.ts`：覆盖 rename 空值 400 / id 不存在 404 / 成功广播 `contacts:changed` + reply `contacts:current`（且只含该机器人的 contacts）三条路径。
- 影响范围：ws-server.ts（contacts:rename case）、ws-server-contacts.test.ts（新增）。

---

## 2026-08-14 — feat(kernel): 进站采集通讯录 + ChannelManager 暴露 listContacts/renameContact

### 变更

- ChannelManager 进站（handleInbound）采集通讯录：单聊记 person（fromUserId）、群聊记 group（chatId），失败仅 warn 不阻断消息处理。
- deps 新增 `contactsFile` 字段 + `contactsFile` getter（缺省回落 CONTACTS_FILE）。
- 新增公开方法 `listContacts(channelId?)` / `renameContact(id, remark)`，代理 contact-store 的 list/rename。
- 影响范围：channel-manager.ts（+5 处）、channel-manager.test.ts（+1 采集用例，复用 mock deps 构造）。

---

## 2026-08-14 — fix(desktop): 外链子窗口移除 parent，修复 macOS 多屏拖动消失

### 变更

- 外链子窗口（openInChildWindow）创建时移除 `parent: mainWindow`：macOS 上带 parent 的 child window 拖到不同缩放的扩展显示器会消失（Electron #31815，官方 workaround 即移除 parent）。
- 补偿移除 parent 后缺失的 owned-window 跟随行为：新增 `childWindows` 集合追踪所有子窗口，主窗口收起（关闭→隐藏到托盘）时同步隐藏所有子窗口，子窗口关闭时从集合移除。
- 影响范围：main.cjs（openInChildWindow + close 处理器）、web-preferences.test.ts（+2 防回归用例：不再出现 parent、主窗口收起时同步隐藏子窗口）。

---

## 2026-08-14 — feat(frontend): 新建会话页新增右侧文件浏览侧栏

### 变更

- 新建会话页（NewSessionPane）新增右侧文件树侧栏：复用 ExplorerPanel（文件浏览/双击预览/拖拽 @提及），右侧可拖拽宽度（SidebarResizer），主列居中内容与侧栏并排。
- 双入口 toggle：主列右上角 folder 图标开关（未选项目时禁用）+ 侧栏标题栏 › 折叠按钮，与会话页文件树开关行为一致；状态独立持久化（localStorage `wa-pi:new-session-explorer-open/width`），默认收起。
- 侧栏根目录跟随当前选中项目 cwd；未选项目时入口禁用 + 空态兜底。
- 影响范围：NewSessionPane.tsx（布局改造 + 开关/侧栏）、新增 store/new-session-explorer.ts、新增 new-session-explorer.test.tsx（4 用例）。

---

## 2026-08-13 — feat(frontend): 文件预览底部地址栏增加复制按钮

### 变更

- 新增 `PathBar` 组件：文件预览底部地址栏（完整路径 + 复制 icon）。点击复制路径到剪贴板，复用 `copyToClipboard` + toast 反馈（与 CodeBlockCard 一致）。
- 三处接入：代码预览、markdown 预览、unsupported 不支持预览页。unsupported 分支结构调整（外层 flex-col h-full + 内层居中内容 + 底部贴 PathBar），使地址栏贴底全宽。
- unsupported 页操作按钮顺序调整：「关闭」移到最右（用默认应用打开 → 在访达中显示 → 关闭）。
- 影响范围：FileViewer.tsx（新增 PathBar + 三处接入 + unsupported 结构 + 按钮顺序）、FileViewer.test.tsx（+2 复制用例：代码预览复制路径、unsupported 也有复制按钮）。

---

## 2026-08-13 — style(frontend): 「不支持预览/读取失败」空状态页按钮改为无边框幽灵风格

### 变更

- FileViewer 的 unsupported / error 空状态页操作按钮原复用顶栏紧凑 `fv-btn`（24px 工具按钮、细灰边框），在空状态页显丑。新增 `fv-empty-btn` 类：32px 高、圆角 8px、无边框透明底，hover 显浅灰底；三按钮统一无主次（方案 B，用户选定）。
- 顶栏工具栏、会话视图等处的 `fv-btn` 不受影响（仍为紧凑工具按钮）。
- 影响范围：styles.css（新增 `.fv-empty-btn`）、FileViewer.tsx（unsupported 3 按钮 + error 1 按钮换 class）、FileViewer.test.tsx（2 处 className 断言同步更新）。

---

## 2026-08-13 — feat(frontend): 最近视图补齐会话右键菜单（重命名/删除/打开目录）

### 变更

- 「最近」视图的会话行补上与项目视图一致的右键菜单：重命名、删除、打开目录（所有会话均可「在访达/文件管理器中打开」，非系统项目打开项目根目录、系统项目打开会话子目录）。
- 复用 ProjectItem 的 `useClampMenu`（由私有改为导出）做菜单坐标钳制，复用 `project-menu-close` 事件做跨组件菜单互斥。
- RecentSessionsList 增加重命名弹窗（Modal）与删除确认框（ConfirmDialog），删除时同步清理 composer 草稿与会话内存态（removeSessionPrefs + removeSession）。
- 影响范围：RecentSessionsList.tsx、ProjectItem.tsx（导出 useClampMenu），及 RecentSessionsList.test.tsx（新增 5 个右键菜单用例，含 api mock）。

---

## 2026-08-13 — feat(frontend): 侧边栏重构——智能体置顶、最近视图新建入口、项目/最近虚线分段

### 变更

- **布局重排**：侧边栏顶部顺序调整为「智能体折叠项 → 任务|IM 页签」，将智能体折叠项移出页签分支、置于页签控件之上（跨任务/IM 两页签始终可见）。
- **移除独立新建会话按钮**：删除 `NewSessionButton` 组件（含测试），新建会话入口迁入「最近」视图。
- **「最近」视图新建入口**：时间线顶部「今天」刻度改为**始终显示**（即使当天无会话），右侧放「＋ 新建会话」文字入口（右对齐），点击触发 `onNewSession`，与原按钮行为一致。
- **项目/最近虚线分段**：「项目 | 最近」次级分段控件由实心灰底改为虚线边框（`1px dashed var(--hairline-strong)`），中间虚线竖线分割，选中态用文字加粗（无底色），与「任务 | IM」实心分段形成视觉层级区分。
- **i18n**：`recentSessions` 新增 `newSession` 键、精简 `empty` 文案（中英）。
- 影响范围：Sidebar.tsx、RecentSessionsList.tsx、src/util/recentSessions.ts（导出 startOfDay）、i18n locales，删除 NewSessionButton.tsx / NewSessionButton.test.tsx，及对应测试。

---

## 2026-08-13 — feat(frontend): 侧边栏会话列表位置动画（最近视图 + 项目视图）

### 变更

- 引入 `@formkit/auto-animate`：侧边栏会话重排时播放位置过渡动画（250ms ease-out），替代 DOM 瞬间换位的「闪一下」。默认禁用，仅在用户点击触发的重排时启用（后台 SSE 推送不动画）。
- **「最近」时间线**：点击会话触发重排时动画；日期刻度提升为动画容器直接子元素（稳定 key），避免刻度在重排时瞬移闪烁。
- **项目视图**：重排时机从「折叠→展开」改为「点击项目名」（含折叠时点击展开、已展开时点击选中），点击会话仍保持稳定顺序不重排；提取 `orderSessions` 纯函数（稳定顺序 + 新会话插入 + 强制重排）。
- 清理 `agentList` 死 i18n 键（折叠后仅保留 sectionTitle）。
- 影响范围：RecentSessionsList.tsx、ProjectItem.tsx、src/util/projectOrder.ts、SessionRow.tsx、i18n locales，及对应测试。

---

## 2026-08-13 — fix(frontend): 新建页选模型发送后会话界面显示旧模型（existed 分支模型丢失）

### 变更

- **问题**：在新建会话界面选了模型 A，发送消息跳转到会话界面后，会话界面的模型选择器显示的是上一次使用的模型 B（而非 A），但实际发送请求用的却是 A。
- **根因**：`NewSessionPane` 选模型时通过 `setSessionPrefs(草稿id, { model })` 把模型写入草稿 sessionId。发送时若草稿 id 残留了一个已发送过的会话 id（`existed` 分支触发），`finalId` 会分叉成全新随机 id，模型 A 留在 `bySession[草稿id]` 下；而详情页 `Composer` 读的是 `bySession[finalId]`（为空），只能回退到全局 `defaults.model`——一旦 defaults 是上一次的模型 B，就会显示 B。
- **修复**：`handleSend` 发送时在 `setDefaults` 之后，把用户选的模型显式落到 `finalId` 的会话级 prefs（`setSessionPrefs(finalId, { model })`），消除对 defaults 回退的依赖，确保详情页直接读到 A。
- **影响范围**：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`（新增 existed 分支回归测试）。

---

## 2026-08-13 — fix(desktop): 换端口启动按钮两个 bug——端口未切换 + 按钮并排

### 变更

- **Bug 1（换端口未生效）**：`app.relaunch({ env })` 在 Windows 上环境变量替换不可靠，新进程仍读到旧端口。修复：改用命令行参数 `--wa-pi-port=<port>` 传递新端口（env 双保险），`FIXED_PORT` 解析优先级改为 `--wa-pi-port 参数 > WA_PI_WS_PORT env > 默认 9778`；重复 relaunch 时先过滤旧参数避免残留旧值。
- **Bug 2（按钮并排）**：错误态两个按钮在 flex column 容器里仍可能横向排列。修复：包 `.actions` flex column 容器 + `gap:10px` 明确上下排列。
- **测试**：port-switch.test.ts 新增 4 个（resolveFixedPort 参数/env/默认/重复过滤），splash-html 回归通过；全套 146 pass（2 fail 为预先存在的打包签名测试）。

## 2026-08-13 — feat(desktop): 端口自愈失败时提供「换端口启动」+「退出」选项

### 变更

- **问题**：启动时固定端口 9778 被占用且自动清理失效时，splash 错误态只有「重启应用」按钮；若清理后仍被占用（幽灵句柄），用户无任何操作途径（splash 无边框、无标题栏，只能任务管理器强杀）。
- **方案**：把「重启应用」替换为「换端口启动」（从 9778 下一个端口找可用端口，relaunch 带 WA_PI_WS_PORT 环境变量），并新增「退出」按钮。
- **改动**：
  - 新增 `util/splash-html.cjs`：启动页 HTML 生成提取为纯函数（buildSplashHTML），错误态按钮改为 switch-port-btn + quit-btn，__showRestart 替换为__showActions({switchPort, quit})
  - 新增 `util/port-switch.cjs`：pickSwitchPort（从 basePort+1 找可用端口，纯函数）
  - `main.cjs`：buildSplashURL 改用 buildSplashHTML；新增 ipc handler `app:switch-port-start`（findAvailablePort + relaunch 带 env）与 `app:quit`；selfHealFailed 与 restart-after-port-kill 清理后仍占用分支均显示换端口/退出按钮
  - `preload.cjs`：waPiApp 新增 switchPortStart / quit
  - 前端零改动（同源相对路径，换端口后 loadURL 指向新端口即可）
- **注意**：换端口后 IndexedDB origin 改变，跨 origin 数据不可见（沿用原有固定端口注释的说明）。
- **测试**：splash-html.test.ts 6 个（按钮存在性/替换语义/__showActions/点击绑定）+ port-switch.test.ts 2 个（从 basePort+1 找端口/找不到返回 null），全通过；startup-heal / port.cjs 回归 18 个通过。

## 2026-08-13 — feat(desktop): 首启按需下载 Node.js 运行时，解决无 node 环境 MCP npx 报错

### 变更

- **问题**：打包版只捆绑 bun（wa-pi-kernel.exe），从不捆绑 node。用户未安装 node 时，MCP 服务器通过 `npx -y <package>` 启动会报错（`"node" is not recognized` / npx-resolver 30s 卡顿 / POSIX shim 无法执行等）——MCP 服务器是第三方进程，其内部对 node 运行时的依赖无法通过 bun 兼容性兜底解决。
- **方案**：首启时检测系统 node，无系统 node 则自动下载 Node.js LTS（v22.23.2）到 `~/.pi/agent/node/`。通过 IP 地理位置检测（api.country.is）自动选择下载源：国内用户优先 npmmirror，国外用户优先 nodejs.org。下载的 node 自带完整 npm/npx。
- **改动**：
  - 新增 `packages/desktop/src/util/node-runtime.cjs`：IP 检测（detectIsCN）+ 下载源选择 + node LTS 下载/解压/版本管理（ensureNodeRuntime）
  - `main.cjs` 启动流程新增 2b+) 步骤：在首启依赖安装（2c）前检测/下载 node，splash 显示进度
  - `ensureRuntimeBinLinks` 改造：有真实 node 时 binDir 只生成 bun.cmd（避免 bun x 包装脚本遮蔽 node 自带的 npm/npx），node/npm/npx 由下载的 node 目录自带，PATH 追加 binDir + nodeDir
  - 无 node（下载失败）时保持现有 bun fallback 行为不变
- **影响范围**：`packages/desktop/src/util/node-runtime.cjs`（新增）、`packages/desktop/src/main.cjs`（ensureRuntimeBinLinks + 启动流程）
- **验证**：单元测试 21/21 + E2E 2/2 全通过——IP 检测 CN → npmmirror 下载 34MB → 解压 → node v22.23.2 / npm 10.9.8 / npx 10.9.8 全部可用；端到端 `npx -y @modelcontextprotocol/server-filesystem` 成功启动

## 2026-08-13 — fix(kernel): RPC 模式 custom() 挂根治——bridge 扩展 session_start patch

### 变更

- **问题**：输入 `/mcp`（或任何调用 `ctx.ui.custom()` 的扩展命令）后 pi 进程永久挂起——不回 response、不发事件，wa-pi 无限等待直到 60s RPC 超时。此问题影响所有用 custom() 全屏面板的插件，非 pi-mcp-adapter 个例。
- **根因**：pi RPC 模式的 `ctx.ui.custom()` 原生实现返回 `undefined` 且不调用 factory 回调。扩展命令 handler（如 openMcpPanel）在 `await new Promise(resolve => ctx.ui.custom(factory))` 中永久挂起。
- **修复**：wa-pi-bridge 扩展在 `session_start`（bindExtensions 设好共享 uiContext 之后触发）时，将 `uiContext.custom()` 替换为**先 notify 再同步抛出**。效果链：
  - `custom()` 调用时先 `ui.notify(msg, "warning")` → 前端 extension_notify 已对接：**聊天窗口中间居中显示，30s 后自动消失**
  - 再同步 `throw` → handler throws → `_tryExecuteExtensionCommand` catch → `extension_error` 事件（补充提示）
  - 同时 `preflightResult(true)` 正常触发 → prompt 成功返回
  - `session_start` 在每次 bindExtensions（启动/new_session/switch_session/reload）后都触发，patch 自动重应用
- **设计原则**：零超时（同步 throw，ms 级反馈）、零白名单（覆盖所有插件的 custom() 调用）、零第三方源码修改（仅 wa-pi 自有 bridge 扩展运行时 patch）。
- 影响范围：packages/kernel/src/wa-pi-bridge.extension.ts、packages/kernel/tests/bridge-extension.test.ts。

## 2026-08-12 — fix(frontend): 文件浏览器暗色模式适配

### 变更

- **ExplorerPanel / 公共按钮 fv-btn / token 胶囊**：迁移悬空 CSS 变量（`--bg-secondary`/`--bg-tertiary`/`--border` → `--surface-hover`/`--surface-elevated`/`--hairline`/`--accent`）。此前这些变量从未定义，hover 背景、按钮边框在浅色和暗色下都实际失效；迁移后恢复生效并跟随主题。
- **DirTreePicker（选目录弹窗）**：移除硬编码颜色（面板 `#FFFFFF`、按钮 `#1D1D1F` → `bg-surface`/`bg-brand text-white` 主按钮范式）；清理旧 Tailwind 死类（`text-text`/`bg-surface0`/`border-surface0`/`text-subtext`/`text-blue`/`border-blue`/`border-t-blue` → `text-primary`/`bg-surface-elevated`/`border-hairline`/`text-secondary`/`text-brand`）；第三方树组件 react-complex-tree 的选中/悬停/选中竖条改用项目 token（自动跟随深浅色与 6 色主题），并覆盖库内层 button 背景为透明，暗色下选中态统一为品牌软背景。
- **FilePicker（附件文件选择器，对话界面 📎）**：同 DirTreePicker 修复集——移除硬编码颜色（面板/确定按钮）、清理死类、TREE_STYLES 改用项目 token + 覆盖库选中 button 层（修复暗色下选中目录「亮灰底 + 白字不可读」）、复选框 `accent-blue` → `accent-brand` 跟随主题色。
- **验证**：新增 DirTreePicker（6 用例）与 ExplorerPanel（3 用例）组件测试；单测全量回归 927 pass；typecheck 通过；E2E 60 pass（15 个既有失败与本次改动无关）；dev 环境浅色/暗色 computed style 逐项验证 token 生效。
- 影响范围：packages/frontend/src/styles.css、packages/frontend/src/components/DirTreePicker.tsx、packages/frontend/src/components/DirTreePicker.test.tsx、packages/frontend/src/components/ExplorerPanel.test.tsx、packages/frontend/src/components/ui/FilePicker.tsx。

## 2026-08-12 — feat(frontend/kernel): 文件不支持预览时新增「默认方式打开」按钮（系统默认应用打开文件）

### 变更

- **需求**：文件预览器不支持预览时，在「在访达中打开」旁新增「默认方式打开」按钮，点击后用系统默认应用打开文件本身（等同双击）。
- **实现**：
  - kernel `routes/fs.ts` 新增 `POST /api/fs/open-with-default-app`（expandTilde + ENOENT 回退搜索，与 reveal-file 一致；打开文件本身而非目录）；提取 `defaultOpenCommand`（mac open / win start / linux xdg-open）。
  - 安全修复：`spawnOpen` 替代 `spawn(..., { shell: true })`——参数数组传递不经 shell（用户路径含特殊字符无注入风险），Windows `start` 经 `cmd /c` 调用；reveal-file 同步收敛。
  - 前端 `fs-client.ts` 新增 `openFileWithDefaultApp`；`FileViewer.tsx` unsupported 分支新增按钮（testid `fv-open-default`）；i18n `common.openWithDefaultApp`（zh 默认方式打开 / en Open with Default App）。
- **验证**：TDD 三红灯（kernel defaultOpenCommand、fs-client 请求、FileViewer 按钮）→ 绿灯；真实 HTTP 路由验证（缺 path 400、不存在 ENOENT，不触发真实 open）；typecheck 通过；前端全量 1415 测试（顺带修复 VersionTimeline 测试断言数据过期，pre-existing）。
- 影响范围：packages/kernel/src/routes/fs.ts、packages/frontend/src/{fs-client.ts,components/blocks/FileViewer.tsx,i18n/locales/{zh,en}.ts} 及对应测试。

## 2026-08-12 — fix(frontend): 系统设置>文字大小不生效于聊天窗口 markdown 正文（.prose-sm 固定字号覆盖）

### 变更

- **根因**：设置值写入 localStorage（wa-pi-ui-prefs）与 CSS 变量 `--font-scale` 更新均正常，但聊天窗口 assistant 消息正文走 `@tailwindcss/typography` 的 `.prose-sm`，插件声明固定 `font-size: .875rem`（不引用 `--font-scale`），覆盖了外层气泡的缩放字号。用户消息气泡/输入框均正常，唯独 markdown 正文不跟随。
- **修复**：styles.css「文字大小缩放」区新增 `.prose-sm { font-size: calc(0.875rem * var(--font-scale)); }`（layer 外、后出现，覆盖插件规则）。只覆盖 `.prose-sm` 不动 `.prose` 基类——TextBlock（ask 预览，prose 无 prose-sm）靠 `.text-sm` 覆盖缩放，避免字号从 14px 变 16px。
- **影响面**：聊天窗口 markdown 正文、文件预览器、回收站查看器、导出图片（prose-sm 均跟随）；TextBlock/输入框不受影响。
- **验证**：TDD——新增 styles-font-scale.test.ts 字符串断言（修复前红）；前端全量 1328 pass / 0 fail；vite build 产物确认覆盖规则位于插件规则之后（层叠胜出）；happy-dom 层叠验证 `--font-scale=1.25` 时字号计算为 `calc(.875rem * 1.25)`。
- 影响范围：packages/frontend/src/styles.css、tests/styles-font-scale.test.ts。

## 2026-08-12 — feat(desktop): 外链子窗口加地址栏（显示/复制/修改地址后导航）

### 变更

- **背景**：外链在应用内新窗口打开后，用户无法看到当前地址、无法复制或修改跳转。
- **实现**（packages/desktop）：
  - 新增 `src/assets/link-window.html` 地址栏壳页面：地址输入框（回车/前往导航）、复制按钮（waPiClipboard）、导航结果回显；用户编辑过地址后不再被导航覆盖（edited 标记）。
  - `main.cjs` 的 `openInChildWindow` 改为 BrowserWindow 壳（加载地址栏 HTML，挂 preload）+ `WebContentsView` 承载网页内容（sandbox 开启、不挂 preload，外部内容保持隔离）；resize 时同步内容区 bounds；`did-navigate`/`did-navigate-in-page` → 地址栏回显；IPC `linkwin:load/ready/url-changed`，多子窗口并发按 sender 隔离；`normalizeUrl` 补协议并只放行 http/https（防 javascript:/file: 注入）。
  - `preload.cjs` 新增 `waPiLinkWin`（load/ready/onUrlChanged）。
- **验证**：桌面测试 116 pass（新增 3 个字符串断言：WebContentsView 隔离、壳+view 结构、地址栏页面交互；剩余 1 个 mac-sign 失败为既有问题）；Electron 冒烟实测全链路——初始加载同步地址、地址栏输入 → IPC → 内容导航 → 地址回显。
- 影响范围：packages/desktop/src/{main.cjs,preload.cjs,assets/link-window.html}、tests/web-preferences.test.ts。

## 2026-08-12 — fix(desktop): 外链在应用内新窗口打开；localhost 服务链接不再被拦截；子窗口统一安全配置

### 变更

- **根因**：Electron 主进程 `setWindowOpenHandler` 用 `isSelfUrl` 拦截了所有 localhost 链接，用户/agent 提供的本地服务链接（如视觉伴侣页面 `http://localhost:53213/...`）点击后被 deny、无反应；外链打开方式与产品预期不符。
- **修复**（packages/desktop/src/main.cjs）：
  - `target=_blank` / `window.open` 不再按 isSelfUrl 拦截，一律在应用内新窗口（BrowserWindow 子窗口）打开；`will-navigate` 保留 isSelfUrl 防御（无 target 导航被应用自身地址劫持时阻止，FileViewer 相对路径仍由前端拦截）。
  - 子窗口 webPreferences 补齐 `sandbox: false` + `preload`（与 splash/main 统一，修复 web-preferences 既有断言失败）。
  - 顺带清理 `ensureRuntimeBinLinks` 未使用的 runtimeDir/seedDir 参数。
- **验证**：桌面测试 114 pass（剩余 1 个 mac-sign 失败为既有问题，原实现即失败）；前端 tests/blocks + FileViewer 66 pass / 0 fail；main.cjs `node --check` 通过。
- 影响范围：packages/desktop/src/main.cjs、packages/desktop/tests/web-preferences.test.ts、packages/frontend/src/components/blocks/FileViewer.tsx（注释）。

## 2026-08-12 — fix(frontend): 主回复中反引号包裹的裸 URL 渲染为可点击链接；顺带统一 agent 消息纯文本位置的 URL 链接化

### 变更

- **根因**：主回复走 ReactMarkdown + remark-gfm，autolink 不解析行内代码（code 构造）内的文本；而 `createMarkdownComponents` 的 code 分支只处理 FilePill、其余原样渲染 `<code>`。AI 习惯用反引号包裹 URL（如 `` `http://localhost:53213/?key=...` ``），导致这类链接不可点击。
- **修复**：markdown-components.tsx 的 code 分支新增 `isLinkText`（trim 后整体匹配 `^https?://\S+$`，协议白名单防 javascript: 注入），行内代码内容是裸 http/https URL 时渲染为 MarkdownLink（新标签页 + 蓝色下划线）。
- **顺带**：新建 `blocks/linkify.tsx`（轻量 URL 链接化，不跑完整 markdown 管线），应用于 agent 消息中不走 ReactMarkdown 的纯文本位置——StreamingOutput 流式预览、ThinkingCard、ToolCallCard 工具结果；AskFormCard 选项 preview 补 remarkGfm（裸 URL 自动链接）。
- **验证**：TDD——新增 markdown-links 反引号 URL 用例（修复前失败）、linkify 8 用例、StreamingOutput 流式 URL 用例、AskFormCard 裸 URL 用例；tests/blocks 56 pass / 0 fail。
- 影响范围：packages/frontend/src/components/blocks/{markdown-components,linkify,StreamingOutput,ThinkingCard,ToolCallCard}.tsx、components/ask/AskFormCard.tsx，及对应测试。

## 2026-08-12

### 新增

- 侧边栏「任务」视图内新增「项目 | 最近」分段切换：「最近」按时间线汇总全部项目会话（按天刻度分组、标注项目名、上限 100 条、点击后停留在最近视图）
- 智能体列表折叠为一行「智能体 n ›」，点击打开智能体宫格弹窗
- `SessionRow` 支持可选 `subtitle` 次级标注

## 2026-08-12 — fix(frontend): AskQuickBar 滚轮横向滚动改用原生 passive:false 绑定，消除 preventDefault 警告

### 变更

- **根因**：AskQuickBar 选项区用 React 合成 `onWheel` 调 `e.preventDefault()` 阻止页面纵向滚动。React 的 wheel 监听器注册为 passive，preventDefault 无效且控制台报 `Unable to preventDefault inside passive event listener invocation`——实际拦不住页面滚动。
- **修复**：改为 `useEffect` 中原生 `addEventListener("wheel", handler, { passive: false })`（与 MermaidBlock/FileViewer 滚轮缩放一致），preventDefault 生效，页面纵向滚动被拦截、选项区横向滚动。
- **验证**：TDD——新增测试验证 wheel 用原生绑定且非 passive（happy-dom 把 `{passive:false}` 规范化为布尔 false，断言兼容）；AskQuickBar 15 pass / AskDock+AskFormCard 25 pass / typecheck 无错误。
- 影响范围：packages/frontend/src/components/ask/AskQuickBar.tsx。

## 2026-08-12 — feat(ask): 便签选项区支持鼠标滚轮横向滚动

### 变更

- **新增**：单行便签（AskQuickBar）选项区监听滚轮——纵向 `deltaY` 转换为横向滚动（向下滚向右、向上滚向左），并阻止页面纵向滚动；无溢出时不拦截。
- 影响范围：packages/frontend（AskQuickBar / 对应测试）。

## 2026-08-12 — fix(ask): 便签左右滚动按钮边界置灰（到最左「<」灰、到最右「>」灰）

### 变更

- **改进**：单行便签（AskQuickBar）左右「<」「>」滚动按钮——仅选项溢出时显示；滚动到最左时「<」置灰、最右时「>」置灰（`disabled` + 降透明度），边界不可继续滚动。
- 影响范围：packages/frontend（AskQuickBar / 对应测试）。

## 2026-08-12 — feat(ask): 便签改「左右 < > 滚动按钮」+ 文案简化为「需要回答：」

### 变更

- **改进**：单行便签（AskQuickBar）去掉 overlay 滚动条指示器；选项溢出时左右显示「<」「>」按钮，点击向左/向右滚动。
- **简化**：便签提示从「徽标数字 + Agent 有 N 个问题待回答」简化为「需要回答：」直接跟选项（i18n `ask.stickyShort`）。
- 影响范围：packages/frontend（AskQuickBar / i18n zh-en / 对应测试）。

## 2026-08-12 — fix(ask): 便签横向滚动条改为隐藏式（不占空间，chip 不被顶起）

### 变更

- **修复**：单行便签（AskQuickBar）选项区改用 `scrollbar-none` 隐藏原生滚动条（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`）——不占布局空间、chip 完全垂直居中，滚动能力保留（触摸板/滚轮/拖拽）。便签高度 42px。
- 影响范围：packages/frontend（AskQuickBar / styles.css / 对应测试）。

## 2026-08-12 — fix(ask): 便签态横向滚动条不再挤压 chip（增高 + 自定义细滚动条）

### 变更

- **修复**：单行便签（AskQuickBar）高度从 34px 增至 42px，容纳横向滚动条；选项区增加 `scrollbar-thin` 自定义细滚动条样式（4px 胶囊 + 底部留白），chip 垂直居中不被顶起。
- 影响范围：packages/frontend（AskQuickBar / styles.css / 对应测试）。

## 2026-08-12 — fix(ask): Ask 弹窗收起入口移入卡片 footer + 弹窗限高防顶部溢出

### 变更

- **修复**：收起弹窗回便签的入口从弹窗底部独立小按钮移到 AskFormCard footer「取消 / 提交」行最左侧（语义清晰、不易漏）。
- **移除**：AskFormCard 右上角 ✕（终止提问）按钮——取消统一走 footer「取消」，避免误触把提问终止掉。
- **修复**：展开弹窗限高 `max-h-[calc(100vh-160px)]` + 内部滚动，底边紧贴输入框上方（间距 0）；多 ask/多问题堆叠时顶部不再超出视口（此前双 ask 顶部溢出 57px），聊天上部历史消息始终可见。
- 影响范围：packages/frontend（AskDock / AskFormCard / 对应测试）。

## 2026-08-12 — feat(ask): Ask 弹窗改「折叠便签 + 悬浮展开」+ 侧边栏 pending ask 问号

### 变更

- **新增**：Ask 弹窗（AskDock）改为双态——首次默认展开为悬浮弹窗（absolute 浮层，不再挤压消息列表/聊天输出）；可收起为单行便签（AskQuickBar，内嵌全部问题的快捷选项 + 提交 icon，选项多时横向滚动）。展开/折叠状态全局持久化到 localStorage（`wa-pi:ask-dock-expanded`），重进会话恢复上次状态。
- **新增**：`buildQuickReply` 纯函数（store/ask.ts）——便签快捷选择 → 完整 AskReply（后端契约：一次提交整个 toolCallId 的全部问题）。
- **新增**：`AskFormCard` 支持 `initialSelected` 预选 prop（便签选中的选项展开后自动带过去）。
- **改进**：侧边栏会话行（SessionRow）pending ask 时显示问号 icon（替代误导的「运行中」spinner）；真正 thinking 仍显示 spinner。
- 影响范围：packages/frontend（AskDock / AskQuickBar / AskFormCard / SessionRow / Icon / store/ask / i18n）。

## 2026-08-12 — fix(frontend): thinking 生命周期职责分离——SessionView mount 不清除 thinking，回退 optimisticEcho/force 补丁

### 变更

- **根因**：`setActiveStatus(sessionId, false)` 被 SessionView mount 和 onReconnect 两个调用点共用，但语义完全不同——mount 是「查询」（isActive=false 不该清除乐观 thinking），reconnect 是「权威对齐」（isActive=false 该清除残留）。之前用 optimisticEcho 保护 + force 参数区分，本质是在错误层面打补丁。
- **修复**：SessionView useEffect 中 isActive=false 时不调 setActiveStatus（不干预 thinking）。thinking 的清除完全由 SDK 事件（agent_end / failTurn / agent_settled）驱动；onReconnect 的 setActiveStatus(false) 负责重连/重启的权威复位。职责分离，不再需要 optimisticEcho 保护 / force 参数。
- **回退**：撤回 fc7b1498 对 session.ts（optimisticEcho 保护 + force + auto_retry_end/agent_settled 清标记）和 App.tsx（force=true）的改动，恢复到 78d76310 的 setActiveStatus 原始逻辑。
- **验证**：TDD——先写 3 个失败的测试（isActive=false 不清除乐观 thinking / isActive=true 补设 / 打开历史会话不新增状态），改 SessionView.tsx 后全部通过。SessionView 34 pass / store-session 78 pass / typecheck 无错误。kernel 侧 isSessionActive 收窄（78d76310）保持不变。
- 影响范围：packages/frontend/src/components/SessionView.tsx。

## 2026-08-12 — fix(kernel+frontend): 右上角 token 统计口径修复——累计含缓存与压缩前历史，进度条改当前上下文占用

### 变更

- **背景**：右上角「累计 xxx k」本应统计整个会话累计消耗，实际只累加可见消息的 input+output：漏掉 cacheRead/cacheWrite（长会话缓存命中占大头）、compaction 压缩后丢失压缩前历史，且进度条误用「累计值 / 模型 contextWindow」当窗口占用。
- **修复**：引入 pi 官方 `get_session_stats`（全会话累计 tokens + 当前上下文占用 contextUsage），进程存活时优先；无进程降级本地全量扫 jsonl（不做压缩过滤/分支过滤，含缓存与压缩前历史）。前端分三态展示：累计胶囊 = 全量 total（含主/子代理拆分）、进度条 = contextUsage.used/total、进度条旁新增「占用 xxx k」当前窗口数值。
- **链路**：kernel `session-history.ts` 新增 `computeSessionUsage` + agent-manager `getSessionStats` + ws-server `session:stats` case + REST `GET /api/sessions/:id/stats`；前端 store `tokenTotals` 扩展 cacheRead/cacheWrite/total/main/subagent + `contextUsageBySession`，`seedTokenTotal` 优先 stats；SessionView 渲染更新。
- **验证**：session-history 29 pass（含 computeSessionUsage 3 测试）、store-session 81 pass、SessionView 31 pass。
- 影响范围：packages/kernel/src/session-history.ts、agent-manager.ts、ws-server.ts、routes/projects-sessions.ts、packages/shared/src/types.ts、packages/frontend/src/store/session.ts、components/SessionView.tsx。

## 2026-08-12 — fix(frontend): 新建会话发送后「正在思考」闪退回归——乐观回显窗口内 isActive=false 不复位 thinking

### 变更

- **背景**：上一提交把 `GET /messages` 的 `isActive` 收窄为「handle.busy 或冷启动+prompt 排队」，修复了打开历史会话误标 thinking 转圈；但新建会话发送消息时出现新回归：发送后 thinking 先出现又消失，直到 agent 开始输出才恢复。根因：新建会话时前端 ComposerInput mount 发 `GET /commands` 与 `POST /prompt` 并发，若 commands 先到 kernel 触发冷启动（`starting.has(sid)=true`）而 `_promptLocks` 尚未命中（prompt 还在路上），随后 GET /messages 返回 `isActive=false`；而 SSE 通道的 echo_user 已先到前端设置乐观 thinking + `optimisticEcho=true`。setActiveStatus(false) 照常复位，把乐观 thinking 清掉。
- **修复**：`session.ts` 的 `setActiveStatus` 增加保护——`optimisticEchoBySession[sessionId]` 为 true（用户刚发消息、等待 SDK 回显）时，`isActive=false` 不清除 thinking。回显到达（message_start user 回显 / agent_end / failTurn）清除标记后，复位逻辑恢复。kernel 侧与前端信号各司其职：kernel 判断会话是否真在处理，前端判断自己是否刚发消息。
- **验证**：store-session.test.ts 新增 2 个回归测试（乐观回显窗口内不清除 / 历史会话无标记仍正常复位）；store-session 80 pass / SessionView 13 pass / kernel 107 pass。
- 影响范围：packages/frontend/src/store/session.ts。

## 2026-08-12 — fix(kernel): 修复打开历史会话误标「正在思考」一直转圈（isSessionBusy 冷启动一刀切回归）

### 变更

- **背景**：08-11 提交 da7acb15 为修复新建会话「正在思考」闪退，把 `isSessionBusy` 改为冷启动期间（`starting.has(sessionId)`）返回 true。但 `starting` 集合被多种场景共用：打开历史会话时前端 ComposerInput 自动拉 `/commands`（getCommands）与 `session:messages` 的 prewarm 也会触发 `ensureStarted` 冷启动。冷启动期间到达的 GET /messages 因此返回 `isActive=true`，前端 `setActiveStatus(true)` 把 idle 历史会话误标 thinking；冷启动完成后仅广播 `session:activated`（只刷 token 统计），无 agent 事件复位 → 会话列表项永久转圈。
- **修复**：`GET /messages` 的 `isActive` 判定收窄为「真正在处理中（handle.busy）或冷启动中且 prompt 排队（`agent:prompt` 的 `_promptLocks` 命中）」：
  - `agent-manager.ts`：`isSessionBusy` 恢复只查 `handle.busy`；新增 `isSessionActive(sessionId, promptQueued)` 组合判定
  - `ws-server.ts`：`session:messages` 改用 `isSessionActive(sessionId, this._promptLocks.has(sessionId))`——`_promptLocks` 在 agent:prompt 处理时同步 set、冷启动在锁内执行，天然是「prompt 排队中」的精确信号
- **验证**：agent-manager.test.ts 新增/更新 2 个测试（prompt 冷启动 true / 预热冷启动 false）+ ws-server 集成测试验证 `_promptLocks` → `isActive` 传递链路；相关测试文件 60 pass / agent-manager 100 pass / 前端 store 78 pass。
- 影响范围：packages/kernel/src/agent-manager.ts、packages/kernel/src/ws-server.ts。

## 2026-08-11 — fix(kernel): pi rpc 子进程改用 Bun.spawn，避免 Windows 上子进程继承 kernel 监听端口句柄

### 变更

- **背景**：Windows 上 kernel（wa-pi-kernel.exe）被强杀/退出后，9778 端口仍以「死 PID 占 LISTENING」的幽灵形态残留，新实例自动清理失败（taskkill 退出码 128「找不到进程」）。根因：`rpc-client.ts` 用 `node:child_process.spawn`（CreateProcess bInheritHandles=TRUE）启动 pi rpc 子进程，Bun.serve 的监听 socket 句柄可继承（见 port.cjs 幽灵占用注释）——kernel 被杀后，仍存活的 pi 子进程/孙进程（bash 等）继续持有 9778 句柄，netstat 却显示已死的创建者 PID。
- **修改**：`packages/kernel/src/rpc-client.ts` 默认 spawn 实现从 `node:child_process.spawn` 改为 `Bun.spawn`（Windows 上只经 HANDLE_LIST 传递 stdio 句柄）：
  - 移除 spawn/exit/error 事件监听，改用 `Subprocess.exited` Promise + 同步 `signalCode`/`exitCode`
  - stdout/stderr 用 `Readable.fromWeb` 转回 Node 流，复用既有 strict JSONL 切分逻辑
  - spawn 同步失败（ENOENT）直接 throw，语义与旧 error 事件一致
  - stdin 写入适配 FileSink（pipe 时即时送达，无需显式 flush）
- **验证**：rpc-client.test.ts 17/17 pass（含真实 pi --mode rpc 集成）；kernel 全量 411 pass/0 fail。
- 影响范围：packages/kernel/src/rpc-client.ts。

## 2026-08-11 — revert(frontend): 移除 llm-ui 流式渲染回退自实现 MarkdownBlock，彻底解决内存溢出

### 变更

- **根因**：`@llm-ui/react` 0.13.3 的 `useLLMOutput` 有 rAF 渲染循环 cleanup bug——useEffect 返回的箭头函数缺 `return`，`cancelAnimationFrame` 从不执行，组件卸载后循环继续运行。长 AI 回复流式渲染期间，每帧 `matchesToOutput().join("")` 创建完整文本副本，被 V8 Context/scope 持久持有。内存快照实测：同一 15.7KB 回复文本被复制 41,276 份，744MB 字符串无法 GC，堆在 7.7 分钟内线性增长到 1426MB。
- **回退**：移除 llm-ui 流式渲染，流式 text 段恒走自实现 `MarkdownBlock`（ReactMarkdown 直接渲染，与定稿同路径）：
  - 删除 `StreamingMarkdown.tsx`、`streaming-code-block.tsx`、`streaming-visible-cache.ts` 及其测试（6 个）
  - `MessageList.tsx` renderSeg text 分支不再按 segIsStreaming 分发
  - `session.ts` 移除 `clearStreamingVisibleCache` 调用
  - package.json 移除 `@llm-ui/react|markdown|code` 依赖与 patch
  - 保留此前 4 项低成本优化（batcher 合帧 / kernel 节流 / 子代理卡片降级 / virtuoso 虚拟化）与 messagesBySession 内存修复（removeSession）
- **验证**：全量前端测试 1368 pass/0 fail；Node 内存压力测试（真实 ReactMarkdown 渲染 150 次、文本增长模拟流式）末轮堆增量仅 1.18MB，无线性泄漏；真实 Chromium 浏览器基线测试应用加载后空闲 6 秒 JS 堆零增长（40.1→40.1MB）——llm-ui 时代同类场景会出现 GB 级累积。
- 影响范围：packages/frontend/src/components/MessageList.tsx、src/components/blocks/（删 StreamingMarkdown/streaming-code-block）、src/store/session.ts、package.json、patches/（移除 @llm-ui patch）。

## 2026-08-11 — fix(frontend): 导出/复制图片时部分 mermaid UML 图文字变白（SVG <style> 颜色导出丢失）

### 变更

- **根因**：html-to-image 对 SVG 直接 cloneNode、不内联样式。mermaid label 文字颜色由 SVG 内 `<style>`（`.label{color:#333}`）提供，SVG-as-image 渲染时该颜色丢失 → 下载/复制的 PNG 里 foreignObject label 文字变白（界面 DOM 渲染正常显黑）。部分图正常是因 label 用 SVG `text` 元素（fill 由 style 继承仍生效），用 foreignObject div 的图（flowchart/class/state/er 等）白字。
- **修复**：`renderTurnsToPngBlob` 导出前对 mermaid svg（`[data-testid="mermaid-svg"] svg`）做字符串层颜色内联——给 foreignObject 内 div/span/p 加十六进制 `color:#333333;fill:#333333`，DOMParser 解析 + 节点替换（避免 innerHTML/outerHTML 写入）。真实浏览器验证：字符串解析路径内联的颜色才会被 SVG-as-image 渲染尊重，DOM API 写同样值无效（Chromium 对 foreignObject 内 HTML 样式快照行为）。
- 验证：TDD 先写失败测试（fixMermaidLabelColors 未实现）→ 修复后 13 pass；相关套件（ExportButton/ExportImageCard/MermaidBlock/markdown-mermaid/旧 collectTurns）共 42 pass；`tsc --noEmit` 通过；真实 Chromium + 真实 mermaid + html-to-image 像素分析：修复后深色文字像素 0.4%→2.2%，节点填充色保留。
- 影响范围：packages/frontend/src/util/export-chat-image.ts（新增 fixMermaidLabelColors + inlineMermaidLabelColors，toBlob 前调用）、export-chat-image.test.ts（新增白字回归测试 + mermaid mock 含 foreignObject）。

## 2026-08-11 — fix(frontend): 导出/复制图片时 mermaid UML 图未渲染完成（截到 loading 占位）

### 变更

- **根因**：`renderTurnsToPngBlob`（export-chat-image.ts）屏外渲染 ExportImageCard 后只等 React 提交 + 字体加载，未等待 mermaid 异步渲染（MermaidBlock 有 1000ms 防抖 + render Promise）。`toBlob` 截屏时 UML 图还是 `mermaid-loading` 占位，下载/复制的 PNG 里图是「渲染中」。
- **修复**：toBlob 前轮询等待卡片内 `mermaid-loading` 占位消失（成功→mermaid-svg / 失败→mermaid-error，均离开占位），10s 超时兑底防死等；无 mermaid 时零额外延迟。
- 验证：TDD 先写失败测试复现（toBlob 时 DOM 仍是 mermaid-loading）→ 修复后 12 pass；相关套件（ExportButton/ExportImageCard/MermaidBlock/markdown-mermaid/旧 collectTurns）共 37 pass；`tsc --noEmit` 通过；真实 Chromium + 真实 mermaid + html-to-image 验证导出 PNG 含渲染完整的 UML 图（像素分析：非白 7.65%、含彩色节点与文字，非 loading 占位）。
- 影响范围：packages/frontend/src/util/export-chat-image.ts（修复）、export-chat-image.test.ts（新增含 mermaid 的导出时序测试 + mermaid mock）。

## 2026-08-12 — feat(frontend): 版本更新历史时间线

### 变更

- **version-history.json 版本历史数据**：新建 `packages/frontend/src/data/version-history.json`，结构化存储所有版本的更新内容（版本号 + 日期 + 新增/改进/修复分类），时间倒序。打包进应用静态资源，前端 import 读取，离线可用。初始数据从 git 历史 RELEASE_NOTES.md 恢复（0.1.18–0.1.21）。
- **VersionTimeline 时间线组件**：垂直时间线展示历史版本，最新版本默认展开、旧版本点击展开/收起，最多显示 100 条。分类标签颜色区分（新增=success 绿、改进=accent 蓝、修复=warning 橙）。
- **AboutSection 嵌入时间线**：设置 → 关于页面新增「更新历史」区域。新版本提示的 releaseNotes 加 whitespace-pre-wrap 修复换行丢失。
- **publish-oss.ts 适配**：从 version-history.json 第一条提取内容注入 latest.yml 的 releaseNotes（替代读取 RELEASE_NOTES.md）。
- 验证：version-history 格式校验 2 pass；VersionTimeline 组件测试 3 pass（渲染/展开收起/100条截断）；AboutSection 测试 7 pass；前端全量 `--isolate` 84 pass；`tsc --noEmit` 通过。
- 影响范围：`packages/frontend/src/data/version-history.json`（新建）、`VersionTimeline.tsx`（新建）、`AboutSection.tsx`（修改）、`scripts/publish-oss.ts`（修改）、i18n 文案。

## 2026-08-12 — fix(frontend): 会话内存泄露——删除会话不清理 store 数据 + message_end 不清流式缓存

### 变更

- **根因**：内存快照分析（heaptimeline）显示 JS 堆持续单调增长无回落。删除会话时仅清理 composer 草稿，messagesBySession 等 19 个 per-session Record + 子代理进度数据全部残留；clear() 遗漏 8 个字段；_streamingVisibleCache 流式结束后不清理。
- **修复**：session store 新增 removeSession(sessionId) 方法（19 个 Record + 子代理进度 + streamingBatcher.drop）；clear() 补全遗漏字段；ProjectItem/ImConversationList 删除会话时调用 removeSession；缓存逻辑提取为独立 streaming-visible-cache.ts 纯模块，message_end 时调 clearStreamingVisibleCache()。
- 验证：TDD 3 红→3 绿；前端 store 测试 5/5 pass。
- 影响范围：packages/frontend/src/store/{session,streaming-visible-cache}.ts、packages/frontend/src/components/{MessageList,ProjectItem,ImConversationList}.tsx。

## 2026-08-12 — 修复新建会话「正在思考」闪退

### 变更

- **修复(kernel)**：新建会话冷启动期间 `isSessionBusy` 返回 false 导致前端清除乐观思考状态；新增 `starting` 检查，冷启动期返回 true，`GET /messages` 正确返回 isActive=true。

## 2026-08-11 — 暗色主题修复 / 流式渲染与滚动交互 / kernel 探活与看门狗治理 / 桌面打包与 OTA

### 变更

- **frontend·暗色模式**：导出图片黑底黑字修复（ExportImageCard 应用主题化 prose 变量）；代码块暗色高亮不可读修复（新增 `useIsDarkMode` hook，按明暗切换 Prism 主题，system 模式跟随系统实时切换）；markdown 渲染启用 typography 对齐网页排版 + 文件预览底色改白；md 预览渲染原始 HTML（rehype-raw）+ 内嵌相对路径图片加载（仅文件预览器，聊天区保持安全不渲染 HTML）。
- **frontend·流式/滚动**：新会话发送后显示「会话新建中」加载页（消除白屏，时间戳窗口 + 事件响应退出 + 20s 兜底）；新建会话 api.post 错误不再被吞——创建失败显示「发送失败」提示（promptErrorBySession，显示条件不依赖加载页窗口，收到服务器事件自动清除）；触摸惯性滚动不再被误判「被动离底」拉回；贴底时折叠/展开不再反复出现「滚动到底部」浮钮（用户主动滚动输入检测）；发送消息后自动滚动到底修复（发送恢复贴底 + 进入会话定位收敛）。
- **frontend·卡片/布局**：FleetCard / DelegateCard 状态摘要行移到卡片底部；统一 thinking/tool/text block 间距（父容器 gap 替代单边 margin）；左上角 logo 放大 1.5 倍；系统设置新增图片导出范围选项（仅 agent 回复 / 双方）+ 通用设置项顺序调整；缓存命中率改为向下取整（避免 99.95% 误显示 100%）。
- **kernel·探活与看门狗**：子代理无进展探活——5 分钟无业务事件判死强杀、不杀主代理；探活移除「工具执行中豁免」、`tool_execution_update` 计入进展；回合看门狗终止后自动重试 1 次；移除主会话回合看门狗（不再杀主代理，子代理独立治理兜底）；子代理执行期间不再误杀主代理；hard-cap 在 ask 豁免后重新武装；看门狗报错文案简化；用户主动停止不再误报「The operation was aborted.」红色错误。
- **kernel·进程治理**：spawn pi 子进程传 `--offline`（主会话 + 子代理）——关闭子进程启动时模型目录网络刷新与共享 models-store.json 锁竞争（同时新建两个会话时第二个不再被 withLockAsync 异步锁拖长、超过前端 30s 硬超时表现为「卡住/无响应」）；offline 无功能副作用（kernel 模型目录由 pi-catalog + providerStore 自管理，扩展/技能走本地路径不受 PI_OFFLINE 门控）。
- **kernel·流式/IM**：SdkEventThrottle 不再丢弃 message_update 增量（流式丢帧修复）；IM 渠道流式 delta 按 contentIndex 分块累积（并发竞态修复）；bridge 心跳探针测试 flaky 治理（重试消除 CI 抖动）。
- **desktop**：ditto 重打包后 blockmap 重新生成（修复增量更新退化为全量下载）；打包版启动卡死修复（trayInstance 被 biome 误改为 const）；macOS OTA 更新无效修复（销毁 Tray 替代 app.exit(0) 兜底，让 ShipIt 正常走完安装）。
- **其他**：记忆 tab 徽标计数按作用域统计，不再混入项目记忆。

## 2026-08-10 — 看门狗与子进程治理 / 主题外观系统 / 桌面端口与 OTA / 发版 v0.1.13–v0.1.20

### 变更

- **kernel·看门狗/超时治理**：主会话回合看门狗（pi 假死自动恢复，修复永久「思考中」）；kernel 超时与信号链路治理 7 项（断连孤儿子代理、停止宽限强杀、ask 流式心跳、httpIdleTimeoutMs 落盘、扩展子进程超时、Infinity 守卫）；httpIdleTimeoutMs 默认值落盘 + 保存校验；ask 改走流式 NDJSON 心跳保活（修复 ~4 分钟提前掐断）；流式 bridge 断连信号透传至子代理；subagent-runner settle 竞速重构（abort 短路 + Infinity 守卫 + 计时器清理）；提问卡片竞态误判失效 + bridge 断连僵尸提问修复。
- **frontend·主题外观系统（v0.1.13）**：CSS 变量分层重构，明暗模式 + 6 色主题 + 字号；AppearanceSection 组件 + ui-prefs store（themeMode/themeColor/fontSize）；system 模式实时跟随系统切换；yellow 深色对比度修复；设置页导航集成与字号迁移。
- **frontend·流式/渲染/滚动**：恢复 llm-ui 流式渲染（撤销 revert，重新采用分块渲染）；工具调用前未闭合 markdown 空白气泡修复；AI 回复中手动上翻不被自动滚动拉回；进行中轮次不提前显示复制/导出按钮；消息气泡最大宽度 78% → 90%；对话界面 duplicate key + Virtuoso 横向溢出 + 回收站长内容换行修复；项目右键菜单视口钳制。
- **desktop·端口/进程/OTA**：win 升级后端口幽灵占用治理（进程登记簿 + 退出清理加固 + 升级前优雅停 kernel + 启动自愈）；登记簿清扫连带 kernel 子孙链；升级安装前优雅停 kernel；退出清理加固（before-quit 同步杀进程树 + sidecar lastPid 兜底）；登记簿 createdAt 取 spawn 时刻 + 自愈异常兜底 + 坏值校验；macOS OTA 系列热修复（v0.1.19 Tray 保活 / v0.1.18 ShipIt 中止 / v0.1.16 验证链路 / v0.1.14 平台 updater + 自签名证书方案 B）；Windows 打包后任务栏图标修复（signExecutable 保留 resEdit）；desktop 数据目录与 kernel 对齐（~/.wa-pi → ~/.pi/agent）；清理 wa-pi 改名残留（死文件 + E2E 死回退 + 过时注释）；图标重新生成（logo.svg 换版 HiAgent/126 绿底）。
- **其他**：录音权限错误改为业务可读文案；移除过时 skip 用例；修复 3 个过时测试断言；发版 v0.1.20 / v0.1.15（进程登记簿 + 端口自愈 + 流式渲染修复 + 图标更新）。

## 2026-08-09 — 回收站功能 / 虚拟化与流式渲染 / i18n 双语 / 初始化向导与预设智能体 / 发版 v0.1.7–v0.1.11

### 变更

- **回收站功能**：全链路实现——类型定义、ProjectStore 软删除/恢复/彻底删除/清空/loadActive、自动归档调度器（6 小时 + 可选自动清理）、WS 事件 + HTTP 路由 + 设置存储、前端 store/trash + 弹窗/会话行/只读消息查看器 + SVG 图标化；最终审查 5 个问题（归档天数 clamp、deleteProject 改软删除、软删会话只读守卫等）。
- **前端·虚拟化/流式渲染**：消息列表 react-virtuoso 虚拟化（长会话性能）+ 移除无限 rAF 循环；流式 text 段改 llm-ui 分块渲染（未闭合代码块跳过 Prism 高亮）；llm-ui React 19 兼容性 spike；StreamingBatcher rAF 裸引用 this 修复（真实浏览器流式预览失效）；子代理卡片 memo + 流式停顿前纯文本预览降级；修复虚拟化后进入会话定位回归 + 滚动行为自动化覆盖。
- **前端·交互/修复**：粘贴超 30 行自动转为文件附件；点击附件 chip 内置文件预览器预览；文件树重新显示隐藏项；streaming 期间不提前显示复制/导出按钮；重命名会话改用内置弹窗；右键菜单互斥 + 项目重命名 + 遮罩不关闭；新建角色默认关系网包含所有内置智能体；切换模型后会话模型回滚（loadSession 竞态）；新会话消息串会话（草稿 id 未消费）/ 空会话（预热占位残留）；fleet 同名 agent 回复/状态串台（taskIndex 全链路透传）；消息流渲染稀疏空洞崩溃修复。
- **i18n 双语**：前端引入 react-i18next 国际化基础设施（自动语言检测 + 设置切换）；全部组件文案接入中英双语；修复英文界面露中文遗漏点 + 非组件层文案迁移；回收站 emoji 图标 SVG 化 + 图标居中。
- **kernel/其他**：修复设置页改 API key 不生效（auth.json 过期凭证劫持）；anthropic-messages 格式 provider 测试连接 404；新增开机自启功能（默认开启）；恢复 README 截图素材；发版 v0.1.10 / v0.1.9 / v0.1.8 / v0.1.7。
- **初始化向导 + 预设智能体体系**：无模型自动弹出两步引导（配置模型 → 设置默认智能体）；268 条预设智能体库 + from-preset 创建 + 部门筛选 + 完整提示词预览 + 3 列卡片弹窗；宫格新建面板独立弹窗；前端 18 个组件文案接入 i18n。

## 2026-08-08 — 适配 pi 0.84 流式协议 / 发版 v0.1.6 / 依赖升级 / 提示音与自动更新

### 变更

- **适配 pi 0.84 流式协议变更**：message_update 移除 partial 快照，前端与企微渠道改 delta 累积渲染；对话消息移除头像保留智能体名字。
- **发版 v0.1.6**：提示音（任务完成/需要操作）、渠道流式回复适配、依赖批量升级（pi-ai ^0.84.1 / vite ^8.2.1 / electron ^43.3.0 / electron-builder ^26.15.3）、README 英文化（拆分 README.zh-CN.md）。
- **新增功能**：任务完成/需要操作提示音（WebAudio，独立开关 + 试听）；系统设置通用页内容改为保存后才生效；设置弹窗导航选中高亮对齐会话样式。
- **修复(kernel)**：企微 IM 流式推送断线期 unhandledRejection 崩溃；skillsAllOff 语义失效（接口补字段透传）；会话清理与预热并发竞态噪音日志降级；新建页切换模型后聊天界面显示旧模型。
- **重构(desktop)**：自动更新源 Gitee Release → 阿里云 OSS（GenericProvider + publish-oss 脚本）。
- **新增(desktop)**：应用版本检查与自动更新（electron-updater，关于页 UI）；侧边栏新建项目入口图标化。
- **新增(frontend)**：输入框 Ctrl+Enter（macOS Cmd+Enter）引导发送。
- **文档/依赖**：README 双语版头部中英界面标识 + i18n 徽章；核心依赖批量升级；删除 docs/superpowers/mockups 早期原型与差异文档；新增初始化向导设计文档；引入 agency-agents-zh 中文角色参考库（268 个，仅参考资料）。

## 2026-08-07 — 初始化向导 / 前端 i18n 全量接入 / 智能体技能 tab 改造 / 企微 IM 渠道增强

### 变更

- **初始化向导**：无模型时自动弹出两步引导（配置模型 → 设置默认智能体，均可跳过），设置页可重开；预设智能体库选择 + 随机人名可改；附带修复 agent:prompt agent_missing 广播缺失。
- **前端 i18n 全量接入**：18 个组件（NewSessionPane / AgentGalleryModal / ProjectItem / Composer / CommandPalette / ImConversationList / Sidebar / ProjectList / MemoryPage 等）+ util/platform.ts 文案接入中英双语。
- **编辑智能体弹窗技能 tab 改造**：全部勾选开关 + `skillsAllOff` 字段表达显式全不选（主会话与子代理派发均识别）；技能名不换行 + 超长描述气泡。
- **角色选择器/卡片溢出修复**：小窗口下角色选择器不再超出屏幕（min-w-0 + 视口钳制）；委托/工具/思考卡片长文本不再撑破（overflow-wrap:anywhere）；统一「打开系统文件/目录」入口文案按平台区分。
- **企微 IM 渠道增强**：默认工作目录 + 切换开关；群聊会话改「群+用户维度」隔离（上下文互不可见）；`/new` 命令归档保留历史会话 + IM tab 右键删除；回复粒度新增「极简」选项；企业微信 token 级流式回复（打字机效果）；映射缓存失效会话兜底重建；IM 会话不再泄漏到任务列表。
- **其他修复**：ProviderFormModal 弹窗点击阴影不再关闭；回收站眼睛/关闭图标居中；emoji 图标 SVG 化。

## 2026-07-30 — 网络错误状态条 / 思考强度持久化 / 全项目重命名 HiAgent → WA PI Agent

### 变更

- **修复(kernel)**：网络错误不再灌入对话流，改用顶部状态条提示（transient / fatal 分类）；每个会话固定自己的思考强度（未设置回退全局默认）；重启后会话标题丢失（createSession 幂等）。
- **修复**：委托子代理「No API key」（跟随主模型 + extensionPaths 透传）；聊天界面未选模型自动选第一个可用模型；打包后 MCP 连接「Executable not found: npx」（新增 npx/npm 包装脚本 + findSystemNode）；已完成 thinking 块因新 thinking 到达误展开（每段独立成卡）；过程卡片展开/弱化逻辑统一（executingMode）。
- **新增**：README.md（产品定位/特性/架构图/截图）。
- **重构**：全项目重命名 HiAgent → WA PI Agent / wa-pi（约 290 个文件：包名 @hiagent/*→ @wa-pi/*、数据目录 ~/.hiagent → ~/.wa-pi、二进制 hiagent-kernel → wa-pi-kernel、环境变量 HIAGENT_*→ WA_PI_*）。

## 2026-07-29 — 思考强度持久化三次修复 / 依赖整体升级 / TUI 命令治理

### 变更

- **修复**：重启后思考强度重置 disabled（hydration 竞态，第三次修复——hydrate 前不写回 localStorage）；切换会话思考强度丢失 + defaults 改用 localStorage 持久化；编辑供应商弹窗快捷下拉卡住（TagInput onSubmit）；provider 配置变更后旧 extension 导致 Model not found（markAllDirty）；Mermaid 流式闪现渲染失败（错误 debounce）；打包后新建会话跳旧会话 / 复制功能失效（sandbox: false）；固定端口 9778 + 端口占用一键重启。
- **配置变更**：前后端依赖整体升级（pi-coding-agent 0.82.1 / pi-ai 0.82.1 / vite 8 / electron 43 / electron-builder 26 等）；pi-coding-agent 补丁移除 bash 默认超时 hunk。
- **TUI 命令治理**：`/mcp-auth` 卡死修复（pi 侧 custom() 同步抛错 + `/` 菜单静态预扫描屏蔽 + TUI-only 命令降级为大模型普通输入）；手动发送扩展命令后永久「思考中」（合成 agent_end）。
- **其他修复**：文件预览 ENOENT 自动搜索回退；文件预览胶囊仅对可解析路径显示；切回会话时 ask 不再错误取消；web_search 默认参数（auto-summary + numResults=8）。

## 2026-07-28（晚） — 委托提示词 v14 定稿

### 变更

- 委托提示词 v14 定稿：deepseek-v4-flash 无思考模式 60/60 通过，提示词总量约 -60%；派发评测脚本加固（每用例前重新生成扩展、自动重试、隔离 worktree 评测）。

## 2026-07-28 — 内联 / 命令菜单 / 命令状态修复

### 变更

- **新增**：内联 `/` 命令菜单动态注册 pi 的 slash 命令（get_commands 全链路，支持插件贡献命令）。
- **修复**：新建会话 `/` 菜单不显示动态插件命令（自动创建 session + 启动 pi 进程）；`/goal` 等命令执行后永久「思考中」（50ms 延迟检查复位）；扩展安装/升级/卸载永久卡「安装中」（broadcast 而非 reply）；MCP 连接器永久卡「测试中」；MCP 工具列表弹窗尺寸（60vw / 80vh）。

## 2026-07-27 — 委托提示词 v3 定稿 / Mermaid 渲染 / Token 显示 6 项修复

### 变更

- 委托提示词 v3 融合版定稿（A/B 实测驱动，explore 88.9% 误派 0%）；派发评测脚本扩容（用例 30→60，`--repeat N` 多轮采样）。
- **新增**：Mermaid 图表渲染（缩放/拖拽/PNG 导出）；内置 pi-cache-optimizer（Token/缓存显示，子 agent usage 累加）；高级项目经理 + 会议纪要专家角色。
- **修复**：刷新页面后会话未还原进行中状态；工具卡片展开/收起宽度跳变（固定 w-[78%]）；Token 显示 6 项缺陷；首次打开存量会话慢（5-10s → ~0.3s，直接解析 JSONL）；角色设置工具 Tab 加载中；编辑角色 SkillsTab 崩溃；记忆/指令/配置加载失败；归档记忆删除不掉；指令文件扫描对齐 pi 框架。

## 2026-07-26 — 去 WS 化阶段二 / 排队系统设计 / 卡顿修复

### 变更

- **设计**：排队系统重构（采用 pi 原生 steer() + 本地列表管理）。
- **修复**：流式输出 fallback（message_update 缺 partial 时用 event.message 兜底）；SSE 事件帧格式；REST 响应体丢失（8 个 store 补 .then）；Composer 错误兜底复位 UI。
- **重构**：阶段一卡顿修复（kernel 50ms 节流 + 前端 rAF 合帧）；去 WS 化阶段二全量迁移到 HTTP REST + SSE + 测试迁移。

## 2026-07-25 — 智能体编辑窗口放大 / 排版修复 / 动态扩展加载

### 变更

- 智能体编辑窗口放大（80vw × 80vh，禁用遮罩关闭）；代码块内 markdown 表格逐格竖排（CSS 作用域防护）；AI 回复中表格/列表行间距异常（lineHeight 3.1 → 1.55）。
- 动态扩展与 agent 目录双重加载（动态包优先 runtimeRequire）；pi-mcp-adapter 升级 2.13.0；发送按钮因过期模型 prefs 置灰（按 id 兜底匹配）。

## 2026-07-24 — 角色系统完善 / 子代理派发优化 / 专家角色预置

### 变更

- **修复**：角色提示词未注入系统提示词；主智能体不主动派发子代理（恢复 Proactive Delegation / Fleet）；FilePicker 搜索目录无法展开；DirTreePicker 搜索切换隐藏目录；工具调用卡弱化时机（拿到 result 即弱化）；阻止加载 Pi 默认 skill（--no-skills + 显式 --skill）；聊天界面时间线渲染顺序；子代理无效模型崩溃（校验 override model）；pi-lens 双重加载 + 工具过滤；关系网 tab 开关样式。
- **新增**：首启预置 7 个专家角色（前端/后端/PM/测试分析师/数据分析师/代码审查/UX 设计师）；子代理派发遥测 + 评测脚本；聊天界面 cocode 显示模式对齐（ProcessCard 体系 + 折叠/语法高亮/FilePill）；系统设置-技能页面优化；CoCode vs HiAgent 差异对比文档。
- **变更**：移除 4 个旧默认角色。
- **重构**：bridge 扩展静态化（tool-schemas.ts 唯一真源）；delegate 工具描述移除硬编码内置类型名。

## 2026-07-23 — pi RPC 子进程架构迁移

### 变更

- **重构**：kernel 从 pi SDK 内嵌迁移到 pi RPC 子进程架构（rpc-client.ts + agent-manager.ts 重写）；测试套件适配（6 个测试文件重写）。
- **新增**：bridge 扩展层（pi RPC 子进程架构的宿主工具桥）；RPC 迁移验收 E2E；技能触发符支持 ¥。
- **修复**：清理 kernel/tests 残留临时文件；frontend 测试套件 11 个既有失败（zustand store 污染）；引导消息重复发送（_promptLocks 只覆盖 ensureStarted）。

## 2026-07-22 — 子智能体调用策略 / 气泡拆分重写

### 变更

- **修复**：主智能体不主动调用子智能体（提示词引导重构，OpenCode 式强制策略）；按 R 重启端口冲突（POSIX 递归杀整棵进程树）；同一回合文本被拆成多个气泡（重写 segmentBlocks）。
- **新增**：内置智能体设置支持保存 model 和思考强度；委派引导可配置化（AgentConfig delegationHints）。
- **测试基础设施**：kernel 不再被强加 happy-dom；store-subagents 测试跨文件 mock 泄漏；SessionView 违反 React Hooks 规则。
- **移除**：死字段 partners.askFrom / inheritProjectContext。

## 2026-07-21 — 默认工作区 / 系统提示词组装框架 / 内置 subagent 全链路

### 变更

- **新增**：默认工作区虚拟项目（🏠 默认工作区）；系统提示词可配置化组装框架（6 段拼装 + prompts.json 配置）；内置 subagent 类型（general-purpose / Explore / Plan）全链路；@ 智能体 chip 渲染 + 按钮选择器自适应。
- **修复**：宫格弹窗左键内置 subagent 无效（打开只读详情）；多行发送换行丢失（contenteditable 块级元素转 \n）；内置 subagent 无 askTo 时无法调起（始终注册 delegate/fleet 工具）；@ 内置 subagent 中文 token 识别失败（改用英文 name）。
- **设计**：知识库检索技术方案调研；@ 智能体语义改造 spec。

## 2026-07-20 — @ 候选菜单与委托规则

### 变更

- **新增**：@ 候选菜单只显示 askTo 名单内；系统提示词加 @[agentName] 委托规则；askTo 非空时同时注册 fleet 工具。
- **重构**：彻底移除 AgentConfig.name 字段（displayName 唯一标识符）；Composer 发送路径不剥离 @[xxx]。
- **修复**：历史消息中 @[智能体] 渲染为 chip；委托后刷新出现空气泡（兼容 role: "custom"）。

## 2026-07-19 — 多智能体矩阵重写

### 变更

- 多智能体矩阵重写：动态增删改查 + 关系网调起 + @/$/# 触发符 + DelegateCard；新建会话页智能体选择器（搜索下拉 + 默认选中最近使用）。

## 2026-07-17 — 插件升级反馈 / 模型闸门 / Quick Invoke 修复

### 变更

- **修复**：动态插件升级无反馈（upgrading 状态 + 进度推送）；未配置模型也能发送（闸门改为验证模型真实存在）；agent 启动失败后会话卡「思考中」（failTurn 复位）；打包后 modelRuntime.getModels 报错（包根动态 import）；Quick Invoke 菜单过窄（560px + 自动滚入视野）；quick-invoke E2E 5 个既有缺陷；记忆页开关失效；Plugin 技能描述显示 "|"（YAML 块标量解析）；大文件上传超时（maxPayloadLength + WS 自动重连）；会话状态点永远「空闲」（活会话级状态）；业务校验错误崩掉 kernel（dispatch 边界 try/catch）。
- **新增**：@ 文件选择支持文件夹（📁/📄 图标区分）。

## 2026-07-16 — Quick Invoke / 供应商预设 / 发送修复

### 变更

- **新增**：Quick Invoke 聊天栏快速调用（@ 文件选择 + $ 技能选择 + contenteditable）；模型供应商预设快捷选择（10 条主流预设）。
- **修复**：新会话发送后白屏（kernel 创建 session 后立即回传用户消息）；停止/队列按钮无响应（session 注册时机提前）；会话列表时间不更新（message_end 也 touchSession）。
- **变更**：思考过程合并 + 工具调用分组折叠（两层折叠面板）。

## 2026-07-15 — MCP 连接器直连 SDK

### 变更

- **重构**：MCP 连接器改用直连 MCP SDK（连接测试/工具列举不再经 Pi agent session）。
- **修复**：HTTP MCP 鉴权失败（url 分支透传 headers）；已连接 MCP 仍保留连接测试按钮。
- **新增**：切换 MCP 项目作用域后自动连接测试；MCP 编辑改为模态弹窗；MCP 查看工具加载过渡。

## 2026-07-14 — 动态插件工具自动发现

### 变更

- 动态插件工具自动发现（遍历扩展 .tools Map）；SDK 自动发现冲突（自有字段 hiagent_packages）；包管理器鲁棒性（process.execPath 替代 bun + 自动创建 package.json）；Dev 模式运行时包解析（runtimeRequire 兜底）。

## 2026-07-13 — 动态插件系统 / Electron shell

### 变更

- **新增**：动态插件系统（安装/卸载/升级/启用/禁用 npm 插件）。
- **重构**：桌面 shell 从 tray-binary 迁到 Electron（为录音系统声音铺基座）。

## 2026-07-12 — 桌面分发模型 / ask 工具

### 变更

- **重构**：桌面分发定为文件夹模型（bun build 打包 kernel.js + node_modules）；前后端端口支持 .env 动态配置。
- **新增**：ask_user_question 结构化澄清提问工具；agent 系统提示词注入执行环境信息；kernel 可导入 + 可选静态前端伺服。
- **修复**：pi-lens 双重加载 + 工具白名单过滤；记忆页作用域选择器状态丢失。

## 2026-07-11 — FilePicker 手风琴 / 记忆管理

### 变更

- FilePicker 手风琴展开 + 限定范围搜索；记忆管理（集成 pi-hermes-memory，增删改查 + 指令文件加载）。

## 2026-07-10 — 工具集扩展

### 变更

- dev 脚本按 R 重启端口漂移（strictPort 固守 5180）；新增 grep/find/ls 与 web_search/fetch_content 工具。

## 2026-07-09 — Composer 重构 / 技能管理 / 系统设置

### 变更

- Composer 重构：胶囊输入 + per-session 偏好持久化 + 模型切换/思考强度/附件；技能管理（目录管理 + 启用/禁用 + 热生效）；系统设置页 + 模型供应商管理；DirTreePicker 搜索过滤。

## 2026-07-08 — Steer 队列控制 / Pi SDK 同进程重构

### 变更

- **新增**：Steer 消息队列控制（followUp 排队 + 引导/立即/取消/清空）；项目列表右键菜单（查看文件夹 + 删除项目）。
- **重构**：Pi SDK 模式重构（从 spawn RPC 子进程改为同进程 SDK 直连）。
- **修复**：pi-intercom 打包为项目依赖、Composer 发送防抖、会话列表重复、首条消息丢失、多 session 共享进程问题、dev 端口清理等多项。

## 2026-07-07 — 移除 Rust 窗口层 / Pi 原生消息模型重构

### 变更

- **架构重构**：移除 Rust 窗口层（bun 一键启动前后端，全 bun:test）；Pi 原生消息模型重构（收敛到 Pi 富消息模型，删除 broker-proxy 旁路系统）。
- **新增**：编排画布（React Flow 4 agent 节点 + 连线）；会话列表交互（右键菜单 + 删除确认）；多智能体委派（后随消息模型重构废弃）。
- **修复**：消息流全链路打通、会话消息重复、E2E 白屏等多项。
- **测试**：E2E 基础设施 + 7 spec；MVP 四层测试全绿（kernel 47 + frontend 42 + E2E 4）。

## 2026-07-06 — 前端数据层

### 变更

- 前端数据层：WS 客户端 + 4 个 Zustand store。

## 2025-08-02 — /mcp-auth 卡住修复

### 变更

- RpcClient.handleUiRequest 的 UI_DIALOG_METHODS 缺少 custom 方法，导致 pi-mcp-adapter 的 ctx.ui.custom() 面板请求无回复、进程永久挂起；将 custom 加入对话方法集合，无 handler 时自动回 cancelled。数据清理（测试遗留无效模型、过期会话文件）。

## 2025-07-28 — 思考文本换行 / 工具来源标签 / 打包白屏

### 变更

- 思考文本不换行（ThinkingCard/ThinkingPanel 加 break-words，ProcessCard 加 min-w-0）；工具来源标签细化（来源从「扩展」细化为 内置 / MCP / 插件包名）；打包后启动白屏（SEED_FILES 补 tool-schemas.ts 和 hiagent-bridge.extension.ts）。

## 2025-01-22 — Token 消耗进度条

### 变更

- 百分比胶囊改为进度条，宽度 = 累计 token / 模型 contextWindow。
