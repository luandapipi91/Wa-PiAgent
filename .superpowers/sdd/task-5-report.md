# Task 5 报告：ConfigStore（读写 agent.md）

## 状态：✅ 完成

- commit: `6d8aeba5880148a2052721969ee90f9ff75355c1`
- 测试：`bun test packages/kernel/tests/config-store.test.ts` → **4 pass, 0 fail**
- typecheck：`tsc --noEmit -p packages/kernel/tsconfig.json` → exit 0

## 文件清单

| 文件 | 动作 | 行数 |
|------|------|------|
| `packages/kernel/src/config-store.ts` | 新建 | 41 |
| `packages/kernel/tests/config-store.test.ts` | 新建 | 57 |

共 2 files changed, 98 insertions(+)。

## 测试输出

```
packages\kernel\tests\config-store.test.ts:
(pass) listAgents 读全部 .md [6.10ms]
(pass) getAgent 返回 null 当不存在 [0.86ms]
(pass) saveAgent 持久化并可读回 [2.85ms]
(pass) saveAgent 拒绝非法配置不写盘 [0.67ms]

 4 pass, 0 fail, 6 expect() calls
```

TDD 流程：
- Step 2（实现前）：`Cannot find module '../src/config-store'` → 1 fail（符合预期）。
- Step 4（实现后）：4 pass。

## 实现要点

`ConfigStore` 类（与 brief 源码完全一致）：
- `constructor(agentsDir: string = PI_AGENTS_DIR)` —— 默认真实 `~/.pi/agent/agents`，测试注入临时目录。
- `listAgents()`：`readdir` → 过滤 `.md` → 逐个 `parseAgentMd`；目录不存在/文件损坏均吞掉返回 `[]` 或跳过。
- `getAgent(name)`：读 `${name}.md`，缺失返回 `null`。
- `saveAgent(config)`：先 `validateAgentConfig`，有错则直接返回错误数组（不写盘）；通过则 `mkdir -p` + `writeFile(stringifyAgentMd)`，返回 `[]`。

依赖：复用 Task 4 的 `parseAgentMd / stringifyAgentMd / validateAgentConfig`，以及 `@hiagent/shared` 的 `PI_AGENTS_DIR / AgentConfig / AgentName`（均已确认导出）。

## 偏离

无。源码逐字照搬 brief，未改逻辑。两点非偏离说明：
1. **未在 `index.ts` 导出 ConfigStore**：`packages/kernel/src/index.ts` 当前是 Task 12 的 `console.log` 占位，brief 也未要求改它，故不动。
2. **CRLF 警告**：git 提交时出现 `LF will be replaced by CRLF`（Windows 行尾），不影响功能，属环境预期。

## 问题

无。临时目录 `tempAgentsDir()` 测后均 `rmSync` 清理，确认无 `.tmp-agents-*` 残留。
