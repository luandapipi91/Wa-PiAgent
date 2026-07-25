# CoCode Desktop vs HiAgent 聊天界面差异对比

- **日期：** 2026-07-24
- **对比对象：**
  - **CoCode**：`cocode-master/desktop`（v0.7.0，Tauri 2 + React 19，样式为单个 8422 行手写 `styles.css`，无 Tailwind）
  - **HiAgent**：`packages/frontend`（React 19 + Vite 6 + Tailwind 3 + zustand 5，CSS 变量映射 Tailwind）
- **运行与截图环境：**
  - HiAgent：复用本机已有 dev 实例（kernel WS 9776 + Vite 5180），真实数据截图。
  - CoCode：`vite dev`（1420）在纯浏览器运行，Playwright `addInitScript` 注入 `window.__TAURI_INTERNALS__` 桩，并用一个 WebSocket↔stdio 桥接进程连接真实后端（`npx tsx src/cli/index.ts desktop`，NDJSON 协议，等价于 Tauri 侧 `src-tauri/src/rpc.rs` 的 `rpc_spawn/rpc_send/rpc:event`）。**注意：截图中右侧「文件浏览」面板的 `Cannot read properties of null (reading 'map')` 报错是桩环境 artifact（桩对文件列表命令返回 null），并非应用真实行为。**
  - 用户另提供 3 张**正式版 CoCode** 截图（版本晚于 0.7.0，浅色主题、真实会话），相关条目以「📷正式版」标注；这些图未落盘，如需嵌入请保存到 `docs/chat-ui-diff-assets/`。
- **截图清单**（`docs/chat-ui-diff-assets/`）：

| 文件 | 内容 |
|---|---|
| `cocode-01-welcome-empty.png` | CoCode 欢迎/空态全景（侧栏、空态、输入区、右面板、状态栏） |
| `cocode-02-chat-turn.png` | CoCode 真实回合（TURN 分隔、用户气泡、ReasoningCard、Markdown 表格、状态栏计费） |
| `cocode-03-slash-menu.png` | CoCode `/` 斜杠命令菜单 |
| `cocode-04-mention-menu.png` | CoCode `@` 文件提及菜单 |
| `hiagent-01-new-session.png` | HiAgent 新建会话页全景（侧栏、引导、输入区） |
| `hiagent-02-session-view.png` | HiAgent 会话页（消息流、气泡、Markdown 表格） |
| `hiagent-03-toolpanel-expanded.png` | HiAgent 工具调用分组展开态 |

差异分类：【样式差异】【交互差异】【一侧缺失】。

---

## 1. 整体布局与主题

- 【样式差异】**窗口骨架**：CoCode 是无边框四区网格——自绘 TitleBar 36px + TabBar 36px + 主区（左侧栏 244px / 中央聊天 / 右侧上下文面板 320px）+ 全局 StatusBar 26px（`cocode-master/desktop/src/styles.css:419-459`、`src/App.tsx:2807-2833`）；HiAgent 只有两区——264px 侧栏 + 主区，无自绘标题栏、无右面板、无状态栏（`packages/frontend/src/App.tsx:137`、`src/components/Sidebar.tsx:24`）。截图：`cocode-01-welcome-empty.png` vs `hiagent-01-new-session.png`。
- 【一侧缺失】**全局状态栏**：CoCode 26px 状态栏实时显示 在线状态/缓存命中率/tokens/本次费用/余额/主题（`desktop/src/ui/statusbar.tsx:174-224`）；HiAgent 无状态栏，模型与费用信息不常驻。
- 【样式差异】**主题体系**：CoCode 是 dark/light × **8 套具名配色风格**（graphite/ember/aurora/midnight 暗、sandstone/porcelain/linen/glacier 亮），全部 oklch CSS 变量，`<html data-theme data-theme-style>` 切换（`desktop/src/theme.ts:12-50`、`styles.css:118-330`）；HiAgent 只有单一浅色主题 "HiAgent Light"（`packages/frontend/src/styles.css:8-53`、`DESIGN.md`），**无暗色模式**。
- 【样式差异】**字体**：CoCode 本地打包 Geist / Geist Mono / Inter，支持字号缩放（CSS zoom 0.875/1/1.125）和字体族切换（`desktop/src/main.tsx:1-11`、`theme.ts:91-114`）；HiAgent 用系统字体栈（-apple-system/PingFang SC），无字号/字体设置（`styles.css:57`）。
- 【交互差异】**布局可调性**：CoCode 侧栏/右面板可 4px 手柄拖拽调宽、可按窗口宽度自动收折（`App.tsx:4488-4526`）；HiAgent 侧栏固定 264px，不可调。
- 【一侧缺失】**i18n**：CoCode 内置 en/zh-CN/de/ja/ru 五语言（`desktop/src/i18n/index.ts:8-18`）；HiAgent 文案中文硬编码，无 i18n。

## 2. 消息列表与气泡

- 【交互差异】**滚动性能**：CoCode 用 react-virtuoso 虚拟滚动 + `content-visibility:auto` 二次优化（`App.tsx:2974-3109`、`styles.css:2242-2245`）；HiAgent 是普通 DOM 全量列表（`MessageList.tsx`），长会话无虚拟化。
- 【样式差异】**用户气泡**：两侧都是右对齐气泡；CoCode `max-width:82%`、`--panel-2` 底色、12px 圆角（`styles.css:2442-2454`）；HiAgent 78% 宽、白底细边框、不对称圆角（右上直角）+ 30px「我」方块头像（`MessageList.tsx:347-355`）。
- 【样式差异】**助手消息**：CoCode **无气泡**、全宽直排，头像/名字/时间戳虽在 JSX 中但被 CSS `display:none` 隐藏（文档式排版，`styles.css:2427-2431`）；HiAgent 是聊天式——🤖 头像 + 「agent名 · 时间」标签 + 镜像圆角气泡（`MessageList.tsx:380-414`）。截图：`cocode-02-chat-turn.png` vs `hiagent-02-session-view.png`。
- 【样式差异】**回合分组**：CoCode 每个用户回合前插「TURN N」大写细线分隔（`ui/thread.tsx:33-40`）；HiAgent 无回合分隔，只有系统事件（如切换智能体）的居中灰字分隔行（`MessageList.tsx:330-334`）。
- 【一侧缺失】**回合导航 JumpBar**：CoCode 右缘每个用户回合一个圆点，悬停弹性变宽 + 消息预览，点击跳转（`ui/jump-bar.tsx:9-111`）；HiAgent 无回合导航。
- 【交互差异】**滚动记忆**：CoCode 每个会话的滚动位置持久化 localStorage，切回恢复阅读位置（`App.tsx:2441-2462`）；HiAgent 每次进入会话滚到底（`MessageList.tsx:111-116`），仅流式中用户上翻时不抢滚动。
- 【交互差异】**消息级操作**：CoCode 悬停消息显现 复制/编辑（编辑把原文塞回输入框，`App.tsx:2132-2139`、`styles.css:2639-2675`）；HiAgent 只有回答末尾「复制回答」按钮 + 失败回合「↻ 重新发送」（`MessageList.tsx:49-74,506-531`）。📷正式版 CoCode 在回答尾部还有「复制 / 分叉会话 / 总结 / 回溯」操作条（0.7.0 代码中无，属新版本特性）。
- 【一侧缺失】**DiffStats**：CoCode 助手回复尾部附本次文件增删行统计（可折叠，`App.tsx:714-786`）；HiAgent 无。

## 3. Markdown / 代码块渲染

- 【样式差异】**渲染栈**：CoCode = react-markdown 9 + remark-gfm + remark-breaks（软换行）+ remark-math + rehype-katex（数学公式）+ Prism 高亮（手写明暗双主题、行号）（`desktop/src/Markdown.tsx:420-422`、`CodeView.tsx:4-55`）；HiAgent = react-markdown 10 + remark-gfm，**无代码高亮库、无数学公式**，正文近似裸标签样式（未装 typography 插件）（`MessageList.tsx:416-419`、`styles.css:111-130`）。
- 【一侧缺失】**代码块工具条**：CoCode 代码块有头部条（语言名 + 复制按钮，>20 行可折叠成 "+N more lines"，`CodeView.tsx:138-163`、`styles.css:2752-2837`）；HiAgent 代码块无头部、无块级复制，只有整条回答的复制按钮。
- 【一侧缺失】**FilePill 文件路径胶囊**：CoCode 把文本中的文件路径（含 `:行:列`）渲染成可点击胶囊——点击在内置 FileViewer 标签页打开，右键可复制路径/文件管理器显示（`Markdown.tsx:270-334,101-143`）；HiAgent 无此能力（其气泡内 chip 仅用于 `@agent/#file/$skill` 输入标记的展示，`MessageList.tsx` textToHtml）。
- 【样式差异】**表格**：CoCode 表格包横向滚动容器 + 斑马纹 + 行 hover（`styles.css:2593-2637`）；HiAgent 表格为浏览器默认样式。截图：`cocode-02-chat-turn.png` vs `hiagent-02-session-view.png`。
- 【样式差异】**正文排版**：CoCode 14px / line-height 1.72 / `text-wrap:pretty`（`styles.css:2456-2467`）；HiAgent 无统一排版尺度，靠 `pre/code` 强制 `pre-wrap` 与任意断行兜底溢出（`styles.css:117-130`）。

## 4. 输入区 Composer

- 【样式差异】**输入高亮方案**：CoCode 用透明 textarea + 背后 `.composer-backdrop` 渲染文字、其中 `@xxx` `/xxx` 用 accent 色标出（`ui/composer.tsx:116-136`、`styles.css:3839-3878`）；HiAgent 用 contenteditable 半受控 + 内联 chip（`@agent`/`#文件`/`$技能` 渲染成彩色胶囊，`ui/ComposerTextarea.tsx`、`quick-invoke/tokens.ts`）。
- 【样式差异】**底栏构成**：CoCode = 附件/图片/命令/提及四个图标钮 + 模型 pill（含 effort 徽标）+ accent 色发送方块（busy 变红色停止，`composer.tsx:800-824,953-1039`）；HiAgent = 📎 + 🎙录音 + 两个原生 `<select>`（模型、思考强度）+ 黑色圆形 ↑（`ui/ComposerInput.tsx:350-379`）。
- 【一侧缺失】**权限模式切换**：CoCode 输入区有 plan/review/auto/yolo 四段分段控件，yolo 态红色描边发光（`styles.css:7381-7418`）；HiAgent 无权限/自治模式概念。
- 【交互差异】**busy 排队**：CoCode busy 时按 Enter 把消息排成虚线队列 chip（可单独删除，FIFO 自动发出，`composer.tsx:615-649`）；HiAgent 运行中发送进顶部队列面板，支持「引导 / 立即 / 清空 / 取消引导」（`SessionView.tsx:111-191`）。能力相近、形态不同（chip 内联 vs 顶部队列面板）。
- 【一侧缺失】**历史与草稿**：CoCode 光标无词时 ArrowUp 跨会话浏览 prompt 历史（`App.tsx:2149-2187`）；中断时自动把被中断的原文塞回输入框（abort-draft 机制，`abort-draft.ts`、`App.tsx:2101-2109`）。HiAgent 文本草稿不持久化、无历史浏览、无中断恢复（仅选择项——模型/思考/附件——存 IndexedDB，`store/composer-db.ts`）。
- 【一侧缺失】**语音输入**：HiAgent 有 🎙 录音（右键切麦克风/系统音频）+ 可拖拽全局录音胶囊，停止后音频作为附件（`ui/RecordButton.tsx`、`ui/RecordingCapsule.tsx`、`store/recording.ts`）；CoCode 无语音输入。
- 【交互差异】**附件路径**：CoCode 走 Tauri 文件对话框、粘贴图片落盘后自动 @ 引用、拖文件入窗显示全屏 "Drop to attach" 遮罩（`composer.tsx:342-382`、`App.tsx:1950-2009`）；HiAgent 走 FilePicker 文件树模态（多选+搜索）/ 隐藏 file input / 粘贴拖拽 base64 上传（50MB 预检，`ComposerInput.tsx:208-249`）。

## 5. 流式输出与加载态

- 【交互差异】**流式渲染机制**：CoCode 把 `model.delta` 按 tab 分桶、**每个 requestAnimationFrame 合并成一次 dispatch**，随后整段 Markdown 重渲染（`App.tsx:4624-4696,558-576`）；HiAgent 用 `partial` 整体覆盖流式占位、`message_end` 合并定稿的双轨 store（`store/session.ts:186-233`）。两侧都避免每 token 一次 React 提交，但 CoCode 多了 rAF 合帧这一层。
- 【样式差异】**加载指示**：CoCode 无打字机/假光标特效，加载 = 输入区 hint-row 闪烁圆点 + 计时、MainHead shimmer「运行中」pill、卡片 meta 转圈（`composer.tsx:651-668`、`App.tsx:4095-4100`）；HiAgent 有独立「正在思考…」气泡 + 顶栏 spinner +「思考中 · Ns」计时 + 红色停止钮（`MessageList.tsx:306-317`、`SessionView.tsx:206-216`）。
- 【交互差异】**中断路径**：CoCode 三条——Esc（busy 且焦点不在输入框）、红色停止键、`/abort` 命令，中断后恢复草稿；HiAgent 一条——顶栏停止钮发 `agent:abort`，kernel 错误时 `failTurn` 防永远卡"思考中"（`session.ts:110-115`）。
- 【交互差异】**思考卡流式行为**：CoCode ReasoningCard 流式中自动展开、结束自动收起（`ui/cards.tsx:212-221`）；HiAgent 思考 pill 任何状态默认折叠，需手动点开（`MessageList.tsx:481-504`；注：`feat/auto-collapse-chat-blocks` 分支正计划改为流式展开/完成折叠，见 `docs/superpowers/specs/2026-07-23-auto-collapse-chat-blocks-design.md`）。

## 6. 工具调用与思考过程展示

- 【样式差异】**卡片体系**：CoCode 有统一 `Card` 基座（图标方块按 tone 着色 + kind + 名称 + 右侧 meta/耗时 + chevron，compact 变体用于过程信息），连续工具调用自动攒成一组「N 次工具调用」（`ui/cards.tsx:10-62`、`ui/thread.tsx:107-125,283-291`）；HiAgent 是 pill 两级折叠——组 pill「🔧 工具调用记录 (N) · ✓x ✗y」→ 单工具 pill → JSON 参数/结果（`MessageList.tsx:534-660`）。截图：`hiagent-03-toolpanel-expanded.png`（HiAgent 展开态）；CoCode 0.7.0 分组态见代码，📷正式版截图为「N 个工具 · M 段思考」单行折叠组 + 工具卡内嵌 JSON 参数块（视觉与 0.7.0 代码的 ToolGroupShell 一脉相承，标签文案不同）。
- 【样式差异】**专用卡片种类**：CoCode 有 ShellCard（`$` 命令 + 输出逐行染色 ✓绿/✗红）、DiffCard（双列行号 + 红绿行底）、TaskToolCard（子代理运行态「探索中 · N 工具 · Xs」+ 完成后渲染子代理 markdown 答案）、PlanBanner/ActivePlanTaskCard、CompactionCard（`ui/cards.tsx` 各处）；HiAgent 只有 DelegateCard（橙色半透明卡片，硬编码 `rgba(250,179,135)` 与浅色主题体系不一致）+ 通用 JSON 展示（`components/blocks/DelegateCard.tsx`）。
- 【样式差异】**思考呈现**：CoCode ReasoningCard（violet 色调）只显示第一段思考，后续中间思考刻意隐藏，正文支持 `` `code` `` 和 `**粗体**` 轻量标记（`thread.tsx:272-282`、`cards.tsx:222-234`）；HiAgent 思考全文折叠在「💭 思考过程」pill 后，展开为竖线 + 斜体灰字。截图：`cocode-02-chat-turn.png`。
- 【交互差异】**审批交互**：CoCode 三通道——ShellCard 等待态内联按钮（始终允许/拒绝/执行）、六类待决项浮出底部 `ApprovalOverlay`（**无背景遮罩、点击穿透聊天**、Esc=拒绝）、裸 Enter 快捷批准最新待批项（`ui/approval-overlay.tsx`、`App.tsx:2517-2543`）；HiAgent 单通道——AskDock 停靠输入区上方 + AskFormCard 表单卡（单选/多选/「其他…」输入/每题备注/选中项 preview），pending 期间 composer 禁用（`components/ask/AskDock.tsx`、`AskFormCard.tsx`、`store/ask.ts`）。「待人工确认」：CoCode 审批浮层未能在桥接环境中触发真实审批场景截图（需触发需批准的命令，本次未执行）。
- 【交互差异】**计划批准**：CoCode 支持「完善」三级反馈（切 textarea 提修改意见）、选项类审批支持自定义文本（`thread.tsx:435-470,741-764`）；HiAgent AskFormCard 亦有「其他…」自定义输入与备注栏，能力相近。

## 7. 会话管理与侧边栏

- 【样式差异】**侧栏信息架构**：CoCode = 头部按钮行（新会话/导入/历史）+ 工作区切换钮 + 会话搜索框 +「最近」分组会话列表 + 底部固定行（审批规则/关于/设置）（`ui/sidebar.tsx`）；HiAgent = logo + 新建会话 +「智能体」区（Top3 渐变头像 + 状态点）+「项目」区（项目 > 会话两级树）+ 设置（`Sidebar.tsx`、`AgentListSection.tsx`、`ProjectList.tsx`）。核心差异：**CoCode 单 agent + 工作区维度，HiAgent 多智能体 + 项目维度**。
- 【一侧缺失】**多标签**：CoCode TabBar 每个 tab 对应后端一个独立 RPC 会话，支持拖拽重排、右键菜单、文件查看器 tab 混排，所有 TabRuntime 常驻挂载互不干扰（`App.tsx:3797-4060,2813-2865`）；HiAgent 无 tab，单会话视图。
- 【一侧缺失】**会话导入**：CoCode 可扫描本机 Claude/Codex CLI 会话批量导入，或自定义导入 .jsonl（`sidebar.tsx:451-668`）；HiAgent 无导入。
- 【交互差异】**会话行操作**：CoCode 重命名 = 行内 input（Enter/失焦提交），删除 = 定位确认小气泡（初始焦点在"取消"）；HiAgent 重命名 = `window.prompt`，删除 = ConfirmDialog 模态，另有多项右键菜单（重命名/删除/打开工作目录，`ProjectItem.tsx:154-184`）。
- 【一侧缺失】**未读与状态聚合（HiAgent 独有）**：非当前会话有新回复显示未读蓝点、agent 状态点按名下会话聚合（blocked > thinking > idle）（`session.ts:241-249`、`AgentListSection.tsx:58-70`）；CoCode 无未读概念（多 tab 本身就是"都在眼前"的模型），tab 上有 busy 标记。
- 【交互差异】**智能体切换（HiAgent 独有交互）**：会话内 pill 下拉换 agent，弹「缓存失效」确认，消息流插入「已切换为 X」分隔行；agent 缺失时橙色警示 + 重选弹窗（`AgentSwitcher.tsx:20-31`、`AgentMissingModal.tsx`）；CoCode 无 agent 体系，只有模型 pill 切换。

## 8. 空态与引导

- 【样式差异】**空会话页**：CoCode 居中 108px logo + 欢迎语 + 当前工作区名 + 一排建议按钮（4 条示例提示 + `/help`），点击直接发送或执行命令（`App.tsx:4152-4225`）；HiAgent NewSessionPane = 「开始新会话」标题 + 项目/智能体选择器 + 完整 Composer（与正式会话页同一组件）（`NewSessionPane.tsx`）。截图：`cocode-01-welcome-empty.png` vs `hiagent-01-new-session.png`。
- 【一侧缺失】**Splash 启动页**：CoCode 每次会话首次启动有 1.8s 全屏 splash（logo + 三点跳动，可跳过，`ui/splash.tsx`）；HiAgent 无启动页。
- 【交互差异】**引导教学**：CoCode 空态的 `/help` 建议会把草稿设为 `/` 并聚焦，顺势打开 slash 菜单做功能教学（`App.tsx:2614-2622`）；HiAgent 无此类引导，靠副标题文案「选好项目目录和角色，直接打字发送」。
- 【交互差异】**首次配置**：CoCode 未配置时整屏 NeedsSetup 表单（选工作区 + API Key 密码框，`App.tsx:4227-4290`）；HiAgent 走设置模态里的 Provider 配置（`settings/ProviderSection.tsx`），非阻断式。
- 【样式差异】**更上游的空态**：HiAgent 还有"无任何项目"的 EmptyState（🚀 渐变瓷砖 + CTA 新建项目，`EmptyState.tsx`）；CoCode 对应态只是空态页里提示"先选工作区"。

## 9. 通知反馈

- 【样式差异】**Toast**：CoCode 右下角固定胶囊（1.6s 消失、上浮动画，YOLO 开启时红边 + 红色徽标变体停留 3s，`CommandPalette.tsx:334-345`、`styles.css:7421-7472`）；HiAgent 右上角堆叠卡片（错误红底/成功近黑底，3s 自动消失、点击关闭，`ui/Toast.tsx`、`store/toast.ts`）。
- 【一侧缺失】**系统桌面通知**：CoCode 在窗口失焦时发系统通知——待审批新增（六类文案）与回合完成（耗时 ≥15s 才发，避免秒回打扰）（`notifications.ts:16-106`）；HiAgent 无系统通知（浏览器端），回合完成仅会话内可见 + 未读点。
- 【交互差异】**错误呈现**：CoCode 消息流内联 warn-card（可恢复=warning 色调、否则 danger，带关闭钮）+ 低调细线 sys-event（可在设置整体关掉，`App.tsx:3055-3106`）；HiAgent kernel 错误注入为红色 assistant 消息（`stopReason:"error"`）并给失败回合配「↻ 重新发送」（`MessageList.tsx:380,49-74`）。
- 【交互差异】**通知架构**：CoCode 通知派生抽成纯函数 + 依赖注入并配单测（`notifications.ts`、`notifications.test.ts`）；HiAgent 反馈逻辑散落在 store/组件内。

## 10. 快捷键与命令入口

- 【一侧缺失】**命令面板**：CoCode 有 Cmd/Ctrl+K 全屏命令面板（分组、按上下文动态构建命令、快捷键 kbd 提示、输入过滤，`CommandPalette.tsx`）；HiAgent 无命令面板。「未能运行验证」：命令面板截图时 Playwright 截图超时，本条目以代码为准。
- 【交互差异】**全局快捷键**：CoCode 约 14 个全局快捷键——⌘N 新会话、⌘T/W tab、⌘B/⌘⌥B 侧栏与右面板、⌘L 聚焦输入、⌘, 设置、⌘J 后台任务、Esc 中断、裸 Enter 批准等（`App.tsx:2483-2561,4822-4850`）；HiAgent 只有输入框内 Enter 发送 / Shift+Enter 换行（IME 保护）与各弹窗 Esc 关闭，无全局快捷键（`ComposerInput.tsx:288-323`）。
- 【交互差异】**斜杠命令**：CoCode 约 25 条 slash 命令 + 按用户技能动态生成 `/<skill名>`，`/` 即弹菜单（`App.tsx:2614-2733`、`slash-settings.ts`）；HiAgent **无斜杠菜单**，技能通过 `$`/`¥` 触发 QuickInvoke 插入 chip，发送时展开为 `/skill:name` 文本（`quick-invoke/trigger.ts`、`tokens.ts:30-34`）。截图：`cocode-03-slash-menu.png`。
- 【交互差异】**`@` 语义相反**：CoCode `@` = **文件**提及（RPC `mention_query`，支持 `..` 回上级、Tab 钻进子目录，`composer.tsx:283-516`）；HiAgent `@` = **智能体**委派，`#` 才是文件（流式搜索，`quick-invoke/trigger.ts:23-50`）。截图：`cocode-04-mention-menu.png`。
- 【一侧缺失】**`/btw` 旁路提问**：CoCode 支持不进主对话流的旁路小问题通道（`App.tsx:2024-2044`）；HiAgent 无。

---

## 总结：差异聚类

1. **设计哲学**：CoCode 是「文档式工作台」——无边框桌面壳、tab、状态栏、右面板、全宽排版、过程信息全部压缩成可展开摘要；HiAgent 是「聊天式 IM」——气泡、头像、聊天式侧栏，信息密度低但亲和。
2. **主题与个性化**：CoCode 明暗 × 8 风格 + 字号/字体可调 + i18n；HiAgent 单浅色中文主题。
3. **渲染能力**：CoCode 的 Markdown 管线（高亮/公式/FilePill/代码块工具条）明显更完整；HiAgent 目前是无高亮的基础渲染。
4. **键盘效率**：CoCode 有完整的快捷键 + 命令面板 + slash 体系；HiAgent 以鼠标 + QuickInvoke chip 为主。
5. **HiAgent 独有优势**：多智能体体系（切换/委派/状态聚合/未读）、语音输入、chip 式 QuickInvoke、IndexedDB 选择持久化——这些是 CoCode 没有的能力维度。
6. **值得优先借鉴**（若未来要对齐）：暗色主题体系、代码块高亮 + 复制、FilePill、busy 排队 chip、中断草稿恢复、命令面板。
