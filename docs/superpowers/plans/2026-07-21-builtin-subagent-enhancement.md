# 内置 subagent 增强（新增 Plan + 真实提示词/工具展示 + model/thinking 可设置）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 HiAgent 的内置 subagent 体系做三项增强：① 新增 Plan（第 3 个内置类型）；② AgentConfig 展示 pi-subagents 真实的 systemPrompt + builtinToolNames（替换当前的占位假文案）；③ 让用户能给内置 subagent 设置 model/thinking，存在 `~/.hiagent/subagent-overrides.json`，delegate 调起时合并到 svc.spawn。

**Architecture:** 不引入新依赖。pi-subagents 的 default-agents.ts 已经定义了 general-purpose / Explore / Plan 三者的 systemPrompt 和 builtinToolNames——kernel 用一个 WS 事件 `subagent:list` 把这些只读信息暴露给前端。新增 `subagent-overrides.json`（用户级，启动时幂等初始化）保存 model/thinking 覆盖；`spawnViaSubagentsService` 调 `svc.spawn` 前合并覆盖到 `SpawnOptions`。`SUBAGENT_TYPES` 加 Plan；`AgentConfig` 内置分支 model/thinking 控件改为可编辑（其它字段仍只读），保存走新 WS 事件 `subagent:save-override`。

**Tech Stack:** Bun + bun:test（kernel/shared）、React + bun:test + @testing-library/react（frontend）、`@gotgenes/pi-subagents`

## Global Constraints

- 所有代码注释用中文（AGENTS.md 第 1 条）
- 测试框架：kernel/shared 用 `bun:test`；frontend 用 `bun:test` + happy-dom + @testing-library/react
- 类型定义集中在 `packages/shared/src/types.ts`
- `PATH="$HOME/.bun/bin:$PATH"` 前缀跑 bun（环境未默认注入）
- 工作区有与本次无关的未提交改动（CHANGELOG.md / docs/research/*）：**只用 `git add` 指定文件**，**不要 `git commit -am`**
- 每个 Task 结尾 commit，commit message 用 `feat:` / `fix:` / `refactor:` / `test:` / `docs:` 前缀
- baseline 有 3 个预存 fail（testConnection x2 + agent:abort x1），与本功能无关——**不要修**
- 测试用 `--timeout 10000` 避免偶发挂死
- **不改 SessionEntity / ProjectEntity 类型**

**关键路径常量速查**：
- `HIAGENT_DIR` = `~/.hiagent`
- `SUBAGENT_TYPES_FILE` = `~/.hiagent/subagent-overrides.json`（新增）
- pi-subagents 默认 3 个 agent：`general-purpose` / `Explore` / `Plan`（kernel 直接 import `DEFAULT_AGENTS`）

---

## File Structure

| 文件 | 改动类型 | 职责 |
|---|---|---|
| `packages/shared/src/constants.ts` | 修改 | `SUBAGENT_TYPES` 加 Plan；加 `SUBAGENT_OVERRIDES_FILE` 常量 |
| `packages/shared/src/types.ts` | 修改 | 新增 `SubagentOverride` / `SubagentInfo` 类型 + 2 个 WS 事件类型 |
| `packages/kernel/src/subagent-store.ts` | **新建** | 加载/保存 subagent-overrides.json；`ensureSubagentOverrides` 幂等初始化 |
| `packages/kernel/src/subagent-info.ts` | **新建** | 从 pi-subagents DEFAULT_AGENTS 读取 systemPrompt + builtinToolNames |
| `packages/kernel/src/ws-server.ts` | 修改 | 加 2 个 handler：`subagent:list` / `subagent:save-override` |
| `packages/kernel/src/delegate-tool.ts` | 修改 | `spawnViaSubagentsService` 合并 override 到 SpawnOptions |
| `packages/kernel/src/index.ts` | 修改 | 启动时 `ensureSubagentOverrides` |
| `packages/frontend/src/components/AgentConfig.tsx` | 修改 | 内置分支改为：用 WS 拉取真实 systemPrompt + builtinToolNames 展示；model/thinking 可编辑 |
| `packages/frontend/src/store/subagents.ts` | **新建** | zustand store：list / saveOverride / 内置 subagent 信息缓存 |
| `packages/frontend/src/App.tsx` | 修改 | 启动时 `useSubagentsStore.getState().load()` |

---

## Phase 1: shared 类型与常量

依赖：无（最先做）

### Task 1.1: SUBAGENT_TYPES 加 Plan + SUBAGENT_OVERRIDES_FILE 常量

**Files:**
- Modify: `packages/shared/src/constants.ts:59-76`（SUBAGENT_TYPES 数组）
- Modify: `packages/shared/src/constants.ts:24-26` 附近（新增 SUBAGENT_OVERRIDES_FILE）
- Test: `packages/shared/tests/constants.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `SUBAGENT_TYPES` 含 3 项（general-purpose / Explore / Plan）；`SUBAGENT_OVERRIDES_FILE` 路径常量

- [ ] **Step 1: 写失败测试**

在 `packages/shared/tests/constants.test.ts` 的 `SUBAGENT_TYPES` 相关测试附近追加：

```ts
import { SUBAGENT_OVERRIDES_FILE } from "../src/constants";

test("SUBAGENT_TYPES 含 Plan（第 3 个内置类型）", () => {
  const names = SUBAGENT_TYPES.map(t => t.name);
  expect(names).toContain("Plan");
  const plan = SUBAGENT_TYPES.find(t => t.name === "Plan");
  expect(plan).toBeDefined();
  expect(plan!.displayName).toBe("规划子智能体");
  expect(plan!.readOnly).toBe(true);
  expect(plan!.emoji).toBeTruthy();
  expect(plan!.gradient.length).toBe(2);
});

test("isSubagentType / normalizeSubagentType 识别 Plan", () => {
  expect(isSubagentType("Plan")).toBe(true);
  expect(isSubagentType("规划子智能体")).toBe(true);
  expect(normalizeSubagentType("规划子智能体")).toBe("Plan");
  expect(normalizeSubagentType("Plan")).toBe("Plan");
});

test("SUBAGENT_OVERRIDES_FILE 指向 ~/.hiagent/subagent-overrides.json", () => {
  expect(SUBAGENT_OVERRIDES_FILE.endsWith("subagent-overrides.json")).toBe(true);
  expect(SUBAGENT_OVERRIDES_FILE.includes("hiagent")).toBe(true);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/shared/tests/constants.test.ts`
Expected: FAIL，报 `Plan` 不在 SUBAGENT_TYPES 或 `SUBAGENT_OVERRIDES_FILE` 未导出

- [ ] **Step 3: 在 constants.ts 加 Plan + SUBAGENT_OVERRIDES_FILE**

修改 `packages/shared/src/constants.ts`，在 `PROMPTS_FILE` 行附近加：

```ts
export const PROMPTS_FILE = `${HIAGENT_DIR}/prompts.json`;
export const SUBAGENT_OVERRIDES_FILE = `${HIAGENT_DIR}/subagent-overrides.json`;   // 内置 subagent 的 model/thinking 覆盖
```

在 `SUBAGENT_TYPES` 数组末尾追加第 3 项：

```ts
  {
    name: "Plan",
    displayName: "规划子智能体",
    description: "只读代码架构师，探索代码库并设计实施方案。",
    emoji: "📐",
    gradient: ["#7c3aed", "#a78bfa"],
    readOnly: true,
  },
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/shared/tests/constants.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/shared typecheck`
Expected: exit 0

- [ ] **Step 6: commit**

```bash
git add packages/shared/src/constants.ts packages/shared/tests/constants.test.ts
git commit -m "feat(shared): SUBAGENT_TYPES 加 Plan + SUBAGENT_OVERRIDES_FILE 常量"
```

---

### Task 1.2: 新增 SubagentOverride / SubagentInfo 类型 + 2 个 WS 事件

**Files:**
- Modify: `packages/shared/src/types.ts`（在 WS 事件 union 附近）
- Test: `packages/shared/tests/types.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SubagentOverride`：`{ type: string; model?: string | null; thinking?: ThinkingLevel | null }`
  - `SubagentInfo`：`{ name; displayName; description; emoji; gradient; readOnly; systemPrompt; builtinToolNames: string[]; override?: SubagentOverride }`
  - `SubagentListRequest`：`{ type: "subagent:list" }`
  - `SubagentListResult`：`{ type: "subagent:list"; subagents: SubagentInfo[] }`
  - `SubagentSaveOverrideEvent`：`{ type: "subagent:save-override"; override: SubagentOverride }`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/tests/types.test.ts` 末尾追加：

```ts
import type { SubagentOverride, SubagentInfo } from "../src/types";
import type { WSClientEvent, WSServerEvent } from "../src/types";

test("SubagentOverride 类型结构", () => {
  const o: SubagentOverride = { type: "general-purpose", model: "openai/gpt-4o", thinking: "high" };
  expect(o.type).toBe("general-purpose");
  // model / thinking 都可空（不覆盖时省略）
  const o2: SubagentOverride = { type: "Explore" };
  expect(o2.model).toBeUndefined();
});

test("SubagentInfo 含只读字段 + 可选 override", () => {
  const info: SubagentInfo = {
    name: "Explore",
    displayName: "探索子智能体",
    description: "...",
    emoji: "🔍",
    gradient: ["#0891b2", "#06b6d4"],
    readOnly: true,
    systemPrompt: "# CRITICAL: READ-ONLY",
    builtinToolNames: ["read", "bash", "grep", "find", "ls"],
    override: { type: "Explore", model: "openai/gpt-4o" },
  };
  expect(info.builtinToolNames).toHaveLength(5);
});

test("WSClientEvent 含 subagent:list / subagent:save-override", () => {
  const req: WSClientEvent = { type: "subagent:list" };
  const save: WSClientEvent = { type: "subagent:save-override", override: { type: "Plan", thinking: "max" } };
  expect(req.type).toBe("subagent:list");
  expect(save.type).toBe("subagent:save-override");
});

test("WSServerEvent 含 subagent:list 结果", () => {
  const res: WSServerEvent = { type: "subagent:list", subagents: [] };
  expect(res.type).toBe("subagent:list");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/shared/tests/types.test.ts`
Expected: FAIL，报类型未导出

- [ ] **Step 3: 在 types.ts 加类型 + WS 事件**

修改 `packages/shared/src/types.ts`，在 `AgentConfig` 接口附近（约第 40-56 行之后）加：

```ts
/** 内置 subagent 的用户级覆盖（model / thinking）。type = 内置 subagent 英文名。 */
export interface SubagentOverride {
  type: string;
  model?: string | null;
  thinking?: ThinkingLevel | null;
}

/** 内置 subagent 完整信息（前端 AgentConfig 展示用）。systemPrompt/builtinToolNames 来自 pi-subagents，只读。 */
export interface SubagentInfo {
  name: string;
  displayName: string;
  description: string;
  emoji: string;
  gradient: [string, string];
  readOnly: boolean;
  systemPrompt: string;
  builtinToolNames: string[];
  override?: SubagentOverride;
}
```

在 WSClientEvent / WSServerEvent 的 union 里加（找现有的 `ProjectsListRequest` / `AgentListRequest` 附近）：

```ts
// client → kernel
export interface SubagentListRequest { type: "subagent:list"; }
export interface SubagentSaveOverrideEvent {
  type: "subagent:save-override";
  override: SubagentOverride;
}

// kernel → client
export interface SubagentListResult {
  type: "subagent:list";
  subagents: SubagentInfo[];
}
```

然后把它们加入 `WSClientEvent` 和 `WSServerEvent` 联合类型（找现有的 union 列表末尾追加 `| SubagentListRequest | SubagentSaveOverrideEvent` 和 `| SubagentListResult`）。

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/shared/tests/types.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/shared typecheck`
Expected: exit 0

- [ ] **Step 6: commit**

```bash
git add packages/shared/src/types.ts packages/shared/tests/types.test.ts
git commit -m "feat(shared): 新增 SubagentOverride / SubagentInfo 类型 + WS 事件"
```

---

## Phase 2: kernel 数据层（override 存储 + pi-subagents 信息读取）

依赖：Phase 1 完成

### Task 2.1: 新建 subagent-store（加载/保存/初始化 overrides）

**Files:**
- Create: `packages/kernel/src/subagent-store.ts`
- Create: `packages/kernel/tests/subagent-store.test.ts`

**Interfaces:**
- Consumes: `SUBAGENT_OVERRIDES_FILE` from shared
- Produces:
  - `loadSubagentOverrides(): Promise<SubagentOverride[]>`
  - `saveSubagentOverride(override): Promise<SubagentOverride[]>`（返回全量）
  - `getSubagentOverride(type): Promise<SubagentOverride | undefined>`
  - `ensureSubagentOverrides(): Promise<void>`（幂等初始化空 `[]`）

- [ ] **Step 1: 写失败测试**

新建 `packages/kernel/tests/subagent-store.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadSubagentOverrides,
  saveSubagentOverride,
  getSubagentOverride,
  ensureSubagentOverrides,
} from "../src/subagent-store";

function tempFile() {
  return join(import.meta.dir, ".tmp-subagent-overrides-" + Math.random().toString(36).slice(2) + ".json");
}

let file: string;
beforeEach(() => { file = tempFile(); });
afterEach(() => { rmSync(file, { force: true }); });

test("ensureSubagentOverrides 首次调用写入空数组", async () => {
  await ensureSubagentOverrides(file);
  expect(existsSync(file)).toBe(true);
  const data = JSON.parse(readFileSync(file, "utf8"));
  expect(data).toEqual({ overrides: [] });
});

test("ensureSubagentOverrides 二次调用幂等（不覆盖）", async () => {
  writeFileSync(file, JSON.stringify({ overrides: [{ type: "Plan", model: "openai/gpt-4o" }] }));
  await ensureSubagentOverrides(file);
  const data = JSON.parse(readFileSync(file, "utf8"));
  expect(data.overrides).toHaveLength(1);
});

test("ensureSubagentOverrides 失败不抛错（不阻塞启动）", async () => {
  // 路径指向不存在的目录深处
  await expect(ensureSubagentOverrides(join(import.meta.dir, ".non-existent-" + Date.now(), "f.json")))
    .resolves.toBeUndefined();
});

test("saveSubagentOverride 新增覆盖", async () => {
  const all = await saveSubagentOverride(file, { type: "Plan", model: "openai/gpt-4o", thinking: "high" });
  expect(all).toHaveLength(1);
  expect(all[0].type).toBe("Plan");
});

test("saveSubagentOverride 同 type 覆盖已存在记录（不重复）", async () => {
  await saveSubagentOverride(file, { type: "Plan", model: "openai/gpt-4o" });
  const all = await saveSubagentOverride(file, { type: "Plan", model: "glm-4.6", thinking: "max" });
  expect(all).toHaveLength(1);
  expect(all[0].model).toBe("glm-4.6");
  expect(all[0].thinking).toBe("max");
});

test("getSubagentOverride 返回单个记录", async () => {
  await saveSubagentOverride(file, { type: "Explore", thinking: "medium" });
  const o = await getSubagentOverride(file, "Explore");
  expect(o?.thinking).toBe("medium");
  expect(await getSubagentOverride(file, "general-purpose")).toBeUndefined();
});

test("loadSubagentOverrides 文件不存在返回空数组", async () => {
  expect(await loadSubagentOverrides(join(import.meta.dir, ".non-existent-" + Date.now() + ".json"))).toEqual([]);
});

test("loadSubagentOverrides 格式错误降级为空数组", async () => {
  writeFileSync(file, "{ invalid json");
  expect(await loadSubagentOverrides(file)).toEqual([]);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/subagent-store.test.ts`
Expected: FAIL，报 `Cannot find module '../src/subagent-store'`

- [ ] **Step 3: 实现 subagent-store.ts**

新建 `packages/kernel/src/subagent-store.ts`：

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SubagentOverride } from "@hiagent/shared";

/**
 * 加载 subagent-overrides.json。文件不存在或格式错误降级为空数组，绝不抛错。
 */
export async function loadSubagentOverrides(filePath: string): Promise<SubagentOverride[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { overrides?: SubagentOverride[] };
    return Array.isArray(data.overrides) ? data.overrides : [];
  } catch {
    return [];
  }
}

/**
 * 保存单个 subagent 覆盖（同 type 覆盖已存在记录）。返回保存后的全量列表。
 */
export async function saveSubagentOverride(
  filePath: string,
  override: SubagentOverride,
): Promise<SubagentOverride[]> {
  const all = await loadSubagentOverrides(filePath);
  const idx = all.findIndex(o => o.type === override.type);
  if (idx >= 0) all[idx] = override;
  else all.push(override);
  await persist(filePath, all);
  return all;
}

/**
 * 取单个 type 的覆盖记录；不存在返回 undefined。
 */
export async function getSubagentOverride(
  filePath: string,
  type: string,
): Promise<SubagentOverride | undefined> {
  const all = await loadSubagentOverrides(filePath);
  return all.find(o => o.type === type);
}

/**
 * 启动时确保 overrides 文件存在（幂等初始化为 `{ overrides: [] }`）。
 * 失败仅 console.warn，不阻塞 kernel 启动。
 */
export async function ensureSubagentOverrides(filePath: string): Promise<void> {
  try {
    const existing = await loadSubagentOverrides(filePath);
    // loadSubagentOverrides 失败时返回空数组，无法区分"文件不存在"和"空文件"——
    // 改用 stat 判断
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await readFile(filePath, "utf8");
      return;  // 文件存在，不动
    } catch {
      // 文件不存在，写入空配置
      await persist(filePath, existing);
    }
  } catch (e) {
    console.warn("[kernel] ensureSubagentOverrides 失败:", e);
  }
}

/** 内部：持久化到文件 */
async function persist(filePath: string, overrides: SubagentOverride[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ overrides }, null, 2), "utf8");
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/subagent-store.test.ts`
Expected: PASS（7 个全过）

- [ ] **Step 5: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel typecheck`
Expected: exit 0

- [ ] **Step 6: commit**

```bash
git add packages/kernel/src/subagent-store.ts packages/kernel/tests/subagent-store.test.ts
git commit -m "feat(kernel): 新建 subagent-store（加载/保存/初始化 model/thinking 覆盖）"
```

---

### Task 2.2: 新建 subagent-info（从 pi-subagents 读取真实 systemPrompt + builtinToolNames）

**Files:**
- Create: `packages/kernel/src/subagent-info.ts`
- Create: `packages/kernel/tests/subagent-info.test.ts`

**Interfaces:**
- Consumes: `SUBAGENT_TYPES` from shared；pi-subagents `DEFAULT_AGENTS`
- Produces: `getSubagentInfo(overrides): SubagentInfo[]`（合并 SUBAGENT_TYPES 元信息 + pi-subagents 真实 systemPrompt/builtinToolNames + 用户 override）

- [ ] **Step 1: 写失败测试**

新建 `packages/kernel/tests/subagent-info.test.ts`：

```ts
import { test, expect } from "bun:test";
import { getSubagentInfo } from "../src/subagent-info";
import { SUBAGENT_TYPES } from "@hiagent/shared";

test("getSubagentInfo 返回 3 个内置 subagent", () => {
  const infos = getSubagentInfo([]);
  expect(infos).toHaveLength(3);
  const names = infos.map(i => i.name);
  expect(names).toContain("general-purpose");
  expect(names).toContain("Explore");
  expect(names).toContain("Plan");
});

test("getSubagentInfo 含 SUBAGENT_TYPES 的元信息（displayName/emoji/gradient）", () => {
  const infos = getSubagentInfo([]);
  for (const t of SUBAGENT_TYPES) {
    const info = infos.find(i => i.name === t.name);
    expect(info).toBeDefined();
    expect(info!.displayName).toBe(t.displayName);
    expect(info!.emoji).toBe(t.emoji);
    expect(info!.gradient).toEqual(t.gradient);
    expect(info!.readOnly).toBe(t.readOnly);
  }
});

test("getSubagentInfo 从 pi-subagents 读取真实 systemPrompt", () => {
  const infos = getSubagentInfo([]);
  // Explore 与 Plan 的 systemPrompt 是 pi-subagents 内置的 read-only 长文案，不是空串
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.systemPrompt.length).toBeGreaterThan(100);
  expect(explore!.systemPrompt).toContain("READ-ONLY");
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.systemPrompt.length).toBeGreaterThan(100);
  expect(plan!.systemPrompt).toContain("architect");
});

test("getSubagentInfo 从 pi-subagents 读取 builtinToolNames", () => {
  const infos = getSubagentInfo([]);
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
  // general-purpose 未设置 builtinToolNames（继承全部）→ 空数组
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.builtinToolNames).toEqual([]);
});

test("getSubagentInfo 合并用户 override", () => {
  const infos = getSubagentInfo([
    { type: "Explore", model: "openai/gpt-4o", thinking: "high" },
    { type: "Plan", thinking: "max" },
  ]);
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.override).toEqual({ type: "Explore", model: "openai/gpt-4o", thinking: "high" });
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.override?.thinking).toBe("max");
  // 未设置 override 的 general-purpose
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.override).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/subagent-info.test.ts`
Expected: FAIL，报 `Cannot find module '../src/subagent-info'`

- [ ] **Step 3: 实现 subagent-info.ts**

新建 `packages/kernel/src/subagent-info.ts`：

```ts
import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";

/**
 * 从 pi-subagents DEFAULT_AGENTS 读取内置 agent 的真实 systemPrompt + builtinToolNames。
 *
 * pi-subagents 在 src/config/default-agents.ts 里定义了 3 个默认 agent：
 *   general-purpose / Explore / Plan
 * 每个 agent 有 systemPrompt（除 general-purpose 为空串外都非空）+ builtinToolNames（除 general-purpose
 * 未设置外都为 READ_ONLY_TOOLS = ["read","bash","grep","find","ls"]）。
 *
 * 直接 dynamic import DEFAULT_AGENTS 而不是 svc.resolveAgentConfig：避免依赖 service 单例
 * （kernel 启动时 service 可能还没 publish）。
 */
async function loadPiDefaultAgents(): Promise<Map<string, {
  systemPrompt: string;
  builtinToolNames?: string[];
}>> {
  try {
    const mod = await import("@gotgenes/pi-subagents");
    // DEFAULT_AGENTS 是 Map<string, AgentConfig>，含 systemPrompt / builtinToolNames
    const map = (mod as any).DEFAULT_AGENTS as Map<string, any> | undefined;
    if (!map) return new Map();
    const result = new Map<string, { systemPrompt: string; builtinToolNames?: string[] }>();
    for (const [name, cfg] of map.entries()) {
      result.set(name, {
        systemPrompt: cfg.systemPrompt ?? "",
        builtinToolNames: Array.isArray(cfg.builtinToolNames) ? cfg.builtinToolNames : undefined,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

// 缓存 pi-subagents DEFAULT_AGENTS（启动后不变，避免每次 list 都 dynamic import）
let piDefaultsCache: Map<string, { systemPrompt: string; builtinToolNames?: string[] }> | null = null;
async function getPiDefaults() {
  if (piDefaultsCache) return piDefaultsCache;
  piDefaultsCache = await loadPiDefaultAgents();
  return piDefaultsCache;
}

// 仅供测试重置缓存用（test 可注入伪 DEFAULT_AGENTS 时不需此函数，但 export 便于排错）
export function _resetPiDefaultsCache() { piDefaultsCache = null; }

/**
 * 组装内置 subagent 完整信息列表：SUBAGENT_TYPES 元信息 + pi-subagents 真实 systemPrompt/builtinToolNames + 用户 override。
 * 顺序与 SUBAGENT_TYPES 一致。
 */
export async function getSubagentInfo(overrides: SubagentOverride[]): Promise<SubagentInfo[]> {
  const piDefaults = await getPiDefaults();
  return SUBAGENT_TYPES.map(t => {
    const pi = piDefaults.get(t.name);
    return {
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      emoji: t.emoji,
      gradient: t.gradient,
      readOnly: t.readOnly,
      systemPrompt: pi?.systemPrompt ?? "",
      builtinToolNames: pi?.builtinToolNames ?? [],
      override: overrides.find(o => o.type === t.name),
    };
  });
}
```

**重要修正**：测试是同步调用 `getSubagentInfo([])`，但实现是 async。**测试签名要改异步**——见 Step 1 的测试代码：实际是同步调用 `getSubagentInfo([])`，要改成 `await getSubagentInfo([])`。

更新 Step 1 的测试代码（每个 `const infos = getSubagentInfo(...)` 改为 `const infos = await getSubagentInfo(...)`，test 函数加 `async`）：

```ts
test("getSubagentInfo 返回 3 个内置 subagent", async () => {
  const infos = await getSubagentInfo([]);
  // ... 其余同
});
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/subagent-info.test.ts`
Expected: PASS（5 个全过）

- [ ] **Step 5: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel typecheck`
Expected: exit 0

- [ ] **Step 6: commit**

```bash
git add packages/kernel/src/subagent-info.ts packages/kernel/tests/subagent-info.test.ts
git commit -m "feat(kernel): 新建 subagent-info（合并 SUBAGENT_TYPES + pi-subagents 真实配置 + override）"
```

---

### Task 2.3: index.ts 启动集成 ensureSubagentOverrides

**Files:**
- Modify: `packages/kernel/src/index.ts`（在 ensurePromptsConfig 调用之后插入）

**Interfaces:**
- Consumes: `ensureSubagentOverrides` from subagent-store；`SUBAGENT_OVERRIDES_FILE` from shared
- Produces: 启动时 `~/.hiagent/subagent-overrides.json` 存在

- [ ] **Step 1: 修改 index.ts**

修改 `packages/kernel/src/index.ts`，**在 `ensurePromptsConfig(PROMPTS_FILE)` 之后**插入：

```ts
// 启动时确保 subagent-overrides.json 存在（幂等初始化空配置）
await ensureSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
```

顶部 import 区补：

```ts
import { ensureSubagentOverrides } from "./subagent-store";
```

shared import 行（已有 `PROMPTS_FILE`）补 `SUBAGENT_OVERRIDES_FILE`：

```ts
import { WS_PORT, HIAGENT_DIR, BUILTIN_SKILLS_DIR, SYSTEM_PROJECT_CWD, PROMPTS_FILE, SUBAGENT_OVERRIDES_FILE } from "@hiagent/shared";
```

- [ ] **Step 2: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel typecheck`
Expected: exit 0

- [ ] **Step 3: 手动验证 seed（可选，跑不动就跳过）**

```bash
PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel dev &
sleep 3
ls -la ~/.hiagent/subagent-overrides.json
kill %1 2>/dev/null
```
Expected: 文件存在，内容 `{"overrides":[]}`。**若 kernel 启动需要 SDK 而跑不起来，跳过此步**。

- [ ] **Step 4: commit**

```bash
git add packages/kernel/src/index.ts
git commit -m "feat(kernel): 启动时 ensureSubagentOverrides 幂等初始化 subagent-overrides.json"
```

---

## Phase 3: kernel WS handler + spawn 合并 override

依赖：Phase 1 + Phase 2 完成

### Task 3.1: ws-server 加 subagent:list / subagent:save-override handler

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`（在 handle 方法里加 case）
- Modify: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: `getSubagentInfo` / `loadSubagentOverrides` / `saveSubagentOverride` from subagent-info / subagent-store；`SUBAGENT_OVERRIDES_FILE`
- Produces: `subagent:list` 返回 `SubagentInfo[]`；`subagent:save-override` 持久化并广播 `subagent:list`

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/ws-server.test.ts` 末尾追加（用 `withServer` 辅助）：

```ts
test("subagent:list 返回 3 个内置 subagent 含真实 systemPrompt + builtinToolNames", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "subagent:list" });
    const e = await recv() as any;
    expect(e.type).toBe("subagent:list");
    expect(e.subagents).toHaveLength(3);
    const explore = e.subagents.find((s: any) => s.name === "Explore");
    expect(explore.systemPrompt.length).toBeGreaterThan(100);
    expect(explore.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
    const plan = e.subagents.find((s: any) => s.name === "Plan");
    expect(plan.systemPrompt).toContain("architect");
  });
});

test("subagent:save-override 持久化并广播 subagent:list", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({
      type: "subagent:save-override",
      override: { type: "Plan", model: "glm-4.6", thinking: "max" },
    });
    // 广播 subagent:list（全量）
    const e = await recv() as any;
    expect(e.type).toBe("subagent:list");
    const plan = e.subagents.find((s: any) => s.name === "Plan");
    expect(plan.override).toEqual({ type: "Plan", model: "glm-4.6", thinking: "max" });
  });
});
```

**注意**：`withServer` 用真实文件 `SUBAGENT_OVERRIDES_FILE` 写入——测试后必须清理。参考 system-prompt.test.ts 的 try/finally 模式：在测试开头 backup 原文件，测试末尾还原。

简化方案：测试用单独的临时 SUBAGENT_OVERRIDES_FILE。但 WSServer 是从常量读文件路径，无法注入。

**实际方案**：测试用真实 `SUBAGENT_OVERRIDES_FILE` 但**每次保存前先备份、测试后还原**。修改测试：

```ts
test("subagent:save-override 持久化并广播 subagent:list", async () => {
  const { agentManager } = makeMockAgentManager();
  // 备份现有 subagent-overrides.json
  const f = SUBAGENT_OVERRIDES_FILE;
  let backup: string | null = null;
  try { backup = readFileSync(f, "utf8"); } catch {}
  try {
    await withServer(agentManager, async (send, recv) => {
      send({
        type: "subagent:save-override",
        override: { type: "Plan", model: "glm-4.6", thinking: "max" },
      });
      const e = await recv() as any;
      expect(e.type).toBe("subagent:list");
      const plan = e.subagents.find((s: any) => s.name === "Plan");
      expect(plan.override).toEqual({ type: "Plan", model: "glm-4.6", thinking: "max" });
    });
  } finally {
    // 还原
    if (backup !== null) writeFileSync(f, backup);
    else try { rmSync(f, { force: true }); } catch {}
  }
});
```

需要顶部 import：
```ts
import { SYSTEM_PROJECT_ID, SUBAGENT_OVERRIDES_FILE } from "@hiagent/shared";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/ws-server.test.ts -t "subagent:"`
Expected: FAIL

- [ ] **Step 3: 在 ws-server 加 handler**

修改 `packages/kernel/src/ws-server.ts` 的 `handle` 方法，找现有 case 末尾（比如 `projects:list` 或 `agent:list` 附近）加：

```ts
case "subagent:list": {
  const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
  const subagents = await getSubagentInfo(overrides);
  reply({ type: "subagent:list", subagents });
  break;
}
case "subagent:save-override": {
  await saveSubagentOverride(SUBAGENT_OVERRIDES_FILE, event.override);
  const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
  const subagents = await getSubagentInfo(overrides);
  this.broadcast({ type: "subagent:list", subagents });
  break;
}
```

顶部 import：
```ts
import { loadSubagentOverrides, saveSubagentOverride } from "./subagent-store";
import { getSubagentInfo } from "./subagent-info";
import { ..., SUBAGENT_OVERRIDES_FILE } from "@hiagent/shared";
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/ws-server.test.ts -t "subagent:"`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel typecheck`
Expected: exit 0

- [ ] **Step 6: commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts
git commit -m "feat(kernel): ws-server 加 subagent:list / subagent:save-override handler"
```

---

### Task 3.2: spawnViaSubagentsService 合并 override 到 SpawnOptions

**Files:**
- Modify: `packages/kernel/src/delegate-tool.ts`（`spawnViaSubagentsService`）
- Modify: `packages/kernel/tests/delegate-tool.test.ts`

**Interfaces:**
- Consumes: `getSubagentOverride` from subagent-store；`SUBAGENT_OVERRIDES_FILE`
- Produces: `spawnViaSubagentsService` 调 `svc.spawn` 时把用户设的 model/thinking 透传到 `options`

**背景**：pi-subagents 的 `SpawnOptions`（service.ts:55-63）支持 `model?: string` 和 `thinkingLevel?: string`。HiAgent 当前 spawn 时没传，全用默认。本 Task 让用户配置的 override 生效。

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/delegate-tool.test.ts` 末尾追加（用真实 spawnViaSubagentsService + publishSubagentsService）：

```ts
test("spawnViaSubagentsService 合并 override model/thinkingLevel 到 svc.spawn options", async () => {
  // 用临时 overrides 文件，避免污染开发机
  const tmpFile = `/tmp/hiagent-test-overrides-${Date.now()}.json`;
  // 备份原模块路径常量：spawnViaSubagentsService 内部用 SUBAGENT_OVERRIDES_FILE，无法注入
  // 改方案：测试直接调 spawnViaSubagentsService 并传可选 overridesFilePath 参数
  // （实现要把 SUBAGENT_OVERRIDES_FILE 从硬编码改为函数参数，默认 SUBAGENT_OVERRIDES_FILE）

  const fakeService = {
    spawn: mock((type: string, prompt: string, options?: any) => {
      // 检查 options 含 override 的 model / thinkingLevel
      expect(options?.model).toBe("glm-4.6");
      expect(options?.thinkingLevel).toBe("xhigh");  // max → xhigh（SDK 映射）
      return "agent-fake-id";
    }),
    getRecord: () => ({ id: "agent-fake-id", type: "Plan", description: "", status: "completed", result: "plan done", toolUses: 1, startedAt: 0, compactionCount: 0 }),
    abort: mock(() => true),
  };
  publishSubagentsService(fakeService as any);

  // 写入 override：Plan → model=glm-4.6, thinking=max
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(tmpFile, JSON.stringify({ overrides: [{ type: "Plan", model: "glm-4.6", thinking: "max" }] }));

  const result = await spawnViaSubagentsService("Plan", "design api", {
    overridesFilePath: tmpFile,  // 新参数：测试注入临时文件
  });
  expect(result.text).toBe("plan done");
  expect(result.isError).toBe(false);
  expect(fakeService.spawn).toHaveBeenCalledTimes(1);

  // 清理
  await rm(tmpFile, { force: true });
  unpublishSubagentsService();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/delegate-tool.test.ts -t "合并 override"`
Expected: FAIL，报 `overridesFilePath` 参数不存在

- [ ] **Step 3: 修改 spawnViaSubagentsService 签名 + 合并 override**

修改 `packages/kernel/src/delegate-tool.ts` 第 154-196 行 `spawnViaSubagentsService`：

改前签名：
```ts
export async function spawnViaSubagentsService(
  agent: string,
  task: string,
  opts?: { intervalMs?: number; activeTimeoutMs?: number; hardDeadlineMs?: number },
): Promise<DelegateSpawnResult> {
```

改后：
```ts
import { getSubagentOverride } from "./subagent-store";
import { SUBAGENT_OVERRIDES_FILE } from "@hiagent/shared";
import type { ThinkingLevel } from "@hiagent/shared";

export interface SpawnOpts {
  intervalMs?: number;
  activeTimeoutMs?: number;
  hardDeadlineMs?: number;
  /** 测试注入临时 overrides 文件路径；生产路径默认 SUBAGENT_OVERRIDES_FILE */
  overridesFilePath?: string;
}

// thinking → pi-subagents thinkingLevel 映射（与 agent-manager prompt 方法一致）：
// "disabled" → "off"；"max" → "xhigh"；"medium"/"high" 透传
function mapThinkingToLevel(thinking: ThinkingLevel): string {
  return thinking === "disabled" ? "off"
    : thinking === "max" ? "xhigh"
    : thinking;
}

export async function spawnViaSubagentsService(
  agent: string,
  task: string,
  opts?: SpawnOpts,
): Promise<DelegateSpawnResult> {
  const mod = await import("@gotgenes/pi-subagents");
  let svc = mod.getSubagentsService();
  // 兜底：Pi SDK 未加载扩展入口 → 手动导入并调用 default export（保持现有逻辑不变）
  if (!svc) {
    console.log("[delegate] getSubagentsService 未就绪，尝试手动加载扩展入口...");
    try {
      const req = createRequire(import.meta.url);
      const pkgRoot = dirname(req.resolve("@gotgenes/pi-subagents/package.json"));
      const indexTs = join(pkgRoot, "src", "index.ts");
      console.log("[delegate] 扩展入口路径:", indexTs);
      const pkgReq = createRequire(join(pkgRoot, "package.json"));
      const modExt = await pkgReq(indexTs);
      if (typeof modExt.default === "function") {
        console.log("[delegate] 扩展入口 default export 找到，调用中...");
        try {
          await modExt.default(createExtensionApiStub());
          svc = mod.getSubagentsService();
          console.log("[delegate] 手动加载后 getSubagentsService() =>", svc ? "已就绪" : "仍 undefined");
        } catch (e) {
          console.log("[delegate] 扩展入口 default export 抛错:", e);
        }
      } else {
        console.log("[delegate] 扩展入口无 default export, typeof:", typeof modExt.default);
      }
    } catch (e) {
      console.log("[delegate] 手动加载扩展入口失败:", e);
    }
  }
  if (!svc) return { text: "子智能体服务未就绪", isError: true };

  // 合并 subagent override（model / thinkingLevel）到 svc.spawn options
  const normalizedAgent = normalizeSubagentType(agent);  // 中文别名归一化
  const overridesFile = opts?.overridesFilePath ?? SUBAGENT_OVERRIDES_FILE;
  const override = await getSubagentOverride(overridesFile, normalizedAgent).catch(() => undefined);
  const spawnOptions: any = {};
  if (override?.model) spawnOptions.model = override.model;
  if (override?.thinking) spawnOptions.thinkingLevel = mapThinkingToLevel(override.thinking);

  let id: string;
  try {
    id = svc.spawn(
      normalizedAgent,
      task,
      Object.keys(spawnOptions).length > 0 ? spawnOptions : undefined,
    );
  } catch (err) {
    return { text: `子智能体调起失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  return waitSubagentResult(svc, id, opts);
}
```

注意顶部 import 已有 `normalizeSubagentType`（Task "中文别名" 已加），无需重复。

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/delegate-tool.test.ts -t "合并 override"`
Expected: PASS

- [ ] **Step 5: 跑 delegate-tool 全量测试确保不回归**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/kernel/tests/delegate-tool.test.ts`
Expected: PASS（除 baseline 预存的 testConnection / agent:abort，本文件全部通过）

- [ ] **Step 6: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/kernel typecheck`
Expected: exit 0

- [ ] **Step 7: commit**

```bash
git add packages/kernel/src/delegate-tool.ts packages/kernel/tests/delegate-tool.test.ts
git commit -m "feat(kernel): spawnViaSubagentsService 合并 subagent override model/thinking 到 SpawnOptions"
```

---

## Phase 4: 前端 store + AgentConfig 改造

依赖：Phase 3 完成（WS 事件就绪）

### Task 4.1: 新建 useSubagentsStore + App 启动加载

**Files:**
- Create: `packages/frontend/src/store/subagents.ts`
- Modify: `packages/frontend/src/App.tsx`
- Create: `packages/frontend/tests/store-subagents.test.ts`

**Interfaces:**
- Consumes: `send` / `onMessage` from ws-instance；`SubagentInfo` / `SubagentOverride` types
- Produces: `useSubagentsStore` with `subagents: SubagentInfo[]` + `load()` + `saveOverride(o)`

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/store-subagents.test.ts`：

```ts
import { test, expect, beforeEach, mock } from "bun:test";

const handlers = new Set<(e: any) => void>();
const sendMock = mock();
mock.module("../src/ws-instance", () => ({
  send: sendMock,
  onMessage: (h: (e: any) => void) => { handlers.add(h); return () => handlers.delete(h); },
}));

import { useSubagentsStore } from "../src/store/subagents";

beforeEach(() => {
  handlers.clear();
  sendMock.mockClear();
  useSubagentsStore.setState({ subagents: [] });
});

const emit = (e: any) => handlers.forEach(h => h(e));

test("load 发送 subagent:list 事件", () => {
  useSubagentsStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "subagent:list" });
});

test("收到 subagent:list 事件后填充 subagents", () => {
  const fakeList = [
    { name: "Plan", displayName: "规划子智能体", description: "", emoji: "📐",
      gradient: ["#7c3aed", "#a78bfa"], readOnly: true,
      systemPrompt: "long...", builtinToolNames: ["read"] },
  ];
  emit({ type: "subagent:list", subagents: fakeList });
  expect(useSubagentsStore.getState().subagents).toEqual(fakeList);
});

test("saveOverride 发送 subagent:save-override 事件", () => {
  useSubagentsStore.getState().saveOverride({ type: "Plan", model: "glm-4.6" });
  expect(sendMock).toHaveBeenCalledWith({
    type: "subagent:save-override",
    override: { type: "Plan", model: "glm-4.6" },
  });
});

test("getByName 返回单个 subagent info", () => {
  useSubagentsStore.setState({
    subagents: [{ name: "Plan", displayName: "规划子智能体", description: "",
      emoji: "📐", gradient: ["#7c3aed", "#a78bfa"], readOnly: true,
      systemPrompt: "x", builtinToolNames: [] }],
  });
  const info = useSubagentsStore.getState().getByName("Plan");
  expect(info?.displayName).toBe("规划子智能体");
  expect(useSubagentsStore.getState().getByName("non-exist")).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/frontend/tests/store-subagents.test.ts`
Expected: FAIL，报 `Cannot find module '../src/store/subagents'`

- [ ] **Step 3: 实现 store/subagents.ts**

新建 `packages/frontend/src/store/subagents.ts`：

```ts
import { create } from "zustand";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";
import { send, onMessage } from "../ws-instance";

interface State {
  subagents: SubagentInfo[];
  load: () => void;
  saveOverride: (override: SubagentOverride) => void;
  getByName: (name: string) => SubagentInfo | undefined;
}

/**
 * 内置 subagent 信息 store。
 * - load：发送 subagent:list，kernel 回包后填充 subagents
 * - saveOverride：发送 subagent:save-override，kernel 持久化后广播 subagent:list 自动刷新
 *
 * App.tsx 启动时调 load；WS 事件已在 App 的 onMessage 全局 dispatch 里转发到这里。
 */
export const useSubagentsStore = create<State>((set, get) => ({
  subagents: [],
  load: () => {
    send({ type: "subagent:list" });
  },
  saveOverride: (override) => {
    send({ type: "subagent:save-override", override });
  },
  getByName: (name) => get().subagents.find(s => s.name === name),
}));

// 全局监听 subagent:list 广播，自动更新 store（无需在 App 里 dispatch）
// 注意：mock.module 测试时 onMessage 在 import 时绑定；生产 import 时也立即绑定
onMessage(e => {
  if (e.type === "subagent:list") {
    useSubagentsStore.setState({ subagents: (e as any).subagents });
  }
});
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/frontend/tests/store-subagents.test.ts`
Expected: PASS（4 个全过）

- [ ] **Step 5: App.tsx 启动加载**

修改 `packages/frontend/src/App.tsx`，在现有 `useProjectsStore.getState().load()` 附近（约第 41-47 行 useEffect）加：

```ts
useSubagentsStore.getState().load();
```

顶部 import：
```ts
import { useSubagentsStore } from "./store/subagents";
```

**注意**：App.tsx 的 onMessage 全局 dispatch **不需要加 subagent:list 分支**——store/subagents.ts 顶部已经自己 `onMessage` 监听了。

- [ ] **Step 6: typecheck**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/frontend typecheck`
Expected: exit 0

- [ ] **Step 7: commit**

```bash
git add packages/frontend/src/store/subagents.ts packages/frontend/tests/store-subagents.test.ts packages/frontend/src/App.tsx
git commit -m "feat(frontend): 新建 useSubagentsStore + App 启动加载"
```

---

### Task 4.2: AgentConfig 内置分支改为展示真实 systemPrompt + builtinToolNames，model/thinking 可编辑

**Files:**
- Modify: `packages/frontend/src/components/AgentConfig.tsx:34-57`（builtinDraft 构造逻辑）
- Modify: `packages/frontend/src/components/AgentConfig.tsx:121-124`（tab 渲染的 onChange）
- Modify: `packages/frontend/src/components/AgentConfig.tsx:116-138`（footer + tab content 置灰范围）
- Modify: `packages/frontend/tests/AgentConfig.test.tsx`

**关键改动**：
1. 不再用本地构造的假 systemPromptBody，改从 `useSubagentsStore.getByName` 取真实 SubagentInfo
2. 内置分支：BasicTab 的 systemPromptBody / ToolsTab 的 tools / SkillsTab / PartnersTab 全部只读（保持现状），但 **BasicTab 的 model + thinking 改为可编辑**（去掉 `[&_select]:pointer-events-none`）
3. model/thinking 改变时调 `useSubagentsStore.saveOverride`（不走 agent:config:save）
4. footer 显示"内置 subagent，仅 model/thinking 可设置"提示

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/tests/AgentConfig.test.tsx` 的"内置 subagent"describe 末尾追加：

```ts
  test("内置 subagent 显示真实 systemPrompt（来自 useSubagentsStore）", async () => {
    const { useSubagentsStore } = await import("../src/store/subagents");
    useSubagentsStore.setState({
      subagents: [{
        name: "Explore", displayName: "探索子智能体", description: "",
        emoji: "🔍", gradient: ["#0891b2", "#06b6d4"], readOnly: true,
        systemPrompt: "# CRITICAL: READ-ONLY MODE - real prompt from pi-subagents",
        builtinToolNames: ["read", "bash", "grep", "find", "ls"],
      }],
    });
    render(<AgentConfig agentName="Explore" onClose={() => {}} />);
    // 等内置 draft 渲染
    await waitFor(() => expect(screen.getByTestId("agent-config").textContent).toContain("探索子智能体"));
    // BasicTab 切到提示词 textarea（提示词 body 在 textarea 里）
    // 实际断言 systemPromptBody 文本可见
    expect(screen.getByTestId("agent-config").textContent).toContain("CRITICAL: READ-ONLY");
  });

  test("内置 subagent 的 model 改变时调 saveOverride（不走 agent:config:save）", async () => {
    const { useSubagentsStore } = await import("../src/store/subagents");
    const saveOverride = mock();
    useSubagentsStore.setState({
      subagents: [{
        name: "Plan", displayName: "规划子智能体", description: "",
        emoji: "📐", gradient: ["#7c3aed", "#a78bfa"], readOnly: true,
        systemPrompt: "x", builtinToolNames: [],
      }],
      saveOverride,
    });
    render(<AgentConfig agentName="Plan" onClose={() => {}} />);
    // 切到 BasicTab 默认就显示；model select 改值
    const modelSelect = screen.getByTestId("cfg-model-select") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "openai/gpt-4o" } });
    // 应调 saveOverride（不是 agent:config:save）
    expect(saveOverride).toHaveBeenCalledWith(expect.objectContaining({
      type: "Plan", model: "openai/gpt-4o",
    }));
    // 不应发送 agent:config:save
    const cfgSaveCall = sentEvents.find(e => e.type === "agent:config:save");
    expect(cfgSaveCall).toBeUndefined();
  });

  test("内置 subagent 的 model 选择控件不置灰（可点）", () => {
    render(<AgentConfig agentName="Plan" onClose={() => {}} />);
    const modelSelect = screen.getByTestId("cfg-model-select");
    // model select 不应有 pointer-events-none
    expect(modelSelect.className).not.toContain("pointer-events-none");
    // 但 footer 提示仍是"内置 subagent"
    expect(screen.getByTestId("cfg-builtin-notice")).toBeTruthy();
  });

  test("内置 subagent 的 thinking 改变时调 saveOverride", async () => {
    const { useSubagentsStore } = await import("../src/store/subagents");
    const saveOverride = mock();
    useSubagentsStore.setState({
      subagents: [{
        name: "Plan", displayName: "规划子智能体", description: "",
        emoji: "📐", gradient: ["#7c3aed", "#a78bfa"], readOnly: true,
        systemPrompt: "x", builtinToolNames: [],
      }],
      saveOverride,
    });
    render(<AgentConfig agentName="Plan" onClose={() => {}} />);
    const thinkingSelect = screen.getByTestId("cfg-thinking-select") as HTMLSelectElement;
    fireEvent.change(thinkingSelect, { target: { value: "max" } });
    expect(saveOverride).toHaveBeenCalledWith(expect.objectContaining({
      type: "Plan", thinking: "max",
    }));
  });
```

顶部 import（如未有）：`import { waitFor } from "@testing-library/react";`

- [ ] **Step 2: 跑测试验证失败**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/frontend/tests/AgentConfig.test.tsx -t "内置 subagent"`
Expected: FAIL（旧实现 model select 不可点 / systemPromptBody 是占位假文案）

- [ ] **Step 3: 改 AgentConfig 内置分支**

修改 `packages/frontend/src/components/AgentConfig.tsx`，顶部加 import：

```ts
import { useSubagentsStore } from "../store/subagents";
import type { SubagentInfo, SubagentOverride, ThinkingLevel } from "@hiagent/shared";
```

替换 `builtinDraft` 构造（35-57 行）：

```ts
const isBuiltin = isSubagentType(agentName);
const builtinInfo = useSubagentsStore(s => s.subagents.find(i => i.name === agentName));
const builtinDraft: AgentConfig | null = useMemo(() => {
  if (!builtinInfo) return null;
  return {
    displayName: builtinInfo.displayName,
    avatar: builtinInfo.emoji,
    avatarColor: `${builtinInfo.gradient[0]}-${builtinInfo.gradient[1]}`,
    description: builtinInfo.description,
    // model/thinking 来自用户 override（无 override 时 null = 跟随主智能体）
    model: builtinInfo.override?.model ?? null,
    thinking: builtinInfo.override?.thinking ?? null,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    // 工具：内置 subagent 的真实 builtinToolNames（来自 pi-subagents），只读展示
    tools: builtinInfo.builtinToolNames ?? [],
    skills: [],
    mcpServers: [],
    partners: { askTo: [], askFrom: [] },
    triggerKeywords: [],
    // 真实 systemPrompt（来自 pi-subagents），只读展示
    systemPromptBody: builtinInfo.systemPrompt,
  };
}, [builtinInfo]);
```

替换 tab content 的 className（116 行）——只对非 select / 非 thinking 控件置灰：

```ts
// 内置 subagent：除 model/thinking 选择器外的字段只读
const builtinReadOnlyClass = isBuiltin
  ? "opacity-60 [&_input:not([data-testid=cfg-model-select]):not([data-testid=cfg-thinking-select])]:pointer-events-none [&_button]:pointer-events-none [&_textarea]:pointer-events-none [&_[role=checkbox]]:pointer-events-none"
  : "";
```

实际更稳的做法：用 `[&_textarea]:pointer-events-none` 让 systemPromptBody textarea 只读，model/thinking 用 `select` 标签不在禁用列表里（textarea/button 都禁，但 select 没禁）。

修改 className：

```ts
className={`px-5 py-4 h-[380px] overflow-y-auto ${isBuiltin ? "opacity-60 [&_input[type=checkbox]]:pointer-events-none [&_button]:pointer-events-none [&_textarea]:pointer-events-none" : ""}`}
```

- 注意：`select` 标签没有被禁用 → model/thinking 可改。`input[type=checkbox]` 禁用（工具/技能勾选只读）。`textarea` 禁用（systemPromptBody 只读）。`button` 禁用（关键词 chip 的 ✕ 按钮、关系网勾选禁用）。
- 但 model/thinking 是 `<select>`，不会匹配上述 selector → **可点**。

BasicTab onChange 改为内置时走 saveOverride：

```ts
// 在 BasicTab 内（或 AgentConfig 主组件传入 onChange 时拦截）
// 实际做法：在 AgentConfig 主组件 onChange 包装：
const handleChange = (next: AgentConfig) => {
  if (isBuiltin) {
    // 内置 subagent：只关心 model / thinking 变化，其它字段被 pointer-events-none 锁死
    const override: SubagentOverride = {
      type: agentName,
      model: next.model ?? null,
      thinking: next.thinking ?? null,
    };
    useSubagentsStore.getState().saveOverride(override);
    // 本地 draft 也更新（让 select 立即反映）
    setDraft(next);
    return;
  }
  setDraft(next);
};
```

替换 tab 渲染的 onChange 为 `handleChange`：

```ts
{draft && tab === "basic" && <BasicTab draft={draft} onChange={handleChange} />}
{draft && tab === "tools" && <ToolsTab draft={draft} onChange={handleChange} tools={tools} />}
{draft && tab === "skills" && <SkillsTab draft={draft} onChange={handleChange} />}
{draft && tab === "partners" && <PartnersTab draft={draft} onChange={handleChange} selfName={agentName} />}
```

footer 提示更新：

```ts
{isBuiltin && (
  <span data-testid="cfg-builtin-notice" className="text-[11px] text-tertiary self-center mr-auto">
    内置 subagent，仅 model / 思考强度可设置
  </span>
)}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/frontend/tests/AgentConfig.test.tsx -t "内置 subagent" --timeout 10000`
Expected: PASS（4 个新测试 + 既有 4 个测试）

- [ ] **Step 5: 跑 AgentConfig 全量确保不回归**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/frontend/tests/AgentConfig.test.tsx --timeout 10000`
Expected: PASS（旧测试 + 新测试全过）

- [ ] **Step 6: typecheck + vite build**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run --filter @hiagent/frontend typecheck && cd packages/frontend && bun run build`
Expected: typecheck exit 0；build 成功

- [ ] **Step 7: commit**

```bash
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/tests/AgentConfig.test.tsx
git commit -m "feat(frontend): AgentConfig 内置分支展示真实 systemPrompt/builtinToolNames，model/thinking 可编辑"
```

---

## Phase 5: 全量回归 + CHANGELOG

依赖：所有 Phase 完成

### Task 5.1: 全量回归 + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 跑全量测试**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test packages/shared/tests/ packages/kernel/tests/ packages/frontend/tests/ --timeout 30000`
Expected: 所有测试 PASS，**3 个 baseline 预存 fail**（testConnection x2 + agent:abort x1）除外，**0 新增 fail**

- [ ] **Step 2: typecheck 全量**

Run: `PATH="$HOME/.bun/bin:$PATH" bun run typecheck`
Expected: 4 个包全部 exit 0

- [ ] **Step 3: vite build**

Run: `cd packages/frontend && PATH="$HOME/.bun/bin:$PATH" bun run build`
Expected: build 成功

- [ ] **Step 4: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部 `## 2026-07-21` 下新增一段（放在"内置 subagent 类型"条目之后）：

```markdown
### 增强
- **内置 subagent 三项增强**：① 新增 Plan（第 3 个内置类型，read-only 软件架构师）；② AgentConfig 内置分支改为从 pi-subagents 读取真实 systemPrompt 与 builtinToolNames 展示（替换原占位假文案）；③ 用户可为内置 subagent 设置 model/思考强度，覆盖存于 `~/.hiagent/subagent-overrides.json`，delegate 调起时合并到 `svc.spawn` options。新增 WS 事件 `subagent:list` / `subagent:save-override`，新建 `packages/kernel/src/subagent-store.ts`（override 持久化）+ `packages/kernel/src/subagent-info.ts`（合并 pi-subagents 真实配置）。影响范围：shared/constants.ts（SUBAGENT_TYPES 加 Plan）、shared/types.ts（新类型 + WS 事件）、kernel/subagent-store.ts（新）、kernel/subagent-info.ts（新）、kernel/ws-server.ts、kernel/delegate-tool.ts、kernel/index.ts、frontend/store/subagents.ts（新）、frontend/AgentConfig.tsx、frontend/App.tsx。
```

- [ ] **Step 5: commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 内置 subagent 增强（Plan + 真实提示词 + model/thinking 可设置）"
```

- [ ] **Step 6: 最终验证**

```bash
PATH="$HOME/.bun/bin:$PATH" bun test --timeout 30000 2>&1 | tail -5
PATH="$HOME/.bun/bin:$PATH" bun run typecheck 2>&1 | tail -5
```
Expected: 测试除 baseline 预存 3 fail 外全过；typecheck 4 包 exit 0

---

## Self-Review 检查

**1. Spec 覆盖：**

| 需求点 | 对应 Task |
|---|---|
| 新增 Plan 智能体 | Task 1.1（SUBAGENT_TYPES 加 Plan）|
| 内置智能体的提示词、工具支持正常查看（真实内容） | Task 2.2（subagent-info 读 pi-subagents）+ Task 3.1（WS 暴露）+ Task 4.2（AgentConfig 用真实 SubagentInfo）|
| 内置智能体的思考强度、模型支持设置 | Task 1.2（SubagentOverride 类型）+ Task 2.1（subagent-store）+ Task 3.1（save-override handler）+ Task 3.2（spawn 合并 override）+ Task 4.2（AgentConfig model/thinking 可编辑 + 调 saveOverride）|

**2. 占位扫描**：无 TBD/TODO；每个步骤都有完整代码 ✓

**3. 类型一致性：**
- `SubagentOverride` 签名 `{ type; model?; thinking? }` 全程一致 ✓
- `SubagentInfo` 签名（`name/displayName/description/emoji/gradient/readOnly/systemPrompt/builtinToolNames/override?`）shared 定义 → kernel 产出 → frontend store → AgentConfig 消费，一致 ✓
- `getSubagentInfo(overrides): Promise<SubagentInfo[]>`（async，Task 2.2 已说明测试改 async）✓
- `spawnViaSubagentsService` 新参数 `overridesFilePath` 测试用，生产默认 `SUBAGENT_OVERRIDES_FILE` ✓

**4. 风险点：**
- Task 2.2 `getSubagentInfo` 是 async（dynamic import pi-subagents），WS handler 里 await 即可
- Task 3.1 测试用真实 `SUBAGENT_OVERRIDES_FILE`，必须 try/finally 还原
- Task 3.2 thinking → thinkingLevel 映射（max → xhigh）要与 agent-manager prompt 方法一致
- Task 4.2 select 不被 pointer-events-none 选择器禁用 → 可点；其它字段（textarea/checkbox/button）禁用

---

## 执行说明

Plan 完成并保存到 `docs/superpowers/plans/2026-07-21-builtin-subagent-enhancement.md`。两个执行选项：

1. **Subagent-Driven（推荐）** - 每个 Task 分发独立 subagent，Task 间做 review
2. **Inline Execution** - 当前会话直接按 Task 顺序执行，Phase 间检查点
