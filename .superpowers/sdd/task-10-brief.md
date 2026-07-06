### Task 10: AgentManager（双 key spawn/kill）

**Files:**
- Create: `packages/kernel/src/agent-manager.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: `PiRpcClient`, `PiEvent` from `./pi-rpc-client`；`AgentManager` 持有 `ProjectStore`（取 cwd）；`makeAgentStateKey` from `@hiagent/shared`
- Produces:
  - `class AgentManager { constructor(opts: { projectStore: ProjectStore; onEvent: (key: AgentStateKey, e: PiEvent) => void; spawnFn?: PiRpcClient["opts"]["spawnFn"]; }); ensureStarted(projectId, agentName): Promise<PiRpcClient>; abort(projectId, agentName): Promise<void>; disposeAll(): Promise<void>; getState(key): AgentState | undefined; }`
  - agents Map key = `${projectId}:${agentName}`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-manager.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { rmSync } from "node:fs";
import { join } from "node:path";

function mockSpawn() {
  const child = {
    stdin: { write: () => {}, end: () => {} },
    stdout: new EventEmitter(),  // 自带 on/emit
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
  };
  return child as any;
}

function tempProjectFile() {
  return join(import.meta.dir, ".tmp-am-" + Math.random().toString(36).slice(2) + ".json");
}

test("ensureStarted 用 projectId+agentName 双 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/work" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p.id, "dev");
  const c2 = await am.ensureStarted(p.id, "dev");
  expect(c1).toBe(c2);  // 同 key 复用
  const events: [string, string][] = [];
  const am2 = new AgentManager({
    projectStore: ps,
    onEvent: (key, e) => events.push([key, e.kind]),
    spawnFn: mockSpawn,
  });
  await am2.ensureStarted(p.id, "product");
  await am.disposeAll();
  await am2.disposeAll();
  rmSync(f, { force: true });
});

test("不同 projectId 是独立进程", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p1 = await ps.createProject({ name: "A", cwd: "/a" });
  const p2 = await ps.createProject({ name: "B", cwd: "/b" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p1.id, "dev");
  const c2 = await am.ensureStarted(p2.id, "dev");
  expect(c1).not.toBe(c2);
  await am.disposeAll();
  rmSync(f, { force: true });
});

test("onEvent 携带正确 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });
  const seen: string[] = [];
  const am = new AgentManager({
    projectStore: ps,
    onEvent: (key) => seen.push(key),
    spawnFn: mockSpawn,
  });
  await am.ensureStarted(p.id, "dev");
  expect(seen).toContain(`${p.id}:dev`);
  await am.disposeAll();
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 agent-manager.ts**

`packages/kernel/src/agent-manager.ts`:
```typescript
import type { AgentName, AgentState, AgentStateKey } from "@hiagent/shared";
import { makeAgentStateKey } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import { PiRpcClient, type PiEvent, type PiRpcClientOpts } from "./pi-rpc-client";

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  onEvent: (key: AgentStateKey, e: PiEvent) => void;
  spawnFn?: PiRpcClientOpts["spawnFn"];
}

export class AgentManager {
  private agents = new Map<AgentStateKey, PiRpcClient>();
  private states = new Map<AgentStateKey, AgentState>();

  constructor(private opts: AgentManagerOpts) {}

  async ensureStarted(projectId: string, agentName: AgentName): Promise<PiRpcClient> {
    const key = makeAgentStateKey(projectId, agentName);
    const existing = this.agents.get(key);
    if (existing) return existing;

    const { projects } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);

    const client = new PiRpcClient({
      agentName,
      cwd: project.cwd,
      sessionId: `${projectId}-${agentName}`,  // pi-intercom 会话名
      spawnFn: this.opts.spawnFn,
      onEvent: (e) => {
        if (e.kind === "state") this.states.set(key, e.state);
        this.opts.onEvent(key, e);
      },
    });
    await client.start();
    this.agents.set(key, client);
    return client;
  }

  async abort(projectId: string, agentName: AgentName): Promise<void> {
    const key = makeAgentStateKey(projectId, agentName);
    const client = this.agents.get(key);
    if (client) await client.abort();
  }

  getState(key: AgentStateKey): AgentState | undefined {
    return this.states.get(key);
  }

  getAllStates(): Map<AgentStateKey, AgentState> {
    return new Map(this.states);
  }

  async disposeAll(): Promise<void> {
    for (const client of this.agents.values()) await client.dispose();
    this.agents.clear();
    this.states.clear();
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/agent-manager.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): AgentManager（双 key spawn，cwd 取自 project）"
```

---

