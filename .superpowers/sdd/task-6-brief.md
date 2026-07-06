### Task 6: ProjectStore（读写 projects.json）

**Files:**
- Create: `packages/kernel/src/project-store.ts`
- Test: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Consumes: `PROJECTS_FILE`, `ProjectEntity`, `SessionEntity` from `@hiagent/shared`
- Produces:
  - `class ProjectStore { constructor(filePath?: string); load(): Promise<{projects, sessions}>; createProject({name, cwd}): Promise<ProjectEntity>; updateProject(id, patch): Promise<void>; deleteProject(id): Promise<void>; createSession({projectId, primaryAgent, title}): Promise<SessionEntity>; renameSession(id, title): Promise<void>; deleteSession(id): Promise<void>; }`
  - `id` 用 `crypto.randomUUID()`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/project-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";

function tempFile() {
  return join(import.meta.dir, ".tmp-projects-" + Math.random().toString(36).slice(2) + ".json");
}

test("load 空状态返回空数组", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("createProject 持久化", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "项目A", cwd: "/work/a" });
  expect(p.name).toBe("项目A");
  const { projects } = await store.load();
  expect(projects).toHaveLength(1);
  rmSync(f, { force: true });
});

test("createSession 归属项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  const s = await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "会话1" });
  expect(s.projectId).toBe(p.id);
  expect(s.primaryAgent).toBe("dev");
  const { sessions } = await store.load();
  expect(sessions).toHaveLength(1);
  rmSync(f, { force: true });
});

test("deleteProject 级联删 session", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "s1" });
  await store.deleteProject(p.id);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("updateProject 改名", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "旧", cwd: "/p" });
  await store.updateProject(p.id, { name: "新" });
  const { projects } = await store.load();
  expect(projects[0].name).toBe("新");
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 project-store.ts**

`packages/kernel/src/project-store.ts`:
```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_FILE } from "@hiagent/shared";
import type { ProjectEntity, SessionEntity, AgentName } from "@hiagent/shared";

interface ProjectsFile {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
}

const EMPTY: ProjectsFile = { projects: [], sessions: [] };

export class ProjectStore {
  constructor(private filePath: string = PROJECTS_FILE) {}

  async load(): Promise<ProjectsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as ProjectsFile;
      return { projects: data.projects ?? [], sessions: data.sessions ?? [] };
    } catch {
      return { ...EMPTY };
    }
  }

  private async save(data: ProjectsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async createProject(input: { name: string; cwd: string }): Promise<ProjectEntity> {
    const data = await this.load();
    const project: ProjectEntity = {
      id: randomUUID(), name: input.name, cwd: input.cwd, createdAt: Date.now(),
    };
    data.projects.push(project);
    await this.save(data);
    return project;
  }

  async updateProject(id: string, patch: Partial<Pick<ProjectEntity, "name" | "cwd">>): Promise<void> {
    const data = await this.load();
    const p = data.projects.find(x => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.cwd !== undefined) p.cwd = patch.cwd;
    await this.save(data);
  }

  async deleteProject(id: string): Promise<void> {
    const data = await this.load();
    data.projects = data.projects.filter(p => p.id !== id);
    data.sessions = data.sessions.filter(s => s.projectId !== id);
    await this.save(data);
  }

  async createSession(input: {
    projectId: string; primaryAgent: AgentName; title: string;
  }): Promise<SessionEntity> {
    const data = await this.load();
    const now = Date.now();
    const session: SessionEntity = {
      id: randomUUID(), projectId: input.projectId,
      primaryAgent: input.primaryAgent, title: input.title,
      createdAt: now, lastActivity: now,
    };
    data.sessions.push(session);
    await this.save(data);
    return session;
  }

  async renameSession(id: string, title: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) throw new Error(`会话不存在: ${id}`);
    s.title = title;
    await this.save(data);
  }

  async deleteSession(id: string): Promise<void> {
    const data = await this.load();
    data.sessions = data.sessions.filter(s => s.id !== id);
    await this.save(data);
  }

  async touchSession(id: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (s) { s.lastActivity = Date.now(); await this.save(data); }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/project-store.test.ts
# 期望: 5 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts
git commit -m "feat(kernel): ProjectStore 读写 projects.json（项目+会话 CRUD）"
```

---

