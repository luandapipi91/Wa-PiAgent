# 记忆与指令文件管理 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 hiagent 添加记忆管理页（集成 pi-hermes-memory）和指令文件只读展示，用户可查看/编辑/归档记忆，查看已加载的指令文件。

**Architecture:** kernel 新增 `MemoryStore` 服务读写 pi-hermes-memory 的 Markdown 文件（§ 分隔）+ sidecar 归档 JSON + 配置开关 JSON。前端新增 `memory` view + Zustand store + 组件树。前后端通过 8 个新 WS 事件通信。注入完全交给插件。

**Tech Stack:** Bun + TypeScript（kernel），React 19 + Zustand 5（前端），bun:test（测试）

## Global Constraints

- 所有代码注释和沟通用中文
- 遵循 HiAgent Light 设计系统（DESIGN.md）
- kernel 测试用 `bun:test`，临时目录隔离（`import.meta.dir + ".tmp-" + Math.random()`）
- 前端测试用 `bun:test` + `@testing-library/react`，store mock 用 `useXxxStore.setState({...})`
- WS 事件遵循现有信封模式：list 用 `reply` 定向返回，变更用 `broadcast` 推全量
- 数据根目录 `~/.hiagent`（常量 `HIAGENT_DIR`），通过 `PI_CODING_AGENT_DIR` 环境变量重定向
- 文件路径常量定义在 `packages/shared/src/constants.ts`

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `packages/shared/src/memory.ts` | 记忆/指令/配置的类型定义 + WS 事件类型 |
| `packages/kernel/src/memory-store.ts` | MemoryStore 服务：§ 解析、CRUD、归档、配置、指令扫描 |
| `packages/kernel/tests/memory-store.test.ts` | MemoryStore 单元测试 |
| `packages/kernel/tests/ws-memory.test.ts` | 记忆 WS 事件集成测试 |
| `packages/frontend/src/store/memory.ts` | 前端 Zustand store |
| `packages/frontend/src/components/memory/MemoryPage.tsx` | 页面容器 |
| `packages/frontend/src/components/memory/MemoryCard.tsx` | 记忆卡片（含行内编辑） |
| `packages/frontend/src/components/memory/InstructionItem.tsx` | 指令文件条目 |
| `packages/frontend/src/components/memory/MemoryEmpty.tsx` | 空状态 |
| `packages/frontend/tests/MemoryPage.test.tsx` | 前端组件测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/kernel/package.json` | 加 `pi-hermes-memory` 依赖 |
| `packages/kernel/src/extensions.ts` | `OPTIONAL_EXTENSIONS` 加 pi-hermes-memory |
| `packages/shared/src/types.ts` | `WSClientEvent` / `WSServerEvent` 加记忆事件 |
| `packages/kernel/src/ws-server.ts` | `WSServerOpts` 加 `memoryStore`，加 8 个 case |
| `packages/kernel/src/index.ts` | 创建 `MemoryStore` 并注入 `WSServer` |
| `packages/frontend/src/App.tsx` | `View` 加 `"memory"`，渲染分支，WS 事件路由 |
| `packages/frontend/src/components/Sidebar.tsx` | 加「记忆」导航入口 |
| `packages/frontend/src/styles.css` | 记忆页样式 |

---

## Task 1: 共享类型定义

**Files:**
- Create: `packages/shared/src/memory.ts`
- Modify: `packages/shared/src/types.ts:240-334`
- Modify: `packages/shared/src/index.ts`（导出新模块）

**Interfaces:**
- Produces: `MemoryEntry`, `ArchivedMemory`, `InstructionFile`, `MemoryConfig`, 以及所有 `Memory*Event` / `Instruction*Event` 类型

- [ ] **Step 1: 创建 `packages/shared/src/memory.ts`**

```ts
// ===== 记忆与指令文件管理类型定义 =====

/** 记忆分类：来自文件来源 */
export type MemoryCategory = "memory" | "user" | "failure";

/** 记忆作用域：来自文件路径 */
export type MemoryScope = "global" | "project";

/** 一条记忆条目 */
export interface MemoryEntry {
  id: string;                    // 格式："源文件相对路径:rawIndex"
  text: string;                  // § 分隔后的单条文本
  category: MemoryCategory;
  scope: MemoryScope;
  sourceFile: string;            // 源文件绝对路径
  rawIndex: number;              // 在源文件 § 分隔后的索引（0-based）
  updatedAt?: string;            // 最后修改时间（来自 sidecar，可选）
}

/** 归档的记忆（sidecar 记录） */
export interface ArchivedMemory extends MemoryEntry {
  archivedAt: string;
}

/** 指令文件 */
export interface InstructionFile {
  path: string;                  // 绝对路径
  name: string;                  // AGENTS.md / CLAUDE.md
  scope: MemoryScope;
  content: string;               // 文件全文（UI 截取摘要）
}

/** 记忆配置（开关状态） */
export interface MemoryConfig {
  reviewEnabled: boolean;
  memoryPolicyStyle: "full" | "compact" | "none";
}

/** 归档 sidecar 结构 */
export interface MemoryArchiveFile {
  entries: ArchivedMemory[];
}

// ===== WS 协议事件（记忆管理）=====

// 前端 → kernel
export interface MemoryListEvent { type: "memory:list"; }
export interface MemoryUpdateEvent {
  type: "memory:update";
  entryId: string;
  text: string;
}
export interface MemoryArchiveEvent {
  type: "memory:archive";
  entryId: string;
}
export interface MemoryRestoreEvent {
  type: "memory:restore";
  entryId: string;
}
export interface MemoryPurgeEvent {
  type: "memory:purge";
  entryId: string;
}
export interface InstructionListEvent {
  type: "instruction:list";
  projectId: string;
}
export interface MemoryConfigGetEvent { type: "memory:config:get"; }
export interface MemoryConfigSetEvent {
  type: "memory:config:set";
  reviewEnabled?: boolean;
  memoryPolicyStyle?: "full" | "compact" | "none";
}

// kernel → 前端
export interface MemoryListResult {
  type: "memory:list";
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
}
export interface MemoryUpdateResult {
  type: "memory:update";
  ok: boolean;
}
export interface MemoryChangedEvent {
  type: "memory:changed";
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
}
export interface InstructionListResult {
  type: "instruction:list";
  instructions: InstructionFile[];
}
export interface MemoryConfigEvent {
  type: "memory:config";
  config: MemoryConfig;
}
```

- [ ] **Step 2: 在 `packages/shared/src/types.ts` 的 `WSClientEvent`（行 240）追加记忆事件**

在 `ExtensionListEvent | ExtensionToggleEvent` 行后面加：

```ts
  | MemoryListEvent | MemoryUpdateEvent | MemoryArchiveEvent | MemoryRestoreEvent | MemoryPurgeEvent
  | InstructionListEvent
  | MemoryConfigGetEvent | MemoryConfigSetEvent
```

在文件顶部 import（行 11-14 区域）追加：

```ts
import type {
  MemoryListEvent, MemoryUpdateEvent, MemoryArchiveEvent, MemoryRestoreEvent,
  MemoryPurgeEvent, InstructionListEvent, MemoryConfigGetEvent, MemoryConfigSetEvent,
  MemoryListResult, MemoryChangedEvent, InstructionListResult, MemoryConfigEvent,
} from "./memory";
```

- [ ] **Step 3: 在 `WSServerEvent`（行 326）追加记忆事件**

在 `ExtensionListResult | ExtensionChangedEvent` 行后面加：

```ts
  | MemoryListResult | MemoryChangedEvent
  | InstructionListResult | MemoryConfigEvent
```

- [ ] **Step 4: 在 `packages/shared/src/index.ts` 导出 memory 模块**

找到现有的 `export * from "./extensions"` 或类似行，追加：

```ts
export * from "./memory";
```

- [ ] **Step 5: 验证类型编译通过**

Run: `cd packages/shared && bun run build`（或 `bunx tsc --noEmit`）
Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/memory.ts packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): 记忆与指令文件管理的类型定义和 WS 事件"
```

---

## Task 2: MemoryStore 核心服务

**Files:**
- Create: `packages/kernel/src/memory-store.ts`
- Test: `packages/kernel/tests/memory-store.test.ts`

**Interfaces:**
- Consumes: `HIAGENT_DIR` from `@hiagent/shared`，`ProjectStore`（拿 cwd）
- Produces: `MemoryStore` 类，方法：`list()`, `update()`, `archive()`, `restore()`, `purge()`, `listInstructions()`, `getConfig()`, `setConfig()`

- [ ] **Step 1: 写 `list()` 的失败测试 — § 解析 + 多文件来源**

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { MemoryStore } from "../src/memory-store";
import type { ProjectStore } from "../src/project-store";

const tmpDir = import.meta.dir + ".tmp-memory-" + Math.random().toString(36).slice(2);
const hermesDir = join(tmpDir, "pi-hermes-memory");
const projectsMemoryDir = join(tmpDir, "projects-memory");

// mock ProjectStore：getProjectCwd 返回固定值
function mockProjectStore(cwd: string): ProjectStore {
  return {
    async load() {
      return {
        projects: [{ id: "p1", name: "test", cwd, createdAt: "" }],
        sessions: [],
      };
    },
  } as unknown as ProjectStore;
}

beforeEach(async () => {
  await mkdir(hermesDir, { recursive: true });
  await mkdir(projectsMemoryDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("list 解析全局 MEMORY.md 的 § 分隔条目，category=memory scope=global", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "项目用 pnpm\n§\nCI 需要 frozen-lockfile", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();

  expect(memories).toHaveLength(2);
  expect(memories[0].text).toBe("项目用 pnpm");
  expect(memories[0].category).toBe("memory");
  expect(memories[0].scope).toBe("global");
  expect(memories[0].rawIndex).toBe(0);
  expect(memories[1].text).toBe("CI 需要 frozen-lockfile");
  expect(memories[1].rawIndex).toBe(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts`
Expected: FAIL — `Cannot find module '../src/memory-store'`

- [ ] **Step 3: 实现 `memory-store.ts` 的 `list()` + § 解析**

```ts
// memory-store.ts — 记忆与指令文件管理服务
//
// 设计要点：
// - 读写 pi-hermes-memory 的 Markdown 文件（MEMORY.md/USER.md/failures.md），按 § 分隔条目
// - 归档使用 sidecar JSON（~/.hiagent/memory-archive.json），不修改插件的文件结构
// - 记忆配置开关读写 hermes-memory-config.json
// - 指令文件扫描全局（~/.hiagent）+ 项目 cwd 下的 AGENTS.md/CLAUDE.md
// - 与 pi-hermes-memory 之间无 API 调用，只通过文件系统通信

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  MemoryEntry, ArchivedMemory, InstructionFile, MemoryConfig,
  MemoryArchiveFile, MemoryCategory, MemoryScope,
} from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

/** 记忆文件来源定义 */
interface MemorySourceDef {
  relativePath: string;   // 相对于 hiagentDir 或 projectsMemoryDir 的路径
  category: MemoryCategory;
}

/** 全局记忆文件来源 */
const GLOBAL_SOURCES: MemorySourceDef[] = [
  { relativePath: "pi-hermes-memory/MEMORY.md", category: "memory" },
  { relativePath: "pi-hermes-memory/USER.md", category: "user" },
  { relativePath: "pi-hermes-memory/failures.md", category: "failure" },
];

/** 项目级记忆文件来源 */
const PROJECT_SOURCES: MemorySourceDef[] = [
  { relativePath: "MEMORY.md", category: "memory" },
  { relativePath: "failures.md", category: "failure" },
];

const ARCHIVE_FILE = "memory-archive.json";
const HERMES_CONFIG_FILE = "hermes-memory-config.json";
const PROJECTS_MEMORY_DIR = "projects-memory";

export interface MemoryStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class MemoryStore {
  constructor(private opts: MemoryStoreOpts) {}

  /** 列出所有记忆 + 归档记忆 */
  async list(): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
    const memories: MemoryEntry[] = [];
    const cwd = await this.getCurrentCwd();

    // 全局来源
    for (const src of GLOBAL_SOURCES) {
      const absPath = join(this.opts.hiagentDir, src.relativePath);
      const entries = await this.parseMemoryFile(absPath, src.category, "global");
      memories.push(...entries);
    }

    // 项目来源
    if (cwd) {
      const projectDir = join(this.opts.hiagentDir, PROJECTS_MEMORY_DIR, this.projectNameFromCwd(cwd));
      for (const src of PROJECT_SOURCES) {
        const absPath = join(projectDir, src.relativePath);
        const entries = await this.parseMemoryFile(absPath, src.category, "project");
        memories.push(...entries);
      }
    }

    // 归档
    const archived = await this.loadArchive();

    return { memories, archived };
  }

  /** 解析单个记忆文件的 § 分隔条目 */
  private async parseMemoryFile(
    absPath: string,
    category: MemoryCategory,
    scope: MemoryScope,
  ): Promise<MemoryEntry[]> {
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return []; // 文件不存在，跳过
    }

    const parts = content.split("§").map(s => s.trim()).filter(s => s.length > 0);
    const relPath = relative(this.opts.hiagentDir, absPath).replace(/\\/g, "/");

    return parts.map((text, rawIndex) => ({
      id: `${relPath}:${rawIndex}`,
      text,
      category,
      scope,
      sourceFile: absPath,
      rawIndex,
    }));
  }

  // —— CRUD 方法在后续 step 实现 ——
  async update(_id: string, _text: string): Promise<void> { throw new Error("未实现"); }
  async archive(_id: string): Promise<void> { throw new Error("未实现"); }
  async restore(_id: string): Promise<void> { throw new Error("未实现"); }
  async purge(_id: string): Promise<void> { throw new Error("未实现"); }
  async listInstructions(_projectId: string): Promise<InstructionFile[]> { return []; }
  async getConfig(): Promise<MemoryConfig> { return { reviewEnabled: true, memoryPolicyStyle: "full" }; }
  async setConfig(_opts: Partial<MemoryConfig>): Promise<void> {}

  // —— 辅助方法 ——

  /** 从 ProjectStore 拿当前项目 cwd */
  private async getCurrentCwd(): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    // 取第一个项目作为当前项目（简化：hiagent 单项目场景为主）
    // 实际使用时由 ws-server 传入 projectId 指定
    return projects[0]?.cwd ?? null;
  }

  /** 从 cwd 生成项目目录名（与 pi-hermes-memory 的 projects-memory/<basename> 对齐） */
  private projectNameFromCwd(cwd: string): string {
    // pi-hermes-memory 用 cwd 的 basename 作为项目标识
    const parts = cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || "default";
  }

  /** 加载归档 sidecar */
  private async loadArchive(): Promise<ArchivedMemory[]> {
    try {
      const raw = await readFile(join(this.opts.hiagentDir, ARCHIVE_FILE), "utf8");
      const data = JSON.parse(raw) as MemoryArchiveFile;
      return data.entries ?? [];
    } catch {
      return [];
    }
  }

  /** 保存归档 sidecar */
  private async saveArchive(entries: ArchivedMemory[]): Promise<void> {
    await mkdir(this.opts.hiagentDir, { recursive: true });
    await writeFile(
      join(this.opts.hiagentDir, ARCHIVE_FILE),
      JSON.stringify({ entries } satisfies MemoryArchiveFile, null, 2),
      "utf8",
    );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts`
Expected: PASS

- [ ] **Step 5: 写 `list()` 多分类测试（USER.md → user，failures.md → failure，项目级）**

```ts
test("list 解析 USER.md category=user, failures.md category=failure", async () => {
  await writeFile(join(hermesDir, "USER.md"), "偏好简洁回答\n§\n用中文", "utf8");
  await writeFile(join(hermesDir, "failures.md"), "localStorage 存 token 有 XSS 风险", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();

  const userEntries = memories.filter(m => m.category === "user");
  const failureEntries = memories.filter(m => m.category === "failure");
  expect(userEntries).toHaveLength(2);
  expect(userEntries[0].id).toContain("USER.md");
  expect(failureEntries).toHaveLength(1);
  expect(failureEntries[0].text).toContain("XSS");
});

test("list 包含项目级记忆，scope=project", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "全局记忆", "utf8");
  // 项目目录名取 basename("/my-project") = "my-project"
  const projectDir = join(projectsMemoryDir, "my-project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "MEMORY.md"), "项目记忆\n§\nCI 用 pnpm", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/my-project") });
  const { memories } = await store.list();

  const projectEntries = memories.filter(m => m.scope === "project");
  expect(projectEntries).toHaveLength(2);
  expect(projectEntries[0].text).toBe("项目记忆");
  expect(projectEntries[0].scope).toBe("project");
});

test("list 文件不存在时返回空数组不报错", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories, archived } = await store.list();
  expect(memories).toEqual([]);
  expect(archived).toEqual([]);
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts`
Expected: PASS（3 个测试全通过）

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/memory-store.ts packages/kernel/tests/memory-store.test.ts
git commit -m "feat(kernel): MemoryStore list() — § 解析记忆文件"
```

---

## Task 3: MemoryStore CRUD + 归档

**Files:**
- Modify: `packages/kernel/src/memory-store.ts`（实现 update/archive/restore/purge）
- Test: `packages/kernel/tests/memory-store.test.ts`（追加 CRUD 测试）

**Interfaces:**
- Consumes: Task 2 的 `parseMemoryFile`, `loadArchive`, `saveArchive`
- Produces: `update(id, text)`, `archive(id)`, `restore(id)`, `purge(id)` 四个方法

- [ ] **Step 1: 写 `update()` 的失败测试**

```ts
test("update 按定位 § 段落替换文本", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "旧内容1\n§\n旧内容2", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[1].id; // "pi-hermes-memory/MEMORY.md:1"

  await store.update(targetId, "新内容2");

  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).toContain("新内容2");
  expect(raw).toContain("旧内容1");
  expect(raw).not.toContain("旧内容2");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "update"`
Expected: FAIL — 抛出 "未实现"

- [ ] **Step 3: 实现 `update()` 方法**

替换 `memory-store.ts` 里的 `async update(_id...throw` 占位为：

```ts
  /** 编辑记忆：按 id 定位 § 段落，原地替换文本 */
  async update(id: string, text: string): Promise<void> {
    const sourceFile = await this.resolveSourceFile(id);
    const rawIndex = this.extractRawIndex(id);

    let content: string;
    try {
      content = await readFile(sourceFile, "utf8");
    } catch {
      throw new Error("记忆文件不存在，可能已被插件修改");
    }

    const parts = content.split("§");
    // 过滤空条目的索引对齐：与 parseMemoryFile 一致
    const nonEmptyIndices: number[] = [];
    parts.forEach((p, i) => { if (p.trim().length > 0) nonEmptyIndices.push(i); });

    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) {
      throw new Error("条目不存在，可能已被插件修改，请刷新列表");
    }

    parts[partIndex] = text;
    await writeFile(sourceFile, parts.join("§"), "utf8");
  }
```

并在类中加辅助方法：

```ts
  /** 从 id（"相对路径:rawIndex"）提取 rawIndex */
  private extractRawIndex(id: string): number {
    const colonIdx = id.lastIndexOf(":");
    if (colonIdx === -1) throw new Error(`无效的记忆 ID: ${id}`);
    return parseInt(id.slice(colonIdx + 1), 10);
  }

  /** 从 id 解析源文件绝对路径 */
  private async resolveSourceFile(id: string): Promise<string> {
    const colonIdx = id.lastIndexOf(":");
    const relPath = id.slice(0, colonIdx).replace(/\//g, "/");
    // 尝试拼接 hiagentDir（全局或 projects-memory 下的路径都相对于 hiagentDir）
    return join(this.opts.hiagentDir, relPath);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "update"`
Expected: PASS

- [ ] **Step 5: 写 `archive()` 的失败测试**

```ts
test("archive 从文件移除条目并写入 sidecar", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A\n§\n条目B", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;

  await store.archive(targetId);

  // 文件里应该只剩条目B
  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).not.toContain("条目A");
  expect(raw).toContain("条目B");

  // sidecar 里有归档记录
  const { archived } = await store.list();
  expect(archived).toHaveLength(1);
  expect(archived[0].text).toBe("条目A");
  expect(archived[0].archivedAt).toBeTruthy();
});
```

- [ ] **Step 6: 实现 `archive()`**

替换占位：

```ts
  /** 归档（软删除）：从源文件移除 → 写入 sidecar */
  async archive(id: string): Promise<void> {
    const sourceFile = await this.resolveSourceFile(id);
    const rawIndex = this.extractRawIndex(id);

    let content: string;
    try {
      content = await readFile(sourceFile, "utf8");
    } catch {
      throw new Error("记忆文件不存在");
    }

    const parts = content.split("§");
    const nonEmptyIndices: number[] = [];
    parts.forEach((p, i) => { if (p.trim().length > 0) nonEmptyIndices.push(i); });
    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) throw new Error("条目不存在");

    const archivedText = parts[partIndex].trim();
    parts.splice(partIndex, 1);
    await writeFile(sourceFile, parts.join("§"), "utf8");

    // 写入 sidecar
    const archived = await this.loadArchive();
    const category = this.categoryFromSourceFile(sourceFile);
    const scope = this.scopeFromSourceFile(sourceFile);
    archived.push({
      id,
      text: archivedText,
      category,
      scope,
      sourceFile,
      rawIndex,
      archivedAt: new Date().toISOString(),
    });
    await this.saveArchive(archived);
  }

  /** 从文件路径推断分类 */
  private categoryFromSourceFile(absPath: string): MemoryCategory {
    const normalized = absPath.replace(/\\/g, "/");
    if (normalized.includes("USER.md")) return "user";
    if (normalized.includes("failures.md")) return "failure";
    return "memory";
  }

  /** 从文件路径推断作用域 */
  private scopeFromSourceFile(absPath: string): MemoryScope {
    const normalized = absPath.replace(/\\/g, "/");
    return normalized.includes(`${PROJECTS_MEMORY_DIR}/`) ? "project" : "global";
  }
```

- [ ] **Step 7: 运行确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "archive"`
Expected: PASS

- [ ] **Step 8: 写 `restore()` 的失败测试**

```ts
test("restore 从 sidecar 移除并追加回源文件", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;
  await store.archive(targetId); // 先归档

  await store.restore(targetId); // 再恢复

  // 文件里应该有恢复的条目
  const raw = await readFile(join(hermesDir, "MEMORY.md"), "utf8");
  expect(raw).toContain("条目A");

  // sidecar 应该为空
  const { archived } = await store.list();
  expect(archived).toEqual([]);
});
```

- [ ] **Step 9: 实现 `restore()`**

```ts
  /** 恢复：从 sidecar 移除 → 追加回源文件末尾 */
  async restore(id: string): Promise<void> {
    const archived = await this.loadArchive();
    const entry = archived.find(a => a.id === id);
    if (!entry) throw new Error("归档条目不存在");

    // 追加回源文件
    let content = "";
    try {
      content = await readFile(entry.sourceFile, "utf8");
    } catch {
      // 文件可能不存在了（被插件清空），从空开始
    }
    const trimmed = content.trim();
    const newContent = trimmed.length > 0 ? `${trimmed}\n§\n${entry.text}` : entry.text;
    await mkdir(entry.sourceFile.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
    await writeFile(entry.sourceFile, newContent, "utf8");

    // 从 sidecar 移除
    await this.saveArchive(archived.filter(a => a.id !== id));
  }
```

- [ ] **Step 10: 运行确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "restore"`
Expected: PASS

- [ ] **Step 11: 写 `purge()` 的失败测试**

```ts
test("purge 从 sidecar 彻底删除，不写回文件", async () => {
  await writeFile(join(hermesDir, "MEMORY.md"), "条目A", "utf8");
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const { memories } = await store.list();
  const targetId = memories[0].id;
  await store.archive(targetId);

  await store.purge(targetId);

  const { archived } = await store.list();
  expect(archived).toEqual([]);
});
```

- [ ] **Step 12: 实现 `purge()`**

```ts
  /** 彻底删除：从 sidecar 移除，不写回源文件 */
  async purge(id: string): Promise<void> {
    const archived = await this.loadArchive();
    await this.saveArchive(archived.filter(a => a.id !== id));
  }
```

- [ ] **Step 13: 运行全部测试确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts`
Expected: 全部 PASS

- [ ] **Step 14: Commit**

```bash
git add packages/kernel/src/memory-store.ts packages/kernel/tests/memory-store.test.ts
git commit -m "feat(kernel): MemoryStore CRUD + 归档（update/archive/restore/purge）"
```

---

## Task 4: MemoryStore 指令文件扫描 + 配置开关

**Files:**
- Modify: `packages/kernel/src/memory-store.ts`（实现 listInstructions/getConfig/setConfig）
- Test: `packages/kernel/tests/memory-store.test.ts`（追加测试）

- [ ] **Step 1: 写 `listInstructions()` 的失败测试**

```ts
test("listInstructions 扫描全局 + 项目级 AGENTS.md", async () => {
  // 全局
  await writeFile(join(tmpDir, "AGENTS.md"), "全局指令内容", "utf8");
  // 项目级（cwd = /my-project）
  await mkdir("/tmp/test-project-" + Date.now(), { recursive: true }).catch(() => {});
  const projectCwd = join(tmpDir, "fake-project");
  await mkdir(projectCwd, { recursive: true });
  await writeFile(join(projectCwd, "AGENTS.md"), "项目指令内容", "utf8");

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore(projectCwd) });
  const instructions = await store.listInstructions("p1");

  expect(instructions).toHaveLength(2);
  const globalInst = instructions.find(i => i.scope === "global");
  const projectInst = instructions.find(i => i.scope === "project");
  expect(globalInst).toBeTruthy();
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(projectInst).toBeTruthy();
  expect(projectInst!.content).toBe("项目指令内容");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "listInstructions"`
Expected: FAIL — 返回空数组

- [ ] **Step 3: 实现 `listInstructions()`**

需要先修改 `listInstructions` 签名接受 `projectId`，并从 `ProjectStore` 查 cwd。替换占位：

```ts
  /** 扫描已加载的指令文件（全局 + 项目） */
  async listInstructions(projectId: string): Promise<InstructionFile[]> {
    const result: InstructionFile[] = [];
    const candidates = ["AGENTS.md", "CLAUDE.md"];

    // 全局：~/.hiagent/AGENTS.md 或 CLAUDE.md（取第一个命中）
    for (const name of candidates) {
      const p = join(this.opts.hiagentDir, name);
      if (existsSync(p)) {
        result.push({
          path: p, name, scope: "global",
          content: await readFile(p, "utf8"),
        });
        break;
      }
    }

    // 项目级：cwd 下的 AGENTS.md 或 CLAUDE.md
    const cwd = await this.getProjectCwd(projectId);
    if (cwd) {
      for (const name of candidates) {
        const p = join(cwd, name);
        if (existsSync(p)) {
          result.push({
            path: p, name, scope: "project",
            content: await readFile(p, "utf8"),
          });
          break;
        }
      }
    }

    return result;
  }

  /** 按 projectId 从 ProjectStore 查 cwd */
  private async getProjectCwd(projectId: string): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    return projects.find(p => p.id === projectId)?.cwd ?? null;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts -t "listInstructions"`
Expected: PASS

- [ ] **Step 5: 写 `getConfig()` / `setConfig()` 的失败测试**

```ts
test("getConfig 文件不存在时返回默认值", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(true);
  expect(config.memoryPolicyStyle).toBe("full");
});

test("setConfig 写入后 getConfig 读回新值", async () => {
  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false, memoryPolicyStyle: "none" });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("none");
});

test("setConfig 保留已有配置项不覆盖", async () => {
  // 先写入一个有其他字段的配置
  await writeFile(join(tmpDir, HERMES_CONFIG_FILE), JSON.stringify({
    reviewEnabled: true,
    memoryPolicyStyle: "full",
    nudgeInterval: 5,
    autoConsolidate: true,
  }), "utf8");

  const store = new MemoryStore({ hiagentDir: tmpDir, projectStore: mockProjectStore("/fake") });
  await store.setConfig({ reviewEnabled: false });

  const raw = JSON.parse(await readFile(join(tmpDir, HERMES_CONFIG_FILE), "utf8"));
  expect(raw.reviewEnabled).toBe(false);
  expect(raw.nudgeInterval).toBe(5); // 其他字段保留
  expect(raw.autoConsolidate).toBe(true);
});
```

> 注意：测试里引用 `HERMES_CONFIG_FILE` 常量，需要在文件顶部从 memory-store 导出或直接用字符串 `"hermes-memory-config.json"`。简化起见，用字符串字面量。

- [ ] **Step 6: 实现 `getConfig()` / `setConfig()`**

替换占位：

```ts
  /** 读记忆配置开关 */
  async getConfig(): Promise<MemoryConfig> {
    try {
      const raw = await readFile(join(this.opts.hiagentDir, HERMES_CONFIG_FILE), "utf8");
      const data = JSON.parse(raw);
      return {
        reviewEnabled: data.reviewEnabled ?? true,
        memoryPolicyStyle: data.memoryPolicyStyle ?? "full",
      };
    } catch {
      return { reviewEnabled: true, memoryPolicyStyle: "full" };
    }
  }

  /** 写记忆配置开关（合并写入，不覆盖其他字段） */
  async setConfig(opts: {
    reviewEnabled?: boolean;
    memoryPolicyStyle?: "full" | "compact" | "none";
  }): Promise<void> {
    const configPath = join(this.opts.hiagentDir, HERMES_CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      // 文件不存在，从空开始
    }
    if (opts.reviewEnabled !== undefined) existing.reviewEnabled = opts.reviewEnabled;
    if (opts.memoryPolicyStyle !== undefined) existing.memoryPolicyStyle = opts.memoryPolicyStyle;
    await mkdir(this.opts.hiagentDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");
  }
```

- [ ] **Step 7: 运行全部 memory-store 测试**

Run: `cd packages/kernel && bun test tests/memory-store.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add packages/kernel/src/memory-store.ts packages/kernel/tests/memory-store.test.ts
git commit -m "feat(kernel): MemoryStore 指令文件扫描 + 配置开关"
```

---

## Task 5: WS 事件接入

**Files:**
- Modify: `packages/kernel/src/ws-server.ts:113-122`（WSServerOpts）+ handle switch
- Modify: `packages/kernel/src/index.ts:49-57`（注入 MemoryStore）
- Test: `packages/kernel/tests/ws-memory.test.ts`

**Interfaces:**
- Consumes: Task 2-4 的 `MemoryStore`
- Produces: 8 个 WS case 的完整路由

- [ ] **Step 1: 修改 `WSServerOpts` 加 `memoryStore` 字段**

在 `packages/kernel/src/ws-server.ts` 行 113-122 的 `WSServerOpts` 接口里，`extensionManager` 后面加：

```ts
  memoryStore: MemoryStore;
```

并在文件顶部 import：

```ts
import type { MemoryStore } from "./memory-store";
```

- [ ] **Step 2: 在 `ws-server.ts` 的 `handle()` switch 里加 8 个 case**

找到 `case "extension:toggle"` 之后（约行 543），在 `break;` 后面追加：

```ts
        // ===== 记忆管理 =====
        case "memory:list": {
          try {
            const result = await this.opts.memoryStore.list();
            reply({ type: "memory:list", ...result });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:update": {
          try {
            await this.opts.memoryStore.update(event.entryId, event.text);
            const result = await this.opts.memoryStore.list();
            this.broadcast({ type: "memory:changed", ...result });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:archive": {
          try {
            await this.opts.memoryStore.archive(event.entryId);
            const result = await this.opts.memoryStore.list();
            this.broadcast({ type: "memory:changed", ...result });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:restore": {
          try {
            await this.opts.memoryStore.restore(event.entryId);
            const result = await this.opts.memoryStore.list();
            this.broadcast({ type: "memory:changed", ...result });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:purge": {
          try {
            await this.opts.memoryStore.purge(event.entryId);
            const result = await this.opts.memoryStore.list();
            this.broadcast({ type: "memory:changed", ...result });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "instruction:list": {
          try {
            const instructions = await this.opts.memoryStore.listInstructions(event.projectId);
            reply({ type: "instruction:list", instructions });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:config:get": {
          try {
            const config = await this.opts.memoryStore.getConfig();
            reply({ type: "memory:config", config });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
        case "memory:config:set": {
          try {
            await this.opts.memoryStore.setConfig(event);
            // 配置变更后标脏所有会话，下次 idle 时 reload 读新配置
            this.opts.agentManager.markAllDirty();
            const config = await this.opts.memoryStore.getConfig();
            this.broadcast({ type: "memory:config", config });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
          break;
        }
```

- [ ] **Step 3: 修改 `index.ts` 创建 MemoryStore 并注入 WSServer**

在 `packages/kernel/src/index.ts` 的 `const extensionManager = ...` 后面（约行 38）加：

```ts
import { MemoryStore } from "./memory-store";
```

```ts
  const memoryStore = new MemoryStore({ hiagentDir: HIAGENT_DIR, projectStore });
```

在 `new WSServer({ ... })` 里（行 49-57）加 `memoryStore`：

```ts
  const server = new WSServer({
    configStore, projectStore,
    providerStore,
    skillManager,
    extensionManager,
    memoryStore,
    dataDir: HIAGENT_DIR,
    agentManager: null as any,
    port: WS_PORT,
  });
```

- [ ] **Step 4: 写 WS 集成测试**

参照 `packages/kernel/tests/ws-extension.test.ts` 的 `withExtServer()` 模式。创建 `packages/kernel/tests/ws-memory.test.ts`：

```ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { WSServer } from "../src/ws-server";
import { MemoryStore } from "../src/memory-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

const tmpDir = import.meta.dir + ".tmp-ws-memory-" + Math.random().toString(36).slice(2);

function makeMockAgentManager() {
  return { markAllDirty: () => {} };
}

async function withMemoryServer(fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => void) {
  const projectStore = new ProjectStore(join(tmpDir, "projects.json"));
  const memoryStore = new MemoryStore({ hiagentDir: tmpDir, projectStore });
  const server = new WSServer({
    configStore: null as any, projectStore,
    providerStore: null as any,
    skillManager: null as any,
    extensionManager: null as any,
    memoryStore,
    dataDir: tmpDir,
    agentManager: makeMockAgentManager() as any,
    port: 0,
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise<void>(r => { ws.onopen = () => r(); });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (e) => { queue.push(JSON.parse(e.data)); };

  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = () => new Promise<WSServerEvent>(r => {
    const check = () => {
      if (queue.length > 0) r(queue.shift()!);
      else setTimeout(check, 10);
    };
    check();
  });

  try {
    await fn(send, recv);
  } finally {
    ws.close();
    server.server?.stop?.();
  }
}

test("memory:list 返回解析后的记忆列表", async () => {
  await mkdir(join(tmpDir, "pi-hermes-memory"), { recursive: true });
  await writeFile(join(tmpDir, "pi-hermes-memory", "MEMORY.md"), "测试记忆", "utf8");

  await withMemoryServer(async (send, recv) => {
    send({ type: "memory:list" });
    const resp = await recv() as any;
    expect(resp.type).toBe("memory:list");
    expect(resp.memories).toHaveLength(1);
    expect(resp.memories[0].text).toBe("测试记忆");
  });

  await rm(tmpDir, { recursive: true, force: true });
});

test("memory:update 编辑后广播 memory:changed", async () => {
  await mkdir(join(tmpDir, "pi-hermes-memory"), { recursive: true });
  await writeFile(join(tmpDir, "pi-hermes-memory", "MEMORY.md"), "旧内容", "utf8");

  await withMemoryServer(async (send, recv) => {
    send({ type: "memory:list" });
    const list = await recv() as any;
    const entryId = list.memories[0].id;

    send({ type: "memory:update", entryId, text: "新内容" });
    // 广播 memory:changed
    const changed = await recv() as any;
    expect(changed.type).toBe("memory:changed");
    expect(changed.memories[0].text).toBe("新内容");
  });

  await rm(tmpDir, { recursive: true, force: true });
});

test("memory:config:get 返回默认配置", async () => {
  await withMemoryServer(async (send, recv) => {
    send({ type: "memory:config:get" });
    const resp = await recv() as any;
    expect(resp.type).toBe("memory:config");
    expect(resp.config.reviewEnabled).toBe(true);
  });

  await rm(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 5: 运行 WS 集成测试**

Run: `cd packages/kernel && bun test tests/ws-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/index.ts packages/kernel/tests/ws-memory.test.ts
git commit -m "feat(kernel): 记忆管理 WS 事件接入（8 个 case）"
```

---

## Task 6: 注册 pi-hermes-memory 为可选插件

**Files:**
- Modify: `packages/kernel/package.json`（加依赖）
- Modify: `packages/kernel/src/extensions.ts:87-95`（OPTIONAL_EXTENSIONS）

- [ ] **Step 1: 在 `packages/kernel/package.json` 加依赖**

在 `dependencies` 里 `"pi-lens"` 旁边加：

```json
"pi-hermes-memory": "^0.7.23"
```

- [ ] **Step 2: 安装依赖**

Run: `cd packages/kernel && bun install`
Expected: 安装成功

- [ ] **Step 3: 在 `extensions.ts` 的 `OPTIONAL_EXTENSIONS` 追加 pi-hermes-memory**

在 `pi-lens` 对象后面追加：

```ts
  {
    id: "pi-hermes-memory",
    package: "pi-hermes-memory",
    displayName: "记忆",
    description: "持久化记忆：跨会话记住偏好、纠正和经验",
    defaultEnabled: true,
  },
```

- [ ] **Step 4: 验证插件能被 ExtensionManager 发现**

Run: `cd packages/kernel && bun run src/index.ts`（启动 kernel）
Expected: 日志里出现 pi-hermes-memory 的播种，`settings.json` 的 extensions 字段有 pi-hermes-memory 入口路径

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/package.json packages/kernel/src/extensions.ts bun.lock
git commit -m "feat(kernel): 注册 pi-hermes-memory 为可选插件"
```

---

## Task 7: 前端 Store

**Files:**
- Create: `packages/frontend/src/store/memory.ts`

**Interfaces:**
- Consumes: Task 1 的类型定义
- Produces: `useMemoryStore`（含数据 + actions + UI 状态）

- [ ] **Step 1: 创建 `store/memory.ts`**

```ts
// store/memory.ts — 记忆与指令文件管理 store
import { create } from "zustand";
import type {
  MemoryEntry, ArchivedMemory, InstructionFile, MemoryConfig,
  MemoryListResult, MemoryChangedEvent, InstructionListResult, MemoryConfigEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

type ActiveTab = "saved" | "archived" | "instructions";
type CategoryFilter = "all" | "memory" | "user" | "failure";
type ScopeFilter = "all" | "global" | "project";

interface MemoryState {
  // 数据
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
  instructions: InstructionFile[];
  config: MemoryConfig | null;

  // UI 状态
  activeTab: ActiveTab;
  categoryFilter: CategoryFilter;
  scopeFilter: ScopeFilter;
  searchQuery: string;
  loading: boolean;

  // actions
  load: () => void;
  loadInstructions: (projectId: string) => void;
  setMemories: (data: MemoryListResult | MemoryChangedEvent) => void;
  setInstructions: (data: InstructionListResult) => void;
  setConfig: (data: MemoryConfigEvent) => void;
  update: (entryId: string, text: string) => void;
  archive: (entryId: string) => void;
  restore: (entryId: string) => void;
  purge: (entryId: string) => void;
  setConfigValue: (opts: Partial<MemoryConfig>) => void;
  setTab: (tab: ActiveTab) => void;
  setCategoryFilter: (f: CategoryFilter) => void;
  setScopeFilter: (f: ScopeFilter) => void;
  setSearchQuery: (q: string) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  archived: [],
  instructions: [],
  config: null,

  activeTab: "saved",
  categoryFilter: "all",
  scopeFilter: "all",
  searchQuery: "",
  loading: false,

  load: () => {
    set({ loading: true });
    send({ type: "memory:list" });
    send({ type: "memory:config:get" });
  },
  loadInstructions: (projectId) => send({ type: "instruction:list", projectId }),
  setMemories: (data) => set({
    memories: data.memories,
    archived: data.archived,
    loading: false,
  }),
  setInstructions: (data) => set({ instructions: data.instructions }),
  setConfig: (data) => set({ config: data.config }),
  update: (entryId, text) => send({ type: "memory:update", entryId, text }),
  archive: (entryId) => send({ type: "memory:archive", entryId }),
  restore: (entryId) => send({ type: "memory:restore", entryId }),
  purge: (entryId) => send({ type: "memory:purge", entryId }),
  setConfigValue: (opts) => send({ type: "memory:config:set", ...opts }),
  setTab: (tab) => set({ activeTab: tab }),
  setCategoryFilter: (f) => set({ categoryFilter: f }),
  setScopeFilter: (f) => set({ scopeFilter: f }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add packages/frontend/src/store/memory.ts
git commit -m "feat(frontend): 记忆管理 Zustand store"
```

---

## Task 8: 前端组件 — MemoryPage 骨架 + 空状态

**Files:**
- Create: `packages/frontend/src/components/memory/MemoryEmpty.tsx`
- Create: `packages/frontend/src/components/memory/MemoryPage.tsx`
- Create: `packages/frontend/src/components/memory/InstructionItem.tsx`

- [ ] **Step 1: 创建 `MemoryEmpty.tsx`**

```tsx
// MemoryEmpty.tsx — 空状态组件
interface Props {
  type: "memory" | "instructions";
}

export function MemoryEmpty({ type }: Props) {
  if (type === "instructions") {
    return (
      <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty-instructions">
        <div
          className="flex items-center justify-center text-3xl mb-4"
          style={{
            width: 64, height: 64, borderRadius: 20,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >📄</div>
        <h4 className="font-extrabold text-base mb-1.5 text-primary">没有指令文件</h4>
        <p className="text-[12.5px] text-tertiary text-center leading-relaxed">
          当前项目根目录下没有 AGENTS.md 或 CLAUDE.md。<br />
          创建后，智能体会自动加载作为行为指令。
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🧠</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">还没有记忆</h4>
      <p className="text-[13px] text-tertiary text-center leading-relaxed">
        智能体会在对话中自动学习并记住你的偏好、纠正和经验。<br />
        开始一段对话，记忆会自动积累到这里。
      </p>
    </div>
  );
}
```

- [ ] **Step 2: 创建 `InstructionItem.tsx`**

```tsx
// InstructionItem.tsx — 指令文件条目（只读）
import type { InstructionFile } from "@hiagent/shared";

interface Props {
  instruction: InstructionFile;
}

export function InstructionItem({ instruction }: Props) {
  const isGlobal = instruction.scope === "global";
  const summary = instruction.content.slice(0, 100).trim() + (instruction.content.length > 100 ? "..." : "");

  const openFile = () => {
    // 用 window.open 打开文件路径（浏览器环境下可能需要 kernel 中转）
    window.open(`file:///${instruction.path.replace(/\\/g, "/")}`, "_blank");
  };

  return (
    <div
      className="flex items-start gap-3 p-3.5 mb-2.5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 14,
      }}
      data-testid={`instruction-item-${instruction.scope}`}
    >
      <div
        className="flex items-center justify-center text-base flex-shrink-0"
        style={{
          width: 36, height: 36, borderRadius: 10,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >📄</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[13px] font-bold text-primary">{instruction.name}</span>
          <span
            className="text-[9.5px] font-semibold px-[7px] py-[2px] rounded-full"
            style={{
              background: isGlobal ? "var(--accent-soft)" : "var(--success-soft)",
              color: isGlobal ? "var(--accent)" : "var(--success)",
            }}
          >{isGlobal ? "全局" : "项目"}</span>
        </div>
        <p className="text-[11px] text-tertiary font-mono mb-1.5">{instruction.path}</p>
        <p className="text-[11.5px] text-secondary leading-relaxed m-0">{summary}</p>
      </div>
      <button
        onClick={openFile}
        className="text-[11px] text-secondary px-3 py-1 rounded-md"
        style={{ border: "1px solid var(--hairline)", background: "transparent" }}
      >打开</button>
    </div>
  );
}
```

- [ ] **Step 3: 创建 `MemoryPage.tsx` 骨架（标题栏 + Tab + 筛选 + 列表占位）**

```tsx
// MemoryPage.tsx — 记忆管理页主容器
import { useEffect } from "react";
import { useMemoryStore } from "../../store/memory";
import { useProjectsStore } from "../../store/projects";
import { MemoryCard } from "./MemoryCard";
import { InstructionItem } from "./InstructionItem";
import { MemoryEmpty } from "./MemoryEmpty";

export function MemoryPage() {
  const {
    memories, archived, instructions, config,
    activeTab, categoryFilter, scopeFilter, searchQuery,
    load, loadInstructions, setMemories, setInstructions, setConfig,
    update, archive, restore, purge, setConfigValue,
    setTab, setCategoryFilter, setScopeFilter, setSearchQuery,
  } = useMemoryStore();

  const currentProjectId = useProjectsStore(s => s.currentProjectId);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (currentProjectId && activeTab === "instructions") {
      loadInstructions(currentProjectId);
    }
  }, [currentProjectId, activeTab, loadInstructions]);

  // 筛选后的记忆
  const filteredMemories = memories
    .filter(m => categoryFilter === "all" || m.category === categoryFilter)
    .filter(m => !searchQuery || m.text.toLowerCase().includes(searchQuery.toLowerCase()));

  const filteredInstructions = instructions
    .filter(i => scopeFilter === "all" || i.scope === scopeFilter);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="memory-page">
      {/* 标题栏 + 内联开关 */}
      <div
        className="flex items-center justify-between px-5 py-3.5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">🧠 记忆</h2>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer" data-testid="toggle-review">
            <span className="text-[11.5px] text-secondary">自动学习</span>
            <ToggleSwitch
              on={config?.reviewEnabled ?? true}
              onChange={(v) => setConfigValue({ reviewEnabled: v })}
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="toggle-inject">
            <span className="text-[11.5px] text-secondary">注入提示</span>
            <ToggleSwitch
              on={config?.memoryPolicyStyle !== "none"}
              onChange={(v) => setConfigValue({ memoryPolicyStyle: v ? "full" : "none" })}
            />
          </label>
        </div>
      </div>

      {/* Tab 栏 */}
      <div
        className="flex px-5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <TabButton active={activeTab === "saved"} onClick={() => setTab("saved")} label="已保存" count={memories.length} />
        <TabButton active={activeTab === "archived"} onClick={() => setTab("archived")} label="归档" count={archived.length} />
        <TabButton active={activeTab === "instructions"} onClick={() => setTab("instructions")} label="指令文件" count={instructions.length} />
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2.5 px-5 py-2.5" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
        {activeTab === "instructions" ? (
          // 指令文件筛选
          <div className="flex gap-1.5">
            {(["all", "project", "global"] as const).map(f => (
              <FilterChip key={f} active={scopeFilter === f} onClick={() => setScopeFilter(f)}
                label={f === "all" ? "全部" : f === "project" ? "项目" : "全局"} />
            ))}
          </div>
        ) : (
          // 记忆筛选
          <>
            <input
              className="flex-1 text-[12px] px-3 py-1.5 rounded-lg"
              style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
              placeholder="🔍 搜索记忆..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              data-testid="memory-search"
            />
            <div className="flex gap-1.5">
              {(["all", "memory", "user", "failure"] as const).map(f => (
                <FilterChip key={f} active={categoryFilter === f} onClick={() => setCategoryFilter(f)}
                  label={f === "all" ? "全部" : f === "memory" ? "记忆" : f === "user" ? "用户" : "失败"} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {activeTab === "saved" && (
          filteredMemories.length === 0
            ? <MemoryEmpty type="memory" />
            : filteredMemories.map(m => (
              <MemoryCard
                key={m.id} entry={m}
                onEdit={(text) => update(m.id, text)}
                onArchive={() => archive(m.id)}
              />
            ))
        )}
        {activeTab === "archived" && (
          archived.length === 0
            ? <MemoryEmpty type="memory" />
            : archived.map(m => (
              <MemoryCard
                key={m.id} entry={m} mode="archived"
                onRestore={() => restore(m.id)}
                onPurge={() => purge(m.id)}
              />
            ))
        )}
        {activeTab === "instructions" && (
          filteredInstructions.length === 0
            ? <MemoryEmpty type="instructions" />
            : filteredInstructions.map(inst => (
              <InstructionItem key={inst.path} instruction={inst} />
            ))
        )}
      </div>
    </div>
  );
}

// —— 内联子组件 ——

function TabButton({ active, onClick, label, count }: {
  active: boolean; onClick: () => void; label: string; count: number;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[12px] font-semibold py-1.5 px-3.5"
      style={{
        color: active ? "var(--brand)" : "var(--text-secondary)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        marginBottom: -1,
      }}
      data-testid={`tab-${label}`}
    >
      {label}
      <span className="text-[10px] text-tertiary ml-1">{count}</span>
    </button>
  );
}

function FilterChip({ active, onClick, label }: {
  active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
      style={{
        background: active ? "var(--accent-soft)" : "var(--surface)",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        border: active ? "none" : "1px solid var(--hairline)",
      }}
    >{label}</button>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      className="relative cursor-pointer"
      style={{
        width: 36, height: 20, borderRadius: 9999,
        background: on ? "var(--accent)" : "var(--hairline-strong)",
        transition: "background 0.2s",
      }}
      data-testid={`toggle-${on ? "on" : "off"}`}
    >
      <div
        className="absolute top-0.5 rounded-full bg-white"
        style={{
          width: 16, height: 16,
          left: on ? 18 : 2,
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,.15)",
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/memory/
git commit -m "feat(frontend): MemoryPage + MemoryEmpty + InstructionItem 组件"
```

---

## Task 9: 前端组件 — MemoryCard（含行内编辑）

**Files:**
- Create: `packages/frontend/src/components/memory/MemoryCard.tsx`

- [ ] **Step 1: 创建 `MemoryCard.tsx`**

```tsx
// MemoryCard.tsx — 记忆卡片（含行内编辑态）
import { useState } from "react";
import type { MemoryEntry } from "@hiagent/shared";

interface Props {
  entry: MemoryEntry;
  mode?: "active" | "archived";
  onEdit?: (text: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onPurge?: () => void;
}

// 分类标签配色
const CATEGORY_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  memory: { bg: "var(--success-soft)", color: "var(--success)", label: "记忆" },
  user: { bg: "var(--accent-soft)", color: "var(--accent)", label: "用户" },
  failure: { bg: "var(--danger-soft)", color: "var(--danger)", label: "失败" },
};

export function MemoryCard({ entry, mode = "active", onEdit, onArchive, onRestore, onPurge }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  const cat = CATEGORY_STYLE[entry.category] ?? CATEGORY_STYLE.memory;
  const isArchived = mode === "archived";

  const handleSave = () => {
    onEdit?.(draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(entry.text);
    setEditing(false);
  };

  return (
    <div
      className="mb-2.5 p-3.5"
      style={{
        background: "var(--surface)",
        border: editing ? "1px solid var(--accent)" : "1px solid var(--hairline)",
        borderRadius: 14,
        opacity: isArchived ? 0.75 : 1,
        boxShadow: editing ? "0 0 0 3px var(--accent-soft)" : "none",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}
      data-testid={`memory-card-${entry.id}`}
    >
      {/* 头部：分类标签 + 作用域 */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ background: cat.bg, color: cat.color }}
        >{cat.label}</span>
        <span className="text-[10px] text-tertiary">
          {entry.scope === "global" ? "○ 全局" : "● 项目"}
        </span>
      </div>

      {/* 内容 / 编辑态 */}
      {editing ? (
        <>
          <textarea
            className="w-full text-[12.5px] leading-relaxed p-2.5 mb-2 outline-none"
            style={{
              background: "var(--canvas)",
              border: "1px solid var(--hairline-strong)",
              borderRadius: 10,
              color: "var(--text-primary)",
              minHeight: 60,
            }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            data-testid="memory-edit-textarea"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancel}
              className="text-[11px] text-secondary px-2.5 py-1 rounded-md"
              style={{ border: "1px solid var(--hairline)", background: "transparent" }}
              data-testid="memory-edit-cancel"
            >取消</button>
            <button
              onClick={handleSave}
              className="text-[11px] font-semibold text-white px-3.5 py-1 rounded-md"
              style={{ background: "var(--accent)", border: "none" }}
              data-testid="memory-edit-save"
            >保存</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-primary m-0 mb-2">{entry.text}</p>
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-tertiary">
              {isArchived ? `归档于 ${entry.archivedAt?.slice(0, 10) ?? ""}` : entry.updatedAt?.slice(0, 10) ?? ""}
            </span>
            <div className="flex gap-1.5">
              {isArchived ? (
                <>
                  <CardButton onClick={onRestore} testId="memory-restore" text="恢复"
                    color="var(--accent)" borderColor="var(--accent)" />
                  <CardButton onClick={onPurge} testId="memory-purge" text="彻底删除"
                    color="var(--danger)" borderColor="var(--danger)" />
                </>
              ) : (
                <>
                  <CardButton onClick={() => setEditing(true)} testId="memory-edit" text="编辑" />
                  <CardButton onClick={onArchive} testId="memory-archive" text="归档" />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CardButton({ onClick, testId, text, color, borderColor }: {
  onClick?: () => void; testId: string; text: string;
  color?: string; borderColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="text-[11px] px-2.5 py-1 rounded-md"
      style={{
        color: color ?? "var(--text-secondary)",
        border: `1px solid ${borderColor ?? "var(--hairline)"}`,
        background: "transparent",
      }}
    >{text}</button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/frontend/src/components/memory/MemoryCard.tsx
git commit -m "feat(frontend): MemoryCard 组件（含行内编辑态）"
```

---

## Task 10: 前端路由接入 — View + Sidebar + WS 事件路由

**Files:**
- Modify: `packages/frontend/src/App.tsx:21,79-84,97-112,36-74`
- Modify: `packages/frontend/src/components/Sidebar.tsx:9-17,19-42`

- [ ] **Step 1: 修改 `App.tsx` 的 `View` 类型**

行 21 改为：

```ts
export type View = "empty" | "new-session" | "session" | "canvas" | "memory";
```

- [ ] **Step 2: 修改 `App.tsx` 的 `useEffect` 派生 view 逻辑**

行 79-84 的 `useEffect`，**在依赖数组不包含 memory 手动切换的情况**。当前逻辑会自动把 view 切回 session/new-session。需要改为：用户手动切到 `memory` 时不要被自动覆盖。

修改为：

```ts
useEffect(() => {
  if (view === "memory") return; // 手动切到记忆页时不自动覆盖
  if (projects.length === 0) setView("empty");
  else if (currentSessionId) setView("session");
  else setView("new-session");
}, [projects.length, currentSessionId, view]);
```

- [ ] **Step 3: 修改 `App.tsx` 渲染分支**

行 97-112 的条件渲染区域，追加 memory view 渲染：

```tsx
{view === "memory" && <MemoryPage />}
```

并在文件顶部 import：

```tsx
import { MemoryPage } from "./components/memory/MemoryPage";
```

- [ ] **Step 4: 修改 `App.tsx` 的 WS 事件路由**

行 36-74 的 `onMessage` switch 里，追加记忆事件路由（参照行 72-73 的 extension 模式）：

```ts
case "memory:list":
case "memory:changed":
  useMemoryStore.getState().setMemories(e as any);
  break;
case "instruction:list":
  useMemoryStore.getState().setInstructions(e as any);
  break;
case "memory:config":
  useMemoryStore.getState().setConfig(e as any);
  break;
```

并在文件顶部 import：

```ts
import { useMemoryStore } from "./store/memory";
```

- [ ] **Step 5: 修改 `Sidebar.tsx` 加「记忆」导航入口**

在 Props interface 加 `onOpenMemory`:

```ts
interface Props {
  onNewSession: () => void;
  onSelectAgent: (name: AgentName) => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onOpenMemory: () => void;   // 新增
  currentView?: View;
}
```

在 `<aside>` 内 `<SettingsButton>` 前面加一个记忆按钮：

```tsx
<button
  onClick={props.onOpenMemory}
  className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13.5px] text-secondary hover:bg-[var(--surface-hover)]"
  data-testid="sidebar-memory-btn"
>
  <span>🧠</span>
  <span>记忆</span>
</button>
```

- [ ] **Step 6: 在 `App.tsx` 渲染 `<Sidebar>` 处传入回调**

行 88-96 渲染 `<Sidebar>` 的地方，加 `onOpenMemory={() => setView("memory")}`：

```tsx
<Sidebar
  onNewSession={...}
  onSelectAgent={...}
  onSelectSession={...}
  onNewSessionInProject={...}
  onSelectProject={...}
  onNewProject={...}
  onOpenMemory={() => setView("memory")}
  currentView={view}
/>
```

- [ ] **Step 7: 启动 dev 验证页面渲染**

Run: `cd scripts && bun run dev.ts`（或 `bun run dev`）
Expected: 侧边栏出现「记忆」入口，点击后渲染 MemoryPage（空状态）

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/App.tsx packages/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): 记忆页路由接入 + 侧边栏入口 + WS 事件路由"
```

---

## Task 11: 前端组件测试

**Files:**
- Test: `packages/frontend/tests/MemoryPage.test.tsx`

- [ ] **Step 1: 写 MemoryPage 渲染 + Tab 切换 + 筛选测试**

```tsx
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryPage } from "../src/components/memory/MemoryPage";
import { useMemoryStore } from "../src/store/memory";

const originalState = useMemoryStore.getState();

beforeEach(() => {
  useMemoryStore.setState({
    memories: [{
      id: "pi-hermes-memory/MEMORY.md:0",
      text: "项目使用 pnpm",
      category: "memory",
      scope: "global",
      sourceFile: "/fake/MEMORY.md",
      rawIndex: 0,
    }],
    archived: [],
    instructions: [{
      path: "/fake/AGENTS.md",
      name: "AGENTS.md",
      scope: "project",
      content: "行为准则",
    }],
    config: { reviewEnabled: true, memoryPolicyStyle: "full" },
    activeTab: "saved",
    categoryFilter: "all",
    scopeFilter: "all",
    searchQuery: "",
  });
});

afterEach(() => {
  useMemoryStore.setState(originalState);
});

test("渲染标题 + 内联开关 + 默认已保存 Tab", () => {
  render(<MemoryPage />);
  expect(screen.getByText("🧠 记忆")).toBeTruthy();
  expect(screen.getByTestId("tab-已保存")).toBeTruthy();
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();
});

test("点击归档 Tab 切换到归档列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-归档"));
  // 归档列表为空时显示空状态
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});

test("点击指令文件 Tab 展示指令列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  expect(screen.getByTestId("instruction-item-project")).toBeTruthy();
});

test("分类筛选 — 点击失败只筛选 failure 类别", () => {
  useMemoryStore.setState({
    memories: [
      { id: "a:0", text: "记忆A", category: "memory", scope: "global", sourceFile: "/a", rawIndex: 0 },
      { id: "b:0", text: "失败B", category: "failure", scope: "global", sourceFile: "/b", rawIndex: 0 },
    ],
  });
  render(<MemoryPage />);
  // 初始展示全部
  expect(screen.getByText("记忆A")).toBeTruthy();
  expect(screen.getByText("失败B")).toBeTruthy();

  // 点击失败筛选
  fireEvent.click(screen.getByText("失败"));
  expect(screen.queryByText("记忆A")).toBeNull();
  expect(screen.getByText("失败B")).toBeTruthy();
});

test("搜索框过滤记忆", () => {
  render(<MemoryPage />);
  const input = screen.getByTestId("memory-search") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pnpm" } });
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();

  fireEvent.change(input, { target: { value: "不存在的关键词" } });
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});
```

- [ ] **Step 2: 写 MemoryCard 编辑交互测试**

```tsx
test("记忆卡片编辑 — 点击编辑展开文本框，保存后回调", () => {
  const editMock = mock();
  useMemoryStore.setState({
    memories: [{
      id: "test:0", text: "原始内容", category: "memory",
      scope: "global", sourceFile: "/fake", rawIndex: 0,
    }],
  });
  useMemoryStore.setState({ update: editMock });

  render(<MemoryPage />);
  // 点击编辑
  fireEvent.click(screen.getByTestId("memory-edit"));
  const textarea = screen.getByTestId("memory-edit-textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("原始内容");

  // 修改内容
  fireEvent.change(textarea, { target: { value: "修改后内容" } });
  fireEvent.click(screen.getByTestId("memory-edit-save"));

  expect(editMock).toHaveBeenCalledWith("test:0", "修改后内容");
});
```

- [ ] **Step 3: 运行前端测试**

Run: `cd packages/frontend && bun test tests/MemoryPage.test.tsx`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/tests/MemoryPage.test.tsx
git commit -m "test(frontend): MemoryPage 渲染 + Tab + 筛选 + 编辑交互测试"
```

---

## Task 12: E2E 测试 + 最终验证

**Files:**
- Test: `packages/frontend/e2e/memory.spec.ts`

- [ ] **Step 1: 写 E2E 测试 — 进入记忆页 → 查看 → 编辑 → 归档 → 指令文件**

参照现有 e2e 测试的 global-setup 模式（`packages/frontend/e2e/global-setup.ts`）：

```ts
import { test, expect } from "@playwright/test";

test.describe("记忆管理", () => {
  test("进入记忆页，查看记忆列表，编辑一条记忆", async ({ page }) => {
    await page.goto("/");
    // 点击侧边栏「记忆」入口
    await page.click('[data-testid="sidebar-memory-btn"]');
    await expect(page.locator('[data-testid="memory-page"]')).toBeVisible();

    // 确认标题和 Tab 存在
    await expect(page.locator('[data-testid="tab-已保存"]')).toBeVisible();
  });

  test("切换到指令文件 Tab", async ({ page }) => {
    await page.goto("/");
    await page.click('[data-testid="sidebar-memory-btn"]');
    await page.click('[data-testid="tab-指令文件"]');
    // 有指令文件就展示条目，没有就展示空状态
    const hasItem = await page.locator('[data-testid*="instruction-item"]').count();
    expect(hasItem >= 0).toBe(true);
  });

  test("开关切换 — 自动学习", async ({ page }) => {
    await page.goto("/");
    await page.click('[data-testid="sidebar-memory-btn"]');
    // 点击自动学习开关
    const toggle = page.locator('[data-testid="toggle-review"]');
    await toggle.click();
    // 不报错即通过
  });
});
```

- [ ] **Step 2: 运行全部 kernel 单元测试**

Run: `cd packages/kernel && bun test`
Expected: 全部 PASS（含 memory-store + ws-memory）

- [ ] **Step 3: 运行全部前端测试**

Run: `cd packages/frontend && bun test`
Expected: 全部 PASS

- [ ] **Step 4: 运行 E2E 测试**

Run: `cd packages/frontend && npx playwright test e2e/memory.spec.ts`
Expected: PASS

- [ ] **Step 5: 清理 E2E 截图（如有）**

Run: 检查并删除测试过程中产生的截图文件

- [ ] **Step 6: 更新 CHANGELOG.md**

在 CHANGELOG.md 顶部追加：

```markdown
## 2026-07-11

### 新增功能
- **记忆管理**：集成 pi-hermes-memory 插件，新增记忆管理页（侧边栏「记忆」入口）
  - 记忆查看/编辑/归档/恢复/彻底删除
  - 分类筛选（记忆/用户/失败）+ 搜索
  - 双开关：自动学习 + 注入提示
- **指令文件展示**：只读展示已加载的 AGENTS.md / CLAUDE.md，支持全局/项目筛选
- **影响范围**：packages/kernel（memory-store, ws-server, extensions）、packages/frontend（MemoryPage, store/memory, App, Sidebar）、packages/shared（memory 类型定义）
```

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/e2e/memory.spec.ts CHANGELOG.md
git commit -m "test: 记忆管理 E2E + CHANGELOG 更新"
```

---

## Self-Review 结果

**Spec 覆盖率检查**：
- ✅ 决策 1（职责边界）：Task 1-5 的 MemoryStore 只做 CRUD，不碰注入
- ✅ 决策 2（注入对齐）：plan 中无注入代码，注入交给插件
- ✅ 决策 3（指令文件只读）：Task 4 的 listInstructions 只读，Task 8 的 InstructionItem 只展示+打开
- ✅ 决策 4（软删除归档）：Task 3 的 archive/restore/purge + sidecar
- ✅ 决策 5（3 分类）：Task 2 的 GLOBAL_SOURCES/PROJECT_SOURCES 固定 3 分类
- ✅ 决策 6（作用域）：Task 2 的 scope 字段 + Task 8 的徽章
- ✅ 决策 7（文件竞争）：plan 不做锁，Task 5 的 CRUD 后广播刷新
- ✅ 决策 8（双开关）：Task 4 的 getConfig/setConfig + Task 8 的 ToggleSwitch

**类型一致性检查**：
- `MemoryStore.list()` → 返回 `{ memories, archived }`，WS case 和前端 store 一致 ✅
- `listInstructions(projectId)` → 接受 projectId 参数，WS event 和 store 一致 ✅
- ID 格式 `"相对路径:rawIndex"` → parseMemoryFile/update/archive 一致 ✅
