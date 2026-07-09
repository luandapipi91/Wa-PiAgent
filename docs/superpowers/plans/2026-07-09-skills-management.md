# 技能管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在系统设置页新增「技能」菜单，管理技能加载目录（增删）、查看已加载技能、单独启用/禁用技能，配置变更后自动 reload 所有会话。

**Architecture:** 前端 Zustand store + SkillSection 组件 → WS 事件 → kernel 用 Pi SDK `loadSkills()` 扫描技能目录 + 读写 `settings.json` 的 `skills`/`disabledSkills` 字段 + reload 所有活跃会话。

**Tech Stack:** React 19 + Zustand 5 + Tailwind 3 + CSS 变量；kernel Bun + `node:fs/promises`；Pi SDK `loadSkills()`；测试统一 `bun:test`（前端组件测试经 `bunfig.toml` preload happy-dom）；E2E Playwright。

**前置依赖**: 系统设置页（SettingsModal + 左侧导航 + settings store）已实现。本计划假设 `SettingsModal.tsx`、`store/settings.ts`（含 `activeSection`）、`SettingsButton.tsx` 已存在。

## Global Constraints

- **语言**：所有回复/注释/沟通用中文；代码标识符保持语义清晰（AGENTS.md §1）
- **测试统一用 `bun:test`**：前端组件测试不是 vitest，靠 `packages/frontend/bunfig.toml` 的 `preload = ["./tests/happydom-setup.ts"]` 提供 happy-dom + WebSocket mock。组件测试 import `{ test, expect, mock } from "bun:test"`
- **精准修改**：只碰必须改的；匹配现有风格（AGENTS.md §4）。复用现有 `ui/Modal`、`ui/ConfirmDialog`、`DirTreePicker`
- **数据目录**：`HIAGENT_DIR`（`packages/shared/src/constants.ts`，env 可覆盖）
- **WS 单例**：前端经 `ws-instance.ts` 的 `send()` / `onMessage()` 收发；store 不直接落盘
- **settings.json 结构**：`{ packages?: string[], skills?: string[], disabledSkills?: string[], [k: string]: unknown }`。`skills` 是 Pi 直接读的字段；`disabledSkills` 是 HiAgent 自定义字段
- **内置目录**：`${HIAGENT_DIR}/skills/`，kernel 启动时 `mkdir -p`。不写入 `skills` 数组（Pi 自动扫描 `agentDir/skills/`）。UI 始终展示、无删除按钮
- **设计文档**：`docs/superpowers/specs/2026-07-09-skills-management-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/skills.ts` | `SkillInfo` 类型 + WS 事件类型（skill:list/toggle, skillDir:add/remove, skill:list/changed 结果） |
| `packages/kernel/src/skill-manager.ts` | `SkillManager` 类：读 settings.json 的 skills/disabledSkills；用 `loadSkills()` 扫描；去重；增删目录；toggle 禁用 |
| `packages/kernel/tests/skill-manager.test.ts` | SkillManager 单测（扫描/去重/增删目录/toggle） |
| `packages/frontend/src/store/skills.ts` | Zustand：skills/allSkills/dirs/disabledSkills/builtinDir + load/toggleSkill/addDir/removeDir |
| `packages/frontend/src/components/settings/SkillSection.tsx` | 技能菜单右侧内容（目录折叠区 + 技能列表） |
| `packages/frontend/tests/store-skills.test.ts` | skills store 单测 |
| `packages/frontend/tests/SkillSection.test.tsx` | SkillSection 组件测试 |
| `packages/frontend/e2e/skills.spec.ts` | E2E：技能管理完整流程 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | re-export `./skills` |
| `packages/shared/src/types.ts` | `WSClientEvent` / `WSServerEvent` 联合加入 skill 事件 |
| `packages/shared/src/constants.ts` | 加 `BUILTIN_SKILLS_DIR` 常量 |
| `packages/kernel/src/agent-manager.ts` | 加 `reloadAllSessions()` 方法（遍历 sessions 调 session.reload()） |
| `packages/kernel/src/ws-server.ts` | `WSServerOpts` 加 `skillManager` + `agentManager`（已有）；handle 加 4 个 skill case |
| `packages/kernel/src/index.ts` | 启动时 `mkdir -p ~/.hiagent/skills/` + new SkillManager + 注入 ws-server |
| `packages/frontend/src/store/settings.ts` | `activeSection` 联合类型加 `"skills"` |
| `packages/frontend/src/components/SettingsModal.tsx` | 左侧导航加「技能」项；右侧条件渲染 `<SkillSection />` |
| `packages/frontend/src/App.tsx` | onMessage 路由 `skill:list` / `skill:changed` 到 skills store |
| `CHANGELOG.md` | 顶部加本次变更记录 |

---

## Task 1: shared 类型 + 常量

**Files:**
- Create: `packages/shared/src/skills.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types.ts`

**Interfaces:**
- Produces: `SkillInfo` 类型；WS 事件类型；`BUILTIN_SKILLS_DIR` 常量

- [ ] **Step 1: 创建 skills.ts（类型 + WS 事件）**

Create `packages/shared/src/skills.ts`:

```ts
// ===== 技能管理类型定义 =====

/** 技能信息（从 SKILL.md frontmatter 提取的最小集） */
export interface SkillInfo {
  name: string;
  description: string;
}

// ===== WS 协议事件（技能管理）=====

// 前端 → kernel
export interface SkillListEvent { type: "skill:list"; }
export interface SkillToggleEvent {
  type: "skill:toggle";
  skillName: string;
  disabled: boolean;          // true=禁用，false=启用
}
export interface SkillDirAddEvent {
  type: "skillDir:add";
  path: string;
}
export interface SkillDirRemoveEvent {
  type: "skillDir:remove";
  path: string;
}

// kernel → 前端（skill:list 和 skill:changed 结构相同）
export interface SkillListResult {
  type: "skill:list";
  skills: SkillInfo[];        // 已启用的技能（过滤禁用 + 去重后）
  allSkills: SkillInfo[];     // 全部扫描出的技能（含禁用的，用于 UI 灰显）
  dirs: string[];             // 技能目录列表（含内置目录，内置在第一位）
  disabledSkills: string[];   // 被禁用的技能名
  builtinDir: string;         // 内置目录路径（告诉前端哪个不可删）
}

export interface SkillChangedEvent {
  type: "skill:changed";
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: string[];
  disabledSkills: string[];
  builtinDir: string;
}
```

- [ ] **Step 2: 加常量到 constants.ts**

Modify `packages/shared/src/constants.ts`，在 `GENERATED_DIR` 之后加：

```ts
export const BUILTIN_SKILLS_DIR = `${HIAGENT_DIR}/skills`;   // 内置技能目录，kernel 启动时创建，不可删
```

- [ ] **Step 3: index.ts re-export**

Modify `packages/shared/src/index.ts`，加一行：

```ts
export * from "./skills";
```

- [ ] **Step 4: 把 skill 事件加入 WS 联合类型**

Modify `packages/shared/src/types.ts`：

顶部 import 区加：
```ts
import type {
  SkillListEvent, SkillToggleEvent, SkillDirAddEvent, SkillDirRemoveEvent,
  SkillListResult, SkillChangedEvent,
} from "./skills";
```

`WSClientEvent` 联合末尾（`FSHomeRequest` 之前）加：
```ts
  | SkillListEvent | SkillToggleEvent | SkillDirAddEvent | SkillDirRemoveEvent
```

`WSServerEvent` 联合末尾（`FSHomeResult` 之前）加：
```ts
  | SkillListResult | SkillChangedEvent
```

- [ ] **Step 5: typecheck 确认通过**

Run: `cd packages/shared && bunx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/skills.ts packages/shared/src/constants.ts packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): 技能管理类型 + WS 事件 + BUILTIN_SKILLS_DIR 常量"
```

---

## Task 2: kernel SkillManager（扫描/去重/目录管理/toggle）

**Files:**
- Create: `packages/kernel/src/skill-manager.ts`
- Create: `packages/kernel/tests/skill-manager.test.ts`

**Interfaces:**
- Consumes: `HIAGENT_DIR`、`BUILTIN_SKILLS_DIR`（from shared）；Pi SDK `loadSkills`
- Produces: `SkillManager` 类：
  - `scan(): Promise<{ skills: SkillInfo[]; allSkills: SkillInfo[]; dirs: string[]; disabledSkills: string[]; builtinDir: string }>`
  - `addDir(path: string): Promise<void>` — 校验存在 + 写 settings.json
  - `removeDir(path: string): Promise<void>` — 拒绝内置 + 从 settings.json 移除
  - `toggleSkill(skillName: string, disabled: boolean): Promise<void>` — 改 disabledSkills

- [ ] **Step 1: 写失败测试**

Create `packages/kernel/tests/skill-manager.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";
import { BUILTIN_SKILLS_DIR } from "@hiagent/shared";

function tmpDir() {
  const dir = join(import.meta.dir, ".tmp-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 在指定目录下创建一个技能（含 SKILL.md）
function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n内容`,
  );
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
  // 创建内置技能目录
  mkdirSync(join(dir, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("scan 空目录返回空技能列表", async () => {
  const mgr = new SkillManager(dir);
  const result = await mgr.scan();
  expect(result.skills).toEqual([]);
  expect(result.allSkills).toEqual([]);
  expect(result.builtinDir).toBe(join(dir, "skills"));
  expect(result.dirs).toContain(join(dir, "skills"));
});

test("scan 扫描出内置目录的技能", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  const result = await mgr.scan();
  expect(result.allSkills.some(s => s.name === "brave-search")).toBe(true);
});

test("addDir 添加用户目录后 scan 能扫到该目录技能", async () => {
  // 内置目录放一个技能
  createSkill(join(dir, "skills"), "builtin-skill", "内置技能");
  // 用户目录放一个技能
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "user-skill", "用户技能");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  expect(result.allSkills.some(s => s.name === "user-skill")).toBe(true);
  expect(result.dirs).toContain(userDir);
});

test("addDir 路径不存在抛错", async () => {
  const mgr = new SkillManager(dir);
  expect(mgr.addDir(join(dir, "nonexistent"))).rejects.toThrow("目录不存在");
});

test("removeDir 内置目录抛错", async () => {
  const mgr = new SkillManager(dir);
  const builtinDir = join(dir, "skills");
  expect(mgr.removeDir(builtinDir)).rejects.toThrow("内置目录不可删除");
});

test("removeDir 用户目录后 settings.json 移除", async () => {
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  await mgr.removeDir(userDir);
  const result = await mgr.scan();
  expect(result.dirs).not.toContain(userDir);
});

test("toggleSkill 禁用后 skills 不含该技能但 allSkills 含", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  await mgr.toggleSkill("brave-search", true);
  const result = await mgr.scan();
  expect(result.allSkills.some(s => s.name === "brave-search")).toBe(true);
  expect(result.skills.some(s => s.name === "brave-search")).toBe(false);
  expect(result.disabledSkills).toContain("brave-search");
});

test("toggleSkill 启用后从 disabledSkills 移除", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  await mgr.toggleSkill("brave-search", true);   // 先禁用
  await mgr.toggleSkill("brave-search", false);  // 再启用
  const result = await mgr.scan();
  expect(result.disabledSkills).not.toContain("brave-search");
  expect(result.skills.some(s => s.name === "brave-search")).toBe(true);
});

test("去重：内置目录同名技能优先于用户目录", async () => {
  // 内置和用户目录都放同名技能，描述不同
  createSkill(join(dir, "skills"), "dup-skill", "内置版本");
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "dup-skill", "用户版本");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  const dup = result.allSkills.find(s => s.name === "dup-skill");
  expect(dup).toBeTruthy();
  expect(dup!.description).toBe("内置版本");  // 内置优先
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/kernel/tests/skill-manager.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 SkillManager**

Create `packages/kernel/src/skill-manager.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIAGENT_DIR, BUILTIN_SKILLS_DIR } from "@hiagent/shared";
import type { SkillInfo } from "@hiagent/shared";

interface SkillSettings {
  packages?: string[];
  skills?: string[];
  disabledSkills?: string[];
  [k: string]: unknown;
}

interface ScanResult {
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: string[];
  disabledSkills: string[];
  builtinDir: string;
}

/**
 * 技能管理：读 settings.json 的 skills/disabledSkills 字段；
 * 用 Pi SDK loadSkills() 扫描技能目录；同名去重（内置优先）。
 */
export class SkillManager {
  private builtinDir: string;

  constructor(private dataDir: string = HIAGENT_DIR) {
    // 内置目录 = dataDir/skills/（测试注入 dataDir 时随之变化）
    this.builtinDir = join(dataDir, "skills");
  }

  /** 读取 settings.json */
  private async readSettings(): Promise<SkillSettings> {
    try {
      const raw = await readFile(join(this.dataDir, "settings.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** 写 settings.json（保留其他字段） */
  private async writeSettings(settings: SkillSettings): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  }

  /**
   * 扫描所有技能目录，返回技能列表（去重 + 过滤禁用）。
   * 扫描顺序：内置目录第一（Pi loadSkills 的 agentDir/skills 自动扫），然后 settings.skills 数组。
   */
  async scan(): Promise<ScanResult> {
    const settings = await this.readSettings();
    const userDirs = settings.skills ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    // 用 Pi SDK loadSkills 扫描
    // agentDir = dataDir → Pi 自动扫 dataDir/skills/（内置）
    // skillPaths = 用户目录数组
    // includeDefaults = false → 不扫 Pi 默认的 ~/.pi/agent/skills/ 等
    const { loadSkills } = await import("@earendil-works/pi-coding-agent");
    const result = loadSkills({
      cwd: this.dataDir,
      agentDir: this.dataDir,
      skillPaths: userDirs,
      includeDefaults: false,
    });

    // 去重：同名保留先扫到的（loadSkills 已保证内置目录优先，因为它从 agentDir/skills 先扫）
    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];
    for (const skill of result.skills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        allSkills.push({ name: skill.name, description: skill.description });
      }
    }

    // 过滤禁用
    const skills = allSkills.filter(s => !disabledSkills.includes(s.name));

    // 目录列表：内置在第一位，然后用户目录
    const dirs = [this.builtinDir, ...userDirs];

    return { skills, allSkills, dirs, disabledSkills, builtinDir: this.builtinDir };
  }

  /** 添加技能目录（校验路径存在 + 写 settings.json skills 数组） */
  async addDir(path: string): Promise<void> {
    if (!existsSync(path)) throw new Error("目录不存在");
    const settings = await this.readSettings();
    const dirs = settings.skills ?? [];
    if (!dirs.includes(path)) {
      dirs.push(path);
      settings.skills = dirs;
      await this.writeSettings(settings);
    }
  }

  /** 删除技能目录（拒绝内置目录） */
  async removeDir(path: string): Promise<void> {
    if (path === this.builtinDir) throw new Error("内置目录不可删除");
    const settings = await this.readSettings();
    const dirs = settings.skills ?? [];
    settings.skills = dirs.filter(d => d !== path);
    await this.writeSettings(settings);
  }

  /** 启用/禁用技能 */
  async toggleSkill(skillName: string, disabled: boolean): Promise<void> {
    const settings = await this.readSettings();
    const list = settings.disabledSkills ?? [];
    if (disabled) {
      if (!list.includes(skillName)) {
        settings.disabledSkills = [...list, skillName];
        await this.writeSettings(settings);
      }
    } else {
      settings.disabledSkills = list.filter(n => n !== skillName);
      await this.writeSettings(settings);
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/kernel/tests/skill-manager.test.ts`
Expected: 9/9 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/skill-manager.ts packages/kernel/tests/skill-manager.test.ts
git commit -m "feat(kernel): SkillManager 扫描/去重/目录管理/toggle"
```

---

## Task 3: kernel AgentManager.reloadAllSessions + WS 接入 + 启动注册

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `SkillManager`（from Task 2）、`AgentManager`
- Produces: `AgentManager.reloadAllSessions()`；WS handler 处理 skill 事件

- [ ] **Step 1: 给 AgentManager 加 reloadAllSessions 方法**

Modify `packages/kernel/src/agent-manager.ts`，在 `disposeAll()` 方法之后（约 272 行）加：

```ts
  /** reload 所有活跃会话（技能/provider 配置变更后调用，让新配置热生效） */
  async reloadAllSessions(): Promise<void> {
    for (const [id, session] of [...this.sessions.entries()]) {
      try {
        // SDK AgentSession.reload() 热重载 skills/extensions/prompts
        await (session as any).reload();
      } catch (err) {
        console.error(`[kernel] session ${id} reload 失败:`, err);
        // 单个失败不阻断其他会话
      }
    }
  }
```

- [ ] **Step 2: 修改 WSServerOpts + handle**

Modify `packages/kernel/src/ws-server.ts`：

顶部 import 加：
```ts
import type { SkillManager } from "./skill-manager";
```

`WSServerOpts` interface 加字段：
```ts
export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  providerStore: ProviderStore;
  skillManager: SkillManager;        // ← 新增
  agentManager: AgentManager;
  dataDir?: string;
  port?: number;
}
```

在 `handle()` 的 switch 末尾（provider case 之后）加 4 个 case：

```ts
      case "skill:list": {
        const result = await this.opts.skillManager.scan();
        reply({ type: "skill:list", ...result });
        break;
      }
      case "skill:toggle": {
        await this.opts.skillManager.toggleSkill(event.skillName, event.disabled);
        // reload 所有会话让禁用/启用热生效
        await this.opts.agentManager.reloadAllSessions();
        const result = await this.opts.skillManager.scan();
        this.broadcast({ type: "skill:changed", ...result });
        break;
      }
      case "skillDir:add": {
        try {
          await this.opts.skillManager.addDir(event.path);
          await this.opts.agentManager.reloadAllSessions();
          const result = await this.opts.skillManager.scan();
          this.broadcast({ type: "skill:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "skillDir:remove": {
        try {
          await this.opts.skillManager.removeDir(event.path);
          await this.opts.agentManager.reloadAllSessions();
          const result = await this.opts.skillManager.scan();
          this.broadcast({ type: "skill:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
```

- [ ] **Step 3: 修改 index.ts 启动装配**

Modify `packages/kernel/src/index.ts`：

顶部 import 加：
```ts
import { SkillManager } from "./skill-manager";
import { BUILTIN_SKILLS_DIR } from "@hiagent/shared";
import { mkdir } from "node:fs/promises";
```

在 `ensureIntercomInstalled()` 调用之后、`const configStore` 之前加：
```ts
  // 确保内置技能目录存在
  await mkdir(BUILTIN_SKILLS_DIR, { recursive: true });
```

在 `const providerStore = new ProviderStore();` 之后加：
```ts
  const skillManager = new SkillManager();
```

修改 `new WSServer({...})` 加入 skillManager：
```ts
  const server = new WSServer({
    configStore, projectStore,
    providerStore,
    skillManager,          // ← 新增
    agentManager: null as any,
    dataDir: HIAGENT_DIR,
    port: WS_PORT,
  });
```

- [ ] **Step 4: 修复现有 ws-server 测试构造参数**

Modify `packages/kernel/tests/ws-server.test.ts` 的 `withServer` helper，补 `skillManager` 参数。

顶部 import 加：
```ts
import { SkillManager } from "../src/skill-manager";
```

`withServer` 函数内加：
```ts
  const skillManager = new SkillManager(tmp("ws-skill-dir"));
```

`new WSServer({...})` 加：
```ts
    skillManager,
```

同样修改 `packages/kernel/tests/ws-provider.test.ts` 的 `withProviderServer`：补 `skillManager` 字段。

- [ ] **Step 5: 写 skill WS 集成测试**

Create `packages/kernel/tests/ws-skill.test.ts`:

```ts
import { test, expect } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { SkillManager } from "../src/skill-manager";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`);
}

function makeMockAgentManager() {
  const calls = { reloadAll: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    reloadAllSessions: async () => { calls.reloadAll++; },
    calls,
  } as any;
}

async function withSkillServer<T>(
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-skill");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    agentManager: mockAM,
    dataDir,
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

test("skill:list 返回技能列表 + 目录 + builtinDir", async () => {
  await withSkillServer(async (send, recv) => {
    send({ type: "skill:list" });
    const e = await recv() as any;
    expect(e.type).toBe("skill:list");
    expect(e.builtinDir).toContain("skills");
    expect(e.dirs).toContain(e.builtinDir);
  });
});

test("skillDir:add 成功后 reload 被调用 + 广播 changed", async () => {
  await withSkillServer(async (send, recv) => {
    const userDir = tmp("user-skills");
    mkdirSync(userDir, { recursive: true });
    send({ type: "skillDir:add", path: userDir });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.dirs).toContain(userDir);
  });
});

test("skillDir:add 不存在的路径返回 error", async () => {
  await withSkillServer(async (send, recv) => {
    send({ type: "skillDir:add", path: "/nonexistent/path" });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("目录不存在");
  });
});

test("skill:toggle 禁用后 skills 不含但 allSkills 含", async () => {
  await withSkillServer(async (send, recv) => {
    // 先确认有技能（通过扫描内置目录 — 这里可能为空，但 toggle 逻辑仍可测）
    send({ type: "skill:toggle", skillName: "fake-skill", disabled: true });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.disabledSkills).toContain("fake-skill");
  });
});

test("skillDir:remove 内置目录返回 error", async () => {
  await withSkillServer(async (send, recv) => {
    // 先拿 builtinDir
    send({ type: "skill:list" });
    const list = await recv() as any;
    send({ type: "skillDir:remove", path: list.builtinDir });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("内置目录不可删除");
  });
});
```

- [ ] **Step 6: 运行全部 kernel 测试确认通过**

Run: `bun test packages/kernel/tests/`
Expected: 全绿（含新增 ws-skill.test.ts 5 个 + 修改后的 ws-server.test.ts / ws-provider.test.ts 原有测试不受影响）

- [ ] **Step 7: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/ws-server.ts packages/kernel/src/index.ts packages/kernel/tests/ws-server.test.ts packages/kernel/tests/ws-provider.test.ts packages/kernel/tests/ws-skill.test.ts
git commit -m "feat(kernel): AgentManager.reloadAllSessions + skill WS 接入 + 启动注册"
```

---

## Task 4: 前端 skills store

**Files:**
- Create: `packages/frontend/src/store/skills.ts`
- Create: `packages/frontend/tests/store-skills.test.ts`

**Interfaces:**
- Consumes: `ws-instance` 的 `send`/`onMessage`、skill WS 事件类型
- Produces: `useSkillsStore`：skills/allSkills/dirs/disabledSkills/builtinDir + load/toggleSkill/addDir/removeDir

- [ ] **Step 1: 写失败测试**

Create `packages/frontend/tests/store-skills.test.ts`:

```ts
import { test, expect, beforeEach, mock } from "bun:test";
import { useSkillsStore } from "../src/store/skills";
import * as wsInstance from "../src/ws-instance";

const sendMock = mock();

beforeEach(() => {
  sendMock.mockClear();
  mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
});

test("load 发 skill:list", () => {
  useSkillsStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "skill:list" });
});

test("toggleSkill 发 skill:toggle", () => {
  useSkillsStore.getState().toggleSkill("brave-search");
  expect(sendMock).toHaveBeenCalledWith({ type: "skill:toggle", skillName: "brave-search", disabled: true });
});

test("toggleSkill 启用已禁用的技能", () => {
  useSkillsStore.setState({ disabledSkills: ["pdf-tools"] });
  useSkillsStore.getState().toggleSkill("pdf-tools");
  expect(sendMock).toHaveBeenCalledWith({ type: "skill:toggle", skillName: "pdf-tools", disabled: false });
});

test("addDir 发 skillDir:add", () => {
  useSkillsStore.getState().addDir("/path/to/skills");
  expect(sendMock).toHaveBeenCalledWith({ type: "skillDir:add", path: "/path/to/skills" });
});

test("removeDir 发 skillDir:remove", () => {
  useSkillsStore.getState().removeDir("/path/to/skills");
  expect(sendMock).toHaveBeenCalledWith({ type: "skillDir:remove", path: "/path/to/skills" });
});

test("setAll 更新本地状态", () => {
  useSkillsStore.getState().setAll({
    type: "skill:list",
    skills: [{ name: "a", description: "desc" }],
    allSkills: [{ name: "a", description: "desc" }],
    dirs: ["/builtin", "/user"],
    disabledSkills: [],
    builtinDir: "/builtin",
  });
  expect(useSkillsStore.getState().skills).toHaveLength(1);
  expect(useSkillsStore.getState().builtinDir).toBe("/builtin");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/frontend/tests/store-skills.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 skills store**

Create `packages/frontend/src/store/skills.ts`:

```ts
import { create } from "zustand";
import type { SkillInfo, SkillListResult, SkillChangedEvent } from "@hiagent/shared";
import { send } from "../ws-instance";

interface SkillsState {
  skills: SkillInfo[];           // 已启用的技能
  allSkills: SkillInfo[];        // 全部技能（含禁用）
  dirs: string[];                // 技能目录列表（含内置）
  disabledSkills: string[];      // 被禁用的技能名
  builtinDir: string;            // 内置目录路径
  loading: boolean;
  load: () => void;
  setAll: (data: SkillListResult | SkillChangedEvent) => void;
  toggleSkill: (skillName: string) => void;   // 自动判断当前状态切换
  addDir: (path: string) => void;
  removeDir: (path: string) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  allSkills: [],
  dirs: [],
  disabledSkills: [],
  builtinDir: "",
  loading: false,
  load: () => send({ type: "skill:list" }),
  setAll: (data) => set({
    skills: data.skills,
    allSkills: data.allSkills,
    dirs: data.dirs,
    disabledSkills: data.disabledSkills,
    builtinDir: data.builtinDir,
    loading: false,
  }),
  toggleSkill: (skillName) => {
    // 当前已禁用 → 启用；当前启用 → 禁用
    const isDisabled = get().disabledSkills.includes(skillName);
    send({ type: "skill:toggle", skillName, disabled: !isDisabled });
  },
  addDir: (path) => send({ type: "skillDir:add", path }),
  removeDir: (path) => send({ type: "skillDir:remove", path }),
}));
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test packages/frontend/tests/store-skills.test.ts`
Expected: 6/6 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/store/skills.ts packages/frontend/tests/store-skills.test.ts
git commit -m "feat(frontend): skills Zustand store"
```

---

## Task 5: SkillSection 组件 + 接线

**Files:**
- Create: `packages/frontend/src/components/settings/SkillSection.tsx`
- Create: `packages/frontend/tests/SkillSection.test.tsx`
- Modify: `packages/frontend/src/store/settings.ts`
- Modify: `packages/frontend/src/components/SettingsModal.tsx`
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useSkillsStore`（from Task 4）、`DirTreePicker`、`settings store`
- Produces: `<SkillSection />` 组件；SettingsModal 左侧导航加「技能」

- [ ] **Step 1: 修改 settings store 支持多 section**

Modify `packages/frontend/src/store/settings.ts`，把 `activeSection` 加入（如果供应商管理计划已加则跳过）：

```ts
import { create } from "zustand";

interface SettingsState {
  showSettings: boolean;
  activeSection: "models" | "skills";
  open: () => void;
  close: () => void;
  setSection: (s: "models" | "skills") => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  showSettings: false,
  activeSection: "models",
  open: () => set({ showSettings: true }),
  close: () => set({ showSettings: false }),
  setSection: (s) => set({ activeSection: s }),
}));
```

- [ ] **Step 2: 写 SkillSection 失败测试**

Create `packages/frontend/tests/SkillSection.test.tsx`:

```tsx
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "../src/components/settings/SkillSection";
import { useSkillsStore } from "../src/store/skills";

beforeEach(() => {
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "/home/.hiagent/skills", loading: false,
  });
});

test("渲染技能目录折叠态 + 已加载技能标题", () => {
  render(<SkillSection />);
  expect(screen.getByText(/技能目录/)).toBeTruthy();
  expect(screen.getByText("/home/.hiagent/skills")).toBeTruthy();  // 折叠态显示内置目录
  expect(screen.getByText("已加载技能")).toBeTruthy();
});

test("点击技能目录展开显示目录列表", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.getByText("/home/.claude/skills")).toBeTruthy();
  expect(screen.getByText("添加技能目录")).toBeTruthy();
});

test("内置目录无删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.queryByTestId("skill-dir-remove-/home/.hiagent/skills")).toBeNull();
});

test("用户目录有删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.getByTestId("skill-dir-remove-/home/.claude/skills")).toBeTruthy();
});

test("技能列表渲染 + checkbox toggle", () => {
  const toggleMock = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索" },
      { name: "pdf-tools", description: "PDF 处理" },
    ],
    disabledSkills: ["pdf-tools"],
    toggleSkill: toggleMock,
  });
  render(<SkillSection />);
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.getByText("pdf-tools")).toBeTruthy();
  // pdf-tools 被禁用 → checkbox 未勾选
  const pdfCheckbox = screen.getByTestId("skill-checkbox-pdf-tools") as HTMLInputElement;
  expect(pdfCheckbox.checked).toBe(false);
  // 点击启用
  fireEvent.click(pdfCheckbox);
  expect(toggleMock).toHaveBeenCalledWith("pdf-tools");
});

test("点击添加技能目录弹出 DirTreePicker", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  fireEvent.click(screen.getByTestId("skill-add-dir-btn"));
  expect(screen.getByTestId("dir-tree-picker")).toBeTruthy();
});
```

- [ ] **Step 3: 运行确认失败**

Run: `bun test packages/frontend/tests/SkillSection.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 SkillSection**

Create `packages/frontend/src/components/settings/SkillSection.tsx`:

```tsx
import { useState } from "react";
import { useSkillsStore } from "../../store/skills";
import { DirTreePicker } from "../DirTreePicker";

export function SkillSection() {
  const { allSkills, dirs, disabledSkills, builtinDir, toggleSkill, addDir, removeDir } = useSkillsStore();
  const [dirExpanded, setDirExpanded] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto">
      {/* 技能目录（上方，默认折叠） */}
      <div className="flex flex-col gap-1">
        <button
          onClick={() => setDirExpanded(!dirExpanded)}
          className="flex items-center gap-2 text-sm text-primary text-left"
          data-testid="skill-dir-toggle"
        >
          <span>技能目录：{builtinDir}</span>
          <span>{dirExpanded ? "▾" : "▸"}</span>
        </button>

        {dirExpanded && (
          <div className="flex flex-col gap-1 pl-4">
            {dirs.map(dir => (
              <div key={dir} className="flex items-center justify-between py-1">
                <span className="text-sm text-secondary">{dir}</span>
                {dir === builtinDir ? (
                  <span className="text-xs text-tertiary">[内置]</span>
                ) : (
                  <button
                    onClick={() => removeDir(dir)}
                    className="text-xs text-secondary hover:text-danger"
                    data-testid={`skill-dir-remove-${dir}`}
                  >删除</button>
                )}
              </div>
            ))}
            <button
              onClick={() => setShowDirPicker(true)}
              className="self-start px-2 py-1 text-xs text-secondary border border-hairline rounded-sm hover:text-primary mt-1"
              data-testid="skill-add-dir-btn"
            >+ 添加技能目录</button>
          </div>
        )}
      </div>

      {/* 已加载技能（下方） */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">已加载技能</span>
        {allSkills.length === 0 && (
          <span className="text-sm text-tertiary py-2">暂无技能，添加技能目录后自动扫描</span>
        )}
        {allSkills.map(skill => {
          const disabled = disabledSkills.includes(skill.name);
          return (
            <label
              key={skill.name}
              className="flex items-center gap-2 py-1 cursor-pointer"
              style={{ opacity: disabled ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={!disabled}
                onChange={() => toggleSkill(skill.name)}
                data-testid={`skill-checkbox-${skill.name}`}
                className="cursor-pointer"
              />
              <span className="text-sm text-primary">{skill.name}</span>
              <span className="text-xs text-tertiary">— {skill.description}</span>
              {disabled && <span className="text-xs" style={{ color: "var(--danger)" }}>[禁用]</span>}
            </label>
          );
        })}
      </div>

      {/* 添加目录选择器 */}
      {showDirPicker && (
        <DirTreePicker
          onPick={(path) => { addDir(path); setShowDirPicker(false); }}
          onCancel={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: 修改 SettingsModal 加技能菜单**

Modify `packages/frontend/src/components/SettingsModal.tsx`：

顶部 import 加：
```tsx
import { useSettingsStore } from "../store/settings";
import { SkillSection } from "./settings/SkillSection";
```

左侧导航从单项改多项（在现有「模型管理」之后加「技能」）：

```tsx
export function SettingsModal({ onClose }: Props) {
  const activeSection = useSettingsStore(s => s.activeSection);
  const setSection = useSettingsStore(s => s.setSection);

  return (
    <Modal onClose={onClose} width={900} data-testid="settings-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-base">系统设置</span>
      </div>
      <div className="flex" style={{ minHeight: 500, maxHeight: "75vh" }}>
        <nav className="w-40 border-r border-hairline p-2 flex flex-col gap-1">
          <button
            onClick={() => setSection("models")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "models"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
          >模型管理</button>
          <button
            onClick={() => setSection("skills")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "skills"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
          >技能</button>
        </nav>
        <div className="flex-1 overflow-auto">
          {activeSection === "models" && <ProviderSection />}
          {activeSection === "skills" && <SkillSection />}
        </div>
      </div>
    </Modal>
  );
}
```

> **注意**：如果供应商管理计划还没把 `<ProviderSection />` 条件渲染加进去，这里需确保 `activeSection === "models"` 渲染 ProviderSection。具体 import `ProviderSection` 的路径取决于供应商管理计划已实现的结构。

- [ ] **Step 6: 修改 App.tsx 路由 skill 事件**

Modify `packages/frontend/src/App.tsx`：

顶部 import 加：
```ts
import { useSkillsStore } from "./store/skills";
```

在 `onMessage` 的 switch 里（provider case 之后）加：
```ts
        case "skill:list": useSkillsStore.getState().setAll(e); break;
        case "skill:changed": useSkillsStore.getState().setAll(e); break;
```

- [ ] **Step 7: 运行组件测试确认通过**

Run: `bun test packages/frontend/tests/SkillSection.test.tsx packages/frontend/tests/store-skills.test.ts`
Expected: 全绿

- [ ] **Step 8: 运行全部前端测试确认无回归**

Run: `cd packages/frontend && bun test`
Expected: 全绿

- [ ] **Step 9: 提交**

```bash
git add packages/frontend/src/components/settings/SkillSection.tsx packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx packages/frontend/src/App.tsx packages/frontend/tests/SkillSection.test.tsx
git commit -m "feat(frontend): SkillSection 组件 + SettingsModal 技能菜单 + App 路由"
```

---

## Task 6: E2E 测试 + CHANGELOG

**Files:**
- Create: `packages/frontend/e2e/skills.spec.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 写 E2E spec**

Create `packages/frontend/e2e/skills.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

test.describe.serial("技能管理", () => {

  test("打开设置 → 技能菜单", async ({ page }) => {
    await page.goto("/");
    // 预置项目（复用 app-flow 模式）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    // 切到技能菜单
    await page.getByText("技能").click();
    await expect(page.getByText("技能目录")).toBeVisible();
    await expect(page.getByText("已加载技能")).toBeVisible();
  });

  test("展开技能目录 + 内置目录无删除按钮", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能").click();
    await page.getByTestId("skill-dir-toggle").click();

    // 内置目录行存在且有 [内置] 标签
    await expect(page.getByText("[内置]")).toBeVisible({ timeout: 5000 });
  });

  test("禁用技能 + 启用技能", async ({ page }) => {
    // 先通过 WS 添加一个带技能的目录，让技能列表有内容
    const e2eSkillDir = join(process.env.HOME || "~", ".hiagent-e2e-skills-test");
    if (!existsSync(e2eSkillDir)) {
      const skillDir = join(e2eSkillDir, "test-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"),
        `---\nname: test-skill\ndescription: 测试技能\n---\n# test-skill`);
    }

    await page.goto("/");
    await page.evaluate(async (skillDir) => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: "skillDir:add", path: skillDir }));
      await new Promise(r => setTimeout(r, 500));
      ws.close();
    }, e2eSkillDir);

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能").click();

    // 等待技能出现
    await expect(page.getByText("test-skill")).toBeVisible({ timeout: 5000 });

    // 禁用
    await page.getByTestId("skill-checkbox-test-skill").uncheck();
    await expect(page.getByText("[禁用]")).toBeVisible({ timeout: 5000 });

    // 启用
    await page.getByTestId("skill-checkbox-test-skill").check();
    await expect(page.getByText("[禁用]")).toHaveCount(0, { timeout: 5000 });

    // 清理：删除测试目录
    await page.evaluate(async (skillDir) => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "skillDir:remove", path: skillDir }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    }, e2eSkillDir);
    rmSync(e2eSkillDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行 E2E**

Run: `cd packages/frontend && bun run e2e -- --grep "技能管理"`
Expected: 3/3 PASS

**截图清理**：E2E 完成后删除所有测试截图：
Run: `find packages/frontend -name "*.png" -path "*screenshot*" -delete 2>/dev/null; find packages/frontend -name "test-*.png" -delete 2>/dev/null`

- [ ] **Step 3: 更新 CHANGELOG**

Modify `CHANGELOG.md`，在顶部加：

```markdown
## 2026-07-09 — 技能管理

- **类型**：新增功能
- **摘要**：系统设置页新增「技能」菜单。支持管理技能加载目录（内置 `~/.hiagent/skills/` 不可删 + 用户自定义目录增删）、查看已加载技能列表、单独启用/禁用技能。同名技能去重（内置优先）。配置变更后自动 reload 所有活跃会话热生效。
- **影响范围**：`shared/src/skills.ts`（新增类型+WS事件）、`shared/src/constants.ts`（BUILTIN_SKILLS_DIR）、`shared/src/types.ts`（WS联合扩展）、`kernel/src/skill-manager.ts`（扫描/去重/目录管理/toggle）、`kernel/src/agent-manager.ts`（reloadAllSessions）、`kernel/src/ws-server.ts`+`index.ts`（WS接入+启动注册）、`frontend/src/store/skills.ts`、`frontend/src/components/settings/SkillSection.tsx`、`frontend/src/store/settings.ts`（activeSection扩展）、`frontend/src/components/SettingsModal.tsx`、`frontend/src/App.tsx`
```

- [ ] **Step 4: 提交**

```bash
git add packages/frontend/e2e/skills.spec.ts CHANGELOG.md
git commit -m "test(e2e): 技能管理完整流程 + CHANGELOG"
```

---

## 验收清单

实现完成后，逐层验证：

- [ ] **第一层（单元）**：`bun test packages/kernel/tests/skill-manager.test.ts` 全绿
- [ ] **第二层（组件）**：`cd packages/frontend && bun test` 全绿（SkillSection/store-skills）
- [ ] **第三层（API）**：`bun test packages/kernel/tests/ws-skill.test.ts` 全绿
- [ ] **第四层（E2E）**：`cd packages/frontend && bun run e2e -- --grep "技能管理"` 全绿
- [ ] **截图清理**：项目内无测试残留截图
- [ ] **CHANGELOG**：已记录
- [ ] **typecheck**：`cd packages/shared && bunx tsc --noEmit` 无错误
