# Product Roadmap — pi.dev RPC 事件对接 — Q3 2026

**Author**: Alex (PM)  **Last Updated**: 2026-08-04  **Version**: 0.1 (Draft)
**Stakeholders**: Kernel Eng, Frontend Eng, Design, Support

> 背景：HiAgent 与 pi RPC（`pi --mode rpc`，`@earendil-works/pi-coding-agent@0.83.0`）深度集成，
> 但 pi 协议 21 个事件中约 11 个事件在消费侧无处理逻辑（前端 `default` 分支忽略 / kernel 无 case）。
> 调研基线见文末附录《事件对接现状矩阵》。本路线图把"事件对接"从技术债转化为用户价值交付。

---

## 🌟 北极星指标

**Agent 运行透明度**：用户对"agent 当前在做什么、为什么等待"始终可感知、可干预。

**Current**: 关键等待事件（重试/压缩/摘要）覆盖率 **0%** — 用户在静默等待中无法区分"在跑/在重试/已卡死"
**Target by EOY**: 关键运行状态事件 UI 覆盖率 **≥ 90%**，重试/压缩等待期用户无反馈时间 **< 3s**

## 支撑指标看板

| Metric | Current | Target | Trend |
| -------- | --------- | -------- | ------- |
| 关键事件 UI 覆盖率（重试/压缩/摘要/扩展错误） | 0% | ≥ 90% | ↑ |
| 等待期用户主动 abort 率（proxy：等待不耐烦信号） | 未知（未埋点） | 下降 30% | ↑ |
| 扩展错误可见率（extension_error → UI/日志） | 0% | 100% | ↑ |
| SDKEvent 类型完整性（声明事件数 / pi 事件总数） | 13/21 | 21/21 | ↑ |
| 用户"卡住/没反应"类反馈（客服/NPS） | 未统计 | 建立基线并下降 | ↑ |

---

## 🟢 Now — 本季度进行中（Q3 2026）

已承诺的工作。工程、设计和 PM 完全对齐。

| Initiative | User Problem（用户问题） | Success Metric | Owner | Status | ETA |
| --- | --- | --- | --- | --- | --- |
| **重试/压缩状态提示**（`auto_retry_start/end`、`compaction_start/end`、`summarization_retry_*`） | 请求卡住时用户不知道是死了还是在重试；长会话压缩时界面无任何反馈 | 状态提示覆盖率 100%；等待期首屏反馈 < 3s；重试等待期 abort 率下降 30% | Kernel Eng + Frontend Eng（PM 协调） | Scoped | Week 6 |
| **SDKEvent 类型债修复**（补 `agent_settled` 及全部透传事件声明） | 透传层类型不完整，前端拿到的事件信封类型盲区，改造成本随时间上升 | SDKEvent 声明事件数 21/21；`any` 逃逸 0 | Kernel Eng | In Dev | Week 1 |

**Initiative 1 详细范围（Scoping）**：

- kernel：`index.ts` 已透传全部事件，无需改透传；需在 `sdk-errors.ts` 或独立模块对 `auto_retry_start`/`compaction_start` 做状态归一化
- 前端：`store/session.ts` `handleSDKEvent` 增加 `auto_retry_start/end`、`compaction_start/end`、`summarization_retry_*` case，驱动一个"正在重试 (2/3)… / 正在整理上下文…"状态条（复用现有 degraded 状态 UI 模式）
- 设计：确认状态条文案与消失时机（`auto_retry_end` / `compaction_end` 时清除；`summarization_retry_finished` 后若仍无产出需提示）
- 明确不做：不阻塞用户输入，重试/压缩期间用户可继续发送（pi 已支持 queue）

---

## 🟡 Next — 未来 1–2 个季度（Q4 2026）

方向性已承诺，开发前需要进一步定义范围。

| Initiative | Hypothesis（假设） | Expected Outcome | Confidence | Blocker |
| --- | --- | --- | --- | --- |
| **扩展错误可视化**（`extension_error` 接入诊断面板 + 可选的 toast） | 扩展/bridge 工具失败现在是静默的（仅 stderr tail），用户和客服都无法定位 | 扩展错误 100% 可见；错误定位时间 < 5min | High | 需要诊断面板形态决策（复用设置页 vs 新增） |
| **扩展状态展示**（`setStatus`/`setWidget`/`setTitle` 接入 footer/widget 区域） | pi 扩展会通过 fire-and-forget UI 反馈状态（如 "/lens 分析中"），GUI 宿主丢弃导致扩展用户无感知 | 扩展状态展示覆盖率 ≥ 80%；扩展开发者反馈满意度 | Med | 需要 Design 定义 widget 区域视觉 |

---

## 🔵 Later — 3–6 个月视野（H1 2027）

战略性投注。未排期。当证据或优先级支持时推进到 Next。

| Initiative | Strategic Hypothesis | Signal Needed to Advance |
| --- | --- | --- |
| **turn 粒度遥测**（`turn_start`/`turn_end` 接入分析埋点） | turn 粒度数据能支撑"单轮耗时/工具链路径"性能分析，指导 prompt 优化 | 用户反馈"agent 太慢"成为 Top 3 痛点；或性能优化进入 OKR |
| **工具执行实时进度**（`tool_execution_update` 流式展示长工具输出，如 bash 中间输出） | 长工具执行（分钟级）期间展示中间输出能显著降低用户等待焦虑 | 长工具执行占比 > 10%；或重试状态条落地后用户仍反馈"等待无反馈" |
| **会话树能力**（`get_tree`/`get_entries`/`fork`/`clone`/`get_fork_messages`） | 分支会话管理（fork/clone）是桌面端差异化能力，覆盖"实验性探索"场景 | 会话管理进入产品路线图；用户访谈出现"想回到之前分支"诉求 |
| **模型/思考级别循环切换**（`cycle_model`/`cycle_thinking_level`/`get_available_thinking_levels`） | 键盘流用户希望不打断流式快速切换模型档位 | 快捷键体系立项；或模型档位切换成为高频操作（数据证实） |

---

## ❌ 我们不做的事（以及为什么）

公开说"不"防止重复请求并建立信任。

| Request | Source | Reason for Deferral | Revisit Condition |
| --- | --- | --- | --- |
| 对接 `abort_retry`（重试状态条加「取消重试」按钮） | Next #3 技术评估（2026-08-04） | 功能冗余：pi 源码 `abort()` 第一行即 `abortRetry()`，「停止」是「取消重试」的超集；abort_retry 唯一生效窗口（退避等待期）内两者结果完全一致 | 出现「放弃重试但允许压缩恢复继续跑」的真实场景时 |
| 对接 `bash` RPC 命令（`bash`/`abort_bash`/`bash_execution_update`） | 协议能力盘点 | 项目刻意走工具调用而非直接 bash 命令，`bash_execution_update` 实际不会产生 | 未来需要"用户手动注入 shell 输出到上下文"场景时 |
| 对接 `export_html` | 协议能力盘点 | 桌面端有更好的导出渠道（截图/复制/分享），HTML 导出对桌面价值低 | 出现"完整会话归档"产品需求 |
| 对接 `set_editor_text` 回填 | 协议能力盘点 | 桌面端输入框有自己的状态管理，被 pi 侧覆盖会破坏 UX | 扩展需要"预填用户输入"场景被证实 |
| 对接 `custom()` UI 方法 | pi 限制 | RPC 模式下 pi 侧 `custom()` 返回 `undefined`（需要真实 TUI），对接无意义 | pi 运行时支持时 |
| 全量暴露 thinking level 档位（`xhigh`/`max`） | 产品判断 | 档位过多增加用户认知负担，模型支持也参差 | 目标用户出现高级用户档位诉求 |

---

## 📊 附录：事件对接现状矩阵（调研基线，2026-08-04）

### pi 协议 21 个事件 vs 对接状态

| pi 事件 | 状态 | 消费位置 / 缺口 | 路线图归属 |
| --- | --- | --- | --- |
| `agent_start` | ✅ 已对接 | agent-manager（busy）/ 前端（thinking） | — |
| `agent_end` | ✅ 已对接 | agent-manager（耗时）/ 前端（idle） | — |
| `agent_settled` | ✅ 已对接 | agent-manager（busy/drain）/ subagent-runner / 前端（思考态兜底复位） | — |
| `turn_start` | ✅ 已对接（类型完整，前端显式忽略） | 前端 store（no-op，消息流由 message_* 驱动） | Later（遥测） |
| `turn_end` | ✅ 已对接（类型完整，前端显式忽略） | 前端 store（no-op，message/toolResults 与 message_end 重复不合并） | Later（遥测） |
| `message_start` | ✅ 已对接 | 前端 store | — |
| `message_update` | ✅ 已对接 | 前端 store + 节流 + rAF | — |
| `message_end` | ✅ 已对接 | agent-manager / sdk-errors / 前端 | — |
| `bash_execution_update` | ❌ 未对接 | 项目不用 bash 命令，不会产生 | 不做 |
| `tool_execution_start` | ✅ 已对接 | subagent-runner / 诊断日志 | — |
| `tool_execution_update` | ❌ 未对接 | 无任何 case | Later |
| `tool_execution_end` | ✅ 已对接 | subagent-runner / 诊断日志 | — |
| `queue_update` | ✅ 已对接 | agent-manager（本地队列覆写）/ 前端 | — |
| `compaction_start` | ✅ 已对接 | 前端 store（「正在压缩上下文…」状态消息） | Now #1（实质已完成） |
| `compaction_end` | ✅ 已对接 | 前端 store（结果替换 + token 刷新） | Now #1（实质已完成） |
| `auto_retry_start` | ✅ 已对接 | 前端 store（重试期间保持 thinking） | Now #1（状态条待做） |
| `auto_retry_end` | ✅ 已对接 | 前端 store（success:false 复位 idle） | Now #1（状态条待做） |
| `summarization_retry_scheduled` | ✅ 已对接 | 前端 store（复用 retryBySession 黄条） | Now #1（实质已完成） |
| `summarization_retry_attempt_start` | ✅ 已对接 | 前端 store（显式 no-op，状态保持到 finished） | Now #1（实质已完成） |
| `summarization_retry_finished` | ✅ 已对接 | 前端 store（清重试进度） | Now #1（实质已完成） |
| `extension_error` | ✅ 已对接 | 前端 store（toast + 诊断区块） | Next #1（已完成） |

### extension_ui_request 子协议

| 方法 | 状态 | 路线图归属 |
| --- | --- | --- |
| `select`/`confirm`/`input`/`editor`/`custom` | ✅ 已对接（dialog → 前端 ask 链路） | — |
| `notify` | ✅ 已对接（→ `extension_notify` toast） | — |
| `setStatus` | ✅ 已对接（→ 底部全局状态栏） | Next #2（已完成） |
| `setWidget` | ✅ 已对接（→ Composer 上/下文本块） | Next #2（已完成） |
| `setTitle` | ✅ 已对接（→ 聊天窗顶部状态条，不写 document.title） | Next #2（已完成） |
| `set_editor_text` | ❌ 只回 cancelled 兜底 | 不做 |

### 未发送的 RPC 命令

`cycle_model`、`cycle_thinking_level`、`get_available_thinking_levels`、`abort_retry`、`bash`/`abort_bash`、`export_html`、`fork`/`clone`/`get_fork_messages`、`get_entries`/`get_tree`、`set_session_name`

→ `abort_retry` 经评估归不做清单（与「停止」功能冗余，见上）；会话树类归 Later；其余进不做清单（理由见上）。
