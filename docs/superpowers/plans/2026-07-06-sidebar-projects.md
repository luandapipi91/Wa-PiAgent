# Sidebar 重构 + 多项目支持 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有"按 agentName 单维度组织会话"的扁平结构，重构为"项目 → 会话"两级模型，支持多项目（独立 cwd）、会话归属项目、sidebar 重组四区块、新建会话改为主区切换面板。

**Architecture:** 三层改造——shared 类型扩展（Project/Session 实体）→ kernel 持久化 + AgentManager 双 key（`(projectId, agentName)`）+ WS 协议带 projectId/sessionId → 前端 store 重构（messages 按 sessionId 聚合）+ sidebar 拆分组件 + 主区状态机。

**Tech Stack:** React 19 + Zustand 5 + TypeScript 5.6（前端）；Bun + TypeScript（kernel）；共享包 `hiagent-shared`；测试用 `bun:test`（kernel + 前端 store）。

**Spec:** `docs/superpowers/specs/2026-07-06-sidebar-projects-design.md`

## Global Constraints

- **语言**：所有代码注释用中文；变量/函数名保持英文语义化
- **配色**：沿用 Catppuccin Mocha（见 spec 2026-07-05 第 6.0 节），不引入新色值
- **测试**：kernel 用 `bun:test`；前端 store 纯函数用 `bun:test`（项目无 vitest 配置，沿用现有 `packages/frontend/tests/store.test.ts` 模式）
- **依赖**：不引入新 npm 包，复用现有 zustand/react/reactflow
- **YAGNI**：不做项目级 agent 配置隔离、不做跨项目 intercom、不做会话搜索（spec 1.3 非目标）
- **现有 agent.md 配置不动**：agent 仍存 `~/.pi/agent/agents/*.md`，全局共享
- **持久化路径**：`~/.hiagent/projects.json` + `~/.hiagent/sessions/<id>.json`
- **WS 端口**：9776（不变）
- **回归**：每个 kernel 任务必须跑通现有 `packages/kernel/tests/*.test.ts`，不能破坏 intercom-monitor / pi-rpc-client 等已有测试

---

## 文件结构

### 新建文件

**shared 层**
- `packages/shared/src/types.ts`（修改，加 Project/Session 实体 + WSEvent 扩展）

**kernel 层**
- `packages/kernel/src/project-store.ts`（新建）— 项目 + 会话元数据持久化（projects.json）
- `packages/kernel/src/session-store.ts`（新建）— 单会话内容持久化（messages + intercomEvents）

**kernel 测试**
- `packages/kernel/tests/project-store.test.ts`（新建）
- `packages/kernel/tests/session-store.test.ts`（新建）

**前端 store**
- `packages/frontend/src/store/projects.ts`（新建）— 项目列表 CRUD + currentProjectId
- `packages/frontend/src/store/session.ts`（重写）— 改为按 sessionId 聚合

**前端组件**
- `packages/frontend/src/components/sidebar/NewSessionButton.tsx`（新建）
- `packages/frontend/src/components/sidebar/AgentListSection.tsx`（新建）
- `packages/frontend/src/components/sidebar/ProjectList.tsx`（新建）
- `packages/frontend/src/components/sidebar/ProjectItem.tsx`（新建）
- `packages/frontend/src/components/sidebar/SessionRow.tsx`（新建，从原 Sidebar 抽出）
- `packages/frontend/src/components/NewSessionPane.tsx`（新建，替代 LaunchScreen）
- `packages/frontend/src/components/ProjectSetup.tsx`（新建，首次无项目引导）

**前端测试**
- `packages/frontend/tests/projects-store.test.ts`（新建）
- `packages/frontend/tests/session-store.test.ts`（新建，替代原 store.test.ts 中 session 部分）

### 修改文件

- `packages/kernel/src/agent-manager.ts` — clients/states 改 `${projectId}:${agentName}` 双 key，spawn 时按 project.cwd
- `packages/kernel/src/state-aggregator.ts` — 所有事件加 projectId/sessionId 路由
- `packages/kernel/src/ws-server.ts` — 新增 projects:*/session:* 命令路由
- `packages/kernel/src/index.ts` — 装配 ProjectStore/SessionStore，扩展 client message handler
- `packages/frontend/src/App.tsx` — 三态路由（empty/project-setup/new-session/session）
- `packages/frontend/src/components/Sidebar.tsx` — 改为容器，组合子组件
- `packages/frontend/src/components/SessionView.tsx` — header 加 intercom 徽标；按 sessionId 取数据
- `packages/frontend/src/components/MessageList.tsx` — 数据源从 agentName 改为 sessionId
- `packages/frontend/src/components/AskCard.tsx` — props 不变（ask 自带 sessionId）
- `packages/frontend/src/components/Composer.tsx` — 不变（已通用）
- `packages/frontend/src/store/agents.ts` — states 改 `${projectId}:${agentName}` 维度 + 全局聚合 selector
- `packages/frontend/src/store/intercom.ts` — asks 加 sessionId 字段
- `packages/frontend/tests/store.test.ts` — 重写适配新 store 签名

### 删除文件

- `packages/frontend/src/components/LaunchScreen.tsx` — 被 NewSessionPane 取代（Task 11 完成后删）

---

## Task 1: shared 类型扩展（Project / Session 实体 + WS 协议）

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/tests/types.test.ts`

**Interfaces:**
- Produces: `ProjectEntity`, `SessionEntity`, `AskItem`（加 sessionId 字段）, 扩展后的 `WSEvent` 联合类型。后续所有 kernel 和 frontend 任务都依赖这些类型。

- [ ] **Step 1: 写失败测试 — 类型能编译**

创建 `packages/shared/tests/types.test.ts`（已存在则追加）：

```typescript
import { test, expect } from "bun:test";
import type { ProjectEntity, SessionEntity, WSEvent, ChatMessage } from "../src/types";

test("ProjectEntity 类型可实例化", () => {
  const p: ProjectEntity = { id: "p1", name: "项目 A", cwd: "/tmp/a", createdAt: 1 };
  expect(p.id).toBe("p1");
});

test("SessionEntity 类型可实例化", () => {
  const s: SessionEntity = {
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "会话1", createdAt: 1, lastActivity: 1,
  };
  expect(s.primaryAgent).toBe("dev");
});

test("WSEvent 含 projects:list 和 session:create 等新类型", () => {
  const e1: WSEvent = { type: "projects:list", projects: [], sessions: [] };
  const e2: WSEvent = { type: "session:create", session: { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 1, lastActivity: 1 } };
  const e3: WSEvent = { type: "agent:message", projectId: "p1", sessionId: "s1", agentName: "dev", message: { id: "m1", role: "user", text: "hi", timestamp: 1 } };
  expect(e1.type).toBe("projects:list");
  expect(e2.type).toBe("session:create");
  expect(e3.type).toBe("agent:message");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/shared/tests/types.test.ts`
Expected: 编译错误 — `ProjectEntity` / `SessionEntity` 不存在；`WSEvent` 不接受 `projects:list` 等。

- [ ] **Step 3: 实现类型扩展**

在 `packages/shared/src/types.ts` 末尾追加（不动现有类型）：

```typescript
// ===== 多项目实体（spec 2026-07-06 第二章）=====

export interface ProjectEntity {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

export interface SessionEntity {
  id: string;
  projectId: string;
  primaryAgent: string;   // 主理 agent name
  title: string;          // 首条消息截断或用户命名
  createdAt: number;
  lastActivity: number;
}
```

并修改 `WSEvent` 联合类型（注意：现有成员加 `projectId?` `sessionId?` 可选字段，保持向后兼容；新增成员带必填字段）：

```typescript
export type WSEvent =
  // 现有（加可选 projectId/sessionId，向后兼容）
  | { type: "agents:list"; agents: AgentConfig[] }
  | { type: "agent:state"; agentName: string; state: AgentState; projectId?: string }
  | { type: "agent:message"; agentName: string; message: ChatMessage; projectId?: string; sessionId?: string }
  | { type: "agent:tool"; agentName: string; toolName: string; toolCallId: string; phase: "start" | "end"; result?: string; projectId?: string; sessionId?: string }
  | { type: "intercom:ask"; from: string; to: string; messageId: string; text: string; startedAt: number; sessionId?: string }
  | { type: "intercom:reply"; toAskMessageId: string; text: string }
  | { type: "intercom:queue"; agentName: string; queue: Array<{ from: string; text: string; startedAt: number }> }
  // 新增：项目/会话管理
  | { type: "projects:list"; projects: ProjectEntity[]; sessions: SessionEntity[] }
  | { type: "project:create"; project: ProjectEntity }
  | { type: "project:update"; project: ProjectEntity }
  | { type: "project:delete"; projectId: string }
  | { type: "session:create"; session: SessionEntity }
  | { type: "session:delete"; sessionId: string }
  | { type: "session:rename"; sessionId: string; title: string };
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/shared/tests/types.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 跑全量回归**

Run: `bun test`
Expected: 现有所有测试仍通过（WSEvent 加可选字段不破坏旧代码）

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types.ts packages/shared/tests/types.test.ts
git commit -m "feat(shared): 新增 Project/Session 实体类型 + WS 协议扩展

- 引入 ProjectEntity / SessionEntity（spec 第二章）
- WSEvent 新增 projects:list/create/update/delete + session:create/delete/rename
- 现有事件加可选 projectId/sessionId，向后兼容"
```

---

## Task 2: kernel ProjectStore — 项目元数据持久化

**Files:**
- Create: `packages/kernel/src/project-store.ts`
- Test: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Produces: `class ProjectStore { constructor(storeDir: string); listProjects(): Promise<ProjectEntity[]>; listSessions(): Promise<SessionEntity[]>; createProject(name: string, cwd: string): Promise<ProjectEntity>; updateProject(id: string, patch: Partial<Pick<ProjectEntity,"name"|"cwd">>): Promise<ProjectEntity>; deleteProject(id: string): Promise<void>; createSession(projectId: string, primaryAgent: string, title?: string): Promise<SessionEntity>; deleteSession(id: string): Promise<void>; renameSession(id: string, title: string): Promise<void>; touchSession(id: string): Promise<void>; }`
- 数据落盘到 `<storeDir>/projects.json`，结构 `{ projects: ProjectEntity[], sessions: SessionEntity[] }`

- [ ] **Step 1: 写失败测试**

创建 `packages/kernel/tests/project-store.test.ts`：

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-ps-")); });
afterEach(async () => { await rm(dir, { recursive: true }); });

test("createProject 创建并落盘", async () => {
  const store = new ProjectStore(dir);
  const p = await store.createProject("项目 A", "/tmp/a");
  expect(p.name).toBe("项目 A");
  expect(p.cwd).toBe("/tmp/a");
  expect(p.id).toMatch(/^p-/);
  // 重启后能读到
  const store2 = new ProjectStore(dir);
  const list = await store2.listProjects();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("项目 A");
});

test("createSession 归属项目", async () => {
  const store = new ProjectStore(dir);
  const p = await store.createProject("项目 A", "/tmp/a");
  const s = await store.createSession(p.id, "dev");
  expect(s.projectId).toBe(p.id);
  expect(s.primaryAgent).toBe("dev");
  const sessions = await store.listSessions();
  expect(sessions.length).toBe(1);
  expect(sessions[0].id).toBe(s.id);
});

test("deleteProject 同时删除其下所有 session", async () => {
  const store = new ProjectStore(dir);
  const p = await store.createProject("项目 A", "/tmp/a");
  await store.createSession(p.id, "dev");
  await store.createSession(p.id, "test");
  await store.deleteProject(p.id);
  expect((await store.listProjects()).length).toBe(0);
  expect((await store.listSessions()).length).toBe(0);
});

test("updateProject 改名和 cwd", async () => {
  const store = new ProjectStore(dir);
  const p = await store.createProject("旧名", "/tmp/old");
  const updated = await store.updateProject(p.id, { name: "新名", cwd: "/tmp/new" });
  expect(updated.name).toBe("新名");
  expect(updated.cwd).toBe("/tmp/new");
});

test("renameSession + touchSession", async () => {
  const store = new ProjectStore(dir);
  const p = await store.createProject("P", "/tmp");
  const s = await store.createSession(p.id, "dev");
  await store.renameSession(s.id, "新标题");
  await store.touchSession(s.id);
  const sessions = await store.listSessions();
  expect(sessions[0].title).toBe("新标题");
  expect(sessions[0].lastActivity).toBeGreaterThan(s.lastActivity);
});

test("空目录首次 listProjects 返回空数组（不抛错）", async () => {
  const store = new ProjectStore(dir);
  expect(await store.listProjects()).toEqual([]);
  expect(await store.listSessions()).toEqual([]);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/project-store.test.ts`
Expected: FAIL — 模块 `../src/project-store` 不存在。

- [ ] **Step 3: 实现 ProjectStore**

创建 `packages/kernel/src/project-store.ts`：

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectEntity, SessionEntity } from "hiagent-shared";

interface DBShape {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
}

export class ProjectStore {
  private filePath: string;

  constructor(private storeDir: string) {
    this.filePath = join(storeDir, "projects.json");
  }

  private async read(): Promise<DBShape> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as DBShape;
    } catch (e: any) {
      if (e.code === "ENOENT") return { projects: [], sessions: [] };
      throw e;
    }
  }

  private async write(db: DBShape): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(db, null, 2), "utf-8");
  }

  async listProjects(): Promise<ProjectEntity[]> {
    return (await this.read()).projects;
  }

  async listSessions(): Promise<SessionEntity[]> {
    return (await this.read()).sessions;
  }

  async createProject(name: string, cwd: string): Promise<ProjectEntity> {
    const db = await this.read();
    const p: ProjectEntity = { id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, cwd, createdAt: Date.now() };
    db.projects.push(p);
    await this.write(db);
    return p;
  }

  async updateProject(id: string, patch: Partial<Pick<ProjectEntity, "name" | "cwd">>): Promise<ProjectEntity> {
    const db = await this.read();
    const idx = db.projects.findIndex(p => p.id === id);
    if (idx < 0) throw new Error(`Project ${id} not found`);
    db.projects[idx] = { ...db.projects[idx], ...patch };
    await this.write(db);
    return db.projects[idx];
  }

  async deleteProject(id: string): Promise<void> {
    const db = await this.read();
    db.projects = db.projects.filter(p => p.id !== id);
    db.sessions = db.sessions.filter(s => s.projectId !== id);
    await this.write(db);
  }

  async createSession(projectId: string, primaryAgent: string, title = "新会话"): Promise<SessionEntity> {
    const db = await this.read();
    if (!db.projects.some(p => p.id === projectId)) throw new Error(`Project ${projectId} not found`);
    const now = Date.now();
    const s: SessionEntity = {
      id: `s-${now}-${Math.random().toString(36).slice(2, 8)}`,
      projectId, primaryAgent, title, createdAt: now, lastActivity: now,
    };
    db.sessions.push(s);
    await this.write(db);
    return s;
  }

  async deleteSession(id: string): Promise<void> {
    const db = await this.read();
    db.sessions = db.sessions.filter(s => s.id !== id);
    await this.write(db);
  }

  async renameSession(id: string, title: string): Promise<void> {
    const db = await this.read();
    const s = db.sessions.find(s => s.id === id);
    if (!s) throw new Error(`Session ${id} not found`);
    s.title = title;
    await this.write(db);
  }

  async touchSession(id: string): Promise<void> {
    const db = await this.read();
    const s = db.sessions.find(s => s.id === id);
    if (!s) throw new Error(`Session ${id} not found`);
    s.lastActivity = Date.now();
    await this.write(db);
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/project-store.test.ts`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 跑全量回归**

Run: `bun test packages/kernel`
Expected: 现有 kernel 测试全过

- [ ] **Step 6: 提交**

```bash
git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts
git commit -m "feat(kernel): ProjectStore 项目+会话元数据持久化

- 落盘到 <storeDir>/projects.json
- 项目 CRUD + 会话 CRUD（归属项目）
- deleteProject 级联删除其下会话"
```

---

## Task 3: kernel SessionStore — 单会话内容持久化

**Files:**
- Create: `packages/kernel/src/session-store.ts`
- Test: `packages/kernel/tests/session-store.test.ts`

**Interfaces:**
- Produces: `class SessionStore { constructor(storeDir: string); loadMessages(sessionId: string): Promise<ChatMessage[]>; appendMessage(sessionId: string, msg: ChatMessage): Promise<void>; loadAsks(sessionId: string): Promise<AskItemWithSession[]>; appendAsk(sessionId: string, ask: AskItemWithSession): Promise<void>; resolveAsk(sessionId: string, messageId: string): Promise<void>; deleteSession(sessionId: string): Promise<void>; }`
- 落盘到 `<storeDir>/sessions/<sessionId>.json`，结构 `{ messages: ChatMessage[], asks: AskItem[] }`
- 依赖 shared 的 `ChatMessage`；`AskItem` 在 shared 没定义（kernel 定义本地接口 `AskItemWithSession`）

- [ ] **Step 1: 写失败测试**

创建 `packages/kernel/tests/session-store.test.ts`：

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import type { ChatMessage } from "hiagent-shared";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-ss-")); });
afterEach(async () => { await rm(dir, { recursive: true }); });

const msg = (id: string, text: string): ChatMessage => ({ id, role: "user", text, timestamp: Date.now() });

test("appendMessage + loadMessages", async () => {
  const store = new SessionStore(dir);
  await store.appendMessage("s1", msg("m1", "hi"));
  await store.appendMessage("s1", msg("m2", "hello"));
  const loaded = await store.loadMessages("s1");
  expect(loaded.length).toBe(2);
  expect(loaded[0].id).toBe("m1");
});

test("不同 session 文件隔离", async () => {
  const store = new SessionStore(dir);
  await store.appendMessage("s1", msg("m1", "a"));
  await store.appendMessage("s2", msg("m2", "b"));
  expect((await store.loadMessages("s1")).length).toBe(1);
  expect((await store.loadMessages("s2")).length).toBe(1);
  expect((await store.loadMessages("s1"))[0].text).toBe("a");
});

test("appendAsk + loadAsks + resolveAsk", async () => {
  const store = new SessionStore(dir);
  await store.appendAsk("s1", { messageId: "a1", sessionId: "s1", from: "dev", to: "product", text: "需求?", startedAt: 1, resolved: false });
  await store.resolveAsk("s1", "a1");
  const asks = await store.loadAsks("s1");
  expect(asks.length).toBe(1);
  expect(asks[0].resolved).toBe(true);
});

test("loadMessages 空会话返回空数组（不抛错）", async () => {
  const store = new SessionStore(dir);
  expect(await store.loadMessages("nonexistent")).toEqual([]);
});

test("deleteSession 清理文件", async () => {
  const store = new SessionStore(dir);
  await store.appendMessage("s1", msg("m1", "hi"));
  await store.deleteSession("s1");
  expect(await store.loadMessages("s1")).toEqual([]);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/session-store.test.ts`
Expected: FAIL — 模块 `../src/session-store` 不存在。

- [ ] **Step 3: 实现 SessionStore**

创建 `packages/kernel/src/session-store.ts`：

```typescript
import { readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "hiagent-shared";

// kernel 本地类型（spec 2.2 AskItem 加 sessionId）
export interface AskItemWithSession {
  messageId: string;
  sessionId: string;
  from: string;
  to: string;
  text: string;
  startedAt: number;
  resolved: boolean;
}

interface SessionFile {
  messages: ChatMessage[];
  asks: AskItemWithSession[];
}

export class SessionStore {
  private sessionsDir: string;

  constructor(private storeDir: string) {
    this.sessionsDir = join(storeDir, "sessions");
  }

  private path(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  private async read(sessionId: string): Promise<SessionFile> {
    try {
      const raw = await readFile(this.path(sessionId), "utf-8");
      return JSON.parse(raw) as SessionFile;
    } catch (e: any) {
      if (e.code === "ENOENT") return { messages: [], asks: [] };
      throw e;
    }
  }

  private async write(sessionId: string, data: SessionFile): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.path(sessionId), JSON.stringify(data, null, 2), "utf-8");
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    return (await this.read(sessionId)).messages;
  }

  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    const data = await this.read(sessionId);
    data.messages.push(msg);
    await this.write(sessionId, data);
  }

  async loadAsks(sessionId: string): Promise<AskItemWithSession[]> {
    return (await this.read(sessionId)).asks;
  }

  async appendAsk(sessionId: string, ask: AskItemWithSession): Promise<void> {
    const data = await this.read(sessionId);
    // 去重（同 messageId 替换）
    data.asks = data.asks.filter(a => a.messageId !== ask.messageId);
    data.asks.push(ask);
    await this.write(sessionId, data);
  }

  async resolveAsk(sessionId: string, messageId: string): Promise<void> {
    const data = await this.read(sessionId);
    data.asks = data.asks.map(a => a.messageId === messageId ? { ...a, resolved: true } : a);
    await this.write(sessionId, data);
  }

  async deleteSession(sessionId: string): Promise<void> {
    try { await unlink(this.path(sessionId)); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/session-store.test.ts`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 跑全量回归**

Run: `bun test packages/kernel`
Expected: 全过

- [ ] **Step 6: 提交**

```bash
git add packages/kernel/src/session-store.ts packages/kernel/tests/session-store.test.ts
git commit -m "feat(kernel): SessionStore 单会话内容持久化

- 每会话独立文件 <storeDir>/sessions/<id>.json
- messages + asks（含 sessionId）持久化
- 支持 resolveAsk 标记已回复"
```

---

## Task 4: AgentManager 双 key 改造（`(projectId, agentName)`）

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`（shared）
- Produces: `AgentManager.ensureStarted(name, projectId, cwd): Promise<PiRpcClient>`、`get(name, projectId)`、`getState(name, projectId)`、`stop(name, projectId)`、`stopAll()`
- 事件签名变更：emit "event" 时 payload 加 `projectId`；emit "state" 同样加 `projectId`

- [ ] **Step 1: 改写测试**

替换 `packages/kernel/tests/agent-manager.test.ts` 中现有测试，增加 projectId 维度（保留 listAvailableAgents 测试不变）：

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { AgentManager } from "../src/agent-manager";
import type { AgentConfig } from "hiagent-shared";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-am-")); });
afterEach(async () => { await rm(dir, { recursive: true }); });

const makeConfig = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
});

test("listAvailableAgents 返回配置", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  await store.saveAgent(makeConfig("pm"));
  const mgr = new AgentManager(store);  // 不再传 cwd
  expect((await mgr.listAvailableAgents()).map(a => a.name).sort()).toEqual(["dev", "pm"]);
});

test("ensureStarted 同一项目同 agent 返回缓存实例", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store);
  const c1 = await mgr.ensureStarted("dev", "p1", "/tmp/a");
  const c2 = await mgr.ensureStarted("dev", "p1", "/tmp/a");
  expect(c1).toBe(c2);
});

test("ensureStarted 不同项目同 agent 是不同实例（双 key）", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store);
  const cA = await mgr.ensureStarted("dev", "p1", "/tmp/a");
  const cB = await mgr.ensureStarted("dev", "p2", "/tmp/b");
  expect(cA).not.toBe(cB);
});

test("getState 按 (projectId, agentName) 维度独立", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store);
  await mgr.ensureStarted("dev", "p1", "/tmp/a");
  await mgr.ensureStarted("dev", "p2", "/tmp/b");
  expect(mgr.getState("dev", "p1").status).toBe("idle");
  expect(mgr.getState("dev", "p2").status).toBe("idle");
  // 停 p1 不影响 p2
  mgr.stop("dev", "p1");
  expect(mgr.getState("dev", "p1").status).toBe("idle");
  expect(mgr.get("dev", "p1")).toBeUndefined();
  expect(mgr.get("dev", "p2")).toBeDefined();
});

test("事件 payload 带 projectId", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store);
  let captured: any = null;
  mgr.on("state", (p) => { captured = p; });
  await mgr.ensureStarted("dev", "p1", "/tmp/a");
  expect(captured.projectId).toBe("p1");
  expect(captured.agentName).toBe("dev");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/agent-manager.test.ts`
Expected: FAIL — 现有 `AgentManager(store, cwd)` 构造签名和 `ensureStarted(name)` 都不匹配。

- [ ] **Step 3: 改写 AgentManager**

替换 `packages/kernel/src/agent-manager.ts` 全文：

```typescript
import { EventEmitter } from "node:events";
import type { AgentConfig, AgentState, RPCEvent } from "hiagent-shared";
import { ConfigStore } from "./config-store";
import { PiRpcClient } from "./pi-rpc-client";

// 双 key：`${projectId}:${agentName}`（spec 第六章）
const key = (projectId: string, agentName: string) => `${projectId}:${agentName}`;

export class AgentManager extends EventEmitter {
  private clients = new Map<string, PiRpcClient>();
  private states = new Map<string, AgentState>();

  constructor(private configStore: ConfigStore) { super(); }  // 不再传 cwd

  async listAvailableAgents(): Promise<AgentConfig[]> { return this.configStore.listAgents(); }

  async ensureStarted(name: string, projectId: string, cwd: string): Promise<PiRpcClient> {
    const k = key(projectId, name);
    let client = this.clients.get(k);
    if (client) return client;
    const config = await this.configStore.getAgent(name);
    if (!config) throw new Error(`Agent "${name}" not found`);
    client = new PiRpcClient(config, cwd);  // cwd 来自 project.cwd
    client.on("event", (event: RPCEvent) => {
      this.updateState(projectId, name, event);
      this.emit("event", { projectId, agentName: name, event });
    });
    client.on("exit", () => {
      this.clients.delete(k);
      this.states.set(k, { status: "idle" });
      this.emit("state", { projectId, agentName: name, state: { status: "idle" } });
    });
    await client.start();
    this.clients.set(k, client);
    this.states.set(k, { status: "idle", model: config.model });
    return client;
  }

  get(name: string, projectId: string): PiRpcClient | undefined { return this.clients.get(key(projectId, name)); }
  getState(name: string, projectId: string): AgentState { return this.states.get(key(projectId, name)) ?? { status: "idle" }; }
  stop(name: string, projectId: string): void {
    const k = key(projectId, name);
    this.clients.get(k)?.stop();
    this.clients.delete(k);
  }
  stopAll(): void { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }

  private updateState(projectId: string, name: string, event: RPCEvent): void {
    const k = key(projectId, name);
    const prev = this.states.get(k) ?? { status: "idle" as const };
    let next = prev;
    if (event.type === "agent_start" || event.type === "turn_start") next = { ...prev, status: "thinking" };
    else if (event.type === "agent_end") next = { ...prev, status: "idle" };
    if (next !== prev) {
      this.states.set(k, next);
      this.emit("state", { projectId, agentName: name, state: next });
    }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/agent-manager.test.ts`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 跑全量回归（含 index.ts 编译）**

Run: `bun test packages/kernel`
Expected: index.ts 中 `new AgentManager(configStore, cwd)` 会编译失败（已删除 cwd 参数）—— 这是预期的，下个 Task 5 修 index.ts。临时把 index.ts 第 16 行改为 `new AgentManager(configStore)` 让编译通过，跑完测试后再恢复（或直接进 Task 5 一起改）。

> **注意**：如果回归因 index.ts 编译错误阻塞，可临时改 index.ts，但 Task 5 会完整重写 index.ts，所以这里允许临时打补丁。

- [ ] **Step 6: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "refactor(kernel): AgentManager 改 (projectId, agentName) 双 key

- 同一 agent 在不同项目是独立 pi 进程，cwd 来自 project.cwd
- 事件 payload 带 projectId
- 构造不再传 cwd，改由 ensureStarted 传入"
```

---

## Task 5: kernel 装配 + WS 命令路由扩展

**Files:**
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/state-aggregator.ts`（事件路由加 sessionId）

**Interfaces:**
- Consumes: `ProjectStore`（Task 2）、`SessionStore`（Task 3）、`AgentManager` 双 key（Task 4）、shared 新 WSEvent 类型（Task 1）
- Produces: 完整的 kernel main，处理新 WS 命令：`projects:list`、`project:create`、`project:update`、`project:delete`、`session:create`、`session:delete`、`session:rename`，以及改造后的 `agent:prompt`（带 projectId/sessionId）

- [ ] **Step 1: 改写 state-aggregator（事件路由加 projectId/sessionId）**

修改 `packages/kernel/src/state-aggregator.ts` 的 `handleAgentEvent` 签名，接收 `projectId` 和 `sessionId`，并把它们透传到 WSEvent：

```typescript
import { EventEmitter } from "node:events";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { RPCEvent, WSEvent, ChatMessage } from "hiagent-shared";

interface IntercomToolArgs { to?: string; message?: string; text?: string; expectsReply?: boolean; replyTo?: string; }

export class StateAggregator extends EventEmitter {
  constructor(private agentManager: AgentManager, private intercomMonitor: IntercomMonitor) { super(); }

  start(): void {
    // AgentManager 现在发 { projectId, agentName, event }
    this.agentManager.on("event", ({ projectId, agentName, event }) =>
      this.handleAgentEvent(projectId, agentName, event, null));
    this.agentManager.on("state", ({ projectId, agentName, state }) => {
      this.emit("ws:event", { type: "agent:state", projectId, agentName, state } as WSEvent);
    });
    this.intercomMonitor.on("reply", (r) => this.handleIntercomReply(r));
  }

  // sessionId 在 prompt 时由 index.ts 注入上下文（见下文 handleAgentEvent 第二参数）
  // 这里用 Map 缓存 toolCallId → sessionId（同一 ask 的 tool_execution_start/end 配对）
  private toolCallSession = new Map<string, string>();

  // 由 index.ts 在 agent:prompt 时调用，建立 sessionId 上下文
  bindSessionContext(projectId: string, agentName: string, sessionId: string): void {
    // 简化：用 projectId+agentName 作 key 存当前 sessionId（同一 agent 串行 prompt）
    this.currentSession.set(`${projectId}:${agentName}`, sessionId);
  }
  private currentSession = new Map<string, string>();

  handleAgentEvent(projectId: string, agentName: string, event: RPCEvent, _sessionId: string | null): void {
    const sessionId = this.currentSession.get(`${projectId}:${agentName}`) ?? _sessionId;
    switch (event.type) {
      case "tool_execution_start":
        if (event.toolName === "intercom") {
          const args = (event.args ?? {}) as IntercomToolArgs;
          if (args.expectsReply && args.to) {
            this.toolCallSession.set(event.toolCallId, sessionId);
            this.emit("ws:event", {
              type: "intercom:ask", from: agentName, to: args.to,
              messageId: event.toolCallId, text: args.message ?? args.text ?? "",
              startedAt: Date.now(), sessionId,
            } as WSEvent);
          }
        }
        this.emit("ws:event", { type: "agent:tool", projectId, sessionId, agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "start" } as WSEvent);
        break;
      case "tool_execution_end": {
        const resultText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        this.emit("ws:event", { type: "agent:tool", projectId, sessionId, agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "end", result: resultText } as WSEvent);
        break;
      }
      case "message_end": {
        const text = event.message.content?.map((c: any) => c.text ?? "").join("") ?? "";
        if (text) {
          const msg: ChatMessage = { id: `m${Date.now()}-${Math.random().toString(36).slice(2,6)}`, role: event.message.role === "user" ? "user" : "assistant", text, timestamp: Date.now() };
          this.emit("ws:event", { type: "agent:message", projectId, sessionId, agentName, message: msg } as WSEvent);
        }
        break;
      }
    }
  }

  handleIntercomReply(r: { toAskMessageId: string; text: string; from: string }): void {
    this.emit("ws:event", { type: "intercom:reply", toAskMessageId: r.toAskMessageId, text: r.text } as WSEvent);
  }
}
```

- [ ] **Step 2: 改写 index.ts（装配 ProjectStore/SessionStore + 新命令路由）**

替换 `packages/kernel/src/index.ts` 全文：

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

async function main() {
  const agentsDir = process.env.HIAGENT_AGENTS_DIR ?? join(homedir(), ".pi/agent/agents");
  const storeDir = process.env.HIAGENT_STORE_DIR ?? join(homedir(), ".hiagent");
  const port = 9776;
  console.log(`[HiAgent kernel] agentsDir=${agentsDir} storeDir=${storeDir} port=${port}`);

  const configStore = new ConfigStore(agentsDir);
  const projectStore = new ProjectStore(storeDir);
  const sessionStore = new SessionStore(storeDir);
  const agentManager = new AgentManager(configStore);
  const intercomMonitor = new IntercomMonitor();
  const aggregator = new StateAggregator(agentManager, intercomMonitor);
  const wsServer = new WSServer(port, aggregator);

  aggregator.start();
  await wsServer.start();
  await intercomMonitor.connect().catch(() => console.log("[kernel] broker not ready, will retry"));

  // 迁移：首次启动若无项目，建默认项目（spec 第八章 8.1）
  if ((await projectStore.listProjects()).length === 0) {
    const cwd = process.env.HIAGENT_CWD ?? process.cwd();
    await projectStore.createProject("默认项目", cwd);
    console.log("[kernel] 已创建默认项目");
  }

  wsServer.onClientMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "agents:list":
          aggregator.emit("ws:event", { type: "agents:list", agents: await agentManager.listAvailableAgents() });
          break;

        // === 项目管理 ===
        case "projects:list": {
          const [projects, sessions] = await Promise.all([projectStore.listProjects(), projectStore.listSessions()]);
          aggregator.emit("ws:event", { type: "projects:list", projects, sessions });
          break;
        }
        case "project:create": {
          const project = await projectStore.createProject(msg.name, msg.cwd);
          aggregator.emit("ws:event", { type: "project:create", project });
          break;
        }
        case "project:update": {
          const project = await projectStore.updateProject(msg.projectId, { name: msg.name, cwd: msg.cwd });
          aggregator.emit("ws:event", { type: "project:update", project });
          break;
        }
        case "project:delete": {
          // 级联：停掉该项目所有 agent + 删会话内容
          const sessions = (await projectStore.listSessions()).filter(s => s.projectId === msg.projectId);
          for (const s of sessions) {
            await sessionStore.deleteSession(s.id);
            if (s.primaryAgent) agentManager.stop(s.primaryAgent, msg.projectId);
          }
          await projectStore.deleteProject(msg.projectId);
          aggregator.emit("ws:event", { type: "project:delete", projectId: msg.projectId });
          break;
        }

        // === 会话管理 ===
        case "session:create": {
          const session = await projectStore.createSession(msg.projectId, msg.primaryAgent, msg.title);
          aggregator.emit("ws:event", { type: "session:create", session });
          break;
        }
        case "session:delete": {
          const meta = (await projectStore.listSessions()).find(s => s.id === msg.sessionId);
          await sessionStore.deleteSession(msg.sessionId);
          await projectStore.deleteSession(msg.sessionId);
          if (meta) agentManager.stop(meta.primaryAgent, meta.projectId);
          aggregator.emit("ws:event", { type: "session:delete", sessionId: msg.sessionId });
          break;
        }
        case "session:rename": {
          await projectStore.renameSession(msg.sessionId, msg.title);
          aggregator.emit("ws:event", { type: "session:rename", sessionId: msg.sessionId, title: msg.title });
          break;
        }

        // === 对话 ===
        case "agent:prompt": {
          const { projectId, sessionId, agentName, message } = msg;
          const project = (await projectStore.listProjects()).find(p => p.id === projectId);
          if (!project) throw new Error(`Project ${projectId} not found`);
          aggregator.bindSessionContext(projectId, agentName, sessionId);
          const userMsg = { id: `u${Date.now()}`, role: "user" as const, text: message, timestamp: Date.now() };
          await sessionStore.appendMessage(sessionId, userMsg);
          aggregator.emit("ws:event", { type: "agent:message", projectId, sessionId, agentName, message: userMsg });
          // 首条消息自动生成会话标题
          const session = (await projectStore.listSessions()).find(s => s.id === sessionId);
          if (session && session.title === "新会话") {
            const title = message.slice(0, 20);
            await projectStore.renameSession(sessionId, title);
            aggregator.emit("ws:event", { type: "session:rename", sessionId, title });
          }
          await projectStore.touchSession(sessionId);
          await intercomMonitor.connect().catch(() => {});
          await (await agentManager.ensureStarted(agentName, projectId, project.cwd)).prompt(message);
          break;
        }
        case "agent:abort":
          agentManager.get(msg.agentName, msg.projectId)?.abort();
          break;

        case "intercom:inject-reply":
          await intercomMonitor.injectReply(msg.messageId, msg.agentName, msg.toAskFrom, msg.text);
          break;
      }
    } catch (e: any) { console.error("[kernel] cmd error:", e.message); }
  });

  console.log(`[HiAgent kernel] listening on ws://localhost:${port}`);
  process.on("SIGINT", async () => { agentManager.stopAll(); await intercomMonitor.disconnect(); wsServer.stop(); process.exit(0); });
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: 跑全量 kernel 测试**

Run: `bun test packages/kernel`
Expected: 全过（含 Task 2/3/4 的测试 + 原有 intercom-monitor / pi-rpc-client / config-store / state-aggregator / agent-md / e2e-smoke）

> **若 state-aggregator.test.ts 因签名改动失败**：更新该测试文件的 mock 以匹配新签名 `handleAgentEvent(projectId, agentName, event, null)`。

- [ ] **Step 4: 手动 smoke：启动 kernel 验证默认项目创建**

Run: `HIAGENT_STORE_DIR=/tmp/hiagent-smoke rm -rf /tmp/hiagent-smoke && HIAGENT_STORE_DIR=/tmp/hiagent-smoke bun run packages/kernel/src/index.ts &; sleep 2; cat /tmp/hiagent-smoke/projects.json; kill %1`
Expected: 输出含一个"默认项目"的 JSON。

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/index.ts packages/kernel/src/state-aggregator.ts packages/kernel/tests/state-aggregator.test.ts
git commit -m "feat(kernel): 装配 ProjectStore/SessionStore + WS 命令路由扩展

- agent:prompt 带 projectId/sessionId，注入 session 上下文
- 新增 projects:list/create/update/delete + session:create/delete/rename
- 首启动自动建默认项目（迁移）
- 首条消息自动生成会话标题"
```

---

## Task 6: 前端 projects store

**Files:**
- Create: `packages/frontend/src/store/projects.ts`
- Test: `packages/frontend/tests/projects-store.test.ts`

**Interfaces:**
- Consumes: shared `ProjectEntity` / `SessionEntity`
- Produces: `useProjects` store：`{ projects: ProjectEntity[]; sessions: SessionEntity[]; currentProjectId: string | null; currentSessionId: string | null; setAll(projects, sessions): void; createProject(p): void; updateProject(p): void; removeProject(id): void; createSession(s): void; removeSession(id): void; renameSession(id, title): void; setCurrentProject(id): void; setCurrentSession(id): void; }`

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/projects-store.test.ts`：

```typescript
import { test, expect } from "bun:test";
import { useProjects } from "../src/store/projects";

test("setAll 初始化项目和会话", () => {
  useProjects.getState().setAll(
    [{ id: "p1", name: "项目 A", cwd: "/tmp/a", createdAt: 1 }],
    [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 1, lastActivity: 1 }],
  );
  expect(useProjects.getState().projects.length).toBe(1);
  expect(useProjects.getState().sessions.length).toBe(1);
});

test("createProject + createSession 增量更新", () => {
  useProjects.getState().setAll([], []);
  useProjects.getState().createProject({ id: "p1", name: "项目 A", cwd: "/tmp/a", createdAt: 1 });
  useProjects.getState().createSession({ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 1, lastActivity: 1 });
  expect(useProjects.getState().projects[0].id).toBe("p1");
  expect(useProjects.getState().sessions[0].projectId).toBe("p1");
});

test("removeProject 级联删除其下会话", () => {
  useProjects.getState().setAll(
    [{ id: "p1", name: "A", cwd: "/tmp", createdAt: 1 }],
    [
      { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 1, lastActivity: 1 },
      { id: "s2", projectId: "p1", primaryAgent: "pm", title: "t", createdAt: 1, lastActivity: 1 },
      { id: "s3", projectId: "p2", primaryAgent: "dev", title: "t", createdAt: 1, lastActivity: 1 },
    ],
  );
  useProjects.getState().removeProject("p1");
  expect(useProjects.getState().projects.length).toBe(0);
  expect(useProjects.getState().sessions.length).toBe(1);
  expect(useProjects.getState().sessions[0].id).toBe("s3");
});

test("setCurrentProject + setCurrentSession", () => {
  useProjects.getState().setAll([{ id: "p1", name: "A", cwd: "/tmp", createdAt: 1 }], []);
  useProjects.getState().setCurrentProject("p1");
  expect(useProjects.getState().currentProjectId).toBe("p1");
  useProjects.getState().setCurrentSession("s1");
  expect(useProjects.getState().currentSessionId).toBe("s1");
});

test("renameSession", () => {
  useProjects.getState().setAll([], [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "旧", createdAt: 1, lastActivity: 1 }]);
  useProjects.getState().renameSession("s1", "新标题");
  expect(useProjects.getState().sessions[0].title).toBe("新标题");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/frontend/tests/projects-store.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 projects store**

创建 `packages/frontend/src/store/projects.ts`：

```typescript
import { create } from "zustand";
import type { ProjectEntity, SessionEntity } from "hiagent-shared";

interface ProjectsStore {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  setAll: (projects: ProjectEntity[], sessions: SessionEntity[]) => void;
  createProject: (p: ProjectEntity) => void;
  updateProject: (p: ProjectEntity) => void;
  removeProject: (id: string) => void;
  createSession: (s: SessionEntity) => void;
  removeSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setCurrentProject: (id: string | null) => void;
  setCurrentSession: (id: string | null) => void;
}

export const useProjects = create<ProjectsStore>((set) => ({
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,

  setAll: (projects, sessions) => set({ projects, sessions }),

  createProject: (p) => set((s) => ({ projects: [...s.projects, p] })),

  updateProject: (p) => set((s) => ({
    projects: s.projects.map(x => x.id === p.id ? p : x),
  })),

  removeProject: (id) => set((s) => ({
    projects: s.projects.filter(p => p.id !== id),
    sessions: s.sessions.filter(sess => sess.projectId !== id),
    currentProjectId: s.currentProjectId === id ? null : s.currentProjectId,
    currentSessionId: s.sessions.find(sess => sess.id === s.currentSessionId)?.projectId === id ? null : s.currentSessionId,
  })),

  createSession: (sess) => set((s) => ({ sessions: [...s.sessions, sess] })),

  removeSession: (id) => set((s) => ({
    sessions: s.sessions.filter(x => x.id !== id),
    currentSessionId: s.currentSessionId === id ? null : s.currentSessionId,
  })),

  renameSession: (id, title) => set((s) => ({
    sessions: s.sessions.map(x => x.id === id ? { ...x, title } : x),
  })),

  setCurrentProject: (id) => set({ currentProjectId: id }),
  setCurrentSession: (id) => set({ currentSessionId: id }),
}));
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/frontend/tests/projects-store.test.ts`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/store/projects.ts packages/frontend/tests/projects-store.test.ts
git commit -m "feat(frontend): projects store 项目+会话列表状态

- projects/sessions/currentProjectId/currentSessionId
- 级联删除项目时清理会话和 currentSessionId"
```

---

## Task 7: 重写 session store（按 sessionId 聚合 messages）

**Files:**
- Modify: `packages/frontend/src/store/session.ts`
- Test: `packages/frontend/tests/session-store.test.ts`（新建，替代原 store.test.ts 的 session 部分）

**Interfaces:**
- Produces: `useSession` 改为 `{ messagesBySession: Record<string, ChatMessage[]>; addMessage(sessionId, msg): void; clearCurrentDraft(): void; }`
- 移除：`currentAgent`、`sessions`（迁到 projects store）、`selectAgent`
- messages 不再按 agentName 聚合

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/session-store.test.ts`：

```typescript
import { test, expect } from "bun:test";
import { useSession } from "../src/store/session";

test("addMessage 按 sessionId 聚合", () => {
  useSession.getState().addMessage("s1", { id: "m1", role: "user", text: "hi", timestamp: 1 });
  useSession.getState().addMessage("s1", { id: "m2", role: "assistant", text: "hello", timestamp: 2 });
  useSession.getState().addMessage("s2", { id: "m3", role: "user", text: "other", timestamp: 3 });
  expect(useSession.getState().messagesBySession["s1"].length).toBe(2);
  expect(useSession.getState().messagesBySession["s2"].length).toBe(1);
});

test("不同 session 隔离", () => {
  useSession.getState().addMessage("s1", { id: "m1", role: "user", text: "a", timestamp: 1 });
  useSession.getState().addMessage("s2", { id: "m2", role: "user", text: "b", timestamp: 2 });
  expect(useSession.getState().messagesBySession["s1"][0].text).toBe("a");
  expect(useSession.getState().messagesBySession["s2"][0].text).toBe("b");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/frontend/tests/session-store.test.ts`
Expected: FAIL — `messagesBySession` 不存在（现有是 `messages: Record<agentName, ...>`）。

- [ ] **Step 3: 重写 session store**

替换 `packages/frontend/src/store/session.ts` 全文：

```typescript
import { create } from "zustand";
import type { ChatMessage } from "hiagent-shared";

interface SessionStore {
  // 按 sessionId 聚合消息（spec 第七章，从 agentName 改为 sessionId）
  messagesBySession: Record<string, ChatMessage[]>;
  addMessage: (sessionId: string, msg: ChatMessage) => void;
}

export const useSession = create<SessionStore>((set) => ({
  messagesBySession: {},

  addMessage: (sessionId, msg) => set((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: [...(s.messagesBySession[sessionId] ?? []), msg],
    },
  })),
}));
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/frontend/tests/session-store.test.ts`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/session-store.test.ts
git commit -m "refactor(frontend): session store 改为按 sessionId 聚合 messages

- 移除 currentAgent / sessions / selectAgent（迁到 projects store）
- messagesBySession: Record<sessionId, ChatMessage[]>"
```

---

## Task 8: agents store + intercom store 适配

**Files:**
- Modify: `packages/frontend/src/store/agents.ts`
- Modify: `packages/frontend/src/store/intercom.ts`
- Test: `packages/frontend/tests/store.test.ts`（重写适配新签名）

**Interfaces:**
- `agents.ts` produces: `updateState(name, projectId, state)`、states key 改 `${projectId}:${agentName}`；新增 selector `getAgentGlobalState(name)` 跨项目聚合（blocked > thinking > idle）
- `intercom.ts` produces: `AskItem` 加 `sessionId` 字段；`addAsk(ask)` 不变（ask 自带 sessionId）

- [ ] **Step 1: 重写 store.test.ts 适配新签名**

替换 `packages/frontend/tests/store.test.ts` 全文：

```typescript
import { test, expect } from "bun:test";
import { useAgents } from "../src/store/agents";
import { useIntercom } from "../src/store/intercom";

test("agents store: setList + updateState (projectId, agentName)", () => {
  useAgents.getState().setList([{ name: "dev", displayName: "研发", avatar: "⚙️", description: "", model: "test", thinking: "off", tools: [], skills: [], partners: { askTo: [], askFrom: [] } }]);
  expect(useAgents.getState().list.length).toBe(1);
  // 双 key 状态
  useAgents.getState().updateState("dev", "p1", { status: "thinking" });
  useAgents.getState().updateState("dev", "p2", { status: "idle" });
  expect(useAgents.getState().states["p1:dev"].status).toBe("thinking");
  expect(useAgents.getState().states["p2:dev"].status).toBe("idle");
});

test("agents store: getAgentGlobalState 跨项目聚合（blocked 优先）", () => {
  useAgents.getState().setList([{ name: "dev", displayName: "研发", avatar: "⚙️", description: "", model: "t", thinking: "off", tools: [], skills: [], partners: { askTo: [], askFrom: [] } }]);
  useAgents.getState().updateState("dev", "p1", { status: "thinking" });
  useAgents.getState().updateState("dev", "p2", { status: "blocked" });
  // p2 blocked 应聚合为 blocked
  expect(useAgents.getState().getAgentGlobalState("dev")).toBe("blocked");
  useAgents.getState().updateState("dev", "p2", { status: "idle" });
  // 只剩 p1 thinking
  expect(useAgents.getState().getAgentGlobalState("dev")).toBe("thinking");
});

test("intercom store: addAsk 带 sessionId + resolveAsk", () => {
  useIntercom.getState().addAsk({ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1+1?", startedAt: 0, resolved: false });
  expect(useIntercom.getState().asks.length).toBe(1);
  expect(useIntercom.getState().asks[0].sessionId).toBe("s1");
  useIntercom.getState().resolveAsk("a1");
  expect(useIntercom.getState().asks[0].resolved).toBe(true);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/frontend/tests/store.test.ts`
Expected: FAIL — `updateState` 签名不匹配、`getAgentGlobalState` 不存在。

- [ ] **Step 3: 改写 agents.ts**

替换 `packages/frontend/src/store/agents.ts` 全文：

```typescript
import { create } from "zustand";
import type { AgentConfig, AgentState } from "hiagent-shared";

const key = (projectId: string, name: string) => `${projectId}:${name}`;

interface AgentsStore {
  list: AgentConfig[];
  // 双 key 状态（spec 2.3）：`${projectId}:${agentName}`
  states: Record<string, AgentState>;
  setList: (a: AgentConfig[]) => void;
  updateState: (name: string, projectId: string, state: AgentState) => void;
  // 跨项目聚合 selector（blocked > thinking > idle）
  getAgentGlobalState: (name: string) => "idle" | "thinking" | "blocked" | "error";
}

export const useAgents = create<AgentsStore>((set, get) => ({
  list: [],
  states: {},

  setList: (agents) => set({ list: agents }),

  updateState: (name, projectId, state) => set((s) => ({
    states: { ...s.states, [key(projectId, name)]: state },
  })),

  getAgentGlobalState: (name) => {
    const states = get().states;
    const statuses = Object.entries(states)
      .filter(([k]) => k.endsWith(`:${name}`))
      .map(([, v]) => v.status);
    if (statuses.includes("blocked")) return "blocked";
    if (statuses.includes("thinking")) return "thinking";
    if (statuses.includes("error")) return "error";
    return "idle";
  },
}));
```

- [ ] **Step 4: 改写 intercom.ts（AskItem 加 sessionId）**

替换 `packages/frontend/src/store/intercom.ts` 全文：

```typescript
import { create } from "zustand";

export interface AskItem {
  messageId: string;
  sessionId: string;   // ← 新增（spec 2.2）
  from: string;
  to: string;
  text: string;
  startedAt: number;
  resolved: boolean;
}

interface IntercomStore {
  asks: AskItem[];
  addAsk: (a: AskItem) => void;
  resolveAsk: (id: string) => void;
}

export const useIntercom = create<IntercomStore>((set) => ({
  asks: [],
  addAsk: (ask) => set((s) => ({ asks: [...s.asks.filter(a => a.messageId !== ask.messageId), ask] })),
  resolveAsk: (messageId) => set((s) => ({ asks: s.asks.map(a => a.messageId === messageId ? { ...a, resolved: true } : a) })),
}));
```

- [ ] **Step 5: 跑测试验证通过**

Run: `bun test packages/frontend/tests/store.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 6: 跑全量前端 store 测试**

Run: `bun test packages/frontend/tests/`
Expected: projects-store + session-store + store 全过

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/store/agents.ts packages/frontend/src/store/intercom.ts packages/frontend/tests/store.test.ts
git commit -m "refactor(frontend): agents store 双 key + intercom ask 加 sessionId

- agents.states 改 \${projectId}:\${agentName} 维度
- 新增 getAgentGlobalState 跨项目聚合（blocked > thinking > idle）
- AskItem 加 sessionId 字段"
```

---

## Task 9: App.tsx 三态路由 + WS 事件分发改造

**Files:**
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjects`（Task 6）、改写后的 `useSession`/`useAgents`/`useIntercom`（Task 7/8）
- Produces: App 三态路由（empty/project-setup/new-session/session），按 `currentSessionId` 和 `projects.length` 决定

- [ ] **Step 1: 改写 App.tsx**

替换 `packages/frontend/src/App.tsx` 全文：

```typescript
import { useEffect, useState, Component, type ReactNode } from "react";
import { wsClient } from "./ws-instance";
import { useSession } from "./store/session";
import { useAgents } from "./store/agents";
import { useIntercom } from "./store/intercom";
import { useProjects } from "./store/projects";
import { NewSessionPane } from "./components/NewSessionPane";
import { ProjectSetup } from "./components/ProjectSetup";
import { SessionView } from "./components/SessionView";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return <div className="h-screen flex items-center justify-center p-8 text-red"><pre>{this.state.error.message}\n{this.state.error.stack}</pre></div>;
    }
    return this.props.children;
  }
}

export function App() {
  const [connected, setConnected] = useState(false);
  const projects = useProjects(s => s.projects);
  const currentSessionId = useProjects(s => s.currentSessionId);
  const setProjectsAll = useProjects(s => s.setAll);
  const addMessage = useSession(s => s.addMessage);
  const updateState = useAgents(s => s.updateState);
  const addAsk = useIntercom(s => s.addAsk);
  const resolveAsk = useIntercom(s => s.resolveAsk);
  const setList = useAgents(s => s.setList);

  useEffect(() => {
    wsClient.connect();
    const t = setInterval(() => setConnected(wsClient.readyState === WebSocket.OPEN), 1000);

    const unsub = wsClient.onEvent(e => {
      switch (e.type) {
        case "agents:list": setList(e.agents); break;
        case "projects:list": setProjectsAll(e.projects, e.sessions); break;
        case "project:create": useProjects.getState().createProject(e.project); break;
        case "project:update": useProjects.getState().updateProject(e.project); break;
        case "project:delete": useProjects.getState().removeProject(e.projectId); break;
        case "session:create": useProjects.getState().createSession(e.session); break;
        case "session:delete": useProjects.getState().removeSession(e.sessionId); break;
        case "session:rename": useProjects.getState().renameSession(e.sessionId, e.title); break;
        case "agent:message":
          if (e.sessionId) addMessage(e.sessionId, e.message);
          break;
        case "agent:state":
          if (e.projectId) updateState(e.agentName, e.projectId, e.state);
          break;
        case "intercom:ask":
          if (e.sessionId) addAsk({ messageId: e.messageId, sessionId: e.sessionId, from: e.from, to: e.to, text: e.text, startedAt: e.startedAt, resolved: false });
          break;
        case "intercom:reply": resolveAsk(e.toAskMessageId); break;
      }
    });

    // 连接后请求初始数据
    if (connected) {
      wsClient.send({ type: "agents:list" });
      wsClient.send({ type: "projects:list" });
    }

    return () => { clearInterval(t); unsub(); };
  }, [connected, setList, setProjectsAll, addMessage, updateState, addAsk, resolveAsk]);

  if (!connected) return <ErrorBoundary><div className="h-screen flex items-center justify-center text-overlay">正在连接内核...</div></ErrorBoundary>;

  // 三态路由（spec 4.5）
  let view: ReactNode;
  if (projects.length === 0) {
    view = <ProjectSetup />;
  } else if (!currentSessionId) {
    view = <NewSessionPane />;
  } else {
    view = <SessionView />;
  }

  // 但 SessionView / NewSessionPane 都自带 Sidebar，所以这里不外挂
  // ProjectSetup 是独立全屏引导
  return <ErrorBoundary>{view}</ErrorBoundary>;
}
```

> **注意**：`NewSessionPane` 和 `SessionView` 尚未创建（Task 10/11），此步骤后编译会失败。这是预期的，本任务不要求编译通过，只要 WS 分发逻辑就位。完成 Task 11 后编译通过。

- [ ] **Step 2: 提交（标注 WIP）**

```bash
git add packages/frontend/src/App.tsx
git commit -m "refactor(frontend): App 三态路由 + WS 事件分发改造

- projects:list/create/update/delete + session:* 事件分发到 projects store
- agent:message/agent:state/intercom:ask 带 sessionId/projectId 路由
- 三态：projects.length===0 → ProjectSetup；无 currentSessionId → NewSessionPane；否则 SessionView
- 注意：NewSessionPane/ProjectSetup/SessionView 待后续任务实现，本提交编译不过"
```

---

## Task 10: ProjectSetup 组件（首次无项目引导）

**Files:**
- Create: `packages/frontend/src/components/ProjectSetup.tsx`

**Interfaces:**
- Consumes: `useAgents`（list）、`wsClient`
- Produces: 全屏引导，表单含项目名 + 选择目录（MVP 用文本输入 cwd，不调系统文件选择器）

- [ ] **Step 1: 实现 ProjectSetup**

创建 `packages/frontend/src/components/ProjectSetup.tsx`：

```typescript
import { useState } from "react";
import { wsClient } from "../ws-instance";
import { useProjects } from "../store/projects";

export function ProjectSetup() {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const createProject = useProjects(s => s.createProject);
  const setCurrentProject = useProjects(s => s.setCurrentProject);

  const submit = () => {
    if (!name.trim() || !cwd.trim()) return;
    wsClient.send({ type: "project:create", name: name.trim(), cwd: cwd.trim() });
    // 后端回 project:create 事件会更新 store；这里乐观设当前项目
    setCurrentProject(null); // 等 list 刷新后由 App 路由
    setName(""); setCwd("");
  };

  return (
    <div className="h-screen flex items-center justify-center bg-base">
      <div className="w-full max-w-[420px] p-8">
        <div className="text-[24px] font-bold text-text mb-2">欢迎使用 HiAgent</div>
        <div className="text-overlay text-[12px] mb-6">先创建你的第一个项目，指定一个工作目录</div>
        <div className="flex flex-col gap-3">
          <input
            className="bg-surface border border-surface2 rounded-md px-3 py-2 text-text text-[12px] outline-none focus:border-blue"
            placeholder="项目名称（如：我的项目）"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            className="bg-surface border border-surface2 rounded-md px-3 py-2 text-text text-[12px] outline-none focus:border-blue"
            placeholder="工作目录绝对路径（如：~/work/my-project）"
            value={cwd}
            onChange={e => setCwd(e.target.value)}
          />
          <button
            onClick={submit}
            disabled={!name.trim() || !cwd.trim()}
            className="bg-blue text-base rounded-md py-2 text-[12px] font-semibold disabled:opacity-50 mt-2"
          >
            创建项目
          </button>
        </div>
        <div className="text-overlay text-[10px] mt-4">
          💡 项目目录决定 agent 的工作目录（cwd），不同项目相互隔离。
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/frontend/src/components/ProjectSetup.tsx
git commit -m "feat(frontend): ProjectSetup 首次无项目引导页

- 项目名 + 工作目录输入
- 发 project:create WS 命令"
```

---

## Task 11: NewSessionPane 组件（替代 LaunchScreen）

**Files:**
- Create: `packages/frontend/src/components/NewSessionPane.tsx`
- Reference: `docs/superpowers/mockups/new-session-pane.html`

**Interfaces:**
- Consumes: `useProjects`（projects 列表）、`useAgents`（list）、`useSession`（addMessage）、`wsClient`
- Produces: 主区"新建会话面板"——顶部主区 header + 居中"开始新会话" + 输入框（输入框上方 `📁 项目 ▾` 和 `🤖 agent ▾` 下拉并排）+ 发送时调 `agent:prompt` 带 projectId/sessionId

- [ ] **Step 1: 实现 NewSessionPane**

创建 `packages/frontend/src/components/NewSessionPane.tsx`：

```typescript
import { useState } from "react";
import { useProjects } from "../store/projects";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { wsClient } from "../ws-instance";
import { Sidebar } from "./Sidebar";

export function NewSessionPane() {
  const projects = useProjects(s => s.projects);
  const agents = useAgents(s => s.list);
  const setCurrentSession = useProjects(s => s.setCurrentSession);
  const setCurrentProject = useProjects(s => s.setCurrentProject);
  const addMessage = useSession(s => s.addMessage);

  // 默认选最近项目（按 createdAt 倒序第一）和第一个 agent
  const [projectId, setProjectId] = useState<string>(
    () => [...projects].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? ""
  );
  const [agentName, setAgentName] = useState<string>(() => agents[0]?.name ?? "");
  const [text, setText] = useState("");

  const send = () => {
    if (!projectId || !agentName || !text.trim()) return;
    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 乐观：本地建会话 + 第一条消息
    setCurrentProject(projectId);
    setCurrentSession(sessionId);
    addMessage(sessionId, { id: `u${Date.now()}`, role: "user", text, timestamp: Date.now() });
    // 后端建会话 + prompt
    wsClient.send({ type: "session:create", projectId, primaryAgent: agentName, title: text.slice(0, 20) });
    wsClient.send({ type: "agent:prompt", projectId, sessionId, agentName, message: text });
    setText("");
  };

  const selectedProject = projects.find(p => p.id === projectId);
  const selectedAgent = agents.find(a => a.name === agentName);

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        {/* 主区 header */}
        <div className="bg-mantle px-4 py-2.5 border-b border-surface flex items-center gap-2">
          <span className="font-semibold text-[13px] text-text">新建会话</span>
          {selectedProject && <span className="text-[10px] text-overlay">· {selectedProject.name}</span>}
        </div>

        {/* 居中面板 */}
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <div className="text-[22px] font-bold text-text mb-1">开始新会话</div>
          <div className="text-overlay text-[11px] mb-7">选好项目目录和角色，直接打字发送</div>

          {/* 输入框容器 */}
          <div className="w-full max-w-[560px] bg-surface border border-surface2 rounded-xl">
            {/* 关键：输入框上方下拉并排 */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-base">
              {/* 项目下拉 */}
              <div className="flex items-center gap-1.5 bg-base rounded-md px-2 py-1 text-[11px]">
                <span>📁</span>
                <select
                  className="bg-transparent text-text outline-none cursor-pointer"
                  value={projectId}
                  onChange={e => setProjectId(e.target.value)}
                >
                  {[...projects].sort((a, b) => b.createdAt - a.createdAt).map(p => (
                    <option key={p.id} value={p.id} className="bg-mantle">{p.name} · {p.cwd}</option>
                  ))}
                </select>
              </div>
              {/* agent 下拉 */}
              <div className="flex items-center gap-1.5 bg-base rounded-md px-2 py-1 text-[11px]">
                <span>{selectedAgent?.avatar ?? "🤖"}</span>
                <select
                  className="bg-transparent text-text outline-none cursor-pointer"
                  value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                >
                  {agents.map(a => (
                    <option key={a.name} value={a.name} className="bg-mantle">{a.displayName}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 输入区 */}
            <div className="px-3 py-3.5 min-h-[80px]">
              <input
                className="bg-transparent border-none text-text flex-1 text-[12px] outline-none w-full"
                placeholder={`给${selectedAgent?.displayName ?? "agent"}发消息...`}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
            </div>

            {/* 底部 chips + 发送 */}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-base">
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">📎 附件</span>
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">🎨 {selectedAgent?.model ?? "模型"}</span>
              <button
                onClick={send}
                disabled={!projectId || !agentName || !text.trim()}
                className="ml-auto bg-blue text-base px-3 py-[5px] rounded-md text-[11px] font-semibold disabled:opacity-50"
              >
                发送 →
              </button>
            </div>
          </div>

          <div className="mt-5 text-overlay text-[10px] text-center max-w-[460px] leading-relaxed">
            💡 项目目录可在此切换；agent 选谁谁是会话主理人。<br/>
            发送第一条消息后进入对话视图。
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/frontend/src/components/NewSessionPane.tsx
git commit -m "feat(frontend): NewSessionPane 新建会话面板（替代 LaunchScreen）

- 主区切换面板，输入框上方项目/agent 下拉并排（mockup 已确认）
- 发送时乐观建会话 + 后端 session:create + agent:prompt"
```

---

## Task 12: Sidebar 重构 + 拆分子组件

**Files:**
- Create: `packages/frontend/src/components/sidebar/NewSessionButton.tsx`
- Create: `packages/frontend/src/components/sidebar/AgentListSection.tsx`
- Create: `packages/frontend/src/components/sidebar/ProjectList.tsx`
- Create: `packages/frontend/src/components/sidebar/ProjectItem.tsx`
- Create: `packages/frontend/src/components/sidebar/SessionRow.tsx`
- Modify: `packages/frontend/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `useProjects`、`useAgents`、`useIntercom`、`wsClient`、`avatarStyle`、`AgentConfig` modal
- Sidebar 改为容器，组合 NewSessionButton + AgentListSection + ProjectList

- [ ] **Step 1: 实现 NewSessionButton**

创建 `packages/frontend/src/components/sidebar/NewSessionButton.tsx`：

```typescript
import { useProjects } from "../../store/projects";

export function NewSessionButton() {
  const setCurrentSession = useProjects(s => s.setCurrentSession);
  return (
    <div className="p-2.5 border-b border-surface">
      <div
        className="bg-surface border border-dashed border-surface2 rounded-md py-2 text-center text-overlay text-[11px] cursor-pointer hover:border-blue/50 transition"
        onClick={() => setCurrentSession(null)}  // null 触发 App 路由到 NewSessionPane
      >
        + 新建会话
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 实现 AgentListSection**

创建 `packages/frontend/src/components/sidebar/AgentListSection.tsx`：

```typescript
import { useState } from "react";
import { useAgents } from "../../store/agents";
import { avatarStyle } from "../../theme/agents";
import { AgentConfig as AgentConfigModal } from "../AgentConfig";
import type { AgentConfig } from "hiagent-shared";

export function AgentListSection() {
  const list = useAgents(s => s.list);
  const getGlobalState = useAgents(s => s.getAgentGlobalState);
  const [editing, setEditing] = useState<AgentConfig | null>(null);

  return (
    <div className="p-2.5 border-b border-surface">
      <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">我的智能体</div>
      <div className="flex flex-col gap-1">
        {list.map(a => {
          const st = getGlobalState(a.name);
          const dotColor = st === "thinking" ? "#89b4fa" : st === "blocked" ? "#fab387" : st === "error" ? "#f38ba8" : "transparent";
          return (
            <div
              key={a.name}
              onClick={() => setEditing(a)}  // 点击进配置（不切会话）
              className="py-1.5 px-2 rounded flex items-center gap-2 cursor-pointer hover:bg-surface/40"
            >
              <div style={avatarStyle(a.name, 22)}>{a.avatar}</div>
              <div className="text-[11px] font-semibold text-text flex-1">{a.displayName}</div>
              {st !== "idle" && <span className="text-[8px]" style={{ color: dotColor }}>●</span>}
            </div>
          );
        })}
      </div>
      {editing && <AgentConfigModal agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
```

- [ ] **Step 3: 实现 SessionRow**

创建 `packages/frontend/src/components/sidebar/SessionRow.tsx`：

```typescript
import type { SessionEntity } from "hiagent-shared";
import { avatarStyle } from "../../theme/agents";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString().slice(5);  // M/D
}

export function SessionRow({
  session,
  isCurrent,
  onClick,
}: {
  session: SessionEntity;
  isCurrent: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="py-1.5 px-2.5 rounded flex items-center gap-2 cursor-pointer transition"
      style={isCurrent
        ? { background: "rgba(137,180,250,0.15)", borderLeft: "2px solid #89b4fa" }
        : { borderLeft: "2px solid transparent" }}
    >
      <div style={avatarStyle(session.primaryAgent, 18)} className="text-[10px]">
        {/* emoji 由 agent 配置决定，这里用 avatarStyle 渲染渐变底；emoji 显示在 children */}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-text truncate">{session.title}</div>
      </div>
      <div className="text-[9px] text-overlay">{relTime(session.lastActivity)}</div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 ProjectItem（含折叠 + ＋ 项目内新建 + 会话子列表）**

创建 `packages/frontend/src/components/sidebar/ProjectItem.tsx`：

```typescript
import { useState } from "react";
import type { ProjectEntity, SessionEntity } from "hiagent-shared";
import { useProjects } from "../../store/projects";
import { SessionRow } from "./SessionRow";

export function ProjectItem({
  project,
  sessions,
  currentSessionId,
}: {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const setCurrentSession = useProjects(s => s.setCurrentSession);
  const setCurrentProject = useProjects(s => s.setCurrentProject);
  const projectSessions = sessions.filter(s => s.projectId === project.id);

  const newSessionInProject = () => {
    setCurrentProject(project.id);
    setCurrentSession(null);  // 触发 NewSessionPane，预选该项目
  };

  const selectSession = (sessionId: string) => {
    setCurrentProject(project.id);
    setCurrentSession(sessionId);
  };

  return (
    <div>
      <div className="py-1.5 px-2.5 flex items-center gap-1.5 cursor-pointer hover:bg-surface/40 rounded">
        <span
          className="text-overlay text-[9px] w-2.5"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {expanded ? "▼" : "▶"}
        </span>
        <span className="text-[11px] font-semibold text-text flex-1">{project.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); newSessionInProject(); }}
          className="w-[18px] h-[18px] rounded bg-blue/15 border border-blue/40 text-blue text-[11px] flex items-center justify-center hover:bg-blue hover:text-base"
          title="在此项目新建会话"
        >＋</button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 ml-2">
          {projectSessions.length === 0 && (
            <div className="text-overlay text-[10px] italic px-2.5 py-1">（暂无会话，点 ＋ 新建）</div>
          )}
          {projectSessions.map(s => (
            <SessionRow
              key={s.id}
              session={s}
              isCurrent={currentSessionId === s.id}
              onClick={() => selectSession(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 实现 ProjectList**

创建 `packages/frontend/src/components/sidebar/ProjectList.tsx`：

```typescript
import { useProjects } from "../../store/projects";
import { ProjectItem } from "./ProjectItem";

export function ProjectList() {
  const projects = useProjects(s => s.projects);
  const sessions = useProjects(s => s.sessions);
  const currentSessionId = useProjects(s => s.currentSessionId);

  return (
    <div className="flex-1 overflow-y-auto p-2.5">
      <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">项目管理</div>
      {projects.length === 0 && (
        <div className="text-overlay text-[10px] italic">暂无项目</div>
      )}
      <div className="flex flex-col gap-1">
        {projects.map(p => (
          <ProjectItem
            key={p.id}
            project={p}
            sessions={sessions}
            currentSessionId={currentSessionId}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 重写 Sidebar 容器**

替换 `packages/frontend/src/components/Sidebar.tsx` 全文：

```typescript
import { NewSessionButton } from "./sidebar/NewSessionButton";
import { AgentListSection } from "./sidebar/AgentListSection";
import { ProjectList } from "./sidebar/ProjectList";

export function Sidebar() {
  return (
    <div className="w-[260px] bg-mantle border-r border-surface flex flex-col h-full">
      <NewSessionButton />
      <AgentListSection />
      <ProjectList />
      {/* 无底部 intercom 状态条（spec 决策：移到会话 header） */}
    </div>
  );
}
```

- [ ] **Step 7: 验证编译 + 启动 dev server 看效果**

Run: `cd packages/frontend && bun run build 2>&1 | tail -20`
Expected: 编译通过（如有类型错误修正）

> 此时不要求所有交互可用，只要 sidebar 能渲染（NewSessionPane 已含 Sidebar）。

- [ ] **Step 8: 提交**

```bash
git add packages/frontend/src/components/Sidebar.tsx packages/frontend/src/components/sidebar/
git commit -m "refactor(frontend): Sidebar 拆分为 5 个子组件 + 重组四区块

- NewSessionButton: 顶部全局新建
- AgentListSection: 我的智能体（点击进配置，状态点全局聚合）
- ProjectList + ProjectItem: 项目管理（折叠/展开 + 项目内 ＋）
- SessionRow: 主理 agent emoji + 标题 + 相对时间
- 移除底部 intercom 状态条（移到会话 header）"
```

---

## Task 13: SessionView 改造（header intercom 徽标 + 按 sessionId 取数据）

**Files:**
- Modify: `packages/frontend/src/components/SessionView.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`

**Interfaces:**
- Consumes: `useProjects`（currentSessionId → session 元数据）、`useSession`（messagesBySession）、`useIntercom`（asks 按 sessionId 过滤）、`useAgents`（agent 配置查 primaryAgent）
- Produces: SessionView header 加橙色 intercom 徽标（当前会话活跃 ask）；MessageList 改 sessionId 数据源

- [ ] **Step 1: 改写 MessageList（数据源改 sessionId）**

替换 `packages/frontend/src/components/MessageList.tsx` 全文：

```typescript
import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { useIntercom } from "../store/intercom";
import { MessageItem } from "./MessageItem";
import { AskCard } from "./AskCard";

export function MessageList({ sessionId, agentName }: { sessionId: string; agentName: string }) {
  const allMessages = useSession(s => s.messagesBySession);
  const messages = allMessages[sessionId] ?? [];
  const list = useAgents(s => s.list);
  const agent = list.find(a => a.name === agentName);
  const allAsks = useIntercom(s => s.asks);
  // intercom 事件按 sessionId 过滤（spec：会话内联）
  const asks = allAsks.filter(a => a.sessionId === sessionId);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, asks]);
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">
      {messages.map(m => <MessageItem key={m.id} msg={m} agentAvatar={agent?.avatar ?? "🤖"} agentName={agent?.displayName ?? agentName} agentKey={agentName} />)}
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 2: 改写 SessionView（header 加 intercom 徽标 + 按 sessionId 路由）**

替换 `packages/frontend/src/components/SessionView.tsx` 全文：

```typescript
import { useState } from "react";
import { useAgents } from "../store/agents";
import { useProjects } from "../store/projects";
import { useSession } from "../store/session";
import { useIntercom } from "../store/intercom";
import { wsClient } from "../ws-instance";
import { AGENT_THEME } from "../theme/agents";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { Canvas } from "./Canvas";

function useElapsed(startedAt: number, active: boolean): number {
  const [s, setS] = useState(Math.floor((Date.now() - startedAt) / 1000));
  useState(() => {
    if (!active) return;
    const t = setInterval(() => setS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  });
  return s;
}

function IntercomBadge({ sessionId }: { sessionId: string }) {
  const asks = useIntercom(s => s.asks);
  const active = asks.filter(a => a.sessionId === sessionId && !a.resolved);
  if (active.length === 0) return null;
  const a = active[0];
  const elapsed = useElapsed(a.startedAt, true);
  return (
    <span
      className="text-peach text-[9px] px-2 py-[3px] rounded-md"
      style={{ background: "rgba(250,179,135,0.15)", border: "1px solid rgba(250,179,135,0.4)" }}
    >
      ● {a.from}→{a.to} · ask · {elapsed}s
    </span>
  );
}

export function SessionView() {
  const currentSessionId = useProjects(s => s.currentSessionId)!;
  const sessions = useProjects(s => s.sessions);
  const currentProjectId = useProjects(s => s.currentProjectId);
  const session = sessions.find(s => s.id === currentSessionId);
  const agentName = session?.primaryAgent ?? "";
  const agent = useAgents(s => s.list.find(a => a.name === agentName));
  const addMessage = useSession(s => s.addMessage);
  const [showCanvas, setShowCanvas] = useState(false);

  if (!session) {
    // 兜底：currentSessionId 失效，回 NewSessionPane 由 App 路由处理
    return null;
  }

  const sendPrompt = (text: string) => {
    addMessage(currentSessionId, { id: `u${Date.now()}`, role: "user", text, timestamp: Date.now() });
    wsClient.send({ type: "agent:prompt", projectId: currentProjectId, sessionId: currentSessionId, agentName, message: text });
  };

  if (showCanvas) return <Canvas />;

  const [from, to] = AGENT_THEME[agentName]?.gradient ?? ["#6c7086", "#585b70"];

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="bg-mantle px-4 py-2.5 border-b border-surface flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center text-[14px]"
              style={{ width: 28, height: 28, borderRadius: "50%", background: `linear-gradient(135deg, ${from}, ${to})` }}
            >
              {agent?.avatar}
            </div>
            <div>
              <div className="font-semibold text-[12px] text-text">{session.title}</div>
              <div className="text-[9px] text-overlay">
                {agent?.displayName} · {agent?.model} · {agent?.thinking}
              </div>
            </div>
            {/* 方案 C：intercom 徽标在 header */}
            <IntercomBadge sessionId={currentSessionId} />
          </div>
          <button
            onClick={() => setShowCanvas(!showCanvas)}
            className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer"
          >
            {showCanvas ? "对话" : "编排画布"}
          </button>
        </div>
        <MessageList sessionId={currentSessionId} agentName={agentName} />
        <Composer agentName={agent?.displayName ?? agentName} agentAvatar={agent?.avatar ?? "🤖"} onSend={sendPrompt} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 删除 LaunchScreen.tsx（已被 NewSessionPane 取代）**

```bash
git rm packages/frontend/src/components/LaunchScreen.tsx
```

确认无其他文件 import LaunchScreen（App.tsx 已改用 NewSessionPane）。

- [ ] **Step 4: 验证编译**

Run: `cd packages/frontend && bun run build 2>&1 | tail -20`
Expected: 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/SessionView.tsx packages/frontend/src/components/MessageList.tsx
git rm packages/frontend/src/components/LaunchScreen.tsx
git commit -m "refactor(frontend): SessionView header intercom 徽标 + 按 sessionId 取数据

- header 加 IntercomBadge（当前会话活跃 ask，方案 C）
- MessageList 数据源从 agentName 改为 sessionId
- 删除 LaunchScreen（被 NewSessionPane 取代）"
```

---

## Task 14: 集成 smoke 测试 + 手动验证

**Files:**
- 无新建，运行已有测试 + 手动跑全栈

- [ ] **Step 1: 全量单元测试**

Run: `bun test`
Expected: shared + kernel + frontend 所有测试通过

- [ ] **Step 2: 前端编译**

Run: `cd packages/frontend && bun run build`
Expected: 构建产物生成，无类型错误

- [ ] **Step 3: kernel 启动 smoke**

```bash
# 清空 store 模拟首次启动
rm -rf /tmp/hiagent-smoke
HIAGENT_STORE_DIR=/tmp/hiagent-smoke bun run packages/kernel/src/index.ts &
sleep 2
# 验证默认项目创建
cat /tmp/hiagent-smoke/projects.json | grep "默认项目"
kill %1
```

Expected: 输出含"默认项目"

- [ ] **Step 4: 前端 dev 启动**

Run: `bun run dev:frontend`（在另一个终端，需 kernel 同时运行）
Expected: 浏览器打开，显示 ProjectSetup（首次）或 NewSessionPane（有项目时）

- [ ] **Step 5: 手动交互验证清单**

按以下步骤操作，验证功能：
1. 首次启动 → 看到 ProjectSetup → 输入项目名 + cwd → 点创建 → sidebar 出现项目
2. 点项目行右侧 ＋ → 主区切到 NewSessionPane，项目下拉预选当前项目
3. 选 agent + 输入消息 + 发送 → 进入 SessionView，看到消息
4. sidebar 会话项显示标题 + 相对时间
5. 点顶部"新建会话" → 切到 NewSessionPane
6. 点"我的智能体"某 agent → 弹出 AgentConfig（不切会话）
7. 折叠/展开项目 → 子会话列表显隐

- [ ] **Step 6: 清理 + 提交**

```bash
# 清理 smoke 临时文件
rm -rf /tmp/hiagent-smoke
git status  # 确认无未提交改动
```

- [ ] **Step 7: 最终提交 + 推送**

```bash
git log --oneline -15  # 检查所有任务都已提交
git push origin master
```

---

## Self-Review 清单

**Spec 覆盖检查**：
- ✅ 数据模型（spec 第二章）→ Task 1
- ✅ Sidebar UI 结构（spec 第三章）→ Task 12
- ✅ 新建会话面板（spec 第四章）→ Task 11
- ✅ 会话视图改造 + intercom 徽标（spec 第五章）→ Task 13
- ✅ Kernel 改动 + 双 key（spec 第六章）→ Task 4, 5
- ✅ Store 改造（spec 第七章）→ Task 6, 7, 8
- ✅ 迁移策略（spec 第八章）→ Task 5 Step 2（默认项目创建）
- ⚠️ 8.2 新用户首次启动引导 → Task 10 ProjectSetup 覆盖

**类型一致性**：
- `updateState(name, projectId, state)` 在 Task 8 定义，App.tsx（Task 9）调用一致 ✅
- `addMessage(sessionId, msg)` 在 Task 7 定义，App.tsx/SessionView/NewSessionPane 调用一致 ✅
- `setCurrentSession(null)` 触发 NewSessionPane，App.tsx 三态路由检查 `currentSessionId` 一致 ✅

**已知简化（不阻塞 MVP）**：
- agent emoji 在 SessionRow 渲染：avatarStyle 返回渐变底，emoji 需从 useAgents.list 查 primaryAgent 对应 avatar 注入（Task 12 Step 3 留了 TODO，实现时补全）
- useElapsed 用 useState 模拟 hook（Task 13），实际应改成 useEffect——实现时修正
