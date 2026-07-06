# Task 5 Review：ConfigStore（读写 agent.md）

## 判定汇总

| 维度 | 结论 |
|------|------|
| **Spec 合规** | ✅ PASS |
| **代码质量** | ✅ PASS |
| **是否需修复** | 否，可直接进入 Task 6 |

---

## 一、Spec 合规（全部满足）

| 检查项 | 结果 | 证据 |
|--------|------|------|
| 三方法签名一致 | ✅ | `listAgents(): Promise<AgentConfig[]>`、`getAgent(name: AgentName): Promise<AgentConfig\|null>`、`saveAgent(config: AgentConfig): Promise<string[]>`，与 brief 完全一致（config-store.ts:10/25/34） |
| 4 passed 实跑 | ✅ | 本地实跑复现：`4 pass, 0 fail, 6 expect() calls`（非仅引用报告） |
| saveAgent 返回校验错误数组（空=成功） | ✅ | 有错 `return errs`（line 36），成功 `return []`（line 39） |
| 复用 Task 4 parse/stringify/validate | ✅ | `import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "./agent-md"`（line 5）；agent-md.ts 三函数均存在且签名匹配 |
| 默认 agentsDir = PI_AGENTS_DIR | ✅ | `constructor(private agentsDir: string = PI_AGENTS_DIR)`，`PI_AGENTS_DIR` 由 `@hiagent/shared` 正确导出（constants.ts:10，经 index.ts `export *` 暴露） |

**typecheck**：`tsc --noEmit -p packages/kernel/tsconfig.json` → exit 0。

## 二、代码质量（全部满足）

| 检查项 | 结果 | 说明 |
|--------|------|------|
| listAgents 对损坏 .md 跳过不抛 | ✅ | 内层 `try { parseAgentMd } catch { /* 跳过 */ }`（line 17）；外层 catch 兜底目录不存在返回 `[]`（line 21） |
| getAgent 不存在返回 null | ✅ | readFile 失败/解析失败均走 `catch → return null`（line 29-31）。测试「getAgent 返回 null 当不存在」实跑通过 |
| saveAgent 非法配置不写盘 | ✅ | `if (errs.length > 0) return errs;` 早返回，`writeFile` 在校验通过后才执行（line 36-38）。测试「拒绝非法配置不写盘」实跑通过，`errs.length > 0` 成立 |
| 测试用临时目录 + 清理 | ✅ | `tempAgentsDir()` 用随机后缀目录 + `mkdirSync(recursive)`，每个 test 末尾 `rmSync(dir, { recursive: true, force: true })`，不碰真实 `~/.pi`。工作树干净，无 `.tmp-agents-*` 残留 |

## 三、观察（非缺陷，无需修复）

1. **源码逐字照搬 brief**：实现与 brief Step 3 给定代码逐字一致，无偏离。报告所述「无偏离」属实。
2. **未在 `index.ts` 导出 ConfigStore**：kernel/src/index.ts 仍是 Task 12 占位 `console.log`。brief 未要求导出，属合理延后，不阻塞。
3. **saveAgent 非法用例构造方式**（`...(await store.getAgent("dev") || {} as never)`）略 hack，但能稳定触发 `name="hacker"` 校验失败，测试断言成立，可接受。
4. **listAgents 性能**：顺序 `for...of` + `await readFile`，非并发。agent.md 数量级小（4 个），无需并发优化。
5. **CRLF 警告**：Windows 行尾预期现象，不影响功能。

## 四、结论

双判定均通过，无需修复。源码、测试、依赖导出、实跑结果、typecheck 全部对齐 brief 与报告，可放行进入 Task 6。
