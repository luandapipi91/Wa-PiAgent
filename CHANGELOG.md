# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

## [Unreleased] - 2026-08-06

### 修复

- **修复「发送消息时穿插插件 notify UI 消息会致 user 消息显示 2 条」**：
  根因是 App.tsx 的 `session:echo_user` 处理器只查 `optimisticEchoBySession` 标志，
  而该标志会被 `message_start(user)`/`agent_end` 兜底/`failTurn` 提前清除；插件
  `extension_notify` 消息穿插延长冷启动窗口、致事件密集，使 `echo_user` 与 SDK
  `message_start` 时序非确定——一旦 echo_user 在标志清除后到达，就会再次
  `optimisticSend` 追加第二条 user。修复：在 store 新增 `echoUser` 幂等入口，
  除标志外再查「同内容 user 消息已存在」，收敛查重逻辑；App.tsx `session:echo_user`
  分支改调 `echoUser`。
  影响范围：`packages/frontend/src/store/session.ts`（新增 `echoUser`）、
  `packages/frontend/src/App.tsx`（改调 `echoUser`）；
  新增回归测试 `packages/frontend/tests/store-session.test.ts`（6 项 echoUser）、
  `packages/frontend/tests/App-echo-user.test.tsx`（2 项端到端）。

## [Unreleased] - 2026-08-05


### 修复

- **前端状态对齐缺陷（断线/kernel 重启后永远"对话中"）**：`setActiveStatus(isActive=false)`
  此前 `return {}` 不复位，SSE 断线窗口漏掉终态事件（不重放）或 kernel 重启后，重连/
  加载对齐永远清不掉残留的 thinking。现显式 false 时复位 idle + 清 streaming 占位 +
  清重试条（无残留时保持 no-op；isActive 缺省 undefined 视为响应不可信、不干预）。
  注：曾基于"pi 断网后静默挂死不报事件"的假设加过 kernel turn 看门狗，经真实 pi RPC
  断网实验（连接拒绝 15.7s / 黑洞地址 ~100s 内均走完整 auto_retry → agent_settled
  终态链）证伪，已整体回滚 kernel 侧改动。
  新增测试：frontend setActiveStatus 对齐 3 个；store-session.test.ts 的 beforeEach
  补 thinkingSinceBySession / retryBySession 重置（既有遗漏）；App.test.tsx 的
  /messages mock 支持按测试覆写 isActive（重试条测试描述运行中会话，改传 isActive=true）。
  影响范围：`packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/store-session.test.ts`、`packages/frontend/tests/App.test.tsx`。

### 修复

- **发送消息偶现用户消息重复显示**：根因在前端去重逻辑——`message_start(user)` 回声
  仅在「optimisticEcho 标记仍在 且 列表末尾是 user 消息」时才替换乐观占位，而占位与
  回声之间插入任意消息（extension_notify 等）、kernel 50ms 兜底合成 agent_end 提前清
  标记、POST 30s 超时 failTurn 清标记，三种时序都会击穿该判定导致回声被追加成重复行。
  修复：乐观占位消息显式携带 `optimistic: true` 标记，回声倒序查找标记消息原位替换，
  不再依赖末尾位置与全局标记。transcript 层无重复（纯显示层问题），刷新后历史不受影响。
  新增 3 个复现测试（先红后绿）。
  影响范围：`packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/store-session.test.ts`。

### 变更

- **系统设置「导出轮数」文案改为「对话导出轮数」**：明确该设置描述的是导出图片时包含的
  对话轮数，与导出菜单「仅本次」子面板措辞区分。仅改 UI 文案，行为不变。
  影响范围：`packages/frontend/src/components/settings/GeneralSection.tsx`。

### 变更

- **agents/ 角色库的角色名中文化**：
  新增 `scripts/rename-agents-zh.ts`，把 `docs/references/awesome-chatgpt-prompts/agents/` 下
  2096 个角色文件的英文 displayName 替换为中文可读角色名（英文原题翻译为简洁中文，
  Gemini/Midjourney 等专有名词与无实义乱码保留原名），文件名同步更新；英文原名保留在
  frontmatter `# Original` 注释中，正文与贡献者信息不变。已处理 Windows 大小写不敏感下
  仅改大小写的映射误删问题，并幂等（已含 `# Original` 注释的文件跳过）。
  新增 `scripts/__tests__/rename-agents-zh.test.ts`（6 个单元测试）。
  英文原名映射持久化在 `docs/references/awesome-chatgpt-prompts/zh-name-map.json`（2096 条），
  可从已转换文件的 `# Original` 注释反推重建；脚本幂等且映射缺失时优雅降级。
  影响范围：`scripts/rename-agents-zh.ts`、`scripts/__tests__/rename-agents-zh.test.ts`（新增）、
  `docs/references/awesome-chatgpt-prompts/agents/`（2096 个文件改名）、
  `docs/references/awesome-chatgpt-prompts/zh-name-map.json`（新增）、
  `docs/references/awesome-chatgpt-prompts/README.md`。

### 变更

- **将 awesome-chatgpt-prompts 的 PROMPTS.md 拆分为单角色提示词文件（wa-pi 可识别格式）**：
  新增 `scripts/split-prompts.ts`，把 `docs/references/awesome-chatgpt-prompts/PROMPTS.md` 的 2096 条
  角色提示词按角色拆成 2096 个独立 `.md` 文件，输出到
  `docs/references/awesome-chatgpt-prompts/agents/`。文件格式与 wa-pi 自定义智能体定义一致
  （YAML frontmatter：displayName/avatar/avatarColor/description/tools/skills/mcpServers/partners，
  正文为提示词原文），可直接复制到 `~/.wa-pi/agents/` 被运行时识别；displayName 清洗非法字符
  （`/ \ : * ? " < > |` → `-`）并截断超长名（≤120 字符），重名自动追加 `-2`/`-3` 后缀；
  贡献者保留在 frontmatter `# Contributed by` 注释中。README 新增「agents/ 角色库」说明。
  影响范围：`scripts/split-prompts.ts`（新增）、`docs/references/awesome-chatgpt-prompts/agents/`
  （2096 个文件，新增）、`docs/references/awesome-chatgpt-prompts/README.md`。

### 变更

- **引入 awesome-chatgpt-prompts 角色提示词参考库（CC0，纯参考资料）**：
  从 [f/awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts) 抓取 `PROMPTS.md`
  原文（2096 个角色条目 / 2088 个唯一角色）至 `docs/references/awesome-chatgpt-prompts/`，
  作为提示词写法的外部参考资料，**不接入运行时**（不并入 `DEFAULT_AGENT_SEEDS`、不写入
  `~/.wa-pi/agents/`、不接前端 UI）。许可证为 CC0 1.0 公共领域（提示词内容部分），随附
  `LICENSE` / `LICENSE-CC0` / `LICENSE-MIT` 三份许可文本作合规留底；另生成中文索引 `README.md`
  按字母分桶列出全部角色，便于查阅。
  影响范围：`docs/references/awesome-chatgpt-prompts/`（PROMPTS.md / LICENSE / LICENSE-CC0 /
  LICENSE-MIT / README.md，均为新增，无运行时代码改动）。

### 变更

- **斜杠命令触发的对话（无 user 消息）导出图片不再置灰 + 导出按钮长按可选轮数**：
  根因是 `collectTurns`（export-chat-image.ts）要求每轮 assistant 必须配对前置 user 消息，
  但 extension 斜杠命令被 pi 拦截执行、不产生 user 消息（kernel ws-server.ts 有意抑制回声，
  Composer 跳过 optimisticSend），导致这类"只有 assistant 回复"的轮次被跳过 → 导出按钮置灰。
  修复：assistant 轮找不到配对 user 时 user 文本置空（不再丢弃整轮）；ExportImageCard 对空 user
  不渲染用户气泡。另新增长按交互——长按「下载 PNG / 复制图片」弹出轮数选择子面板（1-5），
  选中后仅本次用该轮数执行（不改全局设置）；短按仍用全局 exportTurns 立即执行。
  影响范围：`packages/frontend/src/util/export-chat-image.ts`、
  `packages/frontend/src/components/blocks/ExportImageCard.tsx`、
  `packages/frontend/src/components/blocks/ExportButton.tsx`；
  更新测试 `packages/frontend/tests/export-chat-image.test.ts`、
  `packages/frontend/tests/blocks/ExportButton.test.tsx`（含长按轮数交互回归）。

### 变更

- **会话 header「项目文件」按钮图标统一为 Icon 组件 + 18px 跟随字体缩放**：原内联 SVG
  硬编码 `width/height="15"`，改为 `<Icon name="folder" size="1em" className="text-[calc(18px*var(--font-scale))]"/>`，
  与侧边栏项目图标 / 系统设置图标完全同口径（基础 18px，随 `--font-scale` 缩放）。
  影响范围：`packages/frontend/src/components/SessionView.tsx`、
  `packages/frontend/tests/SessionView.test.tsx`（图标尺寸断言）。

### 变更

- **修复「编辑智能体」右键菜单文字换行**：菜单容器固定 `minWidth:140` 且按钮无 `whitespace-nowrap`，
  字体缩放后「编辑智能体」宽度超容器导致 icon 后文字折行。修复：按钮加 `whitespace-nowrap`，
  菜单容器加 `width: max-content` 按内容自适应撑开。
  影响范围：`packages/frontend/src/components/AgentListSection.tsx`、
  `packages/frontend/src/components/AgentGalleryModal.tsx`。

### 变更

- **修复「导出会话→复制图片」取错消息（取到 thinking/前一轮而非当条回复正文）**：
  根因是 `collectTurns`（export-chat-image.ts）先按原始 timestamp 逐条过滤、再合并同回合
  assistant，导致流式期间 store 未 compact 的「thinking 块 + text 正文块」被拆散——
  `uptoTimestamp` 来自渲染合并行（保留回合首块 timestamp），filter 会把同回合 ts 更大的
  text 正文块误过滤掉，只剩 thinking 文字。修复：filter 改为按「回合首块 timestamp」整回合
  判定（同 agent 连续 assistant 同回合，与渲染层 collapseSameTurnAssistants 口径一致），
  整回合要么全部保留要么全部丢弃；合并后 message.timestamp 仍取轮末，保持既有契约。
  影响范围：`packages/frontend/src/util/export-chat-image.ts`；
  新增回归测试 `packages/frontend/tests/export-chat-image.test.ts`（8 项）、
  `packages/frontend/tests/blocks/ExportButton.test.tsx`（4 项）。

### 变更

- **侧边栏图标（项目列表 + 系统设置）基础尺寸 18px 并跟随字体缩放**：项目头部（默认工作区 home / 项目 folder / 展开 folder-open）
  图标由固定 `size={13}` 改为 `size="1em"`，toggle 按钮字体设为 `text-[calc(18px*var(--font-scale))]`；
  系统设置按钮 icon 由固定 `size={12}` 改为 `size="1em"` + `text-[calc(18px*var(--font-scale))]`——
  图标基础尺寸 18px，并随全局字体缩放变量 `--font-scale` 同步缩放（与项目内其余 `text-*` 工具类口径一致）。
  影响范围：`packages/frontend/src/components/ProjectItem.tsx`、`packages/frontend/src/components/SettingsButton.tsx`、
  `packages/frontend/tests/ProjectItem.system.test.tsx`、`packages/frontend/tests/SettingsButton.test.tsx`（尺寸断言测试）。

### 变更

- **动态插件改用 pi 官方 packages 机制 + session.reload 热重载（装卸不丢其他插件 UI）**：
  此前动态插件走 `-e` 显式传路径（spawn 时固定）+ `waPiPackages`（pi 不读），装卸后必须整进程重建，
  导致其他活跃插件的 widget/status 全部丢失。现改为：
  ① 动态包装到 `~/.wa-pi/npm/node_modules/`（pi user scope 路径，package-manager.js:1677）；
  ② settings.json 用 pi 官方 `packages` 字段（pi 自动加载，替代 waPiPackages + -e 动态部分）；
  ③ 内置插件（pi-web-access/pi-mcp-adapter）+ provider-extension + wa-pi-bridge 仍走 `-e`
    （reload 时实例属性保留，不失效）；
  ④ 装卸后调 `session.reload()`（经 bridge `__!wa_pi_reload` 命令）——重读 settings.json packages
    让动态插件集变化生效，重放 session_start 让活跃插件重发 widget/status 恢复 UI，被卸载的
    不重发（其残留由 reload 前的 extension_ui_reset 清掉）。skillDirty（agent 重命名/技能变更）
    仍走整进程重建（session.reload 不重新读 agent 配置）。
  数据迁移：旧 `waPiPackages` → `packages`；旧 runtime/node_modules 的动态插件需重装到 npm/
  （首启迁移或用户重装）。`__!` 前缀命令经前端 commands store 过滤不进命令面板。
  影响范围：`packages/kernel/src/extension-manager.ts`、`packages/kernel/src/extensions.ts`、
  `packages/kernel/src/agent-manager.ts`、`packages/kernel/src/rpc-client.ts`、
  `packages/kernel/src/wa-pi-bridge.extension.ts`、`packages/frontend/src/store/commands.ts`、
  相关测试。

### 变更

- **回退插件装卸热重载方案，恢复整进程重建**：此前两次改动（178c899 + 7f5aeff）
  尝试用 session.reload() 热重载替代整进程重建以避免丢失其他插件 UI。实测发现
  方案根本无效：wa-pi 把所有扩展通过 `-e` 参数传给 pi（否则 pi 不加载动态插件），
  但 `-e` 是 spawn 时固定的，session.reload() 不更新它——卸载的插件路径还在 `-e`
  里，pi 仍加载。热重载只对 settings.json packages 生效，对 `-e` 路径无效。
  现回退到整进程重建（装卸→markAllDirty→进程重启→新的 -e 路径），保证装卸立即
  生效。代价：进程重建会清空所有扩展的 widget/status（pi 不重放 session_start），
  这是已知的、可接受的副作用（用户重新触发插件命令即可恢复 UI）。

### 变更

- **移除空置的 EXTENSION_TOOL_MAP 死代码**：该常量（`packages/shared/src/constants.ts`）
  是 `= {}` 空对象，仓库内无任何写入点——它本想用于「动态插件工具注入 agent allowlist」，
  但 pi 不给宿主提供查询已注册工具的接口（RPC 无列工具命令、package.json 无 tools 声明
  字段），这条注入链路从未接通。一并清理依赖它的死代码：`resolveAgentTools` 的
  `toolMap`/`enabledExtensionIds`/`_agentName` 三个恒 no-op 参数、`listGlobalTools` 的
  空迭代段、相关误导性注释与测试用例。函数签名精简为 `(baseTools, harvestedTools)`。
  扩展工具的实际放行靠默认 agent 的排除式路径（不配 tools 白名单时全部放行），行为
  完全等价。影响范围：`packages/shared/src/constants.ts`、
  `packages/shared/tests/constants.test.ts`、`packages/kernel/src/agent-manager.ts`。
- **测试断言跟进 Icon 化改造（emoji → svg）+ DirTreePicker 查询重构，全量测试转绿**：
  前端把技能 chip 闪电符、项目/目录树图标由 Unicode emoji（⚡🏠📁📄）统一替换为内联
  SVG（Icon 组件）后，测试断言仍按 emoji 文本匹配，且 react-complex-tree 的 treeitem
  `<li>` 内目录名与 svg 图标同层导致 testing-library 的 getByText 因「文本被多元素分割」
  匹配不到，共 24 个测试失败。修复分三块：(1) ComposerTextarea/tokens 的技能 chip
  断言改按 data-token + svg 标记；(2) ProjectItem 图标断言改按 Icon testId（实现侧给
  home/folder/folder-open 三个图标补 testId）；(3) DirTreePicker 新增 treeItem/queryTreeItem
  helper，直接定位 [data-rct-item-interactive]（rct-tree-item-button，文本载体 + 点击选中
  目标 + 展开箭头兄弟），替换所有树节点的 getByText/queryByText/click(getByText)，并去掉
  残留 📁/📄 emoji 正则前缀、修正完整路径字符串转义。全量测试 1058 pass / 0 fail。
  影响范围：`packages/frontend/tests/ComposerTextarea.test.tsx`、
  `packages/frontend/tests/tokens.test.ts`、
  `packages/frontend/tests/ProjectItem.system.test.tsx`、
  `packages/frontend/tests/DirTreePicker.test.tsx`、
  `packages/frontend/src/components/ProjectItem.tsx`。
- **ext-error-spam-demo 新增 `/exterr one` 命令级错误路径**：原 demo 只能经
  input handler 凑 50 条（需 `/exterr fire` + 再发一条消息两步触发），无法快速
  验证单条 extension_error 的渲染。新增 `/exterr one` 子命令，handler 直接 throw，
  被 pi `_tryExecuteExtensionCommand` 整体 try/catch 捕获为 1 条错误
  （event:`command`、extensionPath:`command:exterr`），与 input 路径
  （event:`input`）天然区分。现在两条路径都可在诊断列表回归。
  影响范围：`examples/ext-error-spam-demo/index.ts`、
  `examples/ext-error-spam-demo/README.md`。
- **聊天导出菜单改为 portal 浮层 + 新增「导出轮数」设置**：导出按钮的下拉菜单原用
  absolute 定位，被消息列表滚动容器的 overflow 裁剪、靠近底部时被截断。现改用
  createPortal 提到 document.body（fixed z-50），按按钮位置计算坐标并在空间不足时
  自动向上翻转。同时在「系统设置-通用」新增「导出轮数」滑块（1-5 轮，默认 1 轮），
  持久化到 ui-prefs，ExportButton 导出时读取该值作为 collectTurns 的 maxTurns。
  影响范围：`packages/frontend/src/store/ui-prefs.ts`、
  `packages/frontend/src/components/settings/GeneralSection.tsx`、
  `packages/frontend/src/components/blocks/ExportButton.tsx`、
  `packages/frontend/src/components/blocks/ExportButton.test.tsx`。
- **setWidget 收起态改为半透明悬浮队列，不再占用聊天区/输入框垂直空间**：此前
  ExtWidget 即使"收起"仍渲染一个完整按钮行（箭头+key+首行预览+外边距）插入
  文档流，挤压聊天区和 Composer。现重构为：所有 widget（above/below 不分左右）
  收起时排成**单一队列**，半透明（opacity 0.4）悬浮贴 Composer 上沿
  （position absolute，脱离文档流）→ 零垂直占位；above 用 ↑(紫)、below 用
  ↓(灰) SVG 图标区分类型。窄条数量溢出时左右出现箭头按钮（26×24px），点击
  平滑滚动一个窄条宽度，到头自动隐藏。点击窄条 → 展开（testid 转移到展开块）
  在聊天区与 Composer 之间占位显示完整内容 + "收起 ✕"；收起后窄条回队列。
  影响范围：`packages/frontend/src/components/SessionView.tsx`（主容器加
  relative、新增 ExtWidgetDock 组件替代原 above/below 分组渲染的 ExtWidget）、
  `packages/frontend/tests/SessionView.test.tsx`（2 个 widget 用例适配新交互：
  点击 chip 展开 / 点击 collapse-btn 收起）、
  `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`（widget 颜色用例适配）。

- **ext-ui-bridge-demo 增加 ANSI 颜色演示命令 + 全链路 E2E 验证**：
  demo 扩展新增 `/uidemo color` 子命令，一键触发 notify/setStatus/
  setWidget/setTitle 全部带 ANSI SGR 颜色码的 UI 请求，验证 kernel 透传
  → 前端 AnsiText 解析的端到端彩色渲染；README 补「颜色演示」章节与表格
  说明。同步在 `ext-ui-bridge-demo.spec.ts` 追加两条 E2E：① notify 消息
  永久保留（10s 后仍在）且解析出内联颜色 span；② widget 展开后彩色行可见。
  E2E 全 7 通过（隔离端口 19776/15180）。
  影响范围：`examples/ext-ui-bridge-demo/index.ts`、
  `examples/ext-ui-bridge-demo/README.md`、
  `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`。

- **新增 ext-error-spam-demo 扩展错误测试桩**：参照 ext-ui-bridge-demo，
  新增本地扩展 `examples/ext-error-spam-demo`，用于一次性向「系统设置 >
  诊断」的扩展错误列表（`extension_error`，内存态最近 50 条）灌满 50 条
  有区分度的错误，回归 DiagnosticsSection 的满列表渲染 / 截断 / 清空 /
  滚动表现。机制：注册 50 个 `input` handler 各抛一条带编号（#01..#50 +
  场景）的错，`emitInput` 对同事件多 handler 逐个独立 try/catch → 一条
  用户消息正好产生 50 条 `extension_error`；`/exterr fire|off|reset|status`
  控制装填。规避 kernel 约束：命令 handler 抛错只算 1 条，扩展无主动
  emit/off 接口，故用 armed 开关 + fired 一次性标志。
  影响范围：`examples/ext-error-spam-demo/`（新增 package.json / index.ts
  / README.md）。

- **聊天消息导出为图片**：AI 回复旁（复制按钮左侧）新增导出 icon，点击弹菜单选
  「下载 PNG / 复制图片」，把当条消息往前最多 5 轮的文本对话（用户提问 + AI 文字回复，
  不含思考/工具等过程）生成为分享卡片图片。新增依赖 html-to-image。
  影响范围：`packages/frontend/src/util/export-chat-image.ts`、
  `packages/frontend/src/components/blocks/ExportImageCard.tsx`、
  `packages/frontend/src/components/blocks/ExportButton.tsx`、
  `packages/frontend/src/components/MessageList.tsx`。
- **kernel 透传扩展 UI 文本 ANSI 颜色码，fire-and-forget 不再回复
  extension_ui_response**：`RpcClient.handleUiRequest` 此前对
  notify/setStatus/setWidget/setTitle 的文本统一 `stripAnsi` 剥离终端
  转义码，扩展经 `ctx.ui.theme` 着色的文本到前端后丢失颜色。现改为 ANSI
  原文透传，由前端解析渲染颜色。同时对齐 pi 官方行为（rpc-mode.js
  "Fire and forget - no response needed"）：fire-and-forget 方法
  （notify/setStatus/setWidget/setTitle/set_editor_text）不再回复
  `extension_ui_response`，仅对话类方法（select/confirm/input/editor/
  custom）回复。
  影响范围：`packages/kernel/src/rpc-client.ts`、
  `packages/kernel/tests/rpc-client.test.ts`、
  `packages/kernel/tests/fixtures/fake-pi.ts`（新增多余 ui_response 计数，
  供测试断言）。
- **新增 AnsiText 组件解析 ANSI SGR 颜色码**：新增
  `packages/frontend/src/components/ui/AnsiText.tsx`，单文件零依赖 ANSI
  SGR 颜色解析：`parseAnsiToNodes` 纯函数支持 16 色/bright 色/xterm 256
  色/RGB 真彩的 foreground 与 background、reset(0) 与 39/49 单独复位，
  非 SGR 序列丢弃；`AnsiText` 组件薄封装供渲染层使用。为后续
  notify/setStatus/setWidget/setTitle 彩色渲染提供基础设施。
  影响范围：`packages/frontend/src/components/ui/AnsiText.tsx`（新增）、
  `packages/frontend/tests/ansi-text.test.ts`（新增）。
- **extension_notify 永久保留不去重 + 扩展 UI 文本 ANSI 颜色渲染**：
  前端 session store 的 `extension_notify` 此前 20s 自动消退且与上一条
  同内容时去重，扩展的着色反馈既留不住又丢颜色。现移除自动消退
  setTimeout 与同内容去重逻辑，每条 notify 都永久插入聊天列表；同时
  MessageList 的 custom 消息、SessionView 的 extStatus 状态栏与
  ExtWidget 摘要/正文、App 的 extTitle 标题条全部改用 `AnsiText` 渲染，
  kernel 透传的 ANSI 颜色码解析为内联样式呈现。
  影响范围：`packages/frontend/src/store/session.ts`、
  `packages/frontend/src/components/MessageList.tsx`、
  `packages/frontend/src/components/SessionView.tsx`、
  `packages/frontend/src/App.tsx`、
  `packages/frontend/tests/session-extension-notify.test.ts`、
  `packages/frontend/tests/session-notify-auto-dismiss.test.ts`（重写）、
  `packages/frontend/tests/MessageList.test.tsx`、
  `packages/frontend/tests/SessionView.test.tsx`、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 修复

- **插件卸载/安装后当前会话的扩展 UI 残留不清理**：插件操作触发的 dirty
  reload 重建 pi 进程后，旧进程发射的扩展 UI（setStatus 状态栏 / setWidget
  文本块 / setTitle 标题条）仍留在前端 store，被卸载插件的 UI 继续显示。
  现 kernel `_reloadIfDirty` 重建成功后合成 `extension_ui_reset` 事件
  （SDKEvent 新增该类型），前端 session store 收到后清空该会话的三类扩展
  UI 状态（进程 resume 不重放扩展的 session_start 钩子，UI 是否重发由扩展
  自身行为决定）。
  影响范围：`packages/kernel/src/agent-manager.ts`、
  `packages/shared/src/types.ts`、
  `packages/frontend/src/store/session.ts`、
  `packages/kernel/tests/agent-manager.test.ts`、
  `packages/frontend/tests/session-extension-notify.test.ts`、
  `packages/frontend/e2e/extension-hot-reload.spec.ts`（新增）。

## [Unreleased] - 2026-08-04

### 修复

- **扩展命令不作为用户消息上屏（跟随 TUI 行为）**：已注册扩展命令（如
  /uidemo、内置插件的 /goal）被 pi 拦截直接执行 handler，不写 transcript、
  不发 user message 事件，但聊天窗会因两条通路多出一条不存在的用户消息：
  a) kernel `agent:prompt` 无条件回传 `session:echo_user`（新会话页依赖此
  回显）；b) 前端 `Composer.doSend` 空闲时无条件乐观插入。现 kernel 对
  slash 文本延迟到 ensureStarted 后查命令清单（命中 extension 来源 → 不
  回显；未注册 / prompt / skill 来源 / 查询失败 → 照常回显），前端
  Composer 对命中命令清单的扩展命令跳过乐观插入（commands store 新增
  未过滤的 `allCommands`，开关关闭的命令 pi 仍会拦截，口径与 kernel 一致）。
  影响范围：`packages/kernel/src/ws-server.ts`、
  `packages/frontend/src/store/commands.ts`、
  `packages/frontend/src/components/Composer.tsx`、
  `packages/kernel/tests/ws-agent-prompt-echo.test.ts`（新增）、
  `packages/frontend/tests/Composer.test.tsx`、
  `packages/frontend/tests/commands.test.ts`、
  `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **插件安装/卸载/升级后当前会话立即生效**：此前前端收到 `extension:changed`
  只更新插件列表，`/` 菜单命令缓存不刷新，插件命令要等切换会话才出现；
  设置页文案也仍是初版设计的"下次对话开始时生效"。现 `extension:changed`
  事件追加刷新当前会话命令列表（kernel `getCommands` 脏感知：idle 脏会话
  先重建 pi 进程再返回新清单），`$` 技能菜单本就走 `skill:changed` 实时刷新，
  两处文案同步改为"当前对话立即生效"。busy 会话维持 deferred（下次发消息生效）。
  影响范围：`packages/frontend/src/App.tsx`、
  `packages/frontend/src/components/settings/ExtensionSection.tsx`、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 修复

- **扩展 dialog 弹窗仅允许手动取消**：此前点击遮罩/ESC 会以 cancelled 关闭
  弹窗，误触会让 pi 扩展 handler 拿到意外的取消。现 `ExtensionDialog`
  禁用遮罩点击与 ESC 关闭（`Modal` 新增 `closeOnEsc` prop，默认 true 不影响
  其他弹窗），只有显式点「取消」才应答 cancelled；select 形态补「取消」
  按钮（此前无按钮，禁用 ESC/遮罩后将无法取消）。
  影响范围：`packages/frontend/src/components/ui/Modal.tsx`、
  `packages/frontend/src/components/ExtensionDialog.tsx`、
  `packages/frontend/tests/ExtensionDialog.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **对接 pi 扩展 dialog 子协议（kernel 侧）+ set_editor_text 事件转发**：
  pi RPC 的 select/confirm/input/editor 对话请求此前一律 auto-cancel
  （onUiRequest 无人提供）。现新增进程级单例 `ExtUiRegistry`（语义对齐
  ask-registry）：agent-manager 注入 `onUiRequest`，注册 pending 后以
  `extension_dialog` 事件（sdk:event 信封）广播前端；前端经
  `POST /api/extensions/dialog/respond`（WS 事件 `extension:dialog:respond`）
  应答，未知/已应答 id 返回 400「对话不存在或已应答」。
  abort / _teardownSession / 进程崩溃均兜底 cancelAllForSession 防泄漏。
  同时把 fire-and-forget 的 set_editor_text 桥接为 `extension_editor_text`
  事件（转发语义：替换输入框内容，由前端 Composer 消费），并修正
  `_fetchCommands` docstring 遗留的「附加 TUI 标记」表述。
  前端侧（本次补充）：新增 `ext-dialog` zustand 队列 store 与
  `ExtensionDialog` 弹窗组件（Modal 壳，按 method 渲染
  select/confirm/input/editor 四种形态，应答统一 POST respond 路由，
  App 根部挂载）；session store 分发 `extension_dialog` 入队、
  `extension_editor_text` 写入新字段 `editorTextInjection`；Composer 按
  ts 去重消费注入文本（替换输入框并写草稿，应用后立即清除注入记录，
  防止组件重挂载时用旧注入覆盖用户草稿）。shared 的 SDK 事件联合类型
  补上两个事件声明；kernel 补 `_onExtUiRequest` 广播契约单测。
  影响范围：`packages/kernel/src/ext-ui-registry.ts`（新）、
  `packages/kernel/src/agent-manager.ts`、`packages/kernel/src/ws-server.ts`、
  `packages/kernel/src/routes/extensions.ts`、`packages/kernel/src/rpc-client.ts`、
  `packages/shared/src/extensions.ts`、`packages/shared/src/types.ts`、
  `packages/kernel/tests/ext-ui-registry.test.ts`（新）、
  `packages/kernel/tests/routes-extensions-commands.test.ts`、
  `packages/kernel/tests/rpc-client.test.ts`、
  `packages/kernel/tests/agent-manager.test.ts`、
  `packages/kernel/tests/fixtures/fake-pi.ts`、
  `packages/frontend/src/store/ext-dialog.ts`（新）、
  `packages/frontend/src/components/ExtensionDialog.tsx`（新）、
  `packages/frontend/src/store/session.ts`、
  `packages/frontend/src/components/Composer.tsx`、
  `packages/frontend/src/App.tsx`、
  `packages/frontend/tests/ExtensionDialog.test.tsx`（新）、
  `packages/frontend/tests/store-session.test.ts`、
  `examples/ext-ui-bridge-demo/index.ts`（补 dialog/seteditor 子命令）、
  `examples/ext-ui-bridge-demo/README.md`、
  `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`（新，E2E 全链路验证）。

### 重构

- **删除 tuiOnly 静态扫描，仅保留 packageName 附加**：kernel
  `tui-command-filter.ts` 的 `filterTuiCommands` 改名 `attachPackageName`，
  不再扫描扩展源码识别 TUI-only 命令（`isTuiOnlyExtension` 同步删除）。
  理由：pi 官方无 TUI-only 概念（RPC 模式 custom() 返回 undefined、
  dialog 方法有官方子协议），前端自 e9eeae10 起不再消费 tuiOnly 标记，
  扫描纯属开销且会误标。`CommandInfo.tuiOnly` 字段一并删除。
  影响范围：`packages/kernel/src/tui-command-filter.ts`、
  `packages/kernel/src/agent-manager.ts`、
  `packages/shared/src/commands.ts`、
  `packages/shared/tests/commands.test.ts`、
  `packages/kernel/tests/tui-command-filter.test.ts`、
  `packages/kernel/tests/agent-manager.test.ts`、
  `packages/frontend/src/components/settings/CommandListModal.test.tsx`。

### 修复

- **本地扩展 Windows 绝对路径加载绕过 createRequire**：local 来源插件在
  settings.json `waPiPackages` 里存绝对路径，`buildAdditionalExtensionPaths`
  原先用 createRequire 解析，Windows 反斜杠路径会被损毁（`H:\a\b` → `H:ab`），
  导致本地路径安装的扩展从未进入 pi 的 `-e` 加载列表、其命令/工具不注册。
  现对绝对路径条目改走文件系统直读（新增内部 `resolveLocalExtensionEntry`，
  优先级与 npm 路径对齐：pi.extensions 声明 → 约定入口），npm 裸包名逻辑不变。
  影响范围：`packages/kernel/src/extensions.ts`、
  `packages/kernel/tests/extensions.test.ts`。

## [Unreleased] - 2026-08-04

### 重构

- **内置命令拦截统一封装到 shared**：新增 `KERNEL_INTERCEPTED_COMMANDS` 清单
  与 `matchKernelCommand()` 匹配函数（`@wa-pi/shared` commands.ts），作为
  「kernel 拦截的内置命令」语义的唯一权威来源。kernel `_sendPromptNow` 与
  前端 `optimisticSend` 不再各自硬编码 `/^\/compact(\s|$)/` 正则，统一改调
  `matchKernelCommand`；新增内置命令（如未来的 /clear）只需改 shared 一处。
  影响范围：`packages/shared/src/commands.ts`、
  `packages/shared/tests/commands.test.ts`、
  `packages/kernel/src/agent-manager.ts`、
  `packages/frontend/src/store/session.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **local 插件命令「附加命令」弹窗扫不到**：根因有二：a) local 插件
  身份不一致——ExtensionManager 以绝对路径为 name，而命令扫描侧
  （官方 get_commands RPC + sourceInfo 推导）以 package.json name 为
  packageName，前端按全等过滤永远为空；现 local 插件身份统一为
  package.json name（extractNames 保留绝对路径别名，重复检测/旧数据
  兼容）。b) `getCommands` 借用活跃进程不检查 dirty——安装扩展后旧
  进程清单过期；现命中/借用 dirty 进程时先重建再取。
  注：调查期间曾实现过「扩展命令不回显用户消息」方案（kernel 延迟
  echo + Composer 跳过乐观插入），后按产品决策**整体回退**——最终
  行为为「扩展命令按正常文本发送并回显，pi 同时执行命令 handler」
  （对齐 pi TUI 行为），相关代码未入库。
  影响范围：`packages/kernel/src/extension-manager.ts`、
  `packages/kernel/src/agent-manager.ts`、
  `packages/kernel/tests/extension-manager.test.ts`、
  `packages/kernel/tests/agent-manager.test.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **/compact 不再显示为用户聊天消息**：`optimisticSend` 对 `/compact`（含自定义
  指令）跳过用户消息插入——kernel 已将其转 compact RPC 执行，pi 不产生 user
  回声，此前聊天列表会孤零零挂一条 "/compact"。思考态与占位 streaming 照常
  设置。连带删除 `agent_end` 分支里「最后一条 user 以 /compact 开头则刷新
  token」的失效检测（compaction_end 已是权威刷新点）。影响范围：
  `packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/store-session.test.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **本地插件安装支持 Windows 路径**：`parseExtensionInput` 此前只识别 `/`、`./`、
  `~/` 开头的本地路径，`H:\...` 盘符路径会落入 npm 包名校验被拒绝（报
  「无效的插件名称格式」）。现新增盘符（`C:\` / `C:/`）与 UNC（`\\server\share`）
  路径识别，Windows 本地路径可正常安装。
  影响范围：`packages/kernel/src/extension-manager.ts`、
  `packages/kernel/tests/extension-manager.test.ts`。

## [Unreleased] - 2026-08-04

### 重构

- **移除发送端 / 命令降级拦截**：`prompt` 不再在发送前拉取命令清单、不再把
  已关闭命令加前导空格降级为普通文本，所有 / 命令原样交给 pi 命令分发。
  连带移除 `_commandsFetched` 标记、`resetCommandState()`（ws-server toggle
  不再调用）、`tui-command-filter` 的 `disabledCommandNames` 集合及
  `isCommandDisabled` / `registerDisabledCommands` / `resetDisabledCommands`
  三个函数；`markAllDirty` / `markSkillsDirty` 不再重置命令状态。
  同时修复该移除暴露的既有 bug：`_runCompactCommand` 合成的 `agent_settled`
  此前经 `opts.onEvent` 直发前端、不触发内部 drain，压缩期间排队的消息会
  永久卡在 followUpList；现改走 `_onSessionEvent` 正常 drain 后转发。
  影响范围：`packages/kernel/src/agent-manager.ts`、
  `packages/kernel/src/tui-command-filter.ts`、
  `packages/kernel/src/ws-server.ts`、
  `packages/desktop/scripts/build-kernel-sidecar.ts`（注释）、
  `packages/kernel/tests/agent-manager.test.ts`、
  `packages/kernel/tests/tui-command-filter.test.ts`、
  `packages/kernel/tests/routes-extensions-commands.test.ts`。

## [Unreleased] - 2026-08-04

### 配置变更

- **附加命令默认全部开启 + 移除「TUI 命令不被支持」提示条**：扩展命令开关
  缺省语义从「未记录 = 关闭」翻转为「未记录 = 开启」（pi-goal 等有 RPC 降级
  的命令此前默认被禁用且降级为文本，用户困惑）。`getCommandToggle` 与
  `_fetchCommands` 合并的缺省值 `?? false → ?? true`；仅显式关闭的命令
  登记进 disabledCommandNames 降级。同时移除命令列表弹窗顶部
  「注意：TUI 命令不被支持」黄色提示条（tuiOnly 标记仍在，仅文案下线）。
  影响范围：`packages/kernel/src/extension-manager.ts`、
  `packages/kernel/src/agent-manager.ts`、
  `packages/frontend/src/components/settings/CommandListModal.tsx`、
  `packages/kernel/tests/extension-manager.test.ts`、
  `packages/kernel/tests/agent-manager.test.ts`、
  `packages/frontend/src/components/settings/CommandListModal.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **新增 UI 桥接测试桩扩展 `examples/ext-ui-bridge-demo`**：覆盖全部四类
  扩展 fire-and-forget UI 请求（notify → toast、setStatus → 聊天列底部
  状态栏、setWidget → Composer 上/下方可折叠文本块、setTitle → 聊天窗
  顶部状态条）。`session_start` 自动全量触发，另注册 `/uidemo
  all|notify|status|widget|title|clear` 命令手动演示。仅 `import type`，
  运行时零依赖，作为本地扩展安装即可用；长期保留在仓库内，不随测试清理。
  影响范围：`examples/ext-ui-bridge-demo/`（package.json / index.ts /
  README.md）。

## [Unreleased] - 2026-08-04

### 修复

- **停止主会话时级联中止子代理进程**：此前点「停止」只 abort 主会话 pi，
  正在跑的 delegate/fleet 子代理进程继续跑到完成（结果无人消费、token 白烧，
  fleet 时最多 5 个孤儿进程）。接线已有的半成品能力：会话 handle 新增
  `subagentAborts` 登记表，`makeSpawnFn` 每次派发创建一个 AbortController
  登记（完成移除，叠加外层 signal），`runSubagent` 收到 signal 后优雅中止
  子进程并返回「子智能体已被中止」；`agent-manager.abort()` 与
  `_teardownSession`（防拆除泄漏）级联触发表内全部 controller。
  影响范围：`packages/kernel/src/agent-manager.ts`（登记表 + 两处级联）、
  `packages/kernel/src/delegate-tool.ts`（makeSpawnFn abortRegistry）、
  `packages/kernel/tests/delegate-tool.test.ts`、
  `packages/kernel/tests/agent-manager.test.ts`。

## [Unreleased] - 2026-08-04

### 新增功能

- **setWidget 文本块改为可折叠 + 背景透明**：扩展 `setWidget` 此前以
  `bg-surface-elevated` 不透明色块整段平铺在 Composer 上/下方，占用大量
  垂直空间。改为可折叠组件：默认收起为一行摘要（▶ 箭头 + widget key +
  首行预览），点击展开显示完整等宽文本；内容框去掉不透明底色，仅保留
  左侧 accent 竖线与细边框。收起后只占一行高度。
  影响范围：`packages/frontend/src/components/SessionView.tsx`
  （新增 ExtWidget 组件）、`packages/frontend/tests/SessionView.test.tsx`。

## [Unreleased] - 2026-08-04

### 重构

- **移除 pi-open-agents 依赖**：子代理执行实为 wa-pi 自实现（subagent-runner
  直接 spawn 一次性 pi RPC 子进程；delegate 子进程本就只加载
  provider-extension），pi-open-agents 在会话进程内注册的能力均无消费——
  原生 subagent 工具被 allowlist 屏蔽（`BLOCKED=["subagent"]`）、/agent 命令
  无人调用、banner 只剩误报（「No agent selected」TUI 提示）。移除点：
  `PKG_EXTENSIONS` 加载清单、kernel/desktop sidecar 依赖声明、
  build-kernel-sidecar 生成清单；同步清理 delegate-tool/subagent-runner/
  builtin-agents/subagent-info 的过时注释。验证：kernel 705 测试全过；
  真实 pi RPC 启动无 extension_error、/agent 命令消失、banner widget 不再出现。
  修复测试期间发现 fake-pi 桩的 U+2028 不可见字符曾被编辑器归一化丢失，
  已恢复。影响范围：`packages/kernel/src/extensions.ts`、
  `packages/kernel/package.json`、`packages/kernel/src/delegate-tool.ts`、
  `packages/kernel/src/subagent-runner.ts`、`packages/kernel/src/builtin-agents.ts`、
  `packages/kernel/src/subagent-info.ts`、`packages/kernel/scripts/eval-delegate-trigger.ts`、
  `packages/desktop/scripts/build-kernel-sidecar.ts`、
  `packages/desktop/resources/kernel/package.json`、
  `packages/kernel/tests/extensions.test.ts`、`bun.lock`。

## [Unreleased] - 2026-08-04

### 配置变更

- **移除内置扩展 pi-cache-optimizer**：不再默认加载该扩展，Pi 子进程启动参数
  中不再包含 `-e pi-cache-optimizer`。依赖同时从 kernel、desktop seed 和
  sidecar 构建脚本中移除。缓存命中率 UI 仍基于 Pi SDK 返回的
  `usage.cacheRead / (input + cacheRead + cacheWrite)` 计算，不受影响。
  影响范围：`packages/kernel/src/extensions.ts`、
  `packages/kernel/package.json`、
  `packages/desktop/resources/kernel/package.json`、
  `packages/desktop/scripts/build-kernel-sidecar.ts`、
  `bun.lock`。

## [Unreleased] - 2026-08-04

### 修复

- **扩展 UI 文案剥离 ANSI 转义码 + setStatus 状态栏改挂聊天列**：pi 扩展经
  `ctx.ui.theme` 着色的文本（如 pi-open-agents 的 banner hint）携带
  `\x1b[38;5;Nm` 终端转义码，此前在 widget/状态栏原样显示为乱码。kernel
  rpc-client 新增 `stripAnsi`，notify/setStatus/setWidget/setTitle 四类桥接
  文案统一剥离。同时按产品要求调整 setStatus 状态栏位置：从窗口全局底栏
  （跨左侧项目列表/右侧文件树）改为只挂聊天列底部、文字右对齐，App 根布局
  回退为原 flex 行结构。
  影响范围：`packages/kernel/src/rpc-client.ts`、
  `packages/frontend/src/App.tsx`（移除全局底栏）、
  `packages/frontend/src/components/SessionView.tsx`（聊天列状态栏）、
  `packages/kernel/tests/rpc-client.test.ts`、
  `packages/kernel/tests/fixtures/fake-pi.ts`（ANSI 桩）、
  `packages/frontend/tests/SessionView.test.tsx`、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **extension_error 诊断可视化（方案 A）+ 扩展状态展示（setStatus/setWidget/setTitle）**：
  roadmap Next #1/#2 落地。kernel rpc-client 把 fire-and-forget UI 请求
  （setStatus/setWidget/setTitle）与 notify 同路径桥接为 sdk:event 转发
  （set_editor_text 维持不做）。前端四处 UI——
  ①`extension_error` → error toast 即时提醒 + 系统设置新增「诊断」区块
  （内存态最近 50 条：时间/扩展/事件/错误，可清空）；
  ②`setStatus` → 窗口底部 26px 全局状态栏（App 根布局改 flex-col 承载，
  statusKey 去重、空文案清除）；
  ③`setTitle` → 聊天窗顶部状态条（产品决策：不写 document.title，
  避免公共标题被扩展覆盖）；
  ④`setWidget` → Composer 上/下方文本块（aboveEditor 紫竖线 /
  belowEditor 灰竖线，等宽字体，widgetLines 空清除）。
  SDKEvent 补 extension_error/extension_status/extension_widget/
  extension_title 四个声明。
  影响范围：`packages/shared/src/types.ts`、
  `packages/kernel/src/rpc-client.ts`（桥接）、
  `packages/frontend/src/store/session.ts`（四个 case + 三个状态表）、
  `packages/frontend/src/store/diagnostics.ts`（新增）、
  `packages/frontend/src/App.tsx`（底栏 + 标题条 + 根布局 flex-col）、
  `packages/frontend/src/components/SessionView.tsx`（widget 块）、
  `packages/frontend/src/components/settings/DiagnosticsSection.tsx`（新增）、
  `packages/frontend/src/components/SettingsModal.tsx`、
  `packages/frontend/src/store/settings.ts`、
  `packages/kernel/tests/rpc-client.test.ts`（fake-pi 补 ui_fire_and_forget）、
  `packages/kernel/tests/fixtures/fake-pi.ts`、
  `packages/frontend/tests/store-session.test.ts`、
  `packages/frontend/tests/DiagnosticsSection.test.tsx`、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **对接 `summarization_retry_*` 事件（roadmap Now #1 收尾）**：压缩/分支摘要的
  LLM 调用 transient 失败重试此前是无反馈的静默等待。`SDKEvent` 补三个事件
  声明（`summarization_retry_scheduled{attempt,maxAttempts,delayMs,errorMessage}`、
  `summarization_retry_attempt_start{source:branchSummary|compaction+reason}`、
  `summarization_retry_finished`）；前端 store 复用 `retryBySession` 驱动同一
  黄色重试状态条——scheduled 记录进度、attempt_start 显式保持、finished 清除
  （最终失败由随后 `compaction_end{errorMessage}` 文案呈现）。SDKEvent 声明
  覆盖达 20/21（仅余不会产生的 bash_execution_update）。
  影响范围：`packages/shared/src/types.ts`、
  `packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/store-session.test.ts`。

## [Unreleased] - 2026-08-04

### 新增功能

- **对接 `agent_settled` / `turn_start` / `turn_end` 事件（roadmap Now #2 类型债）**：
  `SDKEvent` 补 `agent_settled` 声明（turn_* 此前已有类型）。前端 store 新增
  `agent_settled` case——pi 语义为「重试/压缩重试/排队续跑全部终结」，正常
  已被 `agent_end{willRetry:false}` 复位，此处作思考态兜底（agent_end 缺失/
  乱序的异常路径防卡死，已空闲则不产生状态变更）；`turn_start`/`turn_end`
  显式忽略（消息流已由 message_start/update/end 驱动，turn_end 携带的
  message/toolResults 与之重复不合并；turn 粒度遥测归 roadmap Later）。
  kernel 侧 agent-manager 本就以 agent_settled 管理 busy/drain，无需改动。
  影响范围：`packages/shared/src/types.ts`（SDKEvent）、
  `packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/store-session.test.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **compactionSummary 消息不再内联渲染摘要正文 + 两条压缩提示路径文案统一**：
  历史里的压缩节点此前渲染为「—— 已压缩早期上下文 · {摘要全文} ——」，
  摘要本身是完整长篇 markdown（Goal/Progress 等），内联展开直接刷屏；
  且 live（compaction_end 插入的「已压缩上下文：X → Y（释放 Z）」）与重载历史
  的压缩节点提示文案不一致、refreshTokenTotals 保留本地成功消息还会造成重复提示。
  现统一为「—— 已压缩早期上下文 · 压缩前 X token ——」（jsonl 不持久化
  estimatedTokensAfter，两边只一致展示 tokensBefore）；refresh 时本地成功的
  compaction_status 消息被去重（进行中/取消/失败仍保留）。`fmtTok` 提取为
  公共 `util/format.ts`（SessionView/MessageList/session store 共用）。
  影响范围：`packages/frontend/src/util/format.ts`（新增）、
  `packages/frontend/src/components/MessageList.tsx`、
  `packages/frontend/src/components/SessionView.tsx`、
  `packages/frontend/src/store/session.ts`、
  `packages/frontend/tests/MessageList.test.tsx`、
  `packages/frontend/tests/store-session.test.ts`。

## [Unreleased] - 2026-08-04

### 修复

- **冷会话点开后「窗口占比」胶囊不显示**：点开会话时前端并行拉 /messages +
  /stats，而后台预热（session:messages 的 ensureStarted）要 5-10s——stats 落在
  降级路径没有 contextUsage，且预热完成后无任何通知，占比要等下一回合
  message_end 才出现。现在预热完成后冷启动场景广播 `session:activated`
  （热会话不重复广播），前端收听后 `refreshSessionStats` 重拉 /stats 补齐
  占比/进度条。AgentManager 新增 `isSessionAlive` 用于冷/热判断。
  影响范围：`packages/kernel/src/ws-server.ts`（session:messages 预热广播）、
  `packages/kernel/src/agent-manager.ts`（isSessionAlive）、
  `packages/shared/src/types.ts`（SessionActivatedEvent）、
  `packages/frontend/src/App.tsx`（事件监听）、
  `packages/kernel/tests/ws-server-session-prewarm.test.ts`、
  `packages/kernel/tests/session-messages.test.ts`（桩补 isSessionAlive）、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **系统设置「通用」新增文字大小滑块（12-32px，只缩放文字不动布局）**：
  拖动滑块调整文字大小，即时生效，localStorage 持久化（`wa-pi-ui-prefs`）。
  实现：CSS 变量 `--font-scale`（= 字号/16）——全项目字号声明统一挂到该
  变量：Tailwind px 任意值（199 处 `text-[Npx]` → `text-[calc(Npx*var(--font-scale))]`）、
  styles.css 自定义规则（10 处）、内联 fontSize（5 处）逐一改为 calc；
  rem 字号类（text-xs/sm/base/lg/xl/3xl）在 styles.css 末尾加同级覆盖
  （后定义生效，间距等 rem 布局不受影响）。期间否决过两版方案：根
  `font-size`（px 声明不缩放，覆盖不全）与 CSS `zoom`/webFrame（vw/vh
  布局随缩放错位，用户反馈布局错乱）。
  影响范围：`packages/frontend/src/store/ui-prefs.ts`（新增）、
  `packages/frontend/src/styles.css`、`packages/frontend/src/main.tsx`、
  `packages/frontend/src/components/**`（37 个 tsx 机械替换）、
  `packages/frontend/src/components/settings/GeneralSection.tsx`、
  `packages/frontend/tests/store-ui-prefs.test.ts`、
  `packages/frontend/tests/GeneralSection.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **系统设置新增「通用」区块：pi 自动重试次数 / 间隔可配置**：设置页左侧导航
  新增「通用」，可配置 transient 错误（网络/超时/5xx/限流）后的自动重试——
  重试次数（0-10，默认 3，产品上限 10）与退避间隔基数（0.5-60 秒，默认 2 秒，
  实际延迟按基数 × 2ⁿ 递增）。持久化到 `~/.wa-pi/settings.json` 的 `retry`
  字段（pi settings-manager 直接消费，read-modify-write 保留其他字段）；
  保存后 kernel 标脏活跃会话，下次发消息重建 pi 进程生效，重试状态条
  「正在自动重试 (n/m)」的 m 同步反映新配置。
  kernel 新增 `settings-store.ts`（读写 + 校验）、WS `settings:get/save` 事件、
  REST `GET/PUT /api/settings/retry`（非法值 400 + 中文错误文案）。
  影响范围：`packages/shared/src/types.ts`（RetrySettings/settings 事件）、
  `packages/kernel/src/settings-store.ts`、`packages/kernel/src/ws-server.ts`、
  `packages/kernel/src/routes/settings.ts`、
  `packages/frontend/src/store/settings.ts`（general 区块）、
  `packages/frontend/src/components/SettingsModal.tsx`（导航）、
  `packages/frontend/src/components/settings/GeneralSection.tsx`、
  `packages/kernel/tests/settings-store.test.ts`、
  `packages/frontend/tests/GeneralSection.test.tsx`、
  `packages/frontend/tests/SettingsModal.test.tsx`。

## [Unreleased] - 2026-08-04

### 新增功能

- **自动重试状态条（方案 B：顶部黄条接管）**：pi 自动重试期间（`auto_retry_start`
  → 退避 → 新尝试），顶部红色「模型连接异常，请检查网络或 Provider 配置」
  切换为黄色「模型请求失败，正在自动重试 (n/m)…」（复用 reconnecting 的
  warning 样式），明确传达「可恢复的等待」而非误导性的配置错误告警；
  重试结束（`auto_retry_end` 成功/耗尽/中止）黄条消失，若 transient 错误
  仍未恢复则回到红条。store 新增 `retryBySession`（auto_retry_start 记录
  attempt/maxAttempts，auto_retry_end 与终态 agent_end 清除）；思考行
  「思考中 · Xs」保持不变。
  影响范围：`packages/frontend/src/store/session.ts`（retryBySession）、
  `packages/frontend/src/App.tsx`（retry-status-bar）、
  `packages/frontend/tests/store-session.test.ts`、
  `packages/frontend/tests/App.test.tsx`。

## [Unreleased] - 2026-08-04

### 修复

- **接入 pi `auto_retry_start` / `auto_retry_end` 事件：自动重试期间保持思考态**：
  此前 transient 错误（如 provider 503/超时）触发 pi 自动重试时，
  `agent_end{willRetry:true}` 会把前端复位为 idle——退避等待期间思考态中断、
  输入区 spinner 消失，用户误以为回复已结束。现在 `agent_end` 带
  `willRetry:true` 时不结算（保持 thinking、不标未读、不写回耗时）；
  新增 `auto_retry_start` case 防御性保持 thinking；`auto_retry_end{success:false}`
  （重试耗尽 / 退避期被 abort，此路径不会再有 agent_end）复位 idle 防思考态卡死；
  `success=true` 不动状态（本轮继续，终态由后续 `agent_end{willRetry:false}` 复位）。
  `SDKEvent` 联合类型补齐两个事件声明。kernel 无需改动（事件本已全量透传，
  busy 由 agent_settled 管理，重试期间不会误复位）。
  影响范围：`packages/shared/src/types.ts`（SDKEvent）、
  `packages/frontend/src/store/session.ts`（agent_end/auto_retry_* case）、
  `packages/frontend/tests/store-session.test.ts`（5 个重试场景用例）。

## [Unreleased] - 2026-08-04

### 修复

- **token 统计口径修正（累计 / 进度条 / 占用三层分离）**：修复聊天窗口右上角
  「累计 xxx k」统计错误——此前用「可见消息的 Σ(input+output)」，漏算
  cacheRead/cacheWrite、压缩后丢历史，且把「累计」误当「当前窗口占比」画进度条。
  现在三层口径分离：①「累计」= 整个会话累计消耗（含 cache、含压缩前历史），
  数据源为 pi `get_session_stats().tokens`（进程不在时 kernel 降级扫 jsonl 全量累加）；
  ②进度条 = 当前上下文窗口占用 / 窗口上限，数据源为
  `get_session_stats().contextUsage`（used/total/ratio）；③进度条上方新增
  「占用 xxx k」= 当前窗口已用 token 数。
  胶囊布局：占用在上（主色，加强）→ 进度条 → 累计在下（小字三级灰，弱化）。
  **前端已移除全部本地统计**：删除 `addTokens` 增量累加（含 delegate childUsage
  累加）、`seedTokenTotal` 的可见消息遍历兜底、SessionView 的「lastUsage 估算占用」
  降级与模型 contextWindow 查表；所有数字只来自 `session:stats`。回合中由
  `message_end`（assistant 带 usage）触发轻量 `refreshSessionStats`（只拉 /stats），
  进度条/占用/累计每轮实时更新；进入会话与压缩结束仍走整量 seed/refresh 校正。
  kernel 新增 `computeSessionUsage`（压缩感知累计，死进程降级）、
  `agentManager.getSessionStats`、WS `session:stats` case 与
  REST `GET /api/sessions/:id/stats`；前端 store 扩展 `tokenTotals`
  （cache/total 五字段）与 `contextUsageBySession`，`statsPatch` 为官方数值唯一入口。
  **子代理消耗计入累计并拆分主/子**：delegate/fleet 的 toolResult 现携带 pi
  官方 `usage` 字段（子进程 LLM 消耗，fleet 多任务聚合），pi
  `get_session_stats` 原生计入累计（"usage reported by tools"），且随
  toolResult 持久化进 jsonl——重启不丢、无需 kernel 任何记账。
  主/子拆分统一来自 jsonl 全量扫描（`computeSessionUsage` 改返回
  `{ main, subagent }`：assistant+compaction/branch_summary→主，
  toolResult.usage→子）；官方路径 `splitOfficialTokens`（合计含子，主=合计−子，
  clamp 防旧会话不一致），降级路径 `mergeTokenUsage`（主+子求和）。
  前端「累计」独立胶囊列（弱化三级灰），子代理消耗 >0 时第二行显示
  「主 Y · 子 Z」拆分；「占用 + 进度条」为另一独立胶囊（主色加强）。
  影响范围：`packages/kernel/src/session-history.ts`（computeSessionUsage 拆分）、
  `packages/kernel/src/agent-manager.ts`（getSessionStats）、
  `packages/kernel/src/delegate-tool.ts`（toolResult 携带 usage）、
  `packages/kernel/src/bridge-registry.ts`、`packages/kernel/src/wa-pi-bridge.extension.ts`
  （usage 透传）、
  `packages/kernel/src/ws-server.ts`（session:stats + splitOfficialTokens/mergeTokenUsage）、
  `packages/kernel/src/routes/projects-sessions.ts`（REST stats 端点）、
  `packages/shared/src/types.ts`、`packages/frontend/src/store/session.ts`、
  `packages/frontend/src/components/SessionView.tsx`、
  `packages/frontend/src/styles.css`、
  `packages/kernel/tests/session-history.test.ts`、
  `packages/kernel/tests/delegate-tool.test.ts`、
  `packages/kernel/tests/ws-server-session-stats.test.ts`、
  `packages/frontend/tests/SessionView.test.tsx`、
  `packages/frontend/tests/store-session.test.ts`。

## [Unreleased] - 2026-08-03

### 变更

- **智能体编辑弹窗与列表弹窗叠加显示**：在智能体宫格（列表）里点「编辑 / 新建」打开
  编辑弹窗时，列表弹窗保持打开（编辑框盖在列表上，关闭编辑框后列表仍在），不再自动
  关闭。用户可在列表与编辑弹窗间对照选择。侧边栏编辑入口与 ⌘K / `/agents` 命令打开
  宫格也不再互相关闭。
  影响范围：`packages/frontend/src/App.tsx`、
  `packages/frontend/tests/App.test.tsx`（宫格新建 / 编辑用例改为断言列表保持打开）。

- **系统设置默认显示「通用」tab**：`useSettingsStore` 的 `activeSection` 初始值从
  `models` 改为 `general`。此前首次打开设置停在「模型管理」（历史遗留锚点），现在
  默认展示通用区块（自动重试等基础配置）；模型管理仍需用户手动点击。
  影响范围：`packages/frontend/src/store/settings.ts`、
  `packages/frontend/tests/SettingsModal.test.tsx`（供应商相关用例先切到模型管理 tab）。

### 修复

- **历史直读感知上下文压缩（readSessionHistory 压缩感知）**：修复压缩后 token 累计不变、
  历史列表不缩水的根因。pi 压缩是 append-only（compaction 节点后旧消息仍在 jsonl 链上），
  wa-pi 直读 jsonl 时沿链回溯会把压缩前的全部消息带出（usage 全被累加）。现在
  `readSessionHistory` 与 pi `buildContextEntries` 同语义：沿链找最新 compaction 节点，
  被压缩的旧消息省略，只保留压缩摘要 + `firstKeptEntryId` 之后的消息 + 压缩后的新消息；
  摘要转 `role:"compactionSummary"` 消息（对齐 pi `createCompactionSummaryMessage`），
  前端 MessageList 居中系统提示渲染。修复后右上角「累计」只反映压缩后的实际 usage，
  历史列表也正确收缩。
  影响范围：`packages/kernel/src/session-history.ts`、
  `packages/frontend/src/components/MessageList.tsx`、
  `packages/kernel/tests/session-history.test.ts`、`packages/frontend/tests/MessageList.test.tsx`。

### 新增

- **compaction_start / compaction_end 事件对接（前端）**：压缩过程现在有完整可见反馈——
  压缩开始时在消息列表插入「正在压缩上下文…」状态消息，压缩结束后替换为结果
  （`已压缩上下文：X → Y token（释放 Z）`，取消/失败显示对应文案）。`compaction_end`
  成为 token 累计刷新的权威信号（不再依赖 agent_end 的 /compact 文本检测），自动压缩
  （threshold/overflow）也顺带刷新 token 胶囊；`refreshTokenTotals` 整表覆盖时保留
  本地 `compaction_status` 消息。kernel 压缩失败不再合成 `message_end` 错误（避免与
  前端 compaction_end 失败文案重复，仅合成 agent_end 退出思考态）。
  影响范围：`packages/shared/src/types.ts`（SDKEvent 补两个事件）、
  `packages/frontend/src/store/session.ts`、`packages/frontend/tests/store-session.test.ts`。

### 修复

- **压缩上下文命令（/compact）真正生效**：修复 cmd:compact 从未触发压缩的根因。
  wa-pi 以 `pi --mode rpc` 启动，而 pi 只在交互模式解析内置斜杠命令（RPC 模式的
  `session.prompt()` 只处理扩展命令 / `/skill:` / prompt 模板），`/compact` 文本此前
  被当作普通 user 消息发给 LLM，jsonl 从不重写、token 从不释放。现在 kernel 在
  `agentManager._sendPromptNow` 拦截 `/compact` 前缀并显式转 `compact` RPC
  （customInstructions 透传，超时放宽到 10 分钟），压缩完成/失败后合成
  `agent_end`（前端退出思考态 + 触发 token 累计刷新）与 `agent_settled`
  （drain 压缩期间排队的消息）。失败经 `message_end{stopReason:"error"}` 管线
  红色渲染，不再静默。
  影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/rpc-client.ts`
  （command 支持 per-command timeoutMs）、`packages/kernel/tests/agent-manager.test.ts`、
  `packages/kernel/tests/fixtures/fake-session-client.ts`。

## [0.1.0] - 2026-08-03 · 初始化版本

wa-pi 桌面应用首个发布版本，整合 2026-07-06 至 2026-08-03 的全部功能改动。

### 核心对话

- 消息流式渲染与自动滚动：rAF 合帧跟随、子代理回复跟随、工具卡片长文本自动滚动、流式期间卡顿优化（memo 化解析/高亮）。
- 轮级折叠摘要行 + 整轮耗时显示（历史与实时渠道语义一致）。
- 粘贴富文本只保留纯文本；输入框草稿按会话持久化（刷新/重启还原，发送后清除）。
- 内置命令「压缩上下文」（cmd:compact）：压缩会话历史释放 token，支持自定义压缩指令（选中插入 /[compact] chip，发送展开为 /compact）；压缩回合结束后自动刷新 token 累计显示。
- 点击会话不重排，仅折叠→展开时按最近活跃重排；会话列表时间实时刷新。
- 切换会话模型不被重置（冷加载竞态修复）；会话标题自动补全（含引导消息、兜底空标题）；重发失败消息展示去重。
- ask 提问：提交卡死修复 + double check 机制（失效提问标 stale 禁用提交）。
- 错误提示优化：404 等确定性错误不再误判网络重试，HTML 错误页清洗为可读提示。

### 多智能体

- 内置 subagent（通用 / Explore / Plan）与命名智能体统一管理；model / 思考强度 override 持久化并在调用端（delegate / fleet spawn）生效。
- 内置面板只读展示（仅 model / 思考强度可设置），文字正常色；工具 tab 正常加载工具列表；关系网 ask 协作（含文案更新）。
- 委托 / 并行卡片：子代理回复流式输出、工具调用计数、计时本地推算不回跳、卡片可折叠、回复区 memo 防闪烁。

### 文件与预览

- 文件预览：代码（带行号）/ markdown / 图片；.md 渲染为 markdown 预览；不支持预览的文件提供「在系统查看文件」。
- 预览窗口改为全局状态（不再随流式结束/折叠/组件卸载关闭）；markdown 排版统一（行高/内边距）；链接新标签打开 + 蓝色下划线。

### 插件系统

- 插件命令级启停管理（弹窗逐条开关，/ 菜单只显示已开启命令）；TUI-only 命令改为 kernel 发送端拦截。
- 命令弹窗加载态、移除 TUI 徽标；卸载 / 升级等待反馈（防重复点击）；动态插件操作后自动刷新技能列表。
- 运行时依赖 seed 补全 patches（修复应用内卸载扩展失败）；web-search 默认 provider 改 anysearch；工具白名单清理。

### 记忆

- 记忆写入策略引导（full / compact / none 三档）；用户 / 项目记忆按策略主动写入；记忆写入冒烟评测脚本。

### 桌面端

- macOS 产物稳定签名（修复重装后屏幕录制权限失效）；Windows 打包镜像固化 + 依赖收集修复。
- GPU 硬件加速开启（修复 Electron 交互/滚动掉帧）；kernel 崩溃日志 + 自动重启；端口幽灵占用清理（防重启死循环）。
- UI 字体 MiSans + 代码字体 JetBrains Mono；项目 MIT 开源许可落地。

### 稳定性与工程

- 各项竞态 / 超时 / 进程泄漏修复：bridge 空闲超时误杀（心跳帧）、delegate/fleet 超时、停止消息异常、子代理进程回收、hydration 竞态（草稿/附件/模型）、edit 卡片畸形参数渲染崩溃等。
- E2E 隔离基础设施（固定隔离目录、REST 辅助层、串行执行）；四层测试全绿（kernel / shared / desktop / frontend）。
