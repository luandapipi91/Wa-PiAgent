# 系统设置页 + 模型供应商管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话列表下方新增「⚙ 系统设置」入口，打开全屏设置页，提供自定义 LLM 供应商的增删改查 + 连通测试，并通过 Pi extension 注册让会话可用。

**Architecture:** 前端 Zustand store + 全屏 Modal（复用 `components/ui/Modal`）→ WS 事件 → kernel `ProviderStore`（读写 `~/.wa-pi/providers.json`）+ 生成 Pi extension 文件注册到 `settings.json.packages`。连通测试由 kernel 直接 `fetch` 探测，不走 Pi。

**Tech Stack:** React 19 + Zustand 5 + Tailwind 3 + CSS 变量（浅色主题）；kernel Bun + `node:fs/promises` JSON 持久化；测试统一 `bun:test`（前端组件测试经 `bunfig.toml` preload happy-dom）；E2E Playwright。

## Global Constraints

- **语言**：所有回复/注释/沟通用中文；代码标识符保持语义清晰（AGENTS.md §1）
- **测试统一用 `bun:test`**：前端组件测试不是 vitest，靠 `packages/frontend/bunfig.toml` 的 `preload = ["./tests/happydom-setup.ts"]` 提供 happy-dom + WebSocket mock。组件测试 import `{ test, expect, mock } from "bun:test"`
- **精准修改**：只碰必须改的；匹配现有风格（AGENTS.md §4）。复用现有 `ui/Modal`、`ui/ConfirmDialog`，不自建遮罩
- **数据目录**：`WA_PI_DIR`（`packages/shared/src/constants.ts`，env 可覆盖，E2E 隔离用）
- **WS 单例**：前端经 `ws-instance.ts` 的 `send()` / `onMessage()` 收发；store 不直接落盘
- **Pi extension 加载机制**：kernel 写 `~/.wa-pi/settings.json` 的 `packages` 字段（本地路径数组），Pi SDK 启动时加载。参照 `intercom-setup.ts` 模式
- **设计文档**：`docs/superpowers/specs/2026-07-09-settings-provider-management-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/providers.ts` | `ProviderApi` / `ProviderModel` / `ModelProvider` 类型 + WS 事件类型 + `PROVIDERS_FILE` 常量（新独立模块，避免 types.ts 膨胀） |
| `packages/shared/tests/providers.test.ts` | `slugifyProviderName` / `splitModelIds` 纯函数单测 |
| `packages/kernel/src/provider-store.ts` | `ProviderStore` 类：读写 `providers.json` 的 CRUD |
| `packages/kernel/src/provider-extension.ts` | `slugifyProviderName(name, existing)` + `generateProviderExtension(providers)` 生成 Pi extension 文件 |
| `packages/kernel/src/provider-test.ts` | `testProviderConnection({ baseUrl, apiKey, api, models })`：fetch 探测 |
| `packages/kernel/tests/provider-store.test.ts` | ProviderStore CRUD 单测 |
| `packages/kernel/tests/provider-extension.test.ts` | slugify + extension 生成单测 |
| `packages/kernel/tests/provider-test.test.ts` | 连通测试单测（mock fetch） |
| `packages/frontend/src/store/settings.ts` | Zustand：`showSettings` 开关 + `open()`/`close()` |
| `packages/frontend/src/store/providers.ts` | Zustand：providers CRUD + test，经 WS |
| `packages/frontend/src/components/ui/TagInput.tsx` | 通用 tag 录入（`\|`/回车添加、× 移除） |
| `packages/frontend/src/components/SettingsButton.tsx` | 入口按钮（Sidebar 底部） |
| `packages/frontend/src/components/SettingsModal.tsx` | 全屏设置 Modal（左导航 + 右内容） |
| `packages/frontend/src/components/settings/ProviderSection.tsx` | 模型管理区块（卡片列表 + 添加按钮） |
| `packages/frontend/src/components/settings/ProviderCard.tsx` | 单供应商卡片（编辑/测试/删除） |
| `packages/frontend/src/components/settings/ProviderFormModal.tsx` | 添加/编辑二级弹窗（tag + 表格 + 测试连接） |
| `packages/frontend/tests/store-settings.test.ts` | settings store 单测 |
| `packages/frontend/tests/store-providers.test.ts` | providers store 单测 |
| `packages/frontend/tests/TagInput.test.tsx` | TagInput 组件测试 |
| `packages/frontend/tests/SettingsModal.test.tsx` | 设置 Modal 组件测试 |
| `packages/frontend/tests/ProviderFormModal.test.tsx` | 供应商表单组件测试 |
| `packages/frontend/e2e/settings-provider.spec.ts` | E2E：完整供应商管理流程 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | re-export `./providers` |
| `packages/shared/src/types.ts` | `WSClientEvent` / `WSServerEvent` 联合加入新 provider 事件 |
| `packages/shared/src/constants.ts` | 加 `PROVIDERS_FILE` + `GENERATED_DIR` 常量 |
| `packages/kernel/src/ws-server.ts` | `WSServerOpts` 加 `providerStore`；`handle()` 加 4 个 provider case |
| `packages/kernel/src/index.ts` | 启动时 new ProviderStore + 注入 ws-server + 调 `ensureProviderExtensionRegistered()` |
| `packages/frontend/src/App.tsx` | 渲染 `<SettingsModal>`（受 settings store 控制） + App onMessage 路由 provider 事件到 store |
| `packages/frontend/src/components/Sidebar.tsx` | ProjectList 下方加 `<SettingsButton>` |
| `packages/frontend/src/components/ProjectList.tsx` | 底部「新建项目」按钮下方加 SettingsButton（或直接在 Sidebar 加） |
| `CHANGELOG.md` | 顶部加本次变更记录 |

---

## Task 1: shared 类型 + 常量 + 纯函数

**Files:**
- Create: `packages/shared/src/providers.ts`
- Create: `packages/shared/tests/providers.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types.ts`

**Interfaces:**
- Produces: `ProviderApi`, `ProviderModel`, `ModelProvider` 类型；WS 事件类型；`PROVIDERS_FILE`/`GENERATED_DIR` 常量；`slugifyProviderName(name, existingSlugs)` / `splitModelIds(input)` 纯函数

- [ ] **Step 1: 写纯函数失败测试**

Create `packages/shared/tests/providers.test.ts`:

```ts
import { test, expect } from "bun:test";
import { slugifyProviderName, splitModelIds } from "../src/providers";

test("slugifyProviderName 英文 + 空格", () => {
  expect(slugifyProviderName("My DeepSeek", [])).toBe("my-deepseek");
});

test("slugifyProviderName 大写转小写", () => {
  expect(slugifyProviderName("OpenAI", [])).toBe("openai");
});

test("slugifyProviderName 移除特殊字符", () => {
  expect(slugifyProviderName("My Provider! @#$", [])).toBe("my-provider");
});

test("slugifyProviderName 中文移除后 fallback", () => {
  // 纯中文移除后为空，fallback provider-<前6位随机>，这里只断言前缀
  const slug = slugifyProviderName("测试供应商", []);
  expect(slug.startsWith("provider-")).toBe(true);
  expect(slug.length).toBeGreaterThan("provider-".length);
});

test("slugifyProviderName 冲突加后缀", () => {
  expect(slugifyProviderName("My DeepSeek", ["my-deepseek"])).toBe("my-deepseek-2");
  expect(slugifyProviderName("My DeepSeek", ["my-deepseek", "my-deepseek-2"])).toBe("my-deepseek-3");
});

test("slugifyProviderName 空白 fallback", () => {
  expect(slugifyProviderName("   ", []).startsWith("provider-")).toBe(true);
});

test("splitModelIds 多个分隔", () => {
  expect(splitModelIds("a|b|c")).toEqual(["a", "b", "c"]);
});

test("splitModelIds 末尾分隔符丢弃空串", () => {
  expect(splitModelIds("a|")).toEqual(["a"]);
  expect(splitModelIds("a|b|")).toEqual(["a", "b"]);
});

test("splitModelIds 纯空白丢弃", () => {
  expect(splitModelIds("   ")).toEqual([]);
  expect(splitModelIds("a|  |b")).toEqual(["a", "b"]);
});

test("splitModelIds 去空白 trim", () => {
  expect(splitModelIds("  a  |  b  ")).toEqual(["a", "b"]);
});

test("splitModelIds 单值", () => {
  expect(splitModelIds("deepseek-chat")).toEqual(["deepseek-chat"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/tests/providers.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 创建 providers.ts（类型 + 常量 + 纯函数）**

Create `packages/shared/src/providers.ts`:

```ts
// ===== 模型供应商类型定义 =====

/** API 格式（对齐 Pi 的 api 字段子集） */
export type ProviderApi = "openai-completions" | "anthropic-messages";

/** 单个模型 */
export interface ProviderModel {
  id: string;              // 模型 ID，如 "deepseek-chat"
  contextWindow: number;   // 上下文窗口（tokens），默认 128000
  maxTokens: number;       // 最大输出（tokens），默认 4096
}

/** 供应商（纯自定义） */
export interface ModelProvider {
  id: string;              // 内部 uuid，前端生成，用于增删改
  name: string;            // 显示名，如 "My DeepSeek"
  baseUrl: string;         // 如 "https://api.deepseek.com/v1"
  apiKey: string;          // 明文存储（本地单用户应用）
  api: ProviderApi;        // "openai-completions" | "anthropic-messages"
  models: ProviderModel[]; // 模型列表
}

// ===== WS 协议事件（provider 管理）=====

// 前端 → kernel
export interface ProviderListEvent { type: "provider:list"; }
export interface ProviderSaveEvent {
  type: "provider:save";
  provider: ModelProvider;   // 有 id 则更新，无则新增
}
export interface ProviderDeleteEvent {
  type: "provider:delete";
  id: string;
}
export interface ProviderTestEvent {
  type: "provider:test";
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];   // anthropic 探测需用真实 model id
}

// kernel → 前端
export interface ProviderListResult {
  type: "provider:list";
  providers: ModelProvider[];
}
export interface ProviderTestResult {
  type: "provider:test";
  ok: boolean;
  error?: string;
}
export interface ProviderChangedEvent {
  type: "provider:changed";
  providers: ModelProvider[];
}

// ===== 纯函数 =====

/**
 * 把供应商显示名转成 Pi provider 名（slug）。
 * 规则：小写、空格转 -、移除非 [a-z0-9-]、collapse 连续 -。
 * 结果为空（如纯中文/符号）则 fallback provider-<6位随机>。
 * 冲突（slug 已在 existingSlugs 中）则加 -2/-3 后缀。
 */
export function slugifyProviderName(name: string, existingSlugs: string[]): string {
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")   // 移除非英文/数字/空格/连字符（中文等移除）
    .replace(/\s+/g, "-")            // 空格转 -
    .replace(/-+/g, "-")            // collapse 连续 -
    .replace(/^-|-$/g, "");          // 去首尾 -

  // slug 为空（纯非 ASCII）→ fallback
  if (!slug) {
    const rand = Math.random().toString(36).slice(2, 8);
    slug = `provider-${rand}`;
  }

  // 冲突检测：若 slug 在 existingSlugs 中，加 -2/-3/...
  if (existingSlugs.includes(slug)) {
    let i = 2;
    while (existingSlugs.includes(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }
  return slug;
}

/**
 * 把含 | 的输入拆成模型 id 列表（trim + 过滤空串）。
 * "a|b|c" → ["a","b","c"]；"a|" → ["a"]；"  " → []。
 * 用于 TagInput 的分隔逻辑和粘贴批量解析。
 */
export function splitModelIds(input: string): string[] {
  return input
    .split("|")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}
```

- [ ] **Step 4: 加常量到 constants.ts**

Modify `packages/shared/src/constants.ts`，在 `PI_AGENTS_DIR` 那行后面加：

```ts
export const PROVIDERS_FILE = `${WA_PI_DIR}/providers.json`;
export const GENERATED_DIR = `${WA_PI_DIR}/.generated`;   // 自动生成的 Pi extension 文件目录
```

- [ ] **Step 5: 把 provider 事件加入 WS 联合类型**

Modify `packages/shared/src/types.ts`：

在文件顶部 import 加：
```ts
import type {
  ProviderListEvent, ProviderSaveEvent, ProviderDeleteEvent, ProviderTestEvent,
} from "./providers";
```

在 `WSClientEvent` 联合（约 204 行）末尾加这 4 个：
```ts
export type WSClientEvent =
  | PromptEvent | AbortEvent
  | SteerPromoteEvent | SteerImmediateEvent | SteerCancelEvent | SteerClearQueueEvent
  | ProjectCreateEvent | ProjectUpdateEvent | ProjectDeleteEvent | ProjectOpenDirEvent
  | SessionRenameEvent | SessionDeleteEvent
  | AgentConfigGetEvent | AgentConfigSaveEvent
  | ProjectsListRequest | SessionMessagesRequest
  | ProviderListEvent | ProviderSaveEvent | ProviderDeleteEvent | ProviderTestEvent
  | FSHomeRequest | FSRootsRequest | FSListDirRequest;
```

在 `WSServerEvent` 联合（约 276 行）加 3 个（同样 import）：
```ts
import type {
  ProviderListResult, ProviderTestResult, ProviderChangedEvent,
} from "./providers";

export type WSServerEvent =
  | SDKEventEnvelope
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent
  | ProviderListResult | ProviderTestResult | ProviderChangedEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSErrorEvent;
```

- [ ] **Step 6: index.ts re-export**

Modify `packages/shared/src/index.ts`，加一行（如果没有这个文件，先确认其结构；参照现有 export 模式）：

```ts
export * from "./providers";
```

- [ ] **Step 7: 运行测试确认通过**

Run: `bun test packages/shared/tests/providers.test.ts`
Expected: 11/11 PASS

同时 typecheck：`bun run --filter @wa-pi/shared typecheck`（如有该脚本，否则 `cd packages/shared && bunx tsc --noEmit`）
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/providers.ts packages/shared/src/constants.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/tests/providers.test.ts
git commit -m "feat(shared): 模型供应商类型 + WS 事件 + slugify/splitModelIds 纯函数"
```

---

## Task 2: kernel ProviderStore（持久化 CRUD）

**Files:**
- Create: `packages/kernel/src/provider-store.ts`
- Create: `packages/kernel/tests/provider-store.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`（from `@wa-pi/shared`）、`PROVIDERS_FILE`（from `@wa-pi/shared`）
- Produces: `ProviderStore` 类，构造参数 `file: string = PROVIDERS_FILE`，方法：
  - `load(): Promise<ModelProvider[]>` — 读文件，不存在返回 `[]`
  - `save(provider: ModelProvider): Promise<void>` — upsert（按 id 匹配，有则替换，无则追加）
  - `delete(id: string): Promise<void>` — 按 id 删

- [ ] **Step 1: 写失败测试**

Create `packages/kernel/tests/provider-store.test.ts`:

```ts
import { test, expect } from "bun:test";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderStore } from "../src/provider-store";
import type { ModelProvider } from "@wa-pi/shared";

function tmpFile() {
  return join(import.meta.dir, ".tmp-providers-" + Math.random().toString(36).slice(2) + ".json");
}

function sampleProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "p1",
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "deepseek-chat", contextWindow: 64000, maxTokens: 8192 }],
    ...overrides,
  };
}

test("load 文件不存在返回空数组", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  expect(await store.load()).toEqual([]);
  rmSync(f, { force: true });
});

test("save 新增后 load 能读回", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("My DeepSeek");
  rmSync(f, { force: true });
});

test("save 同 id 更新（upsert）", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  await store.save(sampleProvider({ name: "Renamed", apiKey: "sk-new" }));
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("Renamed");
  expect(list[0].apiKey).toBe("sk-new");
  rmSync(f, { force: true });
});

test("delete 按 id 删除", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider({ id: "p1" }));
  await store.save(sampleProvider({ id: "p2", name: "Other" }));
  await store.delete("p1");
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe("p2");
  rmSync(f, { force: true });
});

test("delete 不存在的 id 不报错", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.delete("nonexistent");
  expect(await store.load()).toEqual([]);
  rmSync(f, { force: true });
});

test("save 后文件结构为 { providers: [...] }", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw).toHaveProperty("providers");
  expect(raw.providers).toHaveLength(1);
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/kernel/tests/provider-store.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 ProviderStore**

Create `packages/kernel/src/provider-store.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PROVIDERS_FILE } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";

interface ProvidersFile {
  providers: ModelProvider[];
}

/**
 * 供应商持久化：读写 ~/.wa-pi/providers.json（结构 { providers: [...] }）。
 * 沿用 ConfigStore 的 JSON 文件读写模式：文件不存在视为空。
 */
export class ProviderStore {
  constructor(private file: string = PROVIDERS_FILE) {}

  /** 读取全部供应商；文件不存在返回空数组 */
  async load(): Promise<ModelProvider[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      const data = JSON.parse(raw) as ProvidersFile;
      return data.providers ?? [];
    } catch {
      return [];
    }
  }

  /** 新增或更新（按 provider.id upsert） */
  async save(provider: ModelProvider): Promise<void> {
    const list = await this.load();
    const idx = list.findIndex(p => p.id === provider.id);
    if (idx >= 0) list[idx] = provider;
    else list.push(provider);
    await this.persist(list);
  }

  /** 按 id 删除；不存在则无操作 */
  async delete(id: string): Promise<void> {
    const list = await this.load();
    await this.persist(list.filter(p => p.id !== id));
  }

  /** 写盘 */
  private async persist(providers: ModelProvider[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const data: ProvidersFile = { providers };
    await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/kernel/tests/provider-store.test.ts`
Expected: 6/6 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/provider-store.ts packages/kernel/tests/provider-store.test.ts
git commit -m "feat(kernel): ProviderStore 持久化 CRUD"
```

---

## Task 3: kernel provider-extension（slugify + Pi extension 生成）

**Files:**
- Create: `packages/kernel/src/provider-extension.ts`
- Create: `packages/kernel/tests/provider-extension.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`、`slugifyProviderName`（from shared）、`GENERATED_DIR`（from shared）
- Produces:
  - `slugifyProviders(providers: ModelProvider[]): { provider: ModelProvider; slug: string }[]` — 给每个 provider 分配唯一 slug（基于已分配列表做冲突检测）
  - `generateProviderExtension(providers: ModelProvider[]): string` — 生成 Pi extension TS 文件内容（含 registerProvider 调用）
  - `ensureProviderExtensionRegistered(dir: string): Promise<void>` — 写 extension 文件 + 把路径加入 settings.json.packages（幂等）

- [ ] **Step 1: 写失败测试**

Create `packages/kernel/tests/provider-extension.test.ts`:

```ts
import { test, expect } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  slugifyProviders,
  generateProviderExtension,
  ensureProviderExtensionRegistered,
} from "../src/provider-extension";
import type { ModelProvider } from "@wa-pi/shared";

function sampleProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "p1",
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", contextWindow: 64000, maxTokens: 8192 },
      { id: "deepseek-reasoner", contextWindow: 64000, maxTokens: 8192 },
    ],
    ...overrides,
  };
}

test("slugifyProviders 分配唯一 slug", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "My DeepSeek" }),
    sampleProvider({ id: "p2", name: "OpenAI" }),
  ]);
  expect(result[0].slug).toBe("my-deepseek");
  expect(result[1].slug).toBe("openai");
});

test("slugifyProviders 同名冲突加后缀", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "My DeepSeek" }),
    sampleProvider({ id: "p2", name: "My DeepSeek" }),  // 同名
  ]);
  expect(result[0].slug).toBe("my-deepseek");
  expect(result[1].slug).toBe("my-deepseek-2");
});

test("generateProviderExtension 包含 registerProvider 调用", () => {
  const providers = [sampleProvider()];
  const code = generateProviderExtension(providers);
  expect(code).toContain('pi.registerProvider("my-deepseek"');
  expect(code).toContain('name: "My DeepSeek"');
  expect(code).toContain('baseUrl: "https://api.deepseek.com/v1"');
  expect(code).toContain('apiKey: "sk-test"');
  expect(code).toContain('api: "openai-completions"');
});

test("generateProviderExtension 包含所有模型", () => {
  const code = generateProviderExtension([sampleProvider()]);
  expect(code).toContain('id: "deepseek-chat"');
  expect(code).toContain('id: "deepseek-reasoner"');
  expect(code).toContain("contextWindow: 64000");
  expect(code).toContain("maxTokens: 8192");
});

test("generateProviderExtension 空列表生成空工厂", () => {
  const code = generateProviderExtension([]);
  // 空列表也要是合法的 extension（含 import + 工厂函数，只是不注册任何 provider）
  expect(code).toContain("export default function");
});

test("generateProviderExtension anthropic 格式正确映射", () => {
  const code = generateProviderExtension([sampleProvider({ api: "anthropic-messages" })]);
  expect(code).toContain('api: "anthropic-messages"');
});

test("ensureProviderExtensionRegistered 写 extension 文件 + settings.json packages", async () => {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  // 先放 providers.json 让 store 能读到
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider());

  await ensureProviderExtensionRegistered(dir, store);

  // extension 文件存在
  const extFile = join(dir, ".generated", "provider-extension.ts");
  expect(existsSync(extFile)).toBe(true);
  const code = readFileSync(extFile, "utf8");
  expect(code).toContain('registerProvider("my-deepseek"');

  // settings.json packages 含 extension 路径
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain(extFile);

  rmSync(dir, { recursive: true, force: true });
});

test("ensureProviderExtensionRegistered 幂等不重复写", async () => {
  const dir = join(import.meta.dir, ".tmp-ext2-" + Math.random().toString(36).slice(2));
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider());

  await ensureProviderExtensionRegistered(dir, store);
  await ensureProviderExtensionRegistered(dir, store);  // 二次调用

  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  // packages 中 extension 路径只出现一次
  const extPath = join(dir, ".generated", "provider-extension.ts");
  const count = settings.packages.filter((p: string) => p === extPath).length;
  expect(count).toBe(1);

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/kernel/tests/provider-extension.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 provider-extension.ts**

Create `packages/kernel/src/provider-extension.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { slugifyProviderName, GENERATED_DIR } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";
import type { ProviderStore } from "./provider-store";

/** 给每个 provider 分配唯一 slug（基于已分配列表做冲突检测） */
export function slugifyProviders(providers: ModelProvider[]): { provider: ModelProvider; slug: string }[] {
  const usedSlugs: string[] = [];
  return providers.map(p => {
    const slug = slugifyProviderName(p.name, usedSlugs);
    usedSlugs.push(slug);
    return { provider: p, slug };
  });
}

/**
 * 生成 Pi extension TS 文件内容。
 * 每个 provider 一个 pi.registerProvider() 调用，cost 全填 0（后续可扩展）。
 */
export function generateProviderExtension(providers: ModelProvider[]): string {
  const entries = slugifyProviders(providers);
  const registrations = entries.map(({ provider, slug }) => {
    const modelsCode = provider.models.map(m => `      {
        id: ${JSON.stringify(m.id)},
        name: ${JSON.stringify(m.id)},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ${m.contextWindow},
        maxTokens: ${m.maxTokens},
      }`).join(",\n");
    return `  pi.registerProvider(${JSON.stringify(slug)}, {
    name: ${JSON.stringify(provider.name)},
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: ${JSON.stringify(provider.apiKey)},
    api: ${JSON.stringify(provider.api)},
    models: [
${modelsCode}
    ],
  });`;
  }).join("\n\n");

  return `// 自动生成，勿手改 — 由 WaPi provider-extension.ts 从 providers.json 生成
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
${registrations}
}
`;
}

/**
 * 写 extension 文件到 dir/.generated/provider-extension.ts，
 * 并把该路径加入 dir/settings.json 的 packages（幂等）。
 * 参照 intercom-setup.ts 的 settings.json 写入模式。
 */
export async function ensureProviderExtensionRegistered(
  dir: string,
  store: ProviderStore,
): Promise<void> {
  const providers = await store.load();
  const code = generateProviderExtension(providers);

  // 写 extension 文件（每次覆盖，保证与 providers.json 同步）
  const extDir = join(dir, ".generated");
  await mkdir(extDir, { recursive: true });
  const extFile = join(extDir, "provider-extension.ts");
  await writeFile(extFile, code, "utf8");

  // 把 extension 路径加入 settings.json.packages（幂等）
  const settingsPath = join(dir, "settings.json");
  let settings: { packages?: string[]; [k: string]: unknown } = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    // 文件不存在，用空对象
  }
  const packages = settings.packages ?? [];
  if (!packages.includes(extFile)) {
    packages.push(extFile);
    settings.packages = packages;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }
}
```

> **注意**：这里需要用 `WA_PI_DIR` 作为 dir 默认值。由于 `ensureProviderExtensionRegistered` 在 index.ts 调用时会传 `WA_PI_DIR`，且 extension 文件和 settings.json 都在该目录下，所以 dir 参数贯穿一致。`GENERATED_DIR` 常量已定义但这里用 join(dir, ".generated") 保证测试能注入临时 dir。

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/kernel/tests/provider-extension.test.ts`
Expected: 8/8 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/provider-extension.ts packages/kernel/tests/provider-extension.test.ts
git commit -m "feat(kernel): Pi extension 生成（slugify + registerProvider）"
```

---

## Task 4: kernel provider-test（连通测试 fetch 探测）

**Files:**
- Create: `packages/kernel/src/provider-test.ts`
- Create: `packages/kernel/tests/provider-test.test.ts`

**Interfaces:**
- Consumes: `ProviderApi`、`ProviderModel`
- Produces: `testProviderConnection(input: { baseUrl: string; apiKey: string; api: ProviderApi; models: ProviderModel[] }): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: 写失败测试（mock fetch）**

Create `packages/kernel/tests/provider-test.test.ts`:

```ts
import { test, expect, mock, afterEach } from "bun:test";
import { testProviderConnection } from "../src/provider-test";
import type { ProviderModel } from "@wa-pi/shared";

// mock 全局 fetch
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown = {}) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  ) as any;
}

const models: ProviderModel[] = [{ id: "test-model", contextWindow: 128000, maxTokens: 4096 }];

test("openai-completions GET /models 2xx 成功", async () => {
  mockFetch(200, { data: [] });
  const result = await testProviderConnection({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models,
  });
  expect(result.ok).toBe(true);
});

test("openai-completions 请求带 Authorization Bearer", async () => {
  const fetchMock = mock(async (input: string, init?: any) =>
    new Response("{}", { status: 200 })
  );
  globalThis.fetch = fetchMock as any;
  await testProviderConnection({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe("https://api.deepseek.com/v1/models");
  expect(init.headers["Authorization"]).toBe("Bearer sk-test");
});

test("openai-completions 非 2xx 失败带状态码", async () => {
  mockFetch(401, { error: "invalid api key" });
  const result = await testProviderConnection({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "bad",
    api: "openai-completions",
    models,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("401");
});

test("anthropic-messages POST /messages 2xx 成功", async () => {
  mockFetch(200, { id: "msg_1", content: [] });
  const result = await testProviderConnection({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-test",
    api: "anthropic-messages",
    models,
  });
  expect(result.ok).toBe(true);
});

test("anthropic-messages 带 x-api-key + anthropic-version header", async () => {
  const fetchMock = mock(async (input: string, init?: any) =>
    new Response("{}", { status: 200 })
  );
  globalThis.fetch = fetchMock as any;
  await testProviderConnection({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-test",
    api: "anthropic-messages",
    models,
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  expect(init.headers["x-api-key"]).toBe("sk-ant-test");
  expect(init.headers["anthropic-version"]).toBe("2023-06-01");
});

test("网络错误（fetch reject）返回失败", async () => {
  globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); }) as any;
  const result = await testProviderConnection({
    baseUrl: "https://unreachable.example.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("ECONNREFUSED");
});

test("baseUrl 结尾无 / 自动补全路径", async () => {
  const fetchMock = mock(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as any;
  await testProviderConnection({
    baseUrl: "https://api.deepseek.com/v1/",  // 带尾 /
    apiKey: "sk-test",
    api: "openai-completions",
    models,
  });
  const [url] = fetchMock.mock.calls[0];
  // 不应出现双斜杠
  expect(String(url)).not.toContain("//models");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/kernel/tests/provider-test.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 provider-test.ts**

Create `packages/kernel/src/provider-test.ts`:

```ts
import type { ProviderApi, ProviderModel } from "@wa-pi/shared";

interface TestInput {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

/** 超时 10 秒 */
const TIMEOUT_MS = 10000;

/**
 * 连通测试：kernel 直接 fetch 探测供应商（不走 Pi 注册链路）。
 * - openai-completions → GET {baseUrl}/models，Authorization: Bearer
 * - anthropic-messages → POST {baseUrl}/messages 最小请求，x-api-key + anthropic-version
 * 2xx 视为成功，其他返回失败 + 错误信息。
 */
export async function testProviderConnection(input: TestInput): Promise<TestResult> {
  const base = input.baseUrl.replace(/\/+$/, "");  // 去尾部斜杠
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (input.api === "openai-completions") {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } else {
      // anthropic-messages：发最小请求
      const modelId = input.models[0]?.id ?? "test";
      const res = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: controller.signal,
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `超时（${TIMEOUT_MS}ms）` : msg };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/kernel/tests/provider-test.test.ts`
Expected: 7/7 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/provider-test.ts packages/kernel/tests/provider-test.test.ts
git commit -m "feat(kernel): 供应商连通测试（fetch 探测）"
```

---

## Task 5: kernel WS 接入 + 启动注册

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `ProviderStore`、`testProviderConnection`、`ensureProviderExtensionRegistered`、provider WS 事件类型
- Produces: WS handler 处理 `provider:list/save/delete/test`；kernel 启动时加载 providers + 注册 extension

- [ ] **Step 1: 修改 WSServerOpts + handle**

Modify `packages/kernel/src/ws-server.ts`：

顶部 import 加：
```ts
import type { ProviderStore } from "./provider-store";
import { testProviderConnection } from "./provider-test";
import { ensureProviderExtensionRegistered } from "./provider-extension";
```

`WSServerOpts` interface 加字段：
```ts
export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  providerStore: ProviderStore;      // ← 新增
  agentManager: AgentManager;
  dataDir?: string;                  // ← 新增，WA_PI_DIR，用于 ensureProviderExtensionRegistered
  port?: number;
}
```

在 `handle()` 的 switch 末尾（`fs:listDir` case 之后、闭合 `}` 之前）加 4 个 case：

```ts
      case "provider:list": {
        const providers = await this.opts.providerStore.load();
        reply({ type: "provider:list", providers });
        break;
      }
      case "provider:save": {
        await this.opts.providerStore.save(event.provider);
        // 重新生成 extension + 注册到 settings.json
        if (this.opts.dataDir) {
          await ensureProviderExtensionRegistered(this.opts.dataDir, this.opts.providerStore);
        }
        // 广播全量变更
        const providers = await this.opts.providerStore.load();
        this.broadcast({ type: "provider:changed", providers });
        break;
      }
      case "provider:delete": {
        await this.opts.providerStore.delete(event.id);
        if (this.opts.dataDir) {
          await ensureProviderExtensionRegistered(this.opts.dataDir, this.opts.providerStore);
        }
        const providers = await this.opts.providerStore.load();
        this.broadcast({ type: "provider:changed", providers });
        break;
      }
      case "provider:test": {
        const result = await testProviderConnection({
          baseUrl: event.baseUrl,
          apiKey: event.apiKey,
          api: event.api,
          models: event.models,
        });
        reply({ type: "provider:test", ok: result.ok, error: result.error });
        break;
      }
```

- [ ] **Step 2: 修改 index.ts 启动装配**

Modify `packages/kernel/src/index.ts`：

顶部 import 加：
```ts
import { ProviderStore } from "./provider-store";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { WA_PI_DIR } from "@wa-pi/shared";
```

在 `const configStore = new ConfigStore();` 之后加：
```ts
  const providerStore = new ProviderStore();
  // 启动时把已有 providers 注册成 Pi extension（幂等）
  await ensureProviderExtensionRegistered(WA_PI_DIR, providerStore);
```

修改 `new WSServer({...})` 加入 providerStore + dataDir：
```ts
  const server = new WSServer({
    configStore, projectStore,
    providerStore,          // ← 新增
    dataDir: WA_PI_DIR,   // ← 新增
    agentManager: null as any,
    port: WS_PORT,
  });
```

- [ ] **Step 3: 修复现有 ws-server 测试（构造参数变化）**

现有 `packages/kernel/tests/ws-server.test.ts` 的 `withServer` helper 需补 `providerStore` + `dataDir` 参数。修改 `withServer` 函数：

```ts
async function withServer<T>(
  agentManager: any,
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const { ProviderStore } = await import("../src/provider-store");  // 新增
  const providerStore = new ProviderStore(tmp("ws-prov.json"));    // 新增
  const dataDir = tmp("ws-dir");                                   // 新增
  const server = new WSServer({
    configStore, projectStore,
    providerStore,      // ← 新增
    dataDir,            // ← 新增
    agentManager,
    port: 0,
  });
  // ... 其余不变
```

在 import 区加（如果还没有）：
```ts
import { ProviderStore } from "../src/provider-store";
```
（放在文件顶部其他 import 旁，不用动态 import）

- [ ] **Step 4: 新增 provider WS 集成测试**

在 `ws-server.test.ts` 末尾加（或新建 `packages/kernel/tests/ws-provider.test.ts`）。这里新建独立文件避免现有文件过大：

Create `packages/kernel/tests/ws-provider.test.ts`:

```ts
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent, ModelProvider } from "@wa-pi/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
}

async function withProviderServer<T>(
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-dir");
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    dataDir,
    agentManager: makeMockAgentManager(),
    port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test Provider",
    baseUrl: "https://api.test.com/v1", apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "model-1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

test("provider:list 空列表", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:list" });
    const e = await recv() as any;
    expect(e.type).toBe("provider:list");
    expect(e.providers).toEqual([]);
  });
});

test("provider:save 后 list 能读回 + 广播 changed", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:save", provider: sampleProvider() });
    const changed = await recv() as any;
    expect(changed.type).toBe("provider:changed");
    expect(changed.providers).toHaveLength(1);
    send({ type: "provider:list" });
    const list = await recv() as any;
    expect(list.providers[0].name).toBe("Test Provider");
  });
});

test("provider:delete 后列表为空", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:save", provider: sampleProvider() });
    await recv(); // provider:changed
    send({ type: "provider:delete", id: "p1" });
    const changed = await recv() as any;
    expect(changed.type).toBe("provider:changed");
    expect(changed.providers).toHaveLength(0);
  });
});
```

- [ ] **Step 5: 运行全部 kernel 测试确认通过**

Run: `bun test packages/kernel/tests/`
Expected: 全绿（含新增 ws-provider.test.ts 3 个 + 修改后的 ws-server.test.ts 原有测试不受影响）

- [ ] **Step 6: 提交**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/index.ts packages/kernel/tests/ws-server.test.ts packages/kernel/tests/ws-provider.test.ts
git commit -m "feat(kernel): WS 接入 provider 事件 + 启动时注册 Pi extension"
```

---

## Task 6: 前端 settings store + providers store

**Files:**
- Create: `packages/frontend/src/store/settings.ts`
- Create: `packages/frontend/src/store/providers.ts`
- Create: `packages/frontend/tests/store-settings.test.ts`
- Create: `packages/frontend/tests/store-providers.test.ts`

**Interfaces:**
- Consumes: `ws-instance` 的 `send`/`onMessage`、provider WS 事件类型
- Produces:
  - `useSettingsStore`：`showSettings: boolean`、`open()`、`close()`
  - `useProvidersStore`：`providers`、`load()`、`save(p)`、`remove(id)`、`setProviders(ps)`、`test(input)`

- [ ] **Step 1: 写 settings store 失败测试**

Create `packages/frontend/tests/store-settings.test.ts`:

```ts
import { test, expect, beforeEach } from "bun:test";
import { useSettingsStore } from "../src/store/settings";

beforeEach(() => useSettingsStore.setState({ showSettings: false }));

test("open 设置 showSettings true", () => {
  useSettingsStore.getState().open();
  expect(useSettingsStore.getState().showSettings).toBe(true);
});

test("close 设置 showSettings false", () => {
  useSettingsStore.getState().open();
  useSettingsStore.getState().close();
  expect(useSettingsStore.getState().showSettings).toBe(false);
});
```

- [ ] **Step 2: 实现 settings store**

Create `packages/frontend/src/store/settings.ts`:

```ts
import { create } from "zustand";

interface SettingsState {
  showSettings: boolean;
  open: () => void;
  close: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  showSettings: false,
  open: () => set({ showSettings: true }),
  close: () => set({ showSettings: false }),
}));
```

- [ ] **Step 3: 运行确认通过**

Run: `bun test packages/frontend/tests/store-settings.test.ts`
Expected: 2/2 PASS

- [ ] **Step 4: 写 providers store 失败测试**

Create `packages/frontend/tests/store-providers.test.ts`:

```ts
import { test, expect, beforeEach, mock } from "bun:test";
import { useProvidersStore } from "../src/store/providers";
import * as wsInstance from "../src/ws-instance";
import type { ModelProvider } from "@wa-pi/shared";

// mock send，避免真连 WS
const sendMock = mock();
beforeEach(() => {
  sendMock.mockClear();
  mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
  useProvidersStore.setState({ providers: [], loading: false });
});

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test", baseUrl: "https://api.test.com/v1", apiKey: "sk-x",
    api: "openai-completions",
    models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

test("load 发 provider:list", () => {
  useProvidersStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:list" });
});

test("save 发 provider:save", () => {
  const p = sampleProvider();
  useProvidersStore.getState().save(p);
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:save", provider: p });
});

test("remove 发 provider:delete", () => {
  useProvidersStore.getState().remove("p1");
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:delete", id: "p1" });
});

test("setProviders 更新本地列表", () => {
  const p = sampleProvider();
  useProvidersStore.getState().setProviders([p]);
  expect(useProvidersStore.getState().providers).toHaveLength(1);
});
```

- [ ] **Step 5: 实现 providers store**

Create `packages/frontend/src/store/providers.ts`:

```ts
import { create } from "zustand";
import type { ModelProvider, ProviderApi, ProviderModel } from "@wa-pi/shared";
import { send, onMessage } from "../ws-instance";

interface TestInput {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];
}

interface ProvidersState {
  providers: ModelProvider[];
  loading: boolean;
  load: () => void;
  save: (p: ModelProvider) => void;
  remove: (id: string) => void;
  setProviders: (ps: ModelProvider[]) => void;
  test: (input: TestInput) => Promise<{ ok: boolean; error?: string }>;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loading: false,
  load: () => send({ type: "provider:list" }),
  save: (p) => send({ type: "provider:save", provider: p }),
  remove: (id) => send({ type: "provider:delete", id }),
  setProviders: (ps) => set({ providers: ps, loading: false }),
  test: (input) => new Promise((resolve) => {
    const off = onMessage((e: any) => {
      if (e.type === "provider:test") {
        off();
        resolve({ ok: e.ok, error: e.error });
      }
    });
    send({ type: "provider:test", ...input });
  }),
}));
```

- [ ] **Step 6: 运行确认通过**

Run: `bun test packages/frontend/tests/store-providers.test.ts packages/frontend/tests/store-settings.test.ts`
Expected: 6/6 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/store/settings.ts packages/frontend/src/store/providers.ts packages/frontend/tests/store-settings.test.ts packages/frontend/tests/store-providers.test.ts
git commit -m "feat(frontend): settings + providers Zustand store"
```

---

## Task 7: TagInput 组件

**Files:**
- Create: `packages/frontend/src/components/ui/TagInput.tsx`
- Create: `packages/frontend/tests/TagInput.test.tsx`

**Interfaces:**
- Consumes: `splitModelIds`（from `@wa-pi/shared`）
- Produces: `<TagInput value={string[]} onChange={(tags)=>{}} placeholder?={string} />`

- [ ] **Step 1: 写失败测试**

Create `packages/frontend/tests/TagInput.test.tsx`:

```tsx
import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagInput } from "../src/components/ui/TagInput";

test("渲染初始 tags", () => {
  render(<TagInput value={["a", "b"]} onChange={() => {}} />);
  expect(screen.getByText("a")).toBeTruthy();
  expect(screen.getByText("b")).toBeTruthy();
});

test("输入 | 添加 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a"]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "b|" } });
  expect(onChange).toHaveBeenCalledWith(["a", "b"]);
});

test("回车添加 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a"]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "b" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["a", "b"]);
});

test("点 × 移除 tag", () => {
  const onChange = mock();
  render(<TagInput value={["a", "b"]} onChange={onChange} />);
  // 第一个 tag 的删除按钮
  const removeBtns = screen.getAllByTestId("tag-remove");
  fireEvent.click(removeBtns[0]);
  expect(onChange).toHaveBeenCalledWith(["b"]);
});

test("粘贴 a|b|c 拆成 3 个", () => {
  const onChange = mock();
  render(<TagInput value={[]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "a|b|c|" } });
  expect(onChange).toHaveBeenCalledWith(["a", "b", "c"]);
});

test("纯空白不生成 tag", () => {
  const onChange = mock();
  render(<TagInput value={[]} onChange={onChange} />);
  const input = screen.getByTestId("tag-input-field");
  fireEvent.change(input, { target: { value: "   |" } });
  expect(onChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/frontend/tests/TagInput.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 TagInput**

Create `packages/frontend/src/components/ui/TagInput.tsx`:

```tsx
import { useState, type KeyboardEvent, type ChangeEvent } from "react";
import { splitModelIds } from "@wa-pi/shared";

interface TagInputProps {
  value: string[];              // 当前 tags（= 模型 ID 列表）
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/** 通用 tag 录入：输入 | 添加（分隔即 flush），回车提交，× 移除 */
export function TagInput({ value, onChange, placeholder }: TagInputProps) {
  const [text, setText] = useState("");

  // 输入变化：若含 |，把 | 前的部分加入 tags，| 后的剩余留输入框继续
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    // 含分隔符才 flush（避免每次输入都解析）
    if (!newText.includes("|")) {
      setText(newText);
      return;
    }
    // 拆分：最后一个 | 之前的都成 tag，之后的是新的输入框内容
    const ids = splitModelIds(newText);
    if (ids.length > 0) {
      onChange([...value, ...ids]);
    }
    // splitModelIds 已吃掉所有 | 分隔的部分；残留的纯文本无 |
    setText("");
  };

  // 回车：提交整个输入框文本为一个 tag
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) {
        onChange([...value, trimmed]);
        setText("");
      }
    }
  };

  // 移除指定 tag
  const removeTag = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-sm border border-hairline bg-surface"
      data-testid="tag-input"
      onClick={() => document.getElementById("tag-input-field")?.focus()}
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
          style={{ background: "var(--surface-hover)", color: "var(--primary)" }}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(i); }}
            className="text-tertiary hover:text-danger"
            data-testid="tag-remove"
          >×</button>
        </span>
      ))}
      <input
        id="tag-input-field"
        type="text"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] bg-transparent border-0 outline-none text-sm text-primary"
        data-testid="tag-input-field"
      />
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/frontend/tests/TagInput.test.tsx`
Expected: 6/6 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/ui/TagInput.tsx packages/frontend/tests/TagInput.test.tsx
git commit -m "feat(frontend): TagInput 组件（| 分隔/回车添加、× 移除）"
```

---

## Task 8: ProviderFormModal（供应商表单弹窗）

**Files:**
- Create: `packages/frontend/src/components/settings/ProviderFormModal.tsx`
- Create: `packages/frontend/tests/ProviderFormModal.test.tsx`

**Interfaces:**
- Consumes: `TagInput`、`useProvidersStore`（test action）、`ModelProvider`/`ProviderApi` 类型
- Produces: `<ProviderFormModal initial?: ModelProvider onClose: ()=>{} />` — 编辑时传 initial，新增时不传

- [ ] **Step 1: 写失败测试**

Create `packages/frontend/tests/ProviderFormModal.test.tsx`:

```tsx
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderFormModal } from "../src/components/settings/ProviderFormModal";
import { useProvidersStore } from "../src/store/providers";

beforeEach(() => {
  useProvidersStore.setState({ providers: [] });
});

test("渲染表单字段", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  expect(screen.getByText("供应商名称")).toBeTruthy();
  expect(screen.getByText("Base URL")).toBeTruthy();
  expect(screen.getByText("API Key")).toBeTruthy();
  expect(screen.getByText("API 格式")).toBeTruthy();
  expect(screen.getByText(/模型 ID/)).toBeTruthy();
});

test("必填为空时保存按钮禁用", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(true);
});

test("填写完整 + 添加模型后保存启用", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  // 输入模型 id
  const tagInput = screen.getByTestId("tag-input-field");
  fireEvent.change(tagInput, { target: { value: "model-1|" } });
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(false);
});

test("tag 添加后模型表格出现行", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  // 先填必填
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  // 表格出现该模型 id
  expect(screen.getByText("model-1")).toBeTruthy();
  // 上下文窗口/最大输出输入框存在
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
  expect(screen.getByTestId("model-maxTokens-0")).toBeTruthy();
});

test("编辑模式预填 initial 值", () => {
  render(
    <ProviderFormModal
      initial={{
        id: "p1", name: "Existing", baseUrl: "https://api.existing.com/v1",
        apiKey: "sk-old", api: "openai-completions",
        models: [{ id: "existing-model", contextWindow: 32000, maxTokens: 2048 }],
      }}
      onClose={() => {}}
    />
  );
  expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("Existing");
  expect((screen.getByTestId("field-baseUrl") as HTMLInputElement).value).toBe("https://api.existing.com/v1");
});

test("保存调用 store.save", () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "m1|" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(saveMock).toHaveBeenCalledTimes(1);
  const saved = saveMock.mock.calls[0][0];
  expect(saved.name).toBe("Test");
  expect(saved.models[0].id).toBe("m1");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/frontend/tests/ProviderFormModal.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 ProviderFormModal**

Create `packages/frontend/src/components/settings/ProviderFormModal.tsx`:

```tsx
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { TagInput } from "../ui/TagInput";
import { useProvidersStore } from "../../store/providers";
import type { ModelProvider, ProviderApi, ProviderModel } from "@wa-pi/shared";

interface Props {
  initial?: ModelProvider;   // 编辑时传，新增时不传
  onClose: () => void;
}

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 4096;

export function ProviderFormModal({ initial, onClose }: Props) {
  const save = useProvidersStore(s => s.save);
  const test = useProvidersStore(s => s.test);

  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [api, setApi] = useState<ProviderApi>(initial?.api ?? "openai-completions");
  const [modelIds, setModelIds] = useState<string[]>(initial?.models.map(m => m.id) ?? []);
  // 模型长度配置：key = modelId
  const [modelConfigs, setModelConfigs] = useState<Record<string, ProviderModel>>(
    Object.fromEntries((initial?.models ?? []).map(m => [m.id, m]))
  );
  const [testStatus, setTestStatus] = useState<{ state: "idle" | "testing" | "ok" | "fail"; error?: string }>({ state: "idle" });

  // tag 变化 → 同步 modelConfigs（新增的用默认值，删除的移除）
  const handleTagsChange = (tags: string[]) => {
    setModelIds(tags);
    setModelConfigs(prev => {
      const next: Record<string, ProviderModel> = {};
      for (const id of tags) {
        next[id] = prev[id] ?? { id, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS };
      }
      return next;
    });
  };

  const valid = name.trim() && baseUrl.trim() && apiKey.trim() && modelIds.length > 0;

  const handleSave = () => {
    if (!valid) return;
    const provider: ModelProvider = {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      api,
      models: modelIds.map(id => modelConfigs[id]),
    };
    save(provider);
    onClose();
  };

  const handleTest = async () => {
    setTestStatus({ state: "testing" });
    const result = await test({ baseUrl, apiKey, api, models: modelIds.map(id => modelConfigs[id]) });
    setTestStatus(result.ok ? { state: "ok" } : { state: "fail", error: result.error });
  };

  return (
    <Modal onClose={onClose} width={640} data-testid="provider-form-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-sm">{initial ? "编辑供应商" : "添加供应商"}</span>
      </div>
      <div className="p-4 flex flex-col gap-3 overflow-auto" style={{ maxHeight: "70vh" }}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">供应商名称</span>
          <input
            data-testid="field-name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">Base URL</span>
          <input
            data-testid="field-baseUrl"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API Key</span>
          <input
            data-testid="field-apiKey"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API 格式</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "openai-completions"} onChange={() => setApi("openai-completions")} />
              OpenAI 兼容
            </label>
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "anthropic-messages"} onChange={() => setApi("anthropic-messages")} />
              Anthropic
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">模型 ID（输入 | 添加，× 移除）</span>
          <TagInput value={modelIds} onChange={handleTagsChange} placeholder="输入模型 ID，回车或 | 添加" />
        </div>
        {modelIds.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-secondary">模型列表</span>
            <div className="rounded-sm border border-hairline overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-hover text-tertiary">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">模型 ID</th>
                    <th className="text-left px-2 py-1 font-normal">上下文窗口</th>
                    <th className="text-left px-2 py-1 font-normal">最大输出</th>
                  </tr>
                </thead>
                <tbody>
                  {modelIds.map((id, i) => (
                    <tr key={id} className="border-t border-hairline">
                      <td className="px-2 py-1 text-primary">{id}</td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-contextWindow-${i}`}
                          type="number"
                          value={modelConfigs[id]?.contextWindow ?? DEFAULT_CONTEXT}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], contextWindow: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-maxTokens-${i}`}
                          type="number"
                          value={modelConfigs[id]?.maxTokens ?? DEFAULT_MAX_TOKENS}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], maxTokens: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* 测试连接结果 */}
        {testStatus.state === "testing" && <span className="text-xs text-secondary">测试中…</span>}
        {testStatus.state === "ok" && <span className="text-xs" style={{ color: "var(--success)" }}>✓ 连接成功</span>}
        {testStatus.state === "fail" && <span className="text-xs" style={{ color: "var(--danger)" }}>✗ 失败：{testStatus.error}</span>}
      </div>
      <div className="flex justify-between items-center p-3 border-t border-hairline">
        <button
          onClick={handleTest}
          disabled={!baseUrl || !apiKey}
          className="px-3 py-1.5 rounded-sm text-sm border border-hairline text-secondary hover:text-primary disabled:opacity-50"
        >测试连接</button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline hover:text-primary">取消</button>
          <button
            onClick={handleSave}
            disabled={!valid}
            data-testid="provider-save-btn"
            className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          >保存</button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/frontend/tests/ProviderFormModal.test.tsx`
Expected: 6/6 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/settings/ProviderFormModal.tsx packages/frontend/tests/ProviderFormModal.test.tsx
git commit -m "feat(frontend): ProviderFormModal 供应商表单弹窗"
```

---

## Task 9: ProviderCard + ProviderSection + SettingsModal + SettingsButton + 接线

**Files:**
- Create: `packages/frontend/src/components/settings/ProviderCard.tsx`
- Create: `packages/frontend/src/components/settings/ProviderSection.tsx`
- Create: `packages/frontend/src/components/SettingsModal.tsx`
- Create: `packages/frontend/src/components/SettingsButton.tsx`
- Create: `packages/frontend/tests/SettingsModal.test.tsx`
- Modify: `packages/frontend/src/components/Sidebar.tsx`
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useSettingsStore`、`useProvidersStore`、`ProviderFormModal`、`ConfirmDialog`、`Modal`
- Produces: 完整设置页入口 → 弹窗 → 供应商管理 UI

- [ ] **Step 1: 写 SettingsModal 失败测试**

Create `packages/frontend/tests/SettingsModal.test.tsx`:

```tsx
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "../src/components/SettingsModal";
import { useSettingsStore } from "../src/store/settings";
import { useProvidersStore } from "../src/store/providers";

beforeEach(() => {
  useSettingsStore.setState({ showSettings: false });
  useProvidersStore.setState({ providers: [] });
});

test("渲染设置标题 + 左侧模型管理菜单", () => {
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByText("系统设置")).toBeTruthy();
  expect(screen.getByText("模型管理")).toBeTruthy();
});

test("渲染添加供应商按钮", () => {
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByTestId("add-provider-btn")).toBeTruthy();
});

test("点击添加供应商打开 ProviderFormModal", () => {
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("add-provider-btn"));
  expect(screen.getByTestId("provider-form-modal")).toBeTruthy();
});

test("供应商列表渲染卡片", () => {
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test Provider", baseUrl: "https://api.test.com/v1",
      apiKey: "sk-x", api: "openai-completions",
      models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
    }],
  });
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByText("Test Provider")).toBeTruthy();
  expect(screen.getByText("openai-completions")).toBeTruthy();
});

test("删除供应商弹 ConfirmDialog", () => {
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test", baseUrl: "x", apiKey: "y",
      api: "openai-completions", models: [{ id: "m", contextWindow: 1, maxTokens: 1 }],
    }],
  });
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("provider-delete-p1"));
  expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
});

test("确认删除调用 store.remove", () => {
  const removeMock = mock();
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test", baseUrl: "x", apiKey: "y",
      api: "openai-completions", models: [{ id: "m", contextWindow: 1, maxTokens: 1 }],
    }],
    remove: removeMock,
  });
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("provider-delete-p1"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  expect(removeMock).toHaveBeenCalledWith("p1");
});
```

- [ ] **Step 2: 实现 ProviderCard**

Create `packages/frontend/src/components/settings/ProviderCard.tsx`:

```tsx
import type { ModelProvider } from "@wa-pi/shared";

interface Props {
  provider: ModelProvider;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  testStatus?: { state: "idle" | "testing" | "ok" | "fail"; error?: string };
}

export function ProviderCard({ provider, onEdit, onTest, onDelete, testStatus }: Props) {
  return (
    <div
      className="rounded-sm border border-hairline p-3 flex flex-col gap-2"
      data-testid={`provider-card-${provider.id}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-primary">{provider.name}</span>
          <span className="text-xs text-tertiary">{provider.api}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {provider.models.map(m => (
          <span
            key={m.id}
            className="px-1.5 py-0.5 rounded text-xs"
            style={{ background: "var(--surface-hover)", color: "var(--secondary)" }}
          >{m.id}</span>
        ))}
      </div>
      {testStatus?.state === "testing" && <span className="text-xs text-secondary">测试中…</span>}
      {testStatus?.state === "ok" && <span className="text-xs" style={{ color: "var(--success)" }}>✓ 连接成功</span>}
      {testStatus?.state === "fail" && <span className="text-xs" style={{ color: "var(--danger)" }}>✗ {testStatus.error}</span>}
      <div className="flex gap-2">
        <button onClick={onEdit} className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-primary">编辑</button>
        <button onClick={onTest} className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-primary">测试连接</button>
        <button
          onClick={onDelete}
          className="px-2 py-1 rounded-sm text-xs text-secondary border border-hairline hover:text-danger"
          data-testid={`provider-delete-${provider.id}`}
        >删除</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 实现 ProviderSection**

Create `packages/frontend/src/components/settings/ProviderSection.tsx`:

```tsx
import { useState } from "react";
import { useProvidersStore } from "../../store/providers";
import { ProviderCard } from "./ProviderCard";
import { ProviderFormModal } from "./ProviderFormModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { ModelProvider } from "@wa-pi/shared";

export function ProviderSection() {
  const { providers, remove, test } = useProvidersStore();
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelProvider | null>(null);
  const [testStatuses, setTestStatuses] = useState<Record<string, { state: "idle" | "testing" | "ok" | "fail"; error?: string }>>({});

  const handleTest = async (p: ModelProvider) => {
    setTestStatuses(prev => ({ ...prev, [p.id]: { state: "testing" } }));
    const result = await test({ baseUrl: p.baseUrl, apiKey: p.apiKey, api: p.api, models: p.models });
    setTestStatuses(prev => ({
      ...prev,
      [p.id]: result.ok ? { state: "ok" } : { state: "fail", error: result.error },
    }));
  };

  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto">
      <button
        onClick={() => setAdding(true)}
        className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
        style={{ background: "var(--brand)", color: "var(--on-brand)" }}
        data-testid="add-provider-btn"
      >+ 添加供应商</button>
      {providers.map(p => (
        <ProviderCard
          key={p.id}
          provider={p}
          onEdit={() => setEditing(p)}
          onTest={() => handleTest(p)}
          onDelete={() => setConfirmDelete(p)}
          testStatus={testStatuses[p.id]}
        />
      ))}
      {adding && <ProviderFormModal onClose={() => setAdding(false)} />}
      {editing && <ProviderFormModal initial={editing} onClose={() => setEditing(null)} />}
      {confirmDelete && (
        <ConfirmDialog
          title="删除供应商"
          message={`确定删除「${confirmDelete.name}」？此操作不可撤销。`}
          danger
          confirmText="删除"
          onConfirm={() => { remove(confirmDelete.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: 实现 SettingsModal**

Create `packages/frontend/src/components/SettingsModal.tsx`:

```tsx
import { Modal } from "./ui/Modal";
import { ProviderSection } from "./settings/ProviderSection";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  return (
    <Modal onClose={onClose} width={900} data-testid="settings-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-base">系统设置</span>
      </div>
      <div className="flex" style={{ minHeight: 500, maxHeight: "75vh" }}>
        {/* 左侧导航：本次仅「模型管理」 */}
        <nav className="w-40 border-r border-hairline p-2 flex flex-col gap-1">
          <span className="px-2 py-1.5 rounded-sm text-sm font-medium" style={{ background: "var(--surface-hover)", color: "var(--brand)" }}>
            模型管理
          </span>
        </nav>
        {/* 右侧内容 */}
        <div className="flex-1 overflow-auto">
          <ProviderSection />
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: 实现 SettingsButton**

Create `packages/frontend/src/components/SettingsButton.tsx`:

```tsx
interface Props {
  onClick: () => void;
}

export function SettingsButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand"
      data-testid="settings-btn"
    >⚙ 系统设置</button>
  );
}
```

- [ ] **Step 6: 接线 Sidebar**

Modify `packages/frontend/src/components/Sidebar.tsx`，在 `<ProjectList ... />` 之后、`</aside>` 之前加：

```tsx
import { SettingsButton } from "./SettingsButton";
import { useSettingsStore } from "../store/settings";

// ... 在 return 的 aside 内，ProjectList 之后加：
      <SettingsButton onClick={() => useSettingsStore.getState().open()} />
```

完整 Sidebar.tsx 改动：在 `ProjectList` 组件下方添加 `<SettingsButton>`。

- [ ] **Step 7: 接线 App.tsx**

Modify `packages/frontend/src/App.tsx`：

顶部 import 加：
```ts
import { SettingsModal } from "./components/SettingsModal";
import { useSettingsStore } from "./store/settings";
import { useProvidersStore } from "./store/providers";
```

在 `onMessage` 的 switch 里加 provider 事件路由（在 `error` case 之后）：
```ts
        case "provider:list": useProvidersStore.getState().setProviders(e.providers); break;
        case "provider:changed": useProvidersStore.getState().setProviders(e.providers); break;
```

在 return 的 JSX 末尾（`</div>` 之前，DirTreePicker 之后）加：
```tsx
      {useSettingsStore(s => s.showSettings) && <SettingsModal onClose={() => useSettingsStore.getState().close()} />}
```

- [ ] **Step 8: 运行组件测试确认通过**

Run: `bun test packages/frontend/tests/SettingsModal.test.tsx packages/frontend/tests/TagInput.test.tsx packages/frontend/tests/ProviderFormModal.test.tsx`
Expected: 全绿

- [ ] **Step 9: 运行全部前端测试确认无回归**

Run: `cd packages/frontend && bun test`
Expected: 全绿（含现有测试）

- [ ] **Step 10: 提交**

```bash
git add packages/frontend/src/components/SettingsButton.tsx packages/frontend/src/components/SettingsModal.tsx packages/frontend/src/components/settings/ packages/frontend/src/components/Sidebar.tsx packages/frontend/src/App.tsx packages/frontend/tests/SettingsModal.test.tsx
git commit -m "feat(frontend): 设置页 + 供应商管理 UI + Sidebar 入口接线"
```

---

## Task 10: E2E 测试 + CHANGELOG

**Files:**
- Create: `packages/frontend/e2e/settings-provider.spec.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 写 E2E spec**

Create `packages/frontend/e2e/settings-provider.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe.serial("设置页供应商管理", () => {

  test("打开设置页", async ({ page }) => {
    await page.goto("/");
    // 先建项目让 sidebar 显示（复用 app-flow 的模式）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    });

    await page.goto("/");
    await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByText("模型管理")).toBeVisible();
  });

  test("添加供应商完整流程", async ({ page }) => {
    await page.goto("/");
    // 确保有项目（serial 共享 kernel，可能上一步已建）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("add-provider-btn").click();

    // 填表单
    await page.getByTestId("field-name").fill("E2E Test Provider");
    await page.getByTestId("field-baseUrl").fill("https://api.e2e-test.com/v1");
    await page.getByTestId("field-apiKey").fill("sk-e2e-test");
    // tag 录入模型 id
    await page.getByTestId("tag-input-field").fill("e2e-model-1|");
    await expect(page.getByText("e2e-model-1")).toBeVisible();

    // 保存
    await page.getByTestId("provider-save-btn").click();
    // 卡片出现
    await expect(page.getByText("E2E Test Provider")).toBeVisible({ timeout: 5000 });
  });

  test("删除供应商流程", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();

    // 等待供应商卡片出现（上一步添加的）
    const deleteBtn = page.locator('[data-testid^="provider-delete-"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();

    // ConfirmDialog
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();

    // 卡片消失
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(0, { timeout: 5000 });
  });
});
```

- [ ] **Step 2: 运行 E2E**

Run: `cd packages/frontend && bun run e2e -- --grep "设置页供应商管理"`
Expected: 3/3 PASS

**截图清理**：E2E 完成后，检查并删除所有测试产生的截图文件：
Run: `find packages/frontend -name "*.png" -path "*screenshot*" -delete 2>/dev/null; find packages/frontend -name "test-*.png" -delete 2>/dev/null`

- [ ] **Step 3: 更新 CHANGELOG**

Modify `CHANGELOG.md`，在顶部（`---` 分隔线后）加：

```markdown
## 2026-07-09 — 系统设置页 + 模型供应商管理

- **类型**：新增功能
- **摘要**：新增「⚙ 系统设置」入口与全屏设置页，提供自定义 LLM 供应商管理。支持增删改查供应商（名称/baseURL/apiKey/API格式/模型列表），模型 ID 通过 tag 录入（| 分隔/回车添加），每个模型可配置上下文窗口与最大输出，支持连通测试。供应商通过 Pi extension 的 `pi.registerProvider()` 注册，会话可用 `<slug>/<modelId>` 引用。
- **影响范围**：`shared/src/providers.ts`（新增类型+WS事件+纯函数）、`shared/src/constants.ts`（PROVIDERS_FILE/GENERATED_DIR）、`shared/src/types.ts`（WS联合扩展）、`kernel/src/provider-store.ts`（持久化）、`kernel/src/provider-extension.ts`（Pi extension生成）、`kernel/src/provider-test.ts`（连通测试）、`kernel/src/ws-server.ts`+`index.ts`（WS接入+启动注册）、`frontend/src/store/{settings,providers}.ts`、`frontend/src/components/{SettingsButton,SettingsModal}.tsx`、`frontend/src/components/settings/*`、`frontend/src/components/ui/TagInput.tsx`、`Sidebar.tsx`、`App.tsx`
```

- [ ] **Step 4: 提交**

```bash
git add packages/frontend/e2e/settings-provider.spec.ts CHANGELOG.md
git commit -m "test(e2e): 设置页供应商管理完整流程 + CHANGELOG"
```

---

## 验收清单

实现完成后，逐层验证：

- [ ] **第一层（单元）**：`bun test packages/shared/tests/ packages/kernel/tests/provider-*.test.ts` 全绿
- [ ] **第二层（组件）**：`cd packages/frontend && bun test` 全绿（TagInput/ProviderFormModal/SettingsModal/store）
- [ ] **第三层（API）**：`bun test packages/kernel/tests/ws-provider.test.ts` 全绿（WS 事件 CRUD）
- [ ] **第四层（E2E）**：`cd packages/frontend && bun run e2e -- --grep "设置页"` 全绿
- [ ] **截图清理**：项目内无测试残留截图
- [ ] **CHANGELOG**：已记录
- [ ] **typecheck**：`bun run --filter '*' --if-present typecheck` 全绿
