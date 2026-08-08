# 初始化向导（Onboarding Wizard）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首次启动（无模型时）自动弹出两步向导，引导用户配置模型、创建/选择带人名的默认智能体；智能体宫格新建流程同步升级为同一面板。

**Architecture:** 预设数据管线：`docs/references/agency-agents-zh/`（268 个 md）→ 生成脚本 → `packages/kernel/src/data/agency-presets.json` → kernel preset-store + WS 事件 → REST API → 前端 `AgentCreatePicker`（向导第 2 步 + 宫格新建共用）。默认智能体存 localStorage（ui-prefs persist），`pickDefaultAgent` 增加一级优先级。

**Tech Stack:** Bun workspace、kernel 无框架 HTTP 路由 + WS 事件总线（callApi/reply）、React 19 + zustand 5 + Tailwind 3、bun:test + happy-dom（组件测试）、Playwright（E2E）。

**设计文档:** `docs/superpowers/specs/2026-08-07-onboarding-wizard-design.md`

**与 spec 的偏差（有意为之，更小改动）：**
1. 预设路由不新建 `routes/agent-presets.ts`，直接加在现有 `routes/agents.ts`（两行，避免额外注册 wiring）。
2. `defaultAgent` 不新建 onboarding persist store，并入现有 `src/store/ui-prefs.ts`（zustand persist 先例）；仅新建非持久化的 `src/store/onboarding.ts` 管 `wizardOpen`。
3. 组件测试用 **bun:test + happy-dom**（项目实际配置，`packages/frontend/bunfig.toml`），不是 spec 写的 Vitest。
4. kernel 路由注册实际在 `ws-server.ts` 的 `registerRoutes()`，不在 `index.ts`（spec 描述有误，以代码为准）。

## Global Constraints

- 所有回复、代码注释、UI 文案用**中文**；标识符保持英文语义。
- **不动** 9 个内置 seed 智能体：`default-agent-seeds.ts`、`ALL_AGENT_NAMES`、`seedDefaults()` 一律不碰；存量用户 agent md 不迁移。
- 既有 API 签名不变：`POST /api/agents`、`GET/PUT /api/agents/:name/config`、`/api/providers/*` 行为不变。
- kernel 测试在 `packages/kernel/tests/*.test.ts`，用真实临时目录，不 mock fs；每个 test 末尾 `rmSync` 清理。
- 前端组件测试 mock `../../api-client` 模块（`mock.module`），断言用普通 expect（无 jest-dom）。
- 改动每步都要跑对应包的测试：`cd packages/kernel && bun test`、`cd packages/frontend && bun test`。
- 每个 Task 结束按步骤 commit；commit message 用中文描述的 conventional 格式（如 `feat(kernel): ...`）。
- E2E 产生的截图等测试产物全部删除，不留仓库。
- 完成后更新根目录 `CHANGELOG.md`（顶部追加，时间倒序）。

## 任务总览（文件地图）

| Task | 交付物 | 新增/修改 |
|------|--------|-----------|
| 1 | shared 预设类型 + 部门映射 + WS 事件类型 | 新增 `packages/shared/src/agency-presets.ts`；改 `packages/shared/src/types.ts`、`index.ts` |
| 2 | 预设生成脚本 + JSON 数据 | 新增 `scripts/generate-agency-presets.ts`、`scripts/__tests__/generate-agency-presets.test.ts`、`packages/kernel/src/data/agency-presets.json` |
| 3 | kernel preset-store | 新增 `packages/kernel/src/preset-store.ts`、`packages/kernel/tests/preset-store.test.ts` |
| 4 | WS cases + REST 路由 | 改 `packages/kernel/src/ws-server.ts`、`packages/kernel/src/routes/agents.ts` |
| 5 | curl 集成测试 | 新增 `scripts/agents-presets-api-it.sh` |
| 6 | 人名库 | 新增 `packages/frontend/src/data/name-pool.ts`、`name-pool.test.ts` |
| 7 | defaultAgent 持久化 + pickDefaultAgent 优先级 | 改 `packages/frontend/src/store/ui-prefs.ts`、`components/NewSessionPane.tsx`；新增 `components/new-session-pick.test.ts` |
| 8 | ProviderForm 抽取（纯重构） | 新增 `components/settings/ProviderForm.tsx`；改 `ProviderFormModal.tsx` |
| 9 | AgentCreatePicker | 新增 `components/onboarding/AgentCreatePicker.tsx` + 测试 |
| 10 | OnboardingWizard + App 挂载 + 设置入口 | 新增 `components/onboarding/OnboardingWizard.tsx` + 测试、`store/onboarding.ts`；改 `App.tsx`、`GeneralSection.tsx` |
| 11 | 宫格新建流程替换 | 改 `components/AgentGalleryModal.tsx` + 测试 |
| 12 | Playwright E2E | 新增 `e2e/onboarding-wizard.spec.ts`；改 `e2e/helpers.ts` |
| 13 | CHANGELOG + 全量回归 | 改 `CHANGELOG.md` |

依赖序：1→2→3→4→5；6、7 独立；8 独立；9 依赖 4、6；10 依赖 8、9；11 依赖 9；12 依赖全部；13 最后。

---

### Task 1: shared 预设类型 + 部门映射 + WS 事件类型

**Files:**
- Create: `packages/shared/src/agency-presets.ts`
- Modify: `packages/shared/src/types.ts`（`AgentCreateEvent` 附近 :432，`WSClientEvent` union :572-611，`WSServerEvent` union 中 `agent:created` 附近 :773）
- Modify: `packages/shared/src/index.ts`（导出新模块）
- Test: `packages/shared/tests/agency-presets.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `AgencyPreset { id: string; name: string; description: string; emoji: string; color: string; department: string; body: string }`
  - `AgencyPresetMeta = Omit<AgencyPreset, "body">`
  - `AGENCY_DEPARTMENTS: Record<string, string>`（19 个目录名 → 中文部门名）
  - WS 事件：`AgentPresetsRequest { type: "agent:presets" }`、`AgentCreateFromPresetEvent { type: "agent:create-from-preset"; id: string; displayName: string }`、`AgentPresetsResult { type: "agent:presets"; presets: AgencyPresetMeta[] }`

- [ ] **Step 1: 写失败测试**

`packages/shared/tests/agency-presets.test.ts`：

```ts
import { test, expect } from "bun:test";
import { AGENCY_DEPARTMENTS } from "../src/agency-presets";
import type { AgencyPreset, AgencyPresetMeta } from "../src/agency-presets";

test("AGENCY_DEPARTMENTS 覆盖 19 个部门目录", () => {
  expect(Object.keys(AGENCY_DEPARTMENTS)).toHaveLength(19);
  expect(AGENCY_DEPARTMENTS["engineering"]).toBe("工程部");
  expect(AGENCY_DEPARTMENTS["game-development"]).toBe("游戏开发部");
  expect(AGENCY_DEPARTMENTS["gis"]).toBe("GIS 部");
});

test("AgencyPresetMeta 不含 body（类型层面 Omit 的运行时佐证）", () => {
  const meta: AgencyPresetMeta = {
    id: "engineering-frontend-developer",
    name: "前端开发者",
    description: "精通 React",
    emoji: "💻",
    color: "#06B6D4",
    department: "工程部",
  };
  expect("body" in meta).toBe(false);
  // AgencyPreset 则有 body
  const full: AgencyPreset = { ...meta, body: "# 人格" };
  expect(full.body).toBe("# 人格");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && bun test tests/agency-presets.test.ts`
Expected: FAIL，`Cannot find module "../src/agency-presets"`

- [ ] **Step 3: 实现 `packages/shared/src/agency-presets.ts`**

```ts
/** agency-agents-zh 预设智能体库的类型与部门映射（生成脚本 / kernel / 前端共用） */

/** 完整预设（含正文人格提示词），仅存 kernel 侧 JSON */
export interface AgencyPreset {
  /** 文件名去 .md，如 "engineering-frontend-developer" */
  id: string;
  /** 角色中文名，如 "前端开发者" */
  name: string;
  description: string;
  emoji: string;
  color: string;
  /** 中文部门名，如 "工程部" */
  department: string;
  /** 正文人格提示词 */
  body: string;
}

/** 浏览列表用的元数据（不含 body，控制体积） */
export type AgencyPresetMeta = Omit<AgencyPreset, "body">;

/** 目录名 → 中文部门名（19 个，与 agency-agents-zh 目录一一对应） */
export const AGENCY_DEPARTMENTS: Record<string, string> = {
  academic: "学术部",
  design: "设计部",
  engineering: "工程部",
  finance: "金融部",
  "game-development": "游戏开发部",
  gis: "GIS 部",
  hr: "人力资源部",
  legal: "法务部",
  marketing: "营销部",
  "paid-media": "付费媒体部",
  product: "产品部",
  "project-management": "项目管理部",
  sales: "销售部",
  security: "安全部",
  "spatial-computing": "空间计算部",
  specialized: "专项部",
  "supply-chain": "供应链部",
  support: "支持部",
  testing: "测试部",
};
```

- [ ] **Step 4: types.ts 加 WS 事件类型**

在 `AgentCreateEvent`（types.ts:432-435）之后插入：

```ts
export interface AgentPresetsRequest {
  type: "agent:presets";
}
export interface AgentCreateFromPresetEvent {
  type: "agent:create-from-preset";
  /** 预设 id，如 "engineering-frontend-developer" */
  id: string;
  /** 保存为智能体的人名 */
  displayName: string;
}
```

在 `WSClientEvent` union 中 `| AgentCreateEvent` 后加两行：

```ts
	| AgentPresetsRequest
	| AgentCreateFromPresetEvent
```

在 types.ts 顶部 import 区加（与其他 import 并列；若 types.ts 当前无 import 则新建一行）：

```ts
import type { AgencyPresetMeta } from "./agency-presets";
```

服务端结果类型，在 `agent:created` 对应 interface（:773 附近）之后加：

```ts
export interface AgentPresetsResult {
  type: "agent:presets";
  presets: AgencyPresetMeta[];
}
```

并在 `WSServerEvent` union 中对应位置加 `| AgentPresetsResult`。

- [ ] **Step 5: index.ts 导出**

`packages/shared/src/index.ts` 加一行（照现有 export 风格）：

```ts
export * from "./agency-presets";
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `cd packages/shared && bun test && bunx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agency-presets.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/tests/agency-presets.test.ts
git commit -m "feat(shared): 新增 agency 预设智能体类型、部门映射与 WS 事件类型"
```

---

### Task 2: 预设生成脚本 + JSON 数据

**Files:**
- Create: `scripts/generate-agency-presets.ts`
- Create: `packages/kernel/src/data/agency-presets.json`（脚本产物，提交入库）
- Test: `scripts/__tests__/generate-agency-presets.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgencyPreset`、`AGENCY_DEPARTMENTS`（`@wa-pi/shared`）
- Produces:
  - `parseAgencyMd(md: string): { name: string; description: string; emoji: string; color: string; body: string } | null`（纯函数，缺 name/description 返回 null）
  - `packages/kernel/src/data/agency-presets.json`：`AgencyPreset[]`，268 条

- [ ] **Step 1: 写失败测试**

`scripts/__tests__/generate-agency-presets.test.ts`：

```ts
import { test, expect } from "bun:test";
import { parseAgencyMd } from "../generate-agency-presets";

const SAMPLE = `---
name: 前端开发者
description: 精通现代 Web 技术的前端开发专家
emoji: 💻
color: "#06B6D4"
---

# 前端开发者 Agent 人格

你是 **前端开发者**。
`;

test("parseAgencyMd 解析合法 frontmatter", () => {
  const r = parseAgencyMd(SAMPLE);
  expect(r).not.toBeNull();
  expect(r!.name).toBe("前端开发者");
  expect(r!.description).toBe("精通现代 Web 技术的前端开发专家");
  expect(r!.emoji).toBe("💻");
  expect(r!.color).toBe("#06B6D4"); // 引号被剥掉
  expect(r!.body).toContain("# 前端开发者 Agent 人格");
});

test("parseAgencyMd 缺 name 返回 null", () => {
  expect(parseAgencyMd(`---\ndescription: 没有名字\n---\n正文`)).toBeNull();
});

test("parseAgencyMd 无 frontmatter 返回 null", () => {
  expect(parseAgencyMd(`# 普通文档\n正文`)).toBeNull();
});

test("parseAgencyMd 缺 description 返回 null", () => {
  expect(parseAgencyMd(`---\nname: 某人\n---\n正文`)).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test scripts/__tests__/generate-agency-presets.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现生成脚本**

`scripts/generate-agency-presets.ts`：

```ts
/**
 * 预设智能体生成脚本：扫描 docs/references/agency-agents-zh/ 的 19 个部门目录，
 * 解析每个 md 的 YAML frontmatter（name/description/emoji/color）+ 正文，
 * 输出 packages/kernel/src/data/agency-presets.json（AgencyPreset[]，提交入库）。
 *
 * 用法：bun scripts/generate-agency-presets.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { AGENCY_DEPARTMENTS, type AgencyPreset } from "@wa-pi/shared";

const SOURCE_DIR = join(import.meta.dir, "..", "docs", "references", "agency-agents-zh");
const OUT_FILE = join(import.meta.dir, "..", "packages", "kernel", "src", "data", "agency-presets.json");

export interface ParsedAgencyMd {
  name: string;
  description: string;
  emoji: string;
  color: string;
  body: string;
}

/** 解析 agency md：frontmatter 缺 name/description 或无 frontmatter 返回 null */
export function parseAgencyMd(md: string): ParsedAgencyMd | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    // 剥掉首尾引号（color: "#06B6D4" 这种写法）
    fields[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  if (!fields.name || !fields.description) return null;
  return {
    name: fields.name,
    description: fields.description,
    emoji: fields.emoji ?? "",
    color: fields.color ?? "",
    body: m[2].trim(),
  };
}

/** 递归收集目录下所有 .md 文件 */
function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

function main() {
  const presets: AgencyPreset[] = [];
  const seenIds = new Set<string>();
  for (const [dir, department] of Object.entries(AGENCY_DEPARTMENTS)) {
    const absDir = join(SOURCE_DIR, dir);
    for (const file of walkMd(absDir)) {
      const parsed = parseAgencyMd(readFileSync(file, "utf8"));
      if (!parsed) continue; // 索引文档/示例文件自然落空
      const id = basename(file, ".md");
      if (seenIds.has(id)) {
        console.warn(`跳过重复 id: ${id}（${relative(SOURCE_DIR, file)}）`);
        continue;
      }
      seenIds.add(id);
      presets.push({ id, department, ...parsed });
    }
  }
  presets.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(join(OUT_FILE, ".."), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(presets), "utf8");
  console.log(`已生成 ${presets.length} 条预设 → ${relative(process.cwd(), OUT_FILE)}`);
  if (presets.length !== 268) {
    console.warn(`警告：预期 268 条，实际 ${presets.length} 条（agency-agents-zh 可能已更新）`);
  }
}

// 被测试 import 时不执行 main
if (import.meta.main) main();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test scripts/__tests__/generate-agency-presets.test.ts`
Expected: 4 个 PASS

- [ ] **Step 5: 运行脚本生成 JSON 并验证**

Run: `bun scripts/generate-agency-presets.ts`
Expected: 输出 `已生成 268 条预设 → packages/kernel/src/data/agency-presets.json`，无重复 id 警告

再验证产物结构：

Run: `bun -e "const d=require('./packages/kernel/src/data/agency-presets.json'); console.log(d.length, d[0].id, Object.keys(d[0]).join(','))"`
Expected: `268 <某个id> id,name,description,emoji,color,department,body`

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-agency-presets.ts scripts/__tests__/generate-agency-presets.test.ts packages/kernel/src/data/agency-presets.json
git commit -m "feat(kernel): 新增 agency 预设生成脚本与 268 条预设数据 JSON"
```

---

### Task 3: kernel preset-store

**Files:**
- Create: `packages/kernel/src/preset-store.ts`
- Test: `packages/kernel/tests/preset-store.test.ts`

**Interfaces:**
- Consumes: Task 1 类型；Task 2 的 `src/data/agency-presets.json`；`config-store.ts` 的 `ConfigStore.getAgent()/saveAgent()`（:29/:38）；`agent-md.ts` 的 `makeDefaultAgentConfig()`（:201）
- Produces（Task 4 依赖）：
  - `listPresets(): AgencyPresetMeta[]`
  - `getPreset(id: string): AgencyPreset | undefined`
  - `buildAgentConfigFromPreset(preset: AgencyPreset, displayName: string): AgentConfig`
  - `createAgentFromPreset(configStore: ConfigStore, id: string, displayName: string): Promise<CreateFromPresetResult>`
  - `CreateFromPresetResult = { ok: true; agent: AgentConfig } | { ok: false; status: number; error: string }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/preset-store.test.ts`：

```ts
import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import {
  listPresets,
  getPreset,
  buildAgentConfigFromPreset,
  createAgentFromPreset,
} from "../src/preset-store";

function tempAgentsDir() {
  const dir = join(import.meta.dir, ".tmp-presets-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listPresets 返回 268 条元数据且不含 body", () => {
  const list = listPresets();
  expect(list.length).toBeGreaterThanOrEqual(260);
  expect("body" in list[0]).toBe(false);
  expect(list[0].department.length).toBeGreaterThan(0);
});

test("getPreset 命中与未命中", () => {
  const first = listPresets()[0];
  expect(getPreset(first.id)?.name).toBe(first.name);
  expect(getPreset("not-exist-id")).toBeUndefined();
});

test("buildAgentConfigFromPreset 注入名字与预设字段", () => {
  const preset = getPreset(listPresets()[0].id)!;
  const config = buildAgentConfigFromPreset(preset, "林晓岚");
  expect(config.displayName).toBe("林晓岚");
  expect(config.description).toBe(preset.description);
  if (preset.emoji) expect(config.avatar).toBe(preset.emoji);
  if (preset.color) expect(config.avatarColor).toBe(`${preset.color}-${preset.color}`);
  expect(config.systemPromptBody!.startsWith("你的名字是「林晓岚」。")).toBe(true);
  expect(config.systemPromptBody!).toContain(preset.body.slice(0, 20));
});

test("createAgentFromPreset 成功创建并写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const presetId = listPresets()[0].id;
  const r = await createAgentFromPreset(store, presetId, "林晓岚");
  expect(r.ok).toBe(true);
  const onDisk = await store.getAgent("林晓岚" as any);
  expect(onDisk).not.toBeNull();
  expect(onDisk!.systemPromptBody).toContain("你的名字是「林晓岚」。");
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 未知 id 返回 404", async () => {
  const dir = tempAgentsDir();
  const r = await createAgentFromPreset(new ConfigStore(dir), "not-exist-id", "林晓岚");
  expect(r).toEqual({ ok: false, status: 404, error: "预设不存在: not-exist-id" });
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 重名返回 409", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  await store.createAgent("林晓岚");
  const r = await createAgentFromPreset(store, listPresets()[0].id, "林晓岚");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(409);
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 非法名字返回 400", async () => {
  const dir = tempAgentsDir();
  const r = await createAgentFromPreset(new ConfigStore(dir), listPresets()[0].id, "a/b");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(400);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/preset-store.test.ts`
Expected: FAIL，`Cannot find module "../src/preset-store"`

- [ ] **Step 3: 实现 `packages/kernel/src/preset-store.ts`**

```ts
/**
 * agency 预设智能体库：加载生成的 agency-presets.json，
 * 提供浏览元数据与「从预设创建智能体」能力。
 * JSON 缺失/损坏时降级为空列表，不影响 kernel 启动。
 */
import type { AgencyPreset, AgencyPresetMeta, AgentConfig, AgentName } from "@wa-pi/shared";
import { makeDefaultAgentConfig } from "./agent-md";
import type { ConfigStore } from "./config-store";

function loadPresets(): AgencyPreset[] {
  try {
    // bun 支持 JSON import；require 兼容两种运行方式
    const data = require("./data/agency-presets.json") as AgencyPreset[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("[preset-store] agency-presets.json 加载失败，预设功能降级为空：", err);
    return [];
  }
}

const PRESETS = loadPresets();

/** 浏览用元数据（剔除 body） */
export function listPresets(): AgencyPresetMeta[] {
  return PRESETS.map(({ body: _body, ...meta }) => meta);
}

export function getPreset(id: string): AgencyPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** 由预设 + 人名组装 AgentConfig（正文开头注入名字，让智能体知道自己叫什么） */
export function buildAgentConfigFromPreset(preset: AgencyPreset, displayName: string): AgentConfig {
  const config = makeDefaultAgentConfig(displayName);
  if (preset.emoji) config.avatar = preset.emoji;
  if (preset.color) config.avatarColor = `${preset.color}-${preset.color}`;
  config.description = preset.description;
  config.systemPromptBody = `你的名字是「${displayName}」。\n\n${preset.body}`;
  return config;
}

export type CreateFromPresetResult =
  | { ok: true; agent: AgentConfig }
  | { ok: false; status: number; error: string };

/** 从预设创建智能体：404 未知 id / 400 非法名 / 409 重名 */
export async function createAgentFromPreset(
  configStore: ConfigStore,
  id: string,
  displayName: string,
): Promise<CreateFromPresetResult> {
  const preset = getPreset(id);
  if (!preset) return { ok: false, status: 404, error: `预设不存在: ${id}` };
  const name = (displayName ?? "").trim();
  if (!name || /[/\\:*?"<>|]/.test(name)) {
    return { ok: false, status: 400, error: `非法 displayName: ${displayName}` };
  }
  if (await configStore.getAgent(name as AgentName)) {
    return { ok: false, status: 409, error: `名称已被占用: ${name}` };
  }
  const config = buildAgentConfigFromPreset(preset, name);
  const errs = await configStore.saveAgent(config);
  if (errs.length > 0) return { ok: false, status: 400, error: errs.join("; ") };
  return { ok: true, agent: config };
}
```

- [ ] **Step 4: 跑测试确认通过（含全量回归）**

Run: `cd packages/kernel && bun test`
Expected: preset-store 7 个 PASS，既有测试不红

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/preset-store.ts packages/kernel/tests/preset-store.test.ts
git commit -m "feat(kernel): 新增 preset-store，支持从 agency 预设创建带人名的智能体"
```

---

### Task 4: WS 事件 cases + REST 路由

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`（`case "agent:create"` :1267-1284 之后插入两个 case）
- Modify: `packages/kernel/src/routes/agents.ts`（加两行路由）
- Test: `packages/kernel/tests/agent-presets-routes.test.ts`（新建，直接驱动 WSServer 的 HTTP 层）

**Interfaces:**
- Consumes: Task 1 的 `AgentPresetsRequest/AgentCreateFromPresetEvent/AgentPresetsResult`；Task 3 的 `listPresets/createAgentFromPreset`；`callApi` 错误透传约定（reply `{type:"error", message, status}` → HTTP 对应状态码，ws-server.ts:430-455）
- Produces:
  - `GET /api/agents/presets` → `{ type: "agent:presets", presets: AgencyPresetMeta[] }`
  - `POST /api/agents/from-preset` body `{ id, displayName }` → 成功 `{ type: "agent:created", agent }`；失败 `{ error }` + 400/404/409

**路由冲突确认（先读代码再动手）：** 现有 agents 域 3 段 GET 只有字面量 `/api/agents/tools`，无 `:name` 通配；`/api/agents/presets`（3 段字面量）与 `GET /api/agents/:name/config`（4 段）不冲突。注册顺序随意。

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-presets-routes.test.ts`——直接起 WSServer 走真实 HTTP（参考 `ws-server.ts` 构造函数签名 `new WSServer({ configStore, projectStore, providerStore, ..., port })`，先读 `index.ts:164-177` 确认必填 opts；若 WSServer 依赖项过多难以单测，则改为只测路由层：构造 `HttpRouter` + 假 `callApi` 注册 `registerAgentRoutes`，断言路由把请求翻译成正确事件并透传响应——二选一，以实现时读到的代码为准，下列测试按后者编写）：

```ts
import { test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerAgentRoutes } from "../src/routes/agents";

/** 假 callApi：记录事件，按类型返回假响应 */
function fakeCallApi(impl: (event: any) => any) {
  const calls: any[] = [];
  const fn = async (event: any) => {
    calls.push(event);
    const r = impl(event);
    return Response.json(r.body, { status: r.status ?? 200 });
  };
  return { fn, calls };
}

test("GET /api/agents/presets 翻译为 agent:presets 事件", async () => {
  const { fn, calls } = fakeCallApi(() => ({ body: { type: "agent:presets", presets: [] } }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(new Request("http://x/api/agents/presets"));
  expect(calls[0]).toEqual({ type: "agent:presets" });
  expect(res).not.toBeNull();
  expect((await res!.json()).presets).toEqual([]);
});

test("POST /api/agents/from-preset 翻译为 agent:create-from-preset 事件", async () => {
  const { fn, calls } = fakeCallApi(() => ({ body: { type: "agent:created", agent: {} } }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(
    new Request("http://x/api/agents/from-preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "engineering-code-reviewer", displayName: "林晓岚" }),
    }),
  );
  expect(calls[0]).toEqual({
    type: "agent:create-from-preset",
    id: "engineering-code-reviewer",
    displayName: "林晓岚",
  });
  expect(res!.status).toBe(200);
});

test("POST /api/agents/from-preset 错误状态码透传（409）", async () => {
  const { fn } = fakeCallApi(() => ({ body: { error: "名称已被占用: 林晓岚" }, status: 409 }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(
    new Request("http://x/api/agents/from-preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", displayName: "林晓岚" }),
    }),
  );
  expect(res!.status).toBe(409);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-presets-routes.test.ts`
Expected: FAIL，路由不存在（`router.handle` 返回 null）

- [ ] **Step 3: 实现路由（routes/agents.ts）**

在 `registerAgentRoutes` 内既有 `GET /api/agents/tools` 附近加：

```ts
  r.add("GET", "/api/agents/presets", async () => callApi({ type: "agent:presets" }));
  r.add("POST", "/api/agents/from-preset", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "agent:create-from-preset", id: b.id, displayName: b.displayName });
  });
```

（`readJsonBody` 从 `./types` 已 import；若没有则补上。）

- [ ] **Step 4: 实现 ws-server cases**

`ws-server.ts` 顶部 import 区加：

```ts
import { listPresets, createAgentFromPreset } from "./preset-store";
```

`case "agent:create"` 块（:1267-1284）结束之后插入：

```ts
			case "agent:presets": {
				try {
					reply({ type: "agent:presets", presets: listPresets() });
				} catch (err) {
					console.error("[ws] agent:presets error:", err);
					reply({ type: "agent:presets", presets: [] });
				}
				break;
			}
			case "agent:create-from-preset": {
				const result = await createAgentFromPreset(
					this.opts.configStore,
					event.id,
					event.displayName,
				);
				if (!result.ok) {
					reply({ type: "error", message: result.error, status: result.status });
				} else {
					reply({ type: "agent:created", agent: result.agent });
					this.broadcast({
						type: "agent:list",
						agents: await this.opts.configStore.listAgents(),
					});
				}
				break;
			}
```

注意：reply 的 `{ type: "error", message, status }` 经 callApi 转成 HTTP 状态码（ws-server.ts:443-449 的既有逻辑），无需额外处理。缩进对齐文件既有风格（tab）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归 + 类型检查**

Run: `cd packages/kernel && bun test && bunx tsc --noEmit`
Expected: 全 PASS，无类型错误

- [ ] **Step 6: 手工冒烟（dev server）**

Run（另起终端）: `bun run --filter @wa-pi/kernel dev`，然后：

```bash
curl -s http://127.0.0.1:9776/api/agents/presets | head -c 300
curl -s -X POST http://127.0.0.1:9776/api/agents/from-preset -H 'content-type: application/json' -d '{"id":"engineering-code-reviewer","displayName":"测试用-冒烟"}'
curl -s -X POST http://127.0.0.1:9776/api/agents/from-preset -H 'content-type: application/json' -d '{"id":"engineering-code-reviewer","displayName":"测试用-冒烟"}'  # 预期 409
curl -s -X DELETE 'http://127.0.0.1:9776/api/agents/测试用-冒烟'
```

Expected: 列表含 presets；创建成功返回 agent；重复创建 409；清理删除成功。冒烟后停掉 dev server。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/routes/agents.ts packages/kernel/tests/agent-presets-routes.test.ts
git commit -m "feat(kernel): 新增 agents presets 浏览与 from-preset 创建 API"
```

---

### Task 5: curl 集成测试脚本

**Files:**
- Create: `scripts/agents-presets-api-it.sh`

**Interfaces:**
- Consumes: Task 4 的两个端点
- Produces: 可重复执行的集成测试脚本（需运行中的 kernel，`BASE_URL` 环境变量可覆盖，默认 `http://127.0.0.1:9776`）

- [ ] **Step 1: 写脚本**

`scripts/agents-presets-api-it.sh`（风格参照 `scripts/channels-api-it.sh`，先读它对齐 header/计数约定）：

```bash
#!/usr/bin/env bash
# agents presets API 集成测试（需运行中的 kernel）
# 用法：./scripts/agents-presets-api-it.sh   或   BASE_URL=http://127.0.0.1:9778 ./scripts/agents-presets-api-it.sh
set -u
BASE="${BASE_URL:-http://127.0.0.1:9776}"
AGENT_NAME="IT预设智能体-可删除"
PASS=0; FAIL=0

check() { # check <描述> <实际> <预期>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ $1：预期 [$3] 实际 [$2]"; fi
}

echo "== GET /api/agents/presets =="
BODY=$(curl -s "$BASE/api/agents/presets")
check "返回 presets 数组" "$(echo "$BODY" | grep -c '"presets"')" "1"
check "包含工程部预设" "$(echo "$BODY" | grep -c 'engineering-frontend-developer')" "1"
check "元数据不含 body 字段" "$(echo "$BODY" | grep -c '"body"')" "0"

echo "== POST /api/agents/from-preset 成功路径 =="
CODE=$(curl -s -o /tmp/apit-create.json -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"engineering-code-reviewer\",\"displayName\":\"$AGENT_NAME\"}")
check "创建返回 200" "$CODE" "200"
check "返回 agent.displayName" "$(grep -c "$AGENT_NAME" /tmp/apit-create.json)" "1"
check "正文注入名字" "$(curl -s "$BASE/api/agents/$AGENT_NAME/config" | grep -c "你的名字是「$AGENT_NAME」。")" "1"

echo "== 错误路径 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"engineering-code-reviewer\",\"displayName\":\"$AGENT_NAME\"}")
check "重名返回 409" "$CODE" "409"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d '{"id":"not-exist-id","displayName":"任意名字"}')
check "未知 id 返回 404" "$CODE" "404"

echo "== 清理 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/agents/$AGENT_NAME")
check "删除测试智能体" "$CODE" "200"
rm -f /tmp/apit-create.json

echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: 起 dev server 跑脚本**

Run: `bun run --filter @wa-pi/kernel dev`（后台），然后 `bash scripts/agents-presets-api-it.sh`
Expected: `结果：8 通过，0 失败`；脚本结束后停掉 dev server

- [ ] **Step 3: Commit**

```bash
git add scripts/agents-presets-api-it.sh
git commit -m "test(scripts): 新增 agents presets API curl 集成测试"
```

---

### Task 6: 人名库 name-pool

**Files:**
- Create: `packages/frontend/src/data/name-pool.ts`
- Test: `packages/frontend/src/data/name-pool.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 9 依赖）：`randomPersonName(existing?: readonly string[], rng?: () => number): string`——从内置中文人名库随机组合，避开 existing 重名；50 次重试后兜底数字后缀

- [ ] **Step 1: 写失败测试**

`packages/frontend/src/data/name-pool.test.ts`：

```ts
import { test, expect } from "bun:test";
import { randomPersonName } from "./name-pool";

test("生成 2-3 字中文人名", () => {
  const name = randomPersonName();
  expect(name).toMatch(/^[\u4e00-\u9fa5]{2,3}$/);
});

test("避开已存在的名字", () => {
  // rng 恒为 0 → 永远取第一个组合；它已被占用时应重试或兜底
  const name = randomPersonName(["林晓岚"], () => 0);
  expect(name).not.toBe("林晓岚");
});

test("全部组合耗尽时兜底数字后缀", () => {
  // existing 包含第一个组合，rng 恒 0 → 50 次重试全撞 → 兜底
  const name = randomPersonName(["林晓岚", "林晓岚2"], () => 0);
  expect(name).toBe("林晓岚3");
});

test("多次生成不立即重复（统计性）", () => {
  const names = new Set(Array.from({ length: 20 }, () => randomPersonName()));
  expect(names.size).toBeGreaterThan(10);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test src/data/name-pool.test.ts`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现 `packages/frontend/src/data/name-pool.ts`**

```ts
/** 中文人名库：为智能体随机生成人名（姓 + 名），支持查重重试 */

const SURNAMES = [
  "林", "沈", "顾", "苏", "陈", "叶", "周", "许", "陆", "江",
  "方", "韩", "秦", "唐", "宋", "程", "曾", "萧", "尹", "洛",
] as const;

const GIVEN_NAMES = [
  "晓岚", "亦凡", "子墨", "雨桐", "思远", "若曦", "浩然", "静怡",
  "天翊", "梦琪", "景行", "书瑶", "沐宸", "芷若", "云舟", "清晏",
  "明轩", "语嫣", "君泽", "南絮", "既白", "疏影", "承宇", "念安",
] as const;

/** 第一个组合（rng 恒 0 时的结果），兜底逻辑以它为基准 */
const FIRST_COMBO = `${SURNAMES[0]}${GIVEN_NAMES[0]}`; // 林晓岚

/**
 * 随机生成中文人名。
 * @param existing 已存在的名字（智能体 displayName 列表），生成结果避开它们
 * @param rng 随机源，测试可注入确定性函数
 */
export function randomPersonName(
  existing: readonly string[] = [],
  rng: () => number = Math.random,
): string {
  for (let i = 0; i < 50; i++) {
    const name =
      SURNAMES[Math.floor(rng() * SURNAMES.length)] +
      GIVEN_NAMES[Math.floor(rng() * GIVEN_NAMES.length)];
    if (!existing.includes(name)) return name;
  }
  // 兜底：第一个组合加数字后缀
  let n = 2;
  while (existing.includes(`${FIRST_COMBO}${n}`)) n++;
  return `${FIRST_COMBO}${n}`;
}
```

注意：测试 3 的断言依赖「rng 恒 0 → 组合 = 林晓岚」这一实现细节，实现时确认 `SURNAMES[0]+GIVEN_NAMES[0]` 确实是 `林晓岚`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test src/data/name-pool.test.ts`
Expected: 4 个 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/data/name-pool.ts packages/frontend/src/data/name-pool.test.ts
git commit -m "feat(frontend): 新增智能体人名库，支持随机中文人名与查重"
```

---

### Task 7: defaultAgent 持久化 + pickDefaultAgent 优先级

**Files:**
- Modify: `packages/frontend/src/store/ui-prefs.ts`（:39-67 persist store）
- Modify: `packages/frontend/src/components/NewSessionPane.tsx`（`pickDefaultAgent` :21-32 及其两个调用点 :38、:52）
- Test: `packages/frontend/src/components/new-session-pick.test.ts`（新建）

**Interfaces:**
- Consumes: `ui-prefs.ts` 现有 `useUiPrefsStore`（persist，`wa-pi-ui-prefs` key）
- Produces（Task 9、10 依赖）：
  - `useUiPrefsStore` 新增状态：`defaultAgent: string | null`（初始 `null`）+ `setDefaultAgent(name: string | null): void`
  - `pickDefaultAgent(agents, sessions, pendingAgent?, defaultAgent?): AgentName | null`（**导出**，第四参新增）

- [ ] **Step 1: 写失败测试**

`packages/frontend/src/components/new-session-pick.test.ts`：

```ts
import { test, expect } from "bun:test";
import { pickDefaultAgent } from "./NewSessionPane";

const agents = [
  { displayName: "甲" },
  { displayName: "林晓岚" },
  { displayName: "乙" },
] as any;

test("pendingAgent 最优先", () => {
  expect(pickDefaultAgent(agents, [], "丙", "林晓岚")).toBe("丙");
});

test("defaultAgent 次之（须仍在列表中）", () => {
  expect(pickDefaultAgent(agents, [], null, "林晓岚")).toBe("林晓岚");
});

test("defaultAgent 已被删除时落空到列表第一", () => {
  expect(pickDefaultAgent(agents, [], null, "已删除的人")).toBe("甲");
});

test("无 defaultAgent 时保持原逻辑：无会话取列表第一", () => {
  expect(pickDefaultAgent(agents, [], null, null)).toBe("甲");
});

test("空列表返回 null", () => {
  expect(pickDefaultAgent([], [], null, "林晓岚")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test src/components/new-session-pick.test.ts`
Expected: FAIL（`pickDefaultAgent` 未导出 / 第四参不存在）

- [ ] **Step 3: 修改 NewSessionPane.tsx**

`pickDefaultAgent`（:21-32）改为导出 + 第四参（改动最小，只插入一级优先级）：

```ts
/** 计算新建会话的默认智能体：pendingAgent → defaultAgent（向导设置）→ 最近使用者 → 列表第一项 */
export function pickDefaultAgent(
  agents: ReturnType<typeof useAgentsStore.getState>["list"],
  sessions: ReturnType<typeof useProjectsStore.getState>["sessions"],
  pendingAgent?: string | null,
  defaultAgent?: string | null,
): AgentName | null {
  if (pendingAgent) return pendingAgent as AgentName;
  if (defaultAgent && agents.some(a => a.displayName === defaultAgent)) {
    return defaultAgent as AgentName;
  }
  if (sessions.length > 0) {
    const r = topAgentsByRecency(agents, sessions, 1)[0]?.displayName;
    if (r) return r;
  }
  return agents[0]?.displayName ?? null;
}
```

组件内订阅 store（`NewSessionPane` 函数体内，与其他 useXxxStore 并列）：

```ts
const defaultAgent = useUiPrefsStore(s => s.defaultAgent);
```

两个调用点把 `defaultAgent` 传入：:38 `useState<AgentName | null>(pickDefaultAgent(agents, sessions, pendingAgent, defaultAgent))`、:52 的 `setAgentName(pickDefaultAgent(agents, sessions, pendingAgent, defaultAgent))`（:53 依赖数组加 `defaultAgent`）。import 区加 `import { useUiPrefsStore } from "../store/ui-prefs";`。

- [ ] **Step 4: ui-prefs.ts 加 defaultAgent**

`UiPrefsState` 接口加：

```ts
/** 向导设置的默认智能体（displayName），null = 未设置 */
defaultAgent: string | null;
setDefaultAgent: (name: string | null) => void;
```

persist 的初始状态加（与 `fontSize`/`exportTurns` 并列）：

```ts
defaultAgent: null,
setDefaultAgent: (name) => set({ defaultAgent: name }),
```

`onRehydrateStorage` 不动（只管 fontSize）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test`
Expected: 新测试 5 个 PASS，既有测试不红

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/store/ui-prefs.ts packages/frontend/src/components/NewSessionPane.tsx packages/frontend/src/components/new-session-pick.test.ts
git commit -m "feat(frontend): 新建会话默认智能体支持向导设置的 defaultAgent 优先级"
```

---

### Task 8: ProviderForm 抽取（纯重构）

**Files:**
- Create: `packages/frontend/src/components/settings/ProviderForm.tsx`
- Modify: `packages/frontend/src/components/settings/ProviderFormModal.tsx`（381 行 → 薄壳）

**Interfaces:**
- Consumes: 现有 `ProviderFormModal.tsx` 全部表单逻辑（state :22-52、预设加载 :55-66、handlers :94-165、body JSX :167-361、footer）
- Produces（Task 10 依赖）：
  - `ProviderForm({ initial?, onSaved, onCancel? }: { initial?: ModelProvider; onSaved: () => void; onCancel?: () => void })`——表单主体 + 测试/保存按钮；`onCancel` 不传时不渲染「取消」按钮
  - `ProviderFormModal` 对外 props 与 testid 全部不变

**行为约束（重构红线）：**
- 所有 `data-testid` 原样保留：`provider-form-modal`、`preset-search`、`preset-option`、`field-name`、`field-baseUrl`、`field-apiKey`、`model-quick-dropdown`、`model-contextWindow-*`、`provider-save-btn`、`modal-overlay`（e2e `settings-provider.spec.ts` 依赖）
- 「预设选择 → slug 联动」「`tagKey` 强制 TagInput 重挂载」「`createPortal` 模型快捷下拉定位」三块耦合逻辑原样搬动，不改写

- [ ] **Step 1: 先跑基线测试**

Run: `cd packages/frontend && bun test`
Expected: 全绿（记录基线）

- [ ] **Step 2: 抽取**

新建 `ProviderForm.tsx`：把 `ProviderFormModal.tsx` 的以下内容**原样**移入新组件 `ProviderForm`——全部 state（:22-52）、`useEffect` 预设加载（:55-66）、`applyPreset`/`addModelFromPreset`/`handleSave`/`handleTest`/`valid`（:94-165）、body JSX（预设下拉、三个 input、radio、TagInput、模型 table、测试提示）与 footer（测试连接/取消/保存）。差异点：

- props 改为 `{ initial?: ModelProvider; onSaved: () => void; onCancel?: () => void }`
- `handleSave` 末尾的 `onClose()` 改为 `onSaved()`
- 「取消」按钮改为条件渲染：`{onCancel && <button ... onClick={onCancel}>取消</button>}`
- header（标题「编辑供应商/添加供应商」）**不留**在 ProviderForm，留给调用方

`ProviderFormModal.tsx` 改为薄壳：

```tsx
import { Modal } from "../ui/Modal";
import type { ModelProvider } from "@wa-pi/shared";
import { ProviderForm } from "./ProviderForm";

interface Props {
  initial?: ModelProvider;
  onClose: () => void;
}

/** 设置页弹窗壳：header + ProviderForm（表单主体在 ProviderForm，向导复用） */
export function ProviderFormModal({ initial, onClose }: Props) {
  return (
    <Modal onClose={onClose} width={640} closeOnOverlayClick={false} data-testid="provider-form-modal">
      <div className="p-4 border-b border-subtle text-sm font-medium text-primary">
        {initial ? "编辑供应商" : "添加供应商"}
      </div>
      <ProviderForm initial={initial} onSaved={onClose} onCancel={onClose} />
    </Modal>
  );
}
```

注意：header 的边框/文字 className 以原文件 :167 附近实际写法为准，原样保留。

- [ ] **Step 3: 跑测试验证无回归**

Run: `cd packages/frontend && bun test && bunx tsc --noEmit`
Expected: 与基线一致全绿，无类型错误

- [ ] **Step 4: 手工冒烟（可选但推荐）**

起 dev（kernel + frontend），打开 设置 → 模型管理 → 添加供应商：选预设、填 key、加模型、测试连接、保存，确认与重构前一致。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/settings/ProviderForm.tsx packages/frontend/src/components/settings/ProviderFormModal.tsx
git commit -m "refactor(frontend): 抽取 ProviderForm 共用组件，为向导复用模型表单"
```

---

### Task 9: AgentCreatePicker（向导第 2 步 + 宫格新建共用）

**Files:**
- Create: `packages/frontend/src/components/onboarding/AgentCreatePicker.tsx`
- Test: `packages/frontend/src/components/onboarding/AgentCreatePicker.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 API（`GET /api/agents/presets`、`POST /api/agents/from-preset`）；Task 6 的 `randomPersonName`；`useAgentsStore`（list、`loadAll`）；`api-client` 的 `api.get/post`（`ApiError.status`）；`useToastStore`
- Produces（Task 10、11 依赖）：
  - `AgentCreatePicker({ onCreated, onCancel, autoFocusTab }: { onCreated: (displayName: string) => void; onCancel?: () => void; autoFocusTab?: "blank" | "preset" })`
  - 交互契约：创建成功调 `onCreated(displayName)`；409 时 toast 提示并自动重随机名字；手改名字与现有智能体重名时保存按钮置灰

**testid 约定（E2E 依赖，必须一字不差）：** `agent-create-picker`、`picker-tab-blank`、`picker-tab-preset`、`blank-name-input`、`blank-reshuffle`、`blank-create-btn`、`preset-search-input`、`preset-card-<id>`、`preset-name-input`、`preset-reshuffle`、`preset-save-btn`、`preset-back`

- [ ] **Step 1: 写失败测试**

`packages/frontend/src/components/onboarding/AgentCreatePicker.test.tsx`：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentCreatePicker } from "./AgentCreatePicker";

const PRESETS = [
  { id: "engineering-code-reviewer", name: "代码审查员", description: "专业代码审查专家", emoji: "🔍", color: "#06B6D4", department: "工程部" },
  { id: "marketing-seo-specialist", name: "SEO专家", description: "搜索引擎优化", emoji: "📈", color: "#059669", department: "营销部" },
];

const getMock = mock(); const postMock = mock();
mock.module("../../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: mock() } }));

// agents store 需要 list 提供查重；直接设置 state
import { useAgentsStore } from "../../store/agents";

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { type: "agent:presets", presets: PRESETS } : {});
  useAgentsStore.setState({ list: [] } as any);
});

test("默认展示两个 Tab，预设 Tab 加载并分组展示", async () => {
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  expect(await screen.findByText("代码审查员")).toBeTruthy();
  expect(screen.getByText("工程部")).toBeTruthy();
  expect(screen.getByText("营销部")).toBeTruthy();
});

test("搜索按名字/描述过滤", async () => {
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  await screen.findByText("代码审查员");
  fireEvent.change(screen.getByTestId("preset-search-input"), { target: { value: "SEO" } });
  expect(screen.queryByText("代码审查员")).toBeNull();
  expect(screen.getByText("SEO专家")).toBeTruthy();
});

test("选中预设进入命名面板，随机名非空，可保存", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: { displayName: "x" } }));
  render(<AgentCreatePicker onCreated={n => created.push(n)} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  const input = (await screen.findByTestId("preset-name-input")) as HTMLInputElement;
  expect(input.value.length).toBeGreaterThanOrEqual(2);
  fireEvent.change(input, { target: { value: "林晓岚" } });
  fireEvent.click(screen.getByTestId("preset-save-btn"));
  await screen.findByTestId("agent-create-picker"); // 等待异步
  expect(postMock).toHaveBeenCalledWith("/api/agents/from-preset", {
    id: "engineering-code-reviewer", displayName: "林晓岚",
  });
  expect(created).toEqual(["林晓岚"]);
});

test("手改名字与现有智能体重名时保存置灰", async () => {
  useAgentsStore.setState({ list: [{ displayName: "林晓岚" }] } as any);
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  fireEvent.change(await screen.findByTestId("preset-name-input"), { target: { value: "林晓岚" } });
  expect((screen.getByTestId("preset-save-btn") as HTMLButtonElement).disabled).toBe(true);
});

test("空白 Tab：随机名创建走 POST /api/agents", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<AgentCreatePicker onCreated={n => created.push(n)} />);
  const input = (await screen.findByTestId("blank-name-input")) as HTMLInputElement;
  expect(input.value.length).toBeGreaterThanOrEqual(2); // 已自动填随机名
  fireEvent.change(input, { target: { value: "苏念安" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(postMock).toHaveBeenCalledWith("/api/agents", { displayName: "苏念安" });
  expect(created).toEqual(["苏念安"]);
});

test("409 时 toast 提示且自动换名", async () => {
  const err = new Error("名称已被占用") as any; err.status = 409;
  postMock.mockImplementation(async () => { throw err; });
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  const input = (await screen.findByTestId("preset-name-input")) as HTMLInputElement;
  const before = input.value;
  fireEvent.click(screen.getByTestId("preset-save-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(input.value).not.toBe(before); // 自动重随机
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test src/components/onboarding/AgentCreatePicker.test.tsx`
Expected: FAIL，组件不存在

- [ ] **Step 3: 实现 AgentCreatePicker.tsx**

```tsx
import { useEffect, useMemo, useState } from "react";
import type { AgencyPresetMeta } from "@wa-pi/shared";
import { api } from "../../api-client";
import { randomPersonName } from "../../data/name-pool";
import { useAgentsStore } from "../../store/agents";
import { useToastStore } from "../../store/toast";

interface Props {
  /** 创建/保存成功回调（向导场景负责设默认并关闭；宫格场景负责刷新） */
  onCreated: (displayName: string) => void;
  /** 宫格场景用于关闭面板；向导场景不传（跳过走向导自己的按钮） */
  onCancel?: () => void;
  autoFocusTab?: "blank" | "preset";
}

type View = { kind: "list" } | { kind: "naming"; preset: AgencyPresetMeta };

/** 创建智能体面板：空白创建（随机人名）/ 从 268 个预设选择（命名后保存）。向导第 2 步与宫格新建共用。 */
export function AgentCreatePicker({ onCreated, onCancel, autoFocusTab = "preset" }: Props) {
  const [tab, setTab] = useState<"blank" | "preset">(autoFocusTab);
  const existingNames = useAgentsStore(s => s.list.map(a => a.displayName));

  return (
    <div data-testid="agent-create-picker" className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg bg-elevated p-1">
        <button data-testid="picker-tab-blank" onClick={() => setTab("blank")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs ${tab === "blank" ? "bg-accent text-white" : "text-secondary"}`}>
          ✚ 创建新智能体
        </button>
        <button data-testid="picker-tab-preset" onClick={() => setTab("preset")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs ${tab === "preset" ? "bg-accent text-white" : "text-secondary"}`}>
          📚 从预设选择
        </button>
      </div>
      {tab === "blank"
        ? <BlankCreate existingNames={existingNames} onCreated={onCreated} />
        : <PresetPick existingNames={existingNames} onCreated={onCreated} />}
      {onCancel && <button onClick={onCancel} className="self-end text-xs text-tertiary">取消</button>}
    </div>
  );
}

/** 空白创建：随机人名 + 🎲 + 手改，走 POST /api/agents */
function BlankCreate({ existingNames, onCreated }: { existingNames: string[]; onCreated: (n: string) => void }) {
  const [name, setName] = useState(() => randomPersonName(existingNames));
  const [saving, setSaving] = useState(false);
  const dup = existingNames.includes(name.trim());
  const valid = name.trim().length > 0 && !dup && !saving;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post("/api/agents", { displayName: name.trim() });
      await useAgentsStore.getState().loadAll();
      onCreated(name.trim());
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      setName(randomPersonName(existingNames));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-tertiary">TA 的名字</label>
      <div className="flex gap-2">
        <input data-testid="blank-name-input" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && void submit()}
          className="flex-1 rounded-md border border-subtle bg-base px-3 py-2 text-sm text-primary" />
        <button data-testid="blank-reshuffle" title="换一个"
          onClick={() => setName(randomPersonName(existingNames))}
          className="rounded-md bg-elevated px-3">🎲</button>
      </div>
      {dup && <div className="text-xs text-danger">这个名字已被占用</div>}
      <button data-testid="blank-create-btn" disabled={!valid} onClick={() => void submit()}
        className="rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-40">
        {saving ? "创建中…" : "创建"}
      </button>
    </div>
  );
}

/** 预设选择：搜索 + 部门分组 + 命名面板 */
function PresetPick({ existingNames, onCreated }: { existingNames: string[]; onCreated: (n: string) => void }) {
  const [presets, setPresets] = useState<AgencyPresetMeta[]>([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    void (async () => {
      try {
        const res = (await api.get("/api/agents/presets")) as { presets?: AgencyPresetMeta[] };
        setPresets(res.presets ?? []);
      } catch (e) {
        useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  }, []);

  const groups = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const filtered = kw
      ? presets.filter(p => p.name.toLowerCase().includes(kw) || p.description.toLowerCase().includes(kw))
      : presets;
    const map = new Map<string, AgencyPresetMeta[]>();
    for (const p of filtered) {
      const arr = map.get(p.department) ?? [];
      arr.push(p);
      map.set(p.department, arr);
    }
    return Array.from(map.entries());
  }, [presets, search]);

  if (view.kind === "naming") {
    return <NamingPanel preset={view.preset} existingNames={existingNames}
      onBack={() => setView({ kind: "list" })} onCreated={onCreated} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <input data-testid="preset-search-input" value={search} onChange={e => setSearch(e.target.value)}
        placeholder={`🔍 搜索 ${presets.length} 个预设智能体（名字 / 描述）…`}
        className="rounded-md border border-subtle bg-base px-3 py-2 text-sm text-primary" />
      <div className="flex max-h-[45vh] flex-col gap-3 overflow-auto">
        {groups.map(([dept, list]) => (
          <div key={dept}>
            <div className="mb-1 text-xs font-medium text-tertiary">{dept}（{list.length}）</div>
            <div className="grid grid-cols-2 gap-2">
              {list.map(p => (
                <button key={p.id} data-testid={`preset-card-${p.id}`}
                  onClick={() => setView({ kind: "naming", preset: p })}
                  className="rounded-lg border border-subtle p-2 text-left hover:border-accent">
                  <div className="text-sm text-primary">{p.emoji} <b>{p.name}</b></div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-tertiary">{p.description}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="py-6 text-center text-xs text-tertiary">没有匹配的预设</div>}
      </div>
    </div>
  );
}

/** 命名面板：随机人名（🎲/手改）+ 角色能力 + 保存 */
function NamingPanel({ preset, existingNames, onBack, onCreated }: {
  preset: AgencyPresetMeta; existingNames: string[];
  onBack: () => void; onCreated: (n: string) => void;
}) {
  const [name, setName] = useState(() => randomPersonName(existingNames));
  const [saving, setSaving] = useState(false);
  const dup = existingNames.includes(name.trim());
  const valid = name.trim().length > 0 && !dup && !saving;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post("/api/agents/from-preset", { id: preset.id, displayName: name.trim() });
      await useAgentsStore.getState().loadAll();
      onCreated(name.trim());
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      setName(randomPersonName(existingNames)); // 409 等失败：自动换名重试
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-subtle bg-elevated p-3">
        <div className="text-center text-3xl">{preset.emoji}</div>
        <div className="mb-2 text-center text-xs text-tertiary">角色：{preset.name} · {preset.department}</div>
        <label className="text-xs text-tertiary">TA 的名字</label>
        <div className="mt-1 flex gap-2">
          <input data-testid="preset-name-input" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && void submit()}
            className="flex-1 rounded-md border border-subtle bg-base px-3 py-2 text-center text-base font-semibold text-primary" />
          <button data-testid="preset-reshuffle" title="换一个"
            onClick={() => setName(randomPersonName(existingNames))}
            className="rounded-md bg-base px-3">🎲</button>
        </div>
        {dup && <div className="mt-1 text-center text-xs text-danger">这个名字已被占用</div>}
        <div className="mt-2 rounded-md bg-base p-2 text-xs text-secondary">{preset.description}</div>
        <button data-testid="preset-save-btn" disabled={!valid} onClick={() => void submit()}
          className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-40">
          {saving ? "保存中…" : "保存为我的智能体 ✓"}
        </button>
      </div>
      <button data-testid="preset-back" onClick={onBack} className="self-start text-xs text-tertiary">← 返回列表</button>
    </div>
  );
}
```

Tailwind 语义类（`bg-elevated`、`text-primary`、`border-subtle`、`bg-accent`、`text-danger` 等）以实现时项目 `tailwind.config` 实际定义的为准——先 grep 既有组件（如 `ProviderFormModal`、`AgentGalleryModal`）用了哪些，跟着用，不要发明新类名。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test src/components/onboarding/AgentCreatePicker.test.tsx`
Expected: 6 个 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/onboarding/AgentCreatePicker.tsx packages/frontend/src/components/onboarding/AgentCreatePicker.test.tsx
git commit -m "feat(frontend): 新增 AgentCreatePicker（空白创建/预设选择 + 随机人名命名）"
```

---

### Task 10: OnboardingWizard + App 自动弹出 + 设置入口

**Files:**
- Create: `packages/frontend/src/store/onboarding.ts`
- Create: `packages/frontend/src/components/onboarding/OnboardingWizard.tsx`
- Modify: `packages/frontend/src/App.tsx`（mount effect :81-88 区域 + 弹窗渲染区 :536-575）
- Modify: `packages/frontend/src/components/settings/GeneralSection.tsx`（照 :83-134 设置块模式加入口）
- Test: `packages/frontend/src/components/onboarding/OnboardingWizard.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `ProviderForm`；Task 9 的 `AgentCreatePicker`；Task 7 的 `useUiPrefsStore.setDefaultAgent`；`Modal`（:20-46）；`useProvidersStore`（`providers`、`loading`）；`useSettingsStore.close()`
- Produces:
  - `useOnboardingStore`：`{ wizardOpen: boolean; openWizard(): void; closeWizard(): void }`（**不持久化**）
  - `OnboardingWizard({ onClose }: { onClose: () => void })`
  - App 行为：`!providersLoading && providers.length === 0` 时自动 `openWizard()`

**testid 约定：** `onboarding-wizard`、`wizard-step-1`、`wizard-step-2`、`wizard-next`、`wizard-back`、`wizard-skip`

- [ ] **Step 1: 写失败测试**

`packages/frontend/src/components/onboarding/OnboardingWizard.test.tsx`：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import { useUiPrefsStore } from "../../store/ui-prefs";

const getMock = mock(); const postMock = mock();
mock.module("../../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: mock() } }));

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { presets: [] } : { presets: [] });
  useUiPrefsStore.setState({ defaultAgent: null } as any);
});

test("默认停在第 1 步（模型表单）", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
  expect(screen.queryByTestId("wizard-step-2")).toBeNull();
});

test("不保存模型也能「下一步」进入第 2 步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  expect(await screen.findByTestId("wizard-step-2")).toBeTruthy();
  expect(screen.getByTestId("agent-create-picker")).toBeTruthy();
});

test("第 2 步「上一步」返回第 1 步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-back"));
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
});

test("第 2 步「跳过」直接关闭", async () => {
  let closed = false;
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  fireEvent.click(await screen.findByTestId("wizard-skip"));
  expect(closed).toBe(true);
});

test("创建智能体成功后设为 defaultAgent 并关闭", async () => {
  let closed = false;
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  // 向导默认停在预设 Tab，先切到空白 Tab
  fireEvent.click(await screen.findByTestId("picker-tab-blank"));
  fireEvent.change(await screen.findByTestId("blank-name-input"), { target: { value: "林晓岚" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(useUiPrefsStore.getState().defaultAgent).toBe("林晓岚");
  expect(closed).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test src/components/onboarding/OnboardingWizard.test.tsx`
Expected: FAIL，组件不存在

- [ ] **Step 3: 实现 `src/store/onboarding.ts`**

```ts
import { create } from "zustand";

interface OnboardingState {
  /** 初始化向导是否打开（不持久化：触发逻辑见 App.tsx） */
  wizardOpen: boolean;
  openWizard: () => void;
  closeWizard: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  wizardOpen: false,
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
}));
```

- [ ] **Step 4: 实现 `OnboardingWizard.tsx`**

```tsx
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { ProviderForm } from "../settings/ProviderForm";
import { AgentCreatePicker } from "./AgentCreatePicker";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useToastStore } from "../../store/toast";

interface Props {
  onClose: () => void;
}

/** 初始化向导：第 1 步配置模型（不强制）→ 第 2 步设置默认智能体（可跳过） */
export function OnboardingWizard({ onClose }: Props) {
  const [step, setStep] = useState<1 | 2>(1);

  const handleCreated = (displayName: string) => {
    useUiPrefsStore.getState().setDefaultAgent(displayName);
    useToastStore.getState().add(`「${displayName}」已加入你的团队，并设为默认智能体`, "success");
    onClose();
  };

  return (
    <Modal onClose={onClose} width={640} data-testid="onboarding-wizard">
      <div className="border-b border-subtle p-4">
        <div className="text-sm font-medium text-primary">欢迎使用 — 快速初始化</div>
        {/* 步骤条 */}
        <div className="mt-2 flex items-center gap-2">
          <div className={`h-1 w-10 rounded ${step >= 1 ? "bg-accent" : "bg-elevated"}`} />
          <div className={`h-1 w-10 rounded ${step >= 2 ? "bg-accent" : "bg-elevated"}`} />
          <span className="ml-1 text-xs text-tertiary">第 {step} 步 / 共 2 步</span>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto p-4">
        {step === 1 && (
          <div data-testid="wizard-step-1" className="flex flex-col gap-3">
            <div className="text-xs text-tertiary">
              先配置一个模型供应商（也可以稍后再配，直接点「下一步」）。
            </div>
            <ProviderForm onSaved={() => useToastStore.getState().add("模型供应商已保存", "success")} />
          </div>
        )}
        {step === 2 && (
          <div data-testid="wizard-step-2" className="flex flex-col gap-3">
            <div className="text-xs text-tertiary">
              创建你的第一个智能体，或从预设库挑一位专家。TA 将成为你的默认智能体。
            </div>
            <AgentCreatePicker autoFocusTab="preset" onCreated={handleCreated} />
          </div>
        )}
      </div>

      <div className="flex justify-between border-t border-subtle p-3">
        <div>
          {step === 2 && (
            <button data-testid="wizard-back" onClick={() => setStep(1)}
              className="rounded-md bg-elevated px-3 py-1.5 text-sm text-secondary">← 上一步</button>
          )}
        </div>
        <div>
          {step === 1 && (
            <button data-testid="wizard-next" onClick={() => setStep(2)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-white">下一步 →</button>
          )}
          {step === 2 && (
            <button data-testid="wizard-skip" onClick={onClose}
              className="rounded-md bg-elevated px-3 py-1.5 text-sm text-secondary">跳过</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
```

注意：第 2 步创建成功即视为完成（`handleCreated` 直接关闭），「跳过」是唯一出口按钮；`ProviderForm` 不传 `onCancel`（不渲染取消按钮）。

- [ ] **Step 5: App.tsx 挂载**

弹窗渲染区（:536-575，与 `SettingsModal` 同层）加：

```tsx
{useOnboardingStore((s) => s.wizardOpen) && (
  <OnboardingWizard onClose={() => useOnboardingStore.getState().closeWizard()} />
)}
```

import 区加：

```ts
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { useOnboardingStore } from "./store/onboarding";
```

自动弹出：在 App 组件内（其他 `useXxxStore` 订阅附近）加：

```ts
const providers = useProvidersStore(s => s.providers);
const providersLoading = useProvidersStore(s => s.loading);

// 首次启动引导：无任何模型供应商时自动弹出初始化向导
useEffect(() => {
  if (!providersLoading && providers.length === 0) {
    useOnboardingStore.getState().openWizard();
  }
}, [providersLoading, providers]);
```

注意：先读 `store/providers.ts` 确认 `loading` 初始值为 `true`（避免 mount 即闪弹）；若不是 `true`，改为在 effect 里等首次 load 完成（以实际代码为准）。

- [ ] **Step 6: GeneralSection 加入口**

照既有设置块模式（标题 + 说明 + 控件，GeneralSection.tsx:83-134），在末尾加：

```tsx
<div>
  <div className="text-sm font-medium text-primary">初始化引导</div>
  <div className="mt-1 text-xs text-tertiary">重新打开新手引导，配置模型与默认智能体</div>
  <button
    data-testid="reopen-onboarding"
    onClick={() => {
      useSettingsStore.getState().close();
      useOnboardingStore.getState().openWizard();
    }}
    className="mt-2 rounded-md bg-elevated px-3 py-1.5 text-sm text-secondary"
  >
    重新打开引导
  </button>
</div>
```

import 区加 `import { useOnboardingStore } from "../../store/onboarding";`、`import { useSettingsStore } from "../../store/settings";`（以实际路径/既有 import 为准）。

- [ ] **Step 7: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test && bunx tsc --noEmit`
Expected: 新测试 5 个 PASS，既有测试不红，无类型错误

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/store/onboarding.ts packages/frontend/src/components/onboarding/ packages/frontend/src/App.tsx packages/frontend/src/components/settings/GeneralSection.tsx
git commit -m "feat(frontend): 新增初始化向导，无模型时自动弹出，设置页可重开"
```

---

### Task 11: 宫格新建流程替换为 AgentCreatePicker

**Files:**
- Modify: `packages/frontend/src/components/AgentGalleryModal.tsx`（新建流程 :36-37、:86-93、:101-131）
- Test: `packages/frontend/src/components/AgentGalleryModal-create.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 9 的 `AgentCreatePicker`；`AgentGalleryModal` 现有 props `onCreated(name)`（App 侧打开 AgentConfig 编辑弹窗的「乐观打开契约」，:203）
- Produces: 宫格「＋ 新建智能体」点击后打开 `AgentCreatePicker`；创建成功 → 关闭面板 → 调 `props.onCreated(name)`（保持既有契约）；**不设置 defaultAgent**（向导专属）

**行为约束：** 删除 `newName`/`submitCreate`/inline 输入框（:36-37、:101-131 的相关 JSX）；`gallery-create` 按钮 testid 保留；其余宫格功能（删除、chatWith、编辑）不动。

- [ ] **Step 1: 写失败测试**

`packages/frontend/src/components/AgentGalleryModal-create.test.tsx`：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentGalleryModal } from "./AgentGalleryModal";

const getMock = mock(); const postMock = mock(); const delMock = mock();
mock.module("../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: delMock } }));

import { useAgentsStore } from "../store/agents";

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { presets: [] } : {});
  useAgentsStore.setState({ list: [] } as any);
});

test("点击「新建」打开 AgentCreatePicker（不再是 inline 输入框）", async () => {
  render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("gallery-create"));
  expect(await screen.findByTestId("agent-create-picker")).toBeTruthy();
  expect(screen.queryByTestId("gallery-create-input")).toBeNull();
});

test("创建成功回调 onCreated 并关闭面板", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={n => created.push(n)} />);
  fireEvent.click(await screen.findByTestId("gallery-create"));
  fireEvent.click(await screen.findByTestId("picker-tab-blank"));
  fireEvent.change(await screen.findByTestId("blank-name-input"), { target: { value: "苏念安" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(created).toEqual(["苏念安"]);
  expect(screen.queryByTestId("agent-create-picker")).toBeNull();
});
```

（`AgentGalleryModal` 的实际 props 以实现时读到的为准；上面按探索结果 :15-22 的 `{ onClose, onChatWith, onEdit, onCreated }` 编写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test src/components/AgentGalleryModal-create.test.tsx`
Expected: FAIL（`gallery-create-input` 仍存在 / picker 不存在）

- [ ] **Step 3: 修改 AgentGalleryModal.tsx**

- 删除：`newName` state、`submitCreate`、inline 输入框 JSX（`gallery-create-input` 及确定/取消按钮）。`creating` state 改语义为「picker 是否打开」。
- 「＋ 新建智能体」按钮（`gallery-create`）`onClick={() => setCreating(true)}`。
- 模态内容区加（删除确认 ConfirmDialog 同层）：

```tsx
{creating && (
  <AgentCreatePicker
    autoFocusTab="preset"
    onCreated={(name) => {
      setCreating(false);
      onCreated(name);
    }}
    onCancel={() => setCreating(false)}
  />
)}
```

- import 区加 `import { AgentCreatePicker } from "./onboarding/AgentCreatePicker";`，并清理因删除而变得无用的 import/变量。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test && bunx tsc --noEmit`
Expected: 新测试 PASS，既有测试不红

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentGalleryModal.tsx packages/frontend/src/components/AgentGalleryModal-create.test.tsx
git commit -m "feat(frontend): 宫格新建流程升级为 AgentCreatePicker（空白/预设两 Tab）"
```

---

### Task 12: Playwright E2E

**Files:**
- Create: `packages/frontend/e2e/onboarding-wizard.spec.ts`
- Modify: `packages/frontend/e2e/helpers.ts`（加 `deleteAllProviders`）

**Interfaces:**
- Consumes: 全部前序任务；`e2e/helpers.ts` 现有 `createProject`（:46-67）等；global-setup 的隔离环境（`WA_PI_DIR` 独立、`WA_PI_SKIP_AGENT_SEED=1`，:143-159）
- Produces: E2E 覆盖「自动弹出 → 跳过模型 → 从预设创建 → 默认选中」主流程

**环境注意：** E2E 的 kernel 由 global-setup 以隔离 `WA_PI_DIR` 启动，初始无 providers（向导自动弹出的前提）；但其他 spec（如 `settings-provider.spec.ts`）可能往同一环境写过 provider，所以本 spec 的 `beforeAll` 必须先清空 providers。

- [ ] **Step 1: helpers.ts 加清空工具**

```ts
/** 清空全部模型供应商（onboarding 向导测试的前置条件） */
export async function deleteAllProviders(): Promise<void> {
  const res = await fetch(`${BASE}/api/providers`);
  const data = (await res.json()) as { providers?: { id: string; name: string }[] };
  for (const p of data.providers ?? []) {
    await fetch(`${BASE}/api/providers/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(() => {});
  }
}
```

注意：`DELETE /api/providers/:name` 路由参数名是 `name` 但实现按 id 删除（`provider:delete` 事件字段为 `id`）——先读 `routes/providers.ts` 与 provider 删除的 ws case 确认按 id 还是 name 传参，以实际为准。

- [ ] **Step 2: 写 E2E spec**

`packages/frontend/e2e/onboarding-wizard.spec.ts`：

```ts
import { test, expect } from "@playwright/test";
import { createProject, deleteAllProviders, deleteAgentQuiet } from "./helpers";

const AGENT_NAME = "E2E向导智能体";

test.describe.serial("初始化向导", () => {
  test.beforeAll(async () => {
    await deleteAllProviders();   // 确保 providers 为空 → 向导自动弹出
    await deleteAgentQuiet(AGENT_NAME);
  });

  test.afterAll(async () => {
    await deleteAgentQuiet(AGENT_NAME); // finally 清理
  });

  test("无模型时自动弹出 → 跳过模型 → 从预设创建 → 默认选中", async ({ page }) => {
    await createProject("e2e-onboarding", "/tmp/e2e-onboarding");
    await page.goto("/");

    // 1. 向导自动弹出（providers 为空）
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
    await expect(page.getByTestId("wizard-step-1")).toBeVisible();

    // 2. 不保存模型，直接下一步
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();

    // 3. 预设 Tab → 搜索 → 选中卡片 → 命名面板
    await page.getByTestId("picker-tab-preset").click();
    await page.getByTestId("preset-search-input").fill("代码审查");
    await page.getByTestId("preset-card-engineering-code-reviewer").click();
    await expect(page.getByTestId("preset-name-input")).toBeVisible();

    // 4. 改成固定人名并保存
    await page.getByTestId("preset-name-input").fill(AGENT_NAME);
    await page.getByTestId("preset-save-btn").click();

    // 5. 向导关闭，智能体已创建并设为默认
    await expect(page.getByTestId("onboarding-wizard")).toBeHidden();
    await expect.poll(async () => {
      const res = await page.evaluate(async (name) => {
        const r = await fetch(`/api/agents/${encodeURIComponent(name)}/config`);
        return r.ok ? ((await r.json()) as any) : null;
      }, AGENT_NAME);
      return res?.config?.systemPromptBody?.includes(`你的名字是「${AGENT_NAME}」。`) ?? false;
    }).toBe(true);

    // 6. 新建会话默认选中该智能体
    await page.getByTestId("agent-dropdown").waitFor();   // testid 以 AgentDropdown 实际为准，先读组件
    await expect(page.getByTestId("agent-dropdown")).toContainText(AGENT_NAME);
  });

  test("设置页可重新打开引导", async ({ page }) => {
    await createProject("e2e-onboarding2", "/tmp/e2e-onboarding2");
    // 先补一个 provider，确认向导不自动弹
    // （settings-provider.spec.ts 的 saveProvider helper 可复用）
    await page.goto("/");
    await expect(page.getByTestId("onboarding-wizard")).toBeHidden();
    // 打开设置 → general → 重新打开引导
    await page.getByTestId("settings-button").click();     // testid 以 SettingsButton 实际为准
    await page.getByTestId("reopen-onboarding").click();
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
    // 关闭并还愿：删掉补的 provider，保持环境干净
  });
});
```

实现前必须核对的细节（读代码确认，不要猜）：
- `AgentDropdown`/`SettingsButton` 是否有 testid，没有就在组件上补（最小改动，随同本 Task 提交）
- `/api/agents/:name/config` 的响应结构（`config` 字段层级），以 `routes/agents.ts` 的 `agent:config:get` reply 为准
- 第二个用例「补 provider」用 helpers 的 `saveProvider`，并在 `afterAll` 用 `deleteAllProviders()` 还原

- [ ] **Step 3: 跑 E2E**

Run: `cd packages/frontend && bunx playwright test e2e/onboarding-wizard.spec.ts`
Expected: 2 个用例全过；无截图残留（未主动截图；若 trace/screenshot 目录有产物，删除）

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/e2e/onboarding-wizard.spec.ts packages/frontend/e2e/helpers.ts
git commit -m "test(e2e): 新增初始化向导 Playwright 端到端测试"
```

---

### Task 13: CHANGELOG + 全量回归

**Files:**
- Modify: `CHANGELOG.md`（顶部追加）

- [ ] **Step 1: 全量回归**

Run:
```bash
cd packages/shared && bun test && bunx tsc --noEmit
cd ../kernel && bun test && bunx tsc --noEmit
cd ../frontend && bun test && bunx tsc --noEmit && bunx playwright test
```
Expected: 四层全绿（单测 / 组件测试 / curl 集成见 Task 5 / E2E）

- [ ] **Step 2: 更新 CHANGELOG.md**

顶部追加（遵循文件既有格式）：

```markdown
## 2026-08-07

- **新增功能** — 初始化向导：无模型时自动弹出两步引导（配置模型 → 设置默认智能体），设置页可重开；智能体支持从 268 个 agency 预设库选择并以人名保存（随机人名可改）；宫格新建流程升级为同一面板；新建会话默认智能体优先使用向导设置值。影响范围：kernel（preset-store、agents 路由、ws-server cases）、shared（agency-presets 类型）、frontend（onboarding 向导、AgentCreatePicker、ui-prefs、NewSessionPane、AgentGalleryModal、GeneralSection）
```

- [ ] **Step 3: 清理检查**

- `find . -name "*.png" -path "*test-results*"` 等截图残留 → 删除
- `git status` 确认无临时文件混入

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 记录初始化向导与预设智能体功能变更"
```
