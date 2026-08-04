# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

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
