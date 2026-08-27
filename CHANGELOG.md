
## 2026-08-30 — v0.2.29 发版（浮窗拖拽与默认态修复 + SidebarResizer 宽度传播）

- 版本：0.2.28 → 0.2.29。
- 主要：浏览器浮窗默认居中弹出、位置直写不丢；拖地址栏宽度不再带动浮窗移动；浮窗拖拽/尺寸手柄体验修正；SidebarResizer 宽度传播；新建会话页可达性检测。
- 验证：typecheck 全绿；四层回归全绿。
- 影响范围：frontend（BrowserPanel/SidebarResizer/browser store/NewSessionPane）、kernel（ws-server/static-serve）。

## 2026-08-30 — fix(preview/float): 拖地址栏宽度不再带动浮窗 + 默认居中弹出、位置直写不丢

- 背景：①浮窗模式下拖动地址栏宽度把手会把浮窗带若同步平移；②浮窗无历史时默认弹在右上角而非期待中的居中；③浮窗位置落盘走 300ms 防抖，「拖完立刻退出应用」会丢最后一次位置。
- 根因：①SidebarResizer.onMouseDown 只有 preventDefault 无 stopPropagation，把手 div 不在 FloatWindow 整窗拖动的交互元素白名单内 → 冒泡触发两组 window mousemove 循环并行消费同一 dx；②defaultRect 为右上角偏移；③setFloatRect 现仅在拖动 mouseup 一次性提交，防抖前提已不成立。
- 修复：①SidebarResizer 补 stopPropagation（沿用 FloatWindow 角手柄先例），宿主含侧栏/分屏/浮窗全场景受益；②defaultRect 改视口正中；③setFloatRect 改 writeNow 直写，防抖仅保留给高频的分屏比例。④把手手势 col-resize → ew-resize：mac 下 col-resize 字形是带竖线的特殊图形而非箭头，ew-resize 才是标准 ↔ 双向箭头（悬停/拖拽期/panel 形态三处统一，旧断言同步更新）。
- 取证：真实浏览器端到端验证——默认弹出双轴居中✓；拖把手 width: moved=false 且地址栏宽度生效✓；跨刷新位置还原✓。
- 验证：TDD 新增 3 用例（默认居中/直写落盘/冒泡隔离，均先红后绿）；全量回归 1993/1993 ✓；bun run build ✓。
- 影响范围：`packages/frontend/src/components/SidebarResizer.tsx`、`src/store/browser.ts`、新增 2 测试文件。

## 2026-08-30 — fix(new-session): 文件树展开多时输入框被顶出屏底

- 根因（系统化调试定位）：新建会话页主列为「无收缩出口 + justify-center 对称溢出」的 flex 列；右侧文件树 aside 挤窄主列后，Dropdown/输入框/附件 chips 换行增高，内容总高超限 → 整列溢出，因 justify-center 上下对称裁切，位于内容底部的输入框被祖先 overflow-hidden 裁出视口。文件树自身滚动链完备，系通过挤窄间接触发。
- 修复：主列改用对称 auto-margin spacer 居中（去 justify-center，首尾插 mt-auto spacer）+ 主列自带 overflow-y-auto——空间充裕时视觉居中不变；超高时 margin 归零退化为顶对齐可滚动，输入框任何视口下可达。
- 验证：TDD 新增可达性契约用例（先红后绿）；全量回归 1990/1990 ✓；bun run build ✓；待用户真实环境复现场景确认。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`（3 处微调）、新增 `__tests__/new-session-reachability.test.tsx`。

## 2026-08-30 — feat(preview): 元素选中显性开关 + 地址栏默认半宽/可拽调宽

- 背景：预览元素选中只能靠页面内 Ctrl/⌘ 快捷键切换，无可视入口；地址栏曾无限伸展显得过长。
- 实现：①BrowserPanel 工具栏新增「元素选中」图标开关（element 图标，激活品牌色高亮；点击写 localStorage 并即时下发 inspect:set，iframe 快捷键切换经 changed 消息反向同步，双通道一致；仅本地预览可用）。②地址栏默认 width:50% 占工具栏一半，右侧新增 inline 拖拽小把手（SidebarResizer 新 variant，hairline-strong 圆角条 + hover 品牌色 + 悬浮提示），拖拽实时更新并持久化 localStorage（hiagent.preview.urlbar.width），clamp [160, 工具栏−按钮区预留] 不挤占图标；弹性空白右推后所有动作按钮贴工具栏右缘。
- 清理：移除存量未引用变量 externalUrl（无行为影响）。
- 验证：TDD 新增 19 用例（inspect 开关 6、地址栏宽度/拖拽/可见性 7、纯函数 6，均先红后绿）；全量回归 1989/1989 ✓；bun run build ✓。
- 影响范围：`packages/frontend/src/components/BrowserPanel.tsx`、`SidebarResizer.tsx`（新增可选 props，panel 默认形态不变）、`urlbar-size.ts`、i18n zh/en、对应测试文件。

## 2026-08-28 — v0.2.28 发版（预览地址栏适配 + 嵌套子页双高亮修复）

- 版本：0.2.27 → 0.2.28。
- 主要：浏览器预览地址栏尺寸适配（urlbar-size，随面板宽度自适应）；inspect 锁定开关；A 锁定后移入嵌套子页不再出现子页 hover 双高亮残窗；SidebarResizer/面板拖拽在预览分屏下的宽度计算修正。
- 验证：typecheck 全绿；四层回归全绿。
- 影响范围：frontend（BrowserPanel/SidebarResizer/urlbar-size/browser store/i18n）、kernel（preview-inspect.js）。

## 2026-08-28 — fix(preview): A 锁定后移入嵌套子页仍出现子页 hover（双高亮残窗）

- 背景：互斥机制后用户反馈 A 层锁定元素后移入 B 页面，B 仍出现 hover 高亮（双高亮）。
- 根因：A 锁定时向子层广播 hold:true 的时序早于子 iframe 加载完成时消息丢失；子层 init 经 query 补齐状态，但 query/set 回复的 held 字段只用 suppressed（只表示「其他层锁定」），自身锁定（pinned）时为 false —— 子层拿到 false 不抑制。
- 修复：held 语义改为「全屏存在任意锁定」= suppressed || pinned（query 回复与 sendSetToChildren 两处）。
- 验证：同源诊断页三断言（合成 mousemove + 读 UI display）：A 锁定后 B 鼠标移入全隐藏 ✓、A 锁定保持 ✓、A 锁定下强制重载 B 再移入仍全隐藏 ✓（时序场景）。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-28 — fix(preview): .vue 文件无法进代码预览（MIME 误判非文本）

- 背景：用户反馈 .vue/.tsx/.jsx 无法使用文件预览。实测定位：.tsx/.jsx 实际可预览（映射表/Bun 兑底均返回 text/ 前缀）；**.vue 无映射**，Bun 兑底返回 application/octet-stream，kernel checkPreviewable 判非文本直接拒绝 → 代码预览报「不支持的文件类型: application/octet-stream」。
- 修复：getMimeType 映射表显式补 .jsx（text/jsx）/.vue（text/x-vue）；前端 guessLanguage 补 vue → markup（单文件组件按 HTML 结构高亮）。
- 验证：TDD——static-serve.test 新增回归用例（先红后绿）+ 实测三扩展名全部可预览。
- 影响范围：`packages/kernel/src/ws-server.ts`、`packages/frontend/src/components/blocks/FileViewer.tsx`。

## 2026-08-28 — feat(preview): 嵌套子页文件被修改时外层预览也自动刷新

- 背景：自动刷新（file_changes 命中判定）只比对预览外层路径——预览 A.html 内 `<iframe src="./B.html">` 引用的 B.html 被修改时不触发，外层渲染内容过时。
- 实现：命中判定放宽——精确命中预览文件，或「预览文件同目录（含子目录）的本地 html」也命中（嵌套子页近似）。不解析 iframe 引用树（需 kernel 新接口）：刷新幂等（重挂重拉磁盘最新 no-store），同项目无关 html 多刷无害，精确性换零 kernel 改动。逻辑提为 `matchesFileChange` 独立可测。
- 验证：TDD——browser store 新增 4 用例（同目录/子目录命中、兄弟目录与非 html 不命中、目录前缀撞字符串前缀不误命中，先红后绿）；session 接线测试同步语义更新；真实 LLM 全链路 E2E（新增 `preview-nested-refresh.spec.ts`）：预览 A.html → agent edit 工具改子文件 B.html → 不点刷新，外层 iframe 内子页内容自动「版本一」→「版本二」✓。
- 附带修复：playwright.config webServer env 漏传 WA_PI_WEB_PORT——dev vite 占用 5180 时 E2E webServer 起不来（strictPort 退出）。
- 影响范围：`packages/frontend/src/store/browser.ts`、`packages/frontend/playwright.config.ts`、测试文件、新增 `e2e/preview-nested-refresh.spec.ts`。前端全量 bun test 在本机高负载下大面积超时（stash 基线对照同失败且更多，环境性问题），定向测试与干净环境 E2E 全绿。

## 2026-08-28 — v0.2.27 发版（预览自动刷新 + 定时任务全局化收口 + 稳定性修复）

- 版本：0.2.26 → 0.2.27。
- 主要：浏览器本地 HTML 预览支持自动刷新与嵌套预览刷新；定时任务 cron-task CLI 全局目录架构收口（list 显示所属项目、set im-push 注入推送标记、--project/--no-im-push 归属与关闭）；rpc-client 子进程/连接稳定性修复；内核崩溃日志（agent-crash-log）落盘；预览元素选择/浏览器 store、设置-音效/通用面板调整；定时任务 cron-task CLI 测试确定性（剥离宿主项目 env）。
- 验证：typecheck 全绿；kernel/shared/desktop/frontend 四层回归全绿；修复 scheduler-assets CLI_ENV 剥离宿主 WA_PI_SCHEDULER_PROJECT_ID。
- 影响范围：kernel（rpc-client/crash-logger/preview-inspect/scheduler*/auto-compact）、frontend（BrowserPanel/browser store/element-pick/session/ui-prefs/settings）、shared（task-file/constants）、scripts、e2e。

## 2026-08-28 — chore(deps): 底层 Pi 引擎升级 0.84.2 → 0.84.3

- 背景：pi.dev 发布 0.84.3（Windows PowerShell 工具、更安全的托管更新、模型/思考控制等；RPC `toolcall_start` 事件补齐 tool call id/name）。升级后安装包首启动态装依赖与动态内核发版均自动跟随（版本单一来源 `packages/kernel/package.json`，`build-kernel-sidecar.ts` / `publish-kernel.ts` 自动读取）。
- 变更：`packages/kernel/package.json` 三个 @earendil-works 依赖 ^0.84.2 → ^0.84.3（agent-core / pi-ai / pi-coding-agent），根 bun.lock 同步；运行时目录（~/.pi/agent/runtime）与 dev node_modules 均已实装 0.84.3。0.84.x 全系 Breaking change 核查：`GoogleThinkingLevel` 改名在代码库零引用，不受影响。
- 验证：kernel typecheck 干净 + kernel 测试套件全绿（preview-route/preview-inspect 等集成测试）；desktop runtime-deps 单测 10/10；`buildRuntimeManifest()` 实际输出确认 seed 清单锁 ^0.84.3（下次打包自动生效）。
- 影响范围：`packages/kernel/package.json`、`bun.lock`。

## 2026-08-28 — feat(settings): 定时任务完成提示音开关（默认关）+ 定时任务完成不再触发青蛙动画

- 背景：定时任务执行会话（sched- 前缀）完成时与普通会话一样播提示音 + 青蛙动画，用户期望定时任务完成默认安静、且不要动画。
- 实现：① `ui-prefs.ts` 新增 `soundSchedTaskDone`（默认 false）+ setter（persist 自动持久化）；② `session.ts` agent_end 分支拆分——`sched-` 前缀会话提示音由新开关控制、一律不调 triggerTaskDoneFrog（动画硬性关闭无开关），普通会话与 IM 会话行为不变；③ GeneralSection 提示音分组新增「定时任务完成」开关行（testid sound-sched-task-done-toggle）+ zh/en i18n key。
- 验证：TDD——session 接线 5 用例（sched 默认静音无动画/开关开有声仍无动画/普通会话不变/im- 回归/willRetry 回归，先红后绿）+ GeneralSection 组件用例（默认关、点击写 store）；E2E settings-sound.spec 2/2（新开关默认关→开→localStorage 持久化→刷新保持；顺带修复该 spec 单独跑时被 onboarding 向导拦截的既有问题——预置假 provider，与 file-change-summary.spec 同模式）；前端全量回归 1966 pass 0 fail；typecheck 干净。
- 影响范围：`packages/frontend/src/store/ui-prefs.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/settings/GeneralSection.tsx`、`packages/frontend/src/i18n/locales/{zh,en}.ts`、`e2e/settings-sound.spec.ts`。

## 2026-08-28 — feat(preview): 嵌套选中互斥 + 锁图标常驻（可交互元素稳定锁定）

- 背景：①嵌套 iframe 内选中后，父层对整个 `<iframe>` 元素的 hover 高亮会叠加在子层锁定框上，双层高亮混乱，用户感知为「点击锁定不了」；②可交互元素（点击后页面自身响应/重渲染）点击锁定不稳定——框架重渲染重建 DOM 节点，锁定的旧节点脱离文档触发自动解除。
- 实现（kernel preview-inspect.js）：①全屏唯一锁定互斥——锁定状态经逐层消息传播（上行 `inspect:lock` 子→父、下行 `inspect:lock-hold` 父→子，中间层转发+广播其他子层，排除来源防自解锁）：任一层锁定时其余层 suppressed（不 hover 不绘制），点击其他层元素则抢占锁定（被抢占方被动解除并清 current，防抑制解除后残留 current 画出「鬼高亮」）；新加载子层经 query 回复的 held 字段补齐状态。②锁图标常驻双态——hover 中点开锁图标即锁定当前元素（不点击元素本身，页面零扰动），再点解除；图标开/闭锁切换。③节点重建跟随——锁定时快照 selector，元素脱离文档时 querySelector 找同名 tagName 接替节点续锁；「选择父级」同步刷新快照。锁图标 SVG 改 DOM 构建消除 innerHTML。
- 验证：真实浏览器 E2E（sandbox 壳 + src 型嵌套）：B 内点击锁定 → A 无任何高亮 ✓；点 A 层元素抢占 → B 解除、A 锁定 ✓；点 B 抢回 → A 高亮消失 ✓；hover 点锁锁定/再点解除 ✓；全屏恒单一锁定。单测 36 全绿。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-28 — fix(preview): hover 选中跨层残留改为全局广播方案（快速移动可靠）

- 背景：首版 hover 互斥依赖「鼠标进入子 iframe 时父层收到 target=IFRAME 的边界 mousemove」触发清理——快速移动鼠标时该边界事件根本不发生（事件直接跳进 B 深处），A 残留不清，用户实测仍双高亮。
- 改为全局广播方案（用户提出）：本层获得 hover（current null→有）时向上广播 `inspect:hover`；父层收到后清除自身 hover 残留 + 通知其他子层清除 + 记 hoverOwner；本层恢复 hover 时若存在 hoverOwner 则向其发 `hover-clear`。不依赖边界事件，子层收到 mousemove 即广播，快速移动必然覆盖。
- 验证：同源诊断页模拟「快速移动」（跳过一切边界事件直接跨层派发 mousemove）：A hover → 快速跳 B（B hover + A 清除）✓ → 快速跳回 A（A hover + B 清除）✓；单测 36 全绿。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-28 — fix(preview): hover 选中跨层残留（A hover 后移入 B 双高亮）

- 背景：互斥只覆盖了点击锁定（pinned），未覆盖 hover 选中（mousemove 驱动的 current）——鼠标从 A 移入嵌套 B 后事件全部进入 B 文档，A 再也收不到 mousemove，A 的 hover 高亮永久残留原地，与 B 的新 hover 双高亮（用户截图场景）。
- 实现：①mousemove 中 target 为 IFRAME 时（鼠标进入子层，A 收到的最后一批事件）清除本层 current 并记 mouseInChild；②鼠标移回本层（mouseInChild 复位）时下行广播 `inspect:hover-clear`，子层收到后清自身 hover 残留并逐层下传。与锁定互斥（pinned/hold）正交共存：锁定态 hover-clear 不清锁定。
- 验证：同源诊断页合成事件四步断言（A hover 显示 → 进 iframe 后 A 清除 → B 内 hover 显示且 A 保持清除 → 移回 A 后 A 显示 + B 清除，hover-clear 消息确认到达 B）全绿；排查注记：合成 mousemove 派发到 document 时 target 无 tagName 会被 handler 忽略，须派发到具体元素；盲选 querySelector 可能命中零尺寸空元素被视口检查合理隐藏，E2E 须选可见元素。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-28 — feat(preview): 嵌套选中互斥 + 锁图标常驻（可交互元素稳定锁定）

- 背景：①嵌套 iframe 内选中后，父层对整个 `<iframe>` 元素的 hover 高亮会叠加在子层锁定框上，双层高亮混乱，用户感知为「点击锁定不了」；②可交互元素（点击后页面自身响应/重渲染）点击锁定不稳定——框架重渲染重建 DOM 节点，锁定的旧节点脱离文档触发自动解除。
- 实现（kernel preview-inspect.js）：①全屏唯一锁定互斥——锁定状态经逐层消息传播（上行 `inspect:lock` 子→父、下行 `inspect:lock-hold` 父→子，中间层转发+广播其他子层，排除来源防自解锁）：任一层锁定时其余层 suppressed（不 hover 不绘制），点击其他层元素则抢占锁定（被抢占方被动解除并清 current，防抑制解除后残留 current 画出「鬼高亮」）；新加载子层经 query 回复的 held 字段补齐状态（held=suppressed||pinned，覆盖 hold 广播早于子层加载的时序）。②锁图标常驻双态——hover 中点开锁图标即锁定当前元素（不点击元素本身，页面零扰动），再点解除；图标开/闭锁切换。③节点重建跟随——锁定时快照 selector，元素脱离文档时 querySelector 找同名 tagName 接替节点续锁；「选择父级」同步刷新快照。锁图标 SVG 改 DOM 构建消除 innerHTML。
- 验证：真实浏览器 E2E（sandbox 壳 + 真实 hlh PRD 预约功能优化页 src 型嵌套，埋点确认消息链）：A 锁定 → 点 B 内元素 → B 锁定 + A 解除（lock 消息经 A 校验+转发到顶）✓；全屏恒单一锁定 ✓；单测 36 全绿。排查注记：合成事件的 clientX/Y 为 undefined、盲选 querySelector 可能命中隐藏元素，E2E 坐标须经 iframe 几何换算后用真实可见元素。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-28 — fix(preview): srcdoc 内选中元素「发送到聊天」无反应（srcPath=null 被误拒）

- 背景：srcdoc 注入生效后用户反馈仍发不到聊天。真机取证：srcdoc 内选中/锁定/工具条均正常，点「发送到聊天」后输入框无 token。
- 根因：srcdoc 内容内联在外层 PRD 文件里，`selfPreviewPath()` 解析 `about:srcdoc` 得不到磁盘路径，picked 消息携带 `srcPath: null`（合法的「解析不出」信号）；而 `parseInspectMessage` 的形状守护把 null 误判为非法，整条消息被静默丢弃。
- 修复：null 与 undefined 同等视为缺省（回退外层路径定位），仅非字符串非空值才拒收。
- 验证：TDD 两个新用例（先红后绿，累计 10 用例全绿）；全真前端链路 E2E（vite 根下临时页 import 真实 element-pick.ts + 真实 hlk PRD + sandbox 壳）：srcdoc 内 button#allRestore 选中 → 发送 → parseInspectMessage accepted，sendElementToChat 回退外层路径，最终插入 token `![PRD-岗位的总业绩提成核算阶梯.html||button#allRestore]` ✓。
- 影响范围：`packages/frontend/src/element-pick.ts`。

## 2026-08-28 — fix(preview): srcdoc 型嵌套 iframe 内元素选中不可用（真机复现补全修复）

- 背景：用户反馈 hlh PRD 页面预览时嵌套 iframe 内元素仍选不中。上一轮修复只覆盖了 src 型嵌套（消息路由），真机排查发现实际场景是 srcdoc 型：原型内容内联在 srcdoc 属性里，不发 HTTP 请求，kernel 无从注入，内层连脚本都没有。
- 排查（临时埋点取证）：先做父层运行时代注入（injectInspectIntoFrames，非 sandbox 下验证通过）；但真实 App 预览页跑在 sandbox 无 allow-same-origin 的不透明源下，srcdoc 子文档获得独立不透明源，父层 contentDocument 被浏览器阻断，埋点证据 frames:1/injected:0 —— 运行时代注入此路不通。
- 终案（kernel HTTP 层注入）：srcdoc 内容就躺在外层 HTML 文本里，kernel 改写外层 HTML 时顺手在转义态上注入——srcdoc 属性值内找转义 &lt;/head&gt; 前插转义脚本（双/单引号属性两种形态、大小写不敏感、无 head 插值首）；子文档解析时原生携带脚本，零跨源依赖。文档级注入逻辑不变。
- 验证：TDD——5 个 srcdoc 注入单测（先红后绿，累计 36 用例全绿）+ 集成 11 pass；全真 E2E（真实 hlh 文件 + 真实 injectInspectScript + 真实资产脚本 + sandbox 不透明源壳）：HTTP 层外层/srcdoc 双注入确认，srcdoc 内 button#allRestore 锁定高亮 ✓、发送到聊天消息穿透到顶层 ✓（selector 精确、srcPath null 语义正确回退外层路径）。
- 附带：inspect 脚本 picked 转发加 window.parent===window 防护（直接开预览 URL 时不自发自收）；rpc-client command 参数类型收紧；两个 eval 脚本 buildAdditionalExtensionPaths 零参调用对齐（既有类型错误）。
- 影响范围：`packages/kernel/src/preview-inspect.ts`（srcdoc 注入）、`packages/kernel/src/assets/preview-inspect.js`（父层代注入+顶层防护，非 sandbox 场景增强）、测试文件。

## 2026-08-28 — feat(preview): 任务完成后预览文件被修改时自动刷新预览

- 背景：预览着某个 HTML 时 agent 任务修改了该文件，预览不会自动更新，必须手动点刷新。期望：任务完成后若当前会话正在预览的文件被修改，预览自动刷新。
- 实现：复用既有 file_changes 事件链路（agent_end 时 bridge 上报修改清单 → SSE 广播），零 kernel 改动。① `store/browser.ts` 新增 `refreshToken` + `bumpRefresh()`（手动刷新按钮同源）+ `maybeRefreshForFileChanges(sessionId, files)` 命中判定；② `BrowserPanel.tsx` 局部 refreshKey 提升为 store 刷新令牌，iframe key 变化即重挂重拉磁盘最新内容（kernel 预览响应 no-store，重挂等价刷新）；③ `session.ts` 的 file_changes case 接线调用命中判定。判定语义：只看「面板当前显示的预览」（open/path/sessionId），未显示会话的预览切回时挂载即最新，无需刷新。
- 关键坑（E2E 排查发现）：file_changes 的 files 是 FileChangeSnapshot **对象数组**（非字符串数组），命中匹配须按 `f.path` 字段；另发现 E2E helper 用内部 name（dev）作 agentName 时，kernel 启动迁移会把 agent 文件重命名为 displayName（研发.md），第二条消息 getAgent("dev") 失败报 agent_missing 队列卡死——E2E 改传 displayName 规避（与真实前端语义一致）。
- 验证：TDD 四层——store 契约单测 7 用例（命中/未打开/会话不符/路径不符/空预览/空清单，先红后绿）+ session 接线测试 2 用例 + BrowserPanel 组件测试 3 用例（令牌递增 → iframe DOM 节点替换、手动按钮同源）+ 真实 LLM 全链路 E2E（真实浏览器打开预览 → edit 工具修改预览中文件 → 任务完成 → 不点刷新断言 iframe 内容自动变为最新）；前端全量回归 1958 pass 0 fail；typecheck 干净。
- 影响范围：`packages/frontend/src/store/browser.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/BrowserPanel.tsx` 及对应测试、新增 `packages/frontend/e2e/preview-auto-refresh.spec.ts`。

## 2026-08-28 — fix(kernel): Windows 中文安装路径下 pi rpc 全部启动失败（「系统找不到指定的路径」）

- 背景：Windows 用户把应用装在含中文的目录（如 F:\呱\WA PI Agent\）时，所有会话报「agent 启动失败: pi rpc 进程不可用 (code=1)」，stderr 为 GBK 乱码（实为「系统找不到指定的路径。」被 UTF-8 二次错解后的呈现）。
- 根因：桌面端往 PATH 放的 bun.cmd shim 以 UTF-8 无 BOM 写入含中文的 kernel 路径，cmd.exe 按系统 ANSI 代码页（GBK）解析批处理 → 路径失效 → shim 秒退 code=1。kernel sidecar 本体由 Electron 直接 spawn exe 不经 cmd，故只有 pi rpc 全挂。
- 修复：resolvePiRuntime() 在 Windows 上跳过 PATH 上的 bun（含 .cmd shim），直接用 process.execPath（kernel 编译产物即 bun runtime，配合子进程继承的 BUN_BE_BUN=1；dev 下是真 bun.exe）。env 覆盖 WA_PI_PI_RUNTIME 优先级保持最高。
- 验证：新增 3 个 resolvePiRuntime 单测（env 覆盖优先/win32 绕开 shim/非 win32 行为不变），修复前红灯复现、修复后 6/6 全绿；agent-manager 回归唯一失败经 stash 基线对照为工作区并行 crash-log 改动的预置失败，与本修复无关；LSP 类型检查干净。
- 影响范围：`packages/kernel/src/rpc-client.ts`、`packages/kernel/tests/rpc-client.test.ts`。生效需随下次内核发版。

## 2026-08-28 — fix(kernel): 修复大会话慢模型下发消息误报「agent 启动失败: RPC 命令超时」

- 背景：Windows 用户大会话（上下文接近窗口上限）+ 智谱慢模型下，每次发消息先触发 pi 内部隐性压缩（LLM 长调用实测 62s+），而 pi 的 prompt RPC 应答要等 preflight（含压缩）完成后才发，撞上 kernel 默认 60s 命令超时，前端误报「agent 启动失败」（压缩实际已完成，重发即恢复）。日志证据：network.log 里压缩请求 durMs=62.1s 恰超 60s 超时线 2 秒。
- 根因（双重）：① kernel 发送前预压缩（80% 阈值）的数据源走 pi-ai 模型目录查窗口，用户自定义模型（自填 baseUrl 中转）不在目录里 → 预压缩静默失效，pi 在 prompt preflight 里的隐性压缩成为唯一防线且无超时保护；② prompt RPC 命令超时 60s，覆盖不了 preflight 里夹带的长压缩（compact 命令已给 10 分钟但 prompt 没有）。
- 修复：① `_autoCompactIfNeeded` 数据源改为 pi 实时返回的 `getSessionStats().contextUsage`（tokens + contextWindow，与 pi 内部压缩判断同源），压缩提前在 kernel 层完成（compact RPC 有 10 分钟超时），pi preflight 不再触发隐性压缩；删除 catalog 查窗口路径及 `lookupCatalogModel`/`modelContextWindowCache` 孤立代码；② rpc-client `prompt()` 命令超时 60s → 10 分钟（与 compact 对齐；真实失败如无 API key pi 立即回 error 不受影响，超时仅兜底进程无响应）。
- 验证：新增 4 个行为回归测试（自定义模型按 contextUsage 触发压缩/低于阈值不压/tokens null 跳过/无窗口跳过）全绿；修改区域 5 个测试文件 152 pass（1 个 crash-log 失败经 stash 基线对照为工作区并行改动的预置失败，与本修复无关）；pi-lens 0 blocker 0 actionable。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/rpc-client.ts`、新增 `packages/kernel/tests/auto-compact-behavior.test.ts`。生效需随下次内核发版。

## 2026-08-27 — feat(kernel): agent 进程异常退出现场落盘 agent-crash.log

- 背景：pi 子进程被 SIGTRAP/SIGSEGV 类原生信号杀死（code=133/139，如 Bun 运行时 panic）时只有数字可查——panic 原文只打在子进程 stderr 上，RpcClient 内存里留的尾巴随对象丢弃即失，与 ~/Library/Logs/DiagnosticReports 的 .ips 崩溃报告交叉比对无从下手。
- 改动：crash-logger 新增 `formatAgentCrashBlock`/`logAgentCrash`（纯函数格式化 + 异步追加写）；agent-manager `_onProcessExit` 把 session/agent/pid/code/signal + stderr 尾部（末 50 行×2000 字符）追加写入 `<WA_PI_DIR>/logs/agent-crash.log`；RpcClient 新增 pid getter。落盘整体 try/catch 包裹、写入失败静默吞错，绝不影响错误事件合成与会话重建主流程。
- 验证：①RpcClient 单测用真实 Node 子进程自系 SIGTRAP 验证 (code=null, signal=SIGTRAP) 上报与 pid 可取；②格式化/写盘单测（字段齐全、空降级、超长截断、目录自动创建、失败不抛）；③agent-manager 集成测试新增「崩溃退出落盘」断言，并修复假 client 无 getStderrTail 导致的 2 个既有用例（可选链兼容）；相关 121 测试全绿，typecheck 干净。全量回归中 cron-task CLI 3 个失败经干净 HEAD worktree 对照为发版提交既有问题，另 2 个为并发满载抖动（隔离重跑即过），均与本改动无关。
- 影响范围：`packages/kernel/src/{crash-logger,rpc-client,agent-manager}.ts`、`tests/agent-manager.test.ts`、`src/__tests__/agent-crash-log.test.ts`。生效需随下次内核重编/发版（当前已安装 App 内打包二进制不含此改动）。

## 2026-08-28 — fix(preview): 预览页嵌套 iframe 时元素选中可正常发送到聊天

- 背景：预览页内嵌套的本地 iframe（如 `<iframe src="./B.html">`）里的元素可以 hover/锁定高亮，但点「发送到聊天」后聊天框无任何反应。
- 根因：inspect 脚本的消息路由隐含「自己是最外层预览页」——选中消息 `element-picked` 只发 `window.parent`（即外层预览页 A）就停了，A 层只处理开关消息不转发，主应用只认直接子 iframe 的 source，消息死在中间层；同时主应用只有外层页路径，即使消息通了也会用 A 路径去定位行号（查错文件）。
- 修复：① 新增纯函数 `parsePreviewPathname()` 从 `/preview/<encDir>/<rel>` 还原磁盘路径，发送消息时携带 `srcPath`（选中元素实际所在文件）；② inspect 脚本增加嵌套消息路由——子 iframe 的 query 直接回复、changed 走 setDisabled 同步自身+上报+下发、picked 原样逐层中继 parent，开关 set 逐层下发子 iframe；子层消息经 `isChildPreviewWindow()` 校验（本页 iframe + 同 protocol+host + /preview/ 路径，不透明源下不能用 location.origin 比较）。
- 验证：TDD——kernel 新增 5 个 `parsePreviewPathname` 单测、frontend 新增 4 个 srcPath 解析/优先级用例（先红后绿全绿）；真实浏览器 E2E 三层嵌套（App→A3→B3→C）：B3/C 选中发送的消息均携带正确 srcPath 逐层到达顶层，关闭开关后三层高亮全部同步停用；单层/两层回归正常。kernel 全量测试失败（fetch is not a function）为并行工作区改动的既有问题（stash 基线对照同失败），与本修复无关。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`、`packages/frontend/src/element-pick.ts`、两个测试文件。

## 2026-08-28 — fix(ui): 回收站角标红色改灰色，降低视觉干扰

- 背景：右下角回收站入口的未读数量角标用 `bg-danger`（红色），在安静的侧边栏里过于突兀；且回收站项并非紧急错误，不适合用危险语义色。
- 修复：`RecycleBinButton` 角标改为中性灰胶囊——`bg-danger text-white` → `bg-hairline-strong text-secondary`，跟随设计 token 自适应深浅色主题（浅色 #d1d1d6 / 深色 #48484a）。
- 验证：真实浏览器 E2E（隔离 e2e 环境 + mock 角标接口）断言浅色/深色模式 computed 背景色分别为 rgb(209,209,214) / rgb(72,72,74)，截图确认视觉效果；临时验证用例与截图已清理；`bun run build` 已执行（桌面 App 生效）。
- 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`。

## 2026-08-27 — fix(preview): 修复页面滚动后预览高亮选中框消失

- 背景：昨天「高亮框收敛进视口」（69130f5）引入回归——页面滚动到下方后，hover/锁定的高亮框、工具条、提示小字全部不可见。
- 根因：`preview-inspect.js` 的 `render()` 把元素矩形先加上滚动偏移转成__文档坐标__，再传给 `clampRectToViewport()` 按__视口范围__（0~vw/vh）收敛——坐标系混用。滚动后（scrollY>0）框被强拉回文档首屏，当前视口自然看不到；未滚动时两坐标系重合所以一切正常。
- 修复：新增纯函数 `layoutOverlayInPage(vLeft, vTop, w, h, sx, sy, vw, vh)`——先在视口坐标系内 clamp，再加滚动偏移转页面坐标；`render()` 中高亮框/工具条/提示小字三处改用该函数，顺序不可反。
- 验证：TDD——新增 3 个滚动场景单测（先红后绿，22/22 全绿）；真实浏览器 E2E：滚动 1800px 后 hover 目标卡片，高亮框页面坐标 top=2100 精确等于元素位置（300+1800），截图确认框/工具条/提示全部贴合。kernel 单独跑 preview 单测+集成全绿；全量测试失败为既有并发环境问题（stash 基线对照同失败数），与本修复无关。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`、`packages/kernel/tests/preview-inspect.test.ts`。

## 2026-08-27 — v0.2.26 发版（定时任务 AI 化 + 全局目录架构）

- 版本：0.2.25 → 0.2.26。
- 主要：定时任务 AI 化——定时任务从全局 JSON 迁移为文件夹存储（~/.pi/agent/scheduled-tasks/ 下 tasks/ 任务 md + logs/ 日志），agent 可用分发的 cron-task.ts CLI 自主创建/查看/修改/启停/运行；kernel fs.watch 热加载；系统提示词注入定时任务管理引导；自动化面板新增「配置错误」条目展示与修复；旧 JSON 自动迁移归档；定时任务推送默认开启（--no-im-push 显式关闭）；cron-task.ts 支持 --project 归属与 set project、list 显示所属项目（CLI v3 全局目录架构）；发送前自动压缩阈值统一为窗口 80%。
- 验证：typecheck 全绿；kernel/shared/desktop/frontend 四层回归全绿（frontend 1942 pass 0 fail）；修复 auto-compact 用例如 80% 阈值自洽 + scheduler-watcher waitFor 放宽到 10s 防并行 flaky。
- 影响范围：kernel（scheduler*/routes/index/system-prompt/agent-manager/wa-pi-bridge/auto-compact）、shared（task-file/types/constants）、frontend（automation 面板/MessageList/session/store）、scripts（API 集成测试）、e2e。

## 2026-08-27 — fix(ui): 插件 notify 通知不再顶掉消息流末尾的文件修改清单

- 背景：扩展（插件）经 `ctx.ui.notify()` 发出的通知（如 /lens-toggle 执行结果）出现在聊天里时，会与消息流末尾的「📄 已修改 N 个文件」文件修改清单冲突——通知一来，文件修改清单就不显示了。期望两者共存。
- 根因：`MessageList.tsx` 里 `FileChangeSummary` 只在 `isLastMessage`（`i === displayRows.length - 1`，即当前行是列表最后一行）时渲染；而 `extension_notify` 作为 custom 系统消息被 `preprocess()` 插入 `displayRows` 末尾，成为最后一行，导致原本最后一条 assistant 内容消息的 `isLastMessage` 变 false，文件修改清单被顶掉。
- 修复：`isLastMessage` 的语义改为「最后一条内容消息（非 custom 系统提示行）」——新增 `lastContentRowIndex()` 纯函数，从 `displayRows` 末尾向前跳过 custom 系统提示行（extension_notify / agent_switch / compaction_status / reload_config），返回最后一条真正内容消息的索引；`isLastMessage` 改用该索引判定。`isActiveTurnRow`（进行中轮判定）保持 `i === displayRows.length - 1` 不变。
- 验证：TDD —— 新增 `lastContentRowIndex` 纯函数单测（末尾插入 extension_notify / agent_switch 仍返回最后一条内容消息索引）、`MessageRow` 组件测试（isLastMessage 主导 FileChangeSummary 显示与否）；前端全量回归通过；typecheck clean。
- 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/components/__tests__/MessageList.test.ts`、`packages/frontend/src/components/__tests__/MessageRow.test.tsx`。

## 2026-08-27 — fix(ui): 手动 /compact 压缩成功后提示应出现在消息流末尾

- 背景：手动调用 `/compact` 压缩上下文成功后，屏幕中间的「已压缩早期上下文 · 压缩前 N token」提示位置错误——出现在会话顶部，而不是消息流末尾（用户当前操作位置）。
- 根因：`store/session.ts` 的 `refreshTokenTotals` 在压缩完成后的历史重拉时，曾用 `return !mm?.compactionDone` 移除本地成功提示、改由服务端历史的 `compactionSummary` 节点渲染；而 `readSessionHistory` 会把 `compactionSummary` `unshift` 到消息数组最前（= 会话顶部），导致压缩成功提示跑到顶部。
- 修复（方案 A）：本地 `compaction_status` 消息（进行中/取消/失败/成功）全部保留在消息流末尾，作为压缩操作的实时反馈；仅当本地有成功提示时，从服务端历史里剔除 `compactionSummary`，避免会话顶部重复出现压缩标记。重新打开会话（无本地成功提示）时仍保留服务端 `compactionSummary` 作为历史结构标记。
  - `store/session.ts`：`refreshTokenTotals` 改为保留全部本地 `compaction_status`；`hasLocalDone` 时过滤 `compactionSummary`。
- 验证：TDD —— `compaction_start 插入…` 用例更新为「本地成功提示保留 + 服务端 compactionSummary 被剔除」；新增回归测试 `compaction_end 成功但服务端历史无 compactionSummary：本地成功提示应保留（不消失）`；前端全量 1940 pass 0 fail；typecheck 通过；e2e `compact-hint.spec.ts` 注入成功事件断言消息流末尾仅一条提示。
- 影响范围：`packages/frontend/src/store/session.ts`、`packages/frontend/tests/store-session.test.ts`、`packages/frontend/e2e/compact-hint.spec.ts`。

## 2026-08-27 — fix(ui): 压缩开始/完成时消息未自动滚动到底部

- 背景：手动调用 `/compact` 压缩上下文时，「开始压缩（正在压缩上下文…）」与「压缩完成（已压缩早期上下文…）」状态消息插入消息流末尾后，聊天窗口不会自动滚动到底部——用户视口停在原地，看不到压缩进度/结果提示。
- 根因：`MessageList.tsx` 的三条自动滚动路径（`followOutput` / 强制贴底 effect / 200ms interval）全部要求 `autoScrollActive`（streaming/子代理运行/thinking）为真；而压缩状态消息是 idle 状态下的内容增长，`autoScrollActive` 为 false，故无任何路径兜底滚动到底部。
- 修复：`MessageList.tsx` 新增 `lastCompactionKey`（最后一条 `compaction_status` 消息的 `content:timestamp`，插入/替换都会变化）+ 对应 effect——`lastCompactionKey` 变化且 `stickBottom=true`（用户意图看最新）时调用 `scrollToEnd()`。仅当用户停在底部时滚动，不打扰上翻阅读历史的用户。
  - `MessageList.tsx`：新增 compaction 滚动 effect。
- 验证：前端全量 1942 pass 0 fail；MessageList.test.tsx 73 pass；MessageList.subagent-scroll.test.tsx 12 pass 0 fail；typecheck 通过。
- 影响范围：`packages/frontend/src/components/MessageList.tsx`。

## 2026-08-27 — fix(kernel): 定时任务 list 显示所属项目 + 保留「禁止直接编辑或删除」约束

- 背景：①CLI `list` 命令默认不显示任务所属项目，agent/用户无从区分任务归属；用户要求 list 返回所属项目，系统项目显示「默认工作区」。②自动格式化工具误把 system-prompt 的「禁止直接编辑」文案加工成「禁止直接编、辑删除」，且用户要求保留「删除」语义（delete 也不能直接操作目录文件）。
- 修复：
  - `cron-task.ts`：新增 `projectLabelOf`（`__system__`/空 → 默认工作区，否则显示 projectId）；`list` 输出在任务名前加 `[所属项目]` 列。
  - `system-prompt.ts`：文案改回「禁止直接编辑或删除目录下的任务文件」，保留「删除」语义；`system-prompt-scheduled-tasks.test.ts` 断言同步为「禁止直接编辑或删除」，防止格式化工具再次破坏。
  - `scheduler-assets.test.ts`：新增 `list` 显示所属项目用例（**system** → [默认工作区]、--project pa → [pa]）。
- 验证：kernel 全量 1463 pass 0 fail（含修复前 1 fail：system-prompt 文案被误改导致断言不过，已修复）；scheduler-assets 13 pass；typecheck clean。
- 影响范围：`packages/kernel/assets/scheduled-tasks/cron-task.ts`、`system-prompt.ts`、`packages/kernel/tests/scheduler-assets.test.ts`、`system-prompt-scheduled-tasks.test.ts`。

## 2026-08-27 — feat(kernel): 定时任务全局化收口——项目隔离 + ctx 注入模板 + delete 命令 + --im-push 推送标记

- 背景：定时任务已改造为全局目录（WA_PI_DIR/scheduled-tasks/）架构，本次收口 agent 侧管理与执行链路：①agent 对话中创建的定时任务默认归属当前会话项目，且编辑/运行/删除不允许越权操作其他项目任务；②system prompt 的定时任务引导文案改经 ctx 注入（不再在渲染层写死，路径/文件名用共享常量拼接）；③CLI 新增 delete 命令与 --im-push 推送目标标记，让 agent 建带推送目标的任务、执行时能注册 im_push_to 工具推送。
- 改动：
  - `agent-manager.ts`：pi 子进程 env 注入 `WA_PI_SCHEDULER_PROJECT_ID`（归属当前会话项目）；system prompt 注入 `scheduledTasksContext: buildScheduledTasksSystemPrompt()`。
  - `system-prompt.ts`：`SystemPromptContext` 新增 `scheduledTasksContext`；scheduled-tasks 段改 `return ctx.scheduledTasksContext ?? ""`（不再写死）；新增 `buildScheduledTasksSystemPrompt()`（路径/文件名用共享常量），文案含「必须通过 CLI 操作、禁止直接编辑目录文件」约束。
  - `shared/constants.ts`：新增定时任务资产文件名/目录名常量（SCHEDULED_TASKS_DIR_NAME/CRON_CLI_FILE/SCHEDULED_TASKS_README_FILE/SCHEDULED_TASKS_TASKS_DIR/SCHEDULED_TASKS_LOGS_DIR）。
  - `scheduler-assets.ts`：分发时改用共享常量拼接路径/文件名，避免魔法字符串。
  - `assets/scheduled-tasks/cron-task.ts`：新增 `--im-push 渠道,联系人`（可重复，注入 @im-push-to 标记到 prompt，执行时注册 im_push_to 推送）；`set` 新增 `im-push` key；新增 `delete` 命令（项目隔离：agent 场景只能删本项目任务，跨项目明确提示不可操作）；`assertOwnProject` 校验（编辑/运行/删除均隔离）；help 补充示例用法。
- 验证：kernel 全量 1441 pass 0 fail；scheduler-assets 12 pass（含 im-push 注入/delete 隔离用例）；system-prompt-scheduled-tasks 37 pass（含 「未注入 ctx 不出现」）；typecheck clean。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`system-prompt.ts`、`scheduler-assets.ts`、`packages/kernel/assets/scheduled-tasks/cron-task.ts`、`packages/shared/src/constants.ts`、`packages/kernel/tests/scheduler-assets.test.ts`、`system-prompt-scheduled-tasks.test.ts`。

## 2026-08-27 — feat(kernel): 新增 list_contacts 工具（agent 查询当前系统可用联系人）

- 背景：im_push_to 推送要求 agent 知道目标联系人 id，但 agent 无从枚举。本次暴露查询侧工具 `list_contacts`（与 im_push_to 对称，只读），让 agent 能拿到当前系统可用的联系人列表，确定推送目标。
- 改动：
  - `tools/robot-push.ts`：新增 `contactLabelOf`（名称回退：remark → group 退 chatId 前 8 位 / person 退 userId → 兜底 id）、`formatContactsMarkdown`（Markdown 列表，渠道名经 listWithStatus 映射，解析不到回退 channelId）、`createListContactsTool`（工具定义 + execute，含可选 channelId 过滤）。
  - `wa-pi-bridge.extension.ts`：注册 `list_contacts` 工具（始终注册，Type.Optional(channelId)）。
  - `agent-manager.ts`：新增 `listContactsExecutor` opts + `setListContactsExecutor` setter；`handleTool` 增加 `list_contacts` 分发（未接线返回明确错误、executor 抛错返回失败文本）。
  - `index.ts`：构造 channelManager 后 `setListContactsExecutor` 绑定 `createListContactsTool({ channelManager })`（惰性后绑定，解决循环依赖）。
  - `tests/list-contacts.test.ts`：新增 15 项单元/集成测试；`bridge.test.ts` 契约测试同步（工具数 12→13，ALL_BRIDGE_TOOLS 加入 list_contacts）。
- 验证：kernel 相关测试（list-contacts/robot-push/bridge）60 pass 0 fail；typecheck 通过；shared 141 pass 0 fail。
- 影响范围：`packages/kernel/src/tools/robot-push.ts`、`wa-pi-bridge.extension.ts`、`agent-manager.ts`、`index.ts`、`packages/kernel/tests/list-contacts.test.ts`、`bridge.test.ts`。

## 2026-08-27 — fix(kernel): list_contacts 所属渠道列改显示「渠道类型 · 机器人名」

- 背景：list_contacts 初版所属渠道列用了机器人自定义名（channels.json 的 `name`，如「小 co」），导致 agent 看到的是机器人昵称而非渠道类型，误判归属。用户期望显示渠道类型名（如企微/企业微信）。
- 修复：
  - `tools/robot-push.ts`：新增 `channelTypeLabel`（wecom→企业微信、wechat→微信、feishu→飞书、qq→QQ、未知回退原值）；`formatContactsMarkdown` 渠道列改显示「渠道类型 · 机器人名」，渠道未知回退 channelId。
  - `wa-pi-bridge.extension.ts` + `createListContactsTool`：description 同步更新说明。
  - `tests/list-contacts.test.ts`：新增 `channelTypeLabel` 用例，`formatContactsMarkdown` 断言渠道列「企业微信 · 小 co」。
- 验证：kernel 相关测试（list-contacts/robot-push/bridge）65 pass 0 fail；typecheck 通过。
- 影响范围：`packages/kernel/src/tools/robot-push.ts`、`wa-pi-bridge.extension.ts`、`packages/kernel/tests/list-contacts.test.ts`。

## 2026-08-26 — feat(ui): 任务完成青蛙动画（随机姿势 + 聊天区四角随机蹦出）

- 背景：任务完成（agent_end 终态）原先只有提示音、缺视觉反馈。用户希望加一只青蛙从聊天区域蹦出，每次姿势/形态不同、出现在四角之一，并可开关。
- 改动：
  - `util/frog.ts`：新增 `FrogPose`（jump/sit/wave/sleep）、`FrogCorner`（tl/tr/bl/br）类型，`pickFrogPose/pickFrogCorner`（rng 可注入），`triggerTaskDoneFrog(sessionId)`（受 `frogTaskDone` 开关控制 + 仅当触发会话是当前会话才生效 + 写入 frog store）。
  - `store/frog.ts`：新增全局 `useFrogStore`（current burst + setCurrent/clear），`FrogBurst` 含 `corner` 与 `sessionId`。
  - `components/ui/TaskDoneFrog.tsx`：在聊天区（MessageList 容器）内 `absolute` 四角随机蹦出 SVG 青蛙，每种姿势带内建动作（呼吸/眨眼/跳跃蹲跳/挥手/zzz 飘动），动画结束自动清除。
  - `MessageList.tsx`：在聊天区容器内挂载 `<TaskDoneFrog />`（仅当前会话渲染）。
  - `styles.css`：新增四角跳入 `wa-frog-in-tl/tr/bl/br` + 姿态内部动作 `wa-frog-breathe/blink/jump/wave/zfloat` 关键帧。
  - `store/ui-prefs.ts`：新增 `frogTaskDone` 开关（默认 开）+ setter + 持久化。
  - `store/session.ts`：agent_end 终态（非 IM 渠道）调用 `triggerTaskDoneFrog(sessionId)`。
  - `AppearanceSection.tsx` + i18n：设置-外观新增「任务完成动画」开关（从通用 tab 移入）。
- 验证：TDD —— frog / frog-trigger / TaskDoneFrog / store-ui-prefs-frog / session-frog / AppearanceSection-frog 共 30 项 0 fail；前端全量 1927 pass 0 fail；typecheck 通过。
- E2E：新增 `task-done-frog.spec.ts`（外观 tab 开关可切换持久化，与 settings-sound 同构）；本机因隔离 kernel 冷启动未配置模型触发首屏引导 modal 未能实跑通过，CI/配置 provider 环境应通过。
- 影响范围：`packages/frontend/src/util/frog.ts`、`store/frog.ts`、`components/ui/TaskDoneFrog.tsx`、`components/MessageList.tsx`、`store/ui-prefs.ts`、`store/session.ts`、`App.tsx`、`components/settings/AppearanceSection.tsx`、`components/settings/GeneralSection.tsx`、`styles.css`、i18n zh/en、tests 若干。

## 2026-08-27 — v0.2.25 发版（预览归属/高亮收敛 + 提示音随机池 + 引导队列修复）

- 版本：0.2.24 → 0.2.25。
- 主要：切换会话预览归属到对应会话（新建页文件树 HTML 预览带 sessionId 锚点、切走不残留）；本地预览高亮框屏幕边缘收敛进视口；事件完成提示音改随机池（6 个音效，移除重复青蛙叫）；同一会话只允许一条引导中队列。
- 验证：pack:mac + pack:win；publish-oss.ts 推 R2；git tag v0.2.25 + Gitee Release。

## 2026-08-27 — fix(preview): 新建会话页从文件树打开 html 预览带 sessionId 锚点，切走切回能恢复

- 背景：新建会话页预览「切走关、切回恢复」在文件树打开时失效——NewSessionPane 文件树双击 html 用 `openBrowser(path)`（不带 sessionId），预览未归属到本页锚点，切走时 `activateSession` 记不住它，切回自然不恢复。而预览图标用 `openBrowser(undefined, sessionId)`（带锚点）正常。
- 修复：`NewSessionPane.tsx` 文件树 `onOpenFile` 的 html 分支改为 `openBrowser(path, sessionId)`，与非 html 的 `openFilePreview(path, sessionId)` 保持一致，预览按本页锚点记忆。
- 验证：TDD —— 复现「用不带 sessionId 的 openBrowser 打开预览→切走→切回不恢复」红灯；「用带 sessionId 归属锚点→切走→切回恢复」绿灯；`NewSessionPane.test.tsx` 25 pass 0 fail；前端全量 1907 pass 0 fail；typecheck 通过。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`。

## 2026-08-27 — feat(sound): 事件完成提示音改为随机池播放（新增 6 个前 1 秒音效 + 原有青蛙叫）

- 背景：任务完成（`agent_end` 终态）提示音原先固定播放 `frog-croak.mp3` 一个文件，听感单一。用户希望从随机池等概率播放，新增 6 个音效（各截取前 1 秒）与原有青蛙叫混合随机。试听后确认其中某新音效与原有青蛙叫重复，最终决定移除原青蛙叫，随机池只用 6 个新音效。
- 改动：
  - `packages/frontend/public/sounds/` 新增 `event-done-1.mp3` ~ `event-done-6.mp3`（51miz 音效素材，`-t 1` 截取前 1 秒），并删除原 `frog-croak.mp3`。
  - `sound.ts`：新增导出常量 `TASK_DONE_SOUND_POOL`（仅 6 个新音效）；`taskDoneSound()` 改为 `pickTaskDoneSound()` 从池中等概率随机选一个播放（音量 0.8、自动播放策略静默降级逻辑不变）；`previewTaskDone` 试听同样随机。
- 验证：TDD —— `sound.test.ts` 更新「播放青蛙叫」为「播放随机池成员」，新增「池仅 6 个新音效、不含青蛙叫、无重复」「500 次采样覆盖全部池（等概率）」两例，15 pass 0 fail；`bun run typecheck` 通过；`bun run build` 后 `dist/sounds/` 同步 6 个新音频且清除 frog-croak。
- 影响范围：`packages/frontend/src/util/sound.ts`、`packages/frontend/tests/sound.test.ts`、`packages/frontend/public/sounds/event-done-1..6.mp3`（删除 `frog-croak.mp3`）。

## 2026-08-27 — fix(preview): 切到新建会话/空视图时关闭预览不残留；新建会话页顶部加预览图标

- 背景：
  - 会话页打开 HTML 预览后切到新建会话页，预览页面未关闭（BrowserPanel 挂载只取决于 store.open，与 view 无关），旧预览在新建页残留。
  - 新建会话页顶部缺少预览浏览器入口，无法像会话页那样打开预览。
- 修复：
  - `App.tsx`：新增派生 view effect 分支——view 为 `new-session`/`empty` 时调用 `activateSession(null)` 关闭当前会话预览（切走关闭）；切回真实会话时由 `onSelectSession` 的 `activateSession(id)` 恢复（切回恢复）。
  - `NewSessionPane.tsx`：顶部加入预览浏览器图标（`btn-browser-preview`），点击 `openBrowser(undefined, 自身锚点 sessionId)`；新增挂载 effect 调 `activateSession(自身 sessionId)` 实现“按会话记忆、切走关、切回恢复”（新建页预览锚点与草稿共用 `newSessionKey` 派生的 sessionId，同草稿持久化机制）。
- 验证：TDD —— `browser.test.ts` 新增 activateSession(null) 关闭-恢复用例；`App.test.tsx` 新增“处于新建/空视图时已打开预览被关闭”；`NewSessionPane.test.tsx` 新增“顶部预览图标点击打开并归属锚点”；前端全量 1902 pass 0 fail；前端 typecheck 通过。
- 影响范围：`packages/frontend/src/App.tsx`、`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/src/store/browser.test.ts`、`packages/frontend/tests/App.test.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`。

## 2026-08-27 — fix(preview): 本地预览高亮选择框在屏幕边缘时收敛进视口，不再溢出

- 背景：本地 HTML 预览的元素高亮选择功能，选中屏幕边缘（右侧/底部/左侧/顶部）的元素时，高亮选择框用元素原始 `getBoundingClientRect` 换算的文档坐标直接定位，未对视口做 clamp，导致框跑到屏幕外无法操作；工具条（选择父级/发送到聊天）与提示小字（⌘ 关闭高亮）同样可能溢出。
- 修复：
  - `preview-inspect.js` 新增纯函数 `clampRectToViewport(x,y,w,h,vw,vh)`：把文档坐标矩形平移（宽/高超视口才收缩）收敛到视口内，尺寸不变仅移动 left/top。
  - `render()` 中高亮框 `hl`、工具条 `bar`、提示小字 `tip` 均改走 `clampRectToViewport`，整体可见、可操作。
- 验证：TDD —— `preview-inspect.test.ts` 新增 6 例（正常/右缘钳 left/底缘钳 top/负坐标钳 0/宽溢出收缩/高溢出收缩）；kernel preview 相关测试 48 pass 0 fail；kernel typecheck 通过；`KERNEL_ASSET_FILES` 确认含 preview-inspect.js。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`、`packages/kernel/tests/preview-inspect.test.ts`。

## 2026-08-26

- **fix（定时任务 AI 化·整分支审查 5 项收口）**：①`sanitizeTaskId`（shared/task-file.ts 与 CLI cron-task.ts 同规则）在剥前导点后再折叠中间连续点为 `-`，并同步将 `SCHEDULER_ASSET_VERSION` 1→2 触发已分发 CLI 重写升级——修复“create 用未校验 id 建出含 `..` 的孤儿任务文件、update/remove/append 均拒绝该 id 导致永久无法管理”；②前端 scheduler store 抽出 `encodeTaskId`，`deleteTask`/`runTaskNow` 的 path 段与 `loadRecords` 的 `?taskId=` query 值统一编码，`updateTask` 复用同一助手——修复含 URL 保留字符的 id 被误删/查错；③60s 项目对账兜底加 `.catch` 防 unhandled rejection；④watcher `allWritesAreSelf` 在存在解析失败文件时不短路（否则错误不广播）；⑤自动化面板空态条件改为 `tasks.length===0 && taskErrors.length===0`，避免与错误卡片语义冲突。影响范围：kernel（scheduler-watcher/scheduler-assets/index/scheduler-task-store）、shared（task-file）、frontend（store/scheduler、AutomationSidebar）及各对应测试。

- **重构（定时任务 AI 化）**：定时任务数据源从全局 `scheduled-tasks.json` 迁移为各项目 `.wa-pi/scheduled-tasks/` 文件夹（任务 md 文件 + 运行日志）；kernel fs.watch 热加载，CLI/agent 直接改文件即生效；每个项目自动分发 `cron-task.ts` CLI 与 README；系统提示词新增一句定时任务目录引导；旧 JSON 自动迁移归档；自动化面板新增「配置错误」条目展示与修复。影响范围：kernel（scheduler*/routes/index/system-prompt/agent-manager）、shared（task-file/types/constants）、frontend（automation 面板）、scripts（API 集成测试）、e2e。

## 2026-08-26 — test(e2e): automation.spec.ts 新增定时任务 AI 化（CLI 建任务 + 配置错误修复）两条端到端场景

- 新增 E2E：`packages/frontend/e2e/automation.spec.ts` 末尾追加 `test.describe.serial("定时任务 AI 化（CLI 建任务 + 配置错误修复）")`，含两条用例：①agent 经分发的 CLI（`bun <cwd>/.wa-pi/scheduled-tasks/cron-task.ts add --name E2E任务 --agent dev --schedule '{"type":"daily","time":"09:30"}' --prompt ...`）直接写任务文件 → watcher 热载 → 前端列表可见 → `POST /api/scheduled-tasks/:id/run` 触发 → 执行记录落盘 → `logs/E2E任务.log` 非空 → 清理；②坏任务文件（缺 name）→ 面板「⚠ 配置错误」条目 + 错误原因 → 点进编辑表单补全 → `PUT` upsert 修复 → 错误条目消失、任务正常显示、REST errors 清空。Node 侧复用本文件 `api`/`findTaskByName`，新增 `deleteTaskQuietEncoded`/`findTaskError`/`findRecord`/`waitForCliAsset` helper。
- 测试环境：用偏移端口（`WA_PI_E2E_WS_PORT=9830 WA_PI_E2E_WEB_PORT=5183 WA_PI_WEB_PORT=5183`）避开本机真实 kernel（9776/9778 占用）。`automation.spec.ts` 全部 7 用例通过（既有 1-5 + 新增 6、7）。
- 既有测试修正：因 commit 70a63256 给 store.createTask 加了「新建后自动选中新任务」行为，既有用例 2 的「保存后主区应为执行记录页」断言已过期（实际展示任务详情 `task-detail-view`），本任务修正该断言以匹配当前（刻意的）产品行为，其余既有用例不回归。
- 影响范围：`packages/frontend/e2e/automation.spec.ts`。

## 2026-08-26 — test(scripts): 定时任务文件夹化 API 集成测试（scheduler-api-it.sh）

- **test(scripts)**：定时任务文件夹化 API 集成测试（scheduler-api-it.sh）
- 新增 `scripts/scheduler-api-it.sh`：自含起停隔离临时 kernel 的定时任务文件夹化 REST API 集成验收脚本（9 场景：POST 建任务并落盘/列表/watcher 热加载/坏文件 errors/PUT 修复/run 触发/执行记录/DELETE/错误路径 400/404），用独立 `WA_PI_DIR`（mktemp -d）+ 空闲端口（9900 起，lsof 探测）隔离，不触碰宿主 9776/9778。退出清理对 kernel 先 `kill -TERM`（宽限 4s 走优雅退出 → agentManager.disposeAll 回收 pi 子进程），再用 `pkill -TERM -P` 兜底其直接子进程、`kill -KILL` 兜底未退出内核，避免残留孤儿 pi。
- 影响范围：`scripts/scheduler-api-it.sh`（新增）；测试：9 场景全过，退出码 0。

## 2026-08-26 — feat(frontend): 自动化面板展示并修复配置错误的定时任务文件

- 新增功能：scheduler store 新增 `taskErrors: TaskFileError[]` 状态与 `startFixError` action——`loadTasks` 读取 REST 响应 `errors` 存入 `taskErrors`；`startFixError` 用错误信息构造带 `id`（=taskId）的草稿进入编辑表单（id 非空 → 保存走 `updateTask` PUT upsert 修复坏文件，PUT url 对 id 做 encodeURIComponent 适配中文文件名）。AutomationSidebar 在任务列表后渲染「配置错误」条目卡片（⚠ 配置错误 + taskId + 错误原因，error 色 `#f87171` 标红，dashed 边框区分于正常任务），点击进入编辑表单修复。
- 验证：TDD —— 先写 `AutomationMain-errors.test.tsx`（mock GET /api/scheduled-tasks 返回 `{ tasks: [], errors: [...] }`）跑红（2 fail），实现后 `bun run test -- src/components/automation/__tests__/AutomationMain-errors.test.tsx` 2 pass 0 fail；`bun run test -- src/components/automation` 99 pass 0 fail（含既有不回归）；`bun run typecheck` 0 error。
- 影响范围：`packages/frontend/src/store/scheduler.ts`、`packages/frontend/src/components/automation/AutomationSidebar.tsx`、`packages/frontend/src/components/automation/__tests__/AutomationMain-errors.test.tsx`、`packages/frontend/src/components/automation/__tests__/AutomationSidebar.test.tsx`。

## 2026-08-26 — feat(kernel): 系统提示词新增 scheduled-tasks 运行时注入段

- 新增功能：`system-prompt.ts` 新增 `SCHEDULED_TASKS_SEGMENT_ID = "scheduled-tasks"` 与 `ensureScheduledTasksSegment`（位置固定在 memory-policy 之前、im-push 之后），`SystemPromptContext` 增加 `scheduledTasksDir?`；当工作目录存在 `.wa-pi/scheduled-tasks/` 时注入「定时任务管理」引导文案（README.md / cron-task.ts），目录不存在则段不出现。该段为纯运行时注入段不落盘：`savePromptSegments` 剔除、运行时 `ensureScheduledTasksSegment` 补回，`PROMPTS_SCHEMA_VERSION` 26→27（注释标注 v27 新增 scheduled-tasks 段）。`agent-manager.ts` `getPromptSegments` 链上追加补回、`composePrompt` ctx 传 `scheduledTasksDir`（existsSync 探测工作目录）。
- 验证：TDD —— 先写 `system-prompt-scheduled-tasks.test.ts` 跑红（模块未导出 0 pass），实现后 `bun test tests/system-prompt.test.ts tests/system-prompt-im-push.test.ts tests/system-prompt-scheduled-tasks.test.ts` 42 pass 0 fail；kernel 全量 `bun test` 无新增失败（仅既有第三层集成环境性失败），`tsc --noEmit` 0 error。
- 影响范围：`packages/kernel/src/system-prompt.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/tests/system-prompt.test.ts`、`packages/kernel/tests/system-prompt-scheduled-tasks.test.ts`。

## 2026-08-26 — feat(kernel): 定时任务装配切换——文件夹存储 + watcher + 迁移 + kernel.json

- 新增功能：`index.ts` 调度器装配从旧 JSON 过渡接线整体切换为文件夹存储 + watcher 热加载——`schedulerProjectsProvider = () => buildSchedulerProjects(async () => (await projectStore.load()).projects)`、`taskStore = createFolderTaskStore({ projectsProvider })`；启动时 `migrateLegacySchedulerFiles` 一次性迁移旧 `scheduled-tasks.json`/`execution-records.json`（resolveProject 预取项目表 + 查不到回退默认工作区，迁移数 >0 打日志）；对每个项目 `ensureScheduledTasksAssets(p.cwd)` 分发 CLI/README；`TaskScheduler` 的 `loadTasks` 改为 `(await taskStore.listAll()).tasks`，`executeTask` 两处执行记录写入改走 `taskStore.appendRecord(task.projectId ?? SYSTEM_PROJECT_ID, task.id, record)`（append-only + 读取去重即完成 running→终态回写）；新增 `TaskFolderWatcher`（外部文件变化热生效：新/改 scheduleTask、消失 cancelTask、错误与列表变更广播），`server.setSchedulerStore(taskStore)` 注册 Scheduler REST 路由，并加 60s 项目增删兜底对账。`ws-server.ts` 新增 `setSchedulerStore(store)` 延迟注册 `/api/scheduled-tasks*`（数据源为文件夹存储）；`constants.ts` 新增 `KERNEL_INFO_FILE = ${WA_PI_DIR}/kernel.json`，`server.start()` 后写入 `{ port, pid, startedAt }` 供 CLI 发现 kernel，旧 `SCHEDULED_TASKS_FILE`/`EXECUTION_RECORDS_FILE` 标注「仅迁移读取用」。
- 验证：TDD —— `scheduler-assembly.test.ts`（buildSchedulerProjects：默认工作区永远在内、已 seed 不重复追加）；聚焦 `bun test tests/scheduler-assembly.test.ts tests/scheduler.test.ts tests/routes-scheduler.test.ts` 58 pass 0 fail；kernel 全量 `bun test`（隔离集成测试走 `test.ts` 入口）1423 pass 0 fail，`tsc --noEmit` 0 error。
- 影响范围：`packages/shared/src/constants.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/scheduler.ts`、`packages/kernel/src/scheduler-projects.ts`、`packages/kernel/tests/scheduler-assembly.test.ts`。

## 2026-08-26 — feat(kernel): 定时任务 CLI 与 README 资产及自动分发

- 新增功能：新增 `packages/kernel/assets/scheduled-tasks/`（自包含 CLI `cron-task.ts` + 面向 agent 的 `README.md`）与 `packages/kernel/src/scheduler-assets.ts` 的 `ensureScheduledTasksAssets(projectCwd)`——确保项目 `.wa-pi/scheduled-tasks/`（tasks/logs）存在，按首行版本戳比对，旧版自动覆盖升级 CLI/README，用户自加文件不动；写入走 tmp+rename 原子写。CLI 子命令：help/list/show/add/set/validate/test/run，frontmatter/cron 求值逻辑内嵌（与 shared/task-file.ts 同规则），run 经 `${WA_PI_DIR}/kernel.json` 发现 kernel 后 curl 触发。
- 打包裁决：kernel 走 `bun build --compile` 单文件编译，外置 assets 目录不随二进制分发，故用 Bun text import 把两个资产内嵌进 bundle（dev 的 bun run / bun test 原生支持；tsc 不认识 text import，用 @ts-expect-error 屏蔽）；已用临时编译产物冒烟验证分发与 CLI 可用。
- 验证：TDD —— 先写测试跑红（模块不存在），实现后 `bun test tests/scheduler-assets.test.ts` 5 pass 0 fail（含 Bun.spawnSync 真实跑 CLI 的 help/add/list/validate/test 全链路与 kernel 离线报错路径）；kernel 全量 `bun run test` 通过；`tsc --noEmit` 通过。
- 审查修复（同日归并）：CLI `loadTask` 补任务 id 路径校验（含 `/`、`\`、`..` 或空串即拒绝，堵 `set ../escape/out` 路径穿越）；`parseField` 补步进正整数校验（`*/0` 不再死循环，报「cron 步进非法」，对齐 shared）；`parseTask` 补 `schedule.type` 枚举与 `model` 类型检查（对齐 shared `validateTaskData`）。
- 影响范围：`packages/kernel/assets/scheduled-tasks/cron-task.ts`、`packages/kernel/assets/scheduled-tasks/README.md`、`packages/kernel/src/scheduler-assets.ts`、`packages/kernel/tests/scheduler-assets.test.ts`。

## 2026-08-26 — refactor(kernel): 定时任务 REST 与调度器切换到文件夹存储

- 重构：`createSchedulerRoutes` 签名改为 `(store: FolderTaskStore, onTaskChanged, onTaskDeleted, onRunNow)`，端点路径/方法/状态码不变；GET `/api/scheduled-tasks` 响应变为 `{ tasks, errors }`（解析失败的任务文件以 errors 条目返回）；POST 未传 projectId 进默认项目（SYSTEM_PROJECT_ID）；PUT 支持修复解析失败文件（upsert：body 完整合法时覆盖写，文件不存在 404）；DELETE 可删坏文件（幂等）；execution-records 改由 store.listRecords 从各项目 logs 聚合（倒序、200 上限、字段不变）；入口校验改用 shared 的 `validateTaskData`，删除本地副本。`SchedulerDeps` 改为 `{ loadTasks, dataDir, executeTask, broadcast }`（删 tasksFile/recordsFile），`TaskScheduler` 新增 `scheduledIds()`（watcher 对账用）。
- 过渡适配：`ws-server.ts` 定时任务路由注册段暂缓接线（Task 6 装配 watcher 后统一接，接线前 `/api/scheduled-tasks*` 回落 404）；`index.ts` 的 TaskScheduler 暂以 `loadTasks: () => loadScheduledTasks(SCHEDULED_TASKS_FILE)` 注入，迁移期调度行为不变。
- 验证：TDD —— 先改写测试跑红（20 fail），实现后 `bun test tests/routes-scheduler.test.ts tests/scheduler.test.ts` 56 pass 0 fail；kernel 全量 `bun run test` 通过；`tsc --noEmit` 通过。
- 影响范围：`packages/kernel/src/scheduler.ts`、`packages/kernel/src/routes/scheduler.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/index.ts`、`packages/kernel/tests/routes-scheduler.test.ts`、`packages/kernel/tests/scheduler.test.ts`（旧 `scheduler-store.ts` 仍保留供 Task 4 迁移读取）。

## 2026-08-26 — feat(kernel): 旧定时任务 JSON 到项目文件夹的一次性迁移

- 新增功能：新增 `packages/kernel/src/scheduler-migrate.ts` 的 `migrateLegacySchedulerFiles`——启动时一次性把旧全局 `scheduled-tasks.json` + `execution-records.json` 迁移到各项目 `.wa-pi/scheduled-tasks/` 文件夹格式：任务按 projectId 分发（无 projectId 进默认工作区），新 id = `sanitizeTaskId(name)`（冲突追加 -2），执行记录 taskId 同步改写为文件名 id 并追加到对应 log，孤儿记录丢弃；完成后旧文件重命名为 `.migrated` 归档；幂等（旧文件不存在即 no-op）。任务文件写入走 tmp+rename 原子写。
- 验证：TDD —— `bun test tests/scheduler-migrate.test.ts` 3 pass 0 fail（无旧文件 no-op、按 projectId 分发 + 归档、重复执行 no-op）；kernel 全量测试通过；typecheck 通过。
- 影响范围：`packages/kernel/src/scheduler-migrate.ts`、`packages/kernel/tests/scheduler-migrate.test.ts`（旧 `scheduler-store.ts` 仅作迁移读取用，Task 12 才删除）。

## 2026-08-27 — fix(steer): 同一会话同时只允许一条引导中，已有引导时后续引导降级为排队

- 背景：原引导队列允许同时存在多条引导（`steerList`/`steering` 均为数组，可叠加）。用户期望「已有引导中时再按 Ctrl+回车只进排队队列」「排队消息的「引导」按钮在已有引导中置灰」「「立即」按钮保留可用」「引导完成后排队消息自动按顺序发送」。
- 修复：
  - 前端 `Composer.tsx` `handleSendSteer`：运行中且已有引导中（`steering` 非空）→ 降级走 `doSend` 排队路径（调 `/prompt`、入 `followUp`），不再叠加第二个引导（不调 `/steer`）。
  - 前端 `SessionView.tsx` `btn-promote`：`disabled` 增加 `steering.length > 0`（已有引导中置灰「引导」按钮）；「立即」按钮保留可用。
  - 后端 `agent-manager.ts` `steerMessage`：busy 分支若 `steerList` 非空 → 第二条引导消息转投 `followUpList` 排队（防御兜底，保证后端也只有一条引导）。
- 验证：TDD —— 前端 Composer + SessionView 组件测试 63 pass 0 fail（新增「已有引导中 Ctrl+回车降级排队」「btn-promote 置灰」「btn-immediate 保留可用」三例）；kernel steer-queue-poc + routes-chat + agent-manager 146 pass 0 fail（更新「agent_settled 优先 drain steerList」反映新语义）；前端全量 1899 pass 0 fail；前后端 typecheck 通过。
- 影响范围：`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/SessionView.tsx`、`packages/kernel/src/agent-manager.ts`、`packages/frontend/tests/Composer.test.tsx`、`packages/frontend/tests/SessionView.test.tsx`、`packages/kernel/tests/steer-queue-poc.test.ts`。

## 2026-08-27 — v0.2.24 发版（应用内置内核升级 0.1.3 + 内核更新清单平台化）

- 版本：0.2.23 → 0.2.24。
- 主要：应用内置内核从 0.1.2 升级到 0.1.3（auto-compact 阈值改用率百分比，修复大窗口 token 估算偏低导致 400 溢出）；内核更新清单平台化（kernel-latest-<platform>.json，多平台共存互不覆盖）。
- 验证：kernel-updater.test.ts 21 pass 0 fail；auto-compact.test.ts 7 pass 0 fail；pack:mac + pack:win；publish-oss.ts 推 R2；git tag v0.2.24 + Gitee Release。

## 2026-08-27 — 内核独立发布 v0.1.3（自动压缩阈值改用率百分比更早触发）

- 内核版本 0.1.2 → 0.1.3，发布包 `kernel-20260825-1.zip`（darwin-x64）。
- 内容：`shouldCompactBeforeSend` 从固定 33000 预留改为窗口 85% 使用率阈值，修复大窗口下 pi token 估算偏低导致的窗口边缘溢出 400。
- 验证：auto-compact.test.ts 7 pass 0 fail；内核编译 1000 模块；R2 发布 kernel-latest.json 已指向 0.1.3（sha256 39df27e8）。客户端启动检查内核清单自动更新。

## 2026-08-27 — perf(kernel): 发送前自动压缩阈值从「窗口−33K 预留」改为「窗口 85%」更早触发

- 背景：原 `shouldCompactBeforeSend` 用固定 33000 预留（1M 窗口下 96.7% 才触发），对 pi 的「字符数/4」token 估算偏低、目录 contextWindow 偏小的模型，直到真实窗口边缘才压缩；此刻 pi 请求层 max_tokens 已被顶到模型上限，叠加真实 token 越过窗口 → 400（DeepSeek V4 Flash：pi 估算 61 万≈真实 66.5 万，max_tokens 顶 384K 溢出 721 token）。
- 修复：`shouldCompactBeforeSend` 改为「used > contextWindow × 0.85」，压缩提前到 85% 触发；常量 `AUTO_COMPACT_RESERVE_TOKENS`(33000) → `AUTO_COMPACT_USAGE_RATIO`(0.85)；同步更新 agent-manager 日志与 import。
- 验证：TDD —— auto-compact.test.ts 7 pass 0 fail；旧符号残留引用清理干净。
- 影响范围：`packages/kernel/src/auto-compact.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/__tests__/auto-compact.test.ts`。

## 2026-08-27 — v0.2.23 发版（回复过程默认折叠开关 + 附件绝对路径修复 + MCP 测试兼容修复）

- 版本：0.2.22 → 0.2.23。
- 主要：系统设置→外观 新增「回复过程默认折叠」开关；上传附件发 AI 的路径改绝对 path 引用；MCP stdio 连接测试打包环境兼容修复（BUN_BE_BUN=1）。
- 验证：kernel 全量 1397 pass 0 fail；frontend 全量 1896 pass 0 fail；typecheck 通过；pack:mac + pack:win；publish-oss.ts 推 R2；git tag v0.2.23 + Gitee Release。

## 2026-08-27 — fix(test): MCP stdio 连接测试在打包环境下挂起（spawn 缺 BUN_BE_BUN=1）

- 背景：打包/开发机 `~/.pi/agent/bin/bun` 是 shim，`exec` 到内核编译产物 `WaPiKernel`，`process.execPath` 指向它。MCP 测试用 `spawn(process.execPath, [echo-mcp-server.ts])` 跑 stdio server，但测试不经 `startKernel`（其 `ensureBunBeBunEnv()` 才会注入 `BUN_BE_BUN=1` 供子进程继承），导致 WaPiKernel 以内核模式启动（监听 WS 端口 → EADDRINUSE → stderr 输出内核日志 → 非 JSON）→ SDK StdioClientTransport 收不到 JSON-RPC → 连接挂起/关闭。
- 现象：`mcp-connector.test.ts` / `routes-mcp.test.ts` 的 testConnection/listTools/mcp:testResult/mcp:tools 等 4 例在 shim bun 下失败超时；用 `/usr/local/bin/bun` 跑全过（6 pass 0 fail）。
- 修复：两处测试的 MCP stdio config 显式加 `env: { BUN_BE_BUN: "1" }`，使 spawn 的子进程以 bun 模式跑 fixture，与生产 `ensureBunBeBunEnv()` 行为一致。
- 验证：shim bun 下 mcp-connector+routes-mcp 从 4 fail → 9 pass 0 fail；mcp 全量 27 pass 0 fail；kernel 全量 1397 pass 0 fail；kernel typecheck 通过。
- 影响范围：`packages/kernel/tests/mcp-connector.test.ts`、`packages/kernel/tests/routes-mcp.test.ts`。

## 2026-08-27 — feat(share): 再次分享同组文件时预填上一次分享名

- 新增：分享文件弹窗打开时，若该组文件路径之前分享过，预填上一次使用的分享名称到输入框（用户仍可编辑后生成链接）。
- 实现：kernel 新增 `POST /api/share/name-for-paths`，按 `hashPaths(paths)` 匹配 `item.id` 返回历史分享名；前端 `ShareResultModal` 挂载后调用，仅当用户未手动改过输入框时回填（`nameEditedRef` 防覆盖）。
- 调整：`hashPaths` 改用 `Bun.hash` 生成分享 id（保留正/反斜杠归一化，输出 12 位 hex，分享 id 格式保持合规）。不做兼容性迁移。
- 验证：TDD —— `share-pack.test.ts` 4 pass 0 fail（行为契约保持）；`share-routes.test.ts` 22 pass 0 fail（含 name-for-paths 命中/null/400 三例）；`ShareButton.test.tsx` 17 pass 0 fail（含回填/默认名/防覆盖三例）。
- 影响范围：`packages/kernel/src/share/pack.ts`、`packages/kernel/src/routes/share.ts`、`packages/frontend/src/share-client.ts`、`packages/frontend/src/components/ui/ShareButton.tsx` 及相关测试。

## 2026-08-25 — fix(kernel): 中止（停止）成功后广播 agent_end，修复前端停止后永远卡「思考中」

- 背景：点击「停止」后 agent 实际已停下（`handle.busy=false`），但前端一直显示「思考中」。
  根因：`AgentManager.abort()` 成功路径（abort RPC 正常返回）只更新内部 `handle.busy/thinkingSince`，
  **不向前端广播任何退出思考态的事件**（`agent_end`/`agent_settled`）。前端 `statusBySession` 退不出
  thinking 完全依赖 pi 侧是否广播 `agent_settled`，而 pi 的 `session.abort()` 在 agent 已 idle 时
  `waitForIdle()` 立即返回，`_emitAgentSettled` 不触发、不广播 `agent_settled` → 前端永远卡住。
  只有 5s 超时强杀路径才广播 `agent_end`，正常成功路径缺失。
- 修复：`abort()` 成功路径补合成广播 `type:"agent_end"`（幂等，前端再次复位为 idle），与超时强杀路径并列，两条分支互斥不重复。
- 验证：TDD —— 新增测试「abort 成功返回后广播 agent_end（前端退出思考态兜底）」，改动前失败（仅广播 queue_update），改动后通过；agent-manager 全量 113 pass 0 fail，ws-agent-prompt-echo 全绿；kernel 类型检查干净。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/tests/agent-manager.test.ts`。

## 2026-08-24 — feat(ui): 外观设置新增「回复过程默认折叠」开关（agent 回复中工具调用/思维链默认不展开）

- 新增：系统设置→外观 增加 switch 开关「回复过程默认折叠」，开启后（默认开启）agent 回复过程中工具调用与思维链默认折叠（不自动展开），仍可手动点开查看；关闭后恢复旧行为（回复过程中默认展开）。
- 实现：`store/ui-prefs.ts` 新增 `collapseProcessByDefault`（默认 true）+ `setCollapseProcessByDefault`，经 `useAutoCollapse` 的 `defaultCollapsed` 参数接入；覆盖 ThinkingCard / ToolCallCard / ToolGroupCard，**并同步接入 DelegateCard / FleetCard**（后两者原在 `hasProgress` 有实时进度时强制默认展开，会无视开关；现开关开启时即使有进度也默认折叠，用户仍可手动展开）。增加中英文文案。
- 验证：TDD —— 新增 store / useAutoCollapse / AppearanceSection / 卡片行为（Thinking/ToolCall/Delegate/Fleet 开关开折叠、开关关展开）测试；受限并发全量 1894 pass 0 fail；typecheck 干净；浏览器实测开关切换与持久化生效。
- 影响范围：`packages/frontend/src/store/ui-prefs.ts`、`packages/frontend/src/components/blocks/useAutoCollapse.ts`、`packages/frontend/src/components/blocks/ThinkingCard.tsx`、`packages/frontend/src/components/blocks/ToolCallCard.tsx`、`packages/frontend/src/components/blocks/DelegateCard.tsx`、`packages/frontend/src/components/blocks/FleetCard.tsx`、`packages/frontend/src/components/settings/AppearanceSection.tsx`、`packages/frontend/src/i18n/locales/zh.ts`、`packages/frontend/src/i18n/locales/en.ts` 及相关测试。

## 2026-08-24 — fix(kernel): 上传附件发给 AI 的路径改为绝对路径（不再用项目相对路径）

- 背景：上传附件存盘时本就用绝对路径（`.wa-pi/uploads` 是绝对路径下子目录），但发 prompt 前 `buildPromptContent()` 用 `path.relative(handle.cwd, a.path)` 把绝对路径改写成项目相对路径（`.wa-pi/uploads/xxx`）。该相对引用依赖 AI（pi 进程）以 `handle.cwd` 为基准解析——一旦 AI 中途 cd、附件在项目外（`../Desktop/xxx`）、跨盘符或解析基准不一致，AI 就找不到文件（用户反馈“AI 经常找不到位置”）。回归自 commit `e5c74cba`。
- 修复：`buildPromptContent()` 去掉 `relative(cwd, a.path)` 改写，直接发__绝对路径__ `path:` 引用（统一全正斜杠），不再依赖 cwd 解析。同时移除 `node:path` 的 `relative` 导入。**前端文件树拖拽到输入框的插入文本同步改为 `path:绝对路径`**（`ExplorerPanel.startDrag` 的 `wa-pi:insert-mention` 事件），与 kernel 引用格式保持一致。
- Windows 兼容：路径用 `replace(/\\/g, "/")` 归一，Windows 绝对路径 `C:\Users\...` 转为 `C:/Users/...` 全正斜杠（跨平台可解析）；测试断言同步用正斜杠归一，保证 Windows 上也能通过。
- 验证：更新 `agent-manager.test.ts` / `composer-attachments.test.ts` 中断言（从 basename 改为完整绝对路径 `path:` 引用），改动前 1 个失败（图片累计超限回退），修复后两个测试文件 124 pass 0 fail；kernel 类型检查干净；前端 MessageList/AttachmentChip/Composer 相关 105 pass 0 fail，ExplorerPanel 相关 21 pass 0 fail。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/composer-attachments.test.ts`、`packages/frontend/src/components/ExplorerPanel.tsx`。

## 2026-08-24 — v0.2.22 补丁发版（关于页内核版本显示修复 + Windows bash 检测修复 + 内核独立发布）

- 版本：0.2.21 → 0.2.22。
- 主要：修复关于页「内核版本」显示错误（syncSeed 在动态 kernel 下覆盖 runtime 的 package.json 为 seed 旧版 → 现不再覆盖，正确显示更新后内核 0.1.1）；修复 Windows WSL bash stub 误判（No bash shell found）；publish-kernel 的 kernelVersion 改读内核 package.json（0.1.1）；内核独立发布链路打通（publish-kernel.ts 发布内核包，客户端启动自动更新）。
- 验证：bun run test 全量回归；pack:mac + pack:win（wapi-sign + CSC_IDENTITY_AUTO_DISCOVERY=false 免弹签名）；publish-oss.ts 推 R2；git tag v0.2.22 + Gitee Release。

## 2026-08-24 — fix(kernel): Windows 被 WSL 占位 stub 欺骗导致 PortableGit 永远不接线，bash 工具报 "No bash shell found"

- 背景：打包版 / 无 Git Bash 的 Windows 上，使用 bash 工具必现 "No bash shell found"。`ensureBashAvailable()` 调用 `findSystemBash()` 检测系统 bash；而 Windows 10/11 自带 WSL 占位 stub `C:\Windows\system32\bash.exe`——`existsSync` 为真、出现在 PATH 上，但 WSL 未装时 `--version` 跑不通。`findSystemBash()` 只查文件存在不校验可用性，把这个 stub 误判为"已装 Git Bash" → 提前 return null → PortableGit 下载分支永远不走 → `settings.json.shellPath` 恒为空 → pi 子进程读到空 → 报错。诊断桩在真机证实：`findSystemBash()` 命中该 stub 但 `bash --version=null`，而 PortableGit 手动下载解压正常（5.2.37）。
- 修复：`findSystemBash()` 命中候选（含 PATH 分支）后必须 `bashVersionOf(candidate)` 非 null 才算"真可用"，否则返回 null，让流程走 PortableGit 下载接线。
- 验证：新增测试复现该 bug（mock `Bun.which` 返回"存在但 --version 跑不通"的假 bash，断言 `findSystemBash()` 返回 null；返回真可用 bash 时断言返回其路径），修复前失败、修复后通过；kernel 全量测试通过，全量回归 1874 pass 0 fail。
- 影响范围：`packages/kernel/src/bash-runtime.ts`、`packages/kernel/tests/bash-runtime.test.ts`。

## 2026-08-24 — fix(preview): 锁定元素后点击其他元素不再切换/解除高亮

- 背景：元素锁定态下，点击非锁定元素会解除锁定并把高亮跳到新元素；用户期望高亮应一直锁在锁定元素上，只有「点锁定元素解锁/选择父级改锁定目标」两种途径改变。
- 修复：`preview-inspect.js` click handler 的锁定分支改为——点击锁定元素（或其子元素）本身才解锁；点击任何其他元素保持锁定（return），不再跳到新元素。
- 验证：浏览器实测「锁定 A → 点击/hover B → 高亮仍在 A、锁图标仍在 → 点击 A → 解锁」；`preview-inspect.test.ts` 6 pass。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-24 — fix(preview): 关闭高亮选择后页面滚动/缩放不会再让高亮复活

- 背景：关闭高亮选择（Ctrl/⌘ 切换 disabled）后，点击页面元素引起滚动/布局变化时，`scroll`/`resize` 直接触发 `render`，而 `render` 未检查 disabled → `current` 仍在 → 高亮重新出现。
- 修复：`preview-inspect.js` 的 `render` 开头若 disabled 则隐藏 hl/bar/tip 并 return，任何触发（含 scroll/resize）都不再绘制高亮。
- 验证：浏览器实测「hover 高亮 → Ctrl 关闭 → 触发 scroll/resize/hover 别处」高亮均保持隐藏；`preview-inspect.test.ts` 6 pass。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`。

## 2026-08-24 — feat(preview): 预览高亮选择支持 Ctrl/Cmd 开关 + 平台按键提示 + 状态本地保存

- 背景：高亮选择（hover 高亮/元素锁定）默认一直开启、无关闭入口；希望按 Ctrl/Cmd 关闭，且关闭后本地记住（下次预览仍关闭）、再按才打开。
- 方案：`preview-inspect.js` 把「关闭高亮选择」改为开关：按 Ctrl（Windows）/⌘（mac）切换开启/关闭；关闭态隐藏高亮/浮窗/提示且不再响应 hover/click；高亮框左下方、边框外显示一行小字提示当前平台按键（mac 显示 ⌘、Windows 显示 Ctrl）。
- 持久化：本地预览 iframe 为不透明源（sandbox 无 allow-same-origin）无法自用 localStorage，故开关状态由主应用 `BrowserPanel` 持久化（key `hiagent.preview.inspect`），经 postMessage 双向同步：iframe 加载时 query 查询、切换时 changed 上报、主应用收到 query 回 set 下发。
- 实现位置：`packages/kernel/src/assets/preview-inspect.js`、`packages/frontend/src/components/BrowserPanel.tsx`。
- 验证：`preview-inspect.test.ts` 6 pass + `preview-inspect.integration.test.ts` 11 pass；浏览器实测「hover 高亮+平台提示 → Ctrl 关闭（不响应）→ 再按打开恢复」及「主应用下发 set 关闭」；`BrowserPanel.test.tsx` 25 pass 无回归。
- 影响范围：`preview-inspect.js`、`BrowserPanel.tsx`。注：需重新打包/更新 kernel 后本地预览生效。

## 2026-08-24 — v0.2.21 发版（kernel 二进制动态更新 + 内核版本独立管控 0.1.1 关于页显示 + 预览锁定 + Pi 依赖升级）

- 版本：0.2.20 → 0.2.21。
- 主要内容：kernel 二进制动态更新（发布端 publish-kernel.ts 打包内核包+清单+上传、客户端 kernel-updater.cjs 拉清单/下载/校验/覆盖/回滚、runtime-deps 按 build 号判依赖重装并跳过动态更新 kernel、main.cjs 启动接入 syncKernel，失败降级不阻断）；设置「关于」新增「内核版本」并引入内核独立版本管控（packages/kernel/package.json version = 0.1.1，与 app 版本解耦）；抽取共用 s3-upload.cjs；编译内核嵌入 preview-inspect.js（修复打包版本地 html 预览丢失元素选择/高亮）；依赖升级（pi-mcp-adapter 2.17→2.27 移除 MCP OAuth、@napi-rs/keyring、pi-web-access；打包/安装版本单一来源化）。
- 验证：bun run test 全量回归；pack:mac + pack:win（wapi-sign + CSC_IDENTITY_AUTO_DISCOVERY=false 免弹签名）；publish-oss.ts 推送 R2；git tag v0.2.21 + push Gitee；Gitee Release。

## 2026-08-24 — feat(preview): 预览元素选中支持点击锁定高亮 + 锁图标 + 明确解除

- 背景：预览元素悬停高亮会一直跟鼠标走，「选择父级」后高亮固定但缺乏明确的「锁定/解除」状态反馈，用户期望「点击即锁定、浮窗出现锁图标、能明确解除」。
- 方案：注入脚本 `preview-inspect.js` 增加 `pinned` 锁定态。点击元素 → 高亮固定（不再跟 `mousemove` 切换），浮窗出现锁图标（内联 SVG——脚本运行在被预览页内、无法引用前端组件库）；锁定中「选择父级」仍可切到父元素（保持锁定）；解除方式：再点一次当前元素 / 点锁图标 / 点「发送到聊天」（发送后自动解除，恢复 hover 跟随）。
- 实现位置：`preview-inspect.js`（iframe 内原生 JS，锁图标用内联 SVG——脚本运行在被预览页内、无法引用前端组件库）；锁图标图形与前端 `Icon.tsx` 新增的 `lock` 图标一致（24 viewBox / fill none / stroke currentColor / 1.6 线宽 / 圆角端点）。
- 验证：`preview-inspect.test.ts` 6 pass；`preview-inspect.integration.test.ts` 11 pass（改动前后一致）；浏览器实测「hover 选中→点击锁定（锁图标出现）→锁定中 hover 不切换→再点解除→点发送解除」全通过。
- 影响范围：`packages/kernel/src/assets/preview-inspect.js`、`packages/frontend/src/components/ui/Icon.tsx`（新增 `lock` 图标）。注：需重新打包/更新 kernel 后本地 html 预览生效。

## 2026-08-24 — feat(frontend): 浏览器预览按会话独立记忆，切换会话不再重置预览

- 背景：之前点击侧栏切换会话时，`App.tsx` 的 `onSelectSession` 会无条件调用 `useBrowserStore.getState().closeBrowser()`，把全局预览 store 的 `open/path/sessionId` 全部清空，导致「切换会话后浏览器预览窗口重置」。
- 方案：把预览状态从「单一全局」改为「按会话各自记住一份」。浏览器 store 新增 `bySession: Record<sessionId, SessionPreview>`（含 open/path/minimized）与 `activateSession(sessionId)`；切换会话时 `activateSession` 先记录当前会话预览、再恢复目标会话预览。`openBrowser/closeBrowser/setPath/setMinimized` 同步写入当前会话记忆；外部 URL 导航只写 current 不写 store.path，故 path 不变时不会覆盖外部视图。
- 语义：预览上的「代码查看/分享」按钮跟随当前选中会话（`sessionId` 始终等于当前激活会话）；切到从未打开过预览的会话默认显示空窗口；关闭某会话预览会清空该会话记忆。
- 组件：`BrowserPanel` 增加 `useEffect`，在 `store.path` 变化（会话切换恢复）时同步内部 `current/input`，否则面板挂载期间不随 path 变化而更新、会显示旧内容。同一 effect 顺带修复了「预览已打开时双击其它 html 文件不切换」——此前 `current/input` 从不跟 `store.path` 同步，双击后地址栏与 iframe 仍停留旧文件。
- 验证：`store/browser.test.ts` 新增 activateSession 保存/恢复、closeBrowser 清空记忆、setPath/setMinimized 同步记忆、切到无预览会话默认空 4 例；`BrowserPanel.test.tsx` 新增「store.path 变化时同步渲染内容」「预览已打开再双击其他 html 切换」「空预览双击 html 切换」「外部 URL 显示中双击本地 html 切换」等用例；相关 44 个测试全绿。全量 frontend 套件失败数（~889）与基线一致，属并行/环境 flaky（ExplorerPanel 单独跑通过），与本次改动无关。
- 影响范围：`packages/frontend/src/App.tsx`、`packages/frontend/src/store/browser.ts`、`packages/frontend/src/components/BrowserPanel.tsx`、`packages/frontend/src/store/browser.test.ts`、`packages/frontend/src/components/BrowserPanel.test.tsx`。

## 2026-08-24 — fix(kernel/compile): 编译内核未嵌入 preview-inspect.js，打包版本地 html 预览丢失元素选择/高亮

- 背景：本地 html 预览的元素悬停高亮与「发送到聊天」依赖 kernel 注入的 `/preview-inspect.js`。该脚本由 `ws-server.ts` 的 `/preview-inspect.js` 路由经 `Bun.file(new URL("./assets/preview-inspect.js", import.meta.url))` 读取，但 `compile-binary.ts` 的 `--asset` 嵌入清单（原 `BRIDGE_ASSET_FILES`）只含 bridge 扩展三文件，**没有 preview-inspect.js**。
- 根因：bun `--compile` **不会自动打包** `new URL(..., import.meta.url)` 引用的文件（实测打包后 `Bun.file(...)` 对未嵌入文件 `exists()=false`、`text()` 抛 ENOENT），必须显式列入 `--asset` 才会嵌入产物。因此源码 dev（磁盘资产存在）元素选中正常，而 **win/mac 打包版** `/preview-inspect.js` 返回空 → 注入的 `<script>` 加载失败 → 预览页正常渲染但「无元素选择、无高亮」。表现为「仅打包版失效、页面能看但悬停无任何反应」。
- 修复：`packages/kernel/scripts/compile-binary.ts` 把嵌入清单改名 `KERNEL_ASSET_FILES` 并新增 `join(KERNEL_SRC, "assets", "preview-inspect.js")`；同步更新 `packages/kernel/tests/compile-binary.test.ts`（清单长度 4 / 文件存在 / stageAssetDir 平铺名单 / 新增“必须含 preview-inspect.js”回归护栏）。
- 验证：isolated bun --compile probe 证实「不嵌入→ENOENT、嵌入→new URL 可读、被导入模块同样可读」；用修复后脚本重建临时 kernel 二进制，`curl /preview-inspect.js` 返回 HTTP 200 且含 `选择父级/发送到聊天/hiagent:element-picked/buildSelector` 全部关键串；compile-binary.test.ts 6 pass。
- 影响范围：`packages/kernel/scripts/compile-binary.ts`、`packages/kernel/tests/compile-binary.test.ts`。注意：该修复需__重新打包__ kernel（pack:mac / kernel 动态更新）才能让已安装应用生效。

## 2026-08-24 — feat(kernel/version): 内核版本引入独立管控源（packages/kernel/package.json version）并在关于页显示

- 背景：内核（WaPiKernel，bun --compile 单二进制）此前没有独立版本号（kernel package.json version 为占位 0.0.0；`WaPiKernel --version` 输出的是内嵌 bun 版本而非内核版本；`.kernel-version` 只是动态更新的 build 号）。关于页「内核版本」先前读 `.kernel-version`（未动态更新时为 null）导致新装显示 "—"。
- 管控：`packages/kernel/package.json` 的 `version` 从 `0.0.0` 改为 `0.1.1`（独立于 app 版本的内核版本线），作为内核版本的__唯一管控源__，与产品版本解耦。
- 分发：`buildSidecar` 的 `buildRuntimeManifest()` 把 `version` 写进 `resources/kernel/package.json`（打包随包分发；动态更新打包的 kernel zip 同含此字段，runtime 的 package.json 随之反映新内核版本）。
- 展示：`main.cjs` 的 `getKernelVersion` 改为读 `runtime` / `seed` 目录下 `package.json` 的 `version`（runtime 优先，fallback seed），经 `updater:get-info` → 前端 `AboutSection` 显示「内核版本」。
- 影响范围：`packages/kernel/package.json`、`packages/desktop/scripts/build-kernel-sidecar.ts`、`packages/desktop/src/main.cjs`；验证：build-kernel-sidecar.test.ts 1 pass（buildRuntimeManifest 含 version）、updater.test.ts 15 pass、desktop 相关 typecheck；前端 AboutSection 显示。
- 注意：内核版本为__独立版本线__，与 app 版本解耦；需要时独立改 `packages/kernel/package.json` 的 `version` 即可。

- 链路与 app 版本同构：`main.cjs` 向 `setupUpdater` 传入基于 `WA_PI_DIR` 的 lazy `getKernelVersion`（延迟到 handler 触发再读 `~/.pi/agent/runtime/.kernel-version`，因 setupUpdater 调用早于 runtimeDir 定义），`updater.cjs` 的 `updater:get-info` handler 改 async 并透传 `kernelVersion`（新增纯函数 `buildGetInfoPayload`，可单测），`preload.cjs` 的 `getInfo` 自然透传，前端 `store/updater.ts` 存 `kernelVersion` 并在 `AboutSection` 的 app 版本行下新增「内核版本」行，i18n 增 zh/en 文案。
- `kernelVersion` 为 null/空（runtime 无 .kernel-version，或 dev 环境）时 UI 显示“—”。
- 影响范围：`packages/desktop/src/updater/updater.cjs`、`packages/desktop/src/main.cjs`、`packages/frontend/src/store/updater.ts`、`packages/frontend/src/components/settings/AboutSection.tsx`、`packages/frontend/src/i18n/locales/{zh,en}.ts`；测试：updater.test.ts 新增 2 例（buildGetInfoPayload 原样返回/缺省 null），AboutSection.test.tsx 新增内核版本渲染（含 null 兜底）、typecheck 干净。

## 2026-08-24 — fix(kernel-updater): 合并前加固——平台校验 + build 数值比较 + 首启 mkdir

- `syncKernel` 应用远程清单前校验 `manifest.platform`（`currentPlatform()` 与 `publish-kernel.ts` 的 `platformFor` 一致：win32/linux/darwin-x64|arm64），平台不匹配则跳过更新（返回 up-to-date + info 日志），避免跨平台发布导致「旧二进制+新依赖清单」的半更新并永久卡住。
- `needsUpdate` 由裸字符串 `>` 改为 `parseBuild`/`compareBuild` 数值语义比较（`<YYYYMMDD>-<seq>`），闭合 build 的 seq 未零填充（同日发布 ≥10 次跨个位/十位）时字典序比较造成的升级漏判与降级防护击穿；无法解析回退字符串比较。
- `syncKernel` 起点 `mkdir(runtimeDir, {recursive:true})`，防全新安装首次启动下载写 zip 时 runtimeDir 未创建抛 ENOENT。
- 影响范围：`packages/desktop/src/util/kernel-updater.cjs`、`packages/desktop/src/util/kernel-updater.test.ts`；测试：kernel-updater 19 pass（含平台不匹配/同日跨个位升级/降级防护/首启 mkdir 用例），runtime-deps + 集成 9 pass 无回归，typecheck 干净。

## 2026-08-24 — feat(kernel-updater): syncKernel 支持 WA_PI_KERNEL_FEED_URL env 覆盖 feed

- main.cjs 的 `syncKernel` 调用新增 `feedUrl: process.env.WA_PI_KERNEL_FEED_URL || undefined`：该 env 仅供 E2E/测试指向本地 mock，生产不设置时默认走 `DEFAULT_FEED`（OSS 公开读 kernel-latest.json），失败照旧 log.error 降级且不阻断启动；沿用既有 `WA_PI_UPDATER_FEED_URL` 的 env 覆盖默认 feed 模式。
- 影响范围：`packages/desktop/src/main.cjs`；验证：`node --check` 语法通过（2 行增量，无分支逻辑改动），无回归。

## 2026-08-24 — test(desktop): kernel-updater 本地 mock HTTP 集成测试（下载/校验/覆盖链路）

- 新增 `packages/desktop/src/util/kernel-updater.integration.test.ts`：用 `node:http` 起 127.0.0.1 随机端口 mock 服务（分发 `kernel-latest.json` + 真实 zip 包），假 kernel 三件套用系统 `zip -j` 打包进根目录并计算 sha256，然后__不注入 fetchImpl__、用 Node 18+ 全局 `fetch` 走完整链路：下载 → sha256 校验 → 真实 unzip/tar 解压 → 覆盖 runtimeDir 的 WaPiKernel + package.json + bun.lock → 写 `.kernel-version` → 清理临时 zip 与备份目录。断言 `{status:"updated",build}`、KERNEL_BIN 内容等于 zip 内假 kernel、`.kernel-version` == manifest.build、无 `.kernel-update-*` 残留、备份目录已清理。
- 采用条件定义测试（`if (HAS_ZIP)`）而非 `test.skipIf`，规避 bun 1.4 `skipIf` 语义反转；本机有 zip CLI 时真实运行非跳过。
- 影响范围：`packages/desktop/src/util/kernel-updater.integration.test.ts`（新增）；测试：integration 1 pass（真实网络/解压链路），kernel-updater.test.ts 14 pass 无回归。

## 2026-08-24 — feat(desktop/启动): main.cjs 启动流程接入 kernel 动态更新检查（失败降级）

- 在 2c 依赖安装块__之前__新增 `if (app.isPackaged)` 块调用 `syncKernel`：拉取构建清单，发现新 build 则下载/校验/覆盖 WaPiKernel 并写入 `.kernel-version`，进度 UI 新增 `setProgress(12, "正在检查内核更新…")` 阶段。仅当 `kRes.status === "updated"` 时取 `kernelBuild = kRes.build`，否则为 `null`；整个调用包在 try/catch，失败（超时/清单不可用/下载失败）一律 `log.error` 并置 `kernelBuild = null`，**绝不阻断启动**。
- `ensureRuntimeDeps({ ... })` 新增传入 `kernelBuild`（运行时-依赖侧判定依赖重装，复用 Task 4 的 build 号判定）。
- 影响范围：`packages/desktop/src/main.cjs`；验证：`node --check` 语法通过、`bun run typecheck` 干净、runtime-deps 8 pass / kernel-sidecar 15 pass / kernel-updater 14 pass 全绿，无回归。

## 2026-08-24 — feat(desktop/启动): runtime-deps.cjs 适配动态 kernel（syncSeed 跳过动态更新 + 依赖重装按 kernel build 号判定）

- `syncSeed(seedDir, runtimeDir, log, opts)` 扩展：runtimeDir 已有 `.kernel-version`（kernel 被动态更新过）时__不再用 seed 覆盖 KERNEL_BIN__（保留动态更新后的新二进制）；无 `.kernel-version` 则照常用 seed 覆盖（首次/兼容旧行为，行为不变）。`package.json`/`bun.lock` 仍随 seed 照常同步。`opts.kernelBuild` 可预先传入，否则读 `.kernel-version` 得到（import 复用 kernel-updater 的 `readLocalBuild`，避免重复读文件）。
- `ensureRuntimeDeps` 判定改按 kernel build 号：`buildToUse = kernelBuild || version`（kernelBuild 优先，未传入时从 `.kernel-version` 读到，读不到用 app version 兜底），`nmExists && markerVer === buildToUse` 才跳过 install，`.installed-version` 写入 `buildToUse`。package.json 随动态 kernel 变化时会以 build 号变化触发依赖重装（正是 kernel 动态更新的依赖侧）。
- 未实现「app 升级用 seed 兜底覆盖 kernel」细分场景（控制者裁定：动态 build 恒 ≥ seed build，实际几乎不发生，保持在简单分支）。
- 影响范围：`packages/desktop/src/util/runtime-deps.cjs`、`packages/desktop/tests/runtime-deps.test.ts`；测试：runtime-deps 5 pass（新增 2 例：syncSeed 不覆盖动态 kernel / ensureRuntimeDeps 按 build 号跳过 install），kernel-updater 14 pass 无回归；typecheck 干净。

## 2026-08-24 — feat(desktop/启动): kernel 二进制动态更新客户端同步器 kernel-updater.cjs（拉清单/下载/校验/覆盖/回滚）

- 新增 `packages/desktop/src/util/kernel-updater.cjs`：启动时同步 runtime 目录的 kernel 二进制动态更新。纯函数接口 `readLocalBuild`（读 `.kernel-version`）/`fetchManifest`（拉 `kernel-latest.json`）/`needsUpdate`（build 比较，首次或异地视为需更新）/`verifySha256`（文件 hash 比对清单）/`extractZip`（unzip/tar 解压）/`applyKernelUpdate`（备份三件套→解压覆盖→写版本标记，失败拷回备份）/`syncKernel`（主入口，可注入 fetch/logger/onStatus）。依赖注入便于单测，未注入时回退全局 fetch。
- 安全防御：`isSafeZipEntry`/`assertSafeZip` 解压前校验 zip 条目，reject 绝对路径、Windows 盘符、含 `..` 段的条目（防 zip-slip/路径穿越），只允许解压到 runtimeDir 内。
- 错误降级：全程不向上抛（绝不阻塞启动），网络/清单/下载/sha256 失败统一降级 `up-to-date` 或 `failed`；下载与临时 zip 失败均清残留。只写 `.kernel-version`，package.json 变化由 runtime-deps.cjs（Task 4）判定是否重装依赖。
- 影响范围：`packages/desktop/src/util/kernel-updater.cjs`（新增）、`packages/desktop/src/util/kernel-updater.test.ts`（新增）；测试：13 pass（needsUpdate 4 / sha256 1 / fetchManifest 2 / syncKernel 4 / applyKernelUpdate 回滚 1 / isSafeZipEntry 1），含真实解压集成用例（skipIf 无 zip CLI）；`tests/runtime-deps.test.ts` 3 pass 无回归。

## 2026-08-24 — refactor(scripts): 抽取共用 S3 上传模块 s3-upload.cjs（消除 publish-oss/publish-kernel 重复的 ~150 行 S3 逻辑）

- 新增 `scripts/s3-upload.cjs`：把 S3Client 创建（`createS3Client`）、手动 multipart 分片上传（`uploadLarge`）、小文件单次 PUT（`uploadSmall`）抽为共用模块（含 R2 endpoint/region/bucket 常量与手动指引所用的 BUCKET/ENDPOINT）。`publish-oss.ts` 与 `publish-kernel.ts` 此前各自内联了几乎相同的分片/上传逻辑（约 150 行），抽取后两处复用，达成 DRY。
- 改造 `scripts/publish-oss.ts` 与 `scripts/publish-kernel.ts`：改为从 `s3-upload.cjs` 引入 `createS3Client/uploadLarge/uploadSmall`，删除各自内联的 AWS 命令 import、S3Client 创建与 `uploadLarge`（签名统一为 `(client, key, body, partSize?)` 与 `(client, key, body)`）。发布行为不变：上传顺序（安装包/blockmap 在前、清单最后覆盖）、分片重试、失败 abort、releaseNotes 注入、手动上传指引均保留。
- 影响范围：`scripts/s3-upload.cjs`（新增）、`scripts/publish-oss.ts`、`scripts/publish-kernel.ts`、`scripts/s3-upload.test.ts`（新增）；测试：scripts 全部 12 pass（publish-oss 5 / publish-kernel 4 / s3-upload 3），desktop 包 192 pass / 2 skip 无回归。

## 2026-08-24 — feat(scripts): kernel 动态更新发布脚本 publish-kernel.ts（打包 zip + 生成清单）

- 新增 `scripts/publish-kernel.ts`：把 `packages/desktop/resources/kernel/` 下的 WaPiKernel(+.exe) + package.json + bun.lock 三件套打成 `kernel-<build>.zip`，计算 sha256 并生成 `kernel-latest.json` 清单上传 R2（`releases/kernel/`）。上传顺序复用 publish-oss 的「清单最后覆盖」原则（先传 zip + zip.sha256，最后覆盖清单，防清单悬空指向未上传包）。核心逻辑拆为可单测纯函数（`platformFor`/`makeBuild`/`kernelZipEntries`/`buildKernelManifest`），二进制命名复用 kernel 编译侧 `kernelBinaryName`。
- 影响范围：`scripts/publish-kernel.ts`（新增）、`scripts/publish-kernel.test.ts`（新增）；测试：4 pass（platformFor 映射 / makeBuild / kernelZipEntries 三件套 / buildKernelManifest 全字段）。

## 2026-08-24 — fix(desktop/node): 首启下载的 node 的 npm/npx/corepack 符号链接指向临时解压目录，清理后变 broken 导致 MCP 报 Executable not found: npx

- 背景：打包版首启下载 node 到 ~/.pi/agent/node/（node-runtime.cjs 用 fsp.cp 递归复制解压目录）。fsp.cp 把 node 安装里的 npm/npx/corepack 相对符号链接重写成指向源临时解压目录（os.tmpdir()/wa-pi-node-extract-*）的绝对路径；该临时目录在 finally 被删除后，~/.pi/agent/node/bin/{npx,npm,corepack} 全变 broken 符号链接 → MCP 服务器（command: npx）启动时报 "Executable not found in $PATH: npx"。node 本体是真实二进制故可用，npm/npx 失效。
- 修复：node-runtime.cjs 复制 node 后，对 bin/ 下 npm/npx/corepack 符号链接重写为 nodeDir 内相对路径（../lib/node_modules/...），不再依赖临时目录；保证重启/清理后 npm/npx 仍可用。
- 影响范围：packages/desktop/src/util/node-runtime.cjs；验证：node-runtime/runtime-bin 测试 22 pass；typecheck 干净。

## 2026-08-24 — chore(deps): 升级 Pi 扩展依赖 + 打包/安装版本单一来源化（自动跟随依赖升级）

- 背景：wa-pi 运行时依赖清单（build-kernel-sidecar.ts / kernel-compile-it.ts 的 RUNTIME_DEPENDENCIES）在__两处硬编码版本串__（pi-coding-agent ^0.84.2 / keyring ^1.3.0 / pi-web-access ^0.19.0 / pi-mcp-adapter 2.17.0），升级依赖时常漏改导致打包产物与声明不一致。
- 升级：kernel package.json —— @amaster.ai/pi-memory ^0.1.8→^0.1.9、pi-web-access ^0.19.0→^0.24.2（入口仍为 ./index.ts，extensions 断言不破）；新增 @napi-rs/keyring ^1.3.0 作为直接依赖（此前仅存在于 RUNTIME_DEPENDENCIES，无任何 package.json 声明）。
- 单一来源化：buildRuntimeManifest / kernel-compile-it 的 RUNTIME_DEPENDENCIES 改为从 packages/kernel/package.json 读取版本（新增 kernelRuntimeDependencies 函数），删除两处硬编码——以后升级依赖只改 package.json，打包/安装自动跟随，无需手动同步版本串。
- 移除 MCP OAuth 授权/清除授权 → pi-mcp-adapter 2.17→2.27 免 patch：2.27 的 exports 不再暴露 ./mcp-auth.ts（公开入口 . / ./oauth 也未导出 auth API），若保留 wa-pi 对 mcp-auth.ts 的深导入会解析失败、必须重做 patch。故移除 wa-pi 的 MCP OAuth「授权/清除授权」功能（McpOAuthConfig / McpClearAuthEvent / clearAuth / needs_auth / 前端授权与清除授权按钮 / 相关测试），MCP 保留连接测试 testConnection、工具列举 listTools、静态 token（headers.Authorization，McpForm 的 auth 输入框）。pi-mcp-adapter 升到 ^2.27.0（此时 import 已移除，无需 patch），删除 patches/pi-mcp-adapter@2.17.0.patch、清空根 patchedDependencies。
- 影响范围：packages/kernel/package.json、packages/shared/src/{mcp.ts,types.ts}、packages/kernel/src/{mcp-connector,ws-server,routes/mcp}.ts、packages/frontend/src/{store/mcp.ts,components/mcp/{McpCard,McpPage}.tsx,i18n/locales/{en,zh}.ts}、对应测试（mcp-connector/store-mcp/McpCard/mcp-store/routes-mcp）；packages/desktop/scripts/build-kernel-sidecar.ts、scripts/kernel-compile-it.ts、packages/desktop/tests/build-kernel-sidecar.test.ts（版本单一来源化）；验证：kernel/shared/frontend typecheck 干净，kernel mcp 27 pass + frontend mcp 24 pass。

## 2026-08-24 — fix(kernel/子代理): 手改 providers.json 后子代理仍读旧 contextWindow（派发前 mtime 兜底重生成 provider-extension）

- 背景：子代理（跟随主模型的 pi 子进程）加载的模型元数据（contextWindow/maxTokens）来自启动时生成的 `provider-extension.ts`。该文件只在「启动时（index.ts ensureProviderExtensionRegistered）」与「UI provider:save」时重生成；若用户__直接手改 `providers.json`__（绕过 UI 保存），`provider-extension.ts` 不会自动刷新，子代理仍按旧的 contextWindow 处理上下文。当模型 ID 不在 pi SDK 内置目录（如自定义 `deepseek-v4-flash-vision-exp`）时，`--model` 只能靠 extension 注册的元数据，手改配置不生效、需重启。
- 修复：新增 `isProviderExtensionStale(providersFile, extensionPath)`（mtime 比对：providers.json 不早于 extension 即视为过期），在 subagent 派发前 `ensureExtension`（agent-manager.ts）接入——`stale` 与「extension 不含所需 slug」并列为重生成条件。手改 `providers.json` 后下一次 delegate 前自动重生成 `provider-extension.ts`，子进程即读到最新 contextWindow，无需重启。
- 影响范围：`packages/kernel/src/provider-extension.ts`（新增 `isProviderExtensionStale`）、`packages/kernel/src/agent-manager.ts`（ensureExtension 加 mtime 判定 + import PROVIDERS_FILE）；测试：`tests/provider-extension.test.ts` 补 5 例（providers 更新→stale / extension 更新→非 stale / providers 缺失→false / extension 缺失→true / mtime 相同→true），35 pass；typecheck 干净。

## 2026-08-23 — fix(frontend/会话): 新建会话首次发送后 session 短暂消失导致对话区空白/重置

- 背景：快速「新建会话→发送消息」时，新会话页面会闪一下被重置（对话区空白/回到新建页）。根因是前端__整表替换 `sessions`__ 的两条路径都可能在 kernel `projects:list` **快照滞后**（新会话 optimistic `addSession` 后 placeholder 未转正、快照里还没它）时，把乐观新建的当前会话挤掉，导致 `SessionView` 的 `sessions.find(x.id === sessionId)` 找不到该会话 → `if (!session) return null` → 对话区空白。此前 `0c1ee7a66` 只保护了 `currentSessionId`（避免闪回新建页），`defb8256d` 只修了 #300 崩溃（move hooks），均未修「会话从列表消失」这一根因。
- 修复：抽取共享 `mergeSessions`，`setAll`（SSE `projects:list` 事件）与 `load()`（启动/重连拉快照）两条整表替换路径统一复用——仅把「`currentSessionId` 指向但快照缺失」的会话合并回 `sessions` 列表，其余严格以 kernel 快照为准（真删除由删除 handler 显式 `setCurrentSessionId(null)`，不会被复活）。
- 测试钩子：`events.ts` 在 dev 环境（`import.meta.env.DEV`）把 `emitEventForTesting` 挂到 `window.__PI_E2E_EVENT__`，供 E2E 用 `page.evaluate` 在乐观会话已建立后精确注入滞后 `projects:list` 帧；生产构建不挂载、不污染全局。
- 影响范围：`packages/frontend/src/store/projects.ts`（新增 `mergeSessions` + 改造 `setAll`/`load`）、`packages/frontend/src/events.ts`（dev 测试钩子）；测试：`tests/store-projects.test.ts` 补 3 例（setAll 快照滞后保留当前 / setAll 不复活已删 / load 快照滞后保留当前），13 pass；新增 `e2e/session-lag-snapshot.spec.ts` 回归（注入滞后帧后会话仍在、不空白），已验证：修复前该 spec 红（session-view 消失、复现空白）、恢复修复后绿；全量前端 1868 pass；typecheck 干净。

## 2026-08-23 — fix(desktop/启动): dev 模式误杀生产进程（端口自愈 + 登记簿清扫都改为 dev 不碰占用者）

- 背景：`bun run dev:desktop`（`electron .`）启动时会把正在运行的__生产 wa-pi 实例杀掉__。根因两处：
  - ① whenReady 自愈块：`isPortInUse(FIXED_PORT=9778)` 为真时调 `killPortOccupants(9778)`，按端口盲杀——生产 kernel 正监听 9778，被当占用者 `taskkill /T /F`。
  - ② 启动清扫 `sweepRegistry`：无条件执行，其 `isOurs` 三重校验（进程存活 + 创建时间一致 + exe/路径含 wa-pi-kernel 或 `~/.pi/agent`）无法区分 dev 与生产——两者同在 `~/.pi/agent` 数据目录、同 exe 特征、生产进程仍存活且创建时间一致，必然被当"上轮残留"杀掉。
- 改动（`packages/desktop/src/main.cjs`）：dev 模式（`!app.isPackaged`）下端口自愈不再杀进程，直接复用已有「换端口启动」路径（`selfHealFailed` → `autoSwitchPortAndRelaunch`，自动找下一个可用端口 relaunch，不动占用者）；启动清扫 `sweepRegistry` 在 dev 下整体跳过，打包版（`app.isPackaged`）行为不变。崩溃重启清理（`kernel-sidecar.cjs`）是「清理自己启动的 kernel 残留」，属于合理路径，未门控。
- 影响范围：`packages/desktop/src/main.cjs`；相关 util 测试（process-registry / port-switch / port.cjs / startup-heal）63 pass 未受影响。

## 2026-08-23 — fix(多模态): 模型设置的「图片」开关真正生效（此前仅展示，不改变生成 input）

- 背景：选择支持视觉的模型后输入图片，LLM 仍收不到图片（被降级为 `(image omitted)`）。图片转 base64、拼进 user content 的链路正常（2026-08-19 已修），断点在模型侧：pi 引擎用 `model.input.includes("image")` 裁决图片是否进请求，而 `provider-extension.ts` 生成模型代码时 `input` 只取 pi SDK 目录值（`sdk?.input ?? ["text"]`），完全忽略用户在页面勾选的「图片」（`supportsVision`）开关。当模型 ID 不在目录里（自定义 vision 变体，如 `deepseek-v4-flash-vision-exp`）时落死 `["text"]`，图片被降级。
- 修复：`provider-extension.ts` 生成 `input` 时，若用户显式设置了 `supportsVision` 则以用户意图为准——`true` 时确保含 `"image"`（目录已有则不重复添加），`false` 时剔除 `"image"`；未设置（`undefined`）时仍跟随目录默认（行为不变，防回归）。
- 影响范围：`packages/kernel/src/provider-extension.ts`；测试：`tests/provider-extension.test.ts` 补 4 例（目录无模型+vision=true→含image / 目录已含image不重复 / vision=false剔除image / 未设置跟随目录默认），35 pass；相关 ws-provider-dirty、provider-store、extensions 测试 12 pass；typecheck 干净。

## 2026-08-23 — feat(多模态): 超过单张上限（3.5MB）且 ≤30MB 的图片用 bun:image 压缩为 webp 内联

- 背景：图片超过单张 3.5MB 上限 / 累计 10MB 上限时直接降级为附件（`@路径` 引用），模型收不到像素。发送较清晰的截图、照片（3.5MB~30MB）不应直接放弃多模态，可先压缩再内联。
- 修复：`agent-manager.ts` 新增 `compressImageToSize`（bun:image）：把宽缩到 ≤4096 后 webp 编码，逐级降质量（85→60）+ 按 0.7 等比缩小，最多 6 轮，目标压到 ≤ min(3MB, 单张预算)。`readImageContent` 对「超单张上限但 ≤30MB 的位图」（png/jpg/jpeg/gif/webp/bmp）先尝试压缩再内联（mimeType 变 image/webp）；svg/ico 不压缩；超过 30MB 或压缩失败或预算 <1MB 时仍降级为附件。
- 影响范围：`packages/kernel/src/agent-manager.ts`（新增 compressImageToSize + 改造 readImageContent）；测试：`tests/agent-manager.test.ts` 补「超3.5MB≤30MB压缩为webp内联 + 解码字节≤3MB」「超30MB直接降级」2 例，112 pass；typecheck 干净。

## 2026-08-22 — v0.2.19 win 交叉编译重打覆盖

### 发版

- win 更新源用最新 master 代码（含引导队列修复）重新打包覆盖：mac 上经 bun --compile --target=bun-windows-x64 交叉编译 WaPiKernel.exe（bun ≥1.4 支持，首次自动下载 Windows runtime），electron-builder 出 NSIS 安装包后 publish-oss 上传 R2。
- 影响范围：packages/kernel/scripts/compile-binary.ts（buildCompileArgs/kernelBinaryName 支持 target）、packages/desktop/scripts/build-kernel-sidecar.ts（移除本机编译限制，target 透传）、packages/kernel/tests/compile-binary.test.ts（交叉编译参数断言）；验证：compile-binary 6 pass、build-kernel-sidecar 2 pass、pack:win 产物 PE32 验证 + 线上 latest.yml sha512 已更新。

## 2026-08-22 — v0.2.19 mac 补发 + mac 签名修复

### 发版

- mac 更新源 0.2.15 → 0.2.19：打包 mac dmg/zip 并上传 R2（latest-mac.yml 指向 0.2.19）；win 已在上次 0.2.19 发版上线，本次不变。
- 影响范围：packages/desktop/release/、publish-oss 上传；验证：全量回归 + pack:mac + dmg 内 app codesign 验证通过。

### 修复

- **mac 签名一直静默失败**（线上 0.2.15 mac 包也是未签名）：`mac-sign.cjs` 的 `hasCert()` 用 `security find-certificate` 的 exit code 判断证书存在，但 macOS 上无匹配时 exit code 仍为 0 → 误判证书存在 → 用不存在的证书名签名必失败。修复：改用 `-p` 输出 PEM 内容判断（含 BEGIN CERTIFICATE 才算存在），测试同步改为 mock PEM 输出（hasCert 3 例 + resolveIdentity 覆盖）。
- **mac 自签名证书缺失**：登录钥匙串无「WA PI Agent Self-Signed」证书 → 新建构建钥匙串 `wa-pi-build.keychain-db` 并导入自签名证书（p12 备份于 `~/.config/wa-pi/certs/`），codesign 授权后 afterPack 签名成功；同时清理登录钥匙串里的重复证书项（曾致 codesign 身份解析冲突 errSecInternalComponent）。
- **portableBashExe 测试平台断言修正**：Windows 路径断言在 POSIX 上因 join 分隔符差异失败，期望值改用 join 计算，跨平台成立。

- 影响范围：packages/desktop/scripts/mac-sign.cjs、packages/desktop/tests/mac-sign.test.ts、packages/kernel/tests/bash-runtime.test.ts；验证：kernel/bash-runtime 6 pass、desktop/mac-sign 12 pass、全量回归 kernel+shared 128+desktop 191+frontend 1865 全绿。

## 2026-08-22 — fix(引导队列): 多条引导时第一条发送后待引导消息不更新

- 修复：会话有多条引导/排队消息（followUp）时，点第一条消息的「引导」或「立即」发送后，顶部「待引导消息」队列保持不变（已发送的第一条又出现在队列里，队列未减）。根因：`steerMessage` 的 `!handle.busy`（空闲直发）分支直接 `_sendPromptNow` 发送后 return，未从 `followUpList` 移除该条、也不广播 `queue_update`；而前端 `handlePromote`/`handleImmediate` 已乐观把该条从队列移除。前端与 kernel 队列状态分歧后，后续任一 `queue_update` 广播（drain/prompt/settled）用含该条的旧队列覆盖前端，导致「引导后队列不变」。
- 修复：`steerMessage` 空闲直发分支与 busy 分支对齐——`_sendPromptNow` 成功后从 `followUpList` 移除同文本条目并 `_emitLocalQueueUpdate` 广播同步前端（先发送成功再移除，避免发送失败时消息已出队丢失）。
- 影响范围：`packages/kernel/src/agent-manager.ts`（steerMessage 空闲直发分支）；测试：`tests/agent-manager.test.ts` 补「空闲直发移除已排队同文本 + 广播」回归 1 例（110 pass）；typecheck 干净；kernel 全量 1365 pass（2 例 browser 集成测试并发超时，与本次无关，stash 对比确认）。

## 2026-08-22 — fix: 排队/引导消息未发送且队列悬挂（netDegraded 死锁 + busy 竞态）

### 修复

- 修复两个导致「对话中发送的排队/引导消息在本轮结束后未发出，且一直挂在聊天窗顶部队列面板」的缺陷：
  1. **netDegraded 永久卡死**：transient 网络错误（超时/限流/5xx）后 `markNetDegraded(true)`，`agent_settled` 跳过 followUp/steer drain（避免网络不可用时自动发送再次失败），但该标记__只靠用户重发（_sendPromptNow 成功）清除__——用户若不再发新消息（排队消息仍等自动发出），netDegraded 永久为 true，后续所有 settled 都跳过 drain，消息永不发出且队列残留。修复：`agent_start`（新一轮开始）时清除 netDegraded（新一轮说明网络可能已恢复），恢复后续 settled drain。
  2. **busy 竞态致直发不入队**：`am.prompt()` 在多个 await（_resolveModel/setModel/setThinkingLevel/buildPromptContent）之后才检查 `handle.busy`，若这期间本轮已 `agent_settled`（busy 翻 false），消息被 `_sendPromptNow` 直发而非 `followUpList.push`，且直发路径不发 `queue_update` → 前端 isRunning 时乐观入队的显示无人清，队列残留。修复：prompt 决定直发（!busy）后补发 `_emitLocalQueueUpdate`，让前端同步真实队列，清乐观残留。

- 影响范围：`packages/kernel/src/agent-manager.ts`（agent_start 清 netDegraded + prompt 直发补 queue_update）；测试：steer-queue-poc.test.ts 补修复A/B 两例（23 pass）；kernel 相关回归 agent-manager/idle-reap 112 pass、ws-agent-prompt-echo/steer-title-fill 8 pass、channel-manager/reply-composer/composer-attachments/pi-disconnect 54 pass + typecheck 干净。

### 修复

- 修复「系统设置→模型管理」编辑当前聊天窗正在使用的模型、修改 model id 并保存后回到聊天窗的两类异常：
  1. 发送按钮静默置灰（前端悬空引用）：聊天窗当前模型存于 composer-prefs 的 `bySession[sessionId].model`（"slug/旧id" 字符串快照），改 id 后 providers 变成 "slug/新id"，`isModelAvailable` 变 false → 发送按钮禁用，且 ModelSelector 的「按 id 兜底重钉」无法命中（id 本身已变）。修复：新增 `clearStaleModels(providers)`，在 `provider:changed` 时把失效的会话级 + 默认模型引用清 null，让用户看到「未选择模型」占位并重选，而非静默卡死。
  2. 能发送但后端报「Model not found」（热重载不重读 -e）：`provider:save`/`provider:delete` 原调 `markAllDirty()`（dirty 集合 → `reloadExtensions` 热重载），但 provider-extension.ts 经 -e 参数在 pi 进程 spawn 时固化，`session.reload()` 不重读 -e → 运行中的 pi 进程仍持旧模型注册表，`setModel(新id)` 报 Model not found。修复：新增 `markProvidersDirty()` 走 skillDirty 集合（整进程重建 `_rebuildSession`），与 skill 变更同理（-e/--skill 固化只能重启刷新）；provider:save/delete 改调之。

- 影响范围：`packages/frontend/src/store/composer-prefs.ts`（clearStaleModels）、`packages/frontend/src/App.tsx`（provider:changed 联动清除）、`packages/kernel/src/agent-manager.ts`（markProvidersDirty）、`packages/kernel/src/ws-server.ts`（provider:save/delete 改走重建）；测试：composer-prefs 补 clearStaleModels 3 例（25 pass）、agent-manager 补 markProvidersDirty 整进程重建 1 例 + ws-provider-dirty 断言改 markProvidersDirty（3 pass）；kernel 全量 1362 pass（2 例 channel-manager 全量并发 flaky，单独跑全绿）；前端/后端 typecheck 干净。

## 2026-08-22 — v0.2.19 发版

### 发版

- 版本 0.2.18 → 0.2.19（并行插件安装串行化修复——EBUSY/ENOENT）。
- RELEASE_NOTES.md / version-history.json 已更新；线上 win 更新源 latest.yml 指向 0.2.19（mac 保持 0.2.15）。
- 影响范围：packages/desktop/package.json、packages/frontend/package.json、packages/desktop/RELEASE_NOTES.md、packages/frontend/src/data/version-history.json；验证：全量回归 + pack:win + publish-oss 上传 R2。

## 2026-08-22 — 并行插件安装串行化（EBUSY/ENOENT）

### 修复

- 并行安装多个插件报 EBUSY/ENOENT（failed copying files from cache）：NpmPackageService 无串行机制，多个 extension:install 并发触发多个 bun add 同时写同一 node_modules + 读同一 bun 缓存 → Windows 文件锁冲突（EBUSY）+ 缓存竞态（ENOENT）。修复：spawn 排队串行（opQueue/enqueue，任一时刻最多一个 bun 子进程）。影响范围：`packages/kernel/src/npm-package-service.ts`（spawn 串行队列）、`packages/kernel/tests/npm-package-service.test.ts`（+1 用例：fake-bun 记录并发峰值断言 =1）；验证：npm-package-service 20 pass、kernel 全量无新增失败。

## 2026-08-22 — v0.2.18 发版

### 发版

- 版本 0.2.17 → 0.2.18（会话级浏览器自动化工具 browser_* 全量上线 + 插件安装修复 + 页面媒体静音 + bash 报错恢复上游原始提示）。
- RELEASE_NOTES.md / version-history.json 已更新；线上 win 更新源 latest.yml 指向 0.2.18（mac 保持 0.2.15）。
- 影响范围：packages/desktop/package.json、packages/frontend/package.json、packages/desktop/RELEASE_NOTES.md、packages/frontend/src/data/version-history.json；验证：全量回归全绿（kernel 1361 + frontend 1862 + desktop 166 + shared 128）+ pack:win + publish-oss 上传 R2。

## 2026-08-22 — 插件安装修复（编译产物当 bun CLI）

### 修复

- 插件安装失败根因：打包环境 NpmPackageService 用 process.execPath（编译产物 WaPiKernel.exe）执行 bun add，spawn env 未显式带 BUN_BE_BUN=1 → 编译产物不执行 add 而是启动内嵌 kernel（cwd=npm 目录 → loadCatalog 解析 pi-ai 失败 + 主 kernel 占 9778 → EADDRINUSE）→ 安装失败。修复：spawn 显式传 `env: { ...process.env, BUN_BE_BUN: "1" }`（不依赖继承链）。影响范围：`packages/kernel/src/npm-package-service.ts`（spawn env + 空 catch 注释）、`packages/kernel/tests/npm-package-service.test.ts`（+1 用例断言 spawn env 含 BUN_BE_BUN）；验证：npm-package-service 19 pass、kernel 全量无新增失败。

## 2026-08-22 — v0.2.17 发版

### 发版

- 版本 0.2.16 → 0.2.17（Windows 无 Git Bash 场景修复：自动下载 PortableGit 接线 shellPath + bash 报错友好化）。
- RELEASE_NOTES.md / version-history.json 已更新；线上 win 更新源 latest.yml 指向 0.2.17（mac 保持 0.2.15）。
- 影响范围：packages/desktop/package.json、packages/frontend/package.json、packages/desktop/RELEASE_NOTES.md、packages/frontend/src/data/version-history.json；验证：全量回归 + pack:win + publish-oss 上传 R2 + 阿里云 OSS。

## 2026-08-22 — Windows 无 Git Bash 场景修复（shell 工具）

### 修复

- bash 工具报错友好化：pi 引擎在 Windows 找不到 Git Bash 时抛 "No bash shell found"（面向 VS Code 的误导文案）——kernel 消息流检测并替换为中文引导（装 Git for Windows 或配置 shellPath）。影响范围：`packages/kernel/src/sdk-errors.ts`（friendlyShellUnavailable/applyFriendlyShellMessage）、`packages/kernel/src/agent-manager.ts`（message_end 消息接入）；测试 sdk-errors +3 例。
- Windows 自动提供 bash（B-1）：agent shell 工具依赖 Git Bash，没装 Git 的电脑上必现报错——新增 `packages/kernel/src/bash-runtime.ts` 检测系统 bash，无则从 npmmirror 镜像下载 PortableGit（~64MB，GitHub 回退）解压到 %LOCALAPPDATA%\wa-piash 并接线 settings.json.shellPath（pi 引擎读取生效）；同时把 usr/bin 注入进程 PATH（MSYS2 DLL 依赖）。启动异步不阻塞，下载完成前由友好提示兜底。影响范围：bash-runtime.ts（新）、settings-store.ts（loadShellPath/saveShellPath）、index.ts（startKernel 接线）；测试 bash-runtime 6 例 + settings-store 2 例；端到端验证下载→解压→bash --version 5.2.37 通过。

## 2026-08-22 — v0.2.16 发版

### 发版

- 版本 0.2.15 → 0.2.16（kernel 单二进制编译 + 入口统一 + BUN_BE_BUN 修复 + 浏览器预览交互优化 + 盘符路径胶囊）。
- RELEASE_NOTES.md / version-history.json 已更新；线上 win 更新源 latest.yml 指向 0.2.16（mac 保持 0.2.15，本机无法产出 mac 包）。
- 影响范围：packages/desktop/package.json、packages/frontend/package.json、packages/desktop/RELEASE_NOTES.md、packages/frontend/src/data/version-history.json；验证：全量回归 + pack:win + publish-oss 上传 R2。

## 2026-08-22 — kernel 编译产物启动修复（真实打包验证）

### 修复

- 编译产物 spawn 时剔除 BUN_BE_BUN：宿主/系统环境若带 BUN_BE_BUN=1（如 wa-pi 宿主 Bun 环境），编译产物会充当 bun CLI（打印 usage 后 code=0 退出）而非运行内嵌 kernel——sidecar spawn env 显式剔除，子进程需要当 CLI 的场景（install、wrapper）各自显式设置。
- build.ts run() 用 process.execPath 替代 PATH 解析 bun：Windows 下 shell 环境 PATH 可能不含 bun 目录，spawnSync("bun", shell:true) 报 "The system cannot find the path specified"，与 build-kernel-sidecar.ts 的 run 同款处理。
- 影响范围：packages/desktop/src/kernel-sidecar.cjs、packages/desktop/scripts/build.ts、packages/desktop/tests/kernel-sidecar.test.ts（+1 用例）；验证：kernel-sidecar 15 pass、desktop 全量 188 pass、真实打包+安装+首启+聊天到「未选择模型」+老用户升级遗留清理全通过。

## 2026-08-22 — fix(前端): 会话短暂消失触发 React #300 崩溃白屏

- 修复：发送/接收消息时界面崩溃白屏，报 Minified React error #300（Rendered fewer hooks than expected）。根因：`SessionView` 的 `if (!session) return null` 之后仍有 `useExplorerStore` 两条 Hook——kernel 广播 `projects:list` 快照滞后（新会话乐观添加后 placeholder 尚未转正）时，`setAll` 替换 sessions 数组但防御逻辑保留 `currentSessionId`，App 仍渲染 SessionView 而 `session` 暂时为 undefined，两次渲染 Hook 数量 16→14 触发 #300 崩溃。
- 修复：把两条 `useExplorerStore` 移到 early return 之前，与文件内既有注释承诺的「hooks 必须在 early return 之前调用」模式对齐；session 在/不在时 Hook 数量恒定。
- 影响范围：`packages/frontend/src/components/SessionView.tsx`；测试：`tests/SessionView.test.tsx` 补 2 条回归用例（会话消失不抛 #300 + 会话恢复正常渲染），37 pass；全量前端 1858 pass（3 条既有 AttachmentChip emoji 断言失败，与本次无关）；typecheck 干净。

## 2026-08-22 — kernel 单二进制编译 + 入口统一

### 重构

- kernel 打包形态：「下载 bun + 解释运行 kernel.js」→「bun --compile 单二进制 WaPiKernel(.exe)」
  - 打包：`build-kernel-sidecar.ts` 删除 bun 下载全套逻辑（GitHub/npmmirror 硬依赖消除），改调 `packages/kernel/scripts/compile-binary.ts`（`bun build --compile --external @napi-rs/keyring --asset <bridge 三文件>`）；运行时依赖清单精简为磁盘必需项（@earendil-works/pi-coding-agent + @napi-rs/keyring，Task 6 审计定稿），删除 patchedDependencies 与 patches/bridge 文件复制（patch 编译期已生效）。
  - 运行时：`runtime-deps.cjs` SEED 精简为 WaPiKernel + package.json + bun.lock，install 子进程加 `BUN_BE_BUN=1`（编译产物充当 bun CLI，首启装依赖零下载），清理 kernel.js 时代遗留文件；`kernel-sidecar.cjs` packaged 分支直接 spawn 编译产物（不再 `run kernel.js`）。
  - 子进程链路：`startKernel` 写入 `process.env.BUN_BE_BUN=1`（pi RPC / bun add / MCP 服务器的运行时都是编译产物，缺了它会再跑内嵌 kernel）；`runtime-bin.cjs` 的 bun/node/npm/npx wrapper 显式带 BUN_BE_BUN=1（POSIX 符号链接改 wrapper 脚本）；`resolvePiCliPath` 加 cwd 回退（编译产物虚拟 FS 解析不到磁盘 node_modules）。
  - 入口统一：三条启动链都走 `desktop-server.ts → startKernel`；`index.ts` 删除 `import.meta.main` 分支；kernel `dev` 脚本改跑 desktop-server.ts；`dev:desktop` 优先 spawn `packages/kernel/dist/WaPiKernel`（缺失回退解释运行并提示先 `bun run --filter @wa-pi/kernel build`）。
  - 进程识别：`process-registry.cjs` exe 特征匹配兼容 WaPiKernel 新名与 wa-pi-kernel 旧名（升级期幽灵进程兜底）。
  - 影响范围：`packages/kernel/scripts/compile-binary.ts`（新）、`packages/kernel/src/{index,desktop-server,rpc-client}.ts`、`packages/kernel/package.json`、`packages/shared/src/runtime-check.ts`、`packages/desktop/scripts/build-kernel-sidecar.ts`、`packages/desktop/src/{kernel-sidecar,main}.cjs`、`packages/desktop/src/util/{runtime-deps,runtime-bin,process-registry,port,node-runtime,paths}.cjs`、`scripts/kernel-compile-it.ts`（新）；测试：compile-binary 5 例、build-kernel-sidecar 1 例、runtime-deps 3+1 例、kernel-sidecar +3 例、runtime-bin +2 例、runtime-check +2 例、rpc-client +1 例全绿；集成测试 `bun run scripts/kernel-compile-it.ts` 通过（compile → BUN_BE_BUN install → 净化 PATH spawn → agent:prompt 到「未选择模型」）。

## 2026-08-22 — kernel 单二进制编译（BUN_BE_BUN 运行时链路）

### 新增

- BUN_BE_BUN=1 运行时链路：bun --compile 编译产物默认运行内嵌 kernel，只有 BUN_BE_BUN=1（bun 1.2.16+）才充当 bun CLI。打包环境下 pi RPC 子进程、NpmPackageService 的 bun add、MCP 服务器（npx/bun wrapper）的运行时都是编译产物（process.execPath 或 runtime-bin 链接），缺了会再次启动内嵌 kernel 而非执行目标命令。
  - 实现：`packages/shared/src/runtime-check.ts` 新增 `ensureBunBeBunEnv()`（幂等：仅未设置时写入 BUN_BE_BUN=1）；`packages/kernel/src/index.ts` startKernel() 在 assertBunVersionOrExit 后调用（子进程继承）；`packages/desktop/src/util/runtime-bin.cjs` Windows 分支所有 .cmd 加 `set BUN_BE_BUN=1`，POSIX 分支 bun 符号链接改 wrapper 脚本（符号链接无法携带 env）、无 node 时 node/npx/npm 改 wrapper 并加 env 前缀，文件头注释 wa-pi-kernel → WaPiKernel。
  - 影响范围：packages/shared/src/runtime-check.ts、packages/shared/tests/runtime-check.test.ts、packages/kernel/src/index.ts、packages/desktop/src/util/runtime-bin.cjs、packages/desktop/tests/runtime-bin.test.ts；验证：shared runtime-check 17 pass、desktop runtime-bin 7 pass、desktop 全量 181 pass（1 既有 ditto 平台失败）、kernel 全量 1258 pass（1 既有 commonRoot 失败）。

- kernel 编译产物全链路集成测试（固化 POC + 运行时依赖审计）
  - `scripts/kernel-compile-it.ts`：bun --compile 编译 → BUN_BE_BUN=1 装磁盘依赖 → 净化 PATH spawn 编译产物（强制 resolvePiRuntime 回退 process.execPath，复现打包环境）→ REST+SSE agent:prompt 到「未选择模型」终点。审计方法：probe 报 Cannot find module <pkg> → 补清单重跑，直到收敛。
  - 运行时依赖清单定稿（build-kernel-sidecar.ts / 集成脚本两处同步）：{@earendil-works/pi-coding-agent ^0.84.2（pi RPC 子进程入口）、@napi-rs/keyring ^1.3.0（原生 .node external）、pi-web-access ^0.19.0、pi-mcp-adapter 2.17.0（内置扩展 PKG_EXTENSIONS，pi 子进程经 -e 从磁盘加载 index.ts）}；EXTERNAL_PACKAGES 维持仅 @napi-rs/keyring。
  - 修复编译产物虚拟 FS 解析断点（createRequire(import.meta.url) 指向 B:\~BUN\root，解析不到磁盘 node_modules）：resolvePiCliPath（rpc-client.ts）、resolveExtensionEntryFile（extensions.ts）、loadCatalog（pi-catalog.ts）三处统一加 cwd 回退；stageAssetDir（compile-binary.ts）改返回字面 `assets` 子目录——bun 1.4.0 --asset 按目录名挂载到虚拟根，mkdtemp 随机名导致 bridge 三文件嵌入后运行时找不到（集成测试首次运行 ENOENT 暴露）。
  - 影响范围：scripts/kernel-compile-it.ts（新增）、packages/kernel/src/rpc-client.ts、packages/kernel/src/extensions.ts、packages/kernel/src/pi-catalog.ts、packages/kernel/scripts/compile-binary.ts、packages/kernel/tests/bridge.test.ts、packages/kernel/tests/compile-binary.test.ts、packages/desktop/scripts/build-kernel-sidecar.ts、packages/desktop/tests/build-kernel-sidecar.test.ts；验证：集成测试 ✅（compile → install 327 包 → spawn → agent:prompt → 未选择模型，无 Cannot find module / ENOENT）、kernel 全量 1259 pass（1 既有 commonRoot 失败）、desktop 全量 187 pass（1 既有 regenerateBlockmap 失败）。

## 2026-08-22 — test: 补 browser_* 工具可见性控制验证测试（零新机制）

- 新增：命名智能体 browser_*默认开（DEFAULT_AGENT_TOOLS 已含 → listGlobalTools 自动列出 → ToolsTab 自动出现 4 个开关，`tools: []` = 全量默认 = 默认开，取消勾选转显式白名单即关闭）；只读内置子智能体（Explore/Plan）默认关（agent-manager.ts 硬编码白名单 read/bash/grep/find/ls 天然不含 browser_*）。
- 落点为 3 个验证型测试：kernel `listGlobalTools` 断言含 4 个 browser_*（source='内置'）；只读内置子智能体 spawn 配置 tools 白名单逐字等于 [read,bash,grep,find,ls] 不含 browser_*；前端 ToolsTab 渲染 4 个 browser_* 开关且默认勾选、点掉后 draft.tools 转显式白名单不含该项。
- 影响范围：`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/agent-manager-subagent-overrides.test.ts`、`packages/frontend/tests/AgentConfig.test.tsx`（零生产代码改动）。
- 验证：kernel 112 pass；前端 AgentConfig.test.tsx 32 pass 全绿。

## 2026-08-22 — test(kernel): Layer 4 E2E（真实 bridge 链路 + 白名单验证）

- 新增：`packages/kernel/tests/browser-e2e.test.ts`。真实链路 E2E：起真实 WSServer + 真实 AgentManager（不注入 NOOP_BROWSER_MANAGER，走生产默认 `new BrowserManager()`），`ensureStarted` 会话后加载真实扩展源码配 env，4 个 browser_*工具 execute 经真实 HTTP POST /bridge/tool 到 kernel，完整走 browser_navigate（data: URL）→ browser_evaluate（读 h1）→ browser_screenshot（path 模式，断言落在 `${WA_PI_DIR}/tmp/browser-screenshots` 且文件非空）→ browser_close；引擎不可用时探测 skip 不算失败。白名单验证：agent tools 显式白名单不含 browser_* 时 `--tools` 不含 4 个 browser_*（read/bash 保留），反向含 browser_navigate 时 `--tools` 含之（NOOP_BROWSER_MANAGER，不测真实浏览器）。测试截图/临时文件含失败路径全部清理。
- 影响范围：`packages/kernel/tests/browser-e2e.test.ts`（新建，3 用例）。
- 验证：真实链路 1 pass（本机引擎可用）+ 白名单 2 pass = 3 pass / 0 fail / 40 expect；bridge/agent-manager/browser 相关回归 154 pass 全绿；kernel typecheck 通过。

## 2026-08-22 — fix(kernel): BrowserManager 默认 WebView 工厂补传 backend:"chrome" + Layer 3 真实引擎集成测试

- 修复：默认 viewFactory `new Bun.WebView(o)` → `new Bun.WebView({ ...o, backend: "chrome" })`。真实 API 差异（bun-types@1.4.0）：构造 backend 默认 "webkit" 仅 macOS 可用，非 macOS 平台不传会直接构造抛错；显式传 "chrome" 后自动探测本机 Chrome/Chromium/Edge，跨平台可用。
- 新增：`packages/kernel/tests/browser-real-engine.test.ts`（Layer 3）用真实 Bun.WebView 走 handleBrowserTool 完整工具路径（navigate → evaluate eval/click → screenshot path → close），直接验证 WebViewLike 假设签名与真实引擎匹配；引擎不可用时 test.skip 跳过并标注（不算失败）。实测确认 WebViewLike 与真实 API 仅构造 backend 一处差异，其余签名全部一致。
- 影响范围：`packages/kernel/src/browser-manager.ts`（默认工厂一行）、`packages/kernel/tests/browser-real-engine.test.ts`（新建，2 用例）。
- 验证：真实引擎全链路 2 pass（本机 Windows 引擎可用）；browser 相关回归 20 pass；kernel typecheck 通过；全量套件除既有 Windows 平台失败 commonRoot 外全绿。

## 2026-08-22 — feat(kernel): AgentManager 接线 browser_* 工具（browserManager 注入 + handleTool 分派 + 生命周期）

- 新增：`AgentManagerOpts` 新增可选 `browserManager` 注入（测试注入 fake；生产不传默认 `new BrowserManager()`）；`bridgeCtx.handleTool` 在 memory_ 分支后新增 `tool.startsWith("browser_")` 分支调 `handleBrowserTool`（用 `am.browserManager`，执行逻辑复用既有 browser-tools.ts）；`_teardownSession` 开头随会话销毁 `browserManager.closeSession(sessionId)`（防浏览器进程泄漏），`disposeAll` 末尾 `browserManager.dispose()`（关 sweep 定时器与全部 WebView）。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/tests/browser-tools-bridge.test.ts`（新增 3 例：handleTool 分派 sessionId 正确 / closeSession 随会话销毁 / disposeAll 调 dispose，注入 fake manager）。
- 验证：新测试 3 pass；回归抽样（agent-manager、agent-manager-subagent-overrides、browser-tools、browser-manager）127 pass 全绿。

## 2026-08-22 — feat(kernel): bridge 扩展注册 4 个 browser_* 工具

- 新增：`wa-pi-bridge.extension.ts` 仿 delegate/fleet 注册 browser_navigate / browser_evaluate / browser_screenshot / browser_close 四个工具，DESCRIPTION 与 ParamsSchema 统一来自 shared/tool-schemas.ts（ensureBridgeExtension 运行期连同复制，bridge 侧与 kernel 侧引用同一份定义）；execute 走 callBridge，文件顶部新增 `BROWSER_NAVIGATE_TIMEOUT_MS = 150_000`（navigate 120s + 余量）与 `BROWSER_OPERATION_TIMEOUT_MS = 90_000`（其余操作 60s + 余量）两个超时常量。
- 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`、`packages/kernel/tests/bridge-extension.test.ts`（新增源码级 + loadTools 实际注册断言 7 例）、`packages/kernel/tests/bridge.test.ts`（工具数断言 7→12 同步，im_push_to 排序契约随 ALL_BRIDGE_TOOLS 更新）。
- 验证：bridge 三个测试文件 43 pass；kernel 全量套件除既有 Windows 路径断言 commonRoot（环境性失败，与本改动无关）外全绿。

## 2026-08-21 — fix: Windows 盘符绝对路径（C:/、C:\\）渲染为文件胶囊

- 修复：AI 回复中反引号包裹的 Windows 盘符绝对路径（`C:/Users/.../beautiful.html`）未被识别为文件路径，渲染成普通等宽代码而非可点击文件胶囊（FilePill）。根因：`parseFilePath` 的 `PATH_RE` 只有 Unix 绝对路径（`/`、`~`、`./`）与相对路径分支，无盘符分支；而 `FilePill.resolveAbsolutePath` 早已支持盘符，断点仅在入口判定。
- 顺带修复既有缺陷：绝对路径分支 `[^\s]+` 贪婪吞掉 `:行:列` 后缀且可选组不回溯，导致 `/abs/path.ts:12`、`C:/src/a.ts:12` 的行号从不上屏（与注释承诺不符）；路径主体改 `[^\s:]+` 让后缀正确分离，同时返回时反斜杠归一化为正斜杠。
- 影响范围：`packages/frontend/src/components/blocks/file-path.ts`；测试：file-path.test.ts 补盘符/反斜杠/`:行` 4 断言，FilePill.test.tsx 补 Windows 绝对路径渲染胶囊+点击预览用例（8 pass）。
- 验证：file-path/FilePill/FilePreviewModal/markdown-links/linkify 相关单测 39 pass + typecheck 干净。

## 2026-08-21 — fix: 浏览器预览终审修复波（拖拽渲染性能 / 大文件护栏 / 小项收敛）

- 修复（性能）：浏览器预览拖拽期 60Hz 全树重渲染与同步写盘——`browser` store 持久化改 trailing debounce（每 key 独立 timer，默认 300ms，`setPersistDebounceMs` 可注入，测试置 0 同步写保持确定性）；`SessionView` 用 `React.memo` 包裹（props 不变跳过含 MessageList 的 reconcile）；`BrowserPanel` 整订阅改逐字段 selector（不再随 splitRatio/floatRect 每帧重渲染）。
- 修复（布局）：split 模式聊天侧宽度改 `calc(x% - 2px)`，消除聊天侧+预览侧+分隔条合计 100%+2px 导致预览右缘被裁约 2px。
- 修复（浮动窗）：去掉 FloatWindow 独立标题栏（与 BrowserPanel 工具栏重复两层），改为无标题栏——非交互区域（工具栏空隙等）按住即拖动位置，右下角手柄拖尺寸，缩放手柄 stopPropagation 防止冒泡误触发移动拖拽；关闭/模式切换统一由 BrowserPanel 原工具栏承担。
- 修复（元素选中）：inspect 工具条"选择父级/发送到聊天"点不到——鼠标从元素移向工具条穿过间隙时 mousemove 命中其他元素把选中切走。加粘性区：元素上缘到工具条之间的通道内移动保持当前选中；E2E 补分步移动鼠标路径的回归用例。
- 新增（元素选中）：inspect 工具条按钮左侧显示当前选中元素名（有 id 显示 `tag#id`，否则 `tag.类名`），选择父级时实时更新。
- 修复（元素选中）：选择父级后稍动鼠标选中就被子元素抢回——选择父级后锁定选中（鼠标在锁定元素内部移动不切换，移出才解锁恢复 hover；body 可锁、html 不锁防 hover 失效）。
- 修复（分屏拖拽）：浏览器分屏后右侧文件树面板分隔条拖动跳变——`SidebarResizer` 从绝对坐标（`innerWidth - clientX`，假设面板右缘必在视口右缘）改为增量计算（mousedown 快照起始宽 + 位移增量，新增 `getWidth` prop），与面板在视口中的位置无关；4 个调用点（左侧栏、浏览器分屏、SessionView/NewSessionPane 文件树）同步更新。
- 修复（浮动窗拖拽）：拖动卡顿不跟手、拖着拖着拖不动——① 拖拽中鼠标划入 iframe 后事件被吞（父文档收不到 mousemove/mouseup），导致拖拽卡死与监听器泄漏，改为拖拽期间内容区 `pointer-events: none`；② 拖拽帧路径从「每帧 setState→全树 reconcile」改为拖拽中直接改 DOM style、mouseup 一次性提交 store，消除渲染延迟实现跟手；③ `SidebarResizer` 拖拽期间屏蔽所有 iframe 指针事件（分屏分隔条划过预览 iframe 同样卡死）。
- 新增（浮动窗）：最小化为气泡——工具栏减号按钮（仅浮动模式显示）把浮窗带收缩动画（窗口飞向气泡位置）收成小气泡，气泡带出现/呼吸动画、可拖动停放位置（localStorage 持久化，点击/拖动按 5px 位移阈值区分），点击气泡窗口展开恢复；预览全程保持挂载状态不丢。另修复：地址栏加载本地 html 后切换窗口模式会丢预览内容（地址栏路径同步 store，重挂可恢复；外部网址仍不保留为已知限制）。
- 重构（元素发送）：「发送到聊天」从附件栏 chip 改为输入框__内联 chip__（复用 quick-invoke token 体系，新增元素 token `![路径|起-止行|标签]`）——chip 落在光标处文本流中，发送时 `expandTokens` 内联展开为 `path [line: 起-止] [el: 标签]` 定位文本；消息列表回显时定位文本重新 chip 化（`textToSegments` 识别展开形态）；全屏模式下先自动切回分屏再投递插入。element 附件类型及 kernel 序列化随之移除（shared AttachmentRef/Draft 回退、prompt-attachments 删除、AttachmentChip 图标映射回退）。
- 修复（护栏）：html >10MB 时 /preview 跳过 inspect 注入原样直出、/api/preview-locate 直接返回 nulls（共享常量 `PREVIEW_PARSE_MAX_BYTES`，避免整文件读入内存+全量正则扫描）；/api/preview-locate 限 `.html`/`.htm` 扩展名（不符 400 bad_request）。
- 修复（小项）：`element-pick` 行号接口结果加形状守护（startLine/endLine 均 number|null 才采用，否则按无行号降级）；`iconSvg()` attr 映射补 `strokeDasharray→stroke-dasharray`；`preview-inspect` 注入点正则补已知边界注释（页面 JS 字符串/注释含字面量 `</head>` 时可能注错位置）；prompt-attachments 误导性用例名改「无 cwd 原样输出」。
- 影响范围：`packages/kernel`（ws-server、preview-inspect；集成测试补扩展名 400 + 大文件护栏 3 用例）、`packages/frontend`（store/browser、App、SessionView、BrowserPanel、element-pick、Icon；单测补 debounce 合并与形状守护 3 用例）。
- 验证：kernel 单测 23 pass + typecheck；kernel 集成 preview-inspect 11 pass / preview-route 1 pass（分开跑）；前端单测 44 pass + typecheck；E2E browser-preview.spec.ts 5/5。

## 2026-08-21 — feat: 浏览器预览窗口模式与元素选中（分屏/全屏/浮动 + 元素行号定位发聊天）

- 新增：预览支持与聊天分屏对半（可拖比例）、全屏、浮动窗（可拖位置/尺寸、状态持久化）；本地 html 预览内 hover 高亮元素，可将选中元素（含源码行号定位）以 chip 形式发送到聊天输入框；附件 chip 图标全部 SVG 化。
- 修复：`/api/preview-locate` 被 `/api/` 统一分发遮蔽（HttpRouter 未命中即 404，该分支不可达），元素行号定位从未生效；整块移至 `/api/` 分发之前。`preview-route` 集成断言适配注入分支的 `text/html; charset=utf-8`。
- 影响范围：`packages/kernel`（/preview 注入、/preview-inspect.js、/api/preview-locate、ws-server 路由顺序）、`packages/frontend`（App 布局、BrowserPanel、FloatWindow、element-pick、AttachmentChip/Icon）、`packages/shared`（element 附件类型）；测试：kernel 集成 9 用例（preview-inspect 8 + preview-route 补注入断言）、Playwright E2E 5 用例。

## 2026-08-21 — v0.2.15

### 修复

- browser_* 工具第 1 轮修复：
  - 修复：WebViewLike.click 签名改为兼容 `click(selector, opts?)` 与 `click(x, y, opts?)` 两种形式（原先 1-2 参签名导致坐标 click 调用 tsc 报 TS2554，typecheck 无法通过）。
  - 修复：browser_evaluate eval 结果 8000 字符截断失效（截断作用于局部变量但返回时重新序列化），改为先序列化最终 payload 再截断。
  - 修复：isEngineUnavailable 正则过宽误报，收紧为 spawn/executable 相关的具体签名。
  - 测试：补坐标 click 与超长 eval 截断 2 个用例（browser-tools 11 用例 + browser-manager 6 用例全 PASS）。
  - 影响范围：packages/kernel/src/browser-manager.ts、packages/kernel/src/browser-tools.ts、packages/kernel/tests/browser-tools.test.ts。
- 本地代理中继连接泄漏（bun 1.4 暴露）：隧道/转发一端关闭时另一端残留半关闭连接，`relay.close()` 永远挂起、真实场景连接泄漏。修复 `establishTunnel` 与 `forwardPlain` 双向 pipe 对端清理（client↔outbound 互毁）。
  - 影响范围：`packages/kernel/src/proxy-relay.ts`；验证：net-log 中继日志接入测试 12 用例通过（此前 bun 1.4 下稳定超时）。
- 测试环境耦合修复：`readSystemProxy` 集成测试原断言「返回值不可能是回环地址」，但用户机器开着本地代理（如 Clash 127.0.0.1:7890）时系统代理读到回环地址是合法行为；移除过强断言，回环过滤语义保留在 systemProxyFromEnv 单测。
  - 影响范围：`packages/kernel/src/__tests__/settings-proxy.test.ts`；验证：settings-proxy 24 用例通过。
- kernel 全量测试不再卡死正在运行的正式桌面应用（聊天无响应）
  - 根因：① kernel 全量测试（bun ./scripts/test.ts）与正式应用共享 `~/.pi/agent`（@wa-pi/shared 的 WA_PI_DIR 默认值），15+ 个测试并发读写同一目录（tmp/sysprompts、settings.json、sessions 等）→ 文件竞争；② bun test 默认 --parallel=CPU 核数 + 每文件内 20 并发 + 各测试 spawn 子进程 → CPU 瞬间满载 → 正式 kernel 事件循环被饿死 → 无响应（真实发生，被迫重启应用）。
  - 调整（tests/setup.ts）：preload 强制把 WA_PI_DIR / PI_CODING_AGENT_DIR 指向 mkdtemp 临时目录（可用 WA_PI_TEST_DIR 固定），测试读写的都是隔离数据，spawn 的子进程继承隔离 env；预创建 sessions/tmp/sysprompts 等标准目录。
  - 调整（scripts/test.ts）：全量测试加 `--parallel=4 --max-concurrency=8` 限制 worker 与并发，避免 CPU 满载。
  - 调整（channel-manager.test.ts）：44 处固定 50ms 等待在负载下不够（flaky），放宽到 500ms；「/new 指令」「智能体删除兜底」改为条件轮询。
  - 调整（ws-extension-skill-refresh.test.ts）：SSE 等待改 pump 收集模式（消除 Promise.race 悬空读）+ 操作幂等超时重试 + 单测超时 5s→15s（SSE 等待 10s 大于 bun 默认 5s）；历史 flaky 根治。
  - 影响范围：packages/kernel/tests/setup.ts、scripts/test.ts、channel-manager.test.ts、ws-extension-skill-refresh.test.ts；验证：受限全量 1254 tests / 110 files / 176s 全部通过，正式 ~/.pi/agent 零污染、9778 正常运行。
- dev 启动：vite 强制用 bun runtime（`bun --bun`）。vite bin 脚本 shebang 为 `#!/usr/bin/env node`，默认解析到系统 node（本机 v14 过旧，不支持 vite 8 的 `??=` 等语法导致启动报 SyntaxError）；`--bun` 把 node 符号链接指向 bun，vite 在 bun runtime 下正常启动，与 Node ≥20 要求解耦（scripts/dev.ts spawnFrontend）。

### 新增

- browser_* 宿主浏览器工具（browser_navigate/evaluate/screenshot/close）
  - 新增：BrowserManager 会话级 Bun.WebView 实例池（packages/kernel/src/browser-manager.ts）——每个 wa-pi 会话一个 WebView，首次 navigate 隐式创建、之后复用；销毁三层：闲置超时 sweep、会话结束 closeSession、显式 browser_close；视图工厂可注入（测试用 fake）。
  - 新增：browser-tools.ts 执行逻辑——handleBrowserTool(manager, sessionId, tool, params) 按工具分派返回 BridgeToolResult；超时用 Promise.race 包装（页面加载 120s、操作 60s）、ERR_INVALID_STATE 并发重试（最多 3 次×100ms 递增间隔）、eval 结果超 8000 字符截断、截图默认落盘到截图目录（path 模式）或返回 data URL（base64 模式）、引擎不可用错误提示含 BUN_CHROME_PATH 指引。
  - 测试：browser-manager 6 用例、browser-tools 9 用例全 PASS（fake view + fake manager 注入）。
  - 影响范围：packages/kernel/src/browser-manager.ts、packages/kernel/src/browser-tools.ts、packages/kernel/tests/browser-manager.test.ts、packages/kernel/tests/browser-tools.test.ts。
- bridge-extension 兼容 bun --compile 单二进制（POC 支撑，mac 验证用）
  - 背景：Windows 真机 POC 验证「kernel 用 bun --compile 编译成单 exe + --asset 嵌入桥接文件」可行——jiti 扩展加载器在编译产物中正常解析（agent 能创建到「未选择模型」一步，与解释运行同线）。此提交是 POC 需要的两处代码支撑。
  - 实现：`packages/kernel/src/bridge-extension.ts` ① 三个 resolve 函数加 `__dirname/assets/` 子目录回退（bun --compile --asset 把 wa-pi-bridge.extension.ts/tool-schemas.ts/file-snapshot.ts 嵌入到 import.meta.dir/assets/）；② `ensureBridgeExtension` 的 copyFile 改 readFileSync+writeFile（编译产物虚拟 FS 不支持 copyFile，existsSync 可读但 copyFile ENOENT）。
  - 影响范围：`packages/kernel/src/bridge-extension.ts`；测试：bridge-extension 10 例全绿、kernel typecheck 无新增错误（既有 mcp-connector 1 例除外）。mac 待验证：darwin 交叉编译、原生依赖（@napi-rs/keyring）架构变体加载、codesign/Gatekeeper。
- dev 启动自动下载 bun 1.4.0（版本不足不再直接报错退出）
  - 背景：上一提交加了版本守卫，dev 机 bun <1.4.0 时打印中文错误并 exit(1)，用户需手动升级 npm 包装的 bun（`npm install -g bun@latest`），体验差且与打包版（sidecar 固定 1.4.0）行为不一致。
  - 实现：`scripts/bun-dev-runtime.ts`（新增）——下载 bun 1.4.0 到用户缓存目录（`%LOCALAPPDATA%\wa-pi\bun` / `~/.cache/wa-pi/bun`，`WA_PI_BUN_CACHE_DIR` 可覆盖），GitHub 固定 tag + npmmirror 双镜像回退，PowerShell/unzip 解压，`--version` 校验 ≥1.4；`packages/shared/src/bun-download.ts`（新增）——资产名/URL 纯函数（与发版 sidecar 共用策略防漂移）；`scripts/dev.ts` main() 版本不足时改为：查缓存 → 下载 → 用下载 bun 重启 dev 自身（PATH 前置 + `WA_PI_PI_RUNTIME` env 注入让 pi rpc 子进程跟随）→ 下载失败才走原有报错退出兜底；spawnKernel/spawnFrontend 改用 `process.execPath` + `shell:false`（重启后即下载 bun，插件安装 NpmPackageService 经 process.execPath 自动跟随）。
  - 影响范围：`packages/shared/src/bun-download.ts`（新）、`tests/bun-download.test.ts`（新 7 例）、`packages/shared/src/index.ts`、`scripts/bun-dev-runtime.ts`（新）、`scripts/__tests__/bun-dev-runtime.test.ts`（新 9 例）、`scripts/dev.ts`、`.gitignore`（.bun-cache/ 兑底）；验证：shared 123 pass、scripts 14 pass、bun build 通过。范围边界：dev:kernel / dev:frontend / dev:desktop 直跑仍会被 startKernel 守卫拦截（单独任务跟进）。
- 启动强制校验 Bun ≥ 1.4.0（dev 与打包统一入口守卫）
  - 背景：代码已升级 bun 1.4.0 并依赖其行为（scheduler.ts 的 Bun.cron 按本地时区解析、crash-logger 移除 bun#25633 白名单需 1.3.15+），但 dev 机器若仍用 1.3.x 会静默运行在错误行为上（定时任务错 8 小时、crash 竞态）而不自知。
  - 实现：`packages/shared/src/runtime-check.ts`（新增）提供 `parseBunVersion`/`isBunAtLeast`/`checkBunVersion`/`assertBunVersionOrExit` 纯函数与中文错误文案；`scripts/dev.ts` main() 在 ensureDeps 后快速失败（先自修复依赖再查版本，保留动态 import 链路）；`packages/kernel/src/index.ts` startKernel() 第一行最终兜底（三条启动链 dev:kernel / dev:desktop / 打包 sidecar 都汇聚于此）；根 package.json 加 `engines.bun: >=1.4.0`（bun install 警告级，非强制）。
  - 影响范围：`packages/shared/src/runtime-check.ts`（新）、`tests/runtime-check.test.ts`（新 15 例）、`packages/shared/src/index.ts`、`scripts/dev.ts`、`packages/kernel/src/index.ts`、`package.json`；验证：shared 全量 116 pass、runtime-check 15 pass、dev.ts 在 1.3.14 下打印中文错误并退出。
- 首启依赖安装 100% 成功（根治「依赖装失败 → 后续模型代理请求 404」）
  - 根因：读 Windows 系统代理的 registry-js（os-proxy-config→windows-system-proxy 链）是原生 addon，安装时要 prebuild 下载/ node-gyp 编译；prebuild 下载 ECONNRESET + 机器无 VS C++ 工具链时编译失败 → bun install 退出码 1，且旧逻辑只看退出码就写 `.installed-version` 标记，后续启动永久跳过安装，kernel 加载 registry-js 报 `Cannot find module .../registry.node`，读系统代理失败，模型请求经中继走向死端口/直连报 404。
  - 调整：读系统代理改为自研跨平台实现（settings-store.ts），零第三方依赖、零原生模块——Windows 用系统自带 reg.exe 读注册表（ProxyEnable/ProxyServer），macOS 用 scutil --proxy，Linux 用环境变量；删除 os-proxy-config 依赖链。
  - 调整：build-kernel-sidecar 依赖清单删除 registry-js、kernel.js 构建去掉 `--external registry-js`；首启安装 `bun install --ignore-scripts`（跳过一切 lifecycle 脚本，纯 JS 包下载解压即用，无编译环节）→ 网络通即 100% 成功。
  - 调整：安装后 verifyInstall 校验顶层依赖真实存在（仅看退出码会漏掉半装）；失败清理 node_modules 重装（installWithRetry 主源→回退源两轮，Windows 文件锁重试 3 次×1s）；全部失败__不写标记__ → 下次启动自动重试（门禁：安装不成功不允许使用应用）。
  - 调整：`readSystemProxy` 不再把 env 里的本地中继地址（`http://127.0.0.1:端口` 残留值）当上游——旧值会让新中继上游指向已死端口，抽 `systemProxyFromEnv` 纯函数忽略回环代理后继续读系统代理。
  - 新增：依赖安装失败错误页提供「重试」（IPC `app:retry-install` → relaunch，preload 暴露 `waPiApp.retryInstall`）与「退出」按钮。
  - 影响范围：`packages/kernel/src/settings-store.ts`（自研跨平台读代理 + SettingsJson 类型替换 Record<string,any>）、`packages/desktop/src/util/runtime-deps.cjs`（--ignore-scripts + verifyInstall + installWithRetry）、`packages/desktop/scripts/build-kernel-sidecar.ts`（删 registry-js）、`packages/kernel/package.json`（删 os-proxy-config）、`packages/desktop/src/main.cjs`、`preload.cjs`；测试：runtime-deps 9 用例、settings-proxy 24 用例（含 reg/scutil 解析、systemProxyFromEnv）。
- 端口被占用时静默自动换端口启动，不再弹提示
  - 调整：kernel 固定端口（默认 9778）被占用、自动清理（3 轮）仍失败时，不再在启动页弹「端口被占用」错误提示 + 「换端口启动」按钮，改为静默自动查找下一个可用端口（findAvailablePort 从被占端口+1 线性探测）并 relaunch 启动；找不到任何可用端口时才落回错误提示。
  - 同样处理：清理占用进程后仍被占用（幽灵句柄）的分支，不再提示直接换端口。
  - 重构：抽 `switchPortAndRelaunch`（port-switch.cjs，依赖注入可测）封装「找端口→写 .switch-port→relaunch→exit」；main.cjs 三处（自愈失败/清理后仍占/程序化 handler）复用同一逻辑。
  - 影响范围：`packages/desktop/src/util/port-switch.cjs`、`packages/desktop/src/main.cjs`；测试：port-switch 新增 switchPortAndRelaunch 3 个用例。
- 模型前两次重试（attempt≤2）顶部不显示「正在自动重试 (n/m)」黄条，改显示「当前请求服务器繁忙，请等待～」；第三次起（attempt≥3）才显示重试进度条。
  - 影响范围：`packages/frontend/src/App.tsx`（retry-status-bar 文案分支）、`packages/frontend/src/i18n/locales/{zh,en}.ts`（新增 app.retryWaiting）；测试：App.test.tsx 新增前两次重试用例 + 原有重试用例改 attempt=3，beforeEach 重置 net/retry 状态条字段防污染。

### 重构

- 发版存储从阿里云 OSS 迁移到 Cloudflare R2：publish-oss 脚本改 S3 兼容 SDK（@aws-sdk/client-s3 + lib-storage），更新 URL 与凭证键名（R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY）同步切换（scripts/publish-oss.ts、electron-builder.yml、updater.cjs、.env.example）
- 运行时升级 bun 1.4.0 并移除旧版本（1.3.x）bug 兼容：
  - 发版 sidecar 打包固定下载 bun-v1.4.0（build-kernel-sidecar.ts npmmirror 版本）；darwin 资产名 arm64 → aarch64（bun 资产命名，写 arm64 会 404 回退 host bun 导致版本不可控）；README 前置要求 ≥1.4、@types/bun ^1.4.0。
  - 反转 Bun.cron 时区换算（scheduler.ts）：bun 1.4 起 Bun.cron 按系统本地时区解析 cron（旧版 1.3.x 固定 UTC，之前的 localToUtc 换算在 1.4 会触发错误时点），改为直接以本地时刻生成 cron；custom 直通语义改为本地时刻。
  - 移除 bun#25633 autoSelectFamily 竞态白名单（crash-logger，1.3.15+ 修复）；移除 fetch 连接池同 host 多 server 错误复用 workaround（tests/setup.ts fetch 包装 + ws-extension-skill-refresh connection: close，1.4 已修复）。
  - 保留：fetch timeout:false（bun 1.4 尊重 timeout 参数但默认 300s 硬超时仍在）、process.env 代理变量特殊 getter/setter（1.4 仍 delete 不掉）、publish-oss 手动 multipart（@aws-sdk lib-storage 未确认修复）。
  - 影响范围：packages/desktop/scripts/build-kernel-sidecar.ts、packages/kernel/src/scheduler.ts、crash-logger.ts、wa-pi-bridge.extension.ts、tests/setup.ts、ws-extension-skill-refresh.test.ts、scheduler.test.ts、crash-handlers.test.ts、README*、package.json；测试：scheduler 33 pass（bun 1.4 实测）。

## 2026-08-20 — fix(UI): 侧边栏窄宽时顶部标题只显示「WA PI」隐藏 Agent

- 调整：顶部标题「WA PI Agent」在侧边栏宽度 < 240px 时只显示「WA PI」、隐藏「Agent」（与回收站/系统设置 compact 同一阈值），避免换行/截断；宽时显示完整标题。
- 影响范围：`packages/frontend/src/components/Sidebar.tsx`；测试：Sidebar 新增宽/窄标题显示用例。

## 2026-08-20 — fix(UI): 修复侧边栏 compact 图标回落到 12px（Tailwind 扫不到模板拼接类名）

- 根因：`text-[calc(${compact ? 24 : 16}px*var(--font-scale))]` 把尺寸数字放进模板插值，Tailwind content 扫描拿不到完整类名字面量 → 不生成对应 CSS → 图标 font-size 回落到按钮 `text-xs`（12px），看起来「没放大」。
- 修复：改为完整类名字面量三元表达式（`compact ? "text-[calc(24px*var(--font-scale))] flex-shrink-0" : "..."`），Tailwind 可扫描生成；验证 tailwindcss 产出 CSS 含 24/16/27/20px 四个类。
- 附带：重新构建前端 dist（旧产物缺这些类）。尺寸最终：垃圾桶 compact 24px/常规 16px；系统设置 compact 27px/常规 20px。
- 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`、`SettingsButton.tsx`、`dist/`（重新构建）。

## 2026-08-20 — fix(UI): 系统设置 compact 图标 32→27px

- 调整：系统设置图标 compact（仅图标）32→27px；常规 20px、垃圾桶（compact 24px / 常规 16px）不变。
- 影响范围：`packages/frontend/src/components/SettingsButton.tsx`；测试：SettingsButton compact 尺寸断言更新。

## 2026-08-20 — fix(UI): 系统设置图标尺寸调整（常规 20px，compact 32px）

- 调整：系统设置图标非 compact 18→20px；compact（仅图标）27→32px。回收站图标不变（compact 24px / 常规 16px）。
- 影响范围：`packages/frontend/src/components/SettingsButton.tsx`；测试：SettingsButton 尺寸断言更新。

## 2026-08-20 — fix(UI): 侧边栏 compact 模式图标放大

- 调整：窄侧栏（compact）仅显示图标时「回收站」16→18px、「系统设置」18→20px（随 --font-scale 缩放），视觉更清晰；非 compact 保持原尺寸。
- 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`、`SettingsButton.tsx`；测试：两按钮 compact 用例补放大尺寸断言。

## 2026-08-20 — fix(UI): 侧边栏 compact 模式图标居中

- 修复：窄侧栏（compact）隐藏文字后，「回收站/系统设置」图标默认靠左——按钮加 `justify-center`，仅 icon 时居中对齐；非 compact 保持靠左。
- 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`、`SettingsButton.tsx`；测试：两按钮各新增 compact 居中 / 非 compact 靠左断言。

## 2026-08-20 — fix(UI): 侧边栏窄宽时底部按钮真正隐藏文字只留图标（compact 模式）

- 修复：上一版仅 truncate 显示省略号、文字未真正隐藏——现改为 Sidebar 宽度 < 240px 时传 `compact` 给「回收站/系统设置」按钮，隐藏文字 span 只保留图标；≥240px 正常显示文字。回收站未读角标（badge）始终保留（功能信息非文字）。
- 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`、`SettingsButton.tsx`、`Sidebar.tsx`；测试：RecycleBinButton 新增 4 用例（compact 隐藏/角标保留）、SettingsButton 新增 compact 2 用例、Sidebar 新增宽度驱动 2 用例。

## 2026-08-20 — fix(UI): 点会话自动关闭浏览器预览；侧边栏窄宽时底部按钮只显示 icon

- 修复：浏览器预览（BrowserPanel）打开后，点击侧边栏任意会话自动关闭预览并回到会话视图（App onSelectSession 调 closeBrowser）。
- 修复：侧边栏拖窄后「回收站 / 系统设置」按钮文字换行、溢出——按钮改为 flex + min-w-0 + overflow-hidden，文字 span whitespace-nowrap + truncate + shrink（可收缩），icon flex-shrink-0；极限窄宽时文字隐藏只显示 icon。
- 影响范围：`packages/frontend/src/App.tsx`、`RecycleBinButton.tsx`、`SettingsButton.tsx`、`Sidebar.tsx`、`e2e/html-preview.spec.ts`（新增点会话关预览 E2E 用例，当前 E2E 环境预存在问题无法运行）；测试：SettingsButton 新增窄宽收缩结构断言。

## 2026-08-20 — feat(文件预览): 聊天中点击 html 文件标签优先用浏览器预览打开

- 调整：会话聊天中点击文件标签（FilePill 路径胶囊 / 发送附件 chip / file_changes 修改清单）时，**html/htm 文件优先打开浏览器预览（BrowserPanel）**，其余文件仍走内置文件预览器——与文件树双击行为一致。
- 实现：新增 `openFileOrPreview(path, sessionId)` 统一分发（`packages/frontend/src/open-file-preview.ts`）：`isHtmlPath` → `useBrowserStore.openBrowser`（kernel `/preview` 同源静态浏览），否则 `useSessionStore.openFilePreview`；三处调用点（FilePill/ComposerInput 附件/FileChangeSummary）替换。
- 影响范围：`packages/frontend/src/open-file-preview.ts`（新）、`open-file-preview.test.ts`（新）、`FilePill.tsx`、`ComposerInput.tsx`、`FileChangeSummary.tsx`、`tests/FilePill.test.tsx`（新增 html 分发用例）；测试：全量前端 1798 个全绿。

## 2026-08-20 — feat(通讯录搜索): 两处通讯录搜索改为纯本地过滤（不再同步企微）

- 调整：系统设置 → 机器人 → 通讯录面板（wecom 渠道）与发送给 IM 联系人弹窗（ContactPickerDialog）的「搜索好友」均为__纯本地过滤__——输入仅草稿，点搜索才按显示名过滤本地列表（人/群统一），清空再点可重置恢复全量；**不再调用企微同步接口**。
- 原因：企微主动推送仅允许推送给「主动给机器人发过消息」的会话；此前搜索同步进来的企微成员（未对话）推送会报 846607 频率/会话限制，同步功能无法带来可推送好友，故前端移除同步调用。
- 保留：后端 `POST /api/contacts/sync-wecom` + `WecomCliClient`（企微 CLI 网关 `contact/users/search`，Bot ID+Secret 签名换 token、853004 自动刷新）接口与测试完整保留，供后续需要时接入。
- 影响范围：`packages/frontend/src/store/contacts.ts`（移除 `syncWecomContacts`）、`packages/frontend/src/components/settings/ContactsPanel.tsx`、`packages/frontend/src/components/ui/ContactPickerDialog.tsx`（移除同步逻辑 + channels store 依赖）；测试：两组件搜索用例改为纯过滤语义（不调同步、无 toast）。

## 2026-08-20 — feat(企微通讯录同步): 通讯录搜索式同步企微成员（已下线）

- 新增：系统设置 → 机器人 → 通讯录面板（wecom 渠道）顶部常驻搜索框，点「搜索好友」按关键词（姓名/部门）搜索企微通讯录成员并合入本地通讯录；输入仅草稿，点搜索才按显示名过滤本地列表（人/群统一）；仅新增 > 0 时 toast 提示，无新增不打扰；同步后保留关键词不清空，过滤继续生效；清空输入框再点「搜索好友」可重置过滤恢复全量。
- 新增：发送给 IM 联系人弹窗（ContactPickerDialog）搜索框旁「搜索好友」按钮（始终显示），输入仅草稿、点搜索才按关键词过滤本地列表；有 wecom 渠道时顺带同步企微成员到本地并刷新，无权限则仅本地过滤（静默），回车同样触发。
- 鉴权：复用机器人已有 Bot ID+Secret，签名（sha256_hex(secret+botId+time+nonce)）调 `get_cli_config` 换取 Bearer token（无需 apikey）；token 失效（853004）自动换新重试，用户无感。后端新 `WecomCliClient`（`packages/kernel/src/channels/wecom-cli-client.ts`）封装企微 CLI 网关 `contact/users/search`。
- 接口：`POST /api/contacts/sync-wecom`（body `{channelId, keywords}`）→ `contacts:sync-wecom` → `ChannelManager.syncWecomContacts`（按成员 ensureContact + remark 为空才填姓名，不覆盖手动备注）→ 广播 `contacts:changed`。
- 影响范围：`packages/kernel/src/channels/wecom-cli-client.ts`（新）、`packages/kernel/src/channel-manager.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/routes/contacts.ts`、`packages/shared/src/types.ts`（新增 `ContactsSyncWecomRequest`/`ContactsSyncWecomResult`）、`packages/frontend/src/store/contacts.ts`、`packages/frontend/src/components/settings/ContactsPanel.tsx`、`packages/frontend/src/components/settings/BotsSection.tsx`、`packages/frontend/src/components/ui/ContactPickerDialog.tsx`；测试：kernel 新增 wecom-cli-client / channel-manager-wecom-sync 单测 + ws-server/routes 用例，前端 ContactsPanel 搜索同步用例（含真搜索过滤/无新增不 toast/同步后不清空）+ ContactPickerDialog 搜索按钮同步用例。

## 2026-08-20 — fix(通讯录): 联系人长名截断（设置-机器人-通讯录面板 + 发送给IM联系人弹窗）

- 修复：通讯录面板（系统设置 → 机器人 → 通讯录）与联系人选择弹窗中，名字过长的联系人（长备注名/长 userId/群 chatId）不再溢出容器——名字 span 加 truncate + min-w-0（flex 内可收缩 + 省略号），右侧 ⋯ 加 flex-shrink-0 防挤压；编辑态 input 加 text-ellipsis（长名显示省略号）+ 保存/取消按钮 flex-shrink-0。
- 影响范围：`packages/frontend/src/components/settings/ContactsPanel.tsx`、`packages/frontend/src/components/ui/ContactPickerDialog.tsx`；测试：两个组件各新增长名截断用例。

## 2026-08-20 — feat(发送给IM联系人): 新建会话也可用推送命令

- 体验：「发送给 IM 联系人」命令不再因 isNewSession 置灰——推送走全局执行器（channelManager 长连接），不依赖会话状态，新建会话首条消息即可带 chip 发送推送。仅运行中禁用（与 reload/compact 一致）。
- 影响范围：`packages/frontend/src/components/ui/ComposerInput.tsx`（disabled 去掉 isNewSession）、`packages/frontend/e2e/send-im.spec.ts`（改为新建会话直接走完整流程，不再先建会话）；测试：ComposerInput 新增新建会话命令可用用例。

## 2026-08-20 — feat(发送给IM联系人): 联系人弹窗搜索 + 多选多 chip

- 体验：联系人选择弹窗改版——标题显示「我的通讯录（x）」（x=联系人总数，去掉渠道分组标题）；顶部新增按名字搜索框（支持备注名/群 chatId 前 8 位/userId）；支持多选，确认后一次性插入多个 @im-push-to chip。
- 影响范围：`packages/frontend/src/components/ui/ContactPickerDialog.tsx`（统一列表 + 搜索 + Set 多选，onPick 改返回数组）、`packages/frontend/src/components/ui/ComposerInput.tsx`（handleSendImPick 批量注册 meta + 多个 token）、i18n zh/en；测试：ContactPickerDialog 新增标题计数/搜索/多选/取消选中用例、ComposerInput 多选双 chip 用例。

## 2026-08-20 — refactor(发送给IM联系人): im_push_to 改全局执行器（实时解析联系人推送）+ / 命令置顶

- 重构：主聊天 im_push_to 不再依赖会话级推送注册表（此前方案：消息 @im-push-to 标记预激活注册表，空闲回收/崩溃重建后注册表随进程丢失，重试报「本会话未配置推送目标」）。改为全局执行器——工具调用时实时按联系人 id 解析，直接走 channelManager 全局长连接（kernel 启动即建立，pushToContact 按 contact.channelId 路由 + 校验联系人存在），无会话级状态，重建后天然可用。定时任务路径不变（executeTask 的 imPush 注入优先）。
- 体验：「发送给 IM 联系人」命令移到 / 命令列表第一位（默认高亮即它，输入 / 直接可达）。
- 影响范围：`packages/kernel/src/agent-manager.ts`（handleTool 改 imPushExecutor 全局执行器，删除注册表/setImPushFactory）、`packages/kernel/src/index.ts`（setImPushExecutor 直接 pushToContact）、`packages/kernel/src/wa-pi-bridge.extension.ts`（工具描述去「无标记报错」）；测试：robot-push 新增「任意会话实时推送」「定时任务注入优先」「未接线报错」「executor 抛错回退」用例。定时任务路径不变（有标记仍白名单 + 结果收集；无标记靠提示词引导，与主聊天一致）。

## 2026-08-20 — feat(发送给IM联系人): 主聊天「发送给 IM 联系人」命令

- 新增功能：主聊天界面「发送给 IM 联系人」命令（/ 菜单 → 弹窗选联系人 → 插入 @im-push-to chip），agent 执行中自主调用 im_push_to 实时推送结果给 IM 联系人。kernel 侧 im_push_to 工具改为始终注册 + 会话级推送注册表（消息标记惰性激活）；系统提示词 im-push 段对普通会话注入通用常驻引导（替代原设计不可行的消息级拼接——会污染 transcript）。定时任务路径零改动。
- 实现：kernel（wa-pi-bridge.extension / agent-manager / index / robot-push）——工具始终注册、`SessionHandle.imPush` 注册表（`_sendPromptNow` 解析 @im-push-to 标记惰性激活）、`GENERIC_IM_PUSH_PROMPT` 常驻引导、index.ts 后绑定 `setImPushFactory`；frontend（ComposerInput / ContactPickerDialog / tokens / store/contacts / MessageList / i18n）——`cmd:send-im` 命令、联系人选择弹窗、chip-im 渲染（未注册灰化）、contacts store 批量注册 chip meta、历史消息 chip 刷新后不灰化。
- 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/tools/robot-push.ts`、`packages/frontend/src/quick-invoke/tokens.ts`、`packages/frontend/src/store/contacts.ts`、`packages/frontend/src/components/ui/ContactPickerDialog.tsx`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/components/MessageList.tsx`、i18n；测试：kernel 单元/集成（robot-push / agent-manager / bridge）、前端组件测试、E2E `packages/frontend/e2e/send-im.spec.ts`。

## 2026-08-20 — feat(HTML预览): 地址栏支持外部 URL（iframe 内嵌外部站点）

- 新增功能：预览窗口地址栏可输入外部网址（http/https，或域名/IP/localhost 自动补 https://），iframe 直接加载外部站点，站内链接正常跳转（target=_blank 允许开新标签）。受对方站点 X-Frame-Options/CSP frame-ancestors 限制（禁止被嵌入的站点白屏，无法绕过）。外部 URL 时「查看源码」「分享」按钮禁用（仅本地 html 可用）。本地 html 预览仍走 /preview allowlist + 独特源 sandbox，语义不变。
- 实现：`preview-url.ts` 新增 `toExternalUrl`（域名/IP/localhost 识别 + 补 https://）；`HtmlPreview` 支持 externalUrl 模式（sandbox 放开 allow-same-origin/allow-popups）；`BrowserPanel` 状态改为判别联合（local/external），openPath 分流外部 URL；相对 html 路径（如 index.html）仍拒绝。
- 影响范围：`packages/frontend/src/preview-url.ts`、`packages/frontend/src/components/blocks/HtmlPreview.tsx`、`packages/frontend/src/components/BrowserPanel.tsx`、i18n zh/en；测试：preview-url toExternalUrl 4 例、HtmlPreview external 模式、BrowserPanel 外部 URL 4 例。

## 2026-08-20 — feat(提示音): 任务完成提示音改为真实青蛙叫声「呱 呱～」

- 背景：原任务完成提示音为 Web Audio 合成上行两音（880→1320Hz），用户反馈不好听；振荡器合成始终像电子音，改用真实录音。
- 实现：下载免费青蛙叫声音效，裁剪开头 428ms 静音后取 1s（完整第一声「呱」）→ 新增 `packages/frontend/public/sounds/frog-croak.mp3`（17KB）；`taskDoneSound` 从 Web Audio 合成改为 `new Audio().play()` 播放 mp3（volume 0.8，自动播放策略拒绝时静默降级）；「需要操作」提示音保持 Web Audio 合成不变。
- 影响范围：`packages/frontend/src/util/sound.ts`、新增 `packages/frontend/public/sounds/frog-croak.mp3`；测试重写 `packages/frontend/tests/sound.test.ts`（taskDone 改为断言 mp3 播放，needsAction 保留 660Hz 断言）。

## 2026-08-20 — feat(HTML预览): 内置浏览器预览 HTML 产物

- 新增功能：内置浏览器预览 HTML 产物——双击 .html 或点会话页右上角 🌐 图标，在占满主内容区的预览窗口渲染页面（相对 js/css/图片完整加载），支持复制路径/刷新/查看源码/分享/关闭。
- 实现：kernel 新增 /preview 同源静态浏览路由（allowlist 仅放行项目根内文件、realpath 防穿越、sandbox iframe 隔离）；前端 preview-url 工具（isHtmlPath/buildPreviewUrl）、browser store（openBrowser/closeBrowser）、HtmlPreview iframe 组件、BrowserPanel 单预览窗口（输入路径/复制/刷新/查看源码/分享/关闭），App/SessionView/NewSessionPane 入口接线 + vite /preview 代理 + i18n。
- 影响范围：`packages/kernel/src/ws-server.ts`、`packages/frontend/src/preview-url.ts`、`packages/frontend/src/store/browser.ts`、`packages/frontend/src/components/blocks/HtmlPreview.tsx`、`packages/frontend/src/components/BrowserPanel.tsx`、`packages/frontend/src/App.tsx`、`packages/frontend/src/components/SessionView.tsx`、`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/vite.config.ts`、i18n；测试：kernel preview-route 单测/集成、组件测试、E2E `packages/frontend/e2e/html-preview.spec.ts`。

# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

## 2026-08-19 — feat(输入框): 跨会话复制保留 chip 语义（技能/@智能体/联系人/命令 token）

- 背景：contenteditable 输入框（聊天 ComposerTextarea / 自动化 TaskPromptComposer）中插入技能 $[名]、@智能体 @[名]、IM 联系人 @im-push-to(...)、命令 /[名] chip 后，复制粘贴到别的输入框（跨会话）时渲染和作用失效——浏览器默认复制 chip 的显示文本（如「⚡ 日报生成」），token 标记只存在于 text/html 的 data-token 里，聊天粘贴端丢弃 HTML → 语义丢失。
- 修复：复制端拦截（ComposerTextarea onCopy）——新增 `selectionToTokenText(range)` 纯函数（tokens.ts），把选中区域里的 chip 还原为 token 原文写入剪贴板 text/plain + text/html；粘贴端无需改（token 文本进来后 textToHtml/toPromptHtml 自动重渲染成 chip）。兼容 user-select:all 原子选区（点击 chip 全选复制也输出完整 token）。
- 影响范围：`packages/frontend/src/quick-invoke/tokens.ts`（新增 selectionToTokenText）、`components/ui/ComposerTextarea.tsx`（onCopy 拦截）；测试新增「selectionToTokenText 单/多 chip 原子选区」「复制写入 token 剪贴板」用例。

## 2026-08-19 — fix(会话): abort 无响应兜底——超时强杀 pi 进程（「停不下聊天」修复）

- 背景：agent 等挂起的 LLM 响应时 pi agent loop 卡死，abort RPC 无人应答，kernel 永远等 `client.abort()`，用户点停止无效只能重启 app（desktop.log 实测：两次 abort 只有进场日志、无 abort DONE）。
- 修复：`AgentManager.abort` 对 abort RPC 加 5s 超时（`abortTimeoutMs` 可注入）；超时后合成 message_end 错误（⚠️ 播报「agent 无响应，已强制停止」）+ agent_end（前端退出思考态），再走 `_teardownSession` 强杀进程——会话记录与 jsonl 保留，下次使用 ensureStarted 自动重建。并发/重复 abort 有守卫不重复处理。
- 影响范围：`packages/kernel/src/agent-manager.ts`；测试新增「abort 无响应超时 → 强杀进程兜底」用例（fake client 新增 hangAbort 开关）。

## 2026-08-19 — feat(多模态): 图片内联按大小硬限制（单张 3.5MB / 累计 10MB），超出回退为附件

- 背景：图片附件已能真正发给大模型后，需按业界标准限制图片大小——原先单张 8MB（base64 ≈10.7MB）超 Anthropic 5MB base64 上限会直接报错；无累计限制会撑爆 RPC payload。
- 业界调研：Anthropic base64 5MB（最严）；OpenAI 原始 20MB；Gemini 内联 7MB/单请求 3600 张（宽松）。取最严约束对齐。
- 实现：单张上限 8MB → 3.5MB（base64 ≈4.67MB < 5MB，pi 生态 4.5MB 同量级）；新增累计上限 10MB——超过累计上限的图片回退为附件（@路径 文本引用），不阻塞发送。readImageContent 返回字节数供预算累计。
- 影响范围：`packages/kernel/src/agent-manager.ts`；测试新增「单张超 3.5MB 回退」「累计超 10MB 超出部分回退」用例。

## 2026-08-19 — fix(多模态): 图片附件真正发给大模型（此前仅降级为 @路径 文本引用）

- 背景：选择支持视觉的模型后发送图片附件，LLM 收到的只是 `Attachments:[@.wa-pi/uploads/xxx.png]` 文本路径，图片从未转为多模态 content part，视觉模型看不到像素。
- 根因：kernel `buildPromptContent` 把 `kind:"image"` 附件统一降级为文本引用；`_sendPromptNow` 调 `client.prompt(text)` 只传文本，不传 pi RPC 已支持的 `images` 参数（pi 侧 session.prompt 会把 images 组装为 user content 的 image part → image_url）。
- 修复：kernel 读取图片文件 → 按扩展名推断 mime → base64 编码为 `ImageContent { type:"image", mimeType, data }`，经 `client.prompt(text, { images })` 发给 pi；文本部分保留 @路径 引用供上下文理解。非图片扩展名/读取失败/超大（>8MB）降级为纯文本引用，不阻塞发送。排队消息（followUpList）随图片一起 drain。
- 影响范围：`packages/kernel/src/agent-manager.ts`（buildPromptContent 改 async + 新增 readImageContent、_sendPromptNow/prompt/队列携带 images、queue_update 推送仍为文本数组）；测试「图片附件转为 ImageContent 发送」「读取失败降级」「排队携带图片」新增，旧「图片统一用 @路径」断言改为新行为。

## 2026-08-19 — fix(代理中继): 普通 HTTP 转发上游失败回退直连 + 回环目标绕过上游（聊天 socket 断连修复）

- 背景：会话中代理上游被切成死端口后，本地 bridge 请求（<http://127.0.0.1:9778）被送进上游代理且> forwardPlain 无回退，直接 502，pi 侧 fetch 报 "The socket connection was closed unexpectedly"（实测 19,594 次 ECONNREFUSED）。
- 修复：
  1. forwardPlain 上游 socket 级失败（连不上/超时）与 CONNECT 隧道同策略——记冷却并回退直连重发（此前直接 502）。
  2. 回环目标（127.x / localhost / ::1）绕过上游，始终直连。
- 影响范围：`packages/kernel/src/proxy-relay.ts`；测试新增「上游死端口回退直连」「回环目标不送上游」用例。

## 2026-08-19 — fix(分享): 单文件夹分享复制链接带文件夹名（/<name>/<文件夹名>/）

- 背景：上轮「单文件夹不展开」后，分享名（如慧来客）+ 文件夹 dist，复制链接却是 /慧来客/（根目录，只显示索引页），没有带上 dist/。
- 修复：upload 端点 URL 计算——单文件夹分享时指向 /<name>/<文件夹名>/（如 /慧来客/dist/），访问直达文件夹内容；其他场景（单文件/多文件/合并）保持 itemShareUrl 逻辑不变。
- 影响范围：`packages/kernel/src/routes/share.ts`；测试「upload 单个文件夹」新增 URL 断言（含 /慧来客/dist/）。

## 2026-08-19 — feat(分享): 单文件夹分享不展开——文件夹本身作为一层保留

- 需求：右键分享文件夹时，之前是内容平铺展开（/慧来客/ 下直接是该文件夹内文件），改为不展开——文件夹本身作为一层保留（/慧来客/dist/index.html，访问 /慧来客/ 看到 dist 目录）。
- 实现：share.ts upload 打包 root 由 `singleDir ?? commonRoot` 改为恒用 `commonRoot`（单文件夹分享时 root=父目录，条目带文件夹名前缀）；`singleDir` 保留用于 autoName（分享名=文件夹名）。
- 影响：单文件/多文件/多文件夹分享行为不变（本就走 commonRoot）；前端无需改动。
- 影响范围：`packages/kernel/src/routes/share.ts`；测试「upload 单个文件夹」断言更新为带 dist/ 前缀。

## 2026-08-19 — feat(frontend): 聊天输入框支持手动拖拽调整高度

- 新增功能：聊天输入框顶部胶囊手柄可拖拽调整高度（60px ~ 50vh，下限与自然生长 minHeight 一致，首次拖动连续不跳变），双击手柄恢复默认高度；全局 localStorage 持久化 `wa-pi:composer-height`，刷新后保持；AskDock、QuickInvokeMenu 等贴输入框定位的浮层自动跟随上沿。
- 影响范围：`packages/frontend/src/components/ui/{ComposerInput,ComposerTextarea,ComposerResizeHandle,useComposerHeight}`、i18n locales、E2E 新增 `e2e/composer-resize.spec.ts`。

## 2026-08-19 — fix(分享): buildDeployZip 对缺失文件容错 + addItem 合并剔除已删除文件（ENOENT 崩溃修复）

- 背景：分享目录被用户改过后（如 index.html 改名 index1.html），state.json 的 files 仍引用旧文件；再次部署时 buildDeployZip readFile 抛 ENOENT 崩溃，部署链路全断（实测 ~/.pi/agent-dev/share-workspace/items/默认工作区/index.html）。
- 修复：
  1. buildDeployZip：state 引用但磁盘缺失的文件跳过（catch 返回 null 则 continue），不崩溃、不进部署包；存活的文件正常打包。
  2. addItem 合并：files 并集前先 stat 校验旧文件磁盘存在性，剔除已删除的旧文件（state 记录自洽，不再残留坏引用）。
- 影响范围：`packages/kernel/src/share/workspace.ts`；测试新增「ENOENT 容错」「合并剔除已删除文件」用例；已清理 dev 数据 state.json（默认工作区剔除缺失 index.html）。

## 2026-08-19 — fix(分享): 合并/多文件分享链接直达问题——目录索引页 + 当次文件直达 URL

- 背景：同名合并后 item.files 变多文件，itemShareUrl 走「目录 URL」分支，而分享目录内无 index.html，访问 <https://xxx.pages.dev/慧来客/> 回退到根说明页（「WaPi Shares 托管站点」），分享内容看不到。
- 修复：
  1. 目录索引页：buildDeployZip 对每个分享目录（用户文件不含 index.html 时）生成 index.html 文件列表页（仅列本目录文件，不泄露其他分享）；EdgeOne token 透传——脚本从 location.search 读 query 拼到子链接，避免 eo_token 丢失 401；用户分享的文件本身是 index.html 时不覆盖。
  2. 当次文件直达：upload 响应 URL 用「本次分享的文件」而非合并后并集计算——同名合并后再单文件分享，链接直达当次文件（如 /慧来客/b.html），不再退化为目录；本次多文件仍指向目录（此时目录有索引页可访问）。
- 影响范围：`packages/kernel/src/share/workspace.ts`（renderDirIndexHtml + buildDeployZip）、`routes/share.ts`（URL 计算）；测试新增「目录索引页生成」「用户 index.html 不覆盖」「合并后 URL 带当次文件名」用例。

## 2026-08-19 — fix(kernel): 已知运行时 bug 不广播 error（Bun autoSelectFamily 竞态）

- 问题：聊天过程中偶发「内核异常 (uncaughtException) : null is not an object (evaluating 'context')」——Bun node:net autoSelectFamily（Happy Eyeballs）连接超时回调访问已置 null 的 context（oven-sh/bun#25633，1.3.15+ 修复）。crash handler 此前一律广播 error，前端会把它注入对话流并 failTurn，打断进行中的回复。
- 修复：crash-logger 增加已知运行时无害 bug 白名单（message + stack 双重匹配 `internalConnectMultipleTimeout`）；命中只写日志 + stderr warn 留痕，不广播 error；同堆栈真实网络错误照常广播，不误伤。
- 影响范围：`packages/kernel/src/crash-logger.ts`；测试新增「已知 bug 不广播」「同堆栈不同 message 照常广播」用例。

## 2026-08-19 — feat(分享): 同名分享改为合并（旧文件保留、新文件追加），不再报「名称重复」

- 需求：分享名相同时不再 409 报错，改为合并——新旧文件进入同一 items/<name>/ 目录，旧文件保留、新文件追加、同路径新覆盖旧；记录合并为一条（files 并集、size 重算）。
- kernel：workspace.ts `addItem` 由「不同 id 同名抛错」改为合并（不删目录 + files 并集 + dirSizeOf 重算）；`renameItem` 重名也合并（目标记录保留 id，源目录文件移入目标，同路径覆盖）；routes/share.ts 去掉上传「重复」409（保留非法字符 409），响应加 `merged`/`filesCount`。
- frontend：share-client `ShareUploadResult` 加 `merged`/`filesCount`；ShareButton 成功且 merged 时 toast「已合并到分享 xxx（共 N 个文件），旧文件已保留」。
- 影响范围：`packages/kernel/src/share/workspace.ts`、`routes/share.ts`；`packages/frontend/src/share-client.ts`、`components/ui/ShareButton.tsx`、i18n zh/en；测试新增「addItem 不同 id 同名合并」「renameItem 重名合并」「upload 同名 merged 标志」「ShareButton 合并提示」用例。

## 2026-08-19 — chore(release): 发布版本 0.2.9（修复 CF 分享链接子域硬编码）

- 版本 0.2.8 → 0.2.9：desktop/frontend package.json、version-history.json（新增 0.2.9 条目）、VersionTimeline maxEntries 断言同步、RELEASE_NOTES.md 重写为当次内容。
- 内容：修复 Cloudflare Pages 分享链接硬编码 wapi-shares.pages.dev 的问题——改用项目真实 .pages.dev 子域生成链接（子域全局唯一，被占用时旧链接打不开）。
- 测试基建：kernel 测试入口加 --preload=./tests/setup.ts（新增：fetch 包装规避 Bun 连接池同 host 多 server 错误复用连接 + 清除宿主中继代理 env 让测试直连）；--path-ignore-patterns 改为多次传参（逗号分隔实测不生效）；ws-extension-skill-refresh 的 SSE/POST 加 connection: close；bridge-disconnect abort 探针改轮询等待（Bun abort 传播有延迟）。

## 2026-08-19 — feat(分享): 分享名称默认值改为项目名称

- 需求：分享弹窗「分享名称」输入框默认值由「文件名/文件夹名/N 个文件」改为当前项目名称。
- 实现：ShareResultModal 默认值优先级 = 显式 projectName prop → 按 sessionId 反查项目名（session.projectId → project.name，默认工作区显示「默认工作区」）→ 回退原自动名；ExplorerPanel 新增 projectName prop（右键分享入口无 sessionId，由 SessionView/NewSessionPane 传入项目名）；FileViewer/FileChangeSummary 走 sessionId 反查自动生效。
- 影响范围：`packages/frontend/src/components/ui/ShareButton.tsx`、`ExplorerPanel.tsx`、`SessionView.tsx`、`NewSessionPane.tsx`；测试新增「projectName 默认值」「空白 projectName 回退自动名」用例。

## 2026-08-19 — fix(share): CF 分享链接用项目真实 pages.dev 子域（不再硬编码 wapi-shares.pages.dev）

- 问题：`.pages.dev` 子域全局唯一，同名项目在不同 Cloudflare 账号可能分到不同子域（如 `wapi-shares-abc.pages.dev`）；此前硬编码 `https://wapi-shares.pages.dev` 拼分享链接，账号子域被占用时会生成打不开的链接。
- 修复：新增 `getProjectSubdomain`（查询项目真实 subdomain，fallback domains[0]）；`getOrCreateProject` 返回真实子域；`deployToCloudflare` 与 refresh-link 的 CF 分支均用真实子域拼 URL（与 edgeone getPresetDomain 对齐）。取不到域名抛明确错误。
- 验证：真实 API 查询 wapi-shares 项目返回真实子域；单测覆盖「子域带后缀（被占用场景）」「domains fallback」「取不到抛错」。
- 影响范围：`packages/kernel/src/share/cloudflare-pages-client.ts`、`packages/kernel/src/routes/share.ts`；测试 mock 项目响应补 subdomain。

## 2026-08-19 — chore(release): 发布版本 0.2.8（Cloudflare Pages 分享渠道 + 稳定性修复）

- 版本 0.2.7 → 0.2.8：desktop/frontend package.json、version-history.json（新增 0.2.8 条目）、VersionTimeline maxEntries 断言同步、RELEASE_NOTES.md 重写为当次内容。
- 内容汇总：文件分享新增 Cloudflare Pages 渠道（API Token + Account ID 一键部署，永久公开链接）；分享配置图文指引与进度条动画改进；智能体宫格按钮与弹窗交互优化；聊天卡死自愈（kernel 崩溃重启 + SSE 假活看门狗）、代理失效回退直连、日志上限自适应等稳定性修复。
- 测试基建：kernel 测试收敛到 scripts/test.ts 统一入口（排除并单独补跑启动完整 kernel 的集成测试，避免 WA_PI_DIR 模块常量污染同 worker 后续测试文件）；static-serve/file-route 集成测试 afterAll 恢复 env；kernel-sidecar.test.ts 两个 startSidecar 测试补注入 isPortInUseFn/killPortOccupantsFn——此前漏注入会走默认真实端口清理，跑 desktop 测试即杀 9778 宿主 kernel 的事故。

## 2026-08-19 — fix(scheduler): 定时任务时区错位——Bun.cron 按 UTC 解析，配置「09:00」实际在北京时间 17:00 触发

- 根因：Bun.cron 的 cron 表达式固定按 UTC 解析（bun-types 文档明确 "interpreted in UTC, regardless of TZ"），而 toCronExpression 把 UI 的本地时间（如 09:00）原样转成 cron，未做本地时区→UTC 换算，导致任务实际在本地 17:00 触发（执行记录中 08-17/08-18 均在 17:00 有 cron 触发）。

- 修复：scheduler.ts 新增 localToUtc 换算（本地时刻 → UTC 时/分 + 跨天日偏移），daily/weekdays/weekly/monthly/hourly(startTime) 统一按本地时间解释后换算成 UTC cron；weekdays 跨天时工作日集合同步偏移（如本地周一~周五 01:00 → UTC DOW 0-4）；monthly 跨月边界（每月 1 号凌晨）回退到 1 并注释已知限制；custom 保持 UTC 语义直通。

- 影响范围：`packages/kernel/src/scheduler.ts`；测试 `packages/kernel/tests/scheduler.test.ts` 固定 TZ=Asia/Shanghai，更新既有断言并新增时区换算专项用例（33 pass）。

## 2026-08-19 — fix(自动化): 执行详情回放隐藏「重新发送」按钮（只读）

- 背景：任务执行详情页复用聊天 MessageList 渲染执行过程回放，若该次执行以模型错误结束（stopReason:error），回放会命中聊天的「重新发送」按钮逻辑，在最后一条 user 消息下方渲染重发按钮；点击会把消息重新 POST 到已结束的 scheduler 会话——执行详情是只读回放，不该有重发入口。
- 修复：MessageList 新增 `readOnly` prop（默认 false），只读时不计算「重新发送」触发条件；ExecutionDetailView 传 `readOnly`。
- 影响范围：`packages/frontend/src/components/MessageList.tsx`、`automation/ExecutionDetailView.tsx`；测试新增「readOnly 不渲染重新发送」「ExecutionDetailView 透传 readOnly」用例。

## 2026-08-19 — fix(自动化): 任务列表按创建时间倒序 + 新建后选中新任务

- 背景：新建自动化任务后找不到、看不到——列表按 JSON 存储顺序（追加在末尾）渲染，新建任务永远沉底；且新建后主区不选中新任务，用户误以为没创建成功。
- 修复：`GET /api/scheduled-tasks` 按 createdAt 倒序返回（新建任务排最前，与执行记录接口同风格）；前端 `createTask` 保存后选中新任务（取 POST 响应 task.id），主区直接显示新任务详情。
- 影响范围：`packages/kernel/src/routes/scheduler.ts`、`packages/frontend/src/store/scheduler.ts`；测试新增「GET 按 createdAt 倒序」「createTask 后选中新任务」用例。

## 2026-08-19 — fix(automation): 新建自动化工作目录下拉移除「默认」空值项，对齐「默认工作区/项目」产品设定

- 背景：产品设定中工作区只有「默认工作区」（**system**）与「项目」两类，无「默认」概念；新建自动化「工作目录」下拉此前硬编码 `<option value="">默认</option>` 空值占位项，与「默认工作区」选项重复且概念混乱。

- 修复：移除空值「默认」项；新建默认选中「默认工作区」（**system**），编辑回填时无 projectId 的旧任务同样兜底为默认工作区；保存 payload 由 projectId 显式携带（**system** 或具体项目 id），后端行为不变。

- 详情页同步：任务详情「工作目录」卡，未绑定或绑定默认工作区时显示「默认工作区」（原为「默认」），不再出现裸 id **system**。

- 影响范围：`packages/frontend/src/components/automation/TaskEditForm.tsx`、`TaskDetailView.tsx`；测试新增「下拉无默认空值项且默认选中默认工作区」「保存 payload projectId=**system**」「旧任务回填默认工作区」「详情 **system**/空值显示默认工作区」用例。

## 2026-08-19 — fix(share): Cloudflare 部署真实链路修复 + 进度条误导修复

- 修复 3（进度条「回退/重置」）：ProgressBar 的 indeterminate 动画原为 30% 滑块往返循环，滑块每次跳回起点被误读为进度回退；改为满宽「呼吸脉冲」动画（透明度渐变，视觉是"处理中"）。实测 kernel uploading percent 单调递增（0→12→…→100 无回退），根因在前端动画。deploying 文案补时长预期「部署中，约需 1-2 分钟…」。

## 2026-08-19 — fix(share): Cloudflare 部署真实链路修复（真实 API 全流程测试验证通过）

- 修复 1：check-missing 返回 HTTP 200 但响应非数组（业务错误对象/空 body，如 JWT 过期）时，此前被强转 string[] 导致 `missing.includes is not a function` 崩溃；现兼容 CF 真实响应 `{success, result: string[]}`（wrangler fetchResult 解包 result）与裸数组两种形态，均非数组则抛明确错误（含 errors[0].message）。
- 修复 2（真实 404 根因）：部署 manifest 的 key 必须带前导 `/`（`"/index.html"` 而非 `"index.html"`，与 wrangler manifest 格式一致）；upload 后补 `/pages/assets/upsert-hashes` 把 hash 注册到项目（wrangler 同款流程），否则部署成功但访问恒 404。
- 验证：用真实 Cloudflare API Token 跑全流程（Account ID 自动获取 → 创建项目 → 内容寻址上传 → upsert-hashes → multipart 部署 → 轮询 → 访问），独立测试项目 `wapi-share-poc-*` 部署后 `/index.html` 与 `/demo/hello.txt` 均 HTTP 200、内容正确，测试后已清理。
- 影响范围：`packages/kernel/src/share/cloudflare-pages-client.ts`；测试新增「HTTP 200 非数组抛明确错误」「{success,result} 包络形态正常走通」用例 + upsert-hashes mock。

## 2026-08-18 — feat(share): 分享渠道支持 Cloudflare Pages

- 新增功能：分享渠道支持 Cloudflare Pages（设置 → 分享 → 渠道切换）。公开链接、无 token 时效；配置 Cloudflare API Token + Account ID 即可部署到 pages.dev。后端新增 cloudflare-pages-client（内容寻址上传 + multipart 部署），部署按 channel 分派。
- 前端设置 UI：ShareSection 渠道从「腾讯 EdgeOne（只读）」改为可切换控件（edgeone / cloudflare）：edgeone 保留注册入口 + API Token + 自定义域名；cloudflare 渲染 Cloudflare API Token + Account ID + 注册链接（dash.cloudflare.com/sign-up，与 edgeone 注册入口同位置）+ 提示文案（链接永久公开、单文件 ≤25MB）。
- 保存 PUT /api/settings/share 全量提交 { channel, token, accountId, customDomain }（token 空串沿用 kernel 保留原值）；share-client 类型补 accountId（GET 已返回、PUT 已接受）。
- 存储用量：云端存储上限无接口可查（EdgeOne/CF 均无法动态获取）→ list 端点恒返回 totalLimit=0，前端只显示已用量「存储 X」，不显示上限（不写死 5GB，买套餐后不失真，也不要求用户填写）。
- 小白指引：API Token 输入框旁新增「?」帮助入口，点击弹窗显示__图文指引__（SVG 界面示意图 + 数字步骤 + 关键链接），带 ✕ 关闭按钮。EdgeOne：Makers 控制台「设置 → API Token」Tab 创建（填描述 + 过期时间）；Cloudflare：API Tokens 页面 Create Token 模板。
- 影响范围：`packages/kernel/src/share/cloudflare-pages-client.ts`、`packages/kernel/src/routes/share.ts`（按 channel 分派部署/refresh-link）、`packages/frontend/src/components/settings/ShareSection.tsx`、`packages/frontend/src/share-client.ts`；测试 `ShareSection.test.tsx`（新增 Cloudflare 渠道用例）、`share-client.test.ts`。

## 2026-08-18 — fix: 聊天卡死自愈链路补全（SSE 假活看门狗 + 崩溃现场日志）

- 背景：上一提交修复了"kernel 崩溃后 respawn 无限 EADDRINUSE"，但前端仍有两个盲区：① kernel 崩溃瞬间 SSE 连接可能假活（TCP 未收到 RST，EventSource.onerror 不触发），后端被 sidecar 拉起后前端仍抱着僵尸连接，卡死状态永不复位；② kernel 静默 exit code=1 无错误输出，崩溃首因无从定位。
- 修复：① kernel 心跳从 ": ping" 注释帧改为真实 data 帧（浏览器 EventSource 对注释帧不触发事件，前端不可观测）且间隔 30s→5s（`sse-bus.ts`、`ws-server.ts`）；前端 `events.ts` 加假活看门狗——任何帧刷新存活时间，OPEN 状态超过 10s 无帧则主动断连走既有重连+快照复位链路，心跳帧不进业务分发；② `kernel-sidecar.cjs` 崩溃退出时把 stderr 末尾 50 条（Bun panic/段错误的唯一现场）随 code/signal 写入 `<WA_PI_DIR>/logs/kernel-crash.log`。
- 影响范围：`packages/kernel/src/sse-bus.ts`、`ws-server.ts`、`tests/sse-bus.test.ts`（新增心跳帧断言）；`packages/frontend/src/events.ts`、`events.test.ts`（新增 4 条：假活判死/心跳保活/心跳不分发/CONNECTING 不误判）；`packages/desktop/src/kernel-sidecar.cjs`、`tests/kernel-sidecar.test.ts`（新增 2 条：崩溃写现场/正常退出不写）。

## 2026-08-18 — fix(desktop): 聊天中"卡死"（kernel 崩溃后 respawn 无限 EADDRINUSE 循环）

- 根因（desktop.log 实证，8/14、8/18 多次复现）：聊天中 kernel 进程崩溃退出（exit code=1，首因待查），其监听 socket 句柄被 pi 子进程/子代理继承，kernel 死后端口 9778 以"死 PID 占 LISTENING"的幽灵形态持续被占（现场抓到 netstat 显示 PID 2284 监听但该进程已不存在）。sidecar 的 `scheduleRespawn` 直接 respawn，新 kernel `Bun.serve` 必然 EADDRINUSE → 退出 → 再 respawn → 无限崩溃循环，后端永久不可用，前端表现为卡死、停止/发送全无效。
- 修复：respawn 前检测端口占用，被占则先调 `killPortOccupants`（含既有的幽灵扫描兜底：按数据目录特征 + 进程树子孙链圈定清理）再 spawn；端口空闲则跳过。
- 影响范围：`packages/desktop/src/kernel-sidecar.cjs`（新增 isPortInUseFn/killPortOccupantsFn 依赖注入 + respawn 前清理）、`packages/desktop/tests/kernel-sidecar.test.ts`（新增 2 条：先清端口再 respawn 的顺序断言、空闲不清理；夹具补注入避免测试真杀进程）。
- 遗留：kernel 崩溃首因（静默 exit code=1）未定位，本次只修复"崩溃后永远起不来"；前端 SSE 假活无看门狗、停止按钮无失败兜底为已知的次要自愈缺口，另行处理。

## 2026-08-18 — feat(desktop): 桌面端日志文件 10MB 上限 + FIFO 裁剪 + 磁盘空间自适应

- 打包版 desktop.log 只增不减会一直膨胀；现超过 10MB 时丢弃最旧的行、只保留最新 8MB（按换行对齐，不留半截行），所有文件操作串行化避免裁剪与追加并发冲突。重启后首次写入会 stat 存量计入上限。
- 磁盘兼容：实际上限随剩余空间自适应——`min(10MB, max(上限的 10%, 剩余空间 * 1%))`，小磁盘机器自动收紧（statfs 结果缓存 60s；statfs 不可用时按 10MB 处理）。
- 影响范围：`packages/desktop/src/util/log.cjs`（createLogger 新增可选 maxBytes/keepBytes/getFreeBytes 参数，调用方 main.cjs 不变）、`packages/desktop/tests/log.cjs.test.ts`（新增）。

## 2026-08-18 — fix(kernel): 代理中途失效自动回退直连（本地代理中继）+ 网络请求日志

- 问题：开启系统代理后若代理软件在会话进行中被关掉，pi 子进程 env 里的代理地址仍指向死端口（运行中进程 env 改不了），LLM 请求重试后全部 Connection error，且无法自动恢复。
- 修复：新增本地 HTTP 代理中继 `proxy-relay.ts`（127.0.0.1 环回，纯 TCP 实现）。`applySystemProxy` 无论开关代理都把 `HTTP_PROXY/HTTPS_PROXY`（大小写）指向中继：开代理时中继每条连接先试上游代理、连不通/超时/被拒则自动回退直连（含 15s 失败冷却，上游恢复后自动切回）；关代理时中继上游清空、全部直连。开关代理只改中继上游，存量/新建子进程 env 不用变。支持上游 http/https 代理与 user:pass 鉴权头注入；中继启动失败退化为旧行为（直接写上游地址）。
- 关键实现约束：① 中继出站刻意用裸 net/tls socket 而非 node:http 客户端——Bun 的 node:http 客户端会读 env 代理，而 kernel env 代理正是中继自身，会回环死锁；② Bun 下 pause 的 socket 收不到对端 close 事件，非转发终结路径（400/502）必须先 resume 再 end，否则 server.close() 悬挂；③ Bun 的 process.env 代理变量是特殊 getter/setter，`delete` 清不掉（同进程后续测试文件会被残留代理劫持），测试清理须置空串。
- 网络请求日志：新增 `net-log.ts`，中继经手的每条请求落盘 `~/.pi/agent/logs/network.log`（滚动：上限 min(50MB, 空闲磁盘 1%)、下限 1MB，到限改名 .1 重开）。每条请求一行：时间/方法与脱敏 URL/路由（upstream、direct、direct(cooldown)、upstream→direct）/result=ok|fail/状态码/耗时/上下行字节/错误原因。CONNECT 隧道在关闭时记一条（durMs = 隧道生命周期 ≈ 请求时长，status 仅建连结果——隧道内 HTTPS 响应码加密不可见）；普通 HTTP 记真实响应码。「上游变更」按值去重。URL 去掉 query/hash/userinfo，不记请求头与 body（防密钥泄漏）。
- 影响范围：`packages/kernel/src/proxy-relay.ts`（新增，含日志埋点）、`net-log.ts`（新增）、`settings-store.ts`（applySystemProxy 统一走中继）、`__tests__/proxy-relay.test.ts`（新增 9 例：CONNECT 隧道/鉴权注入/上游死亡回退/冷却与恢复/关代理切直连/502/普通 HTTP 转发）、`__tests__/net-log.test.ts`（新增：上限计算/URL 脱敏/滚动/formatBytes/中继日志格式——成功含时长与上下行字节、失败含状态码与错误原因、密钥不泄漏、上游变更去重）、`__tests__/settings-proxy.test.ts`（断言改为 env 恒指向中继 + afterEach 空串清代理变量）。

## 2026-08-18 — fix: 打包版默认工作区文件树空白（HOME/USERPROFILE 注入 + resolveSessionCwd 未用持久化 cwd）

- 根因：v0.2.7 只拦截 `WA_PI_DIR` 注入，漏掉 `HOME`/`USERPROFILE`：打包机（macOS）构建时 `HOME=/Users/pipi` 进入前端 bundle，`constants.ts` 用 `${HOME}/.pi/agent` 回退拼出 `/Users/pipi/.pi/agent/workdir`；而 `resolveSessionCwd` 对默认工作区（`__system__`）会话直接用该常量，忽略 kernel 持久化的 `__system__.cwd`（运行时本机路径，Windows 上为 `C:\Users\co\.pi\agent\workdir`）。非构建机（Windows）上请求 macOS 路径 → `list-dir` 返回 `fs:error` → `ExplorerPanel` 静默 `[]` → 默认工作区文件树空白。
- 修复：① `packages/frontend/vite.config.ts` 生产构建恒不注入打包机 env——机器路径（WA_PI_DIR/HOME/USERPROFILE）补上 v0.2.7 漏网，`WA_PI_WS_PORT` 也恒注入默认 9776 不读打包机 process.env/.env；② `packages/shared/src/pure.ts` `resolveSessionCwd` 默认工作区分支只用持久化 `project.cwd`（前端已从 `/api/projects` 拿到 `__system__.cwd`），绝不回退常量（空 cwd 返回空串，前端 ExplorerPanel 空串渲染空态不请求；kernel 调用点均有 `!project.cwd` 前置校验，行为不变）。
- 影响范围：`packages/frontend/vite.config.ts`、`vite.config.test.ts`（HOME/USERPROFILE/WS_PORT 不注入断言）、`packages/shared/src/pure.ts`、`tests/pure.test.ts`（新增 project.cwd 优先 + 空串断言）。需重新打包发布后生效。

## 2026-08-18 — chore(release): 发布版本 0.2.7（修复打包版默认工作区文件树空白）

- 打包发布 0.2.7（mac + win 完整覆盖 OSS）：修复打包版默认工作区会话右侧文件树空白（前端构建误注入 dev 数据目录 ~/.pi/agent-dev，与 kernel 实际 ~/.pi/agent 不一致）。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`、`VersionTimeline.test.tsx`（maxEntries 断言推进到 0.2.7+0.2.6）。

## 2026-08-18 — fix(build): 打包版默认工作区会话文件树空白（前端注入 dev WA_PI_DIR）

- 根因：`vite.config.ts` 的 loadEnv 把 `.env`（dev 专用 `WA_PI_DIR=${HOME}/.pi/agent-dev`）注入生产 bundle；打包版 kernel 运行时无 .env、默认 `~/.pi/agent`。前端 `resolveSessionCwd` 拼出的会话目录查 `~/.pi/agent-dev/workdir/<createdAt>`，而实际在 `~/.pi/agent/workdir/<createdAt>` → `list-dir` 返回 `fs:error` → `ExplorerPanel` 静默 `[]` → 默认工作区会话右侧文件树空白。dev 正常是因为 dev kernel（bun --env-file=.env）与前端都用 agent-dev。
- 修复：`vite.config.ts` 提取 `resolveInjectedValue` 纯函数，生产构建（打包版）恒不注入 `WA_PI_DIR`（bun run 会自动加载 .env 到 process.env，无法与显式 env 区分），前端回退默认 `~/.pi/agent` 与 kernel 一致；HOME/USERPROFILE 仍注入。dev/E2E（development 分支）不受影响。
- 影响范围：`packages/frontend/vite.config.ts`（新增 `resolveInjectedValue` + 对 L8 JSON.parse 补 try/catch）；新增测试 `packages/frontend/vite.config.test.ts`（development 注入 / production 不注入 / HOME 注入 4 断言）。需重新打包发布后生效。

## 2026-08-18 — chore(release): 发布版本 0.2.6（文件分享全链路）

- 版本推进 0.2.5 → 0.2.6：desktop/frontend package.json、bun.lock、version-history.json（新增 0.2.6 条目）、RELEASE_NOTES.md（重写为当次内容）、VersionTimeline 测试 maxEntries 断言同步（0.2.6+0.2.5）。
- 本版本核心：文件分享（文件树多选/预览面板/修改清单三处入口 → EdgeOne 部署 → 公开链接）、分享名称与重命名、分享管理面板（Token 脱敏/自定义域名/立即部署/清空/用量）、部署进度条；修复部署超时、重命名原子化、路径穿越校验、会话活跃口径、Provider 链接链路等。
- 影响范围：packages/desktop、packages/frontend（分享 UI/workflow/version 数据）、packages/kernel（share 工作区/路由/edgeone-client）。

## 2026-08-18 — feat(frontend): 按钮下方提示明确「需部署生效」（与 toast 呼应）

- 重命名/新增/删除等本地变更后，「立即部署」按钮下方常驻提示文案由「N 项变更未部署」改为「N 项变更未部署，需点击立即部署生效」，与重命名 toast「已重命名，需部署后生效」呼应，双处提示。
- 影响范围：i18n zh/en（settings.share.pending）；测试 ShareSection（未部署提示用例）。

## 2026-08-18 — fix(frontend): 分享弹窗点击阴影不关闭（closeOnOverlayClick=false 防误触丢输入）

- 分享弹窗（ShareResultModal）点击阴影不关闭——弹窗里可能正在输入分享名/生成链接，点阴影误关会丢输入；关闭走 X 按钮或 ESC。Modal 通用组件支持 closeOnOverlayClick 开关（其他弹窗仍默认点阴影关闭）。
- 影响范围：`packages/frontend/src/components/ui/ShareButton.tsx`（closeOnOverlayClick={false}）；测试 ShareButton（点遮罩不关 + X 关）、Modal（closeOnOverlayClick=false 用例）。

## 2026-08-18 — fix(frontend): toast 层级提到弹窗之上（z-50 → z-[60]，不再被分享弹窗阴影遮挡）

- 分享名称重复等 toast（ToastContainer z-50）与 Modal 遮罩同为 z-50，Modal portal 到 body 末尾同层后渲染在上，toast 被阴影盖住。toast 改 z-[60]（与 CommandPalette 同级，高于所有弹窗遮罩），始终可见。
- 影响范围：`packages/frontend/src/components/ui/Toast.tsx`。

## 2026-08-18 — feat(kernel+frontend): 重命名提示需部署生效（pendingCount 签名含 name）

- 分享重命名后线上（EdgeOne 部署）仍是旧名，需「立即部署」才生效。pendingCount 签名加入 name（重命名计为未部署变更，列表显示「N 项变更未部署」）；重命名成功 toast 提示「已重命名，需部署后生效」。
- 影响范围：`packages/kernel/src/share/workspace.ts`（pendingCount 签名）；frontend `ShareSection.tsx`（toast 文案）、i18n zh/en（renamedDeploy）；测试 `share-workspace.test.ts`（重命名后 pending=1）。

## 2026-08-18 — fix(frontend): Modal 改用 createPortal 渲染到 body（点击阴影可靠关闭）

- 分享弹窗点击阴影不关闭：Modal 的 fixed 遮罩若挂载在有 transform/overflow 的祖先内（如文件预览面板等），fixed 退化为相对祖先定位、遮罩不覆盖全屏，点击阴影落在遮罩之外不触发 onClose。Modal 改用 createPortal 渲染到 document.body，脱离挂载点布局/层叠上下文，保证遮罩全屏覆盖、点击阴影可靠关闭（影响所有 Modal 弹窗：分享/文件预览/AgentConfig/确认框等）。
- 影响范围：`packages/frontend/src/components/ui/Modal.tsx`；新增测试 `Modal.test.tsx`（遮罩点击/卡片不关/ESC 三用例）。

## 2026-08-18 — fix(kernel): 分享重命名改用原子 rename（原先删旧目录再复制导致 ENOENT 报错）

- renameItem 原先先 rm 旧目录再逐文件读旧目录复制到新目录——旧目录已删导致 readFile ENOENT 报错且数据有丢失风险。改为 rename() 原子移动整个目录（items/ 同盘），并补磁盘同名残留检查防覆盖。
- 影响范围：`packages/kernel/src/share/workspace.ts`；测试 `share-workspace.test.ts`（重命名成功/文件保留 + 重名拒绝 2 用例）。

## 2026-08-18 — fix(kernel): 分享名穿透兼容旧数据（items/<id>/ 自动迁移恢复）

- 穿透改造后 loadItems 对账检查 items/<name>/，旧分享（文件夹 = items/<id>/）被误判目录丢失剔除，导致「我的分享」列表清空。新增旧格式自动迁移：items/<name>/ 缺失时回退检查 items/<id>/（推断 name：单文件=文件名、多=N 个文件，重名加后缀）重命名文件夹并恢复记录；同时扫描 items/ 下孤儿 id 文件夹（state 已空的旧分享）恢复。
- 影响范围：`packages/kernel/src/share/workspace.ts`（listFilesRecursive / migrateLegacyItem / loadItems 增强）；测试 `share-workspace.test.ts`（旧格式迁移 + 孤儿恢复 2 用例）。

## 2026-08-18 — feat(kernel+frontend): 分享名穿透为文件夹名与 URL 子路径（命名/查重/重命名）

- 分享名（ShareItem.name）穿透为本地文件夹名（items/<name>/）与线上 URL 子路径（/<name>/），全库唯一；分享弹窗新增「分享名称」输入（默认自动名：文件夹名/文件名/N 个文件，可改），重名返回 409「已有分享名称重复，请使用其他名字」并 toast 提示；系统设置 → 我的分享 每条右侧加铅笔重命名（点击变 input，回车/失焦保存，Esc 取消）。
- 影响范围：kernel `share/workspace.ts`（name 目录/查重/renameItem）、`share/edgeone-client.ts`（itemShareUrl 子路径用 name）、`routes/share.ts`（upload 收 name + rename 端点）；frontend `share-client.ts`（shareUpload 加 name、shareRename）、`ShareButton.tsx`（名称输入 + 409 toast）、`ShareSection.tsx`（铅笔重命名）、i18n zh/en；测试同步更新。

## 2026-08-18 — feat(frontend): 清空分享加二次确认弹窗

- 「清空分享」点击后弹 ConfirmDialog（danger 红钮），确认才执行本地清空；文案注明线上内容需「立即部署」后移除。E2E 清空用例同步覆盖确认/取消两条路径。
- 影响范围：`packages/frontend/src/components/settings/ShareSection.tsx`、i18n zh/en、`e2e/share-management.spec.ts`。

## 2026-08-18 — fix: 分享三问题修复（打开文件夹兜底/单文件夹去嵌套/删除验证）

- 打开分享文件夹：dev 浏览器端无 `window.waPiApp`（Electron 能力）导致点击无反应；新增 kernel `POST /api/share/open-folder`（按平台 spawn open/explorer/xdg-open，cfg.opener 供测试注入），前端无 Electron 能力时走该兜底。
- 单文件夹分享去嵌套：原 commonRoot 取父目录导致内容多套一层文件夹名；单个文件夹分享时以文件夹本身为根，内容平铺到 `/<id>/`，条目名称取文件夹名。
- 「删除分享删文件」经链路验证（upload → delete → items 目录清空）当前代码无问题；若复现需确认 dev kernel 已重启加载新代码。
- 影响范围：`packages/kernel/src/routes/share.ts`；`packages/frontend/src/share-client.ts`、`components/settings/ShareSection.tsx`；测试同步新增（open-folder/文件夹平铺/前端兜底 3 用例）。

## 2026-08-18 — style(frontend): 「我的分享」按钮区调整（清空分享红色按钮 + 提示下移）

- 「清空」改名「清空分享」（行为不变：仅本地清空，立即部署后线上生效），改为红色实心按钮并固定在「立即部署」右侧；「N 项变更未部署」提示移到按钮行下方。
- 影响范围：`packages/frontend/src/components/settings/ShareSection.tsx`、i18n zh/en。

## 2026-08-18 — feat: 分享上传/部署进度条（SSE 广播 + COS 真实百分比）

- shared 新增 `ShareProgressEvent`（`share:progress`：packing → uploading（0-100 真实百分比）→ deploying → done/error）；kernel `deployWorkspace` 接 COS `onProgress`，share 路由经 SSE 全程广播（含 error 阶段）。
- 前端新增 `store/share-progress.ts`（订阅广播）与 `components/ui/ProgressBar.tsx`（determinate/indeterminate）；ShareResultModal 生成中与「我的分享」立即部署均显示进度条（部署阶段 EdgeOne 无百分比，用 indeterminate 动画）。
- 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/share/edgeone-client.ts`、`routes/share.ts`、`ws-server.ts`；`packages/frontend/src/store/share-progress.ts`、`components/ui/ProgressBar.tsx`、`ShareButton.tsx`、`settings/ShareSection.tsx`、i18n zh/en；测试同步新增（路由广播序列/错误阶段、ProgressBar、两处 UI 进度用例）。

## 2026-08-18 — fix(kernel): 分享部署必现超时/失败修复（项目名长度 + Zip 部署路径）

- 固定项目名 `wapi` 仅 4 字符被 EdgeOne 项目名 5-63 长度校验拒绝，错误嵌套在 `Data.Response.Error`（顶层 Code=0）未识别 → ProjectId undefined → 轮询永不命中 → 恒报「部署超时」。修为 `wapi-shares`；apiCall 识别嵌套错误；getOrCreateProject 拿不到 ProjectId 显式抛错。
- DistType=Zip 时 TempBucketPath 必须指向 zip 文件本身（只给目录 → Failed Code 26）。已用真实账号端到端验证部署 Success。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`；测试 `tests/edgeone-client.test.ts`（嵌套错误回归用例）、`tests/share-routes.test.ts`。

## 2026-08-18 — test(kernel): 修复套件互染与 6 个真失败，test 脚本加 --isolate

- 排查 kernel 全量测试 38 fail（单文件跑全过）：32 个为跨文件互染 + 6 个为 HEAD 真失败。
- 互染根因：`tests/edgeone-client.test.ts` 模块顶层即执行 `globalThis.fetch = fetchMock`，且"原始 fetch"捕获在劫持之后、afterEach 恢复无效——非 isolate 同进程下劫持所有并发文件的 HTTP 请求。修复：真实 fetch 在劫持前捕获，劫持挪入 `beforeEach`、afterEach 正确恢复。
- 真失败根因：`a2fa15b9`（发送前自动压缩防护）在 `_sendPromptNow` 的 `client.prompt` 前插入 `await _autoCompactIfNeeded`，drain 变异步；`tests/steer-queue-poc.test.ts` 6 个用例仍在 `fake.emit(agent_settled)` 后同步断言 `fake.prompted`，永远缺最后一条。修复：新增 `flushDrain()`（让出一个宏任务），emit 后、断言前等待。
- 预防复发：`packages/kernel/package.json` test 脚本改为 `bun test --isolate`（对齐 frontend）。
- 影响范围：`packages/kernel/tests/edgeone-client.test.ts`、`packages/kernel/tests/steer-queue-poc.test.ts`、`packages/kernel/package.json`。

## 2026-08-18 — feat(frontend): 分享面板 tab 拆分 + 打开分享文件夹；fix: 多选分享超时

- 设置-分享拆为「分享设置 / 我的分享」两个 tab；「我的分享」存储用量旁新增文件夹 icon（`window.waPiApp.showItemInFolder` 打开工作区目录，kernel `GET /api/share/list` 响应新增 `workspaceDir`）。
- fix(frontend)：多文件分享报 "signal timed out"——api-client 默认 30s 超时远低于 COS 上传 + 部署轮询耗时；`api.post` 增加可选 timeoutMs，`shareUpload`/`shareDeploy` 用 10 分钟长超时。
- 影响范围：`packages/frontend/src/api-client.ts`、`share-client.ts`、`components/settings/ShareSection.tsx`、i18n zh/en；`packages/kernel/src/routes/share.ts`（list 加 workspaceDir）；测试 `ShareSection.test.tsx`（tab 切换/文件夹入口 2 新用例）、`share-client.test.ts`（长超时断言）、`e2e/share-management.spec.ts`（tab 适配）。

## 2026-08-18 — feat: 产物分享改为固定项目 wapi + 分享管理（spec: docs/superpowers/specs/2026-08-17-share-project-management-design.md）

- kernel 新增 share/workspace.ts（state.json 事实源 + 读时对账 + 部署快照 diff）；edgeone-client 部署入口改为 deployWorkspace（固定项目 wapi、自定义域名优先、itemShareUrl 子路径链接）；分享路由六端点（upload/list/delete/clear/deploy/refresh-link）；share-store/share-history 模型下线。
- 分享设置增加 customDomain（token 空串保留语义，改域名不冲 token）。
- 前端设置-分享 tab：注册入口链接（zh/en 分流）、自定义域名输入、「我的分享」列表（复制链接/删除/清空/立即部署 + 未部署变更提示 + 存储用量）。
- 影响范围：`packages/kernel/src/share/`、`packages/kernel/src/routes/share.ts`、`settings.ts`、`settings-store.ts`、`ws-server.ts`；`packages/frontend/src/share-client.ts`、`components/settings/ShareSection.tsx`、i18n；测试同步更新 + e2e/share-management.spec.ts。

## 2026-08-18 — fix(frontend): transient 网络错误状态条显示具体原因（不再只有通用文案）

- 问题：模型调用被网关断流/限流（socket closed、429 等）时，kernel `classifySdkError` 已把错误清洗成具体文案并随 `net:status` 广播，但前端 `App.tsx` 收到后丢弃 `e.message`，顶部红条只显示通用文案「模型连接异常，请检查网络或 Provider 配置后重试」——用户分不清是网络抖动还是限额打满，表现为"突然断掉，没有任何提示"。
- 修复：session store 新增 `netMessageBySession` 保存具体原因（与 `netStatusBySession` 同生命周期：setNetStatus/clearNetStatus/agent_start/正常 message_end/removeSession/clear 同步清理）；`net:status` 事件把 `e.message` 传入 `setNetStatus`；红条优先显示具体原因，无原因时回落通用文案。
- 影响范围：`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`；测试 `tests/App.test.tsx`（红条显示具体原因 + 无原因回落通用文案 2 用例，TDD 先红后绿）、`tests/store-session.test.ts`（message 存取/清除/联动 4 用例）、`src/store/session-memory-leak.test.ts`（per-session key 补 netMessageBySession）。

## 2026-08-18 — chore(env): 开发环境独立数据目录（隔离 start.bat/start.command 与打包版）

- start.bat/start.command（浏览器版 dev，kernel 9776 + Vite 5180）与打包版桌面（Electron 9778）默认共用 `~/.pi/agent` 数据目录，两个独立 kernel 并发读写同一批 JSON 文件（projects/providers/settings/会话/记忆/日志/进程登记簿），互相覆盖、日志交错、登记簿互清。端口本就错开（9776 vs 9778），隔离数据目录才是根治。
- 修复：`.env` 增加 `WA_PI_DIR=${HOME}/.pi/agent-dev`，dev 的所有数据落到独立目录，与打包版 `~/.pi/agent` 完全隔离；打包版不带 `.env` 不受影响。`.env.example` 同步补充说明（支持 `${HOME}` 插值，勿写 `~`，Node 不展开 tilde；用真实数据调试时注释本行即可）。
- 影响范围：`/.env`（已被 gitignore，仅本地生效）、`.env.example`（模板）
- 全量核查（覆盖 kernel/shared/desktop/frontend/scripts 所有 WA_PI_DIR 消费点与硬编码路径）：生产代码无可执行路径绕过 WA_PI_DIR——所有 `~/.pi/agent` 字面量均为「先读 env/waPiDir 的默认值兜底」（constants.ts:25、port.cjs:56、node-runtime.cjs:169、main.cjs:33）；E2E 硬编码的 `~/.pi/agent/auth.json`（chat-blocks/chat-export/rpc-session/file-change-summary）为刻意读真实 LLM 凭证（只读不落盘），非数据目录写入，属有意例外。无绝对路径硬编码、无对新隔离目录 `agent-dev` 的代码误引用。

## 2026-08-18 — fix(frontend): 自动重试的新回答替换 error 消息而非拼接

- 排查「重试时把做到一半的内容重新发送、任务快结束又重来」：根因链为上游网关抖动（503/断流）→ pi auto-retry → pi 将含部分文本的失败消息移出上下文让模型重写整段（LLM API 无状态，重试必发全量历史，不可避免）→ 前端 message_end 合并逻辑把重试新回答 concat 在 error 消息残留的部分文本后，同一内容在气泡里出现两遍。本次修显示层：上一条是同 agent 的 error 消息时，新回答整体替换而非合并。
- 影响范围：`packages/frontend/src/store/session.ts`（message_end 合并分支）；测试 `tests/store-session.test.ts` 新增回归用例（替换不拼接），79 例全过。

## 2026-08-17 — fix(kernel,frontend): 产物分享最终审查修复（token 脱敏 + 死循环防护 + 域名兜底 + 路径规范化）

- I1 安全（合并前必改）：GET/PUT `/api/settings/share` 不再下发 token 明文，share 字段改为 `{ hasToken, channel }`（PUT 仍接收明文输入、回包同样脱敏）；前端 `shareSettings()` 返回结构同步改为 `{ hasToken, channel }`，调用方 ShareButton/ShareSection 用 `hasToken` 判断是否已配置。
- I2（合并前必改）：`commonRoot` 循环加护栏 `if (parent === root) break`，防 Windows 跨盘时盘符根处 `dirname` 恒等导致死循环。
- I3（强烈建议）：`getPresetDomain` 在 PresetDomain 为空时抛错「无法获取项目域名」，不再静默降级返回项目名（Name 不是域名，会拼出打不开的链接）。
- I4（强烈建议）：`hashPaths` 输入路径先统一分隔符（反斜杠 `\` → `/`）再排序拼接，避免 Windows 上同一文件正/反斜杠入口 hash 不同被当作不同项目。
- 影响范围：`packages/kernel/src/routes/{settings,share}.ts`、`packages/kernel/src/share/{edgeone-client,pack}.ts`、`packages/frontend/src/{share-client.ts,components/ui/ShareButton.tsx,components/settings/ShareSection.tsx}` 及对应测试（settings-share-route / share-routes / edgeone-client / share-pack / share-client / ShareButton / ShareSection）。

## 2026-08-17 — feat(frontend): 文件树多选 + 右键分态 + 分享所选（产物分享任务 11）

- ExplorerPanel 自研文件树从单路径选中升级为多选：`selectedPath` → `selectedPaths: Set<string>`；Ctrl/Cmd+点击 toggle 进出选中集、Shift+点击按 flatList 索引区间连选；节点 `data-selected` 改用 `selectedPaths.has(path)`。目录普通点击仍走展开/折叠，拖拽/双击/5s 轮询不受影响。
- 右键菜单分态：多选（>1）时只显示「分享所选」（`ep-ctx-share-multi`，paths=选中项列表，含文件夹）；单选时保留复制路径/默认应用打开/在访达显示并新增「分享」（`ep-ctx-share`）。
- 分享弹层：ExplorerPanel 新增 `sharePaths` state，右键「分享 / 分享所选」置位后直接渲染 `ShareResultModal`（从 `ui/ShareButton` 导出复用，share-client 走注入 transport）。
- 影响范围：`packages/frontend/src/components/ExplorerPanel.tsx`、`ui/ShareButton.tsx`（导出 ShareResultModal）、i18n zh/en（`explorer.ctxShare` / `ctxShareMulti`）、`ExplorerPanel.test.tsx`（新增 5 用例：Ctrl/Cmd 多选、Shift 连选、多选右键分态、单选含分享、分享 paths 正确）。
- 审查修复：右键分态增加归属校验（右键节点必须在选中集内才走「分享所选」，否则单选该节点弹单文件菜单）；workspaceDir 切换时重置选中集与 Shift 锚点；分享弹层关闭即清空 sharePaths；测试补「文件+目录混合多选分享」「弹层关闭卸载」2 用例。

## 2026-08-17 — fix(kernel): 用户自定义 baseUrl 不再被内置模型目录覆盖（tokenhub 401）

- 用户把预设 provider（如 DeepSeek，模型 deepseek-v4-flash 在 pi 目录中存在）的 baseUrl 改成自建网关（tokenhub.tencentmaas.com）后，`resolveProviderBaseUrl`（连通测试）与 `generateProviderExtension`（真实聊天）都无条件用目录值 `https://api.deepseek.com` 覆盖，导致网关 key 被发到 DeepSeek 官网 → 401 "Authentication Fails, Your api key: ****xxxx is invalid"。
- 新增 `resolveEffectiveBaseUrl`：用户显式配置优先；仅当用户未配置、或与目录值同源（相等/互为前缀，仅差 /v1 等后缀）时才采用目录值，保留「纠正缺 /v1 旧数据」的原有能力。
- 影响范围：`packages/kernel/src/provider-extension.ts`；测试 `packages/kernel/tests/provider-extension.test.ts`（新增 tokenhub 回归 3 用例，调整 api 分节 1 用例预期）。
- 顺带：连通测试报错不再附加「【直连：未检测到 HTTP(S)_PROXY 环境变量】」噪音文案，仅在检测到代理时附加【代理: xxx】；`packages/kernel/src/provider-test.ts`。
- 后续：自建网关端点的 reasoning 模型在生成的 extension 里显式写 `compat: { supportsDeveloperRole: false }`——pi 的 detectCompat 识别不了 tokenhub 等未知网关，会按标准 OpenAI 端点把 system prompt 以 developer role 发送，网关 400（developer is not one of [system, ...]）。判定规则：生效 baseUrl 与目录值不同即为自建端点。

## 2026-08-17 — fix(shared): 纯中文名 provider 的 slug fallback 改为确定性哈希（发送按钮置灰）

- `slugifyProviderName` 对纯中文名（如「腾讯云」）派生不出 slug 时原用 `Math.random()` 生成 `provider-xxxxxx`，每次调用结果不同：选中模型标识（slug/id）下一刻即失配，`isModelAvailable` 恒为 false → 聊天界面发送按钮永远置灰；kernel 侧 extension 注册 slug 同样不稳定。
- 改为 djb2 名字哈希（base36 取 6 位），同一名字跨调用/跨进程产出一致 slug；冲突加后缀逻辑不变。
- 影响范围：`packages/shared/src/providers.ts`；测试 `packages/shared/tests/providers.test.ts`（新增确定性回归 2 用例，调整中文 fallback 注释）。注意：修复前用随机 slug 选中过模型的会话需重新选择一次模型。

## 2026-08-17 — feat(frontend): 文件预览面板头部分享按钮（产物分享任务 10）

- FileViewer 的 Markdown 预览头部与代码预览头部（fv-btn 关闭按钮左侧）新增 ShareButton：`paths=[当前文件 path]`、透传 sessionId、testId `share-file-btn`，class 复用 `fv-btn` 与关闭按钮风格一致。图片预览（ImageViewer 头部结构不同）不在此列。
- 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`；测试 `tests/FileViewer.test.tsx`（新增：md 预览头部出现 share-file-btn / 代码预览头部出现 share-file-btn / 点击打开分享弹层 3 用例，mock share-client）。

## 2026-08-17 — feat(frontend): 文件修改清单每项分享按钮（产物分享任务 9）

- FileChangeSummary 的 FileChangeItem 右侧按钮区（原仅 canDiff 时渲染的 ml-auto 区域）改为对 `!file.error && !file.oversized` 渲染：预览/展开按钮保持仅 canDiff（修改态），新增 ShareButton（`paths=[resolveAbsolutePath(file.path, sessionId)]`，testid `file-change-share-<path>`）——新增（added）与修改（modified）文件都可分享，error/oversized 不显示。i18n 复用已有 `share.share` 文案（任务 8 已加），无新增文案。
- 影响范围：`packages/frontend/src/components/blocks/FileChangeSummary.tsx`；测试 `src/components/blocks/FileChangeSummary.test.tsx`（新增：正常文件显示分享按钮 + error/oversized 不显示、点击渲染分享弹层 2 用例，mock share-client）。

## 2026-08-17 — feat(frontend): share-client + 分享按钮与结果弹层（产物分享任务 8）

- 新增 `share-client.ts`（照 fs-client 的 transport 注入模式，`_setShareTransport` 测试注入）：`shareUpload(paths, sessionId?)` → POST /api/share/upload（返回 { url, expiresAt, projectName, channel }）、`shareSettings()` → GET /api/settings/share、`saveShareSettings(share)` → PUT /api/settings/share。
- 新增 `ShareButton`（`paths: string[]` + 可选 sessionId/className/testId）：点击打开 `ShareResultModal`（同文件内）——挂载时检查分享 token（shareSettings），未配置显示「请先在 设置 → 分享 配置 Token」引导；已配置显示待分享文件列表（文件数 + 首 3 个 basename）+「生成分享链接」→ shareUpload → 成功展示分享 URL + 复制按钮（copyToClipboard）+「链接 N 小时内有效」（由 expiresAt 计算）。testid：share-btn / share-result-modal / share-generate-btn / share-copy-btn / share-url / share-no-token / share-files。
- i18n 补顶层 `share.*`（zh + en）：share/share/title/files/generate/generating/link/copyLink/copied/expiresIn/noToken。
- 测试：`share-client.test.ts`（upload 成功/400 抛错/settings 读写 4 用例）、`ShareButton.test.tsx`（打开弹层/生成显示 URL/未配置 token 引导/复制调用 4 用例，mock share-client + clipboard）。
- 影响范围：`packages/frontend/src/share-client.ts`（新增）、`packages/frontend/src/components/ui/ShareButton.tsx`（新增）、`src/i18n/locales/zh.ts`、`en.ts`；测试 `src/share-client.test.ts`、`src/components/ui/ShareButton.test.tsx`（新增）。

## 2026-08-17 — feat(frontend): 设置页「分享」Tab（产物分享任务 7）

- 设置页新增「分享」Tab：设置 store 的 SettingsSection 联合类型增加 `"share"`；SettingsModal 导航区加「分享」入口与渲染分支；新增 ShareSection 面板（挂载时 GET /api/settings/share 回填，保存 PUT /api/settings/share，渠道「腾讯 EdgeOne」只读展示，API Token 用 password 输入且已保存时脱敏展示「•••」+「修改」切换），i18n 补 settings.share.* / nav.share（zh + en）。
- 影响范围：`packages/frontend/src/store/settings.ts`、`packages/frontend/src/components/settings/ShareSection.tsx`（新增）、`packages/frontend/src/components/SettingsModal.tsx`、`packages/frontend/src/i18n/locales/zh.ts`、`en.ts`；测试 `src/components/settings/ShareSection.test.tsx`（默认渲染/保存 PUT/脱敏展示 3 用例）。

## 2026-08-17 — fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）

- `_autoCompactIfNeeded` 原按「占用 + 模型 catalog maxTokens > 窗口」触发压缩，deepseek-v4（maxTokens=384K）在 1M 窗口下 61.6% 占用就被提前压缩，浪费长上下文。经查证 pi 自身（reserveTokens 固定 16384）与 Claude Code（固定 33K autocompact buffer）均为固定小预留，且 pi-ai 请求层已把 max_tokens clamp 到「窗口 − 占用 − 4096」，输出空间无需 kernel 按上限预留。改为固定预留 33K，判断逻辑抽为纯函数 `shouldCompactBeforeSend`；缓存简化为 modelId → contextWindow。
- 影响范围：`packages/kernel/src/auto-compact.ts`（新增）、`packages/kernel/src/agent-manager.ts`；测试 `src/__tests__/auto-compact.test.ts`（新增 5 用例，含「不再按 maxTokens 预留」回归）。

## 2026-08-17 — feat(kernel): /api/settings/share 读写路由（产物分享任务 6）

- kernel settings 路由新增 GET/PUT `/api/settings/share`：GET 返回 `{ share }`（未配置时回退默认 `token:""`、`channel:"edgeone"`），PUT 读 `body.share` 经 `saveShareSettings` 写盘（read-modify-write 保留其他字段）。复用既有 `loadShareSettings`/`saveShareSettings`；RouteContext 新增可选 `settingsFile` 供测试注入 tmpdir 隔离真实 settings.json（生产缺省仍走真实文件）。
- 影响范围：`packages/kernel/src/routes/settings.ts`、`packages/kernel/src/routes/types.ts`；测试 `tests/settings-share-route.test.ts`（GET 默认值、PUT 往返、PUT 后 loadShareSettings 生效）。

## 2026-08-17 — fix(frontend): 发送消息/收到回复后 lastActivity 未刷新（回归）

- 上一条「点击查看不再更新 lastActivity」仅删除了前端 `selectSession` 乐观更新，但未补上「发消息/收回复时同步」的机制：kernel 始终正确 touch 磁盘（agent:prompt 与 message_end），但 `touchSession` 只落盘不广播，前端 store 收不到新值，界面时间/排序停滞。修复：新增 `useProjectsStore.touchSession(id)`（置 Date.now()），在 `Composer.doSend`（发送 agent:prompt）与 `session.ts` 的 `message_end` 分支（收到回复结束）调用。
- 影响范围：`packages/frontend/src/store/projects.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/Composer.tsx`；测试 `tests/store-projects.test.ts`（touchSession 更新/不存在 id 安全 2 用例）、`tests/session-message-update-batcher.test.ts`（message_end 触发 lastActivity 更新）。

## 2026-08-17 — fix(kernel): 分享部署失败感知 + 轮询间隔注入 + upload 错误处理

- 产物分享任务 5 修复：deployShare 轮询改为轮询至终态后校验最终 Status 必须为 Success，Failed/Error 等失败终态抛错（`EdgeOne 部署失败: <Status>`），不再返回失败链接；新增可选 `pollIntervalMs`（缺省 5000ms）注入轮询间隔，测试传 1 让单测毫秒级完成；POST /api/share/upload handler 包 try/catch 兜底返回结构化 `{ error }` + 500（避免裸 500）。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/src/routes/share.ts`；测试 `tests/share-routes.test.ts`（新增 delete、zip 多选 2 用例，各用例注入 pollIntervalMs=1）。

## 2026-08-17 — feat(kernel+frontend): 点击查看会话不再更新最后激活时间（只有发消息/收回复才算活跃）

- 需求：查看会话不应把「最后激活时间」顶到当前。移除两处「点击/打开即 touch lastActivity」的逻辑：前端 `selectSession` 的乐观更新（projects.ts，仅保留选中切换）、kernel `session:messages` 里的 `touchSession`（ws-server.ts）。发消息 `agent:prompt` 与收回复 `message_end` 的 touch 更新保留。`session:messages` 的 `isDeleted`/`isScheduler` 守卫仍用于 `prewarm`（拉起 pi 进程），未删。
- 影响范围：`packages/frontend/src/store/projects.ts`、`packages/kernel/src/ws-server.ts`；测试 `tests/store-projects.test.ts`（selectSession 断言改为不更新）、`tests/session-messages.test.ts`（普通会话查看也不再 touch）。

## 2026-08-17 — fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）

- `_autoCompactIfNeeded` 原按「占用 + 模型 catalog maxTokens > 窗口」触发压缩，deepseek-v4（maxTokens=384K）在 1M 窗口下 61.6% 占用就被提前压缩，浪费长上下文。经查证 pi 自身（reserveTokens 固定 16384）与 Claude Code（固定 33K autocompact buffer）均为固定小预留，且 pi-ai 请求层已把 max_tokens clamp 到「窗口 − 占用 − 4096」，输出空间无需 kernel 按上限预留。改为固定预留 33K，判断逻辑抽为纯函数 `shouldCompactBeforeSend`；缓存简化为 modelId → contextWindow。
- 影响范围：`packages/kernel/src/auto-compact.ts`（新增）、`packages/kernel/src/agent-manager.ts`；测试 `src/__tests__/auto-compact.test.ts`（新增 5 用例，含「不再按 maxTokens 预留」回归）。

## 2026-08-17 — feat(kernel): 分享上传编排（deployShare）+ /api/share/* 路由

- 产物分享功能：补全 share/edgeone-client.ts 的 deployShare 总入口（探测端点 → 建/取项目 → DescribePagesCosTempToken 拿 COS 临时凭证 → 上传 zip（多选）或单文件 → CreatePagesDeployment（DistType Zip|Folder）→ DescribePagesDeployments 轮询至非 Process（每 5s，最多 40 次）→ getPresetDomain + encipherUrl 拼分享链接，返回 { url, projectName, projectId, expiresAt: now+3h }）。COS 客户端经 cosFactory 注入（测试传 fake），否则 new cos-nodejs-sdk-v5 实构；新增 cos-nodejs-sdk-v5 依赖。
- 新增 routes/share.ts：createShareRoutes 工厂（POST /api/share/upload 校验 paths/token 非空、多选 buildZip、调 deployShare、appendShare 写 history；GET /api/share/list；POST /api/share/delete；导出 commonRoot）。handler 内每次请求 loadShareSettings 读最新 token/channel（保存后无需重启），cfg 作 fallback/测试注入，并支持 cosFactory/settingsFile 注入。ws-server registerRoutes 注册分享路由（share-history.json 落 WA_PI_DIR）。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/src/routes/share.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/package.json`（新增 cos-nodejs-sdk-v5）；测试 `tests/share-routes.test.ts`（mock 全局 fetch + cosFactory fake，上传全链路/空 paths/token 空/list 4 用例）。

## 2026-08-17 — feat(kernel): EdgeOne REST 客户端（探测/项目/encipher）

- 产物分享功能：新增 share/edgeone-client.ts（从 POC 移植的可单测纯函数）——detectBaseUrl 遍历 china/global 端点取首个 Code===0 的可用地址；apiCall 统一 POST + Bearer token 校验 HTTP 状态与业务 Code；getOrCreateProject 按名查询、存在即返回、否则 CreatePagesProject 后返回 ProjectId（重查兑底）；getPresetDomain 取项目的预设域名；encipherUrl 用 DescribePagesEncipherToken 拼 eo_token/eo_time 分享链接。分享总入口 deployShare（上传/部署/轮询）留待任务 5。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/tests/edgeone-client.test.ts`（mock 全局 fetch，3 用例）。

## 2026-08-17 — feat(kernel): 多选路径 zip 打包 + path hash

- 产物分享功能：新增 share/pack.ts（多选路径用 fflate 打包 zip、文件夹递归展开、路径相对 root 保持；hashPaths 生成 sha256 hex 前 12 位作为项目名后缀）；引入 fflate 依赖。
- 影响范围：`packages/kernel/src/share/pack.ts`、`packages/kernel/tests/share-pack.test.ts`、`packages/kernel/package.json`（新增 fflate）。

## 2026-08-17 — feat(kernel): 子代理委托超时 30→60 分钟，工具执行看门狗 5→10 分钟

- 超长子代理委托场景：将子代理委托整体硬上限（RPC 命令超时 + settle 兜底超时）由 30 分钟调至 60 分钟，支持特别久的子代理任务；并把重复的字面量 `1_800_000` 抽成命名常量 `COMMAND_TIMEOUT_MS = 60 * 60_000`（与 `LIVENESS_IDLE_MS`/`ABORT_GRACE_MS` 风格一致，避免将来两处漏改）。
- 工具执行看门狗（无进展探活）默认超时由 5 分钟调至 10 分钟（`LIVENESS_IDLE_MS = 10 * 60_000`），降低长工具静默等待（如等外部 API / 长编译）被误判卡死的概率；工具执行中仍不豁免，持续流式输出刷新计时逻辑不变。
- 影响范围：`packages/kernel/src/subagent-runner.ts`（`COMMAND_TIMEOUT_MS` 常量 + `LIVENESS_IDLE_MS` 值 + 接口/注释同步）；测试 `tests/subagent-runner.test.ts`、`tests/delegate-tool.test.ts` 全部通过（57 例，行为测试均注入短超时值驱动，不受默认值影响）。

## 2026-08-17 — feat(kernel): settings 支持 shareToken/shareChannel

- 产物分享功能的基础配置：settings-store 新增 share 配置段的读写（token + channel，默认 channel=edgeone，token 为空），read-modify-write 保留 settings.json 内其他字段；补 writeSettingsJson helper（带 mkdir recursive）。
- 影响范围：`packages/kernel/src/settings-store.ts`；测试 `tests/settings-share.test.ts`（默认值 + save/load 往返一致 2 用例）。

## 2026-08-17 — fix(kernel): 重名 slug provider 模型窗口落默认值导致 ~122K 误触发自动压缩

- providers.json 中两个 provider 解析为同一 slug（如两个 opencode-go）时，`ensureProviderExtensionRegistered` 构建目录查询 map 用未去重的 `resolveProviderSlug(p, [])`，与 `generateProviderExtension` 内部的 `slugifyProviders`（去重为 opencode-go-2）不一致，第二个 provider 的模型查询全部落空；且 `generateProviderExtension` 的 fallback 是写死的 DEFAULT_SDK_MODEL（128000/16384）而非用户配置——注释宣称"找不到则 fallback 到用户配置"，代码从未如此。结果：用户配置 1M 窗口的模型（OpenCode Go 1 / deepseek-v4-flash）在生成的 extension 里落成 128000，pi 按 `128000 − 16384` 阈值在 ~122K 提前自动压缩（线上证据：会话 s-b99bc7fa 于 121972 tokens 触发）。
- 修复：`ensureProviderExtensionRegistered` 改用 `slugifyProviders` 的去重 slug 构建 map；`lookupSdkModel` provider 过滤未命中时回退裸 id 匹配（派生 slug 在目录中不存在）；`generateProviderExtension` 的 contextWindow/maxTokens 回退链改为 目录 → 用户配置 → 默认值。修复后 opencode-go-2 正确生成 1000000/384000/reasoning: true（此前 128000/16384/false，cost 也全 0）。
- 影响范围：`packages/kernel/src/provider-extension.ts`；测试 `tests/provider-extension.test.ts`（更新"SDK 查找不到"断言为用户配置兜底，新增重名 slug 单元回归 + 真实目录集成回归 2 用例）。

## 2026-08-17 — refactor(frontend): 附件/录音按钮 emoji 改为 SVG 图标

- 输入框底部的附件按钮 📎 与录音按钮 🎙 由 emoji 文本改为统一 SVG 图标（复用 Icon 库已有 `paperclip` / `mic` 图形），视觉与全局图标体系对齐、避免 emoji 跨平台渲染差异。颜色/hover/disabled 态仍由外层 className 控制（Icon 继承 currentColor）。
- 影响范围：`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/components/ui/RecordButton.tsx`；测试 `ComposerInput.test.tsx`、`tests/RecordButton.test.tsx`（新增 SVG 图标渲染断言）。

## 2026-08-17 — chore(release): 发布版本 0.2.5

- 打包发布 0.2.5（mac + win）：原生系统对话框（附件选文件/技能目录/打开文件夹）、任务模型与超时改进、IM 推送重连等待、文件树默认打开、设置弹窗关闭按钮等。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-17 — feat(kernel): 自动化任务执行超时 5 分钟 → 30 分钟

- 定时任务单次执行最长等待由 5 分钟调至 30 分钟（index.ts executeTask 的 MAX_WAIT_MS），超时仍 abort 会话进程并记录「任务执行超时（30 分钟）」。
- 影响范围：`packages/kernel/src/index.ts`（MAX_WAIT_MS + 错误文案）、`packages/kernel/src/routes/scheduler.ts`（立即执行接口注释同步）。

## 2026-08-17 — feat(frontend): 项目文件树右键文件增加「默认方式打开」

- 项目文件树（ExplorerPanel）右键文件弹出的菜单新增「默认方式打开」项，用系统默认应用打开该文件（macOS open / Windows start / Linux xdg-open），仅对文件显示、目录不显示。能力复用已有的 fs-client `openFileWithDefaultApp`（POST `/api/fs/open-with-default-app`），无需改 kernel/desktop。
- 影响范围：`packages/frontend/src/components/ExplorerPanel.tsx`；新增测试 `ExplorerPanel.test.tsx`（右键文件点击调用 + 目录不显示两项断言）。

## 2026-08-17 — fix(kernel): IM 推送前校验连接状态，断线时等待重连

- 定时任务 @im-push-to 主动推送此前只校验 adapter 对象是否存在，不校验实时连接状态；IM 掉线时推送照发，SDK 因 ws.readyState !== OPEN 直接抛错导致推送失败。现推送前校验 `statuses` 实时状态，非 connected 则等待 SDK 自动重连（默认 60s 超时，超时判失败并回填执行记录）。
- 影响范围：`packages/kernel/src/channel-manager.ts`（新增 statusWaiters/waitForConnected/notifyStatusWaiters，pushToContact 加校验）、`packages/kernel/src/channels/mock-adapter.ts`（setStatus 改 public 供测试模拟断线）；测试 `channel-manager.test.ts`（新增断线等待重连、超时抛错 2 用例）。

## 2026-08-17 — feat: 自动化任务新增「使用的模型」配置项

- 新建/编辑自动化任务时可指定运行时模型（下拉：首项「跟随默认」+ 具体 providerSlug/modelId），参考 IM 渠道机器人设置的模型下拉。留空（null/undefined）= 跟随默认（第一个 provider 的第一个模型）。
- 数据链路：`ScheduledTask.model?: string | null`（shared/types.ts）→ 路由校验/透传（routes/scheduler.ts，model 非字符串→400，null 归一为 undefined 存储）→ 执行时 `resolveTaskModel(task.model, providers)` 优先用任务模型（scheduler.ts 新纯函数，index.ts executeTask 调用）。
- 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/routes/scheduler.ts`、`packages/kernel/src/scheduler.ts`、`packages/kernel/src/index.ts`、`packages/frontend/src/components/automation/TaskEditForm.tsx`；测试 `routes-scheduler.test.ts`、`scheduler.test.ts`、`TaskEditForm.test.tsx`。

## 2026-08-17 — fix(frontend): 设置弹框补充显式关闭按钮

- 设置弹框（SettingsModal）标题栏此前只有标题文字，关闭只能靠点击遮罩或 ESC，不符合用户常识。在标题栏右侧补一个 X 关闭按钮（`<Icon name="x">`，`aria-label` 走 `common.close`，`data-testid="settings-close"`），与回收站弹框（RecycleBinModal）标题栏风格一致。
- 影响范围：`packages/frontend/src/components/SettingsModal.tsx`；新增测试 `packages/frontend/src/components/SettingsModal.test.tsx`（断言关闭按钮渲染 + 点击触发 onClose）。

## 2026-08-17 — feat(desktop+frontend): 附件/技能目录/新建项目改用系统原生对话框

- 三处目录/文件选择在 Electron 下改用系统原生对话框：① 附件「选择要发送的文件」（`dialog.showOpenDialog` 多选文件）；② 技能「添加目录」（选目录）；③ 新建项目选工作目录（选目录，两入口 ProjectList/EmptyState 均生效）。浏览器环境全部回退到内置文件/目录树。另：技能目录新增「打开技能文件夹」按钮（`shell.showItemInFolder` 在系统文件管理器定位）。此前 Electron 层完全未封装 `dialog`/`shell`，文件选择走 web 控件、定位走 kernel spawn 系统命令。
- 影响范围：新增 `packages/desktop/src/util/native-dialogs.cjs`（依赖注入封装，注册 `dialog:open-files`/`dialog:open-directory`/`shell:show-item-in-folder` 三个 IPC）；`packages/desktop/src/main.cjs`（require dialog/shell 并调用）、`packages/desktop/src/preload.cjs`（暴露 `waPiApp.showOpenFileDialog`/`showOpenDirectoryDialog`/`showItemInFolder`）；`packages/frontend/src/util/clipboard.ts`（waPiApp 类型声明）；`packages/frontend/src/components/ui/ComposerInput.tsx`（📎 原生优先回退）、`packages/frontend/src/components/settings/SkillSection.tsx`（添加目录原生优先回退 + 打开文件夹按钮）、`packages/frontend/src/store/projects.ts`（createProjectFromDir 原生优先回退）、`packages/frontend/src/i18n/locales/zh.ts`/`en.ts`（新增 skill.openDir）。测试：`native-dialogs.test.ts`、`SkillSection.test.tsx`、`ComposerInput.test.tsx`（新增）；`store-projects.test.ts`（新增 createProjectFromDir 原生/回退/取消三用例）。

## 2026-08-17 — feat(frontend): 自动化任务新建弹窗 @IM联系人 支持群

- 「自动化 → 任务 → 新建任务弹窗」的 @联系人选择器此前只展示 person（`TaskPromptComposer.tsx` 中 `if (c.kind !== "person") continue` 过滤掉了群），现放开为 person + group 均可 @；群名取 chatId 前 8 位展示（对齐通讯录面板 ContactsPanel 的 label）。后端推送链路（pushToContact / im_push_to）本就支持群，无需改动。
- 联系人/群图标统一改 SVG：弹窗列表用 `<Icon name="user|users">`（Icon 库新增 `user` / `users` 两个图形），输入框内已插入的联系人 chip 也从硬编码的「人形剪影」改为 `iconSvg("user"|`users`)` 区分人/群（`prompt-tokens.ts` 的 `ContactChipMeta` 新增 `kind` 字段，删除 `PERSON_ICON_SVG`）。
- 影响范围：`packages/frontend/src/components/automation/TaskPromptComposer.tsx`、`packages/frontend/src/components/automation/prompt-tokens.ts`、`packages/frontend/src/components/ui/Icon.tsx`；测试 `TaskPromptComposer.test.tsx`、`prompt-tokens.test.ts`（新增群展示/选中/群 chip 名/图标 SVG 断言）。

## 2026-08-17 — chore(release): 发布版本 0.2.4

- 打包发布 0.2.4（mac + win 完整覆盖 OSS）：修复模型不可用（404）baseUrl 匹配（Provider 缺 /v1 + 同名模型污染，含测试连接）+ 新建会话页默认工作区隐藏文件浏览按钮。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-17 — fix(frontend): 新建会话页默认工作区隐藏文件浏览按钮

- 修正 2026-08-16 的空态方案：默认工作区（**system**）的 cwd 是 workdir 父目录（内部会话目录，非项目文件），原「走空态」仍保留右上角可点击的文件夹按钮，点击后展开空态反而误导用户。改为对默认工作区直接隐藏入口按钮（而非禁用），与「无项目」场景区分。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`；测试 `new-session-explorer.test.tsx`（默认工作区用例由「空态」改为「隐藏按钮」）。

## 2026-08-17 — test(frontend): VersionTimeline maxEntries 断言跟随 version-history 推进

- 发版 0.2.3 时 version-history.json 已推进到 0.2.3，但 maxEntries 截断测试仍硬编码旧版本号（0.2.1 + 0.1.26），导致前端全量测试 1 例失败。更新断言为当前最新 2 条（0.2.3 + 0.2.2），第 3 条（0.2.1）不渲染。
- 影响范围：`packages/frontend/src/components/settings/VersionTimeline.test.tsx`。

## 2026-08-16 — fix(frontend): 新建会话页文件侧栏对默认工作区不再列出 workdir 内部目录

- 根因：默认工作区（**system**）项目的 cwd 是 `~/.pi/agent/workdir` 父目录（存放每个会话的独立内部目录，可积累数千个子目录）。新建页点右上角「项目文件」开关展开侧栏时，ExplorerPanel 一次性 listDir + 排序 + 渲染全部子目录，主线程长时间阻塞、界面卡死空白（用户感知为「窗口消失」），5 秒轮询反复触发。会话页（SessionView）不受影响——其文件树根目录是 `workdir/<会话时间戳>` 具体会话目录。
- 修复：NewSessionPane 对默认工作区项目返回空 workspaceDir，让侧栏走空态（文案按 projectId 有无区分：默认工作区显示「未设置工作目录」，真正无项目显示「无项目，请先新建」）。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`；测试 `new-session-explorer.test.tsx`（新增默认工作区空态用例）。

## 2026-08-16 — chore(release): 发布版本 0.2.3

- 打包发布 0.2.3：文件修改清单新功能 + 文件预览路径解析修复。产物 `WaPi-Setup-0.2.3.exe` 已上传 OSS（latest.yml 注入 releaseNotes）。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-16 — fix(desktop): publish-oss 注明 --no-proxy 在 Bun 下不生效

- ali-oss 静态 import 早于清代理执行，脚本内 delete 对已缓存代理配置不生效；动态 import 在 Bun 顶层 await 下分片上传会超时。保留静态 import + --no-proxy（尽力而为），注释说明推荐命令行清代理（HTTPS_PROXY= HTTP_PROXY= ... bun run ...）。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-16 — chore(release): 发布版本 0.2.2

- 打包发布 0.2.2：ask bridge 偶发断开重试修复 + 发送前自动压缩防护。产物 `WaPi-Setup-0.2.2.exe` 已上传 OSS（latest.yml 注入 releaseNotes）。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-16 — fix(kernel): ask bridge 偶发断开后自动重试（最多 5 次、间隔 1 秒）

- pi 侧 fetch 的 socket 可能被 Bun 非确定性清理（GC/keep-alive），导致 ask 的 bridge 长连接偶发断开（报 "socket connection was closed unexpectedly" 或 "连接中断（未收到 final 帧）"），提问提前失败——此问题自 ask 功能引入起一直存在。修复：callBridge 对可重试的断开（socket closed / socket hang up / 连接中断）自动重试，最多 5 次、间隔 1 秒；重试前校验 signal 未 abort（ask 仍有效），用户取消/工具中止时不无谓重试。
- 配套：ask 断开后条目保留（disconnected 标记）供重试复用，避免重试时重复弹卡片；用户回答/取消才真正移除条目；一轮对话结束（agent_settled）清空会话 ask 条目防泄漏。`pendingToolCallIds` 只返回真实 pending（过滤 disconnected），前端 double-check 不看到失效卡片。
- 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`（callBridge 加重试 + isRetryableDisconnect + 常量）、`ask-registry.ts`（断开保留 + 复用 + clearSession + pendingToolCallIds 过滤）、`agent-manager.ts`（agent_settled 清空会话 ask）；测试 `bridge-extension.test.ts`（3 个用例）、`ask-registry.test.ts`（3 个用例）。

## 2026-08-16 — feat(kernel): 发送前自动压缩防护 POC（超限自动 compact 后继续发送）

- DeepSeek 等「输入+输出共用上下文窗口」的模型，maxTokens（如 deepseek-v4-flash 的 384000）会作为每次请求的输出预留，与输入 token 叠加超过窗口时（如 748k + 384k > 1M）触发 400。而 pi 的 auto-compaction 用 reserveTokens=16384 判断，触发太晚，中间存在「压缩不触发但已超限」的危险区间。
- POC：`_sendPromptNow` 发送 prompt 前，查当前模型 contextWindow/maxTokens（进程内缓存）+ get_session_stats.contextUsage，若 `used + maxTokens > contextWindow` 先自动 `compact()` 再继续发送。压缩失败不阻断发送（退回现状，让原消息走正常错误渲染）。
- 影响范围：`packages/kernel/src/agent-manager.ts`（新增 `_autoCompactIfNeeded` + 模块级 modelMetaCache，`_sendPromptNow` 插入调用）；测试 `agent-manager.test.ts`（drain 用例改异步等待）+ `fixtures/fake-session-client.ts`（补 getSessionStats）。

## 2026-08-16 — feat: 回复底部新增文件修改清单

- 每轮对话结束后，assistant 回复底部追加「文件修改清单」：按文件去重、标注新增/修改、点击文件名打开内置预览、展开显示本轮「首次编辑前 → 末次编辑后」的整文件行级 diff（同一行多次修改自动合并为一次净变化）。新增/过大/失败三种情况降级为只显示文件名 + 点击预览。
- 实现：pi 扩展经 tool_call/tool_execution_end/agent_end 钩子采集文件前后快照 → POST /bridge/file-changes → kernel 广播 file_changes 事件 → 前端 FileChangeSummary 组件（react-diff-viewer-continued 渲染 diff）。仅最后一条消息渲染，避免多轮重复错位。
- 影响范围：shared/types.ts、kernel wa-pi-bridge.extension.ts + file-snapshot.ts + bridge-extension.ts + agent-manager.ts + ws-server.ts、desktop build-kernel-sidecar.ts、前端 session.ts + FileChangeSummary.tsx + MessageList.tsx + i18n/locales。

## 2026-08-15 — fix(desktop): publish-oss 清代理改为 --no-proxy 参数（默认保留代理）

- 上一条无条件清代理会让想走代理的环境也用不了；改为加 `--no-proxy` 参数时才清代理（默认保留代理，向后兼容）。OSS 国内节点直连、走代理分片上传会 socket 关闭。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-15 — fix(desktop): publish-oss 上传前清除代理（OSS 直连）

- 系统代理（Clash 等）会拦截 ali-oss 上传，大文件分片上传时 socket 被意外关闭。OSS 是国内节点（oss-cn-heyuan），直连即可；脚本上传前清除 HTTP(S)_PROXY 环境变量。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-15 — fix(desktop): linux AppImage 可执行文件名修复

- desktop 包名 `@wa-pi/desktop` 归一化成 `@wa-pidesktop`，AppImage 可执行文件名含 `@`/`-` 不合法；显式指定 `linux.executableName=wa-pi-desktop`。
- 注：Windows 上打 AppImage 仍缺 mksquashfs（appimage 工具仅 Linux 版），全平台需在对应平台打包。
- 影响范围：`packages/desktop/electron-builder.yml`。

## 2026-08-15 — fix(desktop): 打包修复 registry-js 原生模块导致 sidecar 构建失败

- bun build 把读注册表的原生 addon `registry-js`（`os-proxy-config → windows-system-proxy → registry-js`）当 asset 输出，`--outfile` 报「多个输出文件」导致打包失败。
- 修复：kernel.js 构建加 `--external=registry-js`（不内联）；依赖清单加 `registry-js`（首启动态安装 .node）。
- 影响范围：`packages/desktop/scripts/build-kernel-sidecar.ts`。

## 2026-08-15 — revert(kernel/frontend): 撤销「网页端读注册表系统主题」实现

- 读 Windows 注册表（SystemUsesLightTheme）的方案被否决，撤销 kernel `readSystemTheme` + `GET /api/system-theme` + 前端轮询，回到浏览器原生 `prefers-color-scheme`（跟随应用主题）。
- Electron 端的 nativeTheme 修复保留（桌面版生效）。
- 影响范围：`kernel/src/{settings-store.ts,routes/settings.ts}`、`frontend/src/store/ui-prefs.ts`。

## 2026-08-15 — fix(kernel): readSystemTheme 跨平台——仅 Windows 读注册表，macOS/Linux 返回 null

- 上一条 `readSystemTheme` 非 Windows 兑底 light，会导致 macOS/Linux 系统深色时被错误覆盖成浅色。改为：仅 Windows 读 `SystemUsesLightTheme`；macOS/Linux 无「系统/应用」分离（prefers-color-scheme 即系统主题）返回 null，前端保持 prefers-color-scheme 不覆盖。
- 影响范围：`kernel/src/settings-store.ts`。

## 2026-08-15 — fix(kernel/frontend): 网页端「跟随系统」主题读系统主题（SystemUsesLightTheme）

- 上一条只修了 Electron 端（nativeTheme），但网页端（浏览器）prefers-color-scheme 同样只跟随「应用主题」，需 kernel 读 Windows 系统主题注册表键 SystemUsesLightTheme 通过 API 给前端。
- kernel 新增 `readSystemTheme`（reg 读 SystemUsesLightTheme）+ `GET /api/system-theme`；前端 `applyThemeMode(system)` 异步问 kernel 覆盖 prefers-color-scheme，并定时轮询跟随系统主题变化。
- 影响范围：`kernel/src/{settings-store.ts,routes/settings.ts}`、`frontend/src/store/ui-prefs.ts`。

## 2026-08-15 — fix(desktop): 「跟随系统」主题在 Windows 上跟随系统主题（而非应用主题）

- 前端 `prefers-color-scheme` 在 Windows 上跟随「应用主题」（AppsUseLightTheme），用户「跟随系统」实际跟随了应用主题（深色），而非系统主题（浅色）→ 点跟随基本都是暗色。
- 修复：Electron 主进程用 `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`（Windows 上区分系统/应用主题）同步 `themeSource`，使 prefers-color-scheme 对齐系统主题；监听 `updated` 持续同步。
- 影响范围：`packages/desktop/src/main.cjs`。

## 2026-08-15 — fix(frontend): 列表「测试连接」补传 slug（此前只修了弹窗入口）

- 76231a03 的 baseUrl 解析修复只改了编辑弹窗（ProviderForm）传 slug，漏了列表入口（ProviderSection.handleTest）→ 列表测试连接拿不到 slug，按 model id 匹配跨 provider 污染 baseUrl，仍 401/404。
- 修复：`ProviderSection.handleTest` 也传 `p.slug`；新增 `ProviderSection.test.tsx` 锁定两个入口一致。
- 影响范围：`frontend/src/components/settings/ProviderSection.tsx`、`ProviderSection.test.tsx(新)`。

## 2026-08-15 — fix(frontend): 长任务完成整轮折叠时滚动位置跳动（看到的内容不在底部）

- **根因**：长任务执行中，进行中的轮（`isActiveTurnRow`=true，status=thinking 的末行 assistant）过程卡片展开，用户贴底看实时过程。agent_end 到达、status 归 idle → `isActiveTurnRow` 变 false → `canCollapse` 变 true → 过程卡片（thinking/toolCalls/delegate/fleet）折叠成 `TurnSummary`，末行高度骤减；Virtuoso 虚拟化行高测量有延迟，折叠瞬间 scrollTop 停在旧位置，且此时 `autoScrollActive` 已 false、200ms interval 停止兑底 → 用户看到的内容不在底部。
- **修复**：`MessageList` 在 `isActiveTurnRow` true→false（整轮折叠时刻）时，若用户贴底（`stickBottom`）则主动 `scrollToEnd()` 一次，抵消高度骤减、保持贴底。
- **测试（TDD）**：`MessageList.subagent-scroll.test.tsx` 新增 1 用例（整轮结束主动滚动到底部），先写失败测试（修复 stash 后 1 fail）、修复后 12/12 过；frontend 全量 1581/1581 过、typecheck 过。
- 影响范围：`frontend/src/components/MessageList.tsx`、`frontend/tests/MessageList.subagent-scroll.test.tsx`。

## 2026-08-15 — fix(kernel/frontend): opencode-go 测试连接 404（测试连接未用内置目录 baseUrl）

- e1e20c2b 只修了 extension 的 baseUrl（内置目录带 /v1），但「测试连接」仍用 providers.json 里不带 /v1 的旧值 → openai-completions 的 `GET {baseUrl}/models` 打 404。
- 修复：`provider:test` 对 openai-completions 用内置目录解析 baseUrl（新增 `resolveProviderBaseUrl` 纯函数，按 slug 过滤避免同名模型跨 provider 污染）；前端测试连接时传 slug。
- anthropic-messages 保持原样（baseUrl 不带 /v1，`testProviderConnection` 自己拼 /v1/messages）。
- 测试：`provider-extension.test.ts` 新增 `resolveProviderBaseUrl` 3 用例，33 过。
- 影响范围：`kernel/src/{provider-extension,routes/providers,ws-server}.ts`、`shared/src/providers.ts`、`frontend/src/{store/providers.ts,components/settings/ProviderForm.tsx}`。

## 2026-08-15 — chore(release): 发布版本号 0.1.27 → 0.2.1

- desktop 0.1.27 → 0.2.1，frontend 0.1.26 → 0.2.1（统一「关于」页与自动更新版本）
- version-history.json 时间线最新条目 0.1.27 → 0.2.1（latest.yml releaseNotes 实际注入源）
- RELEASE_NOTES.md 与 version-history.json 补全 0.2.1 完整发布说明（定时任务/通讯录/IM 推送/扩展修复/代理设置等 08-14~08-15 全部变更）
- VersionTimeline.test.tsx 断言同步 v0.2.1
- 影响范围：desktop/package.json、frontend/package.json、frontend/src/data/version-history.json、desktop/RELEASE_NOTES.md、VersionTimeline.test.tsx

## 2026-08-15 — chore(kernel): 升级 pi 0.84.2 + 启用 PI_EXPERIMENTAL

- **变更**：①`@earendil-works/pi-*` 全系升级 0.84.1 → 0.84.2（kernel/package.json + sidecar 打包脚本 build-kernel-sidecar.ts，消除 sidecar `^0.83.0` 滞后债）；kernel 显式声明 `pi-agent-core` 修复顶层版本分裂（此前 pi-memory 的 peer 解析到顶层 0.84.1，而 pi-coding-agent 嵌套 0.84.2）。②启用 pi 0.84.2 实验性严格 JSON-schema 约束采样（`process.env.PI_EXPERIMENTAL="1"`，index.ts 注入，经 rpc-client 的 process.env 展开自动覆盖主会话 + 子代理）。③sdk-errors.ts 同步 pi-ai 0.84.2 新增 retryable 文案 `exceeded request buffer limit`。
- **收益**：JSON/RPC message_update 流式 usage 累积修复、DeepSeek max_tokens 字段修复（v4-flash 新增 low 思考档）、Kimi 请求 UA 行为对齐、扩展工具结果长输出折叠、nanoid DoS 安全修复。
- **验证**：0.84.1 vs 0.84.2 双版本对比——kernel 全量测试失败数随机漂移（10→1，失败文件单跑全过，为既有并发 flaky）；frontend 1580/1580 全过；kernel typecheck 通过；E2E channels.spec 两版本结果一致（mock 全链路为既有失败，非回归）；E2E settings-provider 首用例为 onboarding 遮挡既有问题。
- 影响范围：`packages/kernel/package.json`、`packages/desktop/scripts/build-kernel-sidecar.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/sdk-errors.ts`。

## 2026-08-15 — fix(frontend): 修复 5 个既有测试失败（项目折叠断言 + font-scale 行尾 + maxEntries 版本号）

- **根因**：①「项目折叠」3 个失败——产品用 CSS `gridTemplateRows:0fr` 做折叠动画（DOM 始终存在），但测试用 `queryByText("会话1").toBeNull()` 断言「折叠不可见」，happy-dom 不做 CSS 布局、`0fr` 不隐藏 DOM → 断言失败；motion 动画 250ms transition/rAF 在 happy-dom 下 pending，掩盖为 timeout。②`styles-font-scale`——`styles.css` 是 CRLF 行尾，测试断言硬编码 LF，`toContain` 不匹配。③`maxEntries`——数据已推进到 0.1.27，测试写死旧版本号 0.1.24。
- **修复**：①`ProjectItem` 折叠容器加 `aria-expanded={expanded}` + `data-testid="project-sessions-{id}"`（同时改善可访问性），测试改断言该属性而非查 DOM 内容。②`styles-font-scale.test.ts` 读 CSS 后 `.replace(/\r\n/g,"\n")` 归一化行尾。③`VersionTimeline.test.tsx` 断言版本号对齐当前数据（0.1.27 + 0.1.26）。
- **验证**：frontend 全量 1580/1580 通过（0 失败）、typecheck 通过。
- 影响范围：`frontend/src/components/ProjectItem.tsx`、`frontend/tests/{ProjectList,ProjectItem.sort-menu,styles-font-scale}.test.tsx`、`frontend/src/components/settings/VersionTimeline.test.tsx`。

## 2026-08-15 — fix(kernel): provider extension 用内置目录 baseUrl（修 opencode-go 缺 /v1 且同名模型互相污染）

- **根因**：①opencode-go 的 `openai-completions` 模型（deepseek-v4-flash/pro 等）正确 baseUrl 是 `https://opencode.ai/zen/go/v1`（带 /v1），但 providers.json 里存的是不带 /v1 的 `https://opencode.ai/zen/go`（那是 anthropic-messages 模型的 baseUrl，被套用了）→ OpenAI SDK 拼 /chat/completions 后打 404；②`sdkModelMap` 原按 model id 建键，`deepseek-v4-flash` 同时存在于 deepseek 和 opencode-go，会匹配到错误 provider 的 baseUrl（opencode-go 被污染成 api.deepseek.com）。
- **修复**：`provider-extension.ts` extension 生成时优先用内置目录（按 provider slug 精确匹配）的 baseUrl，纠正 providers.json 里缺后缀的旧值；`sdkModelMap` 改用 `${slug}/${modelId}` 复合键避免同名模型跨 provider 冲突。
- **测试（TDD）**：`provider-extension.test.ts` 新增 2 用例（内置 baseUrl 优先纠正 /1v1、同名模型跨 provider 不污染），19/19 过；typecheck 通过；实测生成 opencode-go baseUrl = `https://opencode.ai/zen/go/v1`。
- 影响范围：`packages/kernel/src/provider-extension.ts`、`packages/kernel/tests/provider-extension.test.ts`。

## 2026-08-15 — fix(kernel): 修复 pi 子进程拿不到系统代理（Bun process.env 展开丢失代理变量）

- **根因**：Bun 的 `process.env` 对代理变量（`HTTP_PROXY`/`HTTPS_PROXY` 等）是 getter/setter，不在 `Object.keys(process.env)` 里，导致 `rpc-client` spawn pi 子进程时用 `{ ...process.env }` 展开丢掉了代理变量 → pi 引擎 `EnvHttpProxyAgent` 读不到 `HTTP_PROXY` → LLM 请求直连超时（被墙时）。
- **修复**：`rpc-client.ts` 新增 `collectProxyEnv()`，显式从 `process.env` 读取 8 个代理变量（大小写各 4 个）补进 spawn 的 `env`。
- **测试**：`tests/rpc-client.test.ts` 新增 3 用例（显式收集/未设置/大小写）；agent-manager/bridge/idle-reap 125 用例全过；typecheck 通过。
- 影响范围：`packages/kernel/src/rpc-client.ts`、`packages/kernel/tests/rpc-client.test.ts`。

## 2026-08-15 — feat(settings): 新增「使用系统代理」开关，全软件请求统一走系统代理

- 系统设置 > 通用 > 请求超时下新增「使用系统代理」开关：开启后 kernel 用 `os-proxy-config` 跨平台读系统代理（Windows 注册表 / macOS scutil / Linux 环境变量），设置大小写 `HTTP_PROXY/HTTPS_PROXY` 环境变量；关闭则清空恢复直连；读不到代理（DIRECT）静默直连。
- 覆盖所有请求无例外：pi 引擎 undici `EnvHttpProxyAgent`（LLM 请求）、kernel 的 Bun `fetch`（读大写环境变量）、`curl/wget`（读小写环境变量）均走代理。
- 后端：`settings-store` 加 `loadProxySettings/saveProxySettings/applySystemProxy/readSystemProxy`（基于 `os-proxy-config`）；`routes/settings` 加 `GET/PUT /api/settings/proxy`（保存即 `applySystemProxy` + `markAllDirty` 重建 pi 进程）；`index.ts` 启动时 `applySystemProxy`。
- 网页端兼容：读系统代理在 kernel 端完成（`os-proxy-config` 是纯 Node API + native addon，实测 Bun 可加载），不再依赖 Electron IPC——前端只传开关 `useSystemProxy`，`httpProxy` 由 kernel 兑底读系统代理。
- 依赖：kernel 新增 `os-proxy-config@^1.1.2`（HTTP Toolkit 出品，跨平台读系统代理）。
- 测试（TDD）：`settings-proxy.test.ts` 7 用例（默认/持久化/保留字段/大小写设置/清空/DIRECT/readProxy 兑底）；`GeneralSection.test.tsx` 新增 2 用例。kernel + frontend typecheck 均过。
- 影响范围：`shared/types.ts`、`kernel/settings-store.ts`、`kernel/routes/settings.ts`、`kernel/routes/types.ts`、`kernel/ws-server.ts`、`kernel/index.ts`、`kernel/package.json`、`frontend/GeneralSection.tsx`、`i18n/zh.ts`、`i18n/en.ts` 及对应测试。

## 2026-08-15 — fix(frontend): IM 会话顶部回填修复备注空字符串时不回退的 bug

- 回填用 `??`（nullish），备注为空字符串 `""`（清空过备注）时不会回退到联系人标识，导致回填空；改为 `||`（truthy），与顶部 display 判断一致（空字符串视为无备注）。
- 测试：新增「备注空字符串回填联系人标识」用例（15/15 过）；e2e 铅笔编辑用例加断言「点铅笔回填原始标识（chatId）」，单聊回填验证通过。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`、`e2e/channels.spec.ts`。

## 2026-08-15 — fix(frontend): 项目列表展开改用 grid 高度动画（平滑展开，不再瞬间插入）

- 上一条 fix 去掉会话 opacity + 根节点 layout，但「项目名瞬间出现」未解决（会话列表仍瞬间插入占据高度）。改为给会话列表容器加 `grid-template-rows` 0fr→1fr 高度展开动画（250ms），展开/折叠时高度渐变、下方项目随之逐渐位移，消除「瞬间插入」。
- 去掉 `AnimatePresence`（grid 动画替代 enter/exit）；会话项保留 `layout` FLIP 重排动画；根节点恢复普通 div。
- 影响范围：`packages/frontend/src/components/ProjectItem.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔回填与顶部标题同源（单聊用 chatId）

- 顶部标题（title）单聊用 `chatId`（`IM · ${chatId.slice(0,12)}`），但回填之前用 `fromUserId`，两者在 fromUserId 为空（如 mock 注入未传 fromUserId）时不一致，导致标题显示 xiaoxiaolu 但回填空。改为回填与 title 同源：单聊兑底 `contact.userId ?? imConv.chatId ?? fromUserId`，群聊 `chatId 前 8`。
- 测试：新增「联系人 userId 为空时兑底回填 chatId」用例，14/14 过。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — feat(frontend): 任务详情「最近执行」列表整行可点进详情 + 详情按钮移到最后

- `RecordRow` 整行加 `onClick` 进详情（`cursor-pointer` + `data-testid`），「详情」按钮从内容区移到行末（最右），点击时 `stopPropagation` 避免重复触发。
- 测试（TDD）：`TaskDetailView.test.tsx` 新增 1 用例（点击整行触发 openRecordDetail），13/13 过。
- 影响范围：`packages/frontend/src/components/automation/TaskDetailView.tsx`、`__tests__/TaskDetailView.test.tsx`。

## 2026-08-15 — feat(automation): 执行详情显示执行角色与使用模型

- 执行记录（`ExecutionRecord`）新增 `agentId`（执行角色/智能体）与 `model`（实际使用模型 provider/modelId）字段；`executeTask` 落盘时写入两者。
- 执行详情页 header 元信息展示 🤖 角色 + 🧠 模型（旧记录无该字段则不显示）。
- 测试（TDD）：`ExecutionDetailView.test.tsx` 新增 1 用例（显示角色+模型），5/5 过；后端 scheduler 33/33 过；frontend/kernel typecheck 均过。
- 影响范围：`shared/src/types.ts`、`kernel/src/index.ts`、`frontend/src/components/automation/ExecutionDetailView.tsx`、`__tests__/ExecutionDetailView.test.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔无联系人记录时也回填原始标识

- 上一条 fix 仅在联系人已存在时回填 userId/chatId，首次对话（无联系人记录）时仍回填空。改为无联系人时也从 imConv 兑底回填（person=fromUserId / group=chatId 前 8），与顶部显示的技术标题一致。
- 测试：新增 2 用例（无联系人单聊回填 fromUserId / 群聊回填 chatId 前 8）；「清空输入后失焦不创建联系人」用例同步调整。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — fix(frontend): 项目列表展开时消除项目名与会话动画不一致导致的短暂重叠

- 会话列表原叠加 opacity 淡入（initial/animate/exit），展开时半透明会话项与实色项目名叠透，配合下方项目瞬时跳位，产生短暂重叠。改为与「最近」视图一致：会话项只保留 layout FLIP 位移动画，去掉 opacity 淡入淡出。
- 项目项根节点（含项目名）改 `motion.div layout="position"`，展开/折叠时下方项目 FLIP 平滑位移，消除「瞬时跳位」的突兀。
- 影响范围：`packages/frontend/src/components/ProjectItem.tsx`。

## 2026-08-15 — fix(frontend): 点击「立即执行」后执行记录列表/状态点不即时刷新

- **根因**：点「立即执行」后，kernel `executeTask` 一开始就写入 running 态执行记录并广播 `scheduled-tasks:changed`，但前端该事件只刷新任务列表（loadTasks），不刷新执行记录（loadRecords）——只有执行完成广播 `scheduled-task:completed` 时才刷新。导致 running 态记录、侧边栏状态点（⟳）都不即时显示。
- **修复**：`scheduled-tasks:changed` 事件处理补上 `loadRecords()`，与 `scheduled-task:completed` 一致，执行开始即可见 running 态。
- 影响范围：`packages/frontend/src/App.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔编辑无备注时回填联系人标识

- 点铅笔进入行内编辑时，联系人存在但无备注名的情况下，输入框原回填为空，改为回填联系人标识（person=userId / group=chatId 前 8 位），与通讯录面板 `ContactsPanel` 的回填逻辑一致。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — refactor(kernel): 定时任务推送引导改注入 system prompt（不拼进任务指令）

- **引导位置迁移**：`@im-push-to` 标记的语义澄清（非智能体引用勿 delegate + 用 im_push_to 工具推送）原由 `buildSchedulerPrompt` 拼进任务指令（prompt）末尾，现改为在 agent 启动时注入 **system prompt 的 im-push 段**。
- **新段机制**：`system-prompt.ts` 新增 `im-push` 动态段（模仿 im-channel 段：运行时注入、不落盘、savePromptSegments 剔除、ensureImPushSegment 运行时补回、位置在 im-channel 之后 / memory-policy 之前）；`PROMPTS_SCHEMA_VERSION` 25→26。
- **接线**：`agent-manager._createSession` 当 `imPush.targets` 非空时用 `buildImPushSystemPrompt(targets)` 填充 `imPushContext` 注入 composePrompt；`index.ts` executeTask 不再拼 prompt，直接发 `task.prompt`（技能展开逻辑保留）。`buildSchedulerPrompt` 更名 `buildImPushSystemPrompt`（返回系统提示文本，空目标返回空串）。
- 影响范围：`kernel/src/{system-prompt,agent-manager,tools/robot-push,index}.ts`；测试 `robot-push.test.ts`（buildImPushSystemPrompt 新契约）、`system-prompt-im-push.test.ts`（新段 5 用例）、`system-prompt.test.ts`（落盘过滤加 im-push）、`system-prompt-im-channel.test.ts`（schema 26）。

## 2026-08-15 — feat(kernel/frontend): IM 会话顶部铅笔编辑通讯录备注名

### 变更

- **交互**：IM 会话聊天顶部标题（原为「IM · u1」技术标题）右侧新增铅笔图标，点击进入行内编辑通讯录备注名；默认显示技术标题，编辑后显示「IM · 备注名」（清空备注则回退技术标题）。
- **自动补建**：当前正在聊的联系人若尚未进通讯录，点铅笔保存时自动 `ensureContact` 补建后再 `renameContact`；无联系人且输入为空则不创建（避免点开又关产生空条目）。
- **kernel 链路**：`contact-store.ts` 新增 `ensureContact`（按 `channelId+kind+匹配键` 命中返回/未命中创建含 id，并发同键只建一条）；`channel-manager` 暴露 `ensureContact`；`ws-server` 新增 `contacts:ensure` 事件（空 channelManager→400、抛错→500、成功→reply `contacts:ensured`）；`routes/contacts.ts` 新增 `POST /api/contacts/ensure`；`shared/types.ts` 新增 `ContactsEnsureRequest`/`ContactsEnsureResult`。
- **前端 store**：`contacts.ts` 新增 `ensureContact` 方法 + `contactOf` 纯函数（按 channelId+kind+key 查完整联系人），`remarkOf` 改为复用 `contactOf`。
- **SessionView 集成**：`SessionView` 新增 `imConv` prop（IM 会话传入 `ChannelConversationInfo`），顶部标题 IM 会话时改用新 `ImSessionTitle` 组件；`App.tsx` 把 `imConv` 传入。
- 测试：kernel `contact-store` 3 用例 + `ws-server-contacts` 3 用例 + `routes-contacts` 1 用例；frontend `ImSessionTitle` 组件 10 用例；e2e `channels.spec.ts` 新增「铅笔编辑备注名（自动补建+持久化）」用例，并给首用例补 `saveProvider` 规避 onboarding 向导遮挡（既有 flaky）。
- 影响范围：`kernel/src/{contact-store,channel-manager,routes/contacts,ws-server}.ts`、`shared/src/types.ts`、`frontend/src/{store/contacts.ts,components/ImSessionTitle.tsx(新),components/SessionView.tsx,App.tsx}`、`frontend/e2e/channels.spec.ts`。

## 2026-08-15 — feat(kernel/frontend): 定时任务执行记录详情页（执行过程回放）

### 变更

- **kernel 只读回放**：`ws-server.ts` `session:messages` 处理器对 `source === "scheduler"` 的会话跳过 `touchSession` 与 `prewarm()`（事后回放不再拉起 pi 进程、不污染最近会话排序），jsonl 文件直读链路不变。
- **store 导航**：`scheduler.ts` `AutoView` 加 `"record-detail"`；新增 `selectedRecordId`/`recordDetailBackTo` 与 `openRecordDetail(id, from)`/`closeRecordDetail()`（来源快照回退：从执行记录页打开返回执行记录页，从任务详情打开返回详情）；`selectTask`/`startCreate`/`startEdit` 均重置 `selectedRecordId`。
- **ExecutionDetailView 组件**：拉取 `GET /api/sessions/:id/messages` 写入 session store，复用聊天 `MessageList` 同款渲染回放；边界态：无 sessionId「该记录无执行过程」（附执行错误）、会话不存在同文案、加载失败错误提示+重试。
- **两处入口**：`ExecutionRecords` 记录行整行可点+行尾「详情」按钮；`TaskDetailView` 最近执行 `RecordRow` 加「详情」按钮。`AutomationMain` 主区路由 `record-detail`（不套 overflow 容器，MessageList 自带虚拟滚动）。
- 测试：kernel `session-messages.test.ts` 新增 scheduler 会话只读 3 用例；frontend store 导航 6 用例 + 组件 4 用例；e2e automation 用例 5（REST 造任务+run 触发、写会话 jsonl、点详情断言回放与返回）。E2E 5/5 过（偏移端口 9796/5190）。
- 影响范围：`kernel/src/ws-server.ts`、`frontend/src/store/scheduler.ts`、`frontend/src/components/automation/{ExecutionDetailView(新),AutomationMain,ExecutionRecords,TaskDetailView}.tsx`、`frontend/e2e/automation.spec.ts`。

## 2026-08-15 — fix/feat(automation): 上述重构的验收反馈修复批次 + 计划类型扩展

- **标记前缀修正（解析全链路失效根因）**：标记第一段用真实渠道前缀 `ch_`（原实现误写 `bot_`，与 channel-manager 生成的 `ch_xxx` 不符，插入端与解析端前缀不一致导致 chip 原文直出、联系人卡恒显「无」）；kernel `robot-push.ts`、前端 `prompt-tokens.ts` 及全部 fixture 同步。
- **联系人 chip 视觉**：人形 SVG 图标 + 人名（Icon 表无人形图标，模块私有自造，currentColor 继承），不再显示原文标记/emoji；详情页 prompt 渲染改复用 `toPromptHtml`（与输入框 chip 一致）。
- **技能弹窗通用化**：列表体换聊天通用 `QuickInvokeMenu`（新增 `positionClassName` 定位覆写 prop，聊天侧零影响），补 ↑↓/Enter 键盘导航。
- **弹窗定位修复**：portal 容器显式宽度解除 fixed+w-full 循环依赖（宽度约束失效导致横向撑满屏幕）；锚点收窄到输入框（弹窗紧贴光标下方）；e2e 加宽度/位置断言锁回归。
- **表单可用性**：指令输入框补边框（裸 contenteditable 浅色下与背景融合看不出可输入）；时间输入框点击任意位置 `showPicker()` 弹选择器；AgentDropdown pill ▾ 图标 `ml-auto` 右对齐。
- **计划类型扩展（feat）**：`TaskSchedule.type` 新增 `minute`（`* * * * *`）/`hourly`（`m * * * *` 每小时第 m 分钟，复用 time 分钟段）；表单下拉/分钟选择器、详情页与侧边栏 formatSchedule 同步；周几/日期选择器 `w-full` 与上方同宽。

## 2026-08-15 — refactor(kernel/frontend)!: 自动化任务 @im-push-to 标记与技能 chip 重构

### 变更

- **联系人标记函数式化（功能未发布，无兼容负担）**：任务指令中 IM 推送标记由裸 `@ct_xxx`/`@bot_xxx` 改为 `@im-push-to(ch_xxx,ct_xxx)`（第一段为联系人所属渠道 id，信息性保留，路由以联系人自身 channelId 为准）。带 `@` 前缀与 `@agentName`（delegate 智能体引用）区分，工具描述与系统提示文案均含「不要对其调用 delegate」澄清。
- **kernel 链路**：`robot-push.ts` 重写（`parseImPushMentions` 只认函数式标记；`buildSchedulerPrompt(prompt, contactIds)` 新签名；`createImPushTool` 工具名 `im_push_to`、参数 `contact`、仅走 `pushToContact`）；`agent-manager.ts` `RobotPushInjection`→`ImPushInjection`（`channels`→`targets`）、env `WA_PI_ROBOT_PUSH_CHANNELS`→`WA_PI_IM_PUSH_TARGETS`、handleTool 分发/受限白名单同步；`wa-pi-bridge.extension.ts` 注册段同步；**移除渠道绑定链路**（`pushToChannel`、`parseChannelMentions`、`pushMessage` 外旧分支）；`PushResult.channelId/channelName`→`targetId/targetName`。
- **技能标记 kernel 侧展开**：executeTask 对含 `$` 的提示词调 `channelManager.loadSkillContents()`（改 public）+ `expandSkillTokens`，`$[技能名]` 任意位置生效（SDK 只展开消息开头的 `/skill:`，定时任务不受限）。
- **前端 chip 化（复用聊天 chip 机制）**：新建 `automation/prompt-tokens.ts`（标记解析 + `toPromptHtml` chip 渲染，联系人 chip = 人形图标 + 人名（Icon 表无人形图标，模块私有 SVG 自造），失效联系人灰化显示 id 不报错）；`ComposerTextarea` 加 `toHtml`/`testId` 可选 prop 零侵入复用；`TaskPromptComposer` 重写为 contenteditable（联系人/技能双 chip + 双弹窗 `contact-picker`/`skill-picker`，**技能弹窗列表体复用聊天通用 `QuickInvokeMenu`**（新增 `positionClassName` 定位覆写 prop，键盘 ↑↓/Enter 导航与聊天输入框一致），插入走末尾替换模式，存储形态 `@im-push-to(...)`/`$[名]`）；`TaskDetailView` 四宫格「推送渠道」→「推送联系人」（人名解析），prompt 渲染改用 `toPromptHtml`（chip 与输入框一致，不再手写原文高亮）；`AutomationSidebar.hasIM` 改 `HAS_IM_PUSH_RE`；删除 `utils/channel-mentions.ts`。tokens.ts 新增 `.chip-im`/`.chip-im-invalid` 样式。
- 测试：kernel robot-push 重写至新契约（parseImPushMentions 6 + 工具定义/execute 5 + 会话注入 5 + buildSchedulerPrompt 2）、bridge.test im_push_to 注册断言；frontend 新增 prompt-tokens 9 + TaskPromptComposer 重写 10 + TaskDetailView 新契约 + TaskEditForm 适配 contenteditable 交互；e2e automation.spec testid 同步。
- 影响范围：`kernel/src/{tools/robot-push,agent-manager,channel-manager,index,wa-pi-bridge.extension}.ts`、`shared/src/types.ts`、`frontend/src/components/automation/{prompt-tokens(新),TaskPromptComposer,TaskDetailView,AutomationSidebar}.tsx`、`frontend/src/quick-invoke/tokens.ts`、`frontend/src/components/ui/ComposerTextarea.tsx`、删除 `frontend/src/utils/channel-mentions{,.test}.ts`。
- 附带格式重排（纯格式无逻辑变化，`git diff -w` 已核验）：涉及上述文件的 formatter 重排 + `QuickInvokeMenu.tsx`/`AgentDropdown.tsx`/`i18n/locales/{zh,en}.ts`/`TaskEditForm.test.tsx`/`ComposerTextarea.test.tsx`；typecheck 0 错、相关测试 25/25 过。

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

- **业务修正**：任务指令 `@` 原来选 IM 渠道本身（`@bot_xxx`）——但渠道是被动回复（`sendText(null)` 需要进站帧），且无法指定接收人，任务结果根本推不到具体的人（用户反馈）。改为 `@` 选__渠道通讯录里的人__（`@ct_xxx` 联系人 id），任务执行时主动推送到该联系人。
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
- **行内编辑回填与替换**：点击人/群名展开编辑时，原为 `setValue(c.remark ?? "")`，remark 为空时输入框空白且名字行仍占位（叠加两行）。改为：① 回填当前显示名 `label(c)`（人→userId，群→chatId 前 8 位）；② 编辑态用输入框行__替换__名字行（三元切换，非叠加），取消/保存后名字行恢复；③ `label` 返回类型收紧为 `string`（`userId` 可选字段 `?? ""`）。
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
- **「最近」视图新建入口**：时间线顶部「今天」刻度改为__始终显示__（即使当天无会话），右侧放「＋ 新建会话」文字入口（右对齐），点击触发 `onNewSession`，与原按钮行为一致。
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
- **修复**：wa-pi-bridge 扩展在 `session_start`（bindExtensions 设好共享 uiContext 之后触发）时，将 `uiContext.custom()` 替换为__先 notify 再同步抛出__。效果链：
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
- **重构**：全项目重命名 HiAgent → WA PI Agent / wa-pi（约 290 个文件：包名 @hiagent/_→ @wa-pi/_、数据目录 ~/.hiagent → ~/.wa-pi、二进制 hiagent-kernel → wa-pi-kernel、环境变量 HIAGENT_*→ WA_PI_*）。

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
