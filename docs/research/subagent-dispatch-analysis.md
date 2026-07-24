# 子代理派发问题研究报告：HiAgent 为什么不派发，cocode / Reasonix 怎么做，怎么优化

日期：2026-07-24
范围：只读分析。对标对象：`cocode-master/`（本地源码）、[esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)（GitHub）。

---

## 一、结论摘要

**HiAgent 的子代理派发机制本身是完好的（84 个历史会话中 delegate 调用 38 次，成功率 100%），用得少是"引导缺失"问题，不是功能问题。**

最直接的原因：commit `1197a80`（2026-07-23，提交信息与改动无关）**误删了系统提示词里的「Proactive Delegation」整节**——而这段正是前一天 commit `a003ae7` 专门为解决"不派发子代理"问题加上的。同时 `PROMPTS_SCHEMA_VERSION` 5→6 的自动迁移把老用户磁盘的 `prompts.json` 也同步成了没有这段引导的版本。

cocode 和 Reasonix 解决同一问题的思路高度一致，可归纳为三条：**提示词里写带正反边界的默认派发规则、工具名/工具描述做示能设计（affordance）让模型"顺手就派"、用机制（工具集降权、预算提示、结果蒸馏）而不是靠模型自觉来防乱派。** 其中 cocode 还多做了关键一步：用评测脚本把"该不该派"变成可回归的量化指标（触发率 ≥80% 达标线）。

---

## 二、HiAgent 现状与根因（附代码位置）

### 2.1 现有派发链路（功能完好）

- 宿主工具 `delegate` / `fleet`：kernel 生成 pi 扩展 `hiagent-bridge.ts`（`packages/kernel/src/bridge-extension.ts:288-306`），pi 子进程经 `-e` 加载注册；execute 经 HTTP 回调 kernel `POST /bridge/tool`，由 `packages/kernel/src/agent-manager.ts:437-451` 分发到 `delegate-tool.ts` 的 `makeDelegateTool`/`makeFleetTool`。
- 执行路径：`delegate(agent, task)` → `makeSpawnFn`（`delegate-tool.ts:158-174`）→ `subagent-runner.ts:77` 的 `runSubagentAgent`，spawn 一次性 `pi --mode rpc --no-session` 子进程跑完取回文本。fleet 并行上限 6（`delegate-tool.ts:20`）。
- 可派发对象：内置 3 类型（`general-purpose`/`Explore`/`Plan`，`packages/shared/src/constants.ts:61-86`）+ 当前 agent `partners.askTo` 名单内的命名智能体（`agent-manager.ts:355-359`）。
- pi 原生 `subagent` 工具被刻意禁用（`ALWAYS_EXCLUDED_TOOLS = ["subagent"]`，`agent-manager.ts:99`），统一走宿主 delegate——设计合理，不是根因。

### 2.2 根因列表

| # | 根因 | 证据 | 影响 |
|---|------|------|------|
| 1 | **Proactive Delegation 提示词被误删（主因，回归）** | commit `1197a80` 删除 `DEFAULT_DELEGATE_MECHANISM_PROMPT` 的「### Proactive Delegation」和「### Fleet Parallel Delegation」两节（`git show 1197a80 -- packages/kernel/src/system-prompt.ts`）；前一天 `a003ae7` 刚为治同一问题加上（CHANGELOG.md:129）。`PROMPTS_SCHEMA_VERSION` 5→6 使 `ensurePromptsConfig`（`system-prompt.ts:203-222`）自动迁移，老用户磁盘 prompts.json 同步丢失引导 | 主 agent 没有任何"先查可用子代理再自己动手"的指令，默认 DIY |
| 2 | delegate 工具描述偏保守 | `bridge-extension.ts:66-69`："Do NOT use delegate when: ... simple lookup ... latency-sensitive..."，只有禁用面，没有强制的主动派发面 | 模型默认倾向自己做 |
| 3 | pi 生态的委派引导被一并禁用 | pi-open-agents 只在原生 `subagent` 工具可用时注入 "## Subagent Delegation" 引导（`node_modules/.bun/pi-open-agents@0.1.12/src/index.ts:170-185`），而该工具被 HiAgent 禁用 | 少了一层兜底引导（设计使然，但加剧 #1） |
| 4 | fleet 对白名单用户不可用 | `DEFAULT_AGENT_TOOLS`（`constants.ts:129-151`）含 `delegate` 不含 `fleet`；`listGlobalTools`（`agent-manager.ts:261-279`）也不提供 fleet 勾选 | 显式配过 tools 的 agent 失去并行派发能力 |
| 5 | （潜在隐患）delegate/fleet 的 bridge 超时只有 60s | `bridge-extension.ts:114` `DEFAULT_TIMEOUT_MS`，294/304 行用于 delegate/fleet（只有 ask 放宽到 600s）；超时后 LLM 收到"bridge 调用超时"，但 kernel 侧子代理仍在跑（`bridge-registry.ts:81` 独立 AbortController 不随 HTTP 断开取消） | 子代理任务普遍 >60s，一旦触发会让模型"学到" delegate 不可靠。本机会话尚未出现（0 次），属风险而非现根因 |

**实证**：本机 84 个会话中 24 个出现过 delegate 调用，38 次 toolResult 全部成功——机制完好，模型只是很少选择用它。

### 2.3 不确定之处

- `1197a80` 删除是有意还是误删无法从仓库判断（提交信息是无关的供应商搜索框改动，疑似夹带）。
- 即使修回代码文案，磁盘 `prompts.json` 是静态段 content 直存，需再次递增 `PROMPTS_SCHEMA_VERSION` 才能推送给老用户。
- 默认模型自身的 DIY 倾向无法定量剥离，提示词修复后的实际提升幅度需实测。

---

## 三、cocode-master 的机制分析

cocode 的定位写在架构文档：**子代理是成本/上下文削减机制，不是多智能体协作框架**（`cocode-master/docs/ARCHITECTURE.md:250-251`）。

### 3.1 派发路径

- **`task` 工具**（`src/tools/subagent.ts:605-668`）：参数含 `prompt`/`description`/`tools` 白名单/`max_steps`/`model`/`effort`/`continue_from`/`fork_from`/`system`/`type`。工具描述本身就是"何时该派"的教学（subagent.ts:608-609）："(a) 把 >10 次读取/搜索的探索挡在你的上下文预算之外 (b) 委派自包含调查 (c) 按区域并行研究"。
- **`runAs: subagent` 技能 + 同名顶层工具**（关键手段）：内置 explore/research/review/security-review 四个 subagent 技能，**每个额外注册为同名顶层工具**（`src/tools/skills.ts:192-227`），原文注释："the tool name matches the verb in the question — models pick it because **affordance design > prompt rules**"。explore 工具描述直接写："Chained `read_file` is the wrong tool for these — it bloats your context"。

### 3.2 提示词引导（带正反边界的默认规则）

主 agent 系统提示 `# Delegating to subagents` 节（`src/code/prompt.ts:44-51`）核心一句：

> "**Default to delegating multi-step exploration.** When a request needs several reads/searches to answer ... delegate it to the `task` tool instead of chaining read_file/grep yourself ... Still use direct tools for: a single lookup, 1-2 file reads, anything you must track intermediate results for, or anything needing user interaction. Always pass a clear, self-contained `prompt` — the sub-agent has none of your conversation context."

注意它同时给了**什么时候不派**的边界——这是防止"修复不派发"变成"乱派发"的关键。

### 3.3 调度与约束机制

- **深度硬限**：子代理注册表 fork 自父级，但 `task`/`submit_plan` 永不继承（subagent.ts:144-146）——递归派发在机制上不可能。
- **结果蒸馏**：父会话历史不进子代理；只回传最终答案，截断 8000 字符（subagent.ts:136、473-476）。子代理系统提示（`SUBAGENT_BASE_SYSTEM`，subagent.ts:120-130）："你的最后一条消息是父级唯一能看到的东西，必须自包含、不提问、不客套"。
- **预算提示防乱派**：按会话累计 spawn 次数/token，>3 次软提示、>6 次或 5 万 token 强提示，在工具结果尾部追加 `[budget: ...]` 让模型重新论证下一次派发的必要性（subagent.ts:148-164）。
- **廉价模型默认**：子代理默认 flash 档模型 + effort=high（subagent.ts:137-142）。
- **串行执行**：`task` 注册 `parallelSafe: false`，同轮多个 task 调用实际串行——cocode 并不真并行。
- **量化评测闭环**（防"不派发"最有效的工程手段）：`scripts/eval-task-trigger.mts` 用 100 条分类提示（40 应派 / 30 视情况 / 30 不应派）实测触发率，Explore 类达标线 ≥80%（eval-task-trigger.mts:222）。
- **遥测**：`SubagentTelemetry` 记录每次 spawn 的 compressionRatio（子代理产出 token vs 回传 token），量化"省了多少上下文"。

---

## 四、DeepSeek-Reasonix 的机制分析

Reasonix 是 DeepSeek 原生的终端编码 agent（1.0 用 Go 重写，默认分支 `main-v2`），围绕 prefix cache 调优。**与子代理派发问题高度相关**，关键实现都在 `internal/agent/`：

### 4.1 与子代理直接相关的机制

- **`task` 工具**（`internal/agent/task.go`）：独立 Session + 独立系统提示（"父代理只能看到你的最终答案，交付物要自包含；需要澄清就带精确问题失败，不要猜"）。子代理工具集 = 父注册表剔除 `task`/`parallel_tasks`/`run_skill` 等元工具——**强制单层委派**。`max_steps` 默认 = 父上限一半（下限 5），降低"派出去会失控"的成本顾虑。支持 `run_in_background` 后台 job + `wait` 收集，支持 `continue_from`/`fork_from` 续跑分叉（review→fix→review 循环）。
- **`parallel_tasks` 工具**（`internal/agent/parallel_tasks.go`）：goroutine worker pool 真并行 + `depends_on` DAG 依赖声明（带环检测）。**"wisdom 目录"机制**：上游任务输出写入临时目录文件，下游任务 prompt 里只注入"结果在 X 目录自己读"，不内联上游输出——省 token 且保护缓存。
- **结果只回传最终答案**：子代理工具事件打 `parentID/sub-N` 命名空间转发 UI 做嵌套卡片，文本/推理不进父上下文——这是"敢多派"的前提（父上下文不爆、prefix cache 不破）。
- **双模型 Coordinator**（`internal/agent/coordinator.go`）：planner（只读工具集、限步）与 executor 跑两个独立 session，结构化 plan 交接，双方 prompt prefix 只增不改、缓存命中率高。
- **Goal 模式 + AutoResearch**（`docs/GOAL_ENFORCEMENT.zh-CN.md`）：`/goal` 持续发 continuation turn 直到完成/同一 blocked 重复 3 次；声称完成时检查 canonical todos + AGENTS.md verify 指令做门控拦截；连续 2 轮无工具调用 idle 提醒；长周期目标状态写 `.reasonix/autoresearch/` 本地目录（task_spec/progress/findings/iteration_log/heartbeat），且刻意把动态状态排除在系统提示之外保缓存。

### 4.2 本地佐证

本仓库 `.reasonix/autoresearch/20260722-073412-skill-subagent-driven-development-*/` 正是 Reasonix 在本项目跑 AutoResearch 的真实产物——研究主题恰好就是"subagent-driven-development"，但两个 run 的 `progress.json` 均停在 `iteration: 0`、`status: running`，findings/iteration_log 全空，**实际未推进**。

### 4.3 局限

子代理是同进程 goroutine + 独立 Session，非跨进程分布式；委派严格单层，不支持子代理再派子代理。

---

## 五、HiAgent 优化点清单

按"投入产出比"排序。每条含：改哪里、怎么改、预期效果、成本/风险。

### P0 — 直接修复回归，立竿见影

**1. 恢复并升级 Proactive Delegation 提示词**
- 改哪里：`packages/kernel/src/system-prompt.ts` 的 `DEFAULT_DELEGATE_MECHANISM_PROMPT`；同时递增 `PROMPTS_SCHEMA_VERSION`（6→7）让 `ensurePromptsConfig` 推送给老用户。
- 怎么改：恢复 `a003ae7` 的 Proactive Delegation 节，并按 cocode `prompt.ts:51` 的句式升级为带正反边界的默认规则："需要多次读取/搜索的探索（找所有调用 X、Y 在全项目如何工作、审计 Z）默认 delegate，不要自己连续 read/grep；单次查找、1-2 个文件读取、需要跟踪中间结果、需要用户交互的任务直接做；prompt 必须自包含，子代理没有你的对话上下文。"同时恢复 Fleet Parallel Delegation 节。
- 预期效果：直接消除当前主因。cocode 用同类句式 + 评测实测达到 Explore 类 ≥80% 触发率；HiAgent 修复后预计委派率显著回升（具体幅度需实测，模型 DIY 倾向无法完全消除）。
- 成本/风险：改动 ~30 行提示词 + 版本号，半小时。风险极低；注意 prompts.json 迁移逻辑需覆盖 v6→v7。

**2. delegate 工具描述加主动派发面**
- 改哪里：`packages/kernel/src/bridge-extension.ts:60-69` 的 delegate/fleet 工具描述。
- 怎么改：在现有 "Do NOT use when..." 之前补 "Use delegate proactively when: 探索/审计类任务需要超过 ~5 次文件读取或搜索；可把任务拆给 specialists；多区域独立研究用 fleet 并行"。参考 cocode subagent.ts:608-609 与 Reasonix task.go 的工具描述。
- 预期效果：与 #1 互补——提示词管"意识"，工具描述管"手边的触发点"。cocode/Reasonix 两家都把工具描述当教学文案写，这是低成本高回报项。
- 成本/风险：改文案，半小时，无风险。

### P1 — 机制级改进，防"不派"也防"乱派"

**3. 高频场景注册为独立子代理类型/工具入口（示能设计）**
- 改哪里：`packages/shared/src/constants.ts:61-86`（内置子代理类型定义）+ `delegate-tool.ts` 的 roster 生成。
- 怎么改：把现有 `Explore`/`Plan` 类型的描述按 cocode 的"动词对齐"思路强化（如 Explore 描述直接写"连续 read_file 是错误工具，会污染你的上下文"）；评估是否将 `review`（代码审查）加为第 4 个内置类型。cocode 的经验是工具名对齐问题里的动词比提示词规则有效（skills.ts:192-195）。
- 预期效果：模型在"探索/审查"类措辞的任务中自然选中对应子代理，减少对提示词纪律的依赖。
- 成本/风险：改动小（类型定义+描述），风险低；新增类型需同步 roster 提示与测试。

**4. 结果蒸馏契约 + 回传截断**
- 改哪里：`delegate-tool.ts` 的子代理系统提示/任务包装 + `subagent-runner.ts` 的结果回收。
- 怎么改：给子代理 prompt 注入"父级只能看到你的最终回复，必须自包含、不提问、不客套"（抄 cocode SUBAGENT_BASE_SYSTEM 或 Reasonix DefaultTaskSystemPrompt）；回传结果做字符截断（cocode 用 8000，可参考）。
- 预期效果：父上下文不被子代理输出灌爆，"敢多派"的前提成立；同时避免超长回传撑破主会话。
- 成本/风险：半天。风险低；截断长度需平衡信息丢失。

**5. 会话级派发预算提示**
- 改哪里：`delegate-tool.ts` 的结果包装处（kernel 侧按会话累计 spawn 次数/token）。
- 怎么改：>3 次软提示、>6 次或累计 5 万 token 强提示，在工具结果尾部追加 `[budget: ...]`（直接参考 cocode subagent.ts:148-164 的纯函数设计，可单测）。
- 预期效果：修复 #1 后防止矫枉过正变成乱派发；给模型一个自我纠偏的反馈回路。
- 成本/风险：半天。风险低；阈值需实测调。

**6. delegate/fleet 的 bridge 超时与取消语义修复（隐患项）**
- 改哪里：`bridge-extension.ts:114`（60s 默认超时，delegate/fleet 未放宽）+ `bridge-registry.ts:81`（超时后子代理不取消）。
- 怎么改：delegate/fleet 参照 ask 放宽到 600s 或干脆不设上限；HTTP 超时断开时将取消信号传播到子代理进程。
- 预期效果：消除"模型学到 delegate 不可靠"的潜在负反馈。当前 0 次触发，属预防性修复。
- 成本/风险：改动小，但取消传播涉及进程管理，需测试边界情形（父 abort → child abort 可参考 cocode subagent.ts:301-319）。

### P2 — 能力补齐与长期工程

**7. fleet 加入默认可用工具与全局工具列表**
- 改哪里：`packages/shared/src/constants.ts:129-151`（`DEFAULT_AGENT_TOOLS`）+ `agent-manager.ts:261-279`（`listGlobalTools`）。
- 怎么改：默认工具集加 `fleet`，全局工具列表提供勾选。
- 预期效果：显式配过 tools 的 agent 也能并行派发；HiAgent 的子进程架构天然支持真并行，这是 cocode（串行）没有的优势。
- 成本/风险：改动小；需确认前端工具勾选 UI 同步。

**8. 派发行为评测脚本（可回归指标）**
- 改哪里：新增 `packages/kernel/scripts/` 或 `benchmarks/` 下的评测脚本。
- 怎么改：仿 cocode `scripts/eval-task-trigger.mts`：分类提示集（应派/视情况/不应派，各 30-40 条）+ 触发率统计 + 达标线（探索类 ≥80%）。每次动提示词/工具描述后跑一遍。
- 预期效果：把"agent 会不会主动正确派发"从体感变成可回归指标——这是 cocode 最值得抄的一项，没有它 #1#2#3 的效果无法量化验证。
- 成本/风险：1-2 天（含提示集编写）；运行需要模型额度。

**9. 派发遥测（蒸馏率统计）**
- 改哪里：`subagent-runner.ts` 完成回调处记录子代理总 token vs 回传 token。
- 怎么改：仿 cocode `SubagentTelemetry`，按会话输出 compressionRatio。
- 预期效果：量化每次派发省了多少父上下文，为调提示词和阈值提供数据支撑。
- 成本/风险：半天。风险低。

**10. （可选，较大）并行编排与依赖声明**
- 改哪里：`delegate-tool.ts` fleet 扩展。
- 怎么改：参考 Reasonix `parallel_tasks` 的 `depends_on` DAG + "wisdom 目录"（上游结果写临时文件、下游 prompt 只注入路径）。
- 预期效果：多子代理协同时上下文最省；适合复杂项目级任务。当前 fleet 已能并行，此项属于锦上添花。
- 成本/风险：2-3 天，复杂度高；建议 P0/P1 见效后再评估是否需要。

### 不建议做的

- **恢复 pi 原生 `subagent` 工具**：与宿主 delegate 双轨并存会造成职责混乱，维持现状（统一走 delegate）是对的。
- **允许子代理再派子代理**：cocode/Reasonix 都刻意单层硬限，多层委派收益不明、失控风险高。

---

## 六、推荐落地顺序

1. **第一批（当天可完成）**：#1 恢复提示词 + #2 工具描述 —— 直接消除主因。
2. **第二批（一周内）**：#3 示能强化 + #4 蒸馏契约 + #5 预算提示 + #7 fleet 默认化。
3. **第三批（效果验证）**：#8 评测脚本 + #9 遥测 —— 用数据验证前两批的实际提升，再决定是否做 #10。
4. #6 超时/取消修复可随任一批次顺带做。

---

## 附：信息来源

- HiAgent 源码：`packages/kernel/src/{system-prompt,agent-manager,delegate-tool,bridge-extension,subagent-runner,bridge-registry}.ts`、`packages/shared/src/constants.ts`；git 历史 `a003ae7`、`1197a80`；本机 84 个会话的 delegate 调用统计（38 次调用，0 失败）。
- cocode-master：`docs/ARCHITECTURE.md`、`src/code/prompt.ts`、`src/tools/subagent.ts`、`src/tools/skills.ts`、`src/tools/subagent-types.ts`、`src/telemetry/subagent-distillation.ts`、`scripts/eval-task-trigger.mts`。
- DeepSeek-Reasonix：[README](https://github.com/esengine/DeepSeek-Reasonix)、[docs/SPEC.md](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/SPEC.md)、[GOAL_ENFORCEMENT.zh-CN.md](https://raw.githubusercontent.com/esengine/DeepSeek-Reasonix/main-v2/docs/GOAL_ENFORCEMENT.zh-CN.md)、[internal/agent/task.go](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/internal/agent/task.go)、[internal/agent/parallel_tasks.go](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/internal/agent/parallel_tasks.go)；本地 `.reasonix/autoresearch/20260722-073412-*/` 运行产物。
