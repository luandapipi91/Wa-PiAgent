## 2026-09-19 — v0.5.0 发版（委派判据优化 + 预览禁嵌降级 + 会话资源释放）

- 版本：0.4.8 → 0.5.0。
- 优化：委派提示词多轮精修（fleet/单派选择正确率 88%→100%，四部分 ≤600 tok）；预览遇 X-Frame-Options/CSP 禁嵌自动降级为应用内浏览器窗口。
- 修复：删除会话先温和停止再拆资源；压缩守卫支持目录外思考模型 reasoning 标记；self-protection 提示词改运行时按实际 bridge 端口生成。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：kernel+shared（提示词/委派/压缩守卫）、desktop+frontend（预览降级）、kernel（会话删除）。

## 2026-09-19

- 修复(kernel)：删除运行中/冷启动中的会话未真正停止后台消耗——disposeSession 只强杀不先停止，而冷启动窗口 rpc-client.dispose() 对未就绪 proc 是 no-op，删除后 pi 进程照常起来跑完任务成孤儿；改为先复用 abort 完整语义（清队列+级联停子代理+client.abort RPC+超时强杀+合成 agent_end）再拆资源。新增 3 单测（busy 温和停止/冷启动防孤儿/abort 无响应不卡死），agent-manager 123 pass、idle-reap 4 pass、session-messages 7 pass 全绿。
- 修复(kernel+shared)：手动添加、内置目录未收录的思考模型（如 deepseek-v4-flash）被按非思考模型生成 → pi-ai 永不向 DeepSeek 端点发 thinking:disabled → 服务端默认思考与正文共享 max_tokens，压缩守卫摘要请求被思考吃满预算、正文为空（实测 100% 复现「压缩守卫：摘要为空」）。ProviderModel 新增用户显式 reasoning 字段（boolean 即显式意图，优先于内置目录，对齐 maxTokens/supportsVision「用户显式配置优先」哲学），生成器同步透传。
- 优化(shared)：委派判据对症补丁——数对象行明确「分别梳理/统计 N 个模块再汇总」也算多对象（须 fleet 并行）、单对象行明确「先读懂 X 再改」类改动也派发；同步精简例外行与头部措辞，委派相关四部分合计恰 600 tok ≤600（含 roster 89，eval-prompt-budget.ts 可复现）。fleet 20 评测 R21 达 16/16 满分；评测模型切换为用户配置的 OpenCode Go(星期六)/deepseek-v4.1-flash，下一轮起为新锚点。
- 新增(kernel)：delegate/fleet 子代理中止/超时/异常路径保留部分进度——buildPartialProgressNote 组装工具统计+步骤清单（≤30 条折叠）+输出尾部（≤4000 字符）附加进返回 text，新增 interrupted 结构化标记随 details 与遥测透传（toolStats 正常完成也记录）；12 新用例。
- 修复(kernel)：fleet 并行派发失败/中断不再连坐——子任务 spawn 异常原会让 Promise.all 整体抛错丢光已完成结果，改为转结构化失败结果；聚合 text 标题按失败/中断独立组合标记（如「失败·中断」）；fleet 混合结果/整体中止/排队不连坐 4 用例。
- 新增(frontend)：delegate/fleet 卡片新增「已中断」第三终态视觉——琥珀 warning 色徽标+stop 图标+i18n（悬停提示「部分结果已保留」），fleet 支持子任务行级徽标；旧会话数据（无 details）渲染不变；9 组件用例。
- 修复(kernel)：用户手动停止 delegate/fleet 时部分结果不再丢失——abort 瞬间写占位快照、子任务全部 settle 后写完整快照（subagent-results/<toolCallId>.json），pi 侧桥接扩展识别用户停止（显式区分空闲超时）轮询读取快照把部分进度文本与 interrupted details 拼入工具结果；正常完成零落盘；8 新用例。
- 修复(frontend)：父 delegate/fleet 调用已终态但子任务行仍「运行中·秒数增长」——终态时仍 running 的行兜底归「已中断」（徽标+warning tint+秒数冻结），details.interrupted 精确标记优先；8 新用例，前端全量 2608 pass。
- 修复(kernel)：用户停止时长任务快照晚到致回复退回旧错误文案（实证：final 快照比 pi 轮询窗口关闭晚 33ms）——abort 瞬间即用内存状态组装并写 phase="final" 快照（数百 ms 就绪，不等 settle），settle 后覆盖更新留档；tool_execution_end 收集工具产出内容（单条 800 字/总量 16KB 截断），部分进度新增「关键产出摘录」段；相关 5 测试文件 108 pass。
- 修复(frontend)：被中断轮次的过渡文本被误置为「最终回复」外置到工具卡片之后（视觉上像消息顺序错乱，实证会话 JSONL 数据层完全有序）——外置条件收紧为「最后一段 text 之后无任何过程段」才外置，否则按原序内联渲染；正常回合行为不变；MessageList 相关 94 pass、前端全量 2611 pass。
- 修复(frontend)：合成 agent_end（中止/压缩/扩展命令/删会话兜底广播）误置非当前会话未读圆点——未读置位条件增加 synthetic gate，真实完成提醒不变；store 测试 89 pass。
- 修复(frontend)：fleet 卡片「有正式回复但底部还有空的回复」——①拆分器只认「行首且名称命中任务清单」的【agent】标记为分段边界，agent 正文自带的【】小标题（如「## 【代理A·质数计算】任务结果」）不再被误当分隔符，「用户停止」场景的「已停止。」前缀先剥离再拆分（全历史 123 条 fleet 结果实测可拆分 98→113、0 回归，含用户报告会话）；②降级聚合（无法拆分）时任务行不再承诺「点击查看回复」——标签去后缀、隐藏展开箭头、不可展开，展开区不再渲染空「回复：」块（有实时状态时仅显示状态行）。组件回归 3 例 + E2E 2 例；前端全量 2615 pass、typecheck 全绿。

## 2026-09-18 — v0.4.8 发版（启动提速 + preview_open 工具 + 记忆检索优化）

- 版本：0.4.7 → 0.4.8。
- 新增：agent 工具 preview_open（网址/项目内 html → 内置预览面板）。
- 优化：打包版启动提速（不再每次拷 95MB 内核、不再重复装依赖）；记忆检索触发收紧到知识/过程类提问（冒烟 65%→95%）。
- 修复：启动画面空白/进度条卡住；附件 chip 点击无反应；暗色模式弹窗 markdown 文字不可见；GPU 诊断落盘。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree，2591 pass）。
- 影响范围：desktop（启动流程/GPU）、kernel+shared（记忆检索触发）、frontend（预览面板/附件 chip/弹窗主题）。
## 2026-09-18 — v0.4.7 发版（Markdown 渲染全局统一 + 扩展弹窗修复）

- 版本：0.4.6 → 0.4.7（2 提交）。
- 优化：新增 components/blocks/Markdown.tsx（全仓唯一 markdown 入口），合并原 9 处内联 ReactMarkdown 渲染点。
- 修复：原生扩展弹窗（select/confirm/input/editor）高度与渲染——长 prompt 放 title 且头部不限高导致选项卡被挤出屏幕。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：frontend（blocks/Markdown 及 9 处调用点、ExtensionDialog）。
- fix(frontend): 用户消息气泡里的附件 chip（「附件:文件名」）现在可点击打开——此前 chip 是 innerHTML 注入的 span，发送后点了没反应；改为在气泡上做事件委托（只命中 data-token 以 `path:` 开头的附件 chip，正文文字与其他类型 chip 不触发），按 FilePill 同一口径分发：图片/视频 → 媒体画廊，其余 → 文件预览（html → 浏览器面板），路径按项目 cwd 补全，并给气泡内 chip 加 cursor:pointer 提示。覆盖「附件尾段」与「乐观占位本地附件引用」两条 chip 来源。测试：组件测 5 例（含「点正文不触发」反向断言）+ e2e 2 例（真实上传→发送→点击 chip→弹窗与内容可见）。
- fix(desktop): 打包版启动卡顿（Windows 实测止血）——① 每次启动不再把 ≈95MB 内核二进制拷进 WA_PI_DIR/runtime：自 da951491「移除内核独立打包与独立升级机制」后该副本已无任何读取方（spawn 与 bin 链接都用随包 seed 路径），并清理老用户 runtime 里的存量副本（回收 ~95MB）；② 依赖重装判定改按「依赖清单指纹」（package.json + bun.lock 内容哈希）而非 app 版本号——生产日志实测发版触发的那轮重装 bun 自报 “no changes”，白付一次 95MB 子进程启动（2.2~5.5s，冷网络还叠加 26s 下载）；③ 补启动时间线埋点：runtimeReadyStart/runtimeReadyDone/kernelSpawnStart/splashLoaded/splashFirstFrame。实测（打包版、隔离 WA_PI_DIR、三次冷启动）：升级路径 2185ms → 1530/1541ms，种子同步段 59~83ms → 24~26ms，依赖判定 864ms → 0ms。
- fix(desktop): 启动「画面」修复（只此两处）——① `windowShown` 移到 `firstFrame` 之后：原实现在 did-finish-load 回调里立即 reveal，而首帧探测是异步的，用户先看到一个白窗/半渲染页面（跨平台问题，macOS 同样存在）；② 启动清扫改异步（`sweepRegistryAsync` + execFile）：同步版内部 `spawnSync("powershell")`，实测仅 1 条残留登记就冻住主线程 1061ms（阻塞探针记 1240ms、进度更新空档 4395ms），异步版同墙钟 978ms 但**主线程零阻塞**、启动页在清扫完成前就已出帧；退出/升级前路径仍走同步 `sweepRegistry`（同步监听器内必须同步杀完，语义未破）。实测（打包版冷启动 3 次）：`windowShown` 的 +ms 均大于 `firstFrame`。
- feat(kernel+shared): 记忆检索触发优化——把「什么时候该先查记忆」的判定收紧为「知识类/过程类提问（项目结构 / 依赖清单 / 接口与方法清单 / 项目约定 / 历史决策 / 上一轮改动 / 构建测试方式 / 环境与工具链事实 / 踩过的坑）第一个工具调用就是 memory_search，查完再决定是否委派或读代码；单点定义查询（答案一行念完）不必查」，按既有分层落在三处：MEM_SEARCH_DESC（判定细则唯一真源）、DELEGATE_DESCRIPTION 首条（例外边界，防「一律派发」总则吃掉知识类提问）、Memory Policy full/compact 概述。新增评测脚本 packages/kernel/scripts/eval-memory-trigger.ts（20 条用例逐条显式期望 + casePassed/computeStats/gateFails 0.8 硬门禁 + --dry-run/--selftest 不调模型 + cwd 隔离 worktree + 隔离记忆库）与 eval:memory-trigger 入口，不调模型的自检层接入 kernel test 入口。实测（deepseek-v4-flash，隔离 worktree）：总通过率 13/20(65%) → 19/20(95%)，正例 7/14 → 14/14；核心症状「该查却直接委派」2→0、「先派后查」2→0、「该查却没查」3→0；唯一失败项为「当前会话内已知信息」反例（用户在本条消息里已给足信息，agent 仍多查了一次记忆，属规则略宽待后续收紧）。委派回归：Explore 触发率 30/30(100%) 持平（达标线 80%），fleet 选择正确率 81.25% → 93.75% 不降反升。新增文案与结构不变量断言（MEM_SEARCH_DESC 判定细则、DELEGATE_DESCRIPTION 例外须为第一条判定、两版记忆策略点名知识类提问），shared 169 通过 0 失败。

## 2026-09-18 — v0.4.6 发版（新会话启动/侧栏空白修复 + TUI 弹窗鼠标修复）

- 版本：0.4.5 → 0.4.6（3 提交）。
- 修复：新会话 agent 启动失败（tui-host/click.ts 漏出 TUI_HOST_EXTENSION_FILES/KERNEL_ASSET_FILES 清单）；侧栏一堆空白会话（孤儿回滚广播未过滤 placeholder 预热记录）；TUI 弹窗按钮点不到（未消费鼠标时回退键盘）。
- 其他：移除 kernel 的 pi-agent-core 显式声明（理由已失效）。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：kernel（tui-host 部署清单/compile-binary 资产清单/agent-manager）、frontend。
- fix(frontend): 原生扩展弹窗（ExtensionDialog：pi 的 select/confirm/input/editor）高度与渲染修复——① pi 把长 prompt 放在 **title** 里且头部不限高，卡片被撑满后选项与取消按钮被挤出卡片（卡片 overflow-hidden，滚都滚不到）：尺寸改宽 60% / 高上限 80vh；标题区限高 40vh 自滚、正文区成为唯一滚动区（flex-1 min-h-0 overflow-y-auto）、选项/输入/编辑器/按钮区一律 shrink-0 不被压缩（flex 列默认 shrink:1 会先把按钮压成一条缝），选项多于视口时列表自滚。② 正文是**终端排版 + markdown 混排**：pi-goal-x 的 goal-draft.ts:34 给目标每一行加 `│   ` 前缀（把里面的 markdown 表格挡成纯文本）、分节线写成 `─── X ───`、任务区是 `┌─ TASKS ─┐` 方框，之前当纯文本塞进 div（markdown 单位换行还被并成空格，整段压成一坨）。新增 lib/ext-dialog-text.ts 归一化：去框线前缀/行尾框线、`─── X ───`/`=== X ===`/`┌─ X ─┐` → `### X`、纯装饰线丢弃（只认框线字符，不碰 ASCII `|`，正常 markdown 表格原样通过），title/message 再走与聊天同一套 markdown 管线并保行结构（whitespace-pre-wrap）。验证：归一化纯函数 7 例 + 组件测 38 例（含逐字复刻 pi-goal-x 输出形态：表格成真 <table>、四个小标题、框线字符零残留）、真实浏览器实测同形态文本（卡片 768×536、表格单元格正确、选项与取消全在视口内）；前端全量 2535 通过。
- refactor(frontend): markdown 渲染全局统一——新增 `components/blocks/Markdown.tsx`（全仓库唯一 markdown 入口），把原先 9 处各自内联 ReactMarkdown 的渲染点（聊天正文 MarkdownBlock、子代理流 StreamingOutput、Fleet 降级分支、FileViewer md 预览、导出图片卡片、扩展弹窗、Ask 选项预览、回收站查看器，以及死代码 TextBlock）全部收敛为一个组件：包装类/组件映射覆盖（img/a）/插件（rehypeRaw）/urlTransform/媒体清单（数组或 getter）/文本前置整形（如 normalizeDialogText）/流式节流（streaming+throttleMs）/testid 全部参数化；`interactive=false` 供只读面板（Ask 预览、回收站）退化为纯 markdown，不引入文件 chip/图片画廊/mermaid/代码卡片。删除死代码 TextBlock.tsx（其唯一测试改用统一组件，断言代码块走 CodeBlockCard）；同步修正 StreamingOutput/DelegateCard/MessageList 里描述「停顿降级（useSettled）」的失效注释。刻意保留的差异（产品级，不是漏统一）：聊天区的媒体段落拆分（InlineVideo）、FileViewer 的块级虚拟滚动与 baseDir 相对路径、导出图片依赖 DOM testid 的静态排版。测试：新增统一组件契约 10 例（默认包装/testid 覆盖/interactive 开关/components 合并/transformText/urlTransform/rehypePlugins/节流/媒体清单 getter 引用稳定）；前端全量 2548 通过；e2e 回归通过（chat-blocks / chat-export / chat-media-preview / explorer 的 md 预览）；typecheck 通过。
- fix(frontend): 暗色模式下弹窗 markdown 文字不可见——markdown 的主题配色/换行/段落间距原本挂在 `[data-testid="text-block"]` 上，而扩展弹窗与回收站这些容器传 testId=null，拿不到主题变量，typography 的浅色默认色（--tw-prose-body 近黑）在暗色背景上就是「看不见的字」；改为统一组件容器恒定带 `.md-body` 类，styles.css 的相关选择器收敛为 `:is([data-testid="text-block"], .md-body)`。测试：新增「容器恒带 md-body」与「样式表必须命中 .md-body」两例（已用回退实现验证过红→绿）；真实浏览器暗色实测（themeMode=dark）弹窗正文/标题/粗体计算色为主题色 rgb(245,245,247)，与页面正文同亮度。前端全量 2549 通过；typecheck 通过。
## 2026-09-18 — v0.4.5 发版（定时任务执行态治理 + 内核通道移除）

- 版本：0.4.4 → 0.4.5（4 提交）。
- 新增：定时任务「立即执行」即时可见 + 执行中可取消（防重复执行与卡死状态自愈；任务不存在改返 404）。
- 修复：TUI 长弹窗选项区出屏（限高基准对齐浮窗 + 帧刷新贴底跟随）。
- 优化：移除内核独立打包/独立升级机制（内核只随安装包升级；关于页去内核版本行）。
- fix(frontend+kernel): TUI 弹窗「按钮点不到」——自定义对话框（pi-goal-x 问卷/提案确认）只实现 handleInput、无 handleMouse，点击会落到文本选择；宿主在组件未消费鼠标时按帧文本补「点击 → 键盘」回退（编号选项 ↑↓+Enter、自报 (press 'x' to toggle) 行直发该键），推不出就不动作；同时修坐标：鼠标行号改发**帧行**（面板文本区高度不是格高的整数倍，可见首行只有半行，两侧 floor 差 1 曾致「点 2 中 3」），宿主按 alt-screen 视口偏移折算回终端行、越界即丢。测试：kernel 25 + frontend 3 + e2e 新增点击用例（真 pi 点击选项 → done 回显）。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：kernel（scheduler routes/执行态）、frontend（automation 面板/TuiPanel）、desktop（移除 kernel-updater）。

## 2026-09-18 — v0.4.4 发版（IM 会话自愈重建 + fleet 上限一致性）

- 版本：0.4.3 → 0.4.4（5 提交）。
- 修复：IM 会话被自动回收后自愈重建全新会话 + 回收站对话不再展示；spawn 前 stored cwd 自愈重建丢失目录；fleet 并发上限「文案 5/实际 6」脱节修复（shared 单源同文件插值）+ fleet 评测扩到 20 条。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：kernel（agent-manager/ws-server）、shared（fleet 描述单源）。

## 2026-09-18
- chore(desktop): 新增 GPU 现场取证 demo（`scripts/gpu-diagnose.cjs` + `gpu-diagnose.cmd`）——Windows 同样报「启动卡顿」但 d3d11 在 Win 上是正确后端，不能盲改；demo 不依赖本仓（自带启动页同形页面 + 进度条 transition）、不占端口不读写应用数据，一次跑两种配置（无开关 / 四开关）输出 `[摘要]`+`[时间线]`：合成状态、活动 GPU、rAF 出帧、进度条是否走完。macOS 自测：无开关 ✅ 60fps，四开关 ⚠️ disabled_software / 无活动 GPU / 1fps（能自行识别故障）。
- fix(desktop): 修「打包版启动卡顿——启动页空白/进度条停在低位不动/很久才渲染出界面」——四个强制 GPU 开关无条件生效，其中 `use-angle=d3d11` 是 **Windows 专属** ANGLE 后端，在 macOS 上把 GPU 整个关掉：`app.getGPUFeatureStatus()` 从 `gpu_compositing=enabled / gpuDevice.active=true` 退化为 `disabled_software / active=false`（软件渲染），同一启动页 rAF 出帧 **60fps → 6~16fps**（单变量隔离：只加 d3d11 即 9/7/1fps，另三个单独开均 57~62fps；`getGPUInfo('complete')` 已排除）。改为按平台门控（仅 Windows 保留，见 `util/gpu-switches.cjs`，含单测），macOS/Linux 回到 Electron 默认（实测 GPU 恢复正常）。
- feat(desktop): 启动诊断补盲——① 新增 `[GPU]` 一行状态摘要（原「GPU 信息:」日志永远是空的：`log.info` 只接受一个参数，第二个参数被静默丢弃，两个平台都无从查证有没有硬件加速；软件渲染时带 ⚠️）；② 新增 `[startup]` 时间线（模块加载起点/ready/启动页/主窗口/内核就绪/loadURL/did-finish-load/首帧/窗口显示）——「内核就绪 → 首帧」这段以前完全无日志，正是两个平台都报过的卡顿位置；③ 启动页与主窗口补 `unresponsive` / `render-process-gone` / `did-fail-load` 留痕。实测（隔离数据目录 + 独立端口，不碰在跑实例）：`[GPU] 硬件加速 合成=enabled …`、`[startup] … kernelReady=+2273ms didFinishLoad=+3184ms windowShown=+3200ms firstFrame=+3335ms`；desktop 215 pass / typecheck 全绿。
- fix(kernel): 修「新会话 agent 启动失败」——tui-host 部署清单 `TUI_HOST_EXTENSION_FILES` 与打包资产清单 `KERNEL_ASSET_FILES` 漏了新增的 `tui-host/click.ts`（`panel.ts` 已 import），GENERATED_DIR 缺文件 → pi 加载扩展报 `Cannot find module './click.ts'` → pi rpc 进程退出，**所有**新会话启动失败（并留下占位记录）。补两处清单，deploy 加「以 `src/tui-host/` 实际文件为准」的防漂移测试；实测负控复现原报错、正控（修后部署）加载干净。
- fix(kernel+frontend): 修侧栏「一堆空白会话」——孤儿会话回滚广播原用未过滤的 `projectStore.load()`，把「新开会话」预热写入的 placeholder（空标题占位）记录全量推给前端；改用既有的 `broadcastProjectsList()`（loadActive 过滤），前端 store 合并会话再兜一层 `!placeholder` 过滤（回归测试先红后绿）。
- chore(kernel): 移除 `@earendil-works/pi-agent-core` 显式声明（原声明理由已失效）——kernel 只是 pi 的 RPC 宿主（会话跑在 `pi --mode rpc` 子进程，SDK 一律在子进程内调用），源码对它零 import（仅 `delegate-tool.ts:9` 注释）；该声明系 2026-08-16（285ef51b）为修 `@amaster.ai/pi-memory` 宽范围可选 peer（`>=0.74.0`）把副本拉偏所致，而 pi-memory 已于 a1c88e14 移除。验证：删除后 pi-agent-core 仍经 pi-coding-agent 传递安装、解析版本 0.85.1 不变、无嵌套实例（其自身无 peerDependencies，不存在 peer 分裂风险）；kernel typecheck 全绿 + kernel/desktop 测试全通过。
- chore(deps+docs): 依赖清理与打包清单升级——①sidecar 打包清单（`packages/desktop/resources/kernel/`）pi-coding-agent `^0.84.4` → `^0.85.1` 对齐内核源码，bun.lock 重新生成（旧 lock 整棵 pi 树停留在 0.84.4）；②pin `pi-mcp-adapter` 为 `2.27.0`（原 `^2.27.0` 在 sidecar 重新解析时漂到 2.31.0，其 peer `^0.84.1` 按 0.x 语义不含 0.85.1 → bun 为它单独装嵌套 pi-ai 0.84.4，与宿主 0.85.1 并存形成 peer 版本分裂，且与开发环境版本不一致），sidecar 与开发环境版本归一；③删除零引用依赖：`reactflow`（前端，全仓无 import、dist 零命中）与 `@aws-sdk/lib-storage`（根，`s3-upload.cjs` 注释明确不用）；`@earendil-works/pi-agent-core` 保留（零代码引用但不内联、不分发，且历史上显式声明是为修 peer 版本分裂）；④`THIRD_PARTY_NOTICES.md` 清除过期内容：`@amaster.ai/pi-shared` 条目、已删除的 `patches/` 段落、未安装的 caniuse-lite 段、hosted-git-info 误列为 BlueOak。验证：kernel/frontend/desktop typecheck 全绿，desktop 204 pass，前端 2506 pass / 0 fail，前端构建产物无 reactflow。
- feat(kernel+frontend): 定时任务执行态治理——①「立即执行」即时可见：`POST /:id/run` 改为「先落盘 running 记录 + 广播再响应」并回传该记录，执行链改后台继续（拆分 prepareRun/executeRun，不再 await 整条链）；前端 `runTaskNow` 响应后即刷「最近执行」/状态点，App 的 SSE（scheduled-tasks:changed / scheduled-task:completed）、重连、恢复可见统一走新增 store action `refreshFromEvents`（带合流：一轮刷新在飞时后续事件只记一次待刷；刷新失败降级为忽略，不把「已触发」误报成失败）。原 SSE 只刷列表+记录，详情页「最近执行」从不更新——这是「点了立即执行下面不刷新」的根因。②可取消执行：`TaskScheduler` 新增在飞执行登记表 + `cancelRun`（标记取消 → abort 该次会话 → 等终态落盘），新路由 `POST /api/scheduled-tasks/:id/cancel`，详情页执行中显示「⟳ 执行中」标记 + 「■ 取消执行」（侧栏右键菜单同步换项），记录收敛为 failed + errorCode `scheduler.taskCancelled`（列表/详情按 errorCode 渲染灰色「⊘ 已取消」+ 执行记录页新增「已取消」筛选项，不按故障红叉展示）。③禁止重复执行 + 卡死自愈：同一任务并发闸门（手动与 cron 撞车时 cron 跳过、并发 POST 返 409），`FolderTaskStore.markInterrupted` 把残留 running（进程被杀/重启后终态行丢失）收尾为 failed + `scheduler.taskInterrupted`，启动时全量对账（失败只告警不拖垮启动）、每次立即执行前按 `startedBefore` 下界对该任务尾读窗口对账（避免误伤对账期间刚起的新执行，单任务不再全量解析历史日志）、取消请求无在飞执行时走同一对账。前端不做硬禁用：执行中仍可点「立即执行」，由服务端判定（真在飞 → 409 + 字典文案；卡死残留 → 收尾后照常执行），解决「前端缓存误判执行中导致用户无路可走」。配套：CLI `cron-task.ts run` 按 HTTP 状态码识别 409/404，不再把「未触发」报成已触发（资产版本 v4）；ExecutionDetailView 记录查找回退 recentRecords。测试：kernel 单测 +13 / 存储 +5 / 路由 +4 / 资产 CLI +1、前端 store +6 / 组件 +5、集成脚本新增「run 回传 running 记录」「在飞取消收敛为已取消」「悬空态对账」三场景（并修复该脚本在全局目录重构后 TASKDIR 失配的失效问题）、E2E +3（立即执行即时可见 / 悬空执行中点立即执行自愈并重跑 / 悬空态取消自愈）。
- fix(kernel+frontend): 定时任务执行态两处收尾修正——①「已取消/已中断」文案去掉括号补充说明（字典 `scheduler.taskCancelled` → 「任务已取消」、`scheduler.taskInterrupted` → 「任务已中断」，en 同步）；②`markInterrupted` 不再写入 durationMs——进程何时退出无从得知，保留了会把跨应用关闭的整段时间算成耗时（实测出现「耗时 1560996s」即 18 天），现只留 finishedAt（对账时刻）＋展示侧 recordShowsDuration 一并隐去存量记录里的假耗时（前端刷新即生效，无需重启 kernel）。测试：组件测试补「文案不带括号」「中断不显示耗时（含存量）」「已取消⊘/已中断✕ 与筛选项」断言、存储测试改断言 durationMs 为 undefined，并补 3 条刷新失败降级回归（runTaskNow 不 reject / cancelTaskRun 不丢回执 / 单请求失败不整体 reject，已用临时回滚验证测试有效）。
- fix(kernel): 错误路径修正——`POST /:id/run` 任务不存在由恒返 200 改为 404 `scheduler.taskNotFound`，执行入口失败不再静默（旧实现前端无法区分「已触发」与「任务不存在」）。
- fix(kernel): spawn 前 stored cwd 自愈——存量 IM 会话 sessionId 内嵌时间戳与会话实体 createdAt 错位（旧版各取 Date.now() 相差秒级），pi jsonl 首行 stored cwd 指向的 workdir/<sessionId-ts> 被 workdir-cleaner 按 TTL 清理（引用集合只认 createdAt），resume 时 pi 非交互模式直接 exit(1)（"Stored session working directory does not exist"），IM 侧只看到「pi rpc 进程不可用」且无自愈。修复：_createSession 在 mkdir(推导 cwd) 后流式读 piSessionFile 首行 stored cwd（新增导出 readStoredSessionCwd，大文件只读首行、失败静默），目录缺失则重建，存量错位会话恢复且历史上下文不丢；未来任何原因导致的目录丢失同样自愈。测试：agent-manager-stored-cwd 新增 6 pass（readStoredSessionCwd 单测 5 例 + 错位会话 ensureStarted 自愈集成 1 例）
- fix(kernel): IM 已回收会话自愈重建 + IM 窗口展示过滤——ensureSession 校验排除软删除（回收站，含自动归档 deletedReason:"auto"）与占位会话，失效即兜底新建全新会话（此前 load() 全量通过校验，消息继续落进已回收会话甚至报错）；listConversations 两分支（当前指针 + 历史归档）过滤已回收会话，回收站里的对话不再出现在 IM 窗口；新增 onSessionsArchived 批量清理映射（onSessionDeleted 改为委托），runAutoArchive 归档后调用联动消除悬空映射，下一条 IM 消息自动全新对话。测试：channel-manager 新增 4 例（禁复用/当前指针过滤/历史过滤/批量清理）+ 2 例 fixture 补实体，37 pass；channel 系回归 42 pass
- fix(frontend+kernel): TUI 长弹窗选项区出屏修复——①宿主假终端初始行数 PANEL_ROWS 24→17 对齐前端 TuiPanel 展开态真实可视行数：pi-goal-x 等外部对话框的「保头保尾」行数钳制按创建时该行数一次算定（不随 resize 重算），基准 24 > 浮窗实际约 18 行，长正文时选项区（帧尾）被推出首屏（「Confirm Goal Draft 看不到选项」根因），基准对齐后弹窗自动压短正文保住选项，首屏即看全；②TuiPanel 帧刷新自动贴底兜底：用户未上滚（距底 ≤1 行）时跟随帧尾保证选项/确认区始终可见，上滚阅读正文不打扰、滚回底部自动恢复（判定落 lib/tui-follow.ts 纯函数）。测试：kernel tui-host 3 文件 + frontend 贴底判定 5 例共 54 pass；frontend typecheck 过

- fix(shared+kernel): fleet 并发上限「文案 5 / 实际 6」脱节修复——FLEET_DESCRIPTION 硬编码「Concurrency limit is 5」而常量=6（2026-09-01 拍板），delegate-tool 的 replace 回填因搜索串写「6」与模板「5」不符静默失效，bridge 扩展直引原文同病，模型看到的上限一直停留 5；修复：FLEET_MAX_CONCURRENCY 常量落位 shared tool-schemas.ts、FLEET_DESCRIPTION 同文件插值生来即渲染（数值与文案同源），kernel 删失效 replace 按旧名重导出兼容，bridge 扩展经生成物自动继承零改动；防回归测试补「渲染描述含常量值 + 禁止 5 回潮」，shared 14 pass / kernel delegate-tool 45 pass。配套 fleet 评测用例 6→20（应并行 10/应逐个 6/不该派 4，非 fleet 96 条零改动）+ fleet 选择正确率指标；worktree 实测（deepseek-v4-flash）：fleet 派发 16/20 恰为应派集合、误派 0%、漏派 0%，选择正确率 88%（应并行 9/10、应逐个 5/6）对比基线 67%（4/6）显著改善；simple/edit-small 抽样误派 0%。注意：已安装桌面端需随下次打包更新才见到修复后文案。报告 ~/.wa-pi/eval-dt-fleet20.json

- refactor(release+desktop+frontend): 移除内核独立打包/独立升级机制（v0.2.21 引入，实际未被单独使用）——删除 `scripts/publish-kernel.ts`(+test) 与 `kernel-updater.cjs`(+单测/集成测试)；`main.cjs` 启动不再拉内核清单（删 2c- 步骤与 getKernelVersion/checkingKernelUpdate 文案）；`runtime-deps.cjs` 依赖重装判定回归 app version、`syncSeed` 无条件以随包 seed 覆盖内核（已动态更新过的老用户下次启动回归包内内核）并把 `.kernel-version` 列入遗留清理；关于页移除「内核版本」行（同步清 store 字段 / i18n 中英文案 / IPC 载荷字段）。验证：desktop 205 测试、前端 2508 测试、双端 typecheck 均全绿，新增 E2E（关于页有版本行且无内核版本文案）。
- feat(kernel): 新增 agent 工具 `preview_open`——把网址或项目内 html 文件送到用户的内置 HTML 预览面板（与无头 `browser_*` 区分：本工具把页面呈现在用户眼前）。① `src/preview-tools.ts`：`resolvePreviewTarget` 纯函数校验 url/path 二选一（http/https + host 非空 + 禁止应用自身 origin；path 须绝对路径 + `.html/.htm` + 落 `projectCwds` 内 + 文件存在，复用 ws-server 的 `isPathInProjects`），错误码 `missing_target`/`ambiguous_target`/`invalid_url`/`host_origin_forbidden`/`invalid_path`/`path_forbidden`/`file_not_found`；`createPreviewOpenTool` 读项目列表 → 校验 → `broadcast({type:"preview:open",sessionId,target})`，成功/失败两分支均 try/catch 转文本结果、绝不抛。② `agent-manager.ts`：新增可选 `previewOpenExecutor` + `setPreviewOpenExecutor` + handleTool `preview_open` 分支（未接线返回「预览功能未就绪」+ details.error，已接线 try/catch 调用）。③ `index.ts`：以 `http://127.0.0.1:${server.actualPort}` 与 `http://localhost:${server.actualPort}` 为 selfOrigins 构造工具并注入（惰性取值，端口 start 后才确定）。④ `wa-pi-bridge.extension.ts`：注册 `preview_open`（shared 的 `PREVIEW_OPEN_DESCRIPTION` / `PreviewOpenParamsSchema` / `DEFAULT_TIMEOUT_MS`，照 browser_close 写法）。测试：新增 `tests/preview-tools.test.ts` 27 例（全部错误码 + url/local 两条成功分支 + execute 成功时 broadcast payload 形状与失败时不 broadcast + 异常兜底 + AgentManager 分发 + 真实 HTTP `/bridge/tool` → `/api/events` SSE 端到端，全部先红后绿）；`bridge.test.ts` 工具数断言 14 → 15（含 ALL_BRIDGE_TOOLS）；`bridge-extension.test.ts` 补 preview_open 注册断言。验证：kernel typecheck 全绿；相关 6 个测试文件 214 pass / 0 fail。⑤ 前端：`store/browser.ts` 新增 `externalUrl` + `openExternal`/`setExternalUrl`/`rememberSessionPreview`（本地/外部互斥，`SessionPreview` 加 url 随会话记忆恢复）；新增 `src/agent-preview-opener.ts` 订阅 SSE `preview:open`——归属当前会话立即打开、否则只记入该会话记忆（不抢当前画面）；`BrowserPanel` 内容源改为 store（path/externalUrl 双分支），地址栏外部导航写回 store。⑥ 独立预览窗口（float）：`preview-window`/`preview-window-driver`/`PreviewWindowRoot` 与 `desktop/main.cjs` 的 open/sync/URL 参数全部支持 url（url 优先，否则回落 path）；新增独立窗口→主窗口的 `url` 上报事件（独立窗口地址栏换网址后切回内嵌能恢复同一内容）。⑦ E2E 新增 `e2e/agent-preview-open.spec.ts`（真实浏览器注入 SSE 帧：网址真实加载目标站点 + 本地 html 走 /preview + 非当前会话不抢画面）；`e2e-electron/preview-window.spec.ts` 补跨窗口网址同步用例（独立窗口输网址 → 切回分屏主窗口显示同一网址）。验证：kernel 全量 gate 全绿（typecheck + bun test）；frontend 2589 pass / desktop 215 pass / 前端 typecheck 全绿；浏览器 E2E 3/3、Electron E2E 9/9 通过。工具 description 压缩到 50 token 内且声明与 `browser_*` 自动化工具无关（防模型误用自动化工具当预览），带回退测试（`PREVIEW_OPEN_DESCRIPTION` 含区分语 + 字符数上限）。
- fix(desktop+frontend): 内置预览遇到「站点禁止被嵌入」时自动改用应用内浏览器窗口打开——目标站下发 X-Frame-Options / CSP frame-ancestors（如百度搜索页）时 iframe 只能白屏，且渲染层拿不到任何信号（跨源读不到内容、父文档收不到 securitypolicyviolation，实测确认），故由主进程监听子帧 did-fail-load(-27 ERR_BLOCKED_BY_RESPONSE) → 经 previewwin:event 下发 {type:"blocked",url} → 渲染层 window.open 转应用内外链子窗口（顶级导航不受 frame-ancestors 约束）+ toast 说明 + 收起预览；主窗口（分屏/全屏内嵌）与独立预览窗口两处接线。验证：desktop 源码断言 3、前端 driver 2（先红后绿）、Electron E2E 新增真实用例（百度搜索页 → 自动弹出真窗口并加载该页、预览收起、提示可见）；回归 frontend 2591 / desktop 239 / Electron E2E 10 全绿。教训：wirePreviewBlocked 必须定义在模块级（曾误放 createWindow 内，createPreviewWindow 报 ReferenceError 致预览窗口完全打不开——源码字符串断言抓不到，靠 E2E 暴露）。
- test(e2e): 补「会话界面内嵌预览」形态的禁止嵌入降级用例——从浮动窗口切回会话内嵌分屏后打开真实站点（百度搜索页），断言提示可见 + 应用内浏览器真窗口加载该页 + 预览面板收起（主内容区恢复）；与上一条（独立预览窗口路径）分别覆盖主进程两处 did-fail-load 接线（mainWindow / previewWindow）。Electron E2E 11/11 全绿。
- perf(shared+kernel): 委派提示词优化（含口径修正）——fleet 选择正确率 88%→100% 且连续 2 轮全对（R16/R17 各 16/16：应 fleet 10/10、应逐个 6/6、误派 0/4、漏派 0；报告 eval-dt-fleet-r16/r17.json），委派相关提示词（DELEGATE_DESCRIPTION + FLEET_DESCRIPTION + 系统 delegate-mechanism 段 + delegate-roster 注入段）合计 586 tok ≤600：①判定「先查顺序词（先…再…/然后/按…结果/取决于）→ 一律逐个 delegate、禁止 fleet；否则数对象 ≥2 个互不依赖对象 → 必须一次 fleet 并行、禁止合成一个 delegate；单对象探索/审计/调查或改代码/写文件 → delegate（不要自己动手做完再报结果）；单点查询/需交互 → 不派」；②delegate-roster 紧凑化 183→89 tok（XML 块→一行一智能体，去定义文件路径）；③memory_search 例外收紧为「仅限提问，不含改代码/写文件任务」；④新增测量脚本 packages/kernel/scripts/eval-prompt-budget.ts（四部分合计 ≤600，超预算退出码 1）；⑤迭代 R1-R17：75→88→88→81→94→94→100→100→94→100→94→100→94→100→94→100→100%（轨迹 ~/.wa-pi/eval-dt-iterations.md）；测试 shared 17 + kernel 45 全绿

- fix(kernel): 自身进程保护提示词改为按实际 bridge 端口运行时生成，不再写死 9778/9776——self-protection 段由静态段改为运行时注入段（`buildSelfProtectionPrompt(bridgeUrl)` 按实际启动端口生成文案，入参 → env `WA_PI_BRIDGE_URL` → 不含端口数字的通用兜底），prompts.json schema v27→v28：该段落盘剔除、运行时补回，旧文件里写死端口的 content 随迁移清理；agent-manager 经 `bridgeBaseUrl()`（server.actualPort）注入。验证：system-prompt 家族 61 pass + typecheck 全绿；用真实 prompts.json 副本跑迁移——磁盘不再含 self-protection/9778，渲染文案端口=实际运行端口。注意：已安装打包版需重新打包安装并重启才生效。
- perf(kernel+shared): 委派提示词再压缩（roster 紧凑格式 + 工具描述/机制段收句）——roster 由 XML 块（`<subagents>`/`<agent>`/`<name>`/`<location>`/hints 标签）改为紧凑列表：一行一智能体「- 名称：简介；何时派：…；不派：…；收益：…」，舍弃定义文件路径等纯元数据（`buildDelegateRoster` 保留 agentsDir 入参以兼容调用方）；`DELEGATE_DESCRIPTION` 与 `DEFAULT_DELEGATE_MECHANISM_PROMPT` 同步去重收句。新增 `packages/kernel/scripts/eval-prompt-budget.ts`（口径 CJK≈1 tok、其他 4 字符≈1 tok；默认预算 600，超预算退出码 1，支持 `--budget`/`--json`），把「≤600 tok」从口头约定变成可复跑的门禁。实测：DELEGATE 286 + FLEET 43 + mechanism 164 + roster 92 = 585 tok（≤600；roster 段仅 147 字符）。验证：kernel `bun test` 全部通过（含 eval 自检）、shared 170 pass、desktop 237 pass、四包 typecheck 全绿；前端未引用被改符号故不涉及其测试。修正一处断言：self-protection 重启引导改为「退出重开桌面应用」——splash 的「重启应用」按钮已被「换端口启动」/「退出」替代（见 `packages/desktop/tests/splash-html.test.ts`），旧断言指向已不存在的入口。

## 2026-09-17 — v0.4.3 发版（会话切换体验 + 流式性能 + 稳定性修复）
- fix(frontend): 会话切换 splash 模式——数据就绪列表立即挂载（骨架带 bg-surface 不透明背景覆盖其上），骨架撤除等 listRendered（rangeChanged 首次回调 = 列表首帧渲染完成；空列表/异常 2.5s 兜底）+ 最短展示时长；配合 initialTopMostItemIndex，撤骨架瞬间露出的是已贴底渲染完成的列表，消除「骨架撤→空帧→内容」闪烁。测试：session-switch-pin 新增先渲染后撤契约 + session-initializing 骨架最短展示适配

- 版本：0.4.2 → 0.4.3（27 提交）。
- 修复：切换会话跳顶/加载重叠；流式卡顿与闪烁；侧边栏卡顿；失效提问无法取消；定时任务执行记录变卡；Windows 会话数据写入失败（EPERM）；记忆归档未按项目过滤；扩展弹窗裁切。
- 优化：空闲暂停后台轮询；文件路径 chip / 文件树请求治理；自定义供应商 thinkingLevelMap 透传。
- 验证：typecheck 全绿；四层回归全绿（隔离 worktree）。
- 影响范围：frontend（MessageList/SessionView/侧边栏）、kernel（scheduler/project-store/memory/extension）。

## 2026-09-17
- fix(frontend): 会话切换首帧贴底——历史就绪挂载列表后 useLayoutEffect 直接同步置 scrollTop（不等 virtuoso scrollToIndex 的异步调度），paint 前生效；实验过官方 initialTopMostItemIndex 方案但与 happy-dom 测试基建存在定位死锁（items 不渲染）故回滚，保留 scrollTop+收敛方案
- fix(frontend): 会话切换首帧贴底——历史就绪挂载列表后 useLayoutEffect 直接同步置 scrollTop（不等 virtuoso scrollToIndex 的异步调度），paint 前生效，消除「顶部首屏→跳底」最后残留；E2E 新增真实 Chromium 断言（切会话首帧 scrollTop ≥90% 最大滚动距离）
- fix(frontend): 会话切换 loading 与列表重叠修复——列表挂载条件从 showHistoryLoading 对齐到 skeletonShown（skeleton 有 500ms 最小展示防一闪而过，原条件下列表挂载时骨架未撤 → 内容与「加载会话…」同屏重叠）；配合 useLayoutEffect paint 前贴底，切换会话只剩「loading → 已贴底列表」一次切换。测试：session-switch-pin 契约更新（挂载对齐 skeleton 撤除）
- fix(frontend+kernel): 失效提问可正常取消（此前点取消毫无反应、卡片永久阻塞输入框）——根因：失效 ask 在内核 AskRegistry 已无条目，cancel-ask 静默 no-op 返 200，前端 fire-and-forget 不本地卸载，而卡片卸载只认 toolResult（失效后永不产生）→ 卡片常驻 + Composer 永久禁用。修复：①kernel cancel-ask 未命中 reply error（400 code session.promptStale，与 answer 对齐；测试 kit 同步对齐）；②前端新增本地关闭集合（store/ask.ts 新增 useDismissedAskStore + useVisibleAsks，useIsBlocked 排除已关闭，关闭后输入框解锁）；③AskFormCard 在 stale 或提交收到 400 时点「取消」直接本地关闭，取消失败提示「取消失败，请重试」，提交 400 后同一张卡片也有关闭出口；④折叠便签补关闭入口（stale 或提交 400 时显示 ✕）；⑤关闭标记在 toolResult 到达后自动回收。测试：kernel routes-chat 10 pass（新增 cancel-ask 未命中 400）、前端 AskFormCard 20/AskDock 13/AskQuickBar 18 全绿、E2E ask-stale 新增「失效卡片点取消 → 卡片关闭 + 输入框解锁并可输入」3/3 通过
- style(frontend): 切会话加载界面视觉优化——spinner+文案升级为对话节奏骨架屏（交错占位条 stagger 呼吸 + spinner+状态文案，skeleton-in 渐显入场），session-initializing 与 history-loading 两处统一复用 SessionSkeleton；颜色全走 token（bg-hairline，暗色自适应），修复工作区遗留的未提交半成品牌式损坏（Virtuoso 挂载门控丢失 { 变纯文本）
- fix(frontend): 流式渲染停顿降级改为节流（消除闪烁）——用户实测 plain↔markdown 交替闪烁、切换会话闪一下；MarkdownBlock/ThinkingCard/StreamingOutput 统一改 useThrottledValue 节流（50ms），流式中始终渲染 markdown、解析降为低频，结束/历史/会话切换零延迟。测试重写为节流语义（markdown-streaming-throttle 4 例等），全量 2471 pass + E2E 冒烟 3/3
- test(e2e): 新增 lag-fix-smoke.spec.ts——卡顿三轮修复的真实浏览器冒烟验收（流式降级 50ms 切换/thinking Linkify 降级/工具循环 15 轮 longtask 观察），实测修复后工具循环负载长任务 0 个（修复前 trace 实测 300-593ms×13）
- fix(frontend): 流式渲染两处收尾——①SessionView 拆字段 selector（title/projectId/primaryAgent/createdAt 各自订阅原始值）：trace 实测工具循环期间每个 message_end 的 touchSession 新 session 对象击穿 SessionView 整树（含无 memo 的 Composer/GitToolbar/AgentSwitcher 等，5.2s 长任务），对象引用变化不再击穿；子树残留渲染仅 Composer 自身整店订阅（修复 3 待做）。②流式降级停顿阈值 500ms→50ms（MarkdownBlock/ThinkingCard）：用户反馈 500ms 感知为「卡住不渲染」。测试：session-view-scope 2 例（Profiler 渲染计数 + 二次 touchSession 渲染数恒定契约）+ 默认阈值 2 例，全量 2471 pass，E2E session-history/app-flow/send-scroll 全绿

- feat(frontend): 切会话过渡改为每次触发——showHistoryLoading 去掉 messages.length===0 限制（缓存命中也走骨架过渡），新增 SKELETON_MIN_DISPLAY_MS=500ms 最短显示时长（防骨架一闪而过像闪烁；列表挂载不等此值，贴底内容提前就绪）；SessionSkeleton 移除 spinner 仅保留骨架+文案。配套：SessionSkeleton 测试 2 例 + SessionView.test beforeEach 补清 historyLoadingBySession（修复跨用例污染）+ 旧「不显示历史加载」用例改名适配新语义
- style(frontend): 切会话加载界面视觉优化——spinner+文案升级为对话节奏骨架屏（交错占位条 stagger 呼吸 + 状态文案，skeleton-in 渐显入场），session-initializing 与 history-loading 两处统一复用 SessionSkeleton；颜色全走 token（bg-hairline，暗色自适应），修复工作区遗留的未提交半成品牌式损坏（Virtuoso 挂载门控丢失 { 变纯文本）
- test(e2e): automation 用例 6 Windows 必挂修复——CLI 建任务的 execSync 字符串命令经 cmd.exe 解析，单引号不是 cmd 引用字符，JSON schedule 原样传入报「--schedule 不是合法 JSON」；改 execFileSync 参数数组直传（不经 shell）+ process.execPath + JSON.stringify 生成 schedule，跨平台稳定。验证：automation E2E 7/7 全绿（此前 6/7）
- test(kernel): 全量测试 100% 通过恢复（基线 176 fail）——①元凶：cloudflare-pages-client.test.ts 的 afterEach 用 delete globalThis.fetch 替代恢复原值，bun test 单进程跑全量时殃及后续所有依赖 fetch 的文件（fetch is not a function 约百处连锁）；②file-route 等 5 个集成测试每用例启新 kernel 但 stopHandle 被覆盖，泄漏实例句柄锁住临时目录致 afterAll 清理 EBUSY——改为每用例 try/finally 即关，清理 rm 加容错（scheduler fs.watch 句柄锁目录到进程退出）；③scripts/test.ts 新增 MOCK_LEAKY_TESTS 类别：fs-open-env 的 mock.module(node:child_process) 在 Bun 1.4 无恢复 API 且 --isolate 同 worker（实测两文件 PID 相同），与 npm-package-service 一起主批排除、单独进程补跑；另清理 TEMP 历史泄漏临时目录 1.6 万个。结果：kernel 14 批全绿 + shared 166 + desktop 227 + frontend 2453 全部 0 fail
- fix(kernel): projects.json 读失败不再反写空库（清库止血）——此前 load() 读失败（文件被占用瞬间/解析失败）静默回退空库，写路径拿到空快照后全量写回即清空全部项目与会话（2026-09-17 事故：projects.json 反复「变空」）。修复：新增私有 loadStrict()，18 个写方法改用之——文件存在但读失败时抛错（project.storeReadFailed）拒绝写、不产生任何写回；ENOENT（首次启动）仍是合法空库；纯只读路径保持 catch-empty。测试 3 例全过
- fix(kernel): 自定义供应商 extension 透传内置目录 thinkingLevelMap——生成器此前只透传 reasoning/compat，丢弃 thinkingLevelMap（glm-5.3-flash 声明 off:null/medium:null 即仅支持 low/high/max），导致 pi 侧 clampThinkingLevel 钉制失效，前端默认 thinking=disabled→off 原样透传，pi-ai zai 分支（baseUrl 含 open.bigmodel.cn）发 thinking:{type:"disabled"}，智谱始终思考模型 400 1210「不支持关闭思考；请使用 low、high 或 max」。修复：CatalogModel/SdkModelInfo 补 thinkingLevelMap 字段、modelToInfo 透传、生成模板输出该字段，EXTENSION_GENERATOR_VERSION 3→4（旧生成文件启动时自动重生成）。验证：实测官方目录 supported=[low,high,max]、丢失 map 后含 off/medium；重生成产物已含 off:null；provider-extension 测试 46 pass（新增回归 1 例）
- fix(frontend): 侧边栏渲染范围修复（trace 实证卡顿根因）——Chrome Performance Trace 实测一次 store 更新触发 React workLoopSync 同步渲染整棵应用树（SessionRow 33%+ProjectItem 16% 主线程热点，300ms 长任务期间点击无响应）：①ProjectList 由 useProjectsStore() 整店订阅改为按字段 selector（无关字段如 dirPickerOpen 的 set 不再重渲染列表）；②SessionRow/ProjectItem memo 化（TrashSessionRow 先例），ProjectItem 内 handleSessionContextMenu 配 useCallback（否则每次渲染新引用使 memo 失效）；③touchSession 目标不在列表时返回原 state，不再无条件 map 制造假引用变化。测试：新增 projects-touch 2 例 + sidebar-render-scope 4 例（Profiler onRender 渲染计数），全量 2464 pass，E2E app-flow/recent-sessions/session-history 全绿
- fix(frontend): 会话界面流式卡顿修复——根因为流式中正在增长的末块每帧全量重跑 ReactMarkdown/remarkGfm（超长回复后期单帧解析实测 1.5万字≈34ms/12万字≈303ms，超 60fps 帧预算数十倍，主线程占满、点击无响应）；①MarkdownBlock 接入停顿降级（isStreaming && !useSettled(500ms) → 纯文本预览，停顿/结束切完整 markdown，复用 StreamingOutput 3.3 既有模式），renderSeg→TextContent 透传 segIsStreaming；②ThinkingCard memo 化 + 流式未停顿跳过 Linkify（消除每帧 O(全文) 正则 split）；测试：新增 markdown-streaming-degrade 4 例 + ThinkingCard 4 例，全量 2458 pass，E2E 渲染路径 4 spec 7 过（streaming-render-perf 的 delegate 用例为既有 flaky，基线 stash 复现确认与本改动无关）
- perf(frontend): 侧边栏卡顿修复——trace 实测 SessionRow+ProjectItem 占同步渲染主线程热点近半：①ProjectList 整店订阅改按字段 selector（store 任意字段 set 不再连坐整个列表）；②ProjectItem/SessionRow memo 化（touchSession 后未变项对象引用稳定则整块跳过）+ ProjectItem 会话右键回调 useCallback 稳定引用；③touchSession 目标不在列表时返回原 state，不再无条件 map 制造假引用变化（曾是侧边栏全量重渲染入口）。测试：新增 sidebar-render-scope（selector 订阅/memo 跳过）+ projects-touch（目标缺失不新建 state）用例，相关 5 文件 17 pass，frontend typecheck 过
- fix(kernel): 记忆归档列表按项目过滤——list() 归档段曾返回全量归档（注释「与旧 sidecar 等价：不按作用域/项目切分」），而前端归档 tab 仅按 scope 二值过滤，导致归档下切换不同项目作用域列表不变（全部项目的归档混显）；且与检索链路口径不一（archivedOnly 检索已按项目下推）。修复：归档段与 memories 段同口径（scope=global + scope=project&projectId 两段查询，archivedOnly: true），前端 filteredArchived 无需改动。测试：kernel memory-store 45 pass（新增回归 2 例：多项目归档过滤 + 未知项目隔离，并改写旧契约测试「任意 list 可见」→「本项目可见」）+ E2E memory.spec 14 passed（新增「项目归档可见、切全局后隐藏」）
- fix(kernel): projects.json 写盘在 Windows 上报 "Send failed: EPERM rename" 修复——①save() 对 rename 做 EPERM 退避重试（50ms起最多4次：Windows 上目标文件被杀软实时扫描/并发读者短暂持有时 MoveFileEx 报 ACCESS_DENIED→EPERM，错误沿发送链路冒泡成发送失败）；②全部 10 个未入队「读-改-写」写点（createProject/createSession/fillSessionTitleIfEmpty/setSessionAgent/setSessionProjectId/updateProject/renameSession/purgeOldTrashSessions/reassignSession/createSystemProject）统一入 writeQueue 串行队列，消除与 message_end fire-and-forget touchSession 并发时的 lost update 与同 tmp 路径竞争。测试：单测5个（mock.node:fs/promises 注入 EPERM 验证重试次数/非EPERM不重试/上限抛错 + save 并发探针断言串行化）+ E2E 回归（ask-stale 2 + send-scroll 5 全绿）
- perf(scheduler): 执行记录三步改造，拆掉「放久了卡」隐患：①后端 listRecords 支持 ?limit=（taskId+limit 走日志尾读 readTailLines+首遇即赢去重，不再全量解析历史，缺窗口时自动扩读）+ ?since=，前端 TaskDetailView「最近执行」改 ?taskId=&limit=3 尾读（新 store 字段 recentRecords，不污染列表数据）；②appendRecord 同步原子写 logs/<taskId>.latest.json 索引 + ?latest=1 聚合端点，侧栏状态点改 loadLatestByTask 读索引（无索引旧数据/损坏时退化尾读兑底），不再全量拉 records；③ExecutionRecords 列表页按 period 窗口增量拉取（?since=，不再默认全量 200）+ 窗口满 200 时显示「加载更早」向前扩窗重拉。测试：kernel store/路由新增 7 用例（尾读去重/损坏行/超长行扩读/latest 索引兑底/since 过滤/路由参数钳 200），前端 automation 3 组件 + encoding 测试同步更新新增 5 用例，全量 2453 通过 0 失败 + E2E automation 5/6（用例 6 为 cmd 单引号 JSON 既有环境问题，与本次无关）
- perf(frontend): 空闲轮询止血——窗口不可见（document.hidden）时暂停常驻流量：①ExplorerPanel 目录树 5s 轮询跳过隐藏期；②SSE 广播驱动的定时任务列表/执行记录拉取在隐藏期跳过，visibilitychange 恢复可见时统一补拉一次。背景：空闲时每 5s 一轮 scheduled-tasks/execution-records/list-dir 请求永不停止（watcher 无条件广播 + 无可见性暂停），长期后台负载是「放久了卡」的嫌疑源。测试：tsc + 前端全量 2450 通过 0 失败 + vite build 通过
- fix(memory): 记忆提示词二次优化（v5→v6c，冲 99%）——根因实锤为字面关键词冲突：knowledge 规则的「技术选型/项目约定」字面命中调研选型（E4）与方案沉淀（E9）场景导致误路由。改法：①knowledge 行就地消歧（讨论拍板→knowledge；实测/排查/交付过程→execution）；②排除项「只是拍板」加反例豁免（已验证可行的方案即使表述为「以后都这样」也记 execution）；③工具描述与 kind 描述同步加 verified solutions 豁免。评测：同窗口交错对照（v5 97.2% / v6a 99.1% / v6b 98.1% / v6c 100%），v6c 连续 8 轮 100%（含跨时段），测试 83 通过 0 失败
- fix(memory): 记忆提示词优化——修复执行记录（kind=execution）从不写入的问题（线上全库 0 条、219 个实质会话 0 次触发）：①工具描述从「否定一切任务记录」改为 knowledge/execution 双类型定义，负面清单不再误伤「修了什么 bug」这类执行记录典型内容，「拿不准就不记」限定到 knowledge；②Memory Policy 新增「任务收尾必写执行记录」事件锚点段（先排除未完成/纯问答/单步小改/拍板未执行，再匹配完成标准），记录格式固定「做了什么+结果+结论」1-3 行；③compact 版与 kind 参数描述同步。评测：36 组测试 case（3 场景×10 + 陷阱）、glm-5.3-flash 实测 23 轮，总正确率基线 ~89% → 最终窗口均值 95.1%，执行陷阱 T1 从 0% → 100%；残留：调研选型双关场景（E4/E9）存在模型侧 ~10-30% 轮次抖动（非文案问题）。评测资产：~/.pi/agent/tmp/mem-eval/
- feat(kernel): memory_search 支持时间范围过滤——新增 since/until（闭区间；接受毫秒时间戳或 'YYYY-MM-DD'/ISO 日期串；日期串按本地时区、until 含当天；非法值一律忽略不报错）与 timeField（'updated' 默认 / 'created'）；时间条件下推到 buildFilter，使 search / countMatches / list / counts / 子串回退路线共用同一口径；参数抽成 shared 的 MemorySearchParamsSchema，消掉 kernel 工具与 bridge 扩展两处手写副本（此前靠人同步）。测试：DAO 4 例 + 工具 3 例（含 parseTimeBound 拒绝 2026-13-45 这类被 Date 静默滚动的非法日期）+ 真库副本端到端验证；kernel memory 相关 184 pass、shared 166 pass、typecheck 过
- fix(shared): delegate/fleet 工具描述补「何时选 fleet」判据——delegate 原文只讲「什么时候该 delegate」、完全没提 fleet，多个独立子任务时易被拆成连续多次 delegate；fleet 原文已有 Use/Do NOT 两段但缺「与顺序 delegate 对比」的正向判据。改法：DELEGATE_DESCRIPTION 增一段「待办是多个互相独立的子任务、且每个任务的范围/输出格式/约束现在就能独立写全 → 一次 fleet 并行派发，不要连续 delegate 多次；反之后一个依赖前一个结果、或对同一处文件逐步推进 → 逐个 delegate」；FLEET_DESCRIPTION 增「能立刻写全每个任务的范围/输出/约束、无人等他人结果时才选 fleet（而非顺序 delegate）」。文案集中在 packages/shared/src/tool-schemas.ts，kernel delegate-tool 与 wa-pi-bridge.extension 均直接引用故两处同步生效。测试：shared tool-schemas + kernel system-prompt 55 pass 0 fail（含两个 DESCRIPTION 与真实工具实例 description 相等的一致性用例）+ kernel bridge 20 pass（resolvePiCliPath 1 例失败为改动前既有环境问题，与本改无关）。影响范围：shared（tool-schemas）、agent 可见工具文案
- test(kernel): delegate 触发率评测扩充——原 60 条用例只增不改，新增 edit-small(12)/edit-explore(6)/fleet(6)/zh-casual(8)/hiagent(10) 五类 42 条用例，新增混淆矩阵（误派率/漏派率）、首次派发轮次、单用例 token 开销三组指标；102 条全量实测（deepseek-v4-flash，隔离 worktree）：explore/edit-explore/fleet 触发 100%，simple 与小改类 edit-small 误派 0%（「随便改一个文件就派子代理」在本评测环境未复现），误派集中在 hiagent 查询类（3/6，如「定时任务日志在哪」误派 Explore），整体误派率 7.1%，已派单例 token 均值 435k 为未派 92.7k 的 4.7 倍；3 例超时（均应派且已派，不影响派发判定）；报告 ~/.wa-pi/eval-dt-full.json

## 2026-09-16

- fix(frontend): 记忆管理归档 Tab 作用域对齐——归档列表与徽标补上 scope 过滤（原先混显全局+项目归档），现在跟左上角作用域下拉一致：全局作用域只看全局归档，切项目只看该项目归档；徽标同口径只计当前作用域。测试：组件（归档列表/徽标随作用域切换 3→2→1）+ E2E（真实浏览器：全局归档不含项目条目、切项目后空态）
- fix(frontend): 记忆管理归档 Tab 类型筛选失效——归档列表渲染直用原始 archived 数组未消费 kindFilter（已保存 Tab 走 filteredMemories 双过滤，归档路径漏了层级筛选），补 filteredArchived 同口径过滤；测试：组件回归（归档内点画像仅剩画像条目/取消恢复）+ E2E（真实浏览器归档→按 kind 徽标计数断言筛选/切回全量）
- chore(memory): 统一子串回退注释与测试示例数据用词为「示例/示」（dao.ts 注释 + memory-dao 测试数据同步替换，对照条目同步调整，行为等价，34 测试全绿）
- fix(frontend): pi 扩展 dialog 弹窗（select/confirm/input/editor）①限高视口 70%——Modal 加 maxHeight 能力，长消息/长选项列表在卡内滚动（header/footer 固定），不再垂直溢出屏幕；②会话锁定——ExtensionDialog 从 App 根节点移挂 SessionView 内按 sessionId 过滤（与 ask 同款），其它会话的 pending 请求不再盖住整个窗口；ext-dialog store 出队改按 requestId（resolveCurrent→resolveById），多会话并发 pending 互不误删。测试：组件（会话锁定/限高断言）+ E2E（真实浏览器注入 sdk:event：长内容 ratio=0.70 卡内滚动、跨会话不弹、切会话出现、应答出队）
- v0.4.2 发版（三层记忆系统重构）
- feat(memory): 记忆面板收敛——移除旧分类维度 + 搜索接通服务端 FTS/BM25
- feat(frontend): 记忆检索中状态改为三段式空态（含搜索词）
- perf(frontend): 文件树大目录卡顿修复——虚拟滚动 + 轮询按需更新
- feat(frontend): 收缩态 TUI chip 队列改为靠右 + 可自由拖动 + 位置持久化
- fix(frontend): TUI 面板展开态不再把内部位置标识当标题渲染
- feat(memory): 三层记忆系统落地（markdown → SQLite + FTS5/BM25）
- fix(frontend): md 预览虚拟滚动拆散 HTML 容器，居中 logo 变左对齐
- fix(kernel): 发送前自动压缩估算按 CJK 加权 + 双条件判定，修复长中文会话撞上游窗口 400 卡死
- fix(frontend): 带附件的消息发送失败后「重新发送」丢失附件
- v0.4.1 发版（插件注册冲突校验 + 预览修复）
- chore(docs): CHANGELOG 压缩为「一天一条」（453 条 → 64 天）+ AGENTS.md 增补「同一天只能有一条记录」规则
- perf(fs): 文件路径 chip / 文件树的请求放大治理（卡顿定位与修复）——① listDir 加「同路径在途去重」（并发重复只发一次，不缓存结果以免拿到过期目录）；② 新增 `POST /api/fs/stat-batch`，FilePill 改为同批合并探测（原先消息里 N 个路径 chip = N 次 /api/fs/stat，现在合并为 1 次），并在前端按微任务窗口攒批；③ 存在性探测加 3s TTL 缓存（吸收虚拟滚动重挂载的重复探测）；④ `/api/fs/stat` 去掉冗余的 existsSync（2 次磁盘操作 → 1 次）；⑤ FleetCard 的 mdComponents 补 useMemo（漏网的一处：内联组件每帧新建 → 整树 remount → chip 反复探测）。排查依据：ExplorerPanel 每 5s 轮询已展开目录（展开 K 个 = 每 5s K+1 个 list-dir）、虚拟滚动重挂载重发 stat。影响：frontend（fs-client / FilePill / FleetCard）、kernel（routes/fs）。测试：单测 + 组件（同批 3 chip → 1 请求）+ API（真实 HTTP 断言 stat-batch 契约）+ E2E（真实浏览器文件树/预览链路无回归）；前端全量 2445 通过。

## 2026-09-15

- feat(kernel+frontend): 插件注册面冲突——安装后问 pi 要注册表，重复命令当场拦下
- fix(scripts): GitHub 镜像同步改为「只提交变化条目」（修 POST /git/trees 超时挂起）
- fix(frontend): 浏览器（无 Electron 桥）遗留 float 偏好吞掉 html 预览
- docs(website): 官网补上「TUI 插件完整支持」
- v0.3.22 发版（TUI 宿主功能 + 压缩守卫/扩展 pin/文件预览修复）
- fix(frontend): 文件预览块级虚拟滚动（代码 + markdown 两条分支）
- fix(kernel): 扩展静默失效（pin 漂移）——加 --exact + 启动时对齐 pin
- fix(kernel): 压缩守卫扩展（修复长会话压缩失败死循环）
- feat(kernel/shared/frontend): 扩展 TUI 宿主与三态面板（ctx.ui.custom / setWidget 图形化）

## 2026-09-14

- v0.3.21 发版（浮动预览独立窗口）
- feat(frontend/desktop): 浮动预览改为独立系统窗口承载（可移出主窗口、与主窗口并行显示）

## 2026-09-10

- v0.3.19 发版（工具卡行数统计 + 渲染稳定性修复）
- v0.3.20 发版（气泡指令文本泄漏修复）
- fix(frontend): 每条用户气泡顶部多出一行 pi-lens 抑制指令文本
- fix(kernel): OpenCode Go 供应商「测试连接」假报 400（漏 x-opencode-session）

## 2026-09-09

- fix(frontend): 流式输出时文件 chip/图片/视频闪烁（每帧整树 remount）
- feat(frontend): edit/write 工具卡右侧 +N -M 行数统计
- fix: 聊天长过程卡折叠后视口跳顶
- fix: 超长无空格字符串的用户消息撑爆窗口
- v0.3.18 发版（下拉选择器修复 + thinking 模型 400 修复）
- fix: 自定义供应商 thinking 模型多轮对话 400（reasoning_content 未回传）

## 2026-09-08

- fix: 模型/思考下拉选择器——宽度自适应 + 箭头统一
- v0.3.17 发版（分享空间功能）
- 新增功能: 分享空间（Cloudflare 渠道多空间分享隔离）
- v0.3.16 发版（会话归档误伤修复 + Git 工具栏收敛）
- fix: 会话自动归档误伤修复（阈值锁死/恢复重删/归档后活动不复活/并发写覆盖）

## 2026-09-07

- 改进：会话 Git 工具栏收敛为分支 chip 单入口
- v0.3.15 发版（Git 拉取链路修复 + 窄窗口布局）
- fix: 拉取最新代码在本地有未提交修改时失败 + toast 错误码不可读
- v0.3.14 发版（修复 Git 图谱表格列错位）
- fix(frontend): Git 图谱表格列错位

## 2026-09-06

- v0.3.13 发版（项目分支管理）
- feat: 项目分支管理预览切换（kernel git 域 + 前端 Git 工具栏/分支菜单/Git 图谱）

## 2026-09-05

- v0.3.12 发版（对话媒体内联预览 + pi 0.85.1）
- chore(deps): pi SDK 升级 0.84.4 → 0.85.1
- feat: 对话媒体内联预览（图片网格/内联视频/画廊弹窗/复制）+ kernel /file 白名单泛化

## 2026-09-04

- v0.3.11 发版（provider maxTokens + 会话切换链路修复）
- fix(kernel): 自定义 provider 模型 maxTokens 用户显式配置优先（第三方端点 max_completion_tokens 超服务端上限 400 必挂）

## 2026-09-02

- fix(frontend): 压缩期间排队消息自动发出后不在界面显示
- fix(kernel): 空闲回收后的会话切换角色必失败一次（「会话已清理」）
- fix(frontend): 切换智能体失败静默（未捕获 rejection + 无提示）
- fix(frontend): 会话顶部角色删除后提示可点击重选
- fix(frontend): 会话标题撑高顶部 + 角色入口改只读展示
- fix(frontend): 小窗口下半屏预览关闭按钮被裁不可见
- fix(frontend): 排队引导窗口超长文字撑满会话视野

## 2026-09-01

- v0.3.10 发版（浮动预览居中 + Cmd 切换去抖）
- fix(preview): 浮动预览无记录双向居中 + Cmd 切换双发去抖
- v0.3.9 发版（修复预览元素选中 bug）
- fix(scripts): dev 按 R 重载卡死修复（防重入 + 就绪主动探测 + 反馈）
- feat(website): 官网下载直连 R2 最新安装包（清单解析 + 桶 CORS）
- v0.3.8 发版（优化青蛙动画）
- v0.3.7 发版（预览高亮开关同步 + 归档 15 天 + 中文首启修复）
- fix(trash): 归档区行增加会话标题列（第一列标题、第二列角色）
- feat(trash): 自动归档默认天数 7 → 15；确认清理计时基准为进区时刻
- chore(memory): memory_add 工具描述加「通用总结类才记」存储准则
- fix(preview): 元素选中开关与实际高亮状态失步（开启不亮/关闭反亮/刷新后失效）
- fix(desktop): 中文 Windows 安装包首启引导/界面显示英文（渲染进程 locale 修复）
- v0.3.6 发版（Pi 引擎 0.84.4 + 清空队列即生效 + chip 复制修复）
- feat(kernel): 委托并发上限 5 → 6
- fix(kernel): 子代理会话 MCP 工具不可见——spawn 链路补装 pi-mcp-adapter + 白名单并入 MCP 工具
- v0.3.5 发版（预览文本嗅探兜底 + 引导附件卡片化 + 插件并行升级修复）
- v0.3.4 发版（代码预览扩展 + 官网移动端适配）
- fix(kernel): 多插件并行升级互踩——只有一个成功、其余回退
- v0.3.3 发版（青蛙主题官网上线 + 折叠滚动收敛）
- fix(frontend): 富文本粘贴后光标跳到输入框末尾（web/桌面通用）
- fix(desktop): Windows/Linux 桌面端输入框 Ctrl+Z 撤销失效
- fix(frontend): 长任务结束整轮折叠后滚动位置跳中间（收敛循环兑底）
- feat(preview): pi 升级 0.84.4 + 清空队列接入 clear_queue RPC（全清语义）
- feat(preview): 聊天窗/排队区 /命令展开形态按白名单还原为命令 chip（skill chip 复制粘贴确认已闭环）
- fix(preview): 聊天窗复制 chip 粘贴回输入框不渲染 chip（展示区复制语义保留）
- feat(preview): 排队区/聊天窗引导附件尾段渲染为「附件:文件名」chip
- feat(preview): 预览大小上限 3MB → 5MB + ws/http 双链路预览判定对齐（补嗅探兑底与图片放行）
- feat(preview): 未识别类型文件文本嗅探兑底——内容为文本即纯文本打开，仅真二进制拒绝
- feat(preview): 文件预览支持 .sh/.java/.go 等主流代码文件（kernel 放行 + Prism 语言补齐）
- fix(frontend): 文件树拖拽插入格式与手输 # 统一 + 聊天窗补 #path: chip 还原
- feat(frontend): 文件预览弹窗点遮罩不关闭 + 右下角拖动调整大小
- fix(frontend): 排队队列面板渲染技能/文件路径 chip
- fix(kernel/test): 裸 bun test 全量挂死根治（任意机器可直接跑全量）
- fix(steer): Ctrl+Enter 发送引导消息附件全链路丢失

## 2026-08-31

- chore(scripts): 新增 GitHub 镜像同步工具 sync-github-mirror.ts
- fix(scripts): dev 一键启动端口写死 9776，不再读 WA_PI_WS_PORT 环境变量
- fix(kernel/shared): 合成 agent_end 打 synthetic 标记，修复一次任务完成蛙叫两声
- feat(frontend): 左上角 Logo 换成动态青蛙（14 动作随机 · 10~20s 一次）
- feat(frontend): 任务完成青蛙全量重设计（19 动画变体 × 8 位置）
- chore(kernel): 单个子代理委派整体硬上限默认 60 分钟 → 2 小时
- fix(website): 官网青蛙彩蛋音效由 Web Audio 合成电子音改为系统内置真实青蛙叫

## 2026-08-29

- feat(website): 新增青蛙主题官网 + R2 发布 + 关于页入口

## 2026-08-30

- feat(i18n): kernel 后端面向用户文案 code 化全链路收尾（任务 0-6）
- fix(desktop): splash 窗口与 runtime-deps 依赖进度文案接入系统语言渲染（Task 5 审查遗漏补漏）
- feat(desktop): 启动进度/更新文案按系统语言渲染（desktop 独立通道 i18n，任务 5）
- feat(kernel): language 偏好打通前端→kernel settings（后端 i18n 基建，任务 1）
- v0.3.1 发版（Windows 默认命令切换 PowerShell + 稳定性修复）
- v0.2.30 发版（新建会话文件树两处修复）
- v0.2.29 发版（浮窗拖拽与默认态修复 + SidebarResizer 宽度传播）
- fix(settings): 模型「测试连接」报错不再泄露本地代理信息，网络失败改用户可读文案
- fix(preview/float): 拖地址栏宽度不再带动浮窗 + 默认居中弹出、位置直写不丢
- fix(new-session): 文件树展开多时输入框被顶出屏底
- feat(preview): 元素选中显性开关 + 地址栏默认半宽/可拽调宽

## 2026-08-28

- feat(frontend): 文件树拖拽到输入框改为文件 chip（#path: 引用）
- fix(kernel): 系统打开出口剥离 WA_PI_* 环境变量（防子进程继承端口/目录变量）
- fix(frontend): 全屏预览关闭后不再重置会话界面（文件树展开状态保留）
- feat(kernel): Windows 默认命令工具切换为 powershell（bash 运行时映射）
- v0.2.28 发版（预览地址栏适配 + 嵌套子页双高亮修复）
- fix(preview): A 锁定后移入嵌套子页仍出现子页 hover（双高亮残窗）
- fix(preview): .vue 文件无法进代码预览（MIME 误判非文本）
- feat(preview): 嵌套子页文件被修改时外层预览也自动刷新
- v0.2.27 发版（预览自动刷新 + 定时任务全局化收口 + 稳定性修复）
- chore(deps): 底层 Pi 引擎升级 0.84.2 → 0.84.3
- feat(settings): 定时任务完成提示音开关（默认关）+ 定时任务完成不再触发青蛙动画
- feat(preview): 嵌套选中互斥 + 锁图标常驻（可交互元素稳定锁定）
- fix(preview): hover 选中跨层残留改为全局广播方案（快速移动可靠）
- fix(preview): hover 选中跨层残留（A hover 后移入 B 双高亮）
- feat(preview): 嵌套选中互斥 + 锁图标常驻（可交互元素稳定锁定）
- fix(preview): srcdoc 内选中元素「发送到聊天」无反应（srcPath=null 被误拒）
- fix(preview): srcdoc 型嵌套 iframe 内元素选中不可用（真机复现补全修复）
- feat(preview): 任务完成后预览文件被修改时自动刷新预览
- fix(kernel): Windows 中文安装路径下 pi rpc 全部启动失败（「系统找不到指定的路径」）
- fix(kernel): 修复大会话慢模型下发消息误报「agent 启动失败: RPC 命令超时」
- fix(preview): 预览页嵌套 iframe 时元素选中可正常发送到聊天
- fix(ui): 回收站角标红色改灰色，降低视觉干扰

## 2026-08-27

- fix(new-session): 文件树两处修复：根行撑破 + 右键菜单超窗
- feat(kernel): agent 进程异常退出现场落盘 agent-crash.log
- fix(preview): 修复页面滚动后预览高亮选中框消失
- v0.2.26 发版（定时任务 AI 化 + 全局目录架构）
- fix(ui): 插件 notify 通知不再顶掉消息流末尾的文件修改清单
- fix(ui): 手动 /compact 压缩成功后提示应出现在消息流末尾
- fix(ui): 压缩开始/完成时消息未自动滚动到底部
- fix(kernel): 定时任务 list 显示所属项目 + 保留「禁止直接编辑或删除」约束
- feat(kernel): 定时任务全局化收口——项目隔离 + ctx 注入模板 + delete 命令 + --im-push 推送标记
- feat(kernel): 新增 list_contacts 工具（agent 查询当前系统可用联系人）
- fix(kernel): list_contacts 所属渠道列改显示「渠道类型 · 机器人名」
- v0.2.25 发版（预览归属/高亮收敛 + 提示音随机池 + 引导队列修复）
- fix(preview): 新建会话页从文件树打开 html 预览带 sessionId 锚点，切走切回能恢复
- feat(sound): 事件完成提示音改为随机池播放（新增 6 个前 1 秒音效 + 原有青蛙叫）
- fix(preview): 切到新建会话/空视图时关闭预览不残留；新建会话页顶部加预览图标
- fix(preview): 本地预览高亮选择框在屏幕边缘时收敛进视口，不再溢出
- fix(steer): 同一会话同时只允许一条引导中，已有引导时后续引导降级为排队
- v0.2.24 发版（应用内置内核升级 0.1.3 + 内核更新清单平台化）
- 内核独立发布 v0.1.3（自动压缩阈值改用率百分比更早触发）
- perf(kernel): 发送前自动压缩阈值从「窗口−33K 预留」改为「窗口 85%」更早触发
- v0.2.23 发版（回复过程默认折叠开关 + 附件绝对路径修复 + MCP 测试兼容修复）
- fix(test): MCP stdio 连接测试在打包环境下挂起（spawn 缺 BUN_BE_BUN=1）
- feat(share): 再次分享同组文件时预填上一次分享名

## 2026-08-26

- feat(ui): 任务完成青蛙动画（随机姿势 + 聊天区四角随机蹦出）
- **fix（定时任务 AI 化·整分支审查 5 项收口）**：①`sanitizeTaskId`（shared/task-file.ts 与 CLI cron-task.ts 同规则）在剥前导点后再折叠中间连续点为 `-`，并同步将 `SC
- test(e2e): automation.spec.ts 新增定时任务 AI 化（CLI 建任务 + 配置错误修复）两条端到端场景
- test(scripts): 定时任务文件夹化 API 集成测试（scheduler-api-it.sh）
- feat(frontend): 自动化面板展示并修复配置错误的定时任务文件
- feat(kernel): 系统提示词新增 scheduled-tasks 运行时注入段
- feat(kernel): 定时任务装配切换——文件夹存储 + watcher + 迁移 + kernel.json
- feat(kernel): 定时任务 CLI 与 README 资产及自动分发
- refactor(kernel): 定时任务 REST 与调度器切换到文件夹存储
- feat(kernel): 旧定时任务 JSON 到项目文件夹的一次性迁移

## 2026-08-25

- fix(kernel): 中止（停止）成功后广播 agent_end，修复前端停止后永远卡「思考中」

## 2026-08-24

- feat(ui): 外观设置新增「回复过程默认折叠」开关（agent 回复中工具调用/思维链默认不展开）
- fix(kernel): 上传附件发给 AI 的路径改为绝对路径（不再用项目相对路径）
- v0.2.22 补丁发版（关于页内核版本显示修复 + Windows bash 检测修复 + 内核独立发布）
- fix(kernel): Windows 被 WSL 占位 stub 欺骗导致 PortableGit 永远不接线，bash 工具报 "No bash shell found"
- fix(preview): 锁定元素后点击其他元素不再切换/解除高亮
- fix(preview): 关闭高亮选择后页面滚动/缩放不会再让高亮复活
- feat(preview): 预览高亮选择支持 Ctrl/Cmd 开关 + 平台按键提示 + 状态本地保存
- v0.2.21 发版（kernel 二进制动态更新 + 内核版本独立管控 0.1.1 关于页显示 + 预览锁定 + Pi 依赖升级）
- feat(preview): 预览元素选中支持点击锁定高亮 + 锁图标 + 明确解除
- feat(frontend): 浏览器预览按会话独立记忆，切换会话不再重置预览
- fix(kernel/compile): 编译内核未嵌入 preview-inspect.js，打包版本地 html 预览丢失元素选择/高亮
- feat(kernel/version): 内核版本引入独立管控源（packages/kernel/package.json version）并在关于页显示
- fix(kernel-updater): 合并前加固——平台校验 + build 数值比较 + 首启 mkdir
- feat(kernel-updater): syncKernel 支持 WA_PI_KERNEL_FEED_URL env 覆盖 feed
- test(desktop): kernel-updater 本地 mock HTTP 集成测试（下载/校验/覆盖链路）
- feat(desktop/启动): main.cjs 启动流程接入 kernel 动态更新检查（失败降级）
- feat(desktop/启动): runtime-deps.cjs 适配动态 kernel（syncSeed 跳过动态更新 + 依赖重装按 kernel build 号判定）
- feat(desktop/启动): kernel 二进制动态更新客户端同步器 kernel-updater.cjs（拉清单/下载/校验/覆盖/回滚）
- refactor(scripts): 抽取共用 S3 上传模块 s3-upload.cjs（消除 publish-oss/publish-kernel 重复的 ~150 行 S3 逻辑）
- feat(scripts): kernel 动态更新发布脚本 publish-kernel.ts（打包 zip + 生成清单）
- fix(desktop/node): 首启下载的 node 的 npm/npx/corepack 符号链接指向临时解压目录，清理后变 broken 导致 MCP 报 Executable not found: npx
- chore(deps): 升级 Pi 扩展依赖 + 打包/安装版本单一来源化（自动跟随依赖升级）
- fix(kernel/子代理): 手改 providers.json 后子代理仍读旧 contextWindow（派发前 mtime 兜底重生成 provider-extension）

## 2026-08-23

- fix(frontend/会话): 新建会话首次发送后 session 短暂消失导致对话区空白/重置
- fix(desktop/启动): dev 模式误杀生产进程（端口自愈 + 登记簿清扫都改为 dev 不碰占用者）
- fix(多模态): 模型设置的「图片」开关真正生效（此前仅展示，不改变生成 input）
- feat(多模态): 超过单张上限（3.5MB）且 ≤30MB 的图片用 bun:image 压缩为 webp 内联

## 2026-08-22

- v0.2.19 win 交叉编译重打覆盖
- v0.2.19 mac 补发 + mac 签名修复
- fix(引导队列): 多条引导时第一条发送后待引导消息不更新
- fix: 排队/引导消息未发送且队列悬挂（netDegraded 死锁 + busy 竞态）
- v0.2.19 发版
- 并行插件安装串行化（EBUSY/ENOENT）
- v0.2.18 发版
- 插件安装修复（编译产物当 bun CLI）
- v0.2.17 发版
- Windows 无 Git Bash 场景修复（shell 工具）
- v0.2.16 发版
- kernel 编译产物启动修复（真实打包验证）
- fix(前端): 会话短暂消失触发 React #300 崩溃白屏
- kernel 单二进制编译 + 入口统一
- kernel 单二进制编译（BUN_BE_BUN 运行时链路）
- test: 补 browser_* 工具可见性控制验证测试（零新机制）
- test(kernel): Layer 4 E2E（真实 bridge 链路 + 白名单验证）
- fix(kernel): BrowserManager 默认 WebView 工厂补传 backend:"chrome" + Layer 3 真实引擎集成测试
- feat(kernel): AgentManager 接线 browser_* 工具（browserManager 注入 + handleTool 分派 + 生命周期）
- feat(kernel): bridge 扩展注册 4 个 browser_* 工具

## 2026-08-21

- fix: Windows 盘符绝对路径（C:/、C:\\）渲染为文件胶囊
- fix: 浏览器预览终审修复波（拖拽渲染性能 / 大文件护栏 / 小项收敛）
- feat: 浏览器预览窗口模式与元素选中（分屏/全屏/浮动 + 元素行号定位发聊天）
- v0.2.15

## 2026-08-20

- fix(UI): 侧边栏窄宽时顶部标题只显示「WA PI」隐藏 Agent
- fix(UI): 修复侧边栏 compact 图标回落到 12px（Tailwind 扫不到模板拼接类名）
- fix(UI): 系统设置 compact 图标 32→27px
- fix(UI): 系统设置图标尺寸调整（常规 20px，compact 32px）
- fix(UI): 侧边栏 compact 模式图标放大
- fix(UI): 侧边栏 compact 模式图标居中
- fix(UI): 侧边栏窄宽时底部按钮真正隐藏文字只留图标（compact 模式）
- fix(UI): 点会话自动关闭浏览器预览；侧边栏窄宽时底部按钮只显示 icon
- feat(文件预览): 聊天中点击 html 文件标签优先用浏览器预览打开
- feat(通讯录搜索): 两处通讯录搜索改为纯本地过滤（不再同步企微）
- feat(企微通讯录同步): 通讯录搜索式同步企微成员（已下线）
- fix(通讯录): 联系人长名截断（设置-机器人-通讯录面板 + 发送给IM联系人弹窗）
- feat(发送给IM联系人): 新建会话也可用推送命令
- feat(发送给IM联系人): 联系人弹窗搜索 + 多选多 chip
- refactor(发送给IM联系人): im_push_to 改全局执行器（实时解析联系人推送）+ / 命令置顶
- feat(发送给IM联系人): 主聊天「发送给 IM 联系人」命令
- feat(HTML预览): 地址栏支持外部 URL（iframe 内嵌外部站点）
- feat(提示音): 任务完成提示音改为真实青蛙叫声「呱 呱～」
- feat(HTML预览): 内置浏览器预览 HTML 产物

## 2026-08-19

- feat(输入框): 跨会话复制保留 chip 语义（技能/@智能体/联系人/命令 token）
- fix(会话): abort 无响应兜底——超时强杀 pi 进程（「停不下聊天」修复）
- feat(多模态): 图片内联按大小硬限制（单张 3.5MB / 累计 10MB），超出回退为附件
- fix(多模态): 图片附件真正发给大模型（此前仅降级为 @路径 文本引用）
- fix(代理中继): 普通 HTTP 转发上游失败回退直连 + 回环目标绕过上游（聊天 socket 断连修复）
- fix(分享): 单文件夹分享复制链接带文件夹名（/<name>/<文件夹名>/）
- feat(分享): 单文件夹分享不展开——文件夹本身作为一层保留
- feat(frontend): 聊天输入框支持手动拖拽调整高度
- fix(分享): buildDeployZip 对缺失文件容错 + addItem 合并剔除已删除文件（ENOENT 崩溃修复）
- fix(分享): 合并/多文件分享链接直达问题——目录索引页 + 当次文件直达 URL
- fix(kernel): 已知运行时 bug 不广播 error（Bun autoSelectFamily 竞态）
- feat(分享): 同名分享改为合并（旧文件保留、新文件追加），不再报「名称重复」
- chore(release): 发布版本 0.2.9（修复 CF 分享链接子域硬编码）
- feat(分享): 分享名称默认值改为项目名称
- fix(share): CF 分享链接用项目真实 pages.dev 子域（不再硬编码 wapi-shares.pages.dev）
- chore(release): 发布版本 0.2.8（Cloudflare Pages 分享渠道 + 稳定性修复）
- fix(scheduler): 定时任务时区错位——Bun.cron 按 UTC 解析，配置「09:00」实际在北京时间 17:00 触发
- fix(自动化): 执行详情回放隐藏「重新发送」按钮（只读）
- fix(自动化): 任务列表按创建时间倒序 + 新建后选中新任务
- fix(automation): 新建自动化工作目录下拉移除「默认」空值项，对齐「默认工作区/项目」产品设定
- fix(share): Cloudflare 部署真实链路修复 + 进度条误导修复
- fix(share): Cloudflare 部署真实链路修复（真实 API 全流程测试验证通过）

## 2026-08-18

- feat(share): 分享渠道支持 Cloudflare Pages
- fix: 聊天卡死自愈链路补全（SSE 假活看门狗 + 崩溃现场日志）
- fix(desktop): 聊天中"卡死"（kernel 崩溃后 respawn 无限 EADDRINUSE 循环）
- feat(desktop): 桌面端日志文件 10MB 上限 + FIFO 裁剪 + 磁盘空间自适应
- fix(kernel): 代理中途失效自动回退直连（本地代理中继）+ 网络请求日志
- fix: 打包版默认工作区文件树空白（HOME/USERPROFILE 注入 + resolveSessionCwd 未用持久化 cwd）
- chore(release): 发布版本 0.2.7（修复打包版默认工作区文件树空白）
- fix(build): 打包版默认工作区会话文件树空白（前端注入 dev WA_PI_DIR）
- chore(release): 发布版本 0.2.6（文件分享全链路）
- feat(frontend): 按钮下方提示明确「需部署生效」（与 toast 呼应）
- fix(frontend): 分享弹窗点击阴影不关闭（closeOnOverlayClick=false 防误触丢输入）
- fix(frontend): toast 层级提到弹窗之上（z-50 → z-[60]，不再被分享弹窗阴影遮挡）
- feat(kernel+frontend): 重命名提示需部署生效（pendingCount 签名含 name）
- fix(frontend): Modal 改用 createPortal 渲染到 body（点击阴影可靠关闭）
- fix(kernel): 分享重命名改用原子 rename（原先删旧目录再复制导致 ENOENT 报错）
- fix(kernel): 分享名穿透兼容旧数据（items/<id>/ 自动迁移恢复）
- feat(kernel+frontend): 分享名穿透为文件夹名与 URL 子路径（命名/查重/重命名）
- feat(frontend): 清空分享加二次确认弹窗
- fix: 分享三问题修复（打开文件夹兜底/单文件夹去嵌套/删除验证）
- style(frontend): 「我的分享」按钮区调整（清空分享红色按钮 + 提示下移）
- feat: 分享上传/部署进度条（SSE 广播 + COS 真实百分比）
- fix(kernel): 分享部署必现超时/失败修复（项目名长度 + Zip 部署路径）
- test(kernel): 修复套件互染与 6 个真失败，test 脚本加 --isolate
- feat(frontend): 分享面板 tab 拆分 + 打开分享文件夹；fix: 多选分享超时
- feat: 产物分享改为固定项目 wapi + 分享管理（spec: docs/superpowers/specs/2026-08-17-share-project-management-design.md）
- fix(frontend): transient 网络错误状态条显示具体原因（不再只有通用文案）
- chore(env): 开发环境独立数据目录（隔离 start.bat/start.command 与打包版）
- fix(frontend): 自动重试的新回答替换 error 消息而非拼接

## 2026-08-17

- fix(kernel,frontend): 产物分享最终审查修复（token 脱敏 + 死循环防护 + 域名兜底 + 路径规范化）
- feat(frontend): 文件树多选 + 右键分态 + 分享所选（产物分享任务 11）
- fix(kernel): 用户自定义 baseUrl 不再被内置模型目录覆盖（tokenhub 401）
- fix(shared): 纯中文名 provider 的 slug fallback 改为确定性哈希（发送按钮置灰）
- feat(frontend): 文件预览面板头部分享按钮（产物分享任务 10）
- feat(frontend): 文件修改清单每项分享按钮（产物分享任务 9）
- feat(frontend): share-client + 分享按钮与结果弹层（产物分享任务 8）
- feat(frontend): 设置页「分享」Tab（产物分享任务 7）
- fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）
- feat(kernel): /api/settings/share 读写路由（产物分享任务 6）
- fix(frontend): 发送消息/收到回复后 lastActivity 未刷新（回归）
- fix(kernel): 分享部署失败感知 + 轮询间隔注入 + upload 错误处理
- feat(kernel+frontend): 点击查看会话不再更新最后激活时间（只有发消息/收回复才算活跃）
- fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）
- feat(kernel): 分享上传编排（deployShare）+ /api/share/* 路由
- feat(kernel): EdgeOne REST 客户端（探测/项目/encipher）
- feat(kernel): 多选路径 zip 打包 + path hash
- feat(kernel): 子代理委托超时 30→60 分钟，工具执行看门狗 5→10 分钟
- feat(kernel): settings 支持 shareToken/shareChannel
- fix(kernel): 重名 slug provider 模型窗口落默认值导致 ~122K 误触发自动压缩
- refactor(frontend): 附件/录音按钮 emoji 改为 SVG 图标
- chore(release): 发布版本 0.2.5
- feat(kernel): 自动化任务执行超时 5 分钟 → 30 分钟
- feat(frontend): 项目文件树右键文件增加「默认方式打开」
- fix(kernel): IM 推送前校验连接状态，断线时等待重连
- feat: 自动化任务新增「使用的模型」配置项
- fix(frontend): 设置弹框补充显式关闭按钮
- feat(desktop+frontend): 附件/技能目录/新建项目改用系统原生对话框
- feat(frontend): 自动化任务新建弹窗 @IM联系人 支持群
- chore(release): 发布版本 0.2.4
- fix(frontend): 新建会话页默认工作区隐藏文件浏览按钮
- test(frontend): VersionTimeline maxEntries 断言跟随 version-history 推进

## 2026-08-16

- fix(frontend): 新建会话页文件侧栏对默认工作区不再列出 workdir 内部目录
- chore(release): 发布版本 0.2.3
- fix(desktop): publish-oss 注明 --no-proxy 在 Bun 下不生效
- chore(release): 发布版本 0.2.2
- fix(kernel): ask bridge 偶发断开后自动重试（最多 5 次、间隔 1 秒）
- feat(kernel): 发送前自动压缩防护 POC（超限自动 compact 后继续发送）
- feat: 回复底部新增文件修改清单

## 2026-08-15

- fix(desktop): publish-oss 清代理改为 --no-proxy 参数（默认保留代理）
- fix(desktop): publish-oss 上传前清除代理（OSS 直连）
- fix(desktop): linux AppImage 可执行文件名修复
- fix(desktop): 打包修复 registry-js 原生模块导致 sidecar 构建失败
- revert(kernel/frontend): 撤销「网页端读注册表系统主题」实现
- fix(kernel): readSystemTheme 跨平台——仅 Windows 读注册表，macOS/Linux 返回 null
- fix(kernel/frontend): 网页端「跟随系统」主题读系统主题（SystemUsesLightTheme）
- fix(desktop): 「跟随系统」主题在 Windows 上跟随系统主题（而非应用主题）
- fix(frontend): 列表「测试连接」补传 slug（此前只修了弹窗入口）
- fix(frontend): 长任务完成整轮折叠时滚动位置跳动（看到的内容不在底部）
- fix(kernel/frontend): opencode-go 测试连接 404（测试连接未用内置目录 baseUrl）
- chore(release): 发布版本号 0.1.27 → 0.2.1
- chore(kernel): 升级 pi 0.84.2 + 启用 PI_EXPERIMENTAL
- fix(frontend): 修复 5 个既有测试失败（项目折叠断言 + font-scale 行尾 + maxEntries 版本号）
- fix(kernel): provider extension 用内置目录 baseUrl（修 opencode-go 缺 /v1 且同名模型互相污染）
- fix(kernel): 修复 pi 子进程拿不到系统代理（Bun process.env 展开丢失代理变量）
- feat(settings): 新增「使用系统代理」开关，全软件请求统一走系统代理
- fix(frontend): IM 会话顶部回填修复备注空字符串时不回退的 bug
- fix(frontend): 项目列表展开改用 grid 高度动画（平滑展开，不再瞬间插入）
- fix(frontend): IM 会话顶部铅笔回填与顶部标题同源（单聊用 chatId）
- feat(frontend): 任务详情「最近执行」列表整行可点进详情 + 详情按钮移到最后
- feat(automation): 执行详情显示执行角色与使用模型
- fix(frontend): IM 会话顶部铅笔无联系人记录时也回填原始标识
- fix(frontend): 项目列表展开时消除项目名与会话动画不一致导致的短暂重叠
- fix(frontend): 点击「立即执行」后执行记录列表/状态点不即时刷新
- fix(frontend): IM 会话顶部铅笔编辑无备注时回填联系人标识
- refactor(kernel): 定时任务推送引导改注入 system prompt（不拼进任务指令）
- feat(kernel/frontend): IM 会话顶部铅笔编辑通讯录备注名
- feat(kernel/frontend): 定时任务执行记录详情页（执行过程回放）
- fix/feat(automation): 上述重构的验收反馈修复批次 + 计划类型扩展
- refactor(kernel/frontend)!: 自动化任务 @im-push-to 标记与技能 chip 重构
- feat(kernel): extension:repair 事件链路（ws + HTTP 路由 + 广播）
- feat(kernel/frontend): 任务指令 @ 改为选联系人 + kernel 主动推送能力
- feat/fix(frontend): 新建文案改自动化 + 表单居中 + 任务指令 $ 技能窗口
- fix(frontend): 原生控件（时间选择/滚动条）跟随深浅主题
- fix(frontend): 任务卡右键菜单 + 最近执行状态点 + AgentDropdown 弹窗内裁剪
- fix(kernel/frontend): 定时任务执行会话隔离，不进侧栏会话列表
- feat(frontend): 自动化默认页规则 + 点选切换 + 通用智能体选择器 + 右键删除
- refactor(frontend): 新建/编辑任务弹窗化 + 侧栏去「执行记录」按钮
- fix(frontend): 通讯录侧滑面板覆盖式定位 + 行内编辑回填/按钮溢出修复
- fix(scheduler): 审查终修复——robot_push 真实注入 + 触发即返回 + 入口校验 + 原子读改写
- test(scheduler): 定时任务 E2E 完整流程测试 + 补执行记录 UI 入口
- feat(scheduler): 主内容区视图路由 + SSE 事件 + kernel 调度集成
- feat(kernel): 记忆字符上限放宽 user 1800 / memory 3200
- feat(scheduler): TaskDetailView 任务详情视图 + ExecutionRecords 执行记录列表
- fix(scheduler): TaskEditForm + TaskPromptComposer 审查修复 3 项
- feat(scheduler): TaskPromptComposer + TaskEditForm 任务编辑表单

## 2026-08-14

- fix(kernel): 切换智能体后立即发消息报「会话未启动」
- feat(scheduler): 侧边栏自动化 Tab + AutomationSidebar 任务列表组件
- feat(scheduler): robot_push 工具 + @channel 解析 + ChannelManager.pushToChannel
- feat(scheduler): REST API 路由（CRUD + 立即执行 + 执行记录查询）
- feat(scheduler): 定时任务类型定义 + 数据持久化层 + Bun.cron 调度引擎
- fix(frontend): 任务 7 审查修复（onReconnect 补 loadContacts + titleOf 复用 remarkOf + 补测试）
- feat(frontend): IM 会话列表备注名回显 + contacts:changed SSE 刷新
- fix(frontend): ContactsPanel 打开时加载通讯录 + 补充备注名优先/失败 toast 测试
- feat(frontend): 通讯录滑出面板 + 行内展开重命名 + BotsSection 入口
- fix(kernel): contacts:rename 空值保护 + 事件级测试
- feat(kernel): 进站采集通讯录 + ChannelManager 暴露 listContacts/renameContact
- fix(desktop): 外链子窗口移除 parent，修复 macOS 多屏拖动消失
- feat(frontend): 新建会话页新增右侧文件浏览侧栏

## 2026-08-13

- feat(frontend): 文件预览底部地址栏增加复制按钮
- style(frontend): 「不支持预览/读取失败」空状态页按钮改为无边框幽灵风格
- feat(frontend): 最近视图补齐会话右键菜单（重命名/删除/打开目录）
- feat(frontend): 侧边栏重构——智能体置顶、最近视图新建入口、项目/最近虚线分段
- feat(frontend): 侧边栏会话列表位置动画（最近视图 + 项目视图）
- fix(frontend): 新建页选模型发送后会话界面显示旧模型（existed 分支模型丢失）
- fix(desktop): 换端口启动按钮两个 bug——端口未切换 + 按钮并排
- feat(desktop): 端口自愈失败时提供「换端口启动」+「退出」选项
- feat(desktop): 首启按需下载 Node.js 运行时，解决无 node 环境 MCP npx 报错
- fix(kernel): RPC 模式 custom() 挂根治——bridge 扩展 session_start patch

## 2026-08-12

- fix(frontend): 文件浏览器暗色模式适配
- feat(frontend/kernel): 文件不支持预览时新增「默认方式打开」按钮（系统默认应用打开文件）
- fix(frontend): 系统设置>文字大小不生效于聊天窗口 markdown 正文（.prose-sm 固定字号覆盖）
- feat(desktop): 外链子窗口加地址栏（显示/复制/修改地址后导航）
- fix(desktop): 外链在应用内新窗口打开；localhost 服务链接不再被拦截；子窗口统一安全配置
- fix(frontend): 主回复中反引号包裹的裸 URL 渲染为可点击链接；顺带统一 agent 消息纯文本位置的 URL 链接化
- 侧边栏「任务」视图内新增「项目 | 最近」分段切换：「最近」按时间线汇总全部项目会话（按天刻度分组、标注项目名、上限 100 条、点击后停留在最近视图）
- fix(frontend): AskQuickBar 滚轮横向滚动改用原生 passive:false 绑定，消除 preventDefault 警告
- feat(ask): 便签选项区支持鼠标滚轮横向滚动
- fix(ask): 便签左右滚动按钮边界置灰（到最左「<」灰、到最右「>」灰）
- feat(ask): 便签改「左右 < > 滚动按钮」+ 文案简化为「需要回答：」
- fix(ask): 便签横向滚动条改为隐藏式（不占空间，chip 不被顶起）
- fix(ask): 便签态横向滚动条不再挤压 chip（增高 + 自定义细滚动条）
- fix(ask): Ask 弹窗收起入口移入卡片 footer + 弹窗限高防顶部溢出
- feat(ask): Ask 弹窗改「折叠便签 + 悬浮展开」+ 侧边栏 pending ask 问号
- fix(frontend): thinking 生命周期职责分离——SessionView mount 不清除 thinking，回退 optimisticEcho/force 补丁
- fix(kernel+frontend): 右上角 token 统计口径修复——累计含缓存与压缩前历史，进度条改当前上下文占用
- fix(frontend): 新建会话发送后「正在思考」闪退回归——乐观回显窗口内 isActive=false 不复位 thinking
- fix(kernel): 修复打开历史会话误标「正在思考」一直转圈（isSessionBusy 冷启动一刀切回归）
- feat(frontend): 版本更新历史时间线
- fix(frontend): 会话内存泄露——删除会话不清理 store 数据 + message_end 不清流式缓存
- 修复新建会话「正在思考」闪退

## 2026-08-11

- fix(kernel): pi rpc 子进程改用 Bun.spawn，避免 Windows 上子进程继承 kernel 监听端口句柄
- revert(frontend): 移除 llm-ui 流式渲染回退自实现 MarkdownBlock，彻底解决内存溢出
- fix(frontend): 导出/复制图片时部分 mermaid UML 图文字变白（SVG <style> 颜色导出丢失）
- fix(frontend): 导出/复制图片时 mermaid UML 图未渲染完成（截到 loading 占位）
- 暗色主题修复 / 流式渲染与滚动交互 / kernel 探活与看门狗治理 / 桌面打包与 OTA

## 2026-08-10

- 看门狗与子进程治理 / 主题外观系统 / 桌面端口与 OTA / 发版 v0.1.13–v0.1.20

## 2026-08-09

- 回收站功能 / 虚拟化与流式渲染 / i18n 双语 / 初始化向导与预设智能体 / 发版 v0.1.7–v0.1.11

## 2026-08-08

- 适配 pi 0.84 流式协议 / 发版 v0.1.6 / 依赖升级 / 提示音与自动更新

## 2026-08-07

- 初始化向导 / 前端 i18n 全量接入 / 智能体技能 tab 改造 / 企微 IM 渠道增强

## 2026-07-30

- 网络错误状态条 / 思考强度持久化 / 全项目重命名 HiAgent → WA PI Agent

## 2026-07-29

- 思考强度持久化三次修复 / 依赖整体升级 / TUI 命令治理

## 2026-07-28

- 委托提示词 v14 定稿
- 内联 / 命令菜单 / 命令状态修复

## 2026-07-27

- 委托提示词 v3 定稿 / Mermaid 渲染 / Token 显示 6 项修复

## 2026-07-26

- 去 WS 化阶段二 / 排队系统设计 / 卡顿修复

## 2026-07-25

- 智能体编辑窗口放大 / 排版修复 / 动态扩展加载

## 2026-07-24

- 角色系统完善 / 子代理派发优化 / 专家角色预置

## 2026-07-23

- pi RPC 子进程架构迁移

## 2026-07-22

- 子智能体调用策略 / 气泡拆分重写

## 2026-07-21

- 默认工作区 / 系统提示词组装框架 / 内置 subagent 全链路

## 2026-07-20

- @ 候选菜单与委托规则

## 2026-07-19

- 多智能体矩阵重写

## 2026-07-17

- 插件升级反馈 / 模型闸门 / Quick Invoke 修复

## 2026-07-16

- Quick Invoke / 供应商预设 / 发送修复

## 2026-07-15

- MCP 连接器直连 SDK

## 2026-07-14

- 动态插件工具自动发现

## 2026-07-13

- 动态插件系统 / Electron shell

## 2026-07-12

- 桌面分发模型 / ask 工具

## 2026-07-11

- FilePicker 手风琴 / 记忆管理

## 2026-07-10

- 工具集扩展

## 2026-07-09

- Composer 重构 / 技能管理 / 系统设置

## 2026-07-08

- Steer 队列控制 / Pi SDK 同进程重构

## 2026-07-07

- 移除 Rust 窗口层 / Pi 原生消息模型重构

## 2026-07-06

- 前端数据层

## 2025-08-02

- /mcp-auth 卡住修复

## 2025-07-28

- 思考文本换行 / 工具来源标签 / 打包白屏

## 2025-01-22

- Token 消耗进度条
