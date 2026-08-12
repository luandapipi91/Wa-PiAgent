# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

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
