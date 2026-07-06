### Task 18: ProjectList + ProjectItem + SessionRow（③ 项目管理区）

**Files:**
- Create: `packages/frontend/src/components/ProjectList.tsx`
- Create: `packages/frontend/src/components/ProjectItem.tsx`
- Create: `packages/frontend/src/components/SessionRow.tsx`
- Test: `packages/frontend/tests/ProjectList.test.tsx` / `SessionRow.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`，`formatRelativeTime`，`agentEmoji`
- Produces:
  - `ProjectList`: 渲染项目列表 + "＋ 新建项目"按钮
  - `ProjectItem`: 折叠/展开 + ＋（项目内新建）+ ⚙️（设置）
  - `SessionRow`: `{emoji} {title} · {time}`，选中态蓝左条

- [ ] **Step 1: SessionRow 组件 + 测试**

`packages/frontend/src/components/SessionRow.tsx`:
```typescript
import type { SessionEntity } from "@hiagent/shared";
import { formatRelativeTime } from "@hiagent/shared";
import { agentEmoji } from "../theme/agents";

interface Props {
  session: SessionEntity;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({ session, selected, onSelect }: Props) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm"
      style={{
        borderLeft: selected ? "2px solid #89b4fa" : "2px solid transparent",
        background: selected ? "rgba(137,180,250,0.15)" : "transparent",
      }}
      data-testid={`session-${session.id}`}
    >
      <span>{agentEmoji(session.primaryAgent)}</span>
      <span className="text-text flex-1 truncate">{session.title}</span>
      <span className="text-xs text-overlay">{formatRelativeTime(session.lastActivity)}</span>
    </button>
  );
}
```

`packages/frontend/tests/SessionRow.test.tsx`:
```typescript
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000,
};

test("显示 emoji + 标题 + 相对时间", () => {
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={() => {}} /></tbody></table>);
  expect(screen.getByText("⚙️")).toBeTruthy();
  expect(screen.getByText("测试会话")).toBeTruthy();
  expect(screen.getByText("2m")).toBeTruthy();
});

test("选中态蓝左条", () => {
  const { container } = render(<table><tbody><SessionRow session={session} selected={true} onSelect={() => {}} /></tbody></table>);
  const btn = container.querySelector("[data-testid='session-s1']") as HTMLElement;
  expect(btn.style.borderLeft).toContain("#89b4fa");
});

test("点击 onSelect", () => {
  const fn = vi.fn();
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={fn} /></tbody></table>);
  fireEvent.click(screen.getByTestId("session-s1"));
  expect(fn).toHaveBeenCalledWith("s1");
});
```

- [ ] **Step 2: ProjectItem + ProjectList 组件**

`packages/frontend/src/components/ProjectItem.tsx`:
```typescript
import { useState } from "react";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";

interface Props {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
}

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  const { project, sessions, currentSessionId } = props;
  const mySessions = sessions.filter(s => s.projectId === project.id);
  return (
    <div data-testid={`project-${project.id}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(e => !e)} className="text-overlay w-4">
          {expanded ? "▼" : "▶"}
        </button>
        <span className="text-sm text-text flex-1 truncate">{project.name}</span>
        <button
          onClick={() => props.onNewSessionInProject(project.id)}
          className="text-overlay hover:text-blue px-1"
          data-testid={`new-in-${project.id}`}
        >＋</button>
        <button
          onClick={() => props.onProjectSettings(project.id)}
          className="text-overlay hover:text-blue px-1"
        >⚙️</button>
      </div>
      {expanded && mySessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          selected={s.id === currentSessionId}
          onSelect={props.onSelectSession}
        />
      ))}
    </div>
  );
}
```

`packages/frontend/src/components/ProjectList.tsx`:
```typescript
import { useProjectsStore } from "../store/projects";
import { ProjectItem } from "./ProjectItem";

interface Props {
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onNewProject: () => void;
}

export function ProjectList(props: Props) {
  const { projects, sessions, currentSessionId } = useProjectsStore();
  return (
    <div className="flex-1 overflow-auto">
      <div className="text-xs text-overlay px-2 py-1 border-t border-surface2 mt-2">项目管理</div>
      {projects.map(p => (
        <ProjectItem
          key={p.id}
          project={p}
          sessions={sessions}
          currentSessionId={currentSessionId}
          {...props}
        />
      ))}
      <button
        onClick={props.onNewProject}
        className="w-full text-left px-2 py-1.5 text-xs text-overlay hover:text-blue"
        data-testid="new-project-btn"
      >＋ 新建项目</button>
    </div>
  );
}
```

- [ ] **Step 3: ProjectList 测试**

`packages/frontend/tests/ProjectList.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectList } from "../src/components/ProjectList";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("渲染项目 + 会话", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now() }],
    currentProjectId: null, currentSessionId: null,
  });
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByText("项目A")).toBeTruthy();
  expect(screen.getByText("会话1")).toBeTruthy();
});

test("项目内 ＋ 触发 onNewSessionInProject", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/a", createdAt: 0 }],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  const fn = vi.fn();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={fn} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-in-p1"));
  expect(fn).toHaveBeenCalledWith("p1");
});

test("新建项目按钮", () => {
  const fn = vi.fn();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={fn} />);
  fireEvent.click(screen.getByTestId("new-project-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/ProjectList.tsx packages/frontend/src/components/ProjectItem.tsx packages/frontend/src/components/SessionRow.tsx packages/frontend/tests/ProjectList.test.tsx packages/frontend/tests/SessionRow.test.tsx
git commit -m "feat(frontend): ProjectList + ProjectItem + SessionRow（③ 项目管理区）"
```

---
## Phase 4 — 前端主区

