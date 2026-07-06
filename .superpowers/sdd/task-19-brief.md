### Task 19: Sidebar 容器（编排四区）

**Files:**
- Create: `packages/frontend/src/components/Sidebar.tsx`
- Test: `packages/frontend/tests/Sidebar.test.tsx`

**Interfaces:**
- Consumes: NewSessionButton, AgentListSection, ProjectList
- Produces: 260px 宽容器，编排四区，透传各回调

- [ ] **Step 1: 实现**

`packages/frontend/src/components/Sidebar.tsx`:
```typescript
import type { AgentName } from "@hiagent/shared";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";

interface Props {
  onNewSession: () => void;
  onSelectAgent: (name: AgentName) => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onNewProject: () => void;
}

export function Sidebar(props: Props) {
  return (
    <aside
      className="flex flex-col gap-1 p-2 overflow-hidden"
      style={{ width: 260, background: "#181825" }}
      data-testid="sidebar"
    >
      <NewSessionButton onNewSession={props.onNewSession} />
      <AgentListSection onSelectAgent={props.onSelectAgent} />
      <ProjectList
        onSelectSession={props.onSelectSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onProjectSettings={props.onProjectSettings}
        onNewProject={props.onNewProject}
      />
    </aside>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/Sidebar.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
  useAgentsStore.setState({ states: {}, configs: {} });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText("新建会话")).toBeTruthy();
  expect(screen.getByText("我的智能体")).toBeTruthy();
  expect(screen.getByText("项目管理")).toBeTruthy();
});

test("透传 onNewSession", () => {
  const fn = vi.fn();
  render(<Sidebar onNewSession={fn} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/Sidebar.tsx packages/frontend/tests/Sidebar.test.tsx
git commit -m "feat(frontend): Sidebar 容器（编排四区，260px 宽）"
```

---

