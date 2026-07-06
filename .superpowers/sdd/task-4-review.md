# Task 4 Review：agent-md 解析与生成

**Review 对象**：commit `9c83d12`（base `246fc28`），`packages/kernel/src/agent-md.ts` + `tests/agent-md.test.ts`
**Review 日期**：2026-07-06
**方式**：读 brief / report / diff 三件套，并独立复跑 `bun test` 与 `tsc --noEmit` 验证（非采纳报告自述）。

---

## 一、Spec 合规 ✅ 通过

| 判据 | 结果 | 证据 |
|------|------|------|
| 导出 `parseAgentMd` / `stringifyAgentMd` / `validateAgentConfig` 三函数 | ✅ | diff 18/103/126 行三处 `export function` |
| 5 个测试真实跑通（非空壳） | ✅ | 独立复跑 `bun test`：`5 pass, 0 fail, 10 expect()`，与 report 一致 |
| 实现与 brief 一致（parseYaml/parseScalar/parseList） | ✅ | 逐行比对 diff 与 brief Step 3 源码，**逐字一致**，零偏离 |
| 无 gray-mirror / js-yaml 等 YAML 依赖 | ✅ | `grep` 确认仅注释与局部变量 `yamlText` 出现 "yaml" 字样；`package.json` 依赖仅 `@hiagent/shared` |
| 仅用 `@hiagent/shared` 类型，无新依赖 | ✅ | `import type { AgentConfig, AgentName, Partners } from "@hiagent/shared"` |
| TS strict 通过 | ✅ | `tsc --noEmit` EXIT 0（base 开 `strict: true`） |
| 与 `AgentConfig` 接口字段对齐 | ✅ | types.ts 12-28 行 14 字段全部覆盖，含可选 `systemPromptBody?: string` |

**红阶段**：report 自述 Step 2 报 `Cannot find module`，合理。TDD 流程成立。

---

## 二、代码质量 ✅ 通过（含 2 个可改进点，非阻塞）

### 2.1 parseYaml 对 partners 嵌套块 —— ✅ 正确
- `val === ""` 分支识别嵌套，`key === "partners"` 时进入子解析。
- 内层 `while` 用 `lines[i].startsWith("  ")`（2 空格缩进）收敛嵌套范围，正则 `^\s+(\w+):\s*(.*)$` 抓 `askTo` / `askFrom`，调 `parseList`。
- 预置 `{ askTo: [], askFrom: [] }` 默认值，缺失子键也不会 `undefined`。✅
- 未知嵌套块走 else 分支纯跳过，安全。✅

### 2.2 parseList 边界 —— ✅ 正确
- `[a, b]` → `slice(1,-1)` 得 `"a, b"` → split/trim → `["a","b"]`。✅
- `[]` → `inner = ""` → 命中 `if (!inner) return []`。✅
- 含引号项 `[product, "x"]` → `replace(/^["']|["']$/g,"")` 去首尾引号。✅
- 非 `[` 开头（如 brief 里 `tools: read, bash, edit` 走 parseScalar 返回原串，由 parseAgentMd 第 95 行的 `split(",")` 兜底）—— 两条路径都能产出数组。✅

> 注：`parseScalar` 第 60-61 行 `if (v.startsWith("[")...) return parseList(v)` 已覆盖数组形态，紧接的 `if (v === "[]")` 是**死代码**（`[]` 会被上一行 parseList 返回 `[]`），无害但冗余。**非阻塞**，照抄自 brief。

### 2.3 往返一致性 parse→stringify→parse —— ✅ 验证通过
- 测试用例 3 `expect(c2).toEqual(c)` 真实断言通过。
- 关键对齐点逐项核对：
  - `inheritProjectContext: true`（bool）→ stringify 输出 `true`（非 `"true"`）→ parseScalar 命中 `v === "true"` 还原 bool。✅ 往返保型。
  - `avatar: "⚙️"` 带引号 → parseScalar 去引号 → stringify 重新加引号。✅
  - `mcpServers: []` → stringify 输出 `[]` → parseList 返回 `[]`。✅
  - partners 两个子键顺序固定（askTo 先 askFrom 后），parseYaml 不依赖顺序。✅
- body 往返：parse 得 `"你是一名资深后端工程师。"`（已 trim），stringify 输出该串，再 parse 仍等价。✅

### 2.4 validateAgentConfig 覆盖度 —— ✅ 全覆盖
- name（白名单 product/pm/dev/test）、displayName、model、thinking（low/medium/high）、systemPromptMode（replace/append）五项全部检查。
- 测试用例 4（非法 name=hacker → errs>0）+ 用例 5（合法 → `[]`）覆盖正反两面。✅

### 2.5 DEV_MD 夹具覆盖度 —— ✅ 充分
- frontmatter（13 标量键）+ partners 嵌套块 + 正文三段齐全。
- 含 bool / 引号串 / 逗号列表 / 空数组 / emoji / 中文 / hex 渐变多类型样本。✅

### 可改进点（非阻塞，不要求本 Task 修复）
1. **`parseScalar` 死代码**：`v === "[]"` 分支不可达（上一位 `parseList` 已处理）。照抄自 brief，建议未来清理。
2. **YAML 子集受限**：parseYaml 仅支持「标量 + 单行逗号列表 + 两层 partners 嵌套」，不支持多行 `- item` 列表、深嵌套、转义。report 已主动声明此限制（MVP 范围内合理）。若 agent.md 演进出多行列表需扩展。
3. **`tsconfig.base.json` 仍含 `"lib": ["...","DOM"]`**：kernel 是纯逻辑包，带 DOM lib 略宽，但不影响本 Task（非本 Task 引入，跨 Task 议题）。

---

## 三、结论

| 维度 | 结论 |
|------|------|
| Spec 合规 | ✅ **通过**。三函数导出齐、5 测试真实绿、与 brief 逐字一致、零新依赖、strict 干净。 |
| 代码质量 | ✅ **通过**。嵌套/边界/往返/校验/夹具五项重点全部成立。2 处可改进点均非阻塞且源自 brief 原样。 |
| 是否需修复 | **否**。可合入。 |
| 建议后续（可选） | 清理 parseScalar 死代码；为 YAML 解析留多行列表扩展位；跨 Task 统一 `.gitattributes`（report 提到的 LF/CRLF）。 |
