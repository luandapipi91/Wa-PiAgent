### Task 21: App 三态路由（empty/new-session/session）

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Create: `packages/frontend/src/components/EmptyState.tsx`（无项目引导）
- Test: `packages/frontend/tests/App-routing.test.tsx`

**Interfaces:**
- Consumes: Sidebar, NewSessionPane, SessionView, useProjectsStore
- Produces: `currentView: "empty" | "new-session" | "session"`，由 projects/currentSessionId 派生

- [ ] **Step 1: EmptyState 组件**

`packages/frontend/src/components/EmptyState.tsx`:
```typescript
interface Props { onNewProject: () => void; }

export function EmptyState({ onNewProject }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center" data-testid="empty-state">
      <p className="text-text mb-4">还没有项目，先创建一个吧</p>
      <button
        onClick={onNewProject}
        className="px-4 py-2 rounded text-sm"
        style={{ background: "#89b4fa", color: "#1e1e2e" }}
        data-testid="empty-new-project"
      >＋ 新建项目</button>
    </div>
  );
}
```

- [ ] **Step 2: App 三态路由**

`packages/frontend/src/App.tsx`:
```typescript
import { useEffect, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { useProjectsStore } from "./store/projects";
import { onMessage, getWs } from "./ws-instance";

type View = "empty" | "new-session" | "session";

export function App() {
  // 只订阅渲染所需的最小状态；actions 在回调里用 getState() 取，避免 stale closure
  const projects = useProjectsStore(s => s.projects);
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const [view, setView] = useState<View>("empty");
  const [configAgent, setConfigAgent] = useState<AgentName | null>(null);

  useEffect(() => {
    getWs();
    useProjectsStore.getState().load();  // getState() 取最新 action
    const off = onMessage(e => {
      const ps = useProjectsStore.getState();  // 每次事件取最新，避免 stale
      switch (e.type) {
        case "projects:list": ps.setAll(e.projects, e.sessions); break;
        case "project:created": ps.addProject(e.project); break;
        case "session:created": ps.addSession(e.session); break;
      }
    });
    return off;
  }, []);  // 空依赖：onMessage 用 getState，不需重订阅

  // 派生 view
  useEffect(() => {
    if (projects.length === 0) setView("empty");
    else if (currentSessionId) setView("session");
    else setView("new-session");
  }, [projects.length, currentSessionId]);

  return (
    <div className="flex h-screen" style={{ background: "#1e1e2e" }}>
      <Sidebar
        onNewSession={() => setView("new-session")}
        onSelectAgent={(name) => setConfigAgent(name)}
        onSelectSession={(id) => { useProjectsStore.getState().selectSession(id); setView("session"); }}
        onNewSessionInProject={(pid) => { useProjectsStore.getState().selectProject(pid); setView("new-session"); }}
        onProjectSettings={() => {}}
        onNewProject={() => { const name = prompt("项目名"); const cwd = prompt("cwd"); if (name && cwd) useProjectsStore.getState().createProject(name, cwd); }}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "empty" && <EmptyState onNewProject={() => useProjectsStore.getState().createProject(prompt("项目名")!, prompt("cwd")!)} />}
        {view === "new-session" && <NewSessionPane />}
        {view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} onSwitchToCanvas={() => {}} />}
      </main>
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
    </div>
  );
}
```

- [ ] **Step 3: 测试**

`packages/frontend/tests/App-routing.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("无项目显示 empty 态", () => {
  render(<App />);
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});

test("有项目无会话显示 new-session 态", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [], currentProjectId: "p1", currentSessionId: null,
  });
  render(<App />);
  expect(screen.getByTestId("new-session-pane")).toBeTruthy();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend
git commit -m "feat(frontend): App 三态路由（empty/new-session/session）"
```

---

