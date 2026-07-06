### Task 17: AgentListSection 组件（② 我的智能体区）

**Files:**
- Create: `packages/frontend/src/components/AgentListSection.tsx`
- Test: `packages/frontend/tests/AgentListSection.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（getGlobalState），`AGENT_DEFS`，`agentEmoji`，`STATUS_COLORS`
- Produces: 渲染 4 个 agent 行，点击触发 `onSelectAgent(name)`（进 AgentConfig 弹窗）

- [ ] **Step 1: 实现**

`packages/frontend/src/components/AgentListSection.tsx`:
```typescript
import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { STATUS_COLORS } from "../theme/colors";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

interface Props { onSelectAgent: (name: AgentName) => void; }

export function AgentListSection({ onSelectAgent }: Props) {
  // 订阅 states 触发重渲染（getGlobalState 内部读 states），否则状态点不会更新
  useAgentsStore(s => s.states);
  const getGlobalState = useAgentsStore.getState().getGlobalState;
  return (
    <div className="mb-3">
      <div className="text-xs text-overlay px-2 mb-1">👥 我的智能体</div>
      {NAMES.map(name => {
        const status = getGlobalState(name);
        return (
          <button
            key={name}
            onClick={() => onSelectAgent(name)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
            data-testid={`agent-${name}`}
          >
            <span className="text-base">{AGENT_DEFS[name].emoji}</span>
            <span className="text-sm text-text flex-1">{AGENT_DEFS[name].label}</span>
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${name}`}
            />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/AgentListSection.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("渲染 4 个 agent 行", () => {
  render(<AgentListSection onSelectAgent={() => {}} />);
  expect(screen.getByTestId("agent-dev")).toBeTruthy();
  expect(screen.getByTestId("agent-test")).toBeTruthy();
});

test("状态点反映全局聚合", () => {
  useAgentsStore.setState({
    states: { "p1:dev": { name: "dev", status: "thinking" } },
    configs: {},
  });
  render(<AgentListSection onSelectAgent={() => {}} />);
  const dot = screen.getByTestId("status-dev");
  expect((dot as HTMLElement).style.background).toBe("#89b4fa"); // thinking 蓝
});

test("点击触发 onSelectAgent", () => {
  const fn = vi.fn();
  render(<AgentListSection onSelectAgent={fn} />);
  fireEvent.click(screen.getByTestId("agent-dev"));
  expect(fn).toHaveBeenCalledWith("dev");
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/AgentListSection.tsx packages/frontend/tests/AgentListSection.test.tsx
git commit -m "feat(frontend): AgentListSection 组件（② 我的智能体 + 全局聚合状态点）"
```

---

