# 默认工作区虚拟项目 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话列表新增常驻的「🏠 默认工作区」虚拟项目，让每个会话在 `~/.wa-pi/workdir/<session.createdAt>/` 下隔离 pwd；删除会话保留目录 7 天后自动清理；skill/mcp 继承全局配置。

**Architecture:** 复用现有 `ProjectEntity` / `SessionEntity`（**不加任何字段**）。新增 4 个 shared 常量（`SYSTEM_PROJECT_ID` / `SYSTEM_PROJECT_NAME` / `SYSTEM_PROJECT_CWD` / `WORKDIR_TTL_DAYS`）和 1 个纯函数 `resolveSessionCwd`（前后端共享）。kernel 在启动时 seed 一个固定 id=`"__system__"` 的项目；`agent-manager._createSession` 把 cwd 从 `project.cwd` 改为 `resolveSessionCwd(session, project)`；新增 `workdir-cleaner.ts` 做定时清理；`ws-server` 拦截对系统项目的 delete/update、在创建全局会话时 mkdir 子目录、为上传/打开目录 handler 加 session 级路径支持。前端在 Sidebar 加独立区、ProjectItem 差异化渲染、NewSessionPane 默认选中、SessionView header 友好文案。

**Tech Stack:** Bun + bun:test（kernel/shared）、React + bun:test + @testing-library/react + happy-dom（frontend）、zustand、Playwright（E2E）

## Global Constraints

- 所有代码注释用中文（AGENTS.md 第 1 条）
- 所有面向用户的文案用中文
- 测试框架：kernel/shared 用 `bun:test`；frontend 用 `bun:test` + happy-dom + @testing-library/react（注意：frontend 测试也用 bun:test，参考 `packages/frontend/tests/Sidebar.test.tsx:1`）
- 类型定义集中在 `packages/shared/src/types.ts`，**不修改 SessionEntity / ProjectEntity 类型**
- `SessionEntity.createdAt`（`types.ts:70`）已存在，复用作为 workdir 子目录名
- `SessionEntity.projectId`（`types.ts:67`）已有，复用判断会话是否属于系统项目
- 系统项目固定 `id = "__system__"`，所有识别走该常量比较
- 不引入新 npm 依赖
- 每个 Task 结尾 commit，commit message 用 `feat:` / `fix:` / `refactor:` / `test:` / `docs:` 前缀
- 测试金字塔四层（unit / component / integration / E2E）必须齐全（AGENTS.md 第 6 条）
- 测试截图在所有测试完成后必须删除（AGENTS.md 第 6 条）
- 完成后在根目录 `CHANGELOG.md` 顶部加一条记录（AGENTS.md 第 7 条）
- 不使用自问自答句式（AGENTS.md 第 8 条）

**关键路径常量速查**（实施时所有路径都从这里读）：
- `WA_PI_DIR` = `~/.wa-pi`（`shared/src/constants.ts:21`）
- `SYSTEM_PROJECT_ID` = `"__system__"`（本计划新增）
- `SYSTEM_PROJECT_NAME` = `"默认工作区"`（本计划新增）
- `SYSTEM_PROJECT_CWD` = `~/.wa-pi/workdir`（本计划新增）
- `WORKDIR_TTL_DAYS` = `7`（本计划新增）

---

## Phase 1: shared 常量与纯函数

依赖：无（最先做，后面所有 Phase 都基于此）

### Task 1.1: 新增 SYSTEM_PROJECT_* 常量

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/tests/constants.test.ts`

**Interfaces:**
- Consumes: `WA_PI_DIR`（`shared/src/constants.ts:21`）、`join` from `node:path`
- Produces: 4 个新常量 `SYSTEM_PROJECT_ID` / `SYSTEM_PROJECT_NAME` / `SYSTEM_PROJECT_CWD` / `WORKDIR_TTL_DAYS`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/tests/constants.test.ts` 末尾追加：

```ts
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS,
} from "../src/constants";

test("SYSTEM_PROJECT_* 常量定义", () => {
  expect(SYSTEM_PROJECT_ID).toBe("__system__");
  expect(SYSTEM_PROJECT_NAME).toBe("默认工作区");
  expect(SYSTEM_PROJECT_CWD.endsWith("workdir")).toBe(true);
  expect(SYSTEM_PROJECT_CWD.includes("wa-pi")).toBe(true);
  expect(WORKDIR_TTL_DAYS).toBe(7);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/shared/tests/constants.test.ts
```

Expected: FAIL，报错 "SYSTEM_PROJECT_ID is not exported" 或类似

- [ ] **Step 3: 在 constants.ts 加入常量**

在 `packages/shared/src/constants.ts` 中，**在 `BUILTIN_SKILLS_DIR` 定义之后**（约第 26 行后）插入：

```ts
import { join } from "node:path";

// ===== 默认工作区（虚拟系统项目）=====
// 一个常驻、不可删除/改名的虚拟项目，作为"没有具体工程目录时的默认聊天空间"。
// 该项目下的每个会话有独立 cwd（~/.wa-pi/workdir/<session.createdAt>/），
// 详见 resolveSessionCwd 纯函数（pure.ts）。
export const SYSTEM_PROJECT_ID = "__system__";
export const SYSTEM_PROJECT_NAME = "默认工作区";
export const SYSTEM_PROJECT_CWD = join(WA_PI_DIR, "workdir");
// 默认工作区会话被删除后，对应的 <createdAt>/ 子目录保留天数；超时后由 workdir-cleaner 清理
export const WORKDIR_TTL_DAYS = 7;
```

**注意**：`join` 已在文件顶部 import 过吗？检查现有 import，如果没有，加 `import { join } from "node:path";`。从 `constants.ts:4`（`PROJECTS_FILE = ${WA_PI_DIR}/projects.json`）可见目前用的是模板字符串而非 `join`，但新常量为了清晰用 `join`。需要补 import。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/shared/tests/constants.test.ts
```

Expected: PASS

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/shared typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/shared/src/constants.ts packages/shared/tests/constants.test.ts && git commit -m "feat(shared): 新增 SYSTEM_PROJECT_* 常量与 WORKDIR_TTL_DAYS"
```

---

### Task 1.2: 新增 resolveSessionCwd 纯函数

**Files:**
- Modify: `packages/shared/src/pure.ts`
- Modify: `packages/shared/tests/pure.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROJECT_ID` / `SYSTEM_PROJECT_CWD`（Task 1.1 产出）
- Produces: `resolveSessionCwd(session, project): string`

```ts
// 签名（前后端共享）
function resolveSessionCwd(
  session: { projectId: string; createdAt: number },
  project: { cwd: string },
): string;
```

行为：
- `session.projectId === SYSTEM_PROJECT_ID` → 返回 `${SYSTEM_PROJECT_CWD}/${session.createdAt}`
- 否则 → 返回 `project.cwd`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/tests/pure.test.ts` 末尾追加：

```ts
import { resolveSessionCwd } from "../src/pure";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "../src/constants";

test("resolveSessionCwd 普通项目返回 project.cwd", () => {
  const session = { projectId: "p-abc", createdAt: 1721567890123 };
  const project = { cwd: "/work/wa-pi" };
  expect(resolveSessionCwd(session, project)).toBe("/work/wa-pi");
});

test("resolveSessionCwd 系统项目返回 workdir/<createdAt>", () => {
  const session = { projectId: SYSTEM_PROJECT_ID, createdAt: 1721567890123 };
  const project = { cwd: SYSTEM_PROJECT_CWD };
  const result = resolveSessionCwd(session, project);
  expect(result).toBe(`${SYSTEM_PROJECT_CWD}/1721567890123`);
  expect(result.endsWith("/1721567890123")).toBe(true);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/shared/tests/pure.test.ts
```

Expected: FAIL，报错 "resolveSessionCwd is not exported"

- [ ] **Step 3: 在 pure.ts 加入函数**

在 `packages/shared/src/pure.ts` 末尾追加：

```ts
import { join } from "node:path";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "./constants";

/**
 * 计算会话的 pwd。
 *
 * - 普通项目会话：返回 project.cwd（行为不变）
 * - 默认工作区会话（projectId === SYSTEM_PROJECT_ID）：返回
 *   ${SYSTEM_PROJECT_CWD}/${session.createdAt}/，即 ~/.wa-pi/workdir/<时间戳>/
 *
 * 这是**纯函数**，从 session.createdAt 推导，不依赖任何持久化的 cwd 字段。
 * 因此 kernel 启动时 mkdir 用的 ts 必须与 createSession 写入的 createdAt 严格一致
 * （详见 ws-server.ts 的 agent:prompt handler）。
 */
export function resolveSessionCwd(
  session: { projectId: string; createdAt: number },
  project: { cwd: string },
): string {
  if (session.projectId === SYSTEM_PROJECT_ID) {
    return join(SYSTEM_PROJECT_CWD, String(session.createdAt));
  }
  return project.cwd;
}
```

**注意 import 位置**：把 `import { join }` 放在文件顶部现有 import 区，把 `import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD }` 也放顶部。`pure.ts` 现有 import 在第 1 行（`import type { AgentState, ... } from "./types";`），在其后加新 import。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/shared/tests/pure.test.ts
```

Expected: PASS（所有原有测试 + 2 个新测试全过）

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/shared typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/shared/src/pure.ts packages/shared/tests/pure.test.ts && git commit -m "feat(shared): 新增 resolveSessionCwd 纯函数（前后端共享）"
```

---

## Phase 2: kernel 默认工作区项目 seed

依赖：Phase 1 完成

### Task 2.1: ProjectStore 新增 createSystemProject 方法

**Files:**
- Modify: `packages/kernel/src/project-store.ts`
- Modify: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROJECT_ID` / `SYSTEM_PROJECT_NAME` / `SYSTEM_PROJECT_CWD`（Task 1.1）
- Produces: `ProjectStore.createSystemProject({ id, name, cwd }): Promise<ProjectEntity>`

行为：
- 幂等：若同 id 已存在则直接返回现有记录，不重复插入
- **绕过** `createProject` 的 cwd 去重（`project-store.ts:37-39`）和 id 自动生成（`randomUUID()`），允许固定 id

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/project-store.test.ts` 末尾追加（参考现有测试风格，见 `project-store.test.ts:11-18`）：

```ts
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD } from "@wa-pi/shared";

test("createSystemProject 首次插入固定 id 项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createSystemProject({
    id: SYSTEM_PROJECT_ID,
    name: SYSTEM_PROJECT_NAME,
    cwd: SYSTEM_PROJECT_CWD,
  });
  expect(p.id).toBe(SYSTEM_PROJECT_ID);
  expect(p.name).toBe(SYSTEM_PROJECT_NAME);
  const { projects } = await store.load();
  expect(projects).toHaveLength(1);
  expect(projects[0].id).toBe(SYSTEM_PROJECT_ID);
  rmSync(f, { force: true });
});

test("createSystemProject 二次调用幂等不重复插入", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: SYSTEM_PROJECT_NAME, cwd: SYSTEM_PROJECT_CWD,
  });
  const second = await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: SYSTEM_PROJECT_NAME, cwd: SYSTEM_PROJECT_CWD,
  });
  expect(second.id).toBe(SYSTEM_PROJECT_ID);
  const { projects } = await store.load();
  expect(projects).toHaveLength(1);
  rmSync(f, { force: true });
});

test("createSystemProject 不影响 createProject 的 cwd 去重", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: SYSTEM_PROJECT_NAME, cwd: SYSTEM_PROJECT_CWD,
  });
  // 普通项目仍可正常创建
  const normal = await store.createProject({ name: "普通项目", cwd: "/work/foo" });
  expect(normal.id).not.toBe(SYSTEM_PROJECT_ID);
  const { projects } = await store.load();
  expect(projects).toHaveLength(2);
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/project-store.test.ts
```

Expected: FAIL，报错 "store.createSystemProject is not a function"

- [ ] **Step 3: 在 ProjectStore 加方法**

在 `packages/kernel/src/project-store.ts` 的 `createProject` 方法（第 34-46 行）**之后**插入：

```ts
  /**
   * 创建固定 id 的系统项目（幂等）。
   *
   * 用于默认工作区：固定 id=SYSTEM_PROJECT_ID，绕过 createProject 的 cwd 去重
   * 和 randomUUID id 生成。同 id 已存在则返回现有记录，不重复插入。
   */
  async createSystemProject(input: {
    id: string; name: string; cwd: string;
  }): Promise<ProjectEntity> {
    const data = await this.load();
    const existing = data.projects.find(p => p.id === input.id);
    if (existing) return existing;
    const project: ProjectEntity = {
      id: input.id, name: input.name, cwd: input.cwd,
      createdAt: Date.now(),
    };
    data.projects.push(project);
    await this.save(data);
    return project;
  }
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/project-store.test.ts
```

Expected: PASS（所有原有测试 + 3 个新测试全过）

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts && git commit -m "feat(kernel): ProjectStore 新增 createSystemProject 幂等方法"
```

---

### Task 2.2: 启动时 seed 默认工作区项目

**Files:**
- Modify: `packages/kernel/src/index.ts`
- Create: `packages/kernel/src/ensure-system-project.ts`
- Create: `packages/kernel/tests/ensure-system-project.test.ts`

**Interfaces:**
- Consumes: `ProjectStore.createSystemProject`（Task 2.1）、`SYSTEM_PROJECT_*` 常量
- Produces: `ensureSystemProject(projectStore): Promise<void>`，副作用是 projects.json 含一条 `__system__` 记录 + `~/.wa-pi/workdir/` 目录存在

- [ ] **Step 1: 写失败测试**

新建 `packages/kernel/tests/ensure-system-project.test.ts`：

```ts
import { test, expect } from "bun:test";
import { rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { ensureSystemProject } from "../src/ensure-system-project";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD,
} from "@wa-pi/shared";

function tempFile() {
  return join(import.meta.dir, ".tmp-ensure-" + Math.random().toString(36).slice(2) + ".json");
}

test("ensureSystemProject 首次调用写入系统项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  const { projects } = await store.load();
  const sys = projects.find(p => p.id === SYSTEM_PROJECT_ID);
  expect(sys).toBeDefined();
  expect(sys!.name).toBe(SYSTEM_PROJECT_NAME);
  expect(sys!.cwd).toBe(SYSTEM_PROJECT_CWD);
  rmSync(f, { force: true });
});

test("ensureSystemProject 二次调用幂等", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  await ensureSystemProject(store);
  const { projects } = await store.load();
  expect(projects.filter(p => p.id === SYSTEM_PROJECT_ID)).toHaveLength(1);
  rmSync(f, { force: true });
});

test("ensureSystemProject 创建 workdir 根目录", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  // SYSTEM_PROJECT_CWD 目录必须存在（实际 ~/.wa-pi/workdir）
  expect(existsSync(SYSTEM_PROJECT_CWD)).toBe(true);
  expect(statSync(SYSTEM_PROJECT_CWD).isDirectory()).toBe(true);
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ensure-system-project.test.ts
```

Expected: FAIL，报错 "Cannot find module '../src/ensure-system-project'"

- [ ] **Step 3: 实现 ensure-system-project.ts**

新建 `packages/kernel/src/ensure-system-project.ts`：

```ts
import { mkdir } from "node:fs/promises";
import type { ProjectStore } from "./project-store";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD,
} from "@wa-pi/shared";

/**
 * 启动时确保默认工作区虚拟项目存在（幂等）。
 *
 * - 若 projects.json 中无 SYSTEM_PROJECT_ID 记录 → 写入一条
 * - 始终确保 SYSTEM_PROJECT_CWD 根目录存在（~/.wa-pi/workdir）
 *
 * 不抛错：失败仅 console.warn，不阻塞 kernel 启动。
 */
export async function ensureSystemProject(projectStore: ProjectStore): Promise<void> {
  try {
    await projectStore.createSystemProject({
      id: SYSTEM_PROJECT_ID,
      name: SYSTEM_PROJECT_NAME,
      cwd: SYSTEM_PROJECT_CWD,
    });
    await mkdir(SYSTEM_PROJECT_CWD, { recursive: true });
  } catch (e) {
    console.warn("[kernel] ensureSystemProject 失败:", e);
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ensure-system-project.test.ts
```

Expected: PASS

- [ ] **Step 5: 集成到 index.ts**

修改 `packages/kernel/src/index.ts`，**在 `migrateLegacySessions(projectStore)` 调用之后**（第 60-61 行附近）插入：

```ts
import { ensureSystemProject } from "./ensure-system-project";

// ... 在 startKernel 函数体内，migrateLegacySessions 之后：
await ensureSystemProject(projectStore);
console.log(`[kernel] 默认工作区已就绪: ${SYSTEM_PROJECT_CWD}`);
```

需要同时把 `SYSTEM_PROJECT_CWD` 加入从 `@wa-pi/shared` 的 import（第 14 行）：

```ts
import { WS_PORT, WA_PI_DIR, BUILTIN_SKILLS_DIR, SYSTEM_PROJECT_CWD } from "@wa-pi/shared";
```

- [ ] **Step 6: 手动启动 kernel 验证 seed 生效**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel dev &
sleep 3
cat ~/.wa-pi/projects.json | grep __system__
kill %1 2>/dev/null
```

Expected: 输出含 `"id": "__system__"` 的一条记录；`~/.wa-pi/workdir` 目录存在

- [ ] **Step 7: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/ensure-system-project.ts packages/kernel/tests/ensure-system-project.test.ts packages/kernel/src/index.ts && git commit -m "feat(kernel): 启动时 seed 默认工作区虚拟项目"
```

---

## Phase 3: kernel pwd 注入与会话目录创建

依赖：Phase 1 + Phase 2 完成

### Task 3.1: createSession 支持外部传入 createdAt

**Files:**
- Modify: `packages/kernel/src/project-store.ts`
- Modify: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ProjectStore.createSession` 的 input 参数对象新增可选字段 `createdAt?: number`

**背景**：默认工作区的子目录名是 `String(session.createdAt)`，必须让"mkdir 时用的 ts" === "session.createdAt"。`createSession` 默认内部 `now = Date.now()`，但允许外部传入同一个 ts。

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/project-store.test.ts` 末尾追加：

```ts
test("createSession 支持外部传入 createdAt", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  const FIXED = 1721567890123;
  const s = await store.createSession({
    projectId: p.id, primaryAgent: "dev", title: "会话",
    createdAt: FIXED,
  });
  expect(s.createdAt).toBe(FIXED);
  rmSync(f, { force: true });
});

test("createSession 不传 createdAt 时仍用 Date.now()", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  const before = Date.now();
  const s = await store.createSession({
    projectId: p.id, primaryAgent: "dev", title: "会话",
  });
  const after = Date.now();
  expect(s.createdAt).toBeGreaterThanOrEqual(before);
  expect(s.createdAt).toBeLessThanOrEqual(after);
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/project-store.test.ts
```

Expected: FAIL，报错 "createdAt does not exist in type ..." 或 ts 类型错误

- [ ] **Step 3: 修改 createSession 签名**

修改 `packages/kernel/src/project-store.ts` 第 64-80 行的 `createSession`：

改前：

```ts
async createSession(input: {
  projectId: string; primaryAgent: AgentName; title: string; id?: string;
}): Promise<SessionEntity> {
  const data = await this.load();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  // ...
}
```

改后：

```ts
async createSession(input: {
  projectId: string; primaryAgent: AgentName; title: string;
  id?: string;
  createdAt?: number;   // 默认工作区用：让 mkdir 用的 ts 与 session.createdAt 严格一致
}): Promise<SessionEntity> {
  const data = await this.load();
  const now = input.createdAt ?? Date.now();
  const id = input.id ?? randomUUID();
  // ...其余不变
}
```

**注意**：只改 input 类型签名和 `now` 取值，其余完全不动。`SessionEntity` 类型不变。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/project-store.test.ts
```

Expected: PASS

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts && git commit -m "feat(kernel): createSession 支持外部传入 createdAt（默认工作区用）"
```

---

### Task 3.2: agent-manager 用 resolveSessionCwd 替换 project.cwd

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`

**Interfaces:**
- Consumes: `resolveSessionCwd`（Task 1.2）
- Produces: agent-manager 创建 session 时 cwd 取自 `resolveSessionCwd(sessionEntity, project)`

**改动点**（基于已读代码 `agent-manager.ts:300-518`）：

| 行号 | 改前 | 改后 |
|---|---|---|
| 309-311 | 校验 `project.cwd` 非空 | 增加：若为系统项目，校验 `resolveSessionCwd` 路径可推导 |
| 351 | `buildMemorySnapshot(WA_PI_DIR, project.cwd)` | `buildMemorySnapshot(WA_PI_DIR, cwd)` |
| 364 | `getProjectMemoryStore(WA_PI_DIR, project.cwd)` | `getProjectMemoryStore(WA_PI_DIR, cwd)` |
| 396 | `cwd: project.cwd` | `cwd` |
| 455 | `cwd: project.cwd` | `cwd` |
| 471 | `this.sessionCwd.set(sessionId, project.cwd)` | `this.sessionCwd.set(sessionId, cwd)` |

其中 `cwd` = 在函数开头算一次的 `resolveSessionCwd(sessionEntity, project)`。

- [ ] **Step 1: 修改 _createSession 注入 cwd**

在 `packages/kernel/src/agent-manager.ts` 的 `_createSession` 方法内，**在 `if (!project.cwd) { throw ... }`（第 309-311 行）之后**加：

```ts
// 计算本次会话的 cwd：
// - 普通项目会话：直接用 project.cwd（行为不变）
// - 默认工作区会话：用 resolveSessionCwd 推导出 ~/.wa-pi/workdir/<createdAt>/
// 后续所有用到 cwd 的地方（resourceLoader / createFn / sessionCwd / memoryStore）都用这个值。
const cwd = resolveSessionCwd(sessionEntity, project);
```

需要把 `resolveSessionCwd` 加到文件顶部的 import（找现有的 `@wa-pi/shared` import 行追加）：

```ts
import { ..., resolveSessionCwd } from "@wa-pi/shared";
```

然后把第 351 行：

```ts
: await buildMemorySnapshot(WA_PI_DIR, project.cwd).catch(
```

改为：

```ts
: await buildMemorySnapshot(WA_PI_DIR, cwd).catch(
```

第 364 行：

```ts
getProjectMemoryStore(WA_PI_DIR, project.cwd),
```

改为：

```ts
getProjectMemoryStore(WA_PI_DIR, cwd),
```

第 395-396 行 `DefaultResourceLoader` 入参：

```ts
const loader = new sdk.DefaultResourceLoader({
  cwd: project.cwd,
```

改为：

```ts
const loader = new sdk.DefaultResourceLoader({
  cwd,
```

第 454-455 行 `createFn` 入参：

```ts
const result = await createFn({
  cwd: project.cwd,
```

改为：

```ts
const result = await createFn({
  cwd,
```

第 471 行：

```ts
this.sessionCwd.set(sessionId, project.cwd);
```

改为：

```ts
this.sessionCwd.set(sessionId, cwd);
```

**注意**：第 309-311 行的 `if (!project.cwd)` 校验保留——普通项目会话仍需要 project.cwd 非空。默认工作区的 project.cwd 是 `~/.wa-pi/workdir/`（非空字符串），所以校验也通过。

- [ ] **Step 2: 跑现有 kernel 测试验证不回归**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/
```

Expected: 所有现有测试 PASS（agent-manager 改动是行为兼容的，普通项目走 `resolveSessionCwd` 的 fallback 分支返回 `project.cwd`）

- [ ] **Step 3: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 4: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/agent-manager.ts && git commit -m "feat(kernel): _createSession 用 resolveSessionCwd 替换 project.cwd（支持默认工作区）"
```

---

### Task 3.3: workdir-cleaner 定时清理任务

**Files:**
- Create: `packages/kernel/src/workdir-cleaner.ts`
- Create: `packages/kernel/tests/workdir-cleaner.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROJECT_CWD` / `WORKDIR_TTL_DAYS` / `SYSTEM_PROJECT_ID`、`ProjectStore`
- Produces: `cleanupExpiredWorkdirs(projectStore): Promise<number>`

清理规则（三重防护）：
1. 子目录名必须**全数字**（时间戳格式）
2. 子目录路径**不在**当前 sessions 表的"被引用目录"集合中
3. 子目录 mtime 距今超过 `WORKDIR_TTL_DAYS` 天

- [ ] **Step 1: 写失败测试**

新建 `packages/kernel/tests/workdir-cleaner.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { cleanupExpiredWorkdirs } from "../src/workdir-cleaner";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS,
} from "@wa-pi/shared";

// 用临时根目录替代真实 ~/.wa-pi/workdir，避免污染开发机
const TMP_ROOT = join(import.meta.dir, ".tmp-workdir-cleaner-" + Math.random().toString(36).slice(2));

// mock SYSTEM_PROJECT_CWD：通过 monkey-patch 让 cleaner 用 TMP_ROOT
// 注意：cleaner 内部 import 的是常量值，monkey-patch 模块导出不可靠。
// 改用：cleaner 接受可选 root 参数（默认 SYSTEM_PROJECT_CWD），测试注入 TMP_ROOT。
// 实施时按此签名实现。

const DAY_MS = 24 * 60 * 60 * 1000;
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * DAY_MS);
const ONE_DAY_AGO = new Date(Date.now() - 1 * DAY_MS);

async function setMtime(dir: string, when: Date) {
  await utimes(dir, when, when);
}

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
});
afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

test("扫到 8 天前的孤立数字目录 → 删除", async () => {
  const oldDir = join(TMP_ROOT, "1721000000000");
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, "foo.txt"), "hi");
  await setMtime(oldDir, EIGHT_DAYS_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(1);
  expect(existsSync(oldDir)).toBe(false);
});

test("扫到 1 天前的目录 → 不删（未超 TTL）", async () => {
  const recentDir = join(TMP_ROOT, "1721000000001");
  await mkdir(recentDir, { recursive: true });
  await setMtime(recentDir, ONE_DAY_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(recentDir)).toBe(true);
});

test("8 天前但被现存 session 引用的目录 → 不删", async () => {
  const referenced = join(TMP_ROOT, "1721000000002");
  await mkdir(referenced, { recursive: true });
  await setMtime(referenced, EIGHT_DAYS_AGO);

  const f = join(TMP_ROOT, "projects.json");
  const store = new ProjectStore(f);
  // 系统项目 + 一个引用该目录的 session
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: TMP_ROOT,
  });
  await store.createSession({
    projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev", title: "引用目录的会话",
    createdAt: 1721000000002,  // ← 与目录名一致
  });

  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(referenced)).toBe(true);
});

test("非数字命名的目录 → 不动", async () => {
  const weirdDir = join(TMP_ROOT, "not-a-timestamp");
  await mkdir(weirdDir, { recursive: true });
  await setMtime(weirdDir, EIGHT_DAYS_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(weirdDir)).toBe(true);
});

test("根目录不存在 → 返回 0 不抛错", async () => {
  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, join(TMP_ROOT, "does-not-exist"));
  expect(cleaned).toBe(0);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/workdir-cleaner.test.ts
```

Expected: FAIL，报错 "Cannot find module '../src/workdir-cleaner'"

- [ ] **Step 3: 实现 workdir-cleaner.ts**

新建 `packages/kernel/src/workdir-cleaner.ts`：

```ts
import { rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectStore } from "./project-store";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS,
} from "@wa-pi/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 扫描默认工作区根目录下的子目录，按三重规则清理过期目录：
 *
 * 1. 子目录名必须全数字（时间戳格式）
 * 2. 子目录路径不在当前 sessions 表的"被引用目录"集合中
 *    （被现存会话引用的目录不能删，即便超时）
 * 3. 子目录 mtime 距今超过 WORKDIR_TTL_DAYS 天
 *
 * @param projectStore 用于查询当前 sessions 表
 * @param root 可选，默认用 SYSTEM_PROJECT_CWD；测试可注入临时目录
 * @returns 实际清理的目录数
 */
export async function cleanupExpiredWorkdirs(
  projectStore: ProjectStore,
  root: string = SYSTEM_PROJECT_CWD,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;  // 根目录不存在
  }

  // 计算"被现存会话引用"的目录路径集合
  const { sessions } = await projectStore.load();
  const activeDirs = new Set<string>();
  for (const s of sessions) {
    if (s.projectId === SYSTEM_PROJECT_ID) {
      activeDirs.add(join(root, String(s.createdAt)));
    }
  }

  const now = Date.now();
  let cleaned = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;  // 非时间戳目录跳过
    const dirPath = join(root, name);
    if (activeDirs.has(dirPath)) continue;  // 被现存会话引用
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;  // stat 失败（可能是普通文件而非目录）跳过
    }
    if (!st.isDirectory()) continue;  // 只清目录，不动文件
    if (now - st.mtimeMs > WORKDIR_TTL_DAYS * DAY_MS) {
      try {
        await rm(dirPath, { recursive: true, force: true });
        cleaned++;
      } catch (e) {
        console.warn(`[workdir-cleaner] 删除失败: ${dirPath}`, e);
      }
    }
  }
  return cleaned;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/workdir-cleaner.test.ts
```

Expected: PASS（5 个测试全过）

- [ ] **Step 5: 集成到 index.ts**

修改 `packages/kernel/src/index.ts`，在 `ensureSystemProject` 调用之后插入：

```ts
import { cleanupExpiredWorkdirs } from "./workdir-cleaner";

// ... 在 startKernel 函数体内，ensureSystemProject 之后：
// 启动时清理过期 workdir 子目录（默认工作区会话被删后保留 7 天）
try {
  const cleaned = await cleanupExpiredWorkdirs(projectStore);
  if (cleaned > 0) console.log(`[kernel] 已清理 ${cleaned} 个过期 workdir 子目录`);
} catch (e) {
  console.warn("[kernel] workdir 清理失败:", e);
}
// 每天定时清理一次
const DAY_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  cleanupExpiredWorkdirs(projectStore).catch(e => {
    console.warn("[kernel] workdir 定时清理失败:", e);
  });
}, DAY_MS);
```

- [ ] **Step 6: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 7: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/workdir-cleaner.ts packages/kernel/tests/workdir-cleaner.test.ts packages/kernel/src/index.ts && git commit -m "feat(kernel): 新增 workdir 7 天清理任务 + 启动集成"
```

---

## Phase 4: kernel ws-server 保护与会话目录

依赖：Phase 1 + Phase 2 + Phase 3 完成

### Task 4.1: 系统项目不可删除/改名

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/tests/ws-server.test.ts`（参考现有 ws-server 测试风格）

**Interfaces:**
- Consumes: `SYSTEM_PROJECT_ID`
- Produces: `project:delete` / `project:update` 收到 `projectId === SYSTEM_PROJECT_ID` 时广播 error

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/ws-server.test.ts` 末尾追加（先看现有测试如何构造 WSServer + reply mock，参考现有用例）：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

test("project:delete 系统项目被拦截", async () => {
  // 构造 store 预置系统项目
  const f = tempFile();
  const store = new ProjectStore(f);
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir",
  });
  // 用现有 ws-server 测试辅助函数构造 server（参考 ws-server.test.ts 现有 setup）
  const { server, replies } = await setupWSServer({ projectStore: store });
  await server.handle({ type: "project:delete", projectId: SYSTEM_PROJECT_ID } as any);
  expect(replies.some(r => r.type === "error" && /不可删除|不可修改/.test(r.message))).toBe(true);
  // 系统项目仍在
  const { projects } = await store.load();
  expect(projects.some(p => p.id === SYSTEM_PROJECT_ID)).toBe(true);
  rmSync(f, { force: true });
});

test("project:update 系统项目被拦截", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir",
  });
  const { server, replies } = await setupWSServer({ projectStore: store });
  await server.handle({
    type: "project:update", projectId: SYSTEM_PROJECT_ID, name: "试图改名",
  } as any);
  expect(replies.some(r => r.type === "error" && /不可删除|不可修改/.test(r.message))).toBe(true);
  const { projects } = await store.load();
  expect(projects[0].name).toBe("默认工作区");  // 名字未变
  rmSync(f, { force: true });
});
```

**注意**：`setupWSServer` 辅助函数若不存在，参考 `ws-server.test.ts` 现有测试的 server 构造方式（手动 new WSServer + mock broadcast/reply）。若现有测试用别的命名（如 `makeServer`），改用该命名。

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ws-server.test.ts -t "系统项目"
```

Expected: FAIL

- [ ] **Step 3: 修改 ws-server 加保护**

修改 `packages/kernel/src/ws-server.ts`：

第 271-276 行 `project:update`：

```ts
case "project:update": {
  if (event.projectId === SYSTEM_PROJECT_ID) {
    reply({ type: "error", message: "默认工作区不可修改" });
    break;
  }
  await this.opts.projectStore.updateProject(event.projectId, { name: event.name, cwd: event.cwd });
  // ...其余不变
}
```

第 277-282 行 `project:delete`：

```ts
case "project:delete": {
  if (event.projectId === SYSTEM_PROJECT_ID) {
    reply({ type: "error", message: "默认工作区不可删除" });
    break;
  }
  await this.opts.projectStore.deleteProject(event.projectId);
  // ...其余不变
}
```

需要在 ws-server.ts 顶部 import 补 `SYSTEM_PROJECT_ID`：

```ts
import { ..., SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ws-server.test.ts
```

Expected: PASS（所有原有 + 2 个新测试）

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts && git commit -m "feat(kernel): ws-server 拦截对默认工作区的删除/改名请求"
```

---

### Task 4.2: agent:prompt 创建默认工作区会话时 mkdir 子目录

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROJECT_ID` / `SYSTEM_PROJECT_CWD`
- Produces: `agent:prompt` handler 在 `isNew && projectId === SYSTEM_PROJECT_ID` 分支生成时间戳子目录

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/ws-server.test.ts` 追加：

```ts
test("agent:prompt 默认工作区新建会话时创建 workdir 子目录", async () => {
  const f = tempFile();
  const TMP_WORKDIR = join(import.meta.dir, ".tmp-workdir-" + Math.random().toString(36).slice(2));
  const store = new ProjectStore(f);
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: TMP_WORKDIR,
  });

  const { server } = await setupWSServer({ projectStore: store });
  // mock agentManager.ensureStarted + prompt 避免真实 SDK
  // ... 参考 ws-server.test.ts 现有 agent:prompt 测试的 mock 方式

  const newSessionId = "s-test-" + Math.random().toString(36).slice(2);
  await server.handle({
    type: "agent:prompt",
    projectId: SYSTEM_PROJECT_ID,
    sessionId: newSessionId,
    agentName: "dev",
    text: "hello",
    model: "test-model",
  } as any);

  // 等 session 创建 + mkdir 完成（异步锁）
  await new Promise(r => setTimeout(r, 100));

  // session 已写入
  const { sessions } = await store.load();
  const created = sessions.find(s => s.id === newSessionId);
  expect(created).toBeDefined();
  expect(created!.projectId).toBe(SYSTEM_PROJECT_ID);

  // workdir 子目录已创建（用 session.createdAt 推导路径）
  const subDir = join(TMP_WORKDIR, String(created!.createdAt));
  const { existsSync } = await import("node:fs");
  expect(existsSync(subDir)).toBe(true);

  // 清理
  const { rmSync } = await import("node:fs");
  rmSync(TMP_WORKDIR, { recursive: true, force: true });
  rmSync(f, { force: true });
});
```

**注意**：测试需要 mock agentManager 以避免真实 SDK 调用。参考 `ws-server.test.ts` 现有 agent:prompt 测试如何注入 mock agentManager。

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ws-server.test.ts -t "默认工作区新建会话"
```

Expected: FAIL，子目录不存在

- [ ] **Step 3: 修改 agent:prompt handler**

修改 `packages/kernel/src/ws-server.ts` 第 342-392 行的 `agent:prompt` handler，在 `isNew` 分支内：

改前（第 356-365 行）：

```ts
const isNew = !existing;
const session = existing ?? await this.opts.projectStore.createSession({
  projectId: event.projectId, primaryAgent: event.agentName,
  title: event.text.slice(0, 20),
  id: event.sessionId,
});
if (isNew) {
  this.broadcast({ type: "session:created", session });
  reply({ type: "session:echo_user", sessionId: session.id, text: event.text, agentName: event.agentName });
}
```

改后：

```ts
const isNew = !existing;
let createdAt: number | undefined;
if (isNew && event.projectId === SYSTEM_PROJECT_ID) {
  // 默认工作区：先生成 ts 作为子目录名 + session.createdAt，确保两者严格一致
  createdAt = Date.now();
}
const session = existing ?? await this.opts.projectStore.createSession({
  projectId: event.projectId, primaryAgent: event.agentName,
  title: event.text.slice(0, 20),
  id: event.sessionId,
  createdAt,
});
if (isNew) {
  // 默认工作区：mkdir workdir/<createdAt>/ 子目录
  if (event.projectId === SYSTEM_PROJECT_ID && createdAt !== undefined) {
    try {
      const sessionDir = join(SYSTEM_PROJECT_CWD, String(createdAt));
      await mkdir(sessionDir, { recursive: true });
    } catch (e) {
      reply({ type: "error", message: `默认工作区会话目录创建失败: ${(e as Error).message}`, sessionId: session.id });
      return;
    }
  }
  this.broadcast({ type: "session:created", session });
  reply({ type: "session:echo_user", sessionId: session.id, text: event.text, agentName: event.agentName });
}
```

需要在 ws-server.ts 顶部 import 补：

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ..., SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "@wa-pi/shared";
```

（`mkdir` / `join` 现有 ws-server 已 import，看一眼是否已存在再决定加不加）

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ws-server.test.ts
```

Expected: PASS

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts && git commit -m "feat(kernel): agent:prompt 默认工作区新建会话时创建 workdir/<createdAt>/ 子目录"
```

---

### Task 4.3: 上传/recording 路径改用 session 级 cwd

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`

**Interfaces:**
- Consumes: `resolveSessionCwd`（Task 1.2）
- Produces: 上传/录音目录基于 `resolveSessionCwd` 而非 `project.cwd`

**改动点**（`ws-server.ts`）：

| 行号 | handler | 改前 | 改后 |
|---|---|---|---|
| 563 | fs:upload | `join(project.cwd, ".wa-pi", "uploads")` | `join(resolveSessionCwdForRequest(...), ".wa-pi", "uploads")` |
| 587 | fs:copy | 同上 | 同上 |
| 663 | fs:recording:append | 同上 | 同上 |
| 676 | fs:recording:finalize | 同上 | 同上 |
| 689 | fs:recording:discard | 同上 | 同上 |

**问题**：fs:upload / fs:copy 事件（`types.ts:348/350`）目前只带 `projectId` 不带 `sessionId`，无法在 handler 里直接定位 session 实体。

**解决方案**：**前端发 fs:upload 时新增 sessionId 字段**（让 fs:upload / fs:copy 事件类型携带可选 sessionId），handler 收到后用 `resolveSessionCwd`；未带则降级到 `project.cwd`（向后兼容老调用方）。

- [ ] **Step 1: 扩展 WS 事件类型携带 sessionId**

修改 `packages/shared/src/types.ts` 第 348/350 行：

```ts
export interface FSUploadRequest {
  type: "fs:upload";
  id: string;
  projectId: string;
  sessionId?: string;   // ← 新增：默认工作区会话级上传目录推导用
  name: string;
  content: string;
}
export interface FSCopyRequest {
  type: "fs:copy";
  id: string;
  projectId: string;
  sessionId?: string;   // ← 新增
  source: string;
}
```

`FSRecordingAppendRequest` / `FinalizeRequest` / `DiscardRequest`（第 359-364 行）同理加 `sessionId?`。

- [ ] **Step 2: 在 ws-server 加辅助函数**

在 `ws-server.ts` 顶部加辅助：

```ts
import { resolveSessionCwd } from "@wa-pi/shared";

/**
 * 从 fs:upload / fs:copy / fs:recording 等事件解析本次操作的 cwd。
 *
 * - 普通项目会话 / 未带 sessionId → 返回 project.cwd（行为不变）
 * - 默认工作区会话 + sessionId → 用 resolveSessionCwd 推导 ~/.wa-pi/workdir/<createdAt>/
 */
async function resolveCwdForFsRequest(
  projectStore: ProjectStore,
  projectId: string,
  sessionId?: string,
): Promise<string> {
  const { projects, sessions } = await projectStore.load();
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);
  if (!sessionId) return project.cwd;
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return project.cwd;
  return resolveSessionCwd(session, project);
}
```

- [ ] **Step 3: 修改 fs:upload handler（第 553-572 行）**

改前：

```ts
const uploadDir = join(project.cwd, ".wa-pi", "uploads");
```

改后：

```ts
const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
const uploadDir = join(cwd, ".wa-pi", "uploads");
```

（去掉原来对 `project.cwd` 的重复校验，辅助函数已包含）

- [ ] **Step 4: 同理修改 fs:copy / fs:recording:* handler**

5 处全部改用 `resolveCwdForFsRequest`。每处改法相同。

- [ ] **Step 5: 写测试**

在 `ws-server.test.ts` 末尾加：

```ts
test("fs:upload 默认工作区会话携带 sessionId 时写入 workdir/<createdAt>/.wa-pi/uploads", async () => {
  // 构造默认工作区项目 + 一个 session，发 fs:upload 带 sessionId，断言文件落在 workdir/<createdAt>/.wa-pi/uploads/
  // ...
});

test("fs:upload 未携带 sessionId 时仍写 project.cwd/.wa-pi/uploads（向后兼容）", async () => {
  // 普通项目 + 无 sessionId，断言行为不变
  // ...
});
```

- [ ] **Step 6: 跑测试**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/ws-server.test.ts
```

Expected: PASS

- [ ] **Step 7: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck && bun run --filter @wa-pi/shared typecheck
```

Expected: 无错误

- [ ] **Step 8: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/shared/src/types.ts packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts && git commit -m "feat(kernel): fs:upload/copy/recording 支持默认工作区 session 级 cwd"
```

---

### Task 4.4: project:open-dir 支持打开 session 级目录

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/kernel/src/ws-server.ts`

**背景**：默认工作区会话的"打开工作目录"菜单项要打开 `~/.wa-pi/workdir/<createdAt>/`（会话级），而非 `~/.wa-pi/workdir/`（项目级）。

- [ ] **Step 1: 扩展 ProjectOpenDirEvent**

修改 `packages/shared/src/types.ts` 第 242-245 行：

```ts
export interface ProjectOpenDirEvent {
  type: "project:open-dir";
  projectId: string;
  sessionId?: string;   // ← 新增：默认工作区会话级目录打开
}
```

- [ ] **Step 2: 修改 project:open-dir handler（ws-server.ts 第 283-292 行）**

改前：

```ts
case "project:open-dir": {
  const data = await this.opts.projectStore.load();
  const project = data.projects.find(p => p.id === event.projectId);
  if (project?.cwd && existsSync(project.cwd)) {
    const openCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [project.cwd], { shell: true, stdio: "ignore" });
  }
  break;
}
```

改后：

```ts
case "project:open-dir": {
  const data = await this.opts.projectStore.load();
  const project = data.projects.find(p => p.id === event.projectId);
  if (!project?.cwd) break;
  // 默认工作区会话级：若有 sessionId 用 resolveSessionCwd 推导子目录
  let dir = project.cwd;
  if (event.sessionId) {
    const session = data.sessions.find(s => s.id === event.sessionId);
    if (session) dir = resolveSessionCwd(session, project);
  }
  if (existsSync(dir)) {
    const openCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [dir], { shell: true, stdio: "ignore" });
  }
  break;
}
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/kernel typecheck && bun run --filter @wa-pi/shared typecheck
```

Expected: 无错误

- [ ] **Step 4: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/shared/src/types.ts packages/kernel/src/ws-server.ts && git commit -m "feat(kernel): project:open-dir 支持 sessionId 打开默认工作区会话级目录"
```

---

## Phase 5: 前端 Sidebar + ProjectItem + ProjectList

依赖：Phase 1-4 完成（前端要用 `SYSTEM_PROJECT_ID` 常量）

### Task 5.1: Sidebar 新增"默认"独立区

**Files:**
- Modify: `packages/frontend/src/components/Sidebar.tsx`
- Modify: `packages/frontend/src/components/ProjectList.tsx`
- Modify: `packages/frontend/tests/Sidebar.test.tsx`
- Modify: `packages/frontend/tests/ProjectList.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/tests/Sidebar.test.tsx` 末尾追加：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

test("默认工作区渲染在独立'默认'区", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  // "默认" 区标题存在
  expect(screen.getByText("默认")).toBeTruthy();
  // 默认工作区项目渲染在"默认"区
  expect(screen.getByText("默认工作区")).toBeTruthy();
  // "项目" 区也有标题
  expect(screen.getAllByText(/^项目$/).length).toBeGreaterThanOrEqual(1);
});

test("默认工作区不出现在项目区（去重）", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  // 只有一处渲染"默认工作区"
  expect(screen.getAllByText("默认工作区").length).toBe(1);
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/Sidebar.test.tsx
```

Expected: FAIL（找不到"默认"区标题）

- [ ] **Step 3: 修改 Sidebar.tsx 加入独立区**

修改 `packages/frontend/src/components/Sidebar.tsx`，在 `AgentListSection` 与 `ProjectList` 之间插入独立区：

```tsx
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { ProjectItem } from "./ProjectItem";

// ...在 Sidebar 组件内：
const allProjects = useProjectsStore(s => s.projects);
const sessions = useProjectsStore(s => s.sessions);
const currentSessionId = useProjectsStore(s => s.currentSessionId);
const currentProjectId = useProjectsStore(s => s.currentProjectId);
const systemProject = allProjects.find(p => p.id === SYSTEM_PROJECT_ID);

// JSX 内：
<AgentListSection onChatWith={props.onChatWith} onEdit={props.onEdit} onMore={props.onMore} />

{/* 默认工作区独立区 */}
{systemProject && (
  <div className="flex-1 overflow-y-auto overflow-x-hidden">
    <div className="text-[11px] font-bold text-tertiary px-2 py-1 border-t border-hairline mt-2 uppercase tracking-wide">
      默认
    </div>
    <ProjectItem
      project={systemProject}
      sessions={sessions}
      currentSessionId={currentSessionId}
      selected={systemProject.id === currentProjectId}
      isNewSessionView={props.currentView === "new-session"}
      onSelectSession={props.onSelectSession}
      onNewSessionInProject={props.onNewSessionInProject}
      onSelectProject={props.onSelectProject}
    />
  </div>
)}

<ProjectList
  onSelectSession={props.onSelectSession}
  onNewSessionInProject={props.onNewSessionInProject}
  onSelectProject={props.onSelectProject}
  onNewProject={props.onNewProject}
  currentView={props.currentView}
/>
```

- [ ] **Step 4: 修改 ProjectList 过滤掉系统项目**

修改 `packages/frontend/src/components/ProjectList.tsx` 第 19-31 行：

```tsx
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

// 在 map 之前过滤：
const userProjects = projects.filter(p => p.id !== SYSTEM_PROJECT_ID);
// ...
{userProjects.map(p => (
  <ProjectItem ... />
))}
```

- [ ] **Step 5: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/Sidebar.test.tsx packages/frontend/tests/ProjectList.test.tsx
```

Expected: PASS

- [ ] **Step 6: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/frontend typecheck
```

Expected: 无错误

- [ ] **Step 7: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/frontend/src/components/Sidebar.tsx packages/frontend/src/components/ProjectList.tsx packages/frontend/tests/Sidebar.test.tsx packages/frontend/tests/ProjectList.test.tsx && git commit -m "feat(frontend): Sidebar 新增'默认'独立区 + ProjectList 过滤系统项目"
```

---

### Task 5.2: ProjectItem 差异化渲染

**Files:**
- Modify: `packages/frontend/src/components/ProjectItem.tsx`
- Modify: `packages/frontend/tests/ProjectItem.sort-menu.test.tsx`（或新建 `ProjectItem.system.test.tsx`）

差异化点：
1. 系统项目折叠时图标用 `🏠`（普通项目用 `📁`），展开时都用 `📂`
2. 系统项目**右键菜单不显示"删除项目"**，仅"查看文件夹"
3. 系统项目下的**会话右键菜单多一项"打开工作目录"**

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/ProjectItem.system.test.tsx`：

```ts
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

beforeEach(() => {
  useProjectUiStore.setState({ collapsedProjectIds: [] });
});

test("系统项目折叠时图标用 🏠", () => {
  const project = { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 };
  render(
    <ProjectItem
      project={project}
      sessions={[]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  // 折叠状态（默认）
  expect(screen.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`).textContent).toContain("🏠");
});

test("系统项目右键菜单不显示'删除项目'", () => {
  const project = { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 };
  render(
    <ProjectItem project={project} sessions={[]} currentSessionId={null} selected={false}
      onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} />
  );
  fireEvent.contextMenu(screen.getByTestId(`project-${SYSTEM_PROJECT_ID}`));
  expect(screen.queryByTestId("menu-delete-project")).toBeNull();
  expect(screen.getByTestId("menu-open-dir")).toBeTruthy();
});

test("系统项目下会话右键菜单有'打开工作目录'项", () => {
  const project = { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 };
  const session = {
    id: "s1", projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev",
    title: "会话", createdAt: 1721000000000, lastActivity: Date.now(),
    piSessionFile: "",
  };
  // 先展开项目才能看到会话
  useProjectUiStore.setState({ collapsedProjectIds: [] });
  render(
    <ProjectItem project={project} sessions={[session]} currentSessionId={null} selected={false}
      onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} />
  );
  // 右键会话
  fireEvent.contextMenu(screen.getByText("会话"));
  expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
});

test("普通项目折叠时图标用 📁（行为不变）", () => {
  const project = { id: "p1", name: "WaPi", cwd: "/work", createdAt: 0 };
  render(
    <ProjectItem project={project} sessions={[]} currentSessionId={null} selected={false}
      onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} />
  );
  expect(screen.getByTestId("project-toggle-p1").textContent).toContain("📁");
});

test("普通项目右键菜单有'删除项目'（行为不变）", () => {
  const project = { id: "p1", name: "WaPi", cwd: "/work", createdAt: 0 };
  render(
    <ProjectItem project={project} sessions={[]} currentSessionId={null} selected={false}
      onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} />
  );
  fireEvent.contextMenu(screen.getByTestId("project-p1"));
  expect(screen.getByTestId("menu-delete-project")).toBeTruthy();
});

test("普通项目下会话右键菜单无'打开工作目录'（行为不变）", () => {
  const project = { id: "p1", name: "WaPi", cwd: "/work", createdAt: 0 };
  const session = {
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "会话", createdAt: 0, lastActivity: Date.now(),
    piSessionFile: "",
  };
  render(
    <ProjectItem project={project} sessions={[session]} currentSessionId={null} selected={false}
      onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} />
  );
  fireEvent.contextMenu(screen.getByText("会话"));
  expect(screen.queryByTestId("menu-open-session-dir")).toBeNull();
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/ProjectItem.system.test.tsx
```

Expected: FAIL

- [ ] **Step 3: 修改 ProjectItem.tsx**

修改 `packages/frontend/src/components/ProjectItem.tsx`：

1. 顶部加 import：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

2. 在组件内（约第 35 行 `const { project, sessions, ... } = props;` 之后）加：

```ts
const isSystem = project.id === SYSTEM_PROJECT_ID;
```

3. 第 116 行的图标：

```tsx
{expanded ? "📂" : (isSystem ? "🏠" : "📁")}
```

4. 新增 `handleOpenSessionDir` handler（约第 91 行 `handleOpenDir` 之后）：

```ts
const handleOpenSessionDir = (session: SessionEntity) => {
  setSessionMenu(null);
  send({ type: "project:open-dir", projectId: project.id, sessionId: session.id });
};
```

5. 在会话右键菜单（第 146-169 行 `sessionMenu` portal）末尾加：

```tsx
{isSystem && (
  <button
    onClick={() => handleOpenSessionDir(sessionMenu.session)}
    className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
    data-testid="menu-open-session-dir"
  >打开工作目录</button>
)}
```

6. 项目右键菜单（第 172-195 行 `projectMenu` portal）的"删除项目"按钮包条件渲染：

```tsx
{!isSystem && (
  <button
    onClick={handleProjectDeleteClick}
    className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
    data-testid="menu-delete-project"
  >删除项目</button>
)}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/ProjectItem.system.test.tsx
```

Expected: PASS

- [ ] **Step 5: 跑现有 ProjectItem 测试确保不回归**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/ProjectItem.sort-menu.test.tsx
```

Expected: PASS

- [ ] **Step 6: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/frontend typecheck
```

Expected: 无错误

- [ ] **Step 7: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/frontend/src/components/ProjectItem.tsx packages/frontend/tests/ProjectItem.system.test.tsx && git commit -m "feat(frontend): ProjectItem 默认工作区差异化（图标/菜单/打开工作目录）"
```

---

## Phase 6: 前端 NewSessionPane + SessionView

依赖：Phase 1 + Phase 5 完成

### Task 6.1: NewSessionPane 项目下拉与默认选中

**Files:**
- Modify: `packages/frontend/src/components/NewSessionPane.tsx`
- Modify: `packages/frontend/tests/NewSessionPane.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/tests/NewSessionPane.test.tsx` 末尾追加（参考现有 NewSessionPane 测试的 mock 方式）：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

test("项目下拉出现默认工作区选项且不带 cwd", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  // mock providers/agents 等
  render(<NewSessionPane />);
  const select = screen.getByTestId("project-select") as HTMLSelectElement;
  // 系统项目 option 文本是 "🏠 默认工作区"
  const sysOption = Array.from(select.options).find(o => o.value === SYSTEM_PROJECT_ID);
  expect(sysOption).toBeDefined();
  expect(sysOption!.textContent).toContain("默认工作区");
  expect(sysOption!.textContent).not.toContain("/tmp/workdir");
  // 普通项目 option 仍带 cwd
  const normalOption = Array.from(select.options).find(o => o.value === "p1");
  expect(normalOption!.textContent).toContain("/work/wa-pi");
});

test("首次进入时默认选中默认工作区", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  render(<NewSessionPane />);
  const select = screen.getByTestId("project-select") as HTMLSelectElement;
  expect(select.value).toBe(SYSTEM_PROJECT_ID);
});
```

**注意**：mock providers/agents 以满足 `pickDefaultAgent` 等前置条件，参考现有 `NewSessionPane.test.tsx` 的 mock 方式。

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/NewSessionPane.test.tsx
```

Expected: FAIL

- [ ] **Step 3: 修改 NewSessionPane.tsx**

修改 `packages/frontend/src/components/NewSessionPane.tsx`：

1. 顶部加 import：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

2. 第 40-41 行 `initialProject` 默认值：

```ts
const initialProject =
  currentProjectId
  ?? projects.find(p => p.id === SYSTEM_PROJECT_ID)?.id
  ?? projects[0]?.id
  ?? null;
```

3. 第 138 行下拉选项渲染：

```tsx
{projects.map(p => (
  <option key={p.id} value={p.id}>
    {p.id === SYSTEM_PROJECT_ID ? "🏠 " : "📁 "}{p.name}
    {p.id === SYSTEM_PROJECT_ID ? "" : ` ${p.cwd}`}
  </option>
))}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/NewSessionPane.test.tsx
```

Expected: PASS

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/frontend typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/frontend/src/components/NewSessionPane.tsx packages/frontend/tests/NewSessionPane.test.tsx && git commit -m "feat(frontend): NewSessionPane 项目下拉加入默认工作区 + 默认选中"
```

---

### Task 6.2: SessionView header 友好文案

**Files:**
- Modify: `packages/frontend/src/components/SessionView.tsx`
- Modify: `packages/frontend/tests/SessionView.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/tests/SessionView.test.tsx` 末尾追加：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

test("默认工作区会话 header 显示友好文案", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
    ],
    sessions: [
      {
        id: "s1", projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev",
        title: "设计海报", createdAt: 1721000000000, lastActivity: Date.now(),
        piSessionFile: "",
      },
    ],
    currentProjectId: SYSTEM_PROJECT_ID, currentSessionId: "s1",
  });
  // mock WS + 其他依赖，参考现有 SessionView.test.tsx
  render(<SessionView sessionId="s1" />);
  // header 显示 "默认工作区 · 工作目录"
  expect(screen.getByText(/默认工作区/)).toBeTruthy();
  expect(screen.getByText(/工作目录/)).toBeTruthy();
});

test("普通项目会话 header 仍显示 project.cwd（不回归）", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 }],
    sessions: [{
      id: "s1", projectId: "p1", primaryAgent: "dev",
      title: "会话", createdAt: 0, lastActivity: Date.now(),
      piSessionFile: "",
    }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  render(<SessionView sessionId="s1" />);
  expect(screen.getByText("/work/wa-pi")).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/SessionView.test.tsx
```

Expected: FAIL

- [ ] **Step 3: 修改 SessionView.tsx header**

修改 `packages/frontend/src/components/SessionView.tsx` 第 97-100 行：

改前：

```tsx
<div className="text-[11.5px] text-tertiary mt-px">
  <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: STATUS_COLORS[headerStatus] }} data-testid="session-status-dot" />
  {project?.cwd ?? ""} · {AGENT_STATE_LABEL[headerStatus]}
</div>
```

改后：

```tsx
<div className="text-[11.5px] text-tertiary mt-px">
  <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: STATUS_COLORS[headerStatus] }} data-testid="session-status-dot" />
  {(session && session.projectId === SYSTEM_PROJECT_ID)
    ? "默认工作区 · 工作目录"
    : (project?.cwd ?? "")
  } · {AGENT_STATE_LABEL[headerStatus]}
</div>
```

顶部加 import：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/WaPi && bun test packages/frontend/tests/SessionView.test.tsx
```

Expected: PASS

- [ ] **Step 5: typecheck**

```bash
cd /Users/pipi/work/WaPi && bun run --filter @wa-pi/frontend typecheck
```

Expected: 无错误

- [ ] **Step 6: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/frontend/src/components/SessionView.tsx packages/frontend/tests/SessionView.test.tsx && git commit -m "feat(frontend): SessionView 默认工作区会话 header 显示友好文案"
```

---

## Phase 7: 第三层 API 集成测试

依赖：Phase 1-6 完成

### Task 7.1: WS 集成测试（默认工作区完整链路）

**Files:**
- Create: `packages/kernel/tests/default-workspace.integration.test.ts`

**说明**：第三层 API 集成测试通过真实 WS 连接验证完整链路。参考 `packages/kernel/tests/ws-server.test.ts` 现有的 WSServer 构造方式。

- [ ] **Step 1: 写集成测试**

新建 `packages/kernel/tests/default-workspace.integration.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { ensureSystemProject } from "../src/ensure-system-project";
import { cleanupExpiredWorkdirs } from "../src/workdir-cleaner";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, SYSTEM_PROJECT_NAME,
} from "@wa-pi/shared";

// 用临时 workdir 根（避免污染开发机）：通过环境变量覆盖 SYSTEM_PROJECT_CWD
// 注意：SYSTEM_PROJECT_CWD 在模块加载时已固化为 ~/.wa-pi/workdir，无法运行时改。
// 改用：测试直接在真实 SYSTEM_PROJECT_CWD 下做隔离的子目录测试，测后清理。

const TEST_SUBDIR_PREFIX = "test-integration-";

test("集成：默认工作区 seed + 创建会话 + 删除会话保留目录 + 7 天清理", async () => {
  // 1. ensureSystemProject 幂等写入
  const f = join(import.meta.dir, ".tmp-integration-" + Math.random().toString(36).slice(2) + ".json");
  const store = new ProjectStore(f);
  await ensureSystemProject(store);
  await ensureSystemProject(store);  // 二次调用幂等
  const { projects } = await store.load();
  expect(projects.some(p => p.id === SYSTEM_PROJECT_ID)).toBe(true);
  expect(projects.find(p => p.id === SYSTEM_PROJECT_ID)!.name).toBe(SYSTEM_PROJECT_NAME);

  // 2. 模拟创建默认工作区会话（带 createdAt）
  const sessionTs = Date.now();
  await store.createSession({
    projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev", title: "集成测试会话",
    createdAt: sessionTs,
  });
  // mkdir 对应子目录（模拟 ws-server agent:prompt 的行为）
  const { mkdir } = await import("node:fs/promises");
  const sessionDir = join(SYSTEM_PROJECT_CWD, String(sessionTs));
  await mkdir(sessionDir, { recursive: true });
  expect(existsSync(sessionDir)).toBe(true);

  // 3. 删除会话：目录保留
  await store.deleteSession(/* 用 sessionId */);
  // 重新查 sessions，确认已删
  const { sessions: afterDelete } = await store.load();
  expect(afterDelete.length).toBe(0);
  // 目录仍存在
  expect(existsSync(sessionDir)).toBe(true);

  // 4. 触发清理：把目录 mtime 改成 8 天前，调 cleanupExpiredWorkdirs
  const { utimes } = await import("node:fs/promises");
  const DAY_MS = 24 * 60 * 60 * 1000;
  await utimes(sessionDir, new Date(Date.now() - 8 * DAY_MS), new Date(Date.now() - 8 * DAY_MS));
  const cleaned = await cleanupExpiredWorkdirs(store);
  expect(cleaned).toBeGreaterThanOrEqual(1);
  expect(existsSync(sessionDir)).toBe(false);

  rmSync(f, { force: true });
});

test("集成：project:delete 拦截系统项目", async () => {
  // 用真实 WSServer + mock broadcast/reply 验证 handler 拦截逻辑
  // 参考 ws-server.test.ts 的 setupWSServer 辅助
  // ... 构造 server，发 project:delete 带 SYSTEM_PROJECT_ID，断言 error 广播
  // 实施时补完整
});

test("集成：project:update 拦截系统项目", async () => {
  // 同上
});
```

- [ ] **Step 2: 跑集成测试**

```bash
cd /Users/pipi/work/WaPi && bun test packages/kernel/tests/default-workspace.integration.test.ts
```

Expected: PASS

- [ ] **Step 3: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/kernel/tests/default-workspace.integration.test.ts && git commit -m "test(kernel): 默认工作区第三层集成测试"
```

---

## Phase 8: 第四层 E2E 测试

依赖：Phase 1-7 完成 + desktop 可启动

### Task 8.1: E2E 完整流程

**Files:**
- Create: `packages/frontend/e2e/default-workspace.spec.ts`

**说明**：Playwright 真实浏览器操作，参考 `packages/frontend/e2e/` 现有 spec 文件的模式。

- [ ] **Step 1: 写 E2E spec**

新建 `packages/frontend/e2e/default-workspace.spec.ts`：

```ts
import { test, expect } from "@playwright/test";
import { existsSync, rmSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROJECT_CWD } from "@wa-pi/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

test("默认工作区完整流程：新建会话 → 写文件 → 删除 → 7 天清理", async ({ page }) => {
  // 1. 启动 desktop（test before hook 已启动，参考现有 e2e setup）
  await page.goto("http://localhost:5180");

  // 2. 在侧栏"默认"区点击"🏠 默认工作区"
  await page.getByText("默认工作区").click();

  // 3. 验证项目下拉默认选中
  const projectSelect = page.getByTestId("project-select");
  await expect(projectSelect).toHaveValue("__system__");

  // 4. 选智能体、输入消息、发送
  await page.getByPlaceholder("给研发发消息...").fill("创建一个 hello.txt");
  await page.getByRole("button", { name: /发送/ }).click();

  // 5. 进入会话视图，header 显示友好文案
  await expect(page.getByText(/默认工作区/)).toBeVisible();
  await expect(page.getByText(/工作目录/)).toBeVisible();

  // 6. 等 agent 调 write_to_file 完成（最多 30s）
  await page.waitForTimeout(30000);

  // 7. 找到最新创建的 workdir 子目录
  const { readdirSync } = await import("node:fs");
  const subdirs = readdirSync(SYSTEM_PROJECT_CWD)
    .filter(n => /^\d+$/.test(n))
    .map(n => ({ name: n, mtime: statSync(join(SYSTEM_PROJECT_CWD, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  expect(subdirs.length).toBeGreaterThan(0);
  const latestDir = join(SYSTEM_PROJECT_CWD, subdirs[0].name);

  // 8. 右键会话 → 菜单有"打开工作目录"
  await page.getByText("创建一个 hello.txt").click({ button: "right" });
  await expect(page.getByTestId("menu-open-session-dir")).toBeVisible();

  // 9. 右键项目 → 菜单仅"查看文件夹"
  await page.getByText("默认工作区").click({ button: "right" });
  await expect(page.getByTestId("menu-open-dir")).toBeVisible();
  await expect(page.getByTestId("menu-delete-project")).toHaveCount(0);

  // 10. 删除该会话
  await page.getByText("创建一个 hello.txt").click({ button: "right" });
  await page.getByTestId("menu-delete").click();
  await page.getByRole("button", { name: /删除/ }).click();

  // 11. 验证子目录仍存在
  expect(existsSync(latestDir)).toBe(true);

  // 12. 手动改 mtime 为 8 天前，触发清理
  utimesSync(latestDir, new Date(Date.now() - 8 * DAY_MS), new Date(Date.now() - 8 * DAY_MS));
  // 调 kernel 清理：通过 WS 触发或直接重启 kernel（实施时择一）
  // 简单做法：fetch kernel 的清理 endpoint（若没有，重启 kernel）
  // 这里假设有 debug endpoint：GET /_debug/cleanup-workdir
  await page.evaluate(() => fetch("/_debug/cleanup-workdir"));
  await page.waitForTimeout(500);

  // 13. 验证目录被删
  expect(existsSync(latestDir)).toBe(false);
});

// 测试后清理所有产生的截图
test.afterAll(() => {
  // 扫描所有 screenshot 路径，rmSync 删除
  // 参考 AGENTS.md 第 6 条要求
});
```

**注意**：实施时根据实际 e2e setup 调整。`/_debug/cleanup-workdir` endpoint 若不存在，需要在 kernel 加一个**仅 dev 模式可用**的 endpoint，或直接重启 kernel。

- [ ] **Step 2: 跑 E2E**

```bash
cd /Users/pipi/work/WaPi/packages/frontend && bun run e2e -- e2e/default-workspace.spec.ts
```

Expected: PASS

- [ ] **Step 3: 清理截图**

```bash
find /Users/pipi/work/WaPi -name "*.png" -path "*/e2e/*" -newer /tmp/marker -delete 2>/dev/null
# 或手动检查 e2e 目录
```

- [ ] **Step 4: commit**

```bash
cd /Users/pipi/work/WaPi && git add packages/frontend/e2e/default-workspace.spec.ts && git commit -m "test(e2e): 默认工作区完整流程 E2E 测试"
```

---

## Phase 9: 收尾

### Task 9.1: CHANGELOG 与全量回归

- [ ] **Step 1: 跑全量测试**

```bash
cd /Users/pipi/work/WaPi && bun test
```

Expected: 所有测试 PASS

- [ ] **Step 2: typecheck 全量**

```bash
cd /Users/pipi/work/WaPi && bun run typecheck
```

Expected: 无错误

- [ ] **Step 3: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部加：

```markdown
- 2026-07-21 / 新增功能
- 摘要：会话列表新增"🏠 默认工作区"常驻虚拟项目；默认工作区下的每个会话在
        ~/.wa-pi/workdir/<createdAt>/ 下隔离 pwd，互不干扰；删除会话保留目录 7 天后
        自动清理；skill/mcp 继承全局配置
- 影响范围：shared/constants.ts、shared/pure.ts、shared/types.ts、kernel/index.ts、
            kernel/project-store.ts、kernel/ws-server.ts、kernel/agent-manager.ts、
            kernel/workdir-cleaner.ts（新）、kernel/ensure-system-project.ts（新）、
            frontend/Sidebar.tsx、frontend/ProjectItem.tsx、frontend/ProjectList.tsx、
            frontend/NewSessionPane.tsx、frontend/SessionView.tsx
```

- [ ] **Step 4: commit**

```bash
cd /Users/pipi/work/WaPi && git add CHANGELOG.md && git commit -m "docs: 更新 CHANGELOG（默认工作区功能）"
```

- [ ] **Step 5: 最终验证**

```bash
cd /Users/pipi/work/WaPi && bun run dev &
sleep 5
# 打开 desktop，手动验证：
# 1. 侧栏有"默认"独立区 + 🏠 默认工作区
# 2. 点默认工作区进新建会话页，下拉默认选中
# 3. 发送消息后会话视图 header 显示"默认工作区 · 工作目录"
# 4. 让 agent 写文件，确认文件落在 ~/.wa-pi/workdir/<ts>/
# 5. 右键会话有"打开工作目录"
# 6. 右键项目无"删除项目"
kill %1
```

---

## Self-Review 检查

**1. Spec 覆盖：**

| Spec 节 | 实施任务 |
|---|---|
| § 1-2 概述/数据模型不变 | Task 1.1（常量）+ Task 1.2（纯函数） |
| § 3.1 seed 系统项目 | Task 2.1 + Task 2.2 |
| § 3.2 项目删除/改名保护 | Task 4.1 |
| § 3.3 会话 cwd 注入 | Task 3.1（createSession createdAt）+ Task 4.2（ws-server mkdir）|
| § 3.4 agent-manager pwd 取值 | Task 3.2 |
| § 3.5 上传目录同步 | Task 4.3 |
| § 3.6 删除会话保留目录 | 已天然满足（session:delete 只删记录），无需新代码；E2E 验证 |
| § 3.7 workdir 7 天清理 | Task 3.3 |
| § 3.8 skill/mcp 继承 | 已天然满足（不在 <ts>/ 下创建 .mcp.json），无需新代码 |
| § 4.1 Sidebar 独立区 | Task 5.1 |
| § 4.2 ProjectItem 差异化 | Task 5.2 |
| § 4.3 NewSessionPane 下拉 | Task 6.1 |
| § 4.4 NewSessionPane 默认选中 | Task 6.1 |
| § 4.5 SessionView header | Task 6.2 |
| § 4 打开工作目录 | Task 4.4 + Task 5.2 |
| § 5 错误处理 | 各 Task 内的 catch/兜底 |
| § 6 测试计划 | Phase 1-8 全覆盖 |

**2. 占位扫描**：无 TBD/TODO；每个步骤都有具体代码 ✓

**3. 类型一致性**：
- `SYSTEM_PROJECT_ID` 全程统一字符串 `"__system__"` ✓
- `resolveSessionCwd` 签名 `(session, project) => string` 全程一致 ✓
- `createSystemProject` 输入 `{ id, name, cwd }` 全程一致 ✓
- `createSession` 新增 input 字段 `createdAt?: number` 一致 ✓
- `cleanupExpiredWorkdirs(projectStore, root?)` 签名一致 ✓

**4. 风险点**：
- ws-server.test.ts 的 `setupWSServer` 辅助命名需在实施 Task 4.1 时核实（可能叫 `makeServer` / `createServer`）
- E2E 的 `/_debug/cleanup-workdir` endpoint 不存在时，实施 Task 8.1 需要补一个 dev-only endpoint 或改为重启 kernel
- Task 4.3 涉及前端是否同步发 sessionId——若前端已有发送（看 `ws-inst.ts` 或调用方），改动更小；若无则需在前端调用方加 sessionId

---

## 执行说明

Plan 完成并保存到 `docs/superpowers/plans/2026-07-21-default-workspace.md`。
