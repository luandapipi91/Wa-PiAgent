# 派发触发率评测方法论：业界标准与 HiAgent 落地

日期：2026-07-27
范围：`packages/kernel/scripts/eval-delegate-trigger.ts` 的评测设计依据。

---

## 一、业界工具调用评测的主流标准

### 1. BFCL（Berkeley Function Calling Leaderboard）
- 地址：https://gorilla.cs.berkeley.edu/leaderboard.html
- 核心指标（v4）：
  - **Invocation Accuracy**：该不该调工具——含 relevance detection（不应调时拒调）类别，正好对应我们的「触发率 / 误派率」
  - **Tool Selection Accuracy**：调没调对工具——对应 delegate 的 `agent` 参数选择是否正确
  - **Parameter Name/Value F1**：参数正确性——对应 delegate 的 `task` 契约质量（我们暂未量化，靠人工抽查）
  - **AST Correctness**：调用语法合法性（bridge 层已保证，无需评测）
- 判分方式：每条用例二元判定（对/错），按类别报分，不报单一总分

### 2. τ-bench / τ²-bench（Sierra）
- 核心做法：**每个任务重复跑 5-8 次**，报 mean；并发明 pass^k 指标（k 次全部通过的比例）衡量一致性
- 动机：agent 行为有方差，单次采样不可比——这正是我们 2026-07-27 实测确认的：
  同一版提示词两次全量跑分 explore 75%↔83%、simple 误派 0%↔10%

### 3. ToolBench / API-Bank
- Pass Rate（有限步数内选出正确工具并生成正确参数的比例）
- 教训：评测集要分「应调 / 可调可不调 / 不应调」三档，避免只测单向

## 二、HiAgent 落地（eval-delegate-trigger.ts 当前设计）

| 业界做法 | 我们的对应 |
|---|---|
| BFCL relevance detection | simple 类（不应派）误派率，目标 ≈0% |
| BFCL invocation accuracy | explore 类（应派）触发率，达标线 ≥80% |
| BFCL tool selection accuracy | 记录 delegate 的 agent 参数，人工抽查是否选对子代理 |
| τ-bench 多轮采样 | `--repeat N`，报 mean±std（N≥3 才出 std） |
| 三档难度 | explore（应派）/ edit（视情况）/ simple（不应派） |
| 成本隔离 | stub bridge：delegate/fleet 只记录不真实 spawn，单用例成本≈主 agent 一次任务 |

### 用例集规模（2026-07-27 扩容）
- explore 30 条：多文件搜索/审计/调用链调查，全部应触发 delegate/fleet
- edit 10 条：单点小改动，不强制派发（参考档）
- simple 20 条：单事实问答（含路径未知的 grep 类，历史上最易误派的形态），不应派发

### 判定规则
- 主 agent 调用 delegate 或 fleet = 触发；自己 read/grep/bash 到底 = 未触发
- 与生产一致的部分：系统提示词（prompts.json 组装）、工具面（排除式 + 全套扩展）
- 与生产不同的部分：bridge 由内置 stub server 应答

## 三、已知局限

- 每条用例只判「是否派发」，不判派发后任务质量（task 契约写得对不对靠抽查）
- edit 类会真实改动工作区，跑完需 git 检查还原；explore/edit 并行跑时存在轻微交叉污染（edit 改的文件可能正被 explore 审计）
- 单模型（评测用 providers.json 默认模型），结论不外推到其他模型

## 四、三版提示词 A/B 终局（deepseek-v4-pro，60 用例 × 3 轮，2026-07-27）

| 版本 | explore 触发（30×3） | simple 误派（20×3） | edit 派发（10×3） |
|---|---|---|---|
| 改前版（决策树 v8） | 85.6% ± 4.2（80/87/90） | 10.0% ± 0.0（10/10/10） | 未测 |
| 改后版（≤2 调用边界+成本措辞 v9） | 75.6% ± 1.6（77/73/77） | 1.7% ± 2.4（0/0/5） | 0.0% ± 0.0 |
| **v3 融合版（定稿 v10）** | **88.9% ± 6.8（80/97/90）** | **0.0% ± 0.0（0/0/0）** | 3.3% ± 4.7（10/0/0） |

结论：
- 单轮采样不可比——同版轮间波动（±4~7 个百分点）大于版本间表面差异，必须 `--repeat ≥3`
- 改前版强在探索倾向（DIY 边界窄），改后版强在单事实边界（反例+路径未知），两者优势正交
- v3 = 单事实 DIY（值/名字/一行，路径未知也算）+ 「通读代码总结/审计/枚举——哪怕单文件内——派 Explore」+ 反例，删除「≤2 tool calls / costs more than it saves」成本框架（它会把成本规避泄漏到探索决策）
- v3 残留漏派：patches/ 调查（3 轮全漏）、extensions.ts 与 bridge-extension 清单（各漏 2 轮）——均属「一个小文件就能答」的边界形态，模型判断合理与否可接受

### 早期基线（30 用例时代，单轮，仅作噪声参照）

| 版本 | 轮次 | explore | simple 误派 |
|---|---|---|---|
| 决策树版（改前） | 第 1 轮 | 10/12 (83%) | 1/10 (10%) |
| 决策树版（改前） | 第 2 轮 | 9/12 (75%) | 0/10 (0%) |
| +≤2调用边界+反例（改后） | 第 1 轮 | 8/12 (67%) | 0/10 (0%) |
