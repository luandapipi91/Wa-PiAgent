### Task 14: WS 客户端 + 4 个 store

**Files:**
- Create: `packages/frontend/src/ws-instance.ts`（单例 WS 连接）
- Create: `packages/frontend/src/store/projects.ts`
- Create: `packages/frontend/src/store/session.ts`
- Create: `packages/frontend/src/store/agents.ts`
- Create: `packages/frontend/src/store/intercom.ts`
- Test: `packages/frontend/tests/store-projects.test.ts` / `store-agents.test.ts`

**Interfaces:**
- Consumes: 所有 `@hiagent/shared` 类型与事件
- Produces（**后续所有组件依赖**）:
  - `wsInstance`: 单例 WebSocket，`send(e: WSClientEvent)`，`onMessage(cb)` 注册
  - `useProjectsStore`: Zustand store，字段 `{ projects, sessions, currentProjectId, currentSessionId, load(), createProject(), selectProject(id), selectSession(id) }`
  - `useSessionStore`: `{ messagesBySession: Record<string, ChatMessage[]>, append(msg), clear() }`
  - `useAgentsStore`: `{ states: Record<AgentStateKey, AgentState>, configs: Record<AgentName, AgentConfig>, setState(key, s), getGlobalState(name): AgentStatus, loadConfig(name) }`
  - `useIntercomStore`: `{ asksBySession: Record<string, AskItem[]>, addAsk(ask), resolveAsk(sessionId, id) }`

- [ ] **Step 1: 写 ws-instance.ts**

`packages/frontend/src/ws-instance.ts`:
```typescript
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";

type Handler = (e: WSServerEvent) => void;
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;

export function getWs(): WebSocket {
  if (!ws) {
    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as WSServerEvent;
        handlers.forEach(h => h(e));
      } catch {}
    };
  }
  return ws;
}

export function send(e: WSClientEvent): void {
  const s = getWs();
  if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(e));
  else s.addEventListener("open", () => s.send(JSON.stringify(e)), { once: true });
}

export function onMessage(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
```

- [ ] **Step 2: 写 projects store**

`packages/frontend/src/store/projects.ts`:
```typescript
import { create } from "zustand";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { send } from "../ws-instance";

interface ProjectsState {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  load: () => void;
  setAll: (projects: ProjectEntity[], sessions: SessionEntity[]) => void;
  createProject: (name: string, cwd: string) => void;
  addProject: (p: ProjectEntity) => void;
  addSession: (s: SessionEntity) => void;
  selectProject: (id: string) => void;
  selectSession: (id: string) => void;
  setCurrentSessionId: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  load: () => send({ type: "projects:list" }),
  setAll: (projects, sessions) => set({ projects, sessions }),
  createProject: (name, cwd) => send({ type: "project:create", name, cwd }),
  addProject: (p) => set(s => ({ projects: [...s.projects, p], currentProjectId: p.id })),
  addSession: (sess) => set(s => ({
    sessions: [...s.sessions, sess],
    currentSessionId: sess.id,
    currentProjectId: sess.projectId,
  })),
  selectProject: (id) => set({ currentProjectId: id }),
  selectSession: (id) => set({ currentSessionId: id }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
```

- [ ] **Step 3: 写 session store**

`packages/frontend/src/store/session.ts`:
```typescript
import { create } from "zustand";
import type { ChatMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, ChatMessage[]>;
  append: (msg: ChatMessage) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (msg) => set(s => ({
    messagesBySession: {
      ...s.messagesBySession,
      [msg.sessionId]: [...(s.messagesBySession[msg.sessionId] ?? []), msg],
    },
  })),
  clear: () => set({ messagesBySession: {} }),
}));
```

- [ ] **Step 4: 写 agents store**

`packages/frontend/src/store/agents.ts`:
```typescript
import { create } from "zustand";
import type { AgentConfig, AgentName, AgentState, AgentStateKey, AgentStatus } from "@hiagent/shared";
import { aggregateAgentState } from "@hiagent/shared";
import { send } from "../ws-instance";

interface AgentsState {
  states: Record<AgentStateKey, AgentState>;
  configs: Partial<Record<AgentName, AgentConfig>>;
  setState: (key: AgentStateKey, s: AgentState) => void;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
  getGlobalState: (name: AgentName) => AgentStatus;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  states: {},
  configs: {},
  setState: (key, s) => set(st => ({ states: { ...st.states, [key]: s } })),
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
  getGlobalState: (name) => {
    const all = Object.entries(get().states)
      .filter(([k]) => k.endsWith(`:${name}`))
      .map(([, v]) => v);
    return aggregateAgentState(all);
  },
}));
```

- [ ] **Step 5: 写 intercom store**

`packages/frontend/src/store/intercom.ts`:
```typescript
import { create } from "zustand";
import type { AskItem } from "@hiagent/shared";

interface IntercomState {
  asksBySession: Record<string, AskItem[]>;
  addAsk: (ask: AskItem) => void;
  resolveAsk: (sessionId: string, id: string) => void;
}

export const useIntercomStore = create<IntercomState>((set) => ({
  asksBySession: {},
  addAsk: (ask) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [ask.sessionId]: [...(s.asksBySession[ask.sessionId] ?? []), ask],
    },
  })),
  resolveAsk: (sessionId, id) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [sessionId]: (s.asksBySession[sessionId] ?? []).map(a =>
        a.messageId === id ? { ...a, resolved: true, resolvedAt: Date.now() } : a
      ),
    },
  })),
}));
```

- [ ] **Step 6: 写 store 测试**

`packages/frontend/tests/store-projects.test.ts`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("setAll 设置项目列表", () => {
  useProjectsStore.getState().setAll(
    [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    [],
  );
  expect(useProjectsStore.getState().projects).toHaveLength(1);
});

test("addSession 切到新会话", () => {
  useProjectsStore.getState().addSession({
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "t", createdAt: 0, lastActivity: 0,
  });
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});
```

`packages/frontend/tests/store-agents.test.ts`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("getGlobalState 跨项目聚合", () => {
  const { setState, getGlobalState } = useAgentsStore.getState();
  setState("p1:dev", { name: "dev", status: "idle" });
  setState("p2:dev", { name: "dev", status: "thinking" });
  expect(getGlobalState("dev")).toBe("thinking");
  setState("p3:dev", { name: "dev", status: "blocked" });
  expect(getGlobalState("dev")).toBe("blocked");
});
```

- [ ] **Step 7: 跑测试**

```bash
cd packages/frontend
bun run test
# 期望: 3 passed（含 Task 13 的 render）
```

- [ ] **Step 8: 提交**

```bash
git add packages/frontend
git commit -m "feat(frontend): WS 客户端 + 4 个 store（projects/session/agents/intercom）"
```

---

