### Task 15: 主题系统（设计 token + 角色）

**Files:**
- Create: `packages/frontend/src/theme/agents.ts`
- Create: `packages/frontend/src/theme/colors.ts`
- Test: `packages/frontend/tests/theme.test.ts`

**Interfaces:**
- Consumes: `AGENT_DEFS` from `@hiagent/shared`
- Produces:
  - `agentEmoji(name): string` / `agentGradient(name): string`（CSS linear-gradient）
  - `STATUS_COLORS: Record<AgentStatus, string>`

- [ ] **Step 1: 实现**

`packages/frontend/src/theme/colors.ts`:
```typescript
import type { AgentStatus } from "@hiagent/shared";

export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#6c7086",
  thinking: "#89b4fa",
  blocked: "#fab387",
};
```

`packages/frontend/src/theme/agents.ts`:
```typescript
import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";

export function agentEmoji(name: AgentName): string {
  return AGENT_DEFS[name].emoji;
}

export function agentGradient(name: AgentName): string {
  const [a, b] = AGENT_DEFS[name].gradient;
  return `linear-gradient(135deg, ${a}, ${b})`;
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/theme.test.ts`:
```typescript
import { test, expect } from "vitest";
import { agentEmoji, agentGradient } from "../src/theme/agents";
import { STATUS_COLORS } from "../src/theme/colors";

test("agentEmoji 4 角色", () => {
  expect(agentEmoji("product")).toBe("📋");
  expect(agentEmoji("dev")).toBe("⚙️");
});

test("agentGradient 含两色", () => {
  expect(agentGradient("dev")).toContain("#fab387");
  expect(agentGradient("dev")).toContain("#f38ba8");
});

test("STATUS_COLORS 三态", () => {
  expect(STATUS_COLORS.blocked).toBe("#fab387");
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/theme packages/frontend/tests/theme.test.ts
git commit -m "feat(frontend): 主题系统（角色 emoji/渐变 + 状态色）"
```

---

