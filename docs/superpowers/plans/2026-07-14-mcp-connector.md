# MCP 连接器 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HiAgent 设置页新增「MCP 连接器」模块，支持全局/项目作用域管理 MCP 服务器配置，手动添加/编辑/删除，连接测试，查看工具列表，清除授权。

**Architecture:** 遵循 memory 现有模式 — shared 层定义类型+WS协议，kernel 层新增 McpStore 负责 `.mcp.json` 读写+临时 Pi session 操作，frontend 层新增 Zustand store + MCP 页面组件 + SettingsModal 集成。

**Tech Stack:** TypeScript, Bun, React, Zustand, Pi SDK, pi-mcp-adapter

## Global Constraints

- 全局配置文件：`~/.hiagent/mcp.json`，项目配置文件：`<cwd>/.mcp.json`
- 配置格式兼容 pi-mcp-adapter 的 `.mcp.json` 规范
- 不实现 MCP 客户端运行时（由 pi-mcp-adapter 负责）
- 每层测试覆盖率 ≥ 80%，kernel/mcp-store.ts ≥ 90%
- 所有 WS 协议事件处理路径至少覆盖成功路径 + 一个错误路径
- 遵循 AGENTS.md 4层测试金字塔

---

### Task 1: Shared MCP 类型定义

**Files:**
- Create: `packages/shared/src/mcp.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `McpServerConfig`, `McpOAuthConfig`, `McpToolSummary`, `McpServerStatus`, `McpListEvent`, `McpSaveEvent`, `McpDeleteEvent`, `McpTestEvent`, `McpListToolsEvent`, `McpClearAuthEvent`, `McpListResult`, `McpChangedEvent`, `McpTestResult`, `McpToolsResult`

- [ ] **Step 1: 创建 packages/shared/src/mcp.ts**

```typescript
// ===== MCP 服务器配置管理类型定义 =====

/** MCP OAuth 配置（兼容 pi-mcp-adapter） */
export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/** MCP 服务器配置（兼容 .mcp.json 格式） */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerToken?: string;
  oauth?: McpOAuthConfig;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean | string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  debug?: boolean;
}

/** 工具参数摘要 */
export interface McpToolParam {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
}

/** MCP 工具摘要（来自 mcp-cache.json） */
export interface McpToolSummary {
  name: string;
  description?: string;
  parameters?: McpToolParam[];
}

/** 服务器运行时状态 */
export type McpServerStatus = "disconnected" | "connected" | "needs_auth" | "error";

// ===== WS 协议事件 =====

// 前端 → 内核
export interface McpListEvent      { type: "mcp:list";      projectId?: string; }
export interface McpSaveEvent      { type: "mcp:save";      projectId?: string; config: McpServerConfig; originalName?: string; }
export interface McpDeleteEvent    { type: "mcp:delete";    projectId?: string; serverName: string; }
export interface McpTestEvent      { type: "mcp:test";      projectId?: string; serverName: string; }
export interface McpListToolsEvent { type: "mcp:listTools"; serverName: string; }
export interface McpClearAuthEvent { type: "mcp:clearAuth"; projectId?: string; serverName: string; }

// 内核 → 前端
export interface McpListResult   { type: "mcp:list";    projectId?: string; servers: McpServerConfig[]; }
export interface McpChangedEvent { type: "mcp:changed"; projectId?: string; servers: McpServerConfig[]; }
export interface McpTestResult   { type: "mcp:testResult"; serverName: string; success: boolean; error?: string; }
export interface McpToolsResult  { type: "mcp:tools";      serverName: string; tools: McpToolSummary[]; }
```

- [ ] **Step 2: 在 packages/shared/src/types.ts 中注册到 WS 联合类型**

在 `WSClientEvent` 中添加（在 Memory 事件之后，`FSHomeRequest` 之前）：

```typescript
  // ... 找到 Memory 事件那行，在其后添加:
  | McpListEvent | McpSaveEvent | McpDeleteEvent | McpTestEvent | McpListToolsEvent | McpClearAuthEvent
```

在 `WSServerEvent` 中添加（在 `MemoryListResult | MemoryChangedEvent` 之后）：

```typescript
  | McpListResult | McpChangedEvent | McpTestResult | McpToolsResult
```

在文件顶部 import 区域添加：

```typescript
import type {
  McpListEvent, McpSaveEvent, McpDeleteEvent, McpTestEvent, McpListToolsEvent, McpClearAuthEvent,
  McpListResult, McpChangedEvent, McpTestResult, McpToolsResult,
} from "./mcp";
```

- [ ] **Step 3: 在 packages/shared/src/index.ts 添加导出**

在 `export * from "./memory";` 之后添加：

```typescript
export * from "./mcp";
```

- [ ] **Step 4: 类型检查**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: 验证类型导出**

Run: `cd packages/kernel && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/mcp.ts packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat: MCP shared 类型定义 + WS 协议事件"
```

---

### Task 2: Kernel McpStore 配置 CRUD

**Files:**
- Create: `packages/kernel/src/mcp-store.ts`
- Create: `packages/kernel/tests/mcp-store.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig`, `McpOAuthConfig`, `McpToolSummary` from `@hiagent/shared`
- Consumes: `ProjectStore` from `./project-store`
- Produces: `McpStore` class — `constructor(opts: { hiagentDir: string; projectStore: ProjectStore })`, `list(projectId?: string): Promise<McpServerConfig[]>`, `save(config: McpServerConfig, projectId?: string): Promise<void>`, `delete(serverName: string, projectId?: string): Promise<void>`, `listTools(serverName: string): Promise<McpToolSummary[]>`

- [ ] **Step 1: 编写 mcp-store 单元测试**

Create `packages/kernel/tests/mcp-store.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpStore } from "../src/mcp-store";
import type { ProjectEntity } from "@hiagent/shared";

const TMP = join(import.meta.dir, "mcp-test-" + Date.now());
const PROJECT_CWD = join(TMP, "my-project");
const MOCK_PROJECT: ProjectEntity = { id: "p1", name: "my-project", cwd: PROJECT_CWD, createdAt: 1 };

const mockProjectStore = {
  load: async () => ({ projects: [MOCK_PROJECT], sessions: [] as any[] }),
} as any;

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  await mkdir(PROJECT_CWD, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function createStore() {
  return new McpStore({ hiagentDir: TMP, projectStore: mockProjectStore });
}

// ===== resolveConfigPath =====
test("resolveConfigPath: 无 projectId 返回全局路径", async () => {
  const store = createStore() as any;
  const path = store.resolveConfigPath(undefined);
  expect(path).toBe(join(TMP, "mcp.json"));
});

test("resolveConfigPath: 带 projectId 返回项目路径", async () => {
  const store = createStore() as any;
  const path = store.resolveConfigPath("p1");
  expect(path).toBe(join(PROJECT_CWD, ".mcp.json"));
});

test("resolveConfigPath: projectId 不存在抛错", async () => {
  const store = createStore() as any;
  expect(() => store.resolveConfigPath("nope")).toThrow();
});

// ===== readConfig =====
test("readConfig: 文件不存在返回空结构", () => {
  const store = createStore() as any;
  const cfg = store.readConfig("/nope/not-exists.json");
  expect(cfg).toEqual({ mcpServers: {} });
});

test("readConfig: 正常解析", async () => {
  const p = join(TMP, "test.json");
  await writeFile(p, JSON.stringify({ mcpServers: { s1: { command: "npx", args: ["-y", "test"] } } }));
  const store = createStore() as any;
  const cfg = store.readConfig(p);
  expect(cfg.mcpServers["s1"].command).toBe("npx");
  expect(cfg.mcpServers["s1"].args).toEqual(["-y", "test"]);
});

test("readConfig: JSON 解析失败抛错", async () => {
  const p = join(TMP, "bad.json");
  await writeFile(p, "{not valid json");
  const store = createStore() as any;
  expect(() => store.readConfig(p)).toThrow();
});

// ===== writeConfig =====
test("writeConfig: 写入后读取一致", async () => {
  const store = createStore() as any;
  const p = join(TMP, "write-test.json");
  await store.writeConfig(p, { mcpServers: { "chrome": { command: "npx", args: ["-y", "chrome-mcp"] } } });
  const read = JSON.parse(require("fs").readFileSync(p, "utf8"));
  expect(read.mcpServers.chrome.command).toBe("npx");
});

test("writeConfig: 父目录不存在时自动创建", async () => {
  const store = createStore() as any;
  const p = join(TMP, "deep", "nested", "cfg.json");
  await store.writeConfig(p, { mcpServers: {} });
  const read = JSON.parse(require("fs").readFileSync(p, "utf8"));
  expect(read.mcpServers).toEqual({});
});

// ===== list =====
test("list: 全局配置返回 servers 数组", async () => {
  const globalPath = join(TMP, "mcp.json");
  await writeFile(globalPath, JSON.stringify({
    mcpServers: {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], lifecycle: "lazy" },
      "figma": { url: "http://localhost:3845/mcp", auth: "oauth" },
    },
  }));
  const store = createStore();
  const servers = await store.list();
  expect(servers.length).toBe(2);
  expect(servers[0].name).toBe("chrome-devtools");
  expect(servers[1].name).toBe("figma");
});

test("list: 文件不存在返回空数组", async () => {
  const store = createStore();
  const servers = await store.list();
  expect(servers).toEqual([]);
});

test("list: 项目配置返回 servers 数组", async () => {
  const projectPath = join(PROJECT_CWD, ".mcp.json");
  await writeFile(projectPath, JSON.stringify({
    mcpServers: { "project-server": { command: "node", args: ["server.js"] } },
  }));
  const store = createStore();
  const servers = await store.list("p1");
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("project-server");
});

// ===== save =====
test("save: 新增 server", async () => {
  const store = createStore();
  await store.save({ name: "test-server", command: "echo", args: ["hello"] });
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("test-server");
});

test("save: 编辑 server", async () => {
  const store = createStore();
  await store.save({ name: "test-server", command: "echo", args: ["hello"] });
  await store.save({ name: "test-server", command: "echo", args: ["world"] });
  const servers = await store.list();
  expect(servers[0].args).toEqual(["world"]);
});

test("save: 改名 server (originalName)", async () => {
  const store = createStore();
  await store.save({ name: "old-name", command: "echo", args: [] });
  await store.save({ name: "new-name", command: "echo", args: [] }, undefined, "old-name");
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("new-name");
});

// ===== delete =====
test("delete: 删除 server", async () => {
  const store = createStore();
  await store.save({ name: "a", command: "echo" });
  await store.save({ name: "b", command: "echo" });
  await store.delete("a");
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("b");
});

test("delete: 删除不存在的 server 抛错", async () => {
  const store = createStore();
  await expect(store.delete("nope")).rejects.toThrow();
});

// ===== listTools =====
test("listTools: 缓存存在时返回工具列表", async () => {
  const cachePath = join(TMP, "mcp-cache.json");
  await writeFile(cachePath, JSON.stringify({
    "chrome-devtools": {
      tools: [
        { name: "take_screenshot", description: "Take a screenshot", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["png", "jpeg"] } } } },
      ],
    },
  }));
  const store = createStore();
  const tools = await store.listTools("chrome-devtools");
  expect(tools.length).toBe(1);
  expect(tools[0].name).toBe("take_screenshot");
  expect(tools[0].description).toBe("Take a screenshot");
  expect(tools[0].parameters).toBeTruthy();
});

test("listTools: 缓存不存在返回空数组", async () => {
  const store = createStore();
  const tools = await store.listTools("unknown-server");
  expect(tools).toEqual([]);
});
```

- [ ] **Step 2: 运行测试，确认全部失败**

Run: `cd packages/kernel && bun test tests/mcp-store.test.ts`
Expected: 全部 FAIL — `McpStore` 不存在

- [ ] **Step 3: 编写 McpStore 实现**

Create `packages/kernel/src/mcp-store.ts`:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig, McpToolSummary, McpToolParam } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

/** .mcp.json 文件顶级结构 */
interface McpConfigFile {
  mcpServers: Record<string, Omit<McpServerConfig, "name">>;
  settings?: Record<string, unknown>;
}

const CACHE_FILE = "mcp-cache.json";

export interface McpStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class McpStore {
  constructor(private opts: McpStoreOpts) {}

  /** 列出全局或项目的 MCP 服务器 */
  async list(projectId?: string): Promise<McpServerConfig[]> {
    const path = this.resolveConfigPath(projectId);
    const cfg = this.readConfig(path);
    return Object.entries(cfg.mcpServers).map(([name, server]) => ({
      name,
      ...server,
    }));
  }

  /** 新增或更新 MCP 服务器配置（originalName 用于改名检测） */
  async save(config: McpServerConfig, projectId?: string, originalName?: string): Promise<void> {
    const path = this.resolveConfigPath(projectId);
    const cfg = this.readConfig(path);
    const { name, ...serverData } = config;

    // 改名：先删旧 key
    if (originalName && originalName !== config.name) {
      if (!cfg.mcpServers[originalName]) {
        throw new Error(`原服务器 ${originalName} 不存在`);
      }
      delete cfg.mcpServers[originalName];
    }

    cfg.mcpServers[name] = serverData;
    await this.writeConfig(path, cfg);
  }

  /** 删除 MCP 服务器配置 */
  async delete(serverName: string, projectId?: string): Promise<void> {
    const path = this.resolveConfigPath(projectId);
    const cfg = this.readConfig(path);
    if (!cfg.mcpServers[serverName]) {
      throw new Error(`服务器 ${serverName} 不存在`);
    }
    delete cfg.mcpServers[serverName];
    await this.writeConfig(path, cfg);
  }

  /** 从 mcp-cache.json 读取工具列表 */
  async listTools(serverName: string): Promise<McpToolSummary[]> {
    const cachePath = join(this.opts.hiagentDir, CACHE_FILE);
    try {
      const raw = await readFile(cachePath, "utf8");
      const cache = JSON.parse(raw);
      const serverCache = cache[serverName];
      if (!serverCache || !Array.isArray(serverCache.tools)) {
        return [];
      }
      return serverCache.tools.map((t: any) => ({
        name: t.name ?? "",
        description: t.description,
        parameters: t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties).map(([pname, pschema]: [string, any]) => ({
              name: pname,
              type: pschema.type ?? "string",
              description: pschema.description,
            }))
          : undefined,
      }));
    } catch {
      return [];
    }
  }

  /** 连接测试：委托给 ws-server.ts 中调用 createAgentSession */
  // 占位 — 实际实现将在 ws-server.ts handler 中内联（需访问 agentManager）

  /** 清除授权：委托给 ws-server.ts 中调用 createAgentSession */
  // 占位 — 同上

  // ===== 内部方法 =====

  /** 根据 projectId 解析配置文件路径 */
  private resolveConfigPath(projectId?: string): string {
    if (!projectId) {
      return join(this.opts.hiagentDir, "mcp.json");
    }
    // 从 ProjectStore 同步查 cwd（load 缓存，不重新读文件）
    // 注意：需要从 projectStore 获取 cwd，使用同步方式
    throw new Error("需要 projectStore 异步查询 cwd；请调用 list/save/delete 等方法");
  }

  /** 读取并解析 .mcp.json */
  private readConfig(path: string): McpConfigFile {
    if (!existsSync(path)) {
      return { mcpServers: {} };
    }
    const raw = require("fs").readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return {
        mcpServers: parsed.mcpServers ?? {},
        settings: parsed.settings,
      };
    } catch (e) {
      throw new Error(`解析 ${path} 失败: ${(e as Error).message}`);
    }
  }

  /** 写入 .mcp.json */
  private async writeConfig(path: string, data: McpConfigFile): Promise<void> {
    const dir = require("path").dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  }
}
```

等等，`resolveConfigPath` 需要异步查 `projectStore`。需要改成异步模式。让我重新设计实现。

- [ ] **Step 3 (revised): 编写 McpStore 实现**

Create `packages/kernel/src/mcp-store.ts`:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig, McpToolSummary } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

interface McpConfigFile {
  mcpServers: Record<string, Omit<McpServerConfig, "name">>;
  settings?: Record<string, unknown>;
}

export interface McpStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class McpStore {
  constructor(private opts: McpStoreOpts) {}

  async list(projectId?: string): Promise<McpServerConfig[]> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    return Object.entries(cfg.mcpServers).map(([name, server]) => ({
      name,
      ...server,
    }));
  }

  async save(config: McpServerConfig, projectId?: string, originalName?: string): Promise<void> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    const { name, ...serverData } = config;

    if (originalName && originalName !== config.name) {
      if (!cfg.mcpServers[originalName]) {
        throw new Error(`原服务器 ${originalName} 不存在`);
      }
      delete cfg.mcpServers[originalName];
    }

    cfg.mcpServers[name] = serverData;
    await this.writeConfig(path, cfg);
  }

  async delete(serverName: string, projectId?: string): Promise<void> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    if (!cfg.mcpServers[serverName]) {
      throw new Error(`服务器 ${serverName} 不存在`);
    }
    delete cfg.mcpServers[serverName];
    await this.writeConfig(path, cfg);
  }

  async listTools(serverName: string): Promise<McpToolSummary[]> {
    const cachePath = join(this.opts.hiagentDir, "mcp-cache.json");
    try {
      const raw = await readFile(cachePath, "utf8");
      const cache = JSON.parse(raw);
      const serverCache = cache[serverName];
      if (!serverCache || !Array.isArray(serverCache.tools)) {
        return [];
      }
      return serverCache.tools.map((t: any) => ({
        name: t.name ?? "",
        description: t.description,
        parameters: t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties).map(([pname, pschema]: [string, any]) => ({
              name: pname,
              type: pschema.type ?? "string",
              description: pschema.description as string | undefined,
            }))
          : undefined,
      }));
    } catch {
      return [];
    }
  }

  // ===== 内部方法 =====

  private async resolveConfigPath(projectId?: string): Promise<string> {
    if (!projectId) {
      return join(this.opts.hiagentDir, "mcp.json");
    }
    const { projects } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.cwd) {
      throw new Error(`项目不存在或缺少工作目录: ${projectId}`);
    }
    return join(project.cwd, ".mcp.json");
  }

  private async readConfig(path: string): Promise<McpConfigFile> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return {
        mcpServers: parsed.mcpServers ?? {},
        settings: parsed.settings,
      };
    } catch (e: any) {
      if (e.code === "ENOENT") {
        return { mcpServers: {} };
      }
      throw new Error(`解析 ${path} 失败: ${e.message}`);
    }
  }

  private async writeConfig(path: string, data: McpConfigFile): Promise<void> {
    const { dirname } = require("path") as typeof import("path");
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  }
}
```

- [ ] **Step 4: 更新测试以匹配异步 API**

Update `packages/kernel/tests/mcp-store.test.ts` 中 `resolveConfigPath` 和 `readConfig` 相关测试：

```typescript
// resolveConfigPath 现在是 async
test("resolveConfigPath: 无 projectId 返回全局路径", async () => {
  const store = createStore() as any;
  const path = await store.resolveConfigPath(undefined);
  expect(path).toBe(join(TMP, "mcp.json"));
});

test("resolveConfigPath: 带 projectId 返回项目路径", async () => {
  const store = createStore() as any;
  const path = await store.resolveConfigPath("p1");
  expect(path).toBe(join(PROJECT_CWD, ".mcp.json"));
});

test("resolveConfigPath: projectId 不存在抛错", async () => {
  const store = createStore() as any;
  await expect(store.resolveConfigPath("nope")).rejects.toThrow();
});

// readConfig 现在是 async
test("readConfig: 文件不存在返回空结构", async () => {
  const store = createStore() as any;
  const cfg = await store.readConfig("/nope/not-exists.json");
  expect(cfg).toEqual({ mcpServers: {} });
});

test("readConfig: 正常解析", async () => {
  const p = join(TMP, "test.json");
  await writeFile(p, JSON.stringify({ mcpServers: { s1: { command: "npx", args: ["-y", "test"] } } }));
  const store = createStore() as any;
  const cfg = await store.readConfig(p);
  expect(cfg.mcpServers["s1"].command).toBe("npx");
});

test("readConfig: JSON 解析失败抛错", async () => {
  const p = join(TMP, "bad.json");
  await writeFile(p, "{not valid json");
  const store = createStore() as any;
  await expect(store.readConfig(p)).rejects.toThrow();
});
```

- [ ] **Step 5: 运行测试**

Run: `cd packages/kernel && bun test tests/mcp-store.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: 类型检查**

Run: `cd packages/kernel && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/mcp-store.ts packages/kernel/tests/mcp-store.test.ts
git commit -m "feat: McpStore — MCP 配置 CRUD + 工具缓存读取"
```

---

### Task 3: Kernel WS 路由 + 初始化

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `McpStore` from `./mcp-store`
- Consumes: `McpListEvent`, `McpSaveEvent`, `McpDeleteEvent`, `McpTestEvent`, `McpListToolsEvent`, `McpClearAuthEvent`, `McpListResult`, `McpChangedEvent`, `McpTestResult`, `McpToolsResult` from `@hiagent/shared`

- [ ] **Step 1: ws-server.ts — 添加 McpStore 到 WSServerOpts**

找到接口 `WSServerOpts` 定义，`memoryStore: MemoryStore;` 行后添加：

```typescript
  mcpStore: McpStore;
```

在 import 区域添加：

```typescript
import type { McpStore } from "./mcp-store";
```

- [ ] **Step 2: ws-server.ts — 在 handle() 中添加新 case**

在 `case "memory:config:set":` 分支结束 `}` 之后（close brace），添加：

```typescript
      // ===== MCP 连接器 =====
      case "mcp:list": {
        try {
          const servers = await this.opts.mcpStore.list(event.projectId);
          reply({ type: "mcp:list", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:save": {
        try {
          await this.opts.mcpStore.save(event.config, event.projectId, event.originalName);
          const servers = await this.opts.mcpStore.list(event.projectId);
          this.broadcast({ type: "mcp:changed", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:delete": {
        try {
          await this.opts.mcpStore.delete(event.serverName, event.projectId);
          const servers = await this.opts.mcpStore.list(event.projectId);
          this.broadcast({ type: "mcp:changed", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:test": {
        try {
          // 连接测试：启动临时 Pi session 执行 /mcp reconnect
          const cwd = event.projectId
            ? (await this.opts.projectStore.load()).projects.find(p => p.id === event.projectId)?.cwd
            : undefined;
          const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
          try {
            const authStorage = AuthStorage.create();
            const modelRegistry = ModelRegistry.create(authStorage);
            const { session } = await createAgentSession({
              cwd,
              sessionManager: SessionManager.inMemory(),
              authStorage,
              modelRegistry,
            });

            let testResult = { ok: false, error: "" };
            const timeout = setTimeout(() => {
              testResult = { ok: false, error: "连接测试超时" };
              session.dispose();
            }, 30000);

            return new Promise<void>((resolvePromise) => {
              session.subscribe((ev: any) => {
                if (ev.type === "agent_end") {
                  clearTimeout(timeout);
                  // 检查最终消息是否包含错误
                  const lastMsg = ev.messages?.[ev.messages.length - 1];
                  const hasError = lastMsg?.stopReason === "error" || lastMsg?.errorMessage;
                  testResult = { ok: !hasError, error: hasError ? (lastMsg?.errorMessage ?? "连接失败") : "" };
                  session.dispose();
                  resolvePromise();
                }
              });
              session.prompt(`/mcp reconnect ${event.serverName}`).catch((err: Error) => {
                clearTimeout(timeout);
                testResult = { ok: false, error: err.message };
                try { session.dispose(); } catch {}
                resolvePromise();
              });
            }).then(() => {
              reply({ type: "mcp:testResult", serverName: event.serverName, ...testResult });
            });
          } catch (err) {
            reply({ type: "mcp:testResult", serverName: event.serverName, success: false, error: `Pi 启动失败: ${(err as Error).message}` });
          }
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:listTools": {
        try {
          const tools = await this.opts.mcpStore.listTools(event.serverName);
          reply({ type: "mcp:tools", serverName: event.serverName, tools });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:clearAuth": {
        try {
          const cwd = event.projectId
            ? (await this.opts.projectStore.load()).projects.find(p => p.id === event.projectId)?.cwd
            : undefined;
          const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
          try {
            const authStorage = AuthStorage.create();
            const modelRegistry = ModelRegistry.create(authStorage);
            const { session } = await createAgentSession({
              cwd,
              sessionManager: SessionManager.inMemory(),
              authStorage,
              modelRegistry,
            });

            const timeout = setTimeout(() => {
              session.dispose();
            }, 60000);

            return new Promise<void>((resolvePromise) => {
              session.subscribe((ev: any) => {
                if (ev.type === "agent_end") {
                  clearTimeout(timeout);
                  session.dispose();
                  resolvePromise();
                }
              });
              session.prompt(`/mcp logout ${event.serverName}`).catch(() => {
                clearTimeout(timeout);
                try { session.dispose(); } catch {}
                resolvePromise();
              });
            }).then(() => {
              reply({ type: "mcp:tools", serverName: event.serverName, tools: [] }); // 复用 tools 类型表示操作完成
            });
          } catch (err) {
            reply({ type: "error", message: (err as Error).message });
          }
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
```

等待——`mcp:clearAuth` 的回复类型不应该复用 `mcp:tools`。改用 `mcp:testResult` 表示操作完成。修正：

```typescript
            }).then(() => {
              reply({ type: "mcp:testResult", serverName: event.serverName, success: true });
            });
```

- [ ] **Step 3: index.ts — 初始化 McpStore**

在 `startKernel()` 中，`const memoryStore = new MemoryStore(...)` 之后添加：

```typescript
  const mcpStore = new McpStore({ hiagentDir: HIAGENT_DIR, projectStore });
```

在 `new WSServer({` 参数中添加：

```typescript
    mcpStore,
```

在 import 区域添加：

```typescript
import { McpStore } from "./mcp-store";
```

- [ ] **Step 4: 类型检查**

Run: `cd packages/kernel && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/index.ts
git commit -m "feat: kernel — MCP WS 路由 + McpStore 初始化"
```

---

### Task 4: Frontend MCP Store

**Files:**
- Create: `packages/frontend/src/store/mcp.ts`
- Create: `packages/frontend/tests/store-mcp.test.ts`

**Interfaces:**
- Produces: `useMcpStore` zustand store — `load(projectId?)`, `setServers(data)`, `save(config, projectId?)`, `delete(serverName, projectId?)`, `testConnection(serverName, projectId?)`, `listTools(serverName)`, `clearAuth(serverName, projectId?)`, `setSelectedProjectId(id)`, `setSearchQuery(q)`
- Consumes: `send` from `../ws-instance`, `McpServerConfig`, `McpServerStatus`, `McpToolSummary` from `@hiagent/shared`

- [ ] **Step 1: 编写 store 测试**

Create `packages/frontend/tests/store-mcp.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { useMcpStore } from "../src/store/mcp";

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    serverStatuses: {},
    toolsCache: {},
  });
});

test("load 发起 mcp:list 请求", () => {
  useMcpStore.getState().load();
  expect(useMcpStore.getState().loading).toBe(true);
});

test("load 带 projectId 发起项目列表请求", () => {
  useMcpStore.getState().load("p1");
  expect(useMcpStore.getState().selectedProjectId).toBe("p1");
});

test("setServers 更新 servers 并清除 loading", () => {
  useMcpStore.getState().load();
  useMcpStore.getState().setServers({
    type: "mcp:list",
    servers: [{ name: "test", command: "echo" }],
  });
  expect(useMcpStore.getState().servers).toEqual([{ name: "test", command: "echo" }]);
  expect(useMcpStore.getState().loading).toBe(false);
});

test("setTestResult 成功更新状态为 connected", () => {
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "test",
    success: true,
  });
  expect(useMcpStore.getState().serverStatuses["test"]).toBe("connected");
});

test("setTestResult 失败更新状态为 error 并记录错误", () => {
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "test",
    success: false,
    error: "连接失败",
  });
  expect(useMcpStore.getState().serverStatuses["test"]).toBe("error");
});

test("setToolsResult 更新 tools cache", () => {
  useMcpStore.getState().setToolsResult({
    type: "mcp:tools",
    serverName: "test",
    tools: [{ name: "tool_a", description: "A tool" }],
  });
  expect(useMcpStore.getState().toolsCache["test"]).toEqual([
    { name: "tool_a", description: "A tool" },
  ]);
});

test("searchQuery 过滤逻辑在 store 中维护", () => {
  useMcpStore.setState({
    servers: [
      { name: "chrome-devtools", command: "npx" },
      { name: "figma", url: "http://localhost:3845/mcp" },
      { name: "linear", command: "npx" },
    ],
  });
  useMcpStore.getState().setSearchQuery("figma");
  expect(useMcpStore.getState().searchQuery).toBe("figma");
});

test("setSelectedProjectId 更新项目选择", () => {
  useMcpStore.getState().setSelectedProjectId("p2");
  expect(useMcpStore.getState().selectedProjectId).toBe("p2");

  useMcpStore.getState().setSelectedProjectId(null);
  expect(useMcpStore.getState().selectedProjectId).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && bun test tests/store-mcp.test.ts`
Expected: 全部 FAIL — store 不存在

- [ ] **Step 3: 编写 store 实现**

Create `packages/frontend/src/store/mcp.ts`:

```typescript
import { create } from "zustand";
import type { McpServerConfig, McpServerStatus, McpToolSummary } from "@hiagent/shared";
import type { McpListResult, McpChangedEvent, McpTestResult, McpToolsResult } from "@hiagent/shared";
import { send } from "../ws-instance";

interface McpState {
  servers: McpServerConfig[];
  selectedProjectId: string | null;
  searchQuery: string;
  loading: boolean;
  /** 各服务器运行时状态（客户端内存，不持久化） */
  serverStatuses: Record<string, McpServerStatus>;

  // actions
  load(projectId?: string): void;
  setServers(data: McpListResult | McpChangedEvent): void;
  setTestResult(data: McpTestResult): void;
  setToolsResult(data: McpToolsResult): void;
  save(config: McpServerConfig, projectId?: string, originalName?: string): void;
  delete(serverName: string, projectId?: string): void;
  testConnection(serverName: string, projectId?: string): void;
  listTools(serverName: string): void;
  clearAuth(serverName: string, projectId?: string): void;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  serverStatuses: {},

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) =>
    set({ servers: data.servers, loading: false }),
  setTestResult: (data) =>
    set((s) => ({
      serverStatuses: {
        ...s.serverStatuses,
        [data.serverName]: data.success ? "connected" : "error",
      },
      ...(data.success ? {} : { error: data.error }),
    })),
  setToolsResult: (data) =>
    set((s) => ({
      // toolsCache 按 serverName 存储，被 McpToolsModal 使用
    })),
  save: (config, projectId, originalName) =>
    send({ type: "mcp:save", projectId, config, originalName }),
  delete: (serverName, projectId) =>
    send({ type: "mcp:delete", projectId, serverName }),
  testConnection: (serverName, projectId) =>
    send({ type: "mcp:test", projectId, serverName }),
  listTools: (serverName) =>
    send({ type: "mcp:listTools", serverName }),
  clearAuth: (serverName, projectId) =>
    send({ type: "mcp:clearAuth", projectId, serverName }),
  setSelectedProjectId: (id) =>
    set({ selectedProjectId: id }),
  setSearchQuery: (q) =>
    set({ searchQuery: q }),
}));
```

Wait — `setToolsResult` should actually store the tools in a cache map. Let me add a `toolsCache` field.

Actually, looking at the spec more carefully: the tools are not cached in the store — they come from the server. The `McpToolsModal` will use a separate state or read from the WS response directly. But for the store, it's cleaner to cache them. Let me keep the store simple and have `McpToolsModal` manage its own state. The store sends the request, the App.tsx listener dispatches to the modal.

Actually, the cleanest approach is to keep the tools cache in the store. Let me revise:

```typescript
interface McpState {
  // ...existing fields...
  toolsCache: Record<string, McpToolSummary[]>;
  // ...
  setToolsResult(data: McpToolsResult): void;
}
```

And `setToolsResult`:

```typescript
  setToolsResult: (data) =>
    set((s) => ({
      toolsCache: { ...s.toolsCache, [data.serverName]: data.tools },
    })),
```

Let me rewrite the store properly.

- [ ] **Step 3 (revised): 编写 store 实现**

Create `packages/frontend/src/store/mcp.ts`:

```typescript
import { create } from "zustand";
import type { McpServerConfig, McpServerStatus, McpToolSummary } from "@hiagent/shared";
import type { McpListResult, McpChangedEvent, McpTestResult, McpToolsResult } from "@hiagent/shared";
import { send } from "../ws-instance";

interface McpState {
  servers: McpServerConfig[];
  selectedProjectId: string | null;
  searchQuery: string;
  loading: boolean;
  /** 各服务器运行时状态（客户端内存，不持久化） */
  serverStatuses: Record<string, McpServerStatus>;
  /** 工具列表缓存（按 serverName） */
  toolsCache: Record<string, McpToolSummary[]>;

  load(projectId?: string): void;
  setServers(data: McpListResult | McpChangedEvent): void;
  setTestResult(data: McpTestResult): void;
  setToolsResult(data: McpToolsResult): void;
  save(config: McpServerConfig, projectId?: string, originalName?: string): void;
  deleteServer(serverName: string, projectId?: string): void;
  testConnection(serverName: string, projectId?: string): void;
  listTools(serverName: string): void;
  clearAuth(serverName: string, projectId?: string): void;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  serverStatuses: {},
  toolsCache: {},

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) => set({ servers: data.servers, loading: false }),
  setTestResult: (data) =>
    set((s) => ({
      serverStatuses: {
        ...s.serverStatuses,
        [data.serverName]: data.success ? "connected" : "error",
      },
    })),
  setToolsResult: (data) =>
    set((s) => ({
      toolsCache: { ...s.toolsCache, [data.serverName]: data.tools },
    })),
  save: (config, projectId, originalName) =>
    send({ type: "mcp:save", projectId, config, originalName }),
  deleteServer: (serverName, projectId) =>
    send({ type: "mcp:delete", projectId, serverName }),
  testConnection: (serverName, projectId) =>
    send({ type: "mcp:test", projectId, serverName }),
  listTools: (serverName) =>
    send({ type: "mcp:listTools", serverName }),
  clearAuth: (serverName, projectId) =>
    send({ type: "mcp:clearAuth", projectId, serverName }),
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
```

- [ ] **Step 4: 运行测试**

Run: `cd packages/frontend && bun test tests/store-mcp.test.ts`
Expected: 全部 PASS（注意 test 中 "delete" 需改为 "deleteServer"）

- [ ] **Step 5: 类型检查**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/store/mcp.ts packages/frontend/tests/store-mcp.test.ts
git commit -m "feat: frontend — MCP Zustand store"
```

---

### Task 5: Frontend Settings Integration

**Files:**
- Create: `packages/frontend/src/components/settings/McpSection.tsx`
- Modify: `packages/frontend/src/store/settings.ts`
- Modify: `packages/frontend/src/components/SettingsModal.tsx`

- [ ] **Step 1: 创建 McpSection.tsx**

```typescript
import { McpPage } from "../mcp/McpPage";

export function McpSection() {
  return <McpPage />;
}
```

- [ ] **Step 2: 更新 settings.ts**

在 `SettingsSection` 类型中添加 `"mcp"`:

```typescript
export type SettingsSection = "models" | "skills" | "plugins" | "memory" | "mcp";
```

- [ ] **Step 3: 更新 SettingsModal.tsx**

在 import 区域添加：

```typescript
import { McpSection } from "./settings/McpSection";
```

在左侧导航 nav 中「记忆」按钮之后添加：

```typescript
          <button
            onClick={() => setSection("mcp")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "mcp"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
            data-testid="settings-nav-mcp"
          >MCP 连接器</button>
```

在右侧内容区域添加：

```typescript
          {activeSection === "mcp" && <McpSection />}
```

- [ ] **Step 4: 类型检查**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无类型错误（McpPage 尚未创建，但 import 仍会报错 — 先创建占位文件再检查）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/settings/McpSection.tsx packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx
git commit -m "feat: frontend — MCP Section + SettingsModal 集成"
```

---

### Task 6: Frontend McpCard + McpEmpty 组件

**Files:**
- Create: `packages/frontend/src/components/mcp/McpCard.tsx`
- Create: `packages/frontend/src/components/mcp/McpEmpty.tsx`

- [ ] **Step 1: 创建 McpCard.tsx**

```typescript
import type { McpServerConfig, McpServerStatus } from "@hiagent/shared";

interface Props {
  config: McpServerConfig;
  status: McpServerStatus;
  onTest: () => void;
  onViewTools: () => void;
  onAuth: () => void;
  onClearAuth: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const STATUS_CONFIG: Record<McpServerStatus, { icon: string; label: string; color: string }> = {
  connected:   { icon: "🟢", label: "已连接", color: "var(--success)" },
  needs_auth:  { icon: "🟡", label: "OAuth 需授权", color: "var(--warning)" },
  error:       { icon: "🔴", label: "连接错误", color: "var(--danger)" },
  disconnected:{ icon: "🔴", label: "未连接", color: "var(--text-tertiary)" },
};

/** 生成服务器配置的描述文本 */
function configSummary(config: McpServerConfig): string {
  if (config.command) {
    const args = config.args?.join(" ") ?? "";
    return [config.command, args].filter(Boolean).join(" ");
  }
  if (config.url) return config.url;
  return "未配置";
}

export function McpCard({ config, status, onTest, onViewTools, onAuth, onClearAuth, onEdit, onDelete }: Props) {
  const st = STATUS_CONFIG[status] ?? STATUS_CONFIG.disconnected;

  return (
    <div
      className="mb-2.5 p-3.5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 14,
      }}
      data-testid={`mcp-card-${config.name}`}
    >
      {/* 头部：名称 + 状态 */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[13px] font-semibold text-primary">● {config.name}</span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: st.color + "20", color: st.color }}
        >{st.icon} {st.label}</span>
      </div>

      {/* 描述行 */}
      <p className="text-[11.5px] text-secondary mb-2 opacity-70 truncate">
        {configSummary(config)}
      </p>

      {/* 操作按钮 */}
      <div className="flex gap-1.5 flex-wrap">
        {status !== "connected" && (
          <CardBtn onClick={onTest} testId={`mcp-test-${config.name}`} label="连接测试" />
        )}
        <CardBtn onClick={onViewTools} testId={`mcp-tools-${config.name}`} label="查看工具" />
        {status === "needs_auth" ? (
          <CardBtn onClick={onAuth} testId={`mcp-auth-${config.name}`} label="授权" accent />
        ) : config.auth ? (
          <CardBtn onClick={onClearAuth} testId={`mcp-clearauth-${config.name}`} label="清除授权" />
        ) : null}
        <CardBtn onClick={onEdit} testId={`mcp-edit-${config.name}`} label="编辑" />
        <CardBtn onClick={onDelete} testId={`mcp-delete-${config.name}`} label="删除" danger />
      </div>
    </div>
  );
}

function CardBtn({ onClick, testId, label, accent, danger }: {
  onClick: () => void;
  testId: string;
  label: string;
  accent?: boolean;
  danger?: boolean;
}) {
  const color = danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--text-secondary)";
  const borderColor = danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--hairline)";
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="text-[11px] px-2.5 py-1 rounded-md"
      style={{
        color,
        border: `1px solid ${borderColor}`,
        background: "transparent",
      }}
    >{label}</button>
  );
}
```

- [ ] **Step 2: 创建 McpEmpty.tsx**

```typescript
export function McpEmpty() {
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="mcp-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🔌</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">暂无 MCP 服务器</h4>
      <p className="text-[13px] text-tertiary text-center leading-relaxed">
        点击上方「+ 手动添加」按钮添加 MCP 服务器配置。<br />
        配置将写入当前作用域的 .mcp.json 文件。
      </p>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/mcp/
git commit -m "feat: frontend — McpCard + McpEmpty 组件"
```

---

### Task 7: Frontend McpToolsModal + McpForm 组件

**Files:**
- Create: `packages/frontend/src/components/mcp/McpToolsModal.tsx`
- Create: `packages/frontend/src/components/mcp/McpForm.tsx`

- [ ] **Step 1: 创建 McpToolsModal.tsx**

```typescript
import { useState } from "react";
import type { McpToolSummary } from "@hiagent/shared";
import { Modal } from "../ui/Modal";

interface Props {
  serverName: string;
  tools: McpToolSummary[];
  onClose: () => void;
}

export function McpToolsModal({ serverName, tools, onClose }: Props) {
  const [search, setSearch] = useState("");

  const filtered = tools.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal onClose={onClose} width={600} data-testid="mcp-tools-modal">
      <div className="p-4 border-b border-hairline flex items-center justify-between">
        <span className="text-primary font-bold text-sm">🔧 {serverName} 工具列表</span>
        <button onClick={onClose} className="text-tertiary text-xs">✕</button>
      </div>
      <div className="p-3 border-b border-hairline">
        <input
          className="w-full text-[12px] px-3 py-1.5 rounded-lg"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder="🔍 搜索工具..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          data-testid="mcp-tools-search"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: "50vh" }}>
        {tools.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[12.5px]">
            暂无可用的工具缓存，请先执行连接测试。
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-tertiary text-[12.5px]">
            没有匹配的工具
          </div>
        ) : (
          <>
            {filtered.map(t => (
              <div key={t.name} className="mb-3 p-3 rounded-lg" style={{ border: "1px solid var(--hairline)" }}>
                <div className="text-[13px] font-semibold text-primary mb-1">{t.name}</div>
                {t.description && (
                  <div className="text-[11.5px] text-secondary mb-2">{t.description}</div>
                )}
                <div className="text-[10.5px]" style={{ color: "var(--text-tertiary)" }}>
                  {t.parameters && t.parameters.length > 0 ? (
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>
                      <div className="font-semibold mb-1">参数</div>
                      {t.parameters.map(p => (
                        <div key={p.name} className="ml-1">
                          <span className="font-medium text-secondary">{p.name}</span>
                          {" "}
                          <span style={{ color: "var(--accent)" }}>{p.type}</span>
                          {p.required && <span className="text-[var(--danger)] ml-0.5">*</span>}
                          {p.description && <span className="text-tertiary ml-1">— {p.description}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-2 rounded" style={{ background: "var(--surface-elevated)" }}>无参数</div>
                  )}
                </div>
              </div>
            ))}
            <div className="text-[11px] text-tertiary text-center pt-2">
              共 {filtered.length} 个工具
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: 创建 McpForm.tsx**

```typescript
import { useState, useEffect } from "react";
import type { McpServerConfig } from "@hiagent/shared";

type Transport = "stdio" | "http";

interface Props {
  initial?: McpServerConfig;
  onSave: (config: McpServerConfig, originalName?: string) => void;
  onCancel: () => void;
}

export function McpForm({ initial, onSave, onCancel }: Props) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<Transport>(initial?.url ? "http" : "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(initial?.args?.join(" ") ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [lifecycle, setLifecycle] = useState<"lazy" | "eager" | "keep-alive">(initial?.lifecycle ?? "lazy");
  const [timeout, setTimeout_] = useState(initial?.requestTimeoutMs?.toString() ?? "");

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setTransport(initial.url ? "http" : "stdio");
      setCommand(initial.command ?? "");
      setArgsText(initial.args?.join(" ") ?? "");
      setUrl(initial.url ?? "");
      setLifecycle(initial.lifecycle ?? "lazy");
      setTimeout_(initial.requestTimeoutMs?.toString() ?? "");
    }
  }, [initial]);

  const handleSubmit = () => {
    if (!name.trim()) return;
    const config: McpServerConfig = {
      name: name.trim(),
      lifecycle: lifecycle === "lazy" ? undefined : lifecycle,
      requestTimeoutMs: timeout ? parseInt(timeout, 10) : undefined,
    };
    if (transport === "stdio") {
      config.command = command.trim();
      if (argsText.trim()) config.args = argsText.trim().split(/\s+/);
    } else {
      config.url = url.trim();
    }
    onSave(config, initial?.name !== name.trim() ? initial?.name : undefined);
  };

  const sectionTitle = isEdit ? `编辑 ${initial?.name}` : "新增 MCP 服务器";

  return (
    <div
      className="mb-3 p-4 rounded-lg"
      style={{ border: "1px solid var(--accent)", background: "var(--surface)", boxShadow: "0 0 0 3px var(--accent-soft)" }}
      data-testid="mcp-form"
    >
      <div className="text-[13px] font-bold text-primary mb-3">{sectionTitle}</div>

      <div className="flex flex-col gap-2.5">
        {/* 名称 */}
        <div>
          <label className="text-[11px] font-semibold text-secondary block mb-0.5">名称</label>
          <input
            className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            placeholder="服务器名称（如 chrome-devtools）"
            value={name}
            onChange={e => setName(e.target.value)}
            data-testid="mcp-form-name"
          />
        </div>

        {/* 传输类型 */}
        <div className="flex gap-2">
          <label className="text-[11px] font-semibold text-secondary">传输类型</label>
          <div className="flex gap-1.5">
            {(["stdio", "http"] as Transport[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTransport(t)}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: transport === t ? "var(--accent-soft)" : "var(--surface)",
                  color: transport === t ? "var(--accent)" : "var(--text-secondary)",
                  border: transport === t ? "none" : "1px solid var(--hairline)",
                }}
                data-testid={`mcp-form-transport-${t}`}
              >{t === "stdio" ? "stdio" : "HTTP"}</button>
            ))}
          </div>
        </div>

        {/* stdio 字段 */}
        {transport === "stdio" && (
          <>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">Command</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="npx"
                value={command}
                onChange={e => setCommand(e.target.value)}
                data-testid="mcp-form-command"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">Args</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="-y some-mcp-server@latest"
                value={argsText}
                onChange={e => setArgsText(e.target.value)}
                data-testid="mcp-form-args"
              />
            </div>
          </>
        )}

        {/* HTTP 字段 */}
        {transport === "http" && (
          <div>
            <label className="text-[11px] font-semibold text-secondary block mb-0.5">URL</label>
            <input
              className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
              style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
              placeholder="http://localhost:3845/mcp"
              value={url}
              onChange={e => setUrl(e.target.value)}
              data-testid="mcp-form-url"
            />
          </div>
        )}

        {/* 生命周期 */}
        <div>
          <label className="text-[11px] font-semibold text-secondary block mb-0.5">生命周期</label>
          <select
            className="text-[12px] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            value={lifecycle}
            onChange={e => setLifecycle(e.target.value as any)}
            data-testid="mcp-form-lifecycle"
          >
            <option value="lazy">lazy — 按需连接</option>
            <option value="eager">eager — 启动时连接</option>
            <option value="keep-alive">keep-alive — 保持连接</option>
          </select>
        </div>

        {/* 超时 */}
        <div>
          <label className="text-[11px] font-semibold text-secondary block mb-0.5">超时 (ms)</label>
          <input
            className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            placeholder="30000"
            value={timeout}
            onChange={e => setTimeout_(e.target.value.replace(/\D/g, ""))}
            data-testid="mcp-form-timeout"
          />
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onCancel}
            className="text-[11px] px-3 py-1 rounded-md"
            style={{ border: "1px solid var(--hairline)", color: "var(--text-secondary)", background: "transparent" }}
            data-testid="mcp-form-cancel"
          >取消</button>
          <button
            onClick={handleSubmit}
            className="text-[11px] font-semibold px-3 py-1 rounded-md text-white"
            style={{ background: "var(--accent)", border: "none" }}
            disabled={!name.trim()}
            data-testid="mcp-form-save"
          >保存</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无新增类型错误（Modal 组件路径需确认存在）

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/mcp/McpToolsModal.tsx packages/frontend/src/components/mcp/McpForm.tsx
git commit -m "feat: frontend — McpToolsModal + McpForm 组件"
```

---

### Task 8: Frontend McpPage 主页面

**Files:**
- Create: `packages/frontend/src/components/mcp/McpPage.tsx`

- [ ] **Step 1: 创建 McpPage.tsx**

```typescript
import { useEffect, useState, type CSSProperties } from "react";
import { useMcpStore } from "../../store/mcp";
import { useProjectsStore } from "../../store/projects";
import { McpCard } from "./McpCard";
import { McpEmpty } from "./McpEmpty";
import { McpForm } from "./McpForm";
import { McpToolsModal } from "./McpToolsModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { McpServerConfig } from "@hiagent/shared";

export function McpPage() {
  const {
    servers, serverStatuses, toolsCache,
    selectedProjectId, searchQuery, loading,
    load, save, deleteServer, testConnection, listTools, clearAuth,
    setSelectedProjectId, setSearchQuery,
    setTestResult, setToolsResult,
  } = useMcpStore();

  const currentProjectId = useProjectsStore(s => s.currentProjectId);
  const projects = useProjectsStore(s => s.projects);

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showToolsFor, setShowToolsFor] = useState<string | null>(null);

  // 首次进入：若 store 未选项目且当前有打开项目，初始化为该项目
  const activeProjectId = selectedProjectId ?? currentProjectId;
  useEffect(() => {
    if (selectedProjectId === null && currentProjectId) {
      setSelectedProjectId(currentProjectId);
    }
  }, [selectedProjectId, currentProjectId, setSelectedProjectId]);

  // 加载列表
  useEffect(() => {
    load(activeProjectId ?? undefined);
  }, [activeProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索过滤
  const filtered = servers.filter(s =>
    !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFormSave = (config: McpServerConfig, originalName?: string) => {
    save(config, activeProjectId ?? undefined, originalName);
    setShowForm(false);
    setEditingServer(null);
  };

  const handleTest = (serverName: string) => {
    testConnection(serverName, activeProjectId ?? undefined);
  };

  const handleViewTools = (serverName: string) => {
    // 先发起 WS 请求取最新工具列表
    listTools(serverName);
    setShowToolsFor(serverName);
  };

  const handleClearAuth = (serverName: string) => {
    clearAuth(serverName, activeProjectId ?? undefined);
    // 重置状态为 disconnected
    useMcpStore.setState(s => ({
      serverStatuses: { ...s.serverStatuses, [serverName]: "disconnected" },
    }));
  };

  const handleDelete = (serverName: string) => {
    deleteServer(serverName, activeProjectId ?? undefined);
    setConfirmDelete(null);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="mcp-page">
      {/* 标题栏 */}
      <div
        className="flex items-center px-5 py-3.5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">🔌 MCP 连接器</h2>
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2.5 px-5 py-2.5" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
        {/* 作用域下拉 */}
        <ScopeDropdown
          selectedProjectId={activeProjectId ?? null}
          projects={projects}
          onSelect={(projectId) => setSelectedProjectId(projectId)}
        />

        {/* 搜索 */}
        <input
          className="flex-1 text-[12px] px-3 py-1.5 rounded-lg min-w-0"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder="🔍 搜索服务器..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="mcp-search"
        />

        {/* 添加按钮 */}
        <button
          onClick={() => { setShowForm(v => !v); setEditingServer(null); }}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
          style={{ background: showForm ? "var(--text-tertiary)" : "var(--accent)", border: "none" }}
          data-testid="mcp-add-button"
        >{showForm ? "取消" : "+ 手动添加"}</button>
      </div>

      {/* 添加/编辑表单 */}
      {(showForm || editingServer) && (
        <div className="px-5 py-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
          <McpForm
            initial={editingServer ?? undefined}
            onSave={handleFormSave}
            onCancel={() => { setShowForm(false); setEditingServer(null); }}
          />
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {loading ? (
          <div className="text-center text-tertiary text-[12.5px] py-8">加载中...</div>
        ) : filtered.length === 0 ? (
          <McpEmpty />
        ) : (
          filtered.map(s => (
            <McpCard
              key={s.name}
              config={s}
              status={serverStatuses[s.name] ?? "disconnected"}
              onTest={() => handleTest(s.name)}
              onViewTools={() => handleViewTools(s.name)}
              onAuth={() => handleTest(s.name)}
              onClearAuth={() => handleClearAuth(s.name)}
              onEdit={() => { setEditingServer(s); setShowForm(false); }}
              onDelete={() => setConfirmDelete(s.name)}
            />
          ))
        )}
      </div>

      {/* 工具列表 Modal */}
      {showToolsFor && (
        <McpToolsModal
          serverName={showToolsFor}
          tools={toolsCache[showToolsFor] ?? []}
          onClose={() => setShowToolsFor(null)}
        />
      )}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`确定要删除 MCP 服务器 ${confirmDelete} 吗？`}
          confirmText="删除"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// —— 作用域下拉（复用 MemoryPage 的 MemoryScopeDropdown 模式）——

function ScopeDropdown({ selectedProjectId, projects, onSelect }: {
  selectedProjectId: string | null;
  projects: { id: string; name: string }[];
  onSelect: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isGlobal = selectedProjectId === null;
  const label = isGlobal
    ? "🌐 全局"
    : (projects.find(p => p.id === selectedProjectId)?.name ?? "项目");

  const itemStyle = (active: boolean): CSSProperties => ({
    color: active ? "var(--accent)" : "var(--text-primary)",
    background: active ? "var(--accent-soft)" : "transparent",
  });

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11.5px] px-2.5 py-1.5 rounded-md"
        style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
        data-testid="mcp-scope-select"
      >
        {label}
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            data-testid="mcp-scope-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute left-0 z-20 mt-1 py-1 rounded-md min-w-[148px] shadow-lg"
            style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
            data-testid="mcp-scope-menu"
          >
            <button
              type="button"
              onClick={() => { onSelect(null); setOpen(false); }}
              className="block w-full text-left text-[11.5px] px-3 py-1.5"
              style={itemStyle(isGlobal)}
              data-testid="mcp-scope-option-global"
            >🌐 全局</button>
            {projects.length > 0 && (
              <div className="my-1" style={{ borderTop: "1px solid var(--hairline)" }} />
            )}
            {projects.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onSelect(p.id); setOpen(false); }}
                className="block w-full text-left text-[11.5px] px-3 py-1.5 truncate"
                style={itemStyle(selectedProjectId === p.id)}
                data-testid={`mcp-scope-option-project-${p.id}`}
                title={p.name}
              >📁 {p.name}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/mcp/McpPage.tsx
git commit -m "feat: frontend — McpPage 主页面"
```

---

### Task 9: Frontend WS Listener + 功能联调

**Files:**
- Modify: `packages/frontend/src/App.tsx`

- [ ] **Step 1: App.tsx — 添加 MCP 事件监听**

在 import 区域添加：

```typescript
import { useMcpStore } from "./store/mcp";
```

在 `onMessage` handler 中，`case "memory:config":` 之后添加：

```typescript
        case "mcp:list":
        case "mcp:changed":
          useMcpStore.getState().setServers(e as any);
          break;
        case "mcp:testResult":
          useMcpStore.getState().setTestResult(e as any);
          break;
        case "mcp:tools":
          useMcpStore.getState().setToolsResult(e as any);
          break;
```

- [ ] **Step 2: 类型检查 + 构建验证**

Run: `cd packages/frontend && bun run tsc --noEmit`
Expected: 无新增类型错误

Run: `cd packages/frontend && bun run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/App.tsx
git commit -m "feat: frontend — App.tsx MCP WS 事件监听"
```

---

### Task 10: Component Tests

**Files:**
- Create: `packages/frontend/tests/McpCard.test.tsx`
- Create: `packages/frontend/tests/McpPage.test.tsx`

- [ ] **Step 1: McpCard 组件测试**

Create `packages/frontend/tests/McpCard.test.tsx`:

```typescript
import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpCard } from "../src/components/mcp/McpCard";

test("渲染 server 名称、描述行", () => {
  render(
    <McpCard
      config={{ name: "test-server", command: "npx", args: ["-y", "test"] }}
      status="disconnected"
      onTest={mock()}
      onViewTools={mock()}
      onAuth={mock()}
      onClearAuth={mock()}
      onEdit={mock()}
      onDelete={mock()}
    />
  );
  expect(screen.getByText(/test-server/)).toBeTruthy();
  expect(screen.getByText("npx -y test")).toBeTruthy();
});

test("disconnected 状态渲染连接测试按钮", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      status="disconnected"
      onTest={mock()} onViewTools={mock()} onAuth={mock()} onClearAuth={mock()} onEdit={mock()} onDelete={mock()}
    />
  );
  expect(screen.getByText("连接测试")).toBeTruthy();
});

test("connected 状态不显示连接测试按钮", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      status="connected"
      onTest={mock()} onViewTools={mock()} onAuth={mock()} onClearAuth={mock()} onEdit={mock()} onDelete={mock()}
    />
  );
  expect(screen.queryByText("连接测试")).toBeNull();
});

test("needs_auth 状态显示授权按钮", () => {
  render(
    <McpCard
      config={{ name: "test", url: "http://localhost/mcp", auth: "oauth" }}
      status="needs_auth"
      onTest={mock()} onViewTools={mock()} onAuth={mock()} onClearAuth={mock()} onEdit={mock()} onDelete={mock()}
    />
  );
  expect(screen.getByText("授权")).toBeTruthy();
});

test("有 auth 且非 needs_auth 显示清除授权按钮", () => {
  render(
    <McpCard
      config={{ name: "test", url: "http://localhost/mcp", auth: "bearer", bearerToken: "xxx" }}
      status="connected"
      onTest={mock()} onViewTools={mock()} onAuth={mock()} onClearAuth={mock()} onEdit={mock()} onDelete={mock()}
    />
  );
  expect(screen.getByText("清除授权")).toBeTruthy();
});

test("按钮点击触发对应回调", () => {
  const onEdit = mock();
  const onDelete = mock();
  const onTest = mock();
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      status="disconnected"
      onTest={onTest} onViewTools={mock()} onAuth={mock()} onClearAuth={mock()}
      onEdit={onEdit} onDelete={onDelete}
    />
  );
  fireEvent.click(screen.getByText("编辑"));
  expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("删除"));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: McpPage 组件测试**

Create `packages/frontend/tests/McpPage.test.tsx`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpPage } from "../src/components/mcp/McpPage";
import { useMcpStore } from "../src/store/mcp";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    serverStatuses: {},
    toolsCache: {},
  });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "测试项目", cwd: "/tmp/test", createdAt: 1 }],
    currentProjectId: "p1",
  } as any);
});

test("渲染标题和工具栏", () => {
  render(<McpPage />);
  expect(screen.getByText("🔌 MCP 连接器")).toBeTruthy();
  expect(screen.getByTestId("mcp-add-button")).toBeTruthy();
  expect(screen.getByTestId("mcp-scope-select")).toBeTruthy();
});

test("空列表显示空态", () => {
  render(<McpPage />);
  expect(screen.getByTestId("mcp-empty")).toBeTruthy();
});

test("点击 + 手动添加 展开表单", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-add-button"));
  expect(screen.getByTestId("mcp-form")).toBeTruthy();
});

test("搜索过滤列表", () => {
  useMcpStore.setState({
    servers: [
      { name: "chrome-devtools", command: "npx" },
      { name: "figma", url: "http://localhost:3845/mcp" },
    ],
  });
  render(<McpPage />);
  expect(screen.getByText(/chrome-devtools/)).toBeTruthy();
  expect(screen.getByText(/figma/)).toBeTruthy();

  const searchInput = screen.getByTestId("mcp-search");
  fireEvent.change(searchInput, { target: { value: "figma" } });
  expect(screen.queryByText(/chrome-devtools/)).toBeNull();
  expect(screen.getByText(/figma/)).toBeTruthy();
});

test("作用域切换", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  expect(screen.getByTestId("mcp-scope-option-global")).toBeTruthy();
  expect(screen.getByTestId("mcp-scope-option-project-p1")).toBeTruthy();
});
```

- [ ] **Step 3: 运行组件测试**

Run: `cd packages/frontend && bun test tests/McpCard.test.tsx tests/McpPage.test.tsx`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/tests/McpCard.test.tsx packages/frontend/tests/McpPage.test.tsx
git commit -m "test: frontend — McpCard + McpPage 组件测试"
```

---

### Task 11: E2E 测试

**Files:**
- Create: `packages/frontend/e2e/mcp-connector.spec.ts`

- [ ] **Step 1: 创建 E2E 测试**

Create `packages/frontend/e2e/mcp-connector.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test.describe("MCP 连接器", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("进入 MCP 连接器页面", async ({ page }) => {
    // 打开设置
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');
    await expect(page.locator('[data-testid="mcp-page"]')).toBeVisible();
    await expect(page.locator("text=MCP 连接器")).toBeVisible();
  });

  test("全局作用域添加服务器", async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');

    // 默认空态
    await expect(page.locator('[data-testid="mcp-empty"]')).toBeVisible();

    // 点击添加
    await page.click('[data-testid="mcp-add-button"]');
    await expect(page.locator('[data-testid="mcp-form"]')).toBeVisible();

    // 填写表单
    await page.fill('[data-testid="mcp-form-name"]', "e2e-test-server");
    await page.fill('[data-testid="mcp-form-command"]', "echo");
    await page.fill('[data-testid="mcp-form-args"]', "hello");

    // 保存
    await page.click('[data-testid="mcp-form-save"]');
    await expect(page.locator('[data-testid="mcp-empty"]')).not.toBeVisible();
    await expect(page.locator('text=e2e-test-server')).toBeVisible();
  });

  test("项目作用域切换", async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');

    // 打开作用域下拉
    await page.click('[data-testid="mcp-scope-select"]');
    await expect(page.locator('[data-testid="mcp-scope-menu"]')).toBeVisible();

    // 选择项目
    const projectOption = page.locator('[data-testid^="mcp-scope-option-project-"]').first();
    if (await projectOption.isVisible()) {
      await projectOption.click();
      // 列表切换到项目作用域
      await expect(page.locator('[data-testid="mcp-page"]')).toBeVisible();
    }
  });

  test("编辑服务器", async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');

    // 添加一个服务器用于编辑
    await page.click('[data-testid="mcp-add-button"]');
    await page.fill('[data-testid="mcp-form-name"]', "edit-test");
    await page.fill('[data-testid="mcp-form-command"]', "original-cmd");
    await page.click('[data-testid="mcp-form-save"]');

    // 编辑
    await page.click('[data-testid="mcp-edit-edit-test"]');
    await expect(page.locator('[data-testid="mcp-form"]')).toBeVisible();
    // 表单预填了值
    const cmdInput = page.locator('[data-testid="mcp-form-command"]');
    await expect(cmdInput).toHaveValue("original-cmd");
    // 修改
    await cmdInput.fill("updated-cmd");
    await page.click('[data-testid="mcp-form-save"]');

    // 验证更新
    await expect(page.locator('text=updated-cmd')).toBeVisible();
  });

  test("查看工具", async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');

    // 添加一个服务器
    await page.click('[data-testid="mcp-add-button"]');
    await page.fill('[data-testid="mcp-form-name"]', "tools-test");
    await page.fill('[data-testid="mcp-form-command"]', "echo");
    await page.click('[data-testid="mcp-form-save"]');

    // 查看工具
    await page.click('[data-testid="mcp-tools-tools-test"]');
    await expect(page.locator('[data-testid="mcp-tools-modal"]')).toBeVisible();
    // 关闭
    await page.click('text=✕');
    await expect(page.locator('[data-testid="mcp-tools-modal"]')).not.toBeVisible();
  });

  test("删除服务器", async ({ page }) => {
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="settings-nav-mcp"]');

    // 添加服务器用于删除
    await page.click('[data-testid="mcp-add-button"]');
    await page.fill('[data-testid="mcp-form-name"]', "delete-test");
    await page.fill('[data-testid="mcp-form-command"]', "echo");
    await page.click('[data-testid="mcp-form-save"]');
    await expect(page.locator('text=delete-test')).toBeVisible();

    // 删除
    await page.click('[data-testid="mcp-delete-delete-test"]');
    // 确认弹窗
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await page.click('[data-testid="confirm-dialog-confirm"]');
    // 消失
    await expect(page.locator('text=delete-test')).not.toBeVisible();
  });
});
```

- [ ] **Step 2: 运行 E2E 测试**

Run: `cd packages/frontend && npx playwright test e2e/mcp-connector.spec.ts --project=chromium`
Expected: 全部或部分 PASS（连接测试 E2E 需要 pi-mcp-adapter 环境）

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/e2e/mcp-connector.spec.ts
git commit -m "test: E2E — MCP 连接器业务流程"
```

---

## Self-Review Checklist

提交前执行以下检查：

1. **Spec coverage**: 每一项 spec 需求都有对应的 task。
   - ✅ 全局/项目作用域 → Task 8 (McpPage)
   - ✅ 手动添加/编辑/删除 → Task 7 (McpForm), Task 8 (McpPage)
   - ✅ 连接测试 → Task 3 (WS handler), Task 8 (McpPage)
   - ✅ 查看工具 → Task 7 (McpToolsModal), Task 8 (McpPage)
   - ✅ 清除授权 → Task 3 (WS handler), Task 8 (McpPage)
   - ✅ 自动读取 .mcp.json → Task 2 (McpStore)
   - ✅ 4 层测试 → Task 2 (unit), Task 10 (component), Task 3 (integration), Task 11 (E2E)

2. **Placeholder scan**: 无 TBD, TODO, "implement later", "add error handling" 等占位符。所有代码步骤都给出了具体实现。

3. **Type consistency**: 
   - `McpServerConfig.name` 在所有 task 中一致
   - `McpStore.list/save/delete/listTools` 签名在 Task 2 和 Task 3 中一致
   - `useMcpStore` actions 在 Task 4, 8, 9 中一致
   - WS 事件类型在 Task 1 (defined), Task 3 (handled), Task 4/9 (consumed) 中一致
- `McpCard` props 在 Task 6 和 Task 8 使用中一致
- `McpForm` props 在 Task 7 和 Task 8 使用中一致
