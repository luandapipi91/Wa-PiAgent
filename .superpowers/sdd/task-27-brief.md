### Task 27: CanvasNode + Canvas 数据模型

**Files:**
- Create: `packages/frontend/src/components/canvas/types.ts`
- Create: `packages/frontend/src/components/canvas/CanvasNode.tsx`
- Test: `packages/frontend/tests/CanvasNode.test.tsx`

**Interfaces:**
- Consumes: `AgentConfig`, `AgentName`, `AGENT_DEFS`，`useAgentsStore`
- Produces:
  - `CanvasNodeData { agentName, state }`
  - `CanvasNode` React Flow 节点组件（22px emoji + 名称 + 状态行 + token）

- [ ] **Step 1: 类型**

`packages/frontend/src/components/canvas/types.ts`:
```typescript
import type { AgentName, AgentStatus } from "@hiagent/shared";

export interface CanvasNodeData {
  agentName: AgentName;
  status: AgentStatus;
  tokenCount?: number;
}
```

- [ ] **Step 2: CanvasNode 组件**

`packages/frontend/src/components/canvas/CanvasNode.tsx`:
```typescript
import { Handle, Position } from "reactflow";
import { AGENT_DEFS } from "@hiagent/shared";
import { STATUS_COLORS } from "../../theme/colors";
import type { CanvasNodeData } from "./types";

const STATUS_LABEL: Record<string, string> = {
  idle: "○ idle", thinking: "● thinking", blocked: "⏸ 等待回复",
};

export function CanvasNode({ data }: { data: CanvasNodeData }) {
  const def = AGENT_DEFS[data.agentName];
  const color = STATUS_COLORS[data.status];
  return (
    <div
      className="rounded-lg px-3 py-2 min-w-[90px]"
      style={{ background: "#181825", border: `2px solid ${color}`, boxShadow: data.status !== "idle" ? `0 0 20px ${color}40` : "none" }}
      data-testid={`canvas-node-${data.agentName}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1">
        <span className="text-lg">{def.emoji}</span>
        <span className="text-sm text-text">{def.label}</span>
      </div>
      <div className="text-[9px] mt-0.5" style={{ color }}>{STATUS_LABEL[data.status]}</div>
      {data.tokenCount !== undefined && <div className="text-[9px] text-overlay">{(data.tokenCount/1000).toFixed(1)}k tok</div>}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
```

- [ ] **Step 3: 测试**

`packages/frontend/tests/CanvasNode.test.tsx`:
```typescript
import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNode } from "../src/components/canvas/CanvasNode";

vi.mock("reactflow", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

test("渲染 emoji + 状态", () => {
  render(<CanvasNode data={{ agentName: "dev", status: "thinking", tokenCount: 2400 }} />);
  expect(screen.getByText("技术实现")).toBeTruthy();
  expect(screen.getByText(/thinking/)).toBeTruthy();
  expect(screen.getByText(/2\.4k tok/)).toBeTruthy();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/canvas packages/frontend/tests/CanvasNode.test.tsx
git commit -m "feat(frontend): CanvasNode（React Flow 节点 + 状态边框）"
```

---

