### Task 23: Composer 组件

**Files:**
- Create: `packages/frontend/src/components/Composer.tsx`
- Test: `packages/frontend/tests/Composer.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`（取 projectId/sessionId/primaryAgent），`send`
- Produces: 发送 `agent:prompt` 事件

- [ ] **Step 1: 实现**

`packages/frontend/src/components/Composer.tsx`:
```typescript
import { useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { agentEmoji } from "../theme/agents";

interface Props { sessionId: string; agentName: AgentName; }

export function Composer({ sessionId, agentName }: Props) {
  const [text, setText] = useState("");
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const handleSend = () => {
    if (!text.trim()) return;
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
  };

  return (
    <div className="p-3" style={{ background: "#181825" }} data-testid="composer">
      <div className="flex gap-2 items-end rounded-lg p-2" style={{ background: "#313244" }}>
        <span className="text-lg">{agentEmoji(agentName)}</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={`给${agentName}发消息...`}
          className="flex-1 bg-transparent text-text outline-none resize-none text-sm"
          rows={1}
          data-testid="composer-input"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="px-3 py-1 rounded text-sm"
          style={{ background: text.trim() ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
          data-testid="composer-send"
        >↩</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/Composer.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1", currentSessionId: "s1",
}));

test("输入发送调 send 带 projectId/sessionId/agentName", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<Composer sessionId="s1" agentName={"dev" as const} />);
  fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "继续" } });
  fireEvent.click(screen.getByTestId("composer-send"));
  const arg = (send as any).mock.calls[0][0];
  expect(arg).toEqual({ type: "agent:prompt", projectId: "p1", sessionId: "s1", agentName: "dev", text: "继续" });
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/Composer.tsx packages/frontend/tests/Composer.test.tsx
git commit -m "feat(frontend): Composer（带 projectId/sessionId/agentName 发送）"
```

---

