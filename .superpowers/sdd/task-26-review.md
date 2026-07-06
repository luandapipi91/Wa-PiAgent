# Task 26 Review：AgentConfig

## 判定方法
三文件交叉核对：brief（实现模板 + 测试模板 + 提交信息）↔ report（自述落实情况）↔ diff（实际 commit `1bb92fe` 改动）。

## 逐项判定

### 1. 占位替换干净（props {agentName,onClose} + data-testid 保留）？ ✅ PASS
- **props 逐字符一致**：
  - 占位：`interface Props { agentName: AgentName; onClose: () => void; }`
  - 实现：`interface Props { agentName: AgentName; onClose: () => void; }`
  - diff 第 32 行确认 props 签名未变；`export function AgentConfig({ agentName, onClose }: Props)` 解构一致。
- **`data-testid="agent-config"` 保留**：diff 第 61 行，外层 `fixed inset-0` 遮罩 div 上带 `data-testid="agent-config"`（占位时在同位置容器上，保留）。
- **占位 3 行 `// PLACEHOLDER` 注释已删除**（diff 第 17-19 行删除）。
- **旁注（非阻断）**：占位原 `data-testid="agent-config-close"`（关闭按钮）在新实现中移除（✕ 按钮无 testid）。该 testid 未被 App.tsx / 任何测试引用，brief 模板也仅要求容器 `agent-config`，故移除安全、无回归。
- **App.tsx 调用兼容**：`<AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />` 无需改动（report 已核）。

### 2. 3 passed？ ✅ PASS
- diff 新增测试文件 3 用例（line 162/168/174）：`打开显示 header + tabs` / `切到系统提示词 tab 显示正文` / `保存调 send`。
- report 自述 `Test Files 16 passed (16) / Tests 35 passed (35)`，其中 `tests/AgentConfig.test.tsx (3)` = 本次 3。
- 前序 32（Task 25 后）+ 3 = 35，数学一致。

### 3. 6 tab？ ✅ PASS
- `const tabs: Tab[] = ["basic", "prompt", "tools", "skills", "partners", "capabilities"]`（diff line 58）= **6 个**。
- 标签渲染：基本信息 / 系统提示词 / 工具 / 技能 / 合作伙伴 / 能力（diff line 77 三元链，6 分支完整）。
- `type Tab` 联合类型 6 成员，与数组一致。

### 4. basic/prompt/partners 真实表单？ ✅ PASS
- **BasicTab**（diff 95-110）：显示名 / 描述 / 模型（input）+ thinking（select low/medium/high），4 字段，`onChange` 不可变更新。真实表单 ✅
- **PromptTab**（diff 112-120）：`systemPromptBody` textarea（`?? ""` 防 undefined，rows=15）+ 模式显示。真实表单 ✅
- **PartnersTab**（diff 122-133）：`partners.askTo`（出向）+ `partners.askFrom`（入向），逗号分隔 ↔ `AgentName[]`（`split(",").map(trim).filter(Boolean)`）。真实表单 ✅
- tools/skills/capabilities 为占位文案（`{tab} 内容（...MVP 简化）`）—— 符合 brief「其余占位说明」。

### 5. 保存调 agent:config:save？ ✅ PASS
- diff line 53-56：`const save = () => { if (draft) send({ type: "agent:config:save", agentName, config: draft }); onClose(); };`
- header 保存按钮 `onClick={save}`（diff line 71）。
- 测试用例「保存调 send」断言 `expect(send).toHaveBeenCalled()` + `expect(onClose).toHaveBeenCalled()` 双验证。

## 与 brief 的一致性 / 偏差
| 项 | brief | 实现 | 一致？ |
|---|---|---|---|
| props 签名 | `{ agentName, onClose }` | 同 | ✅ |
| import send/onMessage | 两行分别 import | **合并为一行** `import { send, onMessage } from "../ws-inst-inst"` | ⚠️ 偏差（等价，同模块，更简洁） |
| 6-tab 数组/标签 | 6 | 6 | ✅ |
| BasicTab 字段 | displayName/description/model/thinking | 同 | ✅ |
| PromptTab | systemPromptBody textarea | 同 | ✅ |
| PartnersTab | askTo/askFrom 双向 | 同 | ✅ |
| 保存逻辑 | `send agent:config:save` + `onClose` | 同 | ✅ |
| 测试 3 用例 | 3 | 3 | ✅ |
| 提交信息 | `feat(frontend): AgentConfig（基本信息+提示词+合作伙伴 tab）` | 同（`1bb92fe`） | ✅ |

**唯一偏差**：`send`/`onMessage` 两行 import 合并为一行 —— 语义等价（同模块），非功能差异，无需修复。

## 结论
**✅ PASS — 全部 5 项判定通过。**
- 占位替换干净（props + `data-testid="agent-config"` 保留，App.tsx 兼容）。
- 3 passed（35 = 32 + 3）。
- 6 tab 完整。
- basic/prompt/partners 真实表单，tools/skills/capabilities 占位（符合 MVP）。
- 保存调 `agent:config:save` + `onClose`，测试双断言覆盖。
- 无需修复项。唯一偏差（import 合并）等价无副作用。

## 非阻断观察
- `data-testid="agent-config-close"` 被移除：未被引用，安全。
- tools/skills/capabilities 为文案占位（按 brief MVP）—— 后续 Task 可增强为逗号分隔编辑表单。
- 测试有 `<tbody> cannot contain a nested <button>` 警告，来自 SessionRow（Task 23），非本次范围。
