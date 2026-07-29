# Memory 项目作用域与手动添加实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `@amaster.ai/pi-memory` 替换 `pi-hermes-memory`，让项目记忆按 `project.cwd` 精确存储；同时在「系统设置 > 记忆」页面顶部增加全局/项目选择器，并支持手动添加记忆。

**Architecture:** 不在 Pi 扩展加载时依赖 `process.cwd()`，而是把 `@amaster.ai/pi-memory` 作为 host-controlled 库直接使用：每个 session 在 kernel 中维护一个全局 `MemoryStore` 和一个按 `project.cwd` 实例化的项目 `MemoryStore`。自定义 memory tools 通过 Pi SDK 的 `customTools` 参数注入，`systemPromptOverride` 中读取当前项目 + 全局记忆追加到提示词。前端 MemoryPage 通过新增 `memoryScope` / `selectedProjectId` 状态控制展示范围，并通过 `memory:add` 事件支持手动写入。

**Tech Stack:** TypeScript, Bun, React, Zustand, `@amaster.ai/pi-memory`, Pi SDK (`@earendil-works/pi-coding-agent`), WebSocket.

## Global Constraints

- 不要修改 `@amaster.ai/pi-memory` 的源码；只使用其 `MemoryStore` 与 `createMemoryTools` API。
- 不迁移旧 `pi-hermes-memory` 数据；数据不重要。
- 不使用 `process.chdir()` 或任何 cwd hack。
- 文件保持 < 800 行，函数保持 < 50 行。
- 所有修改遵循项目既有测试结构（`bun:test` + `@testing-library/react`）。
- 新增公共 API 必须带 TypeScript 类型，避免 `any`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/kernel/package.json` | 移除 `pi-hermes-memory`，新增 `@amaster.ai/pi-memory` 依赖。 |
| `packages/kernel/src/agent-manager.ts` | 移除 chdir POC；在 `_createSession` 中创建并传入自定义 memory tools；把记忆 snapshot 注入系统提示词。 |
| `packages/kernel/src/amaster-memory.ts` | 新增：对 `@amaster.ai/pi-memory` 的包装，提供按 scope 获取 store、add/update/list 等统一接口。 |
| `packages/kernel/src/memory-store.ts` | 重构：内部使用 `amaster-memory.ts`，保持现有 `list/update/archive/restore/purge` API，新增 `add(scope, text, projectId?)`。 |
| `packages/kernel/src/ws-server.ts` | 新增 `memory:add` 事件处理。 |
| `packages/shared/src/memory.ts` | 新增 `MemoryAddEvent` 类型；扩展 `MemoryScope` / `MemoryCategory` 不变。 |
| `packages/shared/src/types.ts` | 把 `MemoryAddEvent` 加入 `WSClientEvent` 联合类型。 |
| `packages/frontend/src/store/memory.ts` | 新增 `add` action；新增 `memoryScope` / `selectedProjectId` UI 状态。 |
| `packages/frontend/src/components/memory/MemoryPage.tsx` | 改造：搜索框前放全局/项目选择器；添加「+ 手动添加」输入区。 |
| `packages/frontend/src/components/memory/MemoryCard.tsx` | 可复用，必要时添加新分类样式。 |
| 测试文件 | `memory-store.test.ts`、`ws-memory.test.ts`、`MemoryPage.test.tsx` 同步更新。 |

---

## Task 1: 安装依赖与回退 chdir POC

**Files:**
- Modify: `packages/kernel/package.json`
- Modify: `packages/kernel/src/agent-manager.ts`
- Delete: `packages/kernel/tests/agent-manager-chdir.poc.test.ts`
- Delete: `packages/kernel/tests/agent-manager-chdir-concurrent.poc.test.ts`

**Interfaces:**
- Produces: `AgentManager` 不再包含 `AsyncMutex` / `cwdLock` / chdir 逻辑。

- [ ] **Step 1: 修改 `packages/kernel/package.json`**

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.0",
    "@wa-pi/shared": "workspace:*",
    "@amaster.ai/pi-memory": "^0.1.5",
    "pi-intercom": "^0.6.0",
    "pi-web-access": "^0.13.0",
    "pi-lens": "^3.8.0"
  }
}
```

- [ ] **Step 2: 回退 `packages/kernel/src/agent-manager.ts` 中的 chdir POC**

删除以下全部代码：
1. `class AsyncMutex { ... }`
2. `private cwdLock = new AsyncMutex();`
3. `_createSession` 中的：
   ```ts
   const releaseCwd = await this.cwdLock.acquire();
   const originalCwd = process.cwd();
   try {
     process.chdir(project.cwd);
   ```
   以及对应的 `finally` 块：
   ```ts
   } finally {
     try { process.chdir(originalCwd); } catch {}
     releaseCwd();
   }
   ```
4. 所有相关注释，例如：
   ```ts
   // pi-hermes-memory 在 extension 加载时用 process.cwd() 检测项目，
   // 必须切到 project.cwd 再加载扩展，否则项目记忆会写到 kernel 启动目录。
   ```

回退后 `_createSession` 的扩展加载/创建块应恢复为：

```ts
const loader = new sdk.DefaultResourceLoader({
  cwd: project.cwd,
  agentDir: WA_PI_DIR,
  additionalExtensionPaths: buildAdditionalExtensionPaths(),
  additionalSkillPaths,
  systemPromptOverride: () =>
    config?.systemPromptMode === "append" && config.systemPromptBody
      ? config.systemPromptBody!
      : WA_PI_DEFAULT_SYSTEM_PROMPT,
  agentsFilesOverride:
    config?.systemPromptMode === "append" && config.systemPromptBody
      ? (current: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: [
            ...current.agentsFiles,
            { path: `/virtual/${config.name}.md`, content: config.systemPromptBody! },
          ],
        })
      : undefined,
});
await loader.reload();

({ session } = await createFn({
  cwd: project.cwd,
  agentDir: WA_PI_DIR,
  sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
  resourceLoader: loader,
  thinkingLevel: config?.thinking ?? "medium",
  tools: config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS,
  authStorage,
  modelRegistry,
}));

session.setSessionName(`${projectId}-${agentName}-${sessionId}`);

if (typeof (session as any).bindExtensions === "function") {
  await (session as any).bindExtensions({});
}
```

- [ ] **Step 3: 删除 POC 测试文件**

```bash
rm packages/kernel/tests/agent-manager-chdir.poc.test.ts
rm packages/kernel/tests/agent-manager-chdir-concurrent.poc.test.ts
```

- [ ] **Step 4: 安装依赖**

```bash
cd packages/kernel
bun install
```

- [ ] **Step 5: 运行 kernel 类型检查**

```bash
cd packages/kernel
bun run typecheck
```

Expected: 无类型错误。

- [ ] **Step 6: 运行 kernel 测试**

```bash
cd packages/kernel
bun test src/agent-manager.test.ts
```

Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/package.json packages/kernel/src/agent-manager.ts

git rm packages/kernel/tests/agent-manager-chdir.poc.test.ts packages/kernel/tests/agent-manager-chdir-concurrent.poc.test.ts

git commit -m "chore(kernel): 移除 pi-hermes-memory chdir POC，准备替换 amaster memory"
```

---

## Task 2: 创建 AmasterMemoryStore 包装层

**Files:**
- Create: `packages/kernel/src/amaster-memory.ts`
- Test: `packages/kernel/tests/amaster-memory.test.ts`

**Interfaces:**
- Consumes: `@amaster.ai/pi-memory` 的 `MemoryStore` 与 `createMemoryTools`。
- Produces:
  - `getGlobalMemoryStore(waPiDir): AmasterStore`
  - `getProjectMemoryStore(waPiDir, cwd): AmasterStore`
  - `AmasterStore.add(text: string): Promise<void>`
  - `AmasterStore.update(oldText: string, newText: string): Promise<boolean>`
  - `AmasterStore.remove(oldText: string): Promise<boolean>`
  - `AmasterStore.list(): Promise<string[]>`
  - `AmasterStore.formatForPrompt(limit?: number): Promise<string>`

- [ ] **Step 1: 写 failing test**

Create `packages/kernel/tests/amaster-memory.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalMemoryStore, getProjectMemoryStore } from "../src/amaster-memory";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "amaster-memory-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("global store 写入后 list 能读回", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("全局偏好：用 pnpm");
  const list = await store.list();
  expect(list).toContain("全局偏好：用 pnpm");
});

test("project store 按 cwd basename 隔离目录", async () => {
  const projectCwd = join(tmpDir, "repos", "my-app");
  const store = getProjectMemoryStore(tmpDir, projectCwd);
  await store.add("项目用 Tailwind");
  const list = await store.list();
  expect(list).toContain("项目用 Tailwind");
});

test("formatForPrompt 返回非空字符串", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("记住用 TypeScript");
  const prompt = await store.formatForPrompt(500);
  expect(prompt).toContain("记住用 TypeScript");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/kernel
bun test tests/amaster-memory.test.ts
```

Expected: FAIL（`getGlobalMemoryStore` 未定义）。

- [ ] **Step 3: 实现 `packages/kernel/src/amaster-memory.ts`**

```ts
// amaster-memory.ts — 对 @amaster.ai/pi-memory 的 host-controlled 包装
//
// 目标：让 kernel 自己决定全局/项目记忆的存储目录，而不是依赖 Pi 扩展加载时的 cwd。

import { MemoryStore } from "@amaster.ai/pi-memory";
import { join } from "node:path";

export interface AmasterStore {
  add(text: string): Promise<void>;
  update(oldText: string, newText: string): Promise<boolean>;
  remove(oldText: string): Promise<boolean>;
  list(): Promise<string[]>;
  formatForPrompt(limit?: number): Promise<string>;
}

/** 从 waPiDir 生成全局记忆目录 */
export function getGlobalMemoryStore(waPiDir: string): AmasterStore {
  return createStore(join(waPiDir, "memories", "global"));
}

/** 按 project.cwd 生成项目记忆目录（取 cwd basename） */
export function getProjectMemoryStore(waPiDir: string, cwd: string): AmasterStore {
  const projectName = cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || "default";
  return createStore(join(waPiDir, "projects-memory", projectName));
}

function createStore(dir: string): AmasterStore {
  const store = new MemoryStore({ dir });

  return {
    async add(text: string) {
      await store.loadFromDisk();
      // @amaster.ai/pi-memory 的 MemoryStore 实例方法命名需以实际包为准；
      // 若包未导出类型，用 (store as any).memory_add 或同等方法。
      // 这里假设存在 memory_add，入参为 { target: "memory", content: text }。
      await (store as any).memory_add({ target: "memory", content: text });
    },
    async update(oldText: string, newText: string) {
      await store.loadFromDisk();
      return await (store as any).memory_replace({ target: "memory", oldText, newText });
    },
    async remove(oldText: string) {
      await store.loadFromDisk();
      return await (store as any).memory_remove({ target: "memory", oldText });
    },
    async list() {
      await store.loadFromDisk();
      const entries = (store as any).getEntries?.("memory") ?? [];
      return entries.map((e: any) => String(e.content ?? e));
    },
    async formatForPrompt(limit = 2000) {
      await store.loadFromDisk();
      const entries = (store as any).getEntries?.("memory") ?? [];
      const texts = entries.map((e: any) => String(e.content ?? e));
      return buildPromptBlock(texts, limit);
    },
  };
}

function buildPromptBlock(entries: string[], limit: number): string {
  let used = 0;
  const kept: string[] = [];
  for (const text of entries) {
    if (used + text.length > limit && kept.length > 0) break;
    kept.push(text);
    used += text.length;
  }
  if (kept.length === 0) return "";
  return `<memory-context>\n${kept.map(t => `- ${t}`).join("\n")}\n</memory-context>`;
}
```

> **注意：** 实际 API 名称以安装后的 `@amaster.ai/pi-memory` 为准。如果 `MemoryStore` 没有直接暴露 `memory_add` 等方法，则改为使用 `createMemoryTools(store)` 返回的 tool handler 函数，或自己调用 `store.loadFromDisk()` 后读写内部 entries。本任务成功后必须修正为真实 API。

- [ ] **Step 4: 运行测试**

```bash
cd packages/kernel
bun test tests/amaster-memory.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/amaster-memory.ts packages/kernel/tests/amaster-memory.test.ts
git commit -m "feat(kernel): 添加 @amaster.ai/pi-memory 包装层"
```

---

## Task 3: 重构 MemoryStore 支持 scope 与 add

**Files:**
- Modify: `packages/kernel/src/memory-store.ts`
- Test: `packages/kernel/tests/memory-store.test.ts`

**Interfaces:**
- Consumes: `getGlobalMemoryStore`, `getProjectMemoryStore` from `amaster-memory.ts`。
- Produces:
  - `MemoryStore.list(projectId?): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }>` 不变。
  - `MemoryStore.add(scope: "global" | "project", text: string, projectId?: string): Promise<void>`
  - `MemoryStore.update(id, text)` / `archive(id)` / `restore(id)` / `purge(id)` 保持原有签名。

- [ ] **Step 1: 更新测试，新增 add 用例**

在 `packages/kernel/tests/memory-store.test.ts` 末尾追加：

```ts
test("add 全局记忆后 list 能读到", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.add("global", "新全局记忆");
  const { memories } = await store.list();
  const found = memories.find(m => m.text === "新全局记忆" && m.scope === "global");
  expect(found).toBeTruthy();
});

test("add 项目记忆后 list 能读到", async () => {
  const store = new MemoryStore({ waPiDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  await store.add("project", "新项目记忆", "p1");
  const { memories } = await store.list("p1");
  const found = memories.find(m => m.text === "新项目记忆" && m.scope === "project");
  expect(found).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/kernel
bun test tests/memory-store.test.ts
```

Expected: 新增两个测试 FAIL（`store.add` 不存在）。

- [ ] **Step 3: 重构 `packages/kernel/src/memory-store.ts`**

保留现有 `MemoryStore` 类签名，内部把读写委托给 `amaster-memory.ts`。关键变更：

1. 导入包装层：
   ```ts
   import { getGlobalMemoryStore, getProjectMemoryStore, type AmasterStore } from "./amaster-memory";
   ```

2. 在 `MemoryStore` 类内新增辅助方法：
   ```ts
   private async getAmasterStores(projectId?: string): Promise<{ global: AmasterStore; project?: AmasterStore }> {
     const global = getGlobalMemoryStore(this.opts.waPiDir);
     let project: AmasterStore | undefined;
     if (projectId) {
       const cwd = await this.getProjectCwd(projectId);
       if (cwd) project = getProjectMemoryStore(this.opts.waPiDir, cwd);
     }
     return { global, project };
   }
   ```

3. 实现 `add`：
   ```ts
   async add(scope: "global" | "project", text: string, projectId?: string): Promise<void> {
     const { global, project } = await this.getAmasterStores(projectId);
     if (scope === "project") {
       if (!project) throw new Error("项目记忆需要 projectId");
       await project.add(text);
     } else {
       await global.add(text);
     }
   }
   ```

4. `list` 方法：为了兼容现有测试中对 `pi-hermes-memory/` 目录的读取，**阶段 1** 可以保留旧解析逻辑作为 fallback，同时读取 amaster 目录。或者更简单：先把测试改为向 amaster 目录写文件，再让 `list` 只读 amaster 目录。这里选择后者（数据不重要）。

   修改 `list`：
   ```ts
   async list(projectId?: string): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
     const memories: MemoryEntry[] = [];
     const { global, project } = await this.getAmasterStores(projectId);

     const globalEntries = await global.list();
     globalEntries.forEach((text, rawIndex) => {
       memories.push(this.makeEntry(text, "global", rawIndex, join(this.opts.waPiDir, "memories", "global", "MEMORY.md")));
     });

     if (project) {
       const projectEntries = await project.list();
       const cwd = await this.getProjectCwd(projectId!);
       const projectName = this.projectNameFromCwd(cwd!);
       projectEntries.forEach((text, rawIndex) => {
         memories.push(this.makeEntry(text, "project", rawIndex, join(this.opts.waPiDir, "projects-memory", projectName, "MEMORY.md")));
       });
     }

     const archived = await this.loadArchive();
     return { memories, archived };
   }

   private makeEntry(text: string, scope: MemoryScope, rawIndex: number, sourceFile: string): MemoryEntry {
     return {
       id: `${relative(this.opts.waPiDir, sourceFile).replace(/\\/g, "/")}:${rawIndex}`,
       text: text.trim(),
       category: "memory",
       scope,
       sourceFile,
       rawIndex,
     };
   }
   ```

5. `update/archive/restore/purge`：保持基于 `id` 定位文件的方式不变，但因为路径从 `pi-hermes-memory/` 变成了 `memories/global/` 和 `projects-memory/<name>/`，需要同步修改 `resolveSourceFile` 和 `categoryFromSourceFile` 的解析逻辑。

- [ ] **Step 4: 更新 memory-store.test.ts 的既有用例以匹配新路径**

把测试中写 `pi-hermes-memory/` 的 setup 改为写 `memories/global/`。例如：

```ts
const globalMemoryDir = join(tmpDir, "memories", "global");

beforeEach(async () => {
  await mkdir(globalMemoryDir, { recursive: true });
  await mkdir(projectsMemoryDir, { recursive: true });
});
```

并把 `await writeFile(join(hermesDir, "MEMORY.md"), ...)` 改为 `await writeFile(join(globalMemoryDir, "MEMORY.md"), ...)`。

> 由于数据格式同样是 `§` 分隔，如果继续直接写文件而不是通过 amaster API，测试仍可验证解析逻辑。

- [ ] **Step 5: 运行测试**

```bash
cd packages/kernel
bun test tests/memory-store.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/memory-store.ts packages/kernel/tests/memory-store.test.ts
git commit -m "feat(kernel): MemoryStore 支持 scope 与 add，切换 amaster memory 目录"
```

---

## Task 4: 添加 `memory:add` WS 协议

**Files:**
- Modify: `packages/shared/src/memory.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/ws-memory.test.ts`

**Interfaces:**
- Produces:
  - `MemoryAddEvent { type: "memory:add"; scope: "global" | "project"; projectId?: string; text: string; }`
  - `WSClientEvent` 包含 `MemoryAddEvent`
  - `ws-server` 处理 `memory:add` 并广播 `memory:changed`

- [ ] **Step 1: 在 shared 添加类型**

修改 `packages/shared/src/memory.ts`，在 `MemoryPurgeEvent` 后追加：

```ts
export interface MemoryAddEvent {
  type: "memory:add";
  scope: "global" | "project";
  projectId?: string;
  text: string;
}
```

修改 `packages/shared/src/types.ts`，把 `MemoryAddEvent` 加入 `WSClientEvent`：

```ts
| MemoryListEvent | MemoryUpdateEvent | MemoryArchiveEvent | MemoryRestoreEvent | MemoryPurgeEvent | MemoryAddEvent
```

- [ ] **Step 2: 更新 ws-memory.test.ts，新增 add 用例**

```ts
test("memory:add 全局记忆后广播 memory:changed", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:add", scope: "global", text: "手动添加的全局记忆" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:changed");
      const texts = resp.memories.map((m: any) => m.text);
      expect(texts).toContain("手动添加的全局记忆");
    },
  );
});

test("memory:add 项目记忆需要 projectId", async () => {
  await withMemoryServer(
    async (dataDir) => {
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      await ps.createProject({ name: "fake-project", cwd: join(dataDir, "fake-project") });
      await mkdir(join(dataDir, "fake-project"), { recursive: true });
    },
    async (send, recv, _mockAM, dataDir) => {
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      const { projects } = await ps.load();
      const projectId = projects[0].id;

      send({ type: "memory:add", scope: "project", projectId, text: "手动添加的项目记忆" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:changed");
      const found = resp.memories.find((m: any) => m.text === "手动添加的项目记忆" && m.scope === "project");
      expect(found).toBeTruthy();
    },
  );
});
```

- [ ] **Step 3: 在 ws-server.ts 处理 memory:add**

在 `case "memory:purge":` 之后新增：

```ts
case "memory:add": {
  try {
    await this.opts.memoryStore.add(event.scope, event.text, event.projectId);
    const result = await this.opts.memoryStore.list(event.projectId);
    this.broadcast({ type: "memory:changed", ...result });
  } catch (err) {
    this.broadcast({ type: "error", message: (err as Error).message });
  }
  break;
}
```

- [ ] **Step 4: 运行测试**

```bash
cd packages/kernel
bun test tests/ws-memory.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/memory.ts packages/shared/src/types.ts packages/kernel/src/ws-server.ts packages/kernel/tests/ws-memory.test.ts
git commit -m "feat(kernel,shared): 添加 memory:add WebSocket 协议"
```

---

## Task 5: 在 AgentManager 注册 memory customTools 并注入提示词

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Modify: `packages/kernel/src/amaster-memory.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`（验证 customTools 传入即可）

**Interfaces:**
- Consumes: `getGlobalMemoryStore`, `getProjectMemoryStore`, `createMemoryTools`。
- Produces:
  - `_createSession` 创建 `customTools` 并传给 `createFn`。
  - `WA_PI_DEFAULT_SYSTEM_PROMPT` 追加当前项目 + 全局记忆 snapshot。

- [ ] **Step 1: 在 amaster-memory.ts 导出 createMemoryToolsForProject**

如果 `@amaster.ai/pi-memory` 的 `createMemoryTools(store)` 返回 Pi SDK 可用的 `ToolDefinition[]`，则直接复用。新增导出：

```ts
export function createMemoryToolsForStores(globalStore: AmasterStore, projectStore?: AmasterStore): ToolDefinition[] {
  // 若 amaster 包提供 createMemoryTools，直接调用两次并合并 tool 名称。
  // 否则自定义 tool schema，内部调用 globalStore/projectStore 的 add/update/remove/list。
}
```

具体实现需根据安装后真实 API 调整。核心 tool schema 示例：

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createMemoryToolsForStores(
  waPiDir: string,
  projectCwd?: string,
): ToolDefinition[] {
  const global = getGlobalMemoryStore(waPiDir);
  const project = projectCwd ? getProjectMemoryStore(waPiDir, projectCwd) : undefined;

  return [
    {
      name: "memory_save",
      description: "保存一条记忆。scope='project' 保存到当前项目，'global' 保存到全局。",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "project"] },
          content: { type: "string" },
        },
        required: ["scope", "content"],
      },
      async handler(args: any) {
        const store = args.scope === "project" && project ? project : global;
        await store.add(args.content);
        return { success: true };
      },
    },
  ];
}
```

- [ ] **Step 2: 修改 agent-manager.ts 的 `_createSession`**

1. 在构建 `loader` 之前，准备 memory stores：
   ```ts
   import { createMemoryToolsForStores } from "./amaster-memory";
   ```

2. 在 `_createSession` 中：
   ```ts
   const memoryCustomTools = createMemoryToolsForStores(WA_PI_DIR, project.cwd);
   ```

3. 修改 `createFn` 调用，加入 `customTools`：
   ```ts
   ({ session } = await createFn({
     cwd: project.cwd,
     agentDir: WA_PI_DIR,
     sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
     resourceLoader: loader,
     thinkingLevel: config?.thinking ?? "medium",
     tools: config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS,
     customTools: memoryCustomTools,
     authStorage,
     modelRegistry,
   }));
   ```

4. 修改 `WA_PI_DEFAULT_SYSTEM_PROMPT` 或在 `systemPromptOverride` 中动态注入记忆 snapshot：
   ```ts
   import { getGlobalMemoryStore, getProjectMemoryStore } from "./amaster-memory";

   async function buildMemoryContext(waPiDir: string, projectCwd?: string): Promise<string> {
     const global = getGlobalMemoryStore(waPiDir);
     const project = projectCwd ? getProjectMemoryStore(waPiDir, projectCwd) : undefined;
     const [globalBlock, projectBlock] = await Promise.all([
       global.formatForPrompt(1500),
       project?.formatForPrompt(1500) ?? Promise.resolve(""),
     ]);
     return [globalBlock, projectBlock].filter(Boolean).join("\n");
   }
   ```

   在 `systemPromptOverride` 中：
   ```ts
   systemPromptOverride: async () => {
     const base =
       config?.systemPromptMode === "append" && config.systemPromptBody
         ? config.systemPromptBody!
         : WA_PI_DEFAULT_SYSTEM_PROMPT;
     const memoryBlock = await buildMemoryContext(WA_PI_DIR, project.cwd);
     return memoryBlock ? `${base}\n\n${memoryBlock}` : base;
   },
   ```

   > 注意：`systemPromptOverride` 当前是同步函数，需要确认 `DefaultResourceLoader` 是否支持 async。如不支持，改为在 `WA_PI_DEFAULT_SYSTEM_PROMPT` 中预留占位符，或同步读取文件。

- [ ] **Step 3: 更新 agent-manager.test.ts 验证 customTools 传入**

在已有 mock `createAgentSessionFn` 的测试中，断言 `opts.customTools` 被传入且非空。

- [ ] **Step 4: 运行测试**

```bash
cd packages/kernel
bun test tests/agent-manager.test.ts
bun run typecheck
```

Expected: 全部 PASS，无类型错误。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/amaster-memory.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): AgentManager 注入 memory customTools 与提示词 snapshot"
```

---

## Task 6: MemoryPage UI 改造（选择器 + 手动添加）

**Files:**
- Modify: `packages/frontend/src/store/memory.ts`
- Modify: `packages/frontend/src/components/memory/MemoryPage.tsx`
- Modify: `packages/frontend/tests/MemoryPage.test.tsx`

**Interfaces:**
- Produces:
  - `memoryScope: "global" | "project"`
  - `selectedProjectId: string | null`
  - `add(scope, text, projectId?)` action
  - 筛选后的记忆按 `memoryScope` / `selectedProjectId` 过滤。

- [ ] **Step 1: 更新 `packages/frontend/src/store/memory.ts`**

新增 state 和 action：

```ts
interface MemoryState {
  // ... 原有字段 ...
  memoryScope: "global" | "project";
  selectedProjectId: string | null;
  // actions
  add: (scope: "global" | "project", text: string, projectId?: string) => void;
  setMemoryScope: (scope: "global" | "project") => void;
  setSelectedProjectId: (id: string | null) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  // ... 原有初始化 ...
  memoryScope: "project",
  selectedProjectId: null,

  add: (scope, text, projectId) => {
    send({ type: "memory:add", scope, text, projectId });
  },
  setMemoryScope: (scope) => set({ memoryScope: scope }),
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
}));
```

- [ ] **Step 2: 改造 `packages/frontend/src/components/memory/MemoryPage.tsx`**

在搜索框前新增选择器：

```tsx
// 在工具栏区域
<div className="flex items-center gap-2.5 px-5 py-2.5" ...>
  <select
    className="text-[11.5px] px-2.5 py-1 rounded-md"
    style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
    value={memoryScope}
    onChange={e => setMemoryScope(e.target.value as "global" | "project")}
    data-testid="memory-scope-select"
  >
    <option value="global">全局记忆</option>
    <option value="project">项目记忆</option>
  </select>

  {memoryScope === "project" && (
    <select
      className="text-[11.5px] px-2.5 py-1 rounded-md"
      style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
      value={selectedProjectId ?? currentProjectId ?? ""}
      onChange={e => setSelectedProjectId(e.target.value)}
      data-testid="memory-project-select"
    >
      {projects.map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  )}

  <input ... />

  <button
    onClick={() => setShowAddModal(true)}
    className="text-[11px] font-semibold px-3 py-1 rounded-md text-white"
    style={{ background: "var(--accent)", border: "none" }}
    data-testid="memory-add-button"
  >+ 添加</button>
</div>
```

新增添加弹窗/输入区（内联在页面底部或 modal，保持简单）：

```tsx
const [showAddModal, setShowAddModal] = useState(false);
const [newMemoryText, setNewMemoryText] = useState("");

// 在列表内容之后或之前
{showAddModal && (
  <div className="px-5 py-3" style={{ borderTop: "1px solid var(--hairline)" }}>
    <textarea
      className="w-full text-[12px] p-2.5 rounded-lg"
      style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)", minHeight: 80 }}
      placeholder="输入要保存的记忆..."
      value={newMemoryText}
      onChange={e => setNewMemoryText(e.target.value)}
      data-testid="memory-add-textarea"
    />
    <div className="flex justify-end gap-2 mt-2">
      <button
        onClick={() => { setShowAddModal(false); setNewMemoryText(""); }}
        className="text-[11px] px-3 py-1 rounded-md"
        style={{ border: "1px solid var(--hairline)" }}
      >取消</button>
      <button
        onClick={() => {
          const targetProjectId = memoryScope === "project" ? (selectedProjectId ?? currentProjectId) : undefined;
          add(memoryScope, newMemoryText, targetProjectId);
          setShowAddModal(false);
          setNewMemoryText("");
        }}
        className="text-[11px] font-semibold px-3 py-1 rounded-md text-white"
        style={{ background: "var(--accent)", border: "none" }}
        data-testid="memory-add-save"
      >保存</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: 按作用域过滤记忆**

修改 `filteredMemories`：

```ts
const filteredMemories = memories
  .filter(m => m.scope === memoryScope)
  .filter(m => categoryFilter === "all" || m.category === categoryFilter)
  .filter(m => !searchQuery || m.text.toLowerCase().includes(searchQuery.toLowerCase()));
```

- [ ] **Step 4: 更新 `MemoryPage.test.tsx`**

新增测试：

```tsx
test("切换全局/项目选择器过滤记忆", () => {
  useMemoryStore.setState({
    memories: [
      { id: "g:0", text: "全局A", category: "memory", scope: "global", sourceFile: "/g", rawIndex: 0 },
      { id: "p:0", text: "项目A", category: "memory", scope: "project", sourceFile: "/p", rawIndex: 0 },
    ],
  });
  render(<MemoryPage />);
  expect(screen.getByText("全局A")).toBeTruthy();
  expect(screen.getByText("项目A")).toBeTruthy();

  fireEvent.change(screen.getByTestId("memory-scope-select"), { target: { value: "global" } });
  expect(screen.getByText("全局A")).toBeTruthy();
  expect(screen.queryByText("项目A")).toBeNull();
});

test("点击添加记忆按钮展开输入区并发送 memory:add", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId("memory-add-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));
  expect(addMock).toHaveBeenCalledWith("project", "新记忆", "p1");
});
```

- [ ] **Step 5: 运行前端测试**

```bash
cd packages/frontend
bun test tests/MemoryPage.test.tsx
bun run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/store/memory.ts packages/frontend/src/components/memory/MemoryPage.tsx packages/frontend/tests/MemoryPage.test.tsx
git commit -m "feat(frontend): MemoryPage 支持全局/项目选择器与手动添加"
```

---

## Task 7-8: 更新测试并清理 pi-hermes-memory 残留

**Files:**
- Modify: `packages/kernel/src/extensions.ts`
- Modify: `packages/kernel/tests/extensions.test.ts`
- Modify: `packages/kernel/tests/ws-extension.test.ts`
- Delete/修改：任何硬编码引用 `pi-hermes-memory` 的路径或测试 fixture。

**Interfaces:**
- Produces: 可选扩展列表中 `pi-hermes-memory` 被移除或标记为未启用；`buildAdditionalExtensionPaths` 不再加载它。

- [ ] **Step 1: 从 `packages/kernel/src/extensions.ts` 的可选扩展中移除 `pi-hermes-memory`**

```ts
export const OPTIONAL_EXTENSIONS: readonly OptionalExtensionDef[] = [
  {
    id: "pi-lens",
    package: "pi-lens",
    displayName: "LSP 诊断",
    description: "实时代码反馈：LSP 诊断、lint、类型检查、结构分析",
    defaultEnabled: true,
  },
  // pi-hermes-memory 已替换为 kernel 内建 amaster memory
];
```

- [ ] **Step 2: 更新相关测试**

运行：

```bash
cd packages/kernel
bun test
```

Expected: 任何因移除 `pi-hermes-memory` 而失败的测试需要修复。典型问题：
- `extensions.test.ts` 中期望可选扩展数量为 2 的断言改为 1。
- `ws-extension.test.ts` 中 toggle `pi-hermes-memory` 的用例改为 toggle `pi-lens` 或删除。

- [ ] **Step 3: 全局搜索 `pi-hermes-memory` 残留**

```bash
grep -r "pi-hermes-memory" packages/kernel/src packages/kernel/tests packages/frontend/src packages/frontend/tests packages/shared/src
```

Expected: 只剩 `MemoryStore` 为了兼容旧路径的 fallback（如果保留了），或已完全移除。

- [ ] **Step 4: 运行全量测试**

```bash
cd packages/kernel && bun test && bun run typecheck
cd packages/frontend && bun test && bun run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/extensions.ts packages/kernel/tests/extensions.test.ts packages/kernel/tests/ws-extension.test.ts
git commit -m "chore(kernel): 清理 pi-hermes-memory 可选扩展与残留引用"
```

---

## Self-Review

**1. Spec coverage:**
- 按 `project.cwd` 写入项目记忆：Task 2 `getProjectMemoryStore` 使用 `cwd` basename。
- 不 hack 第三方：Task 1 移除 chdir，Task 2 使用 host-controlled API。
- 系统设置 > 记忆顶部选择器：Task 6 添加 `memory-scope-select` 和 `memory-project-select`。
- 手动添加记忆：Task 4 后端协议 + Task 6 前端 UI。
- 不迁移数据：Task 3 直接切换目录结构，未写迁移逻辑。

**2. Placeholder scan:**
- 无 TBD/TODO。
- `amaster-memory.ts` 中 `(store as any)` 需要根据真实包 API 调整，已用注释明确说明。

**3. Type consistency:**
- `MemoryAddEvent.scope` 统一为 `"global" | "project"`。
- `MemoryStore.add(scope, text, projectId?)` 与 WS 协议、前端 store 一致。
- `AmasterStore` 接口在 Task 2 定义，Task 5 消费。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-11-memory-project-scope.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
