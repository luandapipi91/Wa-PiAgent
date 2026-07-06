### Task 25: SessionView 组件

**Files:**
- Create: `packages/frontend/src/components/SessionView.tsx`
- Test: `packages/frontend/tests/SessionView.test.tsx`

**Interfaces:**
- Consumes: MessageList, Composer, AskCard, useProjectsStore, useIntercomStore, useAgentsStore
- Produces: 会话 header（标题 + 橙色 intercom 徽标 + 主理agent/模型/状态）+ 消息流（含内联 AskCard）+ Composer

- [ ] **Step 1: 实现**

`packages/frontend/src/components/SessionView.tsx`:
```typescript
import { useEffect } from "react";
import { useProjectsStore } from "../store/projects";
import { useIntercomStore } from "../store/intercom";
import { useAgentsStore } from "../store/agents";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskCard } from "./AskCard";
import { agentEmoji } from "../theme/agents";
import { onMessage } from "../ws-instance";

interface Props { sessionId: string; onSwitchToCanvas: () => void; }

export function SessionView({ sessionId, onSwitchToCanvas }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const asks = useIntercomStore(s => s.asksBySession[sessionId] ?? []);
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? []);
  const getGlobalState = useAgentsStore(s => s.getGlobalState);

  useEffect(() => {
    const off = onMessage(e => {
      if (e.type === "agent:message" && e.sessionId === sessionId) useSessionStore.getState().append(e.message);
      if (e.type === "intercom:ask" && e.sessionId === sessionId) useIntercomStore.getState().addAsk(e.ask);
      if (e.type === "intercom:reply" && e.sessionId === sessionId) useIntercomStore.getState().resolveAsk(sessionId, e.askMessageId);
      if (e.type === "agent:state") useAgentsStore.getState().setState(`${e.projectId}:${e.agentName}`, e.state);
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const activeAsk = asks.find(a => !a.resolved);
  const state = getGlobalState(session.primaryAgent);

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-surface2" style={{ background: "#181825" }}>
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-text font-semibold">{session.title}</span>
            {activeAsk && (
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: "rgba(250,179,135,0.2)", color: "#fab387" }}
                data-testid="intercom-badge"
              >● {activeAsk.from}→{activeAsk.to} · ask · {Math.floor((Date.now() - activeAsk.startedAt)/1000)}s</span>
            )}
          </div>
          <div className="text-xs text-overlay">{session.primaryAgent} · {project?.cwd ?? ""} · {state}</div>
        </div>
        <button onClick={onSwitchToCanvas} className="text-sm text-subtext hover:text-text">编排画布</button>
      </header>
      <MessageList sessionId={sessionId} />
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <Composer sessionId={sessionId} agentName={session.primaryAgent} />
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/SessionView.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useIntercomStore } from "../src/store/intercom";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

vi.mock("../src/ws-instance", () => ({ onMessage: () => () => {} }));

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0 }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useIntercomStore.setState({ asksBySession: {} });
  useAgentsStore.setState({ states: {}, configs: {} });
  useSessionStore.setState({ messagesBySession: {} });
});

test("渲染 header 标题 + 项目目录", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByText("测试")).toBeTruthy();
  expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("无活跃 ask 不显示徽标", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.queryByTestId("intercom-badge")).toBeNull();
});

test("有活跃 ask 显示徽标", () => {
  useIntercomStore.setState({
    asksBySession: { s1: [{ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: Date.now(), resolved: false }] },
  });
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByTestId("intercom-badge")).toBeTruthy();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/SessionView.tsx packages/frontend/tests/SessionView.test.tsx
git commit -m "feat(frontend): SessionView（header 徽标 + 项目目录 + 消息流 + Composer）"
```

---

