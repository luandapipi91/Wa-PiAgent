# Quick Invoke 聊天栏快速调用 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ComposerInput 聊天输入框中，通过 `@` 和 `$` 触发符快速调用项目文件和技能，选中的文件/技能以内联 chip 形式插入消息，发送时展开为纯文本引用标记。

**Architecture:** 后端新增扩展包技能发现能力（extension-manager → skill-manager → agent-manager），前端将原生 `<textarea>` 改为 contenteditable div 支持 chip 内联渲染，新增 QuickInvokeMenu 弹出面板。ComposerTextarea 采用半受控模式解决 contenteditable + React 光标冲突。

**Tech Stack:** TypeScript, React 19, Bun (test runner), @testing-library/react, happy-dom, zustand, WebSocket

## Global Constraints

- **语言**：所有代码注释使用中文；向用户解释时使用中文
- **测试框架**：前端用 `bun:test` + `@testing-library/react` + happy-dom（**不是 vitest**）；后端用 `bun:test` + 真实文件系统临时目录
- **测试配置**：前端 `bunfig.toml` 预加载 `./tests/happydom-setup.ts`，`pathIgnorePatterns = ["**/e2e/**"]`
- **CSS 设计语言**：遵循 DESIGN.md（HiAgent Light 浅色主题），chip 颜色：`@文件` 橙色 `#EB933E`，`$技能` 靛蓝 `#5B5BD6`
- **模块 mock**：前端测试用 `mock.module("../src/ws-instance", ...)` 而非 `vi.mock`，mock 必须在组件 import 之前
- **store 重置**：前端测试 `beforeEach` 中用 `useXxxStore.setState({...})` 重置 zustand 状态
- **WS 事件类型**：所有新增事件类型需加入 `packages/shared/src/types.ts` 的 `WSClientEvent` / `WSServerEvent` 联合类型
- **提交规范**：每个任务完成后提交，commit message 格式 `feat: xxx` / `fix: xxx` / `refactor: xxx`
- **CHANGELOG**：所有任务完成后更新根目录 `CHANGELOG.md`（新条目加在顶部）

---

## 文件结构

### 后端（packages/kernel）

| 文件 | 操作 | 职责 |
|------|------|------|
| `packages/shared/src/skills.ts` | 修改 | `SkillInfo` 增加 `source` 字段 |
| `packages/kernel/src/skill-utils.ts` | **新建** | 从 skill-manager 提取的共享函数：`hasSkillMd` / `scanSkillsDir` / `parseSkillFrontmatter` |
| `packages/kernel/src/skill-manager.ts` | 修改 | 从 skill-utils 导入共享函数；`scan()` 接受扩展技能路径参数；标记 source |
| `packages/kernel/src/extension-manager.ts` | 修改 | 新增 `getEnabledExtensionSkillPaths()` 方法 |
| `packages/kernel/src/ws-server.ts` | 修改 | 4 处 `skillManager.scan()` 调用前获取扩展技能路径 |
| `packages/kernel/src/agent-manager.ts` | 修改 | `resolveEnabledSkillPaths` 合并扩展技能路径 |

### 前端（packages/frontend）

| 文件 | 操作 | 职责 |
|------|------|------|
| `packages/frontend/src/quick-invoke/tokens.ts` | **新建** | chip token 序列化/反序列化纯函数 |
| `packages/frontend/src/quick-invoke/trigger.ts` | **新建** | 触发符检测纯函数（正则匹配 + 过滤逻辑） |
| `packages/frontend/src/components/ui/ComposerTextarea.tsx` | **新建** | contenteditable div，chip 内联渲染 + 光标管理 |
| `packages/frontend/src/components/ui/QuickInvokeMenu.tsx` | **新建** | 统一弹出面板（文件列表 + 技能列表） |
| `packages/frontend/src/components/ui/ComposerInput.tsx` | 修改 | 集成触发检测 + 面板状态 + chip 管理 |

### 测试

| 文件 | 操作 |
|------|------|
| `packages/frontend/tests/tokens.test.ts` | **新建** |
| `packages/frontend/tests/trigger.test.ts` | **新建** |
| `packages/frontend/tests/ComposerTextarea.test.tsx` | **新建** |
| `packages/frontend/tests/QuickInvokeMenu.test.tsx` | **新建** |
| `packages/kernel/tests/skill-utils.test.ts` | **新建** |
| `packages/kernel/tests/extension-manager.test.ts` | 修改（新增测试用例） |
| `packages/kernel/tests/skill-manager.test.ts` | 修改（新增测试用例） |
| `packages/frontend/tests/ComposerInput.test.tsx` | 修改（新增 quick invoke 测试） |

---

## 任务依赖图

```
Task 1 (共享类型 + skill-utils 提取)
  ├── Task 2 (extension-manager + skill-manager 扩展技能扫描)
  │     └── Task 3 (agent-manager additionalSkillPaths 合并)
  └── Task 4 (前端 token + 触发检测纯函数)
        ├── Task 5 (ComposerTextarea)
        │     └── Task 7 (ComposerInput 集成) ← 依赖 Task 6
        └── Task 6 (QuickInvokeMenu)
              └── Task 7
Task 8 (E2E + CHANGELOG) ← 依赖全部
```

Task 1-3（后端）和 Task 4-6（前端基础）可并行开发。Task 7 是集成点。

---

## Task 1: 共享类型扩展 + skill-utils 提取

**目标：** `SkillInfo` 增加 `source` 字段；从 `skill-manager.ts` 提取 `hasSkillMd` / `scanSkillsDir` / `parseSkillFrontmatter` 到共享模块 `skill-utils.ts`。

**Files:**
- Modify: `packages/shared/src/skills.ts:1-8`
- Create: `packages/kernel/src/skill-utils.ts`
- Modify: `packages/kernel/src/skill-manager.ts`（删除已提取的函数，改为从 skill-utils 导入）
- Test: `packages/kernel/tests/skill-utils.test.ts`

**Interfaces:**
- Produces: `SkillInfo.source` 字段（`{ type: "builtin" | "project" | "user" | "extension"; name?: string }`）
- Produces: `skill-utils.ts` 导出 `parseSkillFrontmatter` / `scanSkillsDir` / `hasSkillMd`（签名不变，`scanSkillsDir` 新增可选 `source` 参数）

- [ ] **Step 1: 修改 SkillInfo 类型，增加 source 字段**

修改 `packages/shared/src/skills.ts`：

```ts
// ===== 技能管理类型定义 =====

/** 技能来源类型 */
export type SkillSourceType = "builtin" | "project" | "user" | "extension";

/** 技能来源信息 */
export interface SkillSource {
  type: SkillSourceType;
  /** 扩展来源时为包名，其余无 */
  name?: string;
}

/** 技能信息（从 SKILL.md frontmatter 提取的最小集） */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;        // skill 目录绝对路径（含 SKILL.md 的目录），用于喂给 SDK additionalSkillPaths
  source?: SkillSource; // 技能来源（builtin/user/extension），供前端展示来源标签
}
```

- [ ] **Step 2: 创建 skill-utils.ts，从 skill-manager.ts 提取函数**

创建 `packages/kernel/src/skill-utils.ts`，把 `skill-manager.ts` 中的以下内容**移动**过来（代码不变，仅改变位置）：
- 常量：`MAX_DEPTH` / `MAX_PER_DIR` / `MAX_TOTAL_ENTRIES` / `SKILL_SCAN_TIMEOUT_MS` / `ADD_DIR_TIMEOUT_MS` / `ADD_DIR_VALIDATION_MAX_ENTRIES` / `ADD_DIR_NON_SKILL_THRESHOLD` / `EXCLUDED_DIRS`
- 类：`ScanTimeoutError`
- 函数：`withTimeout` / `parseSkillFrontmatter` / `scanSkillsDir` / `hasSkillMd`

`scanSkillsDir` 签名变更——新增可选 `source` 参数：

```ts
import { readFile, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo, SkillSource } from "@hiagent/shared";

/** 递归扫描最大深度（skill-dir / skill-name / SKILL.md = 3 层） */
export const MAX_DEPTH = 3;
/** 单层目录最多遍历条目数 */
export const MAX_PER_DIR = 200;
/** 全量扫描最多访问的条目总数 */
export const MAX_TOTAL_ENTRIES = 5000;
/** 单个技能目录扫描超时（毫秒） */
export const SKILL_SCAN_TIMEOUT_MS = 8_000;
/** 添加目录时快速验证超时（毫秒） */
export const ADD_DIR_TIMEOUT_MS = 3_000;
/** 添加目录时快速验证最多访问条目数 */
export const ADD_DIR_VALIDATION_MAX_ENTRIES = 1_000;
/** 非技能目录判定阈值：验证完该数量条目仍未找到 SKILL.md 则拒绝 */
export const ADD_DIR_NON_SKILL_THRESHOLD = 30;

/** 扫描时跳过的常见大目录/构建产物目录 */
export const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  "vendor", ".venv", "__pycache__", ".cache", ".turbo", ".idea", ".vscode",
  "Pods", ".gradle", ".svelte-kit", ".nuxt", ".output",
]);

export class ScanTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, context?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new ScanTimeoutError(context ?? `操作超时（${ms}ms）`));
      }, ms);
    }),
  ]);
}

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name 和 description。
 */
export function parseSkillFrontmatter(content: string, dir: string): SkillInfo | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) return null;
  return { name, description: desc ?? "", path: dir };
}

/**
 * 轻量异步递归扫描指定目录，查找 SKILL.md 并解析 frontmatter。
 * @param source 可选来源标记，写入每个 SkillInfo.source
 */
export async function scanSkillsDir(
  dir: string,
  source?: SkillSource,
): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  let totalEntries = 0;

  async function walk(currentDir: string, depth: number) {
    if (depth > MAX_DEPTH || totalEntries >= MAX_TOTAL_ENTRIES) return;

    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(currentDir);
    } catch {
      return;
    }

    try {
      let inspected = 0;
      for await (const entry of handle) {
        if (totalEntries >= MAX_TOTAL_ENTRIES) break;
        inspected++;
        if (inspected > MAX_PER_DIR) break;
        totalEntries++;

        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (EXCLUDED_DIRS.has(name)) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(currentDir, name);
        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          const info = parseSkillFrontmatter(content, fullPath);
          if (info) {
            if (source) info.source = source;
            skills.push(info);
            continue;
          }
        } catch {
          // 没有 SKILL.md，继续递归
        }
        await walk(fullPath, depth + 1);
      }
    } catch {
      // 目录在扫描过程中被删除或权限变化，直接跳过
    } finally {
      try { await handle.close(); } catch {}
    }
  }

  await walk(dir, 1);
  return skills;
}

/**
 * 快速判断一个目录是否像技能目录（自身或子目录包含 SKILL.md）。
 */
export async function hasSkillMd(dir: string): Promise<{ found: boolean; inspectedCount: number }> {
  let found = false;
  let inspectedCount = 0;

  try {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    if (parseSkillFrontmatter(content, dir)) {
      return { found: true, inspectedCount: 0 };
    }
  } catch {}

  async function walk(currentDir: string, depth: number) {
    if (found) return;
    if (depth > MAX_DEPTH) return;
    if (inspectedCount >= ADD_DIR_VALIDATION_MAX_ENTRIES) return;

    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try { handle = await opendir(currentDir); } catch { return; }

    try {
      let inspectedInDir = 0;
      for await (const entry of handle) {
        if (found) break;
        if (inspectedCount >= ADD_DIR_VALIDATION_MAX_ENTRIES) break;
        inspectedInDir++;
        if (inspectedInDir > MAX_PER_DIR) break;
        inspectedCount++;

        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (EXCLUDED_DIRS.has(name)) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(currentDir, name);
        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          if (parseSkillFrontmatter(content, fullPath)) { found = true; break; }
        } catch {}

        await walk(fullPath, depth + 1);
      }
    } catch {}
    finally { try { await handle.close(); } catch {} }
  }

  await walk(dir, 1);
  return { found, inspectedCount };
}
```

- [ ] **Step 3: 修改 skill-manager.ts，从 skill-utils 导入**

修改 `packages/kernel/src/skill-manager.ts`：

1. **删除**已移动到 skill-utils.ts 的代码（常量、`ScanTimeoutError`、`withTimeout`、`parseSkillFrontmatter`、`scanSkillsDir`、`hasSkillMd`、`EXCLUDED_DIRS`）
2. **添加导入**：

```ts
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo, SkillSource } from "@hiagent/shared";
import {
  withTimeout, hasSkillMd, scanSkillsDir,
  SKILL_SCAN_TIMEOUT_MS, ADD_DIR_TIMEOUT_MS, ADD_DIR_NON_SKILL_THRESHOLD,
  ScanTimeoutError,
} from "./skill-utils";

/** settings.json 中与技能相关的字段 */
interface SkillSettings {
  userSkillDirs?: string[];
  disabledSkills?: string[];
  [k: string]: unknown;
}
```

3. **修改 `scan()` 方法**——接受可选扩展技能路径参数：

```ts
  /**
   * 扫描所有技能目录，返回去重 + 禁用过滤后的技能列表。
   * @param extensionSkillPaths 扩展包技能路径列表（由 extension-manager.getEnabledExtensionSkillPaths 提供）
   */
  async scan(
    extensionSkillPaths: { path: string; packageName: string }[] = [],
  ): Promise<ScanResult> {
    const settings = await this.readSettings();
    const userDirs = settings.userSkillDirs ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];

    // 内置目录
    try {
      const list = await withTimeout(
        scanSkillsDir(this.builtinDir, { type: "builtin" }),
        SKILL_SCAN_TIMEOUT_MS,
        `扫描目录超时: ${this.builtinDir}`,
      );
      for (const skill of list) {
        if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[skill-manager] 扫描目录失败或超时，已跳过: ${this.builtinDir} (${reason})`);
    }

    // 用户目录
    for (const dir of userDirs) {
      try {
        const list = await withTimeout(
          scanSkillsDir(dir, { type: "user" }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描目录超时: ${dir}`,
        );
        for (const skill of list) {
          if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[skill-manager] 扫描目录失败或超时，已跳过: ${dir} (${reason})`);
      }
    }

    // 扩展技能目录
    for (const ext of extensionSkillPaths) {
      try {
        const list = await withTimeout(
          scanSkillsDir(ext.path, { type: "extension", name: ext.packageName }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描扩展技能目录超时: ${ext.path}`,
        );
        for (const skill of list) {
          if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[skill-manager] 扫描扩展技能目录失败或超时，已跳过: ${ext.path} (${reason})`);
      }
    }

    // 过滤禁用技能
    const skills = allSkills.filter(s => !disabledSkills.includes(s.name));
    const dirs = [this.builtinDir, ...userDirs];

    return { skills, allSkills, dirs, disabledSkills, builtinDir: this.builtinDir };
  }
```

注意：`ScanResult` 接口不变（`skills` / `allSkills` 已含 `source` 字段，因为 `SkillInfo` 新增了可选 `source`）。

- [ ] **Step 4: 写 skill-utils 单元测试**

创建 `packages/kernel/tests/skill-utils.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter, scanSkillsDir, hasSkillMd } from "../src/skill-utils";

function tmpDir() {
  const dir = join(import.meta.dir, ".tmp-skill-utils-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n内容`);
}

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("parseSkillFrontmatter 提取 name 和 description", () => {
  const info = parseSkillFrontmatter(
    "---\nname: my-skill\ndescription: 测试技能\n---\n# body",
    "/skills/my-skill",
  );
  expect(info).toEqual({ name: "my-skill", description: "测试技能", path: "/skills/my-skill" });
});

test("parseSkillFrontmatter 无 frontmatter 返回 null", () => {
  expect(parseSkillFrontmatter("just text", "/x")).toBeNull();
});

test("scanSkillsDir 扫描并标记 source", async () => {
  createSkill(dir, "alpha", "技能 A");
  createSkill(dir, "beta", "技能 B");
  const result = await scanSkillsDir(dir, { type: "extension", name: "pkg-x" });
  expect(result).toHaveLength(2);
  expect(result.every(s => s.source?.type === "extension")).toBe(true);
  expect(result.every(s => s.source?.name === "pkg-x")).toBe(true);
});

test("scanSkillsDir 无 source 参数时 SkillInfo 不含 source", async () => {
  createSkill(dir, "alpha", "技能 A");
  const result = await scanSkillsDir(dir);
  expect(result[0].source).toBeUndefined();
});

test("hasSkillMd 目录含 SKILL.md 返回 found", async () => {
  createSkill(dir, "alpha", "技能 A");
  const result = await hasSkillMd(dir);
  expect(result.found).toBe(true);
});

test("hasSkillMd 空目录返回 not found", async () => {
  const result = await hasSkillMd(dir);
  expect(result.found).toBe(false);
});
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd packages/kernel && bun test tests/skill-utils.test.ts -v`
Expected: 6 tests PASS

Run: `cd packages/kernel && bun test tests/skill-manager.test.ts -v`
Expected: 全部 PASS（确认提取后 skill-manager 测试未破坏）

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/skills.ts packages/kernel/src/skill-utils.ts packages/kernel/src/skill-manager.ts packages/kernel/tests/skill-utils.test.ts
git commit -m "refactor: 提取 skill-utils 共享模块 + SkillInfo 增加 source 字段"
```

---

## Task 2: extension-manager + skill-manager 扩展技能扫描集成

**目标：** `extension-manager` 新增 `getEnabledExtensionSkillPaths()` 方法；`ws-server.ts` 4 处 `scan()` 调用前获取扩展技能路径。

**Files:**
- Modify: `packages/kernel/src/extension-manager.ts`（新增方法）
- Modify: `packages/kernel/src/ws-server.ts:593-631`（4 处 scan 调用）
- Test: `packages/kernel/tests/extension-manager.test.ts`（新增测试用例）

**Interfaces:**
- Consumes: `hasSkillMd` from `./skill-utils` (Task 1)
- Produces: `ExtensionManager.getEnabledExtensionSkillPaths(): Promise<{ path: string; packageName: string }[]>`

- [ ] **Step 1: 写失败测试 — extension-manager.getEnabledExtensionSkillPaths**

在 `packages/kernel/tests/extension-manager.test.ts` 末尾新增：

```ts
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HIAGENT_DIR } from "@hiagent/shared";

// 辅助：在扩展 runtime 目录下创建带 skills/ 的包结构
function createExtSkillPackage(pkgName: string, skillName: string) {
  const pkgDir = join(HIAGENT_DIR, "runtime", "node_modules", pkgName);
  const skillsDir = join(pkgDir, "skills");
  mkdirSync(join(skillsDir, skillName), { recursive: true });
  writeFileSync(join(skillsDir, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ext skill\n---\n# ${skillName}`);
}

test("getEnabledExtensionSkillPaths 返回含 SKILL.md 的扩展技能路径", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);

  // 先安装一个 npm 包（mock）
  await mgr.install("my-ext-pkg");

  // 创建扩展技能目录结构
  createExtSkillPackage("my-ext-pkg", "ext-tool");

  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(1);
  expect(paths[0].packageName).toBe("my-ext-pkg");
  expect(paths[0].path).toContain("my-ext-pkg/skills");

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "my-ext-pkg"), { recursive: true, force: true });
});

test("getEnabledExtensionSkillPaths 跳过无 skills/ 的扩展", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);
  await mgr.install("no-skill-pkg");

  // 不创建 skills/ 目录
  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(0);

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "no-skill-pkg"), { recursive: true, force: true });
});

test("getEnabledExtensionSkillPaths 不返回已禁用的扩展", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);
  await mgr.install("disabled-pkg");
  await mgr.disable("disabled-pkg");

  createExtSkillPackage("disabled-pkg", "some-skill");

  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(0);

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "disabled-pkg"), { recursive: true, force: true });
});
```

注意：测试中 `tmpDir()` 和 `mockManager()` 是该文件已有的辅助函数，直接复用。`HIAGENT_DIR` 导入需加到文件顶部。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/kernel && bun test tests/extension-manager.test.ts -v`
Expected: 3 个新测试 FAIL（`getEnabledExtensionSkillPaths is not a function`）

- [ ] **Step 3: 实现 getEnabledExtensionSkillPaths**

在 `packages/kernel/src/extension-manager.ts` 中：

1. 添加导入（文件顶部已有的 import 区域）：

```ts
import { hasSkillMd } from "./skill-utils";
```

2. 在 `ExtensionManager` 类中（`disable` 方法之后、类结束之前）新增方法：

```ts
  /**
   * 获取已启用扩展包中包含技能（SKILL.md）的 skills/ 目录路径列表。
   * 入口处用 hasSkillMd 做快速过滤，只返回通过检测的路径。
   * 供 skill-manager.scan() 扫描 + agent-manager additionalSkillPaths 两处消费。
   */
  async getEnabledExtensionSkillPaths(): Promise<{ path: string; packageName: string }[]> {
    const { packages } = await this.list();
    const enabled = packages.filter(p => p.enabled);
    const result: { path: string; packageName: string }[] = [];
    for (const pkg of enabled) {
      const skillsDir = join(HIAGENT_DIR, "runtime", "node_modules", pkg.name, "skills");
      try {
        const { found } = await hasSkillMd(skillsDir);
        if (found) result.push({ path: skillsDir, packageName: pkg.name });
      } catch {
        // 目录不存在或无法访问 -> 跳过
      }
    }
    return result;
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages/kernel && bun test tests/extension-manager.test.ts -v`
Expected: 全部 PASS

- [ ] **Step 5: 修改 ws-server.ts，4 处 scan 调用前获取扩展技能路径**

在 `packages/kernel/src/ws-server.ts` 中，`WsServer` 类内部新增一个私有辅助方法（放在消息处理方法附近）：

```ts
  /** 获取扩展技能路径并调用 skillManager.scan，避免每处重复获取 */
  private async scanSkillsWithExtensions() {
    const extPaths = this.opts.extensionManager
      ? await this.opts.extensionManager.getEnabledExtensionSkillPaths()
      : [];
    return this.opts.skillManager.scan(extPaths);
  }
```

然后修改 4 处调用（skill:list / skill:toggle / skillDir:add / skillDir:remove），把 `await this.opts.skillManager.scan()` 替换为 `await this.scanSkillsWithExtensions()`：

- `case "skill:list"`（约 line 595）：
```ts
        const result = await this.scanSkillsWithExtensions();
```
- `case "skill:toggle"`（约 line 606）：
```ts
        const result = await this.scanSkillsWithExtensions();
```
- `case "skillDir:add"`（约 line 614）：
```ts
          const result = await this.scanSkillsWithExtensions();
```
- `case "skillDir:remove"`（约 line 625）：
```ts
          const result = await this.scanSkillsWithExtensions();
```

- [ ] **Step 6: 运行全部 kernel 测试验证无破坏**

Run: `cd packages/kernel && bun test -v`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/kernel/src/extension-manager.ts packages/kernel/src/ws-server.ts packages/kernel/tests/extension-manager.test.ts
git commit -m "feat: extension-manager 新增扩展技能发现 + ws-server 集成"
```

---

## Task 3: agent-manager additionalSkillPaths 合并扩展技能

**目标：** `resolveEnabledSkillPaths` 函数合并扩展技能路径到 `additionalSkillPaths`，让 Agent 能使用扩展技能。

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:715-729`（`resolveEnabledSkillPaths` 函数）
- Test: `packages/kernel/tests/agent-manager.test.ts`（若无此文件则检查现有测试方式）

**Interfaces:**
- Consumes: `ExtensionManager.getEnabledExtensionSkillPaths()` (Task 2), `SkillManager.scan(extPaths)` (Task 1)

- [ ] **Step 1: 写失败测试**

先检查 `packages/kernel/tests/` 下是否有 agent-manager 相关测试文件。如果有，在其中新增；如果没有，创建 `packages/kernel/tests/agent-manager-skill-paths.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";

function tmpDir() {
  const dir = join(import.meta.dir, ".tmp-agent-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`);
}

// 直接测试 resolveEnabledSkillPaths 的核心逻辑：
// skillManager.scan(extPaths) 返回的 skills 中，
// 来自 userDirs 和 extensionPaths 的技能路径都应该被收集。
test("scan 含扩展技能时，扩展来源技能出现在 allSkills 中", async () => {
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "skills"), { recursive: true });

  // 模拟扩展技能目录
  const extDir = join(dataDir, "fake-ext", "skills");
  createSkill(extDir, "ext-skill", "扩展技能");
  // 注意：实际扩展技能在 ~/.hiagent/runtime/node_modules/<pkg>/skills，
  // 这里用任意路径模拟

  const mgr = new SkillManager(dataDir);
  const result = await mgr.scan([
    { path: join(dataDir, "fake-ext", "skills"), packageName: "fake-ext" },
  ]);

  const extSkill = result.allSkills.find(s => s.name === "ext-skill");
  expect(extSkill).toBeDefined();
  expect(extSkill?.source?.type).toBe("extension");
  expect(extSkill?.source?.name).toBe("fake-ext");

  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试验证通过（scan 部分已在 Task 1 实现）**

Run: `cd packages/kernel && bun test tests/agent-manager-skill-paths.test.ts -v`
Expected: PASS（验证 scan 的扩展技能标记正确）

- [ ] **Step 3: 修改 resolveEnabledSkillPaths 函数**

修改 `packages/kernel/src/agent-manager.ts`，让 `resolveEnabledSkillPaths` 接受 `extensionManager` 参数并合并扩展技能路径：

```ts
/**
 * 解析启用 skill 的目录路径列表，供 SDK additionalSkillPaths 使用。
 * 包含 userSkillDirs 和扩展包 skills/ 目录来源的技能（builtin 由 SDK includeDefaults 自动扫）。
 * skillManager 为空（测试场景）时返回空数组。
 */
async function resolveEnabledSkillPaths(
  skillManager: SkillManager | undefined,
  extensionManager?: ExtensionManager,
): Promise<string[]> {
  if (!skillManager) return [];

  // 获取扩展技能路径（可能为空）
  const extSkillPaths = extensionManager
    ? await extensionManager.getEnabledExtensionSkillPaths()
    : [];
  const extPathStrings = extSkillPaths.map(p => p.path);

  // scan 时传入扩展技能路径，让扫描结果包含扩展来源技能
  const { skills, dirs, builtinDir } = await skillManager.scan(extSkillPaths);
  const userDirs = dirs.filter(d => d !== builtinDir);

  // 收集 userSkillDirs + 扩展来源的技能路径
  return skills
    .filter(s =>
      userDirs.some(d => isUnderPath(s.path, d)) ||
      extPathStrings.some(d => isUnderPath(s.path, d)),
    )
    .map(s => s.path);
}
```

- [ ] **Step 4: 修改 _createSession 中的调用点**

在 `_createSession` 方法中（约 line 262），修改调用：

```ts
    const additionalSkillPaths = await resolveEnabledSkillPaths(
      this.opts.skillManager,
      this.opts.extensionManager,
    );
```

- [ ] **Step 5: 确认 ExtensionManager 类型导入**

检查 `packages/kernel/src/agent-manager.ts` 顶部是否已导入 `ExtensionManager` 类型。根据探索结果 line 11 已有 `import type { ExtensionManager } from "./extension-manager";`。确认存在即可。

- [ ] **Step 6: 运行全部 kernel 测试**

Run: `cd packages/kernel && bun test -v`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager-skill-paths.test.ts
git commit -m "feat: agent-manager additionalSkillPaths 合并扩展技能路径"
```

---

## Task 4: 前端 token 序列化 + 触发检测纯函数

**目标：** 实现 chip token 的序列化/反序列化和触发符检测的纯函数，无 React 依赖。

**Files:**
- Create: `packages/frontend/src/quick-invoke/tokens.ts`
- Create: `packages/frontend/src/quick-invoke/trigger.ts`
- Test: `packages/frontend/tests/tokens.test.ts`
- Test: `packages/frontend/tests/trigger.test.ts`

**Interfaces:**
- Produces: `tokens.ts` 导出 `FILE_TOKEN_RE` / `SKILL_TOKEN_RE` / `expandTokens` / `textToSegments` / `segmentsToText` / `textToHtml` / `escapeHtml`
- Produces: `trigger.ts` 导出 `detectTrigger` / `filterItems`

### tokens.ts 设计

Chip token 格式（存储在 text 状态中的纯文本）：
- 文件：`@[相对路径]`，如 `@[packages/App.tsx]`
- 技能：`$[技能名]`，如 `$[brainstorming]`

发送时展开：
- `@[packages/App.tsx]` → `@packages/App.tsx`
- `$[brainstorming]` → `$brainstorming`

- [ ] **Step 1: 写失败测试 — tokens.test.ts**

创建 `packages/frontend/tests/tokens.test.ts`：

```ts
import { test, expect } from "bun:test";
import {
  FILE_TOKEN_RE, SKILL_TOKEN_RE,
  expandTokens, textToSegments, segmentsToText, textToHtml, escapeHtml,
} from "../src/quick-invoke/tokens";

test("expandTokens 展开文件 token", () => {
  expect(expandTokens("看这个 @[packages/App.tsx] 文件")).toBe("看这个 @packages/App.tsx 文件");
});

test("expandTokens 展开技能 token", () => {
  expect(expandTokens("用 $[brainstorming] 技能")).toBe("用 $brainstorming 技能");
});

test("expandTokens 同时展开文件和技能 token", () => {
  expect(expandTokens("@[a.tsx] 和 $[my-skill]")).toBe("@a.tsx 和 $my-skill");
});

test("expandTokens 无 token 时原样返回", () => {
  expect(expandTokens("普通文本")).toBe("普通文本");
});

test("textToSegments 拆分文本和 chip", () => {
  const segs = textToSegments("hello @[file.ts] world");
  expect(segs).toEqual([
    { type: "text", value: "hello " },
    { type: "file", value: "file.ts" },
    { type: "text", value: " world" },
  ]);
});

test("textToSegments 识别技能 chip", () => {
  const segs = textToSegments("$[my-skill]");
  expect(segs).toEqual([{ type: "skill", value: "my-skill" }]);
});

test("segmentsToText 与 textToSegments 可逆", () => {
  const original = "看 @[a.ts] 和 $[skill]";
  const segs = textToSegments(original);
  expect(segmentsToText(segs)).toBe(original);
});

test("escapeHtml 转义 HTML 特殊字符", () => {
  expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("textToHtml 渲染文件 chip 为 span", () => {
  const html = textToHtml("@[App.tsx]");
  expect(html).toContain("data-token=\"@[App.tsx]\"");
  expect(html).toContain("@App.tsx");
  expect(html).toContain("chip-file");
});

test("textToHtml 渲染技能 chip 为 span", () => {
  const html = textToHtml("$[brainstorm]");
  expect(html).toContain("data-token=\"$[brainstorm]\"");
  expect(html).toContain("$brainstorm");
  expect(html).toContain("chip-skill");
});

test("textToHtml 转义普通文本中的 HTML", () => {
  const html = textToHtml("<b>bold</b>");
  expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/frontend && bun test tests/tokens.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 tokens.ts**

创建 `packages/frontend/src/quick-invoke/tokens.ts`：

```ts
// chip token 序列化/反序列化纯函数
// token 格式：文件 @[相对路径]，技能 $[技能名]
// 发送时展开：@[path] -> @path，$[name] -> $name

/** 文件 token 正则：匹配 @[非]字 符的路径] */
export const FILE_TOKEN_RE = /@\[([^\]]+)\]/g;
/** 技能 token 正则：匹配 $[非]字 符的名称] */
export const SKILL_TOKEN_RE = /\$\[([^\]]+)\]/g;

/** segment 类型 */
export type Segment =
  | { type: "text"; value: string }
  | { type: "file"; value: string }
  | { type: "skill"; value: string };

/**
 * 发送时把 chip token 展开为纯文本引用标记。
 * @[packages/App.tsx] -> @packages/App.tsx
 * $[brainstorming] -> $brainstorming
 */
export function expandTokens(text: string): string {
  return text
    .replace(FILE_TOKEN_RE, "@$1")
    .replace(SKILL_TOKEN_RE, "$$$1"); // $$$1 = 字面 $ + 捕获组1
}

/** 转义 HTML 特殊字符，防止 XSS */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把纯文本（含 token）拆分为 segment 数组，供渲染和序列化使用。
 */
export function textToSegments(text: string): Segment[] {
  const combined = new RegExp(`(${FILE_TOKEN_RE.source}|${SKILL_TOKEN_RE.source})`, "g");
  const parts = text.split(combined).filter(p => p !== "");
  const segs: Segment[] = [];
  for (const part of parts) {
    const fileMatch = part.match(new RegExp(`^${FILE_TOKEN_RE.source}$`));
    if (fileMatch) {
      segs.push({ type: "file", value: fileMatch[1] });
      continue;
    }
    const skillMatch = part.match(new RegExp(`^${SKILL_TOKEN_RE.source}$`));
    if (skillMatch) {
      segs.push({ type: "skill", value: skillMatch[1] });
      continue;
    }
    segs.push({ type: "text", value: part });
  }
  return segs;
}

/** segment 数组还原为纯文本 token 字符串 */
export function segmentsToText(segs: Segment[]): string {
  return segs.map(s => {
    if (s.type === "file") return `@[${s.value}]`;
    if (s.type === "skill") return `$[${s.value}]`;
    return s.value;
  }).join("");
}

/**
 * 把纯文本（含 token）转为 HTML 字符串，chip 渲染为不可编辑的 span。
 * chip 内部含 data-token 属性（原始 token）和显示文本（展开后的引用标记）。
 */
export function textToHtml(text: string): string {
  const segs = textToSegments(text);
  return segs.map(s => {
    if (s.type === "file") {
      const token = `@[${s.value}]`;
      return `<span class="chip chip-file" contenteditable="false" data-token="${escapeHtml(token)}">@${escapeHtml(s.value)}</span>`;
    }
    if (s.type === "skill") {
      const token = `$[${s.value}]`;
      return `<span class="chip chip-skill" contenteditable="false" data-token="${escapeHtml(token)}">$${escapeHtml(s.value)}</span>`;
    }
    return escapeHtml(s.value);
  }).join("");
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages/frontend && bun test tests/tokens.test.ts -v`
Expected: 全部 PASS

- [ ] **Step 5: 写失败测试 — trigger.test.ts**

创建 `packages/frontend/tests/trigger.test.ts`：

```ts
import { test, expect } from "bun:test";
import { detectTrigger, filterItems } from "../src/quick-invoke/trigger";

test("detectTrigger 检测 @ 触发符", () => {
  const result = detectTrigger("hello @App");
  expect(result).toEqual({ type: "file", query: "App" });
});

test("detectTrigger 检测 $ 触发符", () => {
  const result = detectTrigger("用 $brain");
  expect(result).toEqual({ type: "skill", query: "brain" });
});

test("detectTrigger 空查询返回空 query", () => {
  const result = detectTrigger("text @");
  expect(result).toEqual({ type: "file", query: "" });
});

test("detectTrigger 行首 @ 触发", () => {
  const result = detectTrigger("@file");
  expect(result).toEqual({ type: "file", query: "file" });
});

test("detectTrigger 无触发符返回 null", () => {
  expect(detectTrigger("普通文本")).toBeNull();
});

test("detectTrigger 文本中间的 @ 不触发（前面需空格或行首）", () => {
  expect(detectTrigger("email@test")).toBeNull();
});

test("detectTrigger chip token 后不触发", () => {
  // @[file.ts] 是已存在的 chip token，不应触发新面板
  expect(detectTrigger("@[file.ts] @other")).toEqual({ type: "file", query: "other" });
});

test("filterItems 按名称模糊匹配", () => {
  const items = [
    { name: "App.tsx", description: "" },
    { name: "index.ts", description: "" },
    { name: "application.js", description: "" },
  ];
  const result = filterItems(items, "app");
  expect(result.map(r => r.name)).toEqual(["App.tsx", "application.js"]);
});

test("filterItems 空查询返回全部", () => {
  const items = [{ name: "A", description: "" }, { name: "B", description: "" }];
  expect(filterItems(items, "")).toHaveLength(2);
});

test("filterItems 大小写不敏感", () => {
  const items = [{ name: "BrainStorm", description: "" }];
  expect(filterItems(items, "brain")).toHaveLength(1);
});
```

- [ ] **Step 6: 运行测试验证失败**

Run: `cd packages/frontend && bun test tests/trigger.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 7: 实现 trigger.ts**

创建 `packages/frontend/src/quick-invoke/trigger.ts`：

```ts
// 触发符检测 + 列表过滤纯函数

export type TriggerType = "file" | "skill";

export interface TriggerResult {
  type: TriggerType;
  query: string;
}

export interface FilterableItem {
  name: string;
  description?: string;
}

/**
 * 检测光标前文本是否包含触发符 @ 或 $。
 * 规则：
 * - @ / $ 必须在行首或空格之后（避免 email@test 误触发）
 * - 触发符后的文本作为过滤关键词
 * - 已存在的 chip token（@[...] 或 $[...]）不触发
 * - @ 和 $ 互斥，取最后一个出现的
 */
export function detectTrigger(text: string): TriggerResult | null {
  // 先移除已存在的 chip token，避免 token 内的 @ / $ 干扰检测
  const cleaned = text
    .replace(/@\[[^\]]+\]/g, " ")
    .replace(/\$\[[^\]]+\]/g, " ");

  // 检测 @ 文件触发
  const atMatch = cleaned.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch) {
    return { type: "file", query: atMatch[1] };
  }

  // 检测 $ 技能触发
  const dollarMatch = cleaned.match(/(?:^|\s)\$([^\s]*)$/);
  if (dollarMatch) {
    return { type: "skill", query: dollarMatch[1] };
  }

  return null;
}

/**
 * 按名称模糊匹配过滤列表项（大小写不敏感）。
 * 空查询返回全部。
 */
export function filterItems<T extends FilterableItem>(items: T[], query: string): T[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter(item =>
    item.name.toLowerCase().includes(lower) ||
    (item.description?.toLowerCase().includes(lower) ?? false),
  );
}
```

- [ ] **Step 8: 运行测试验证通过**

Run: `cd packages/frontend && bun test tests/trigger.test.ts tests/tokens.test.ts -v`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
git add packages/frontend/src/quick-invoke/tokens.ts packages/frontend/src/quick-invoke/trigger.ts packages/frontend/tests/tokens.test.ts packages/frontend/tests/trigger.test.ts
git commit -m "feat: quick-invoke token 序列化 + 触发检测纯函数"
```

---

## Task 5: ComposerTextarea（contenteditable + chip 渲染）

**目标：** 实现 contenteditable div 组件，支持内联 chip 渲染、光标管理、半受控 text 同步。

**Files:**
- Create: `packages/frontend/src/components/ui/ComposerTextarea.tsx`
- Test: `packages/frontend/tests/ComposerTextarea.test.tsx`

**Interfaces:**
- Consumes: `textToHtml` / `segmentsToText` from `../quick-invoke/tokens` (Task 4)
- Produces: `<ComposerTextarea>` 组件，props: `{ text, onTextChange, placeholder, onKeyDown, onPaste, disabled }`

### 半受控方案说明

contenteditable + React 受控组件的核心冲突：每次 re-render 设置 innerHTML 会丢失光标。

解决方案：**半受控**
- `text` prop 作为「目标值」
- `useEffect([text])` 中比较 DOM 当前文本与 `text`，**仅在不一致时**（外部清空、程序化修改）才更新 DOM innerHTML
- 用户输入时，`onInput` 从 DOM 提取文本回调 `onTextChange`，React 更新 text state → re-render → useEffect 检查发现 DOM 与 text 一致 → **不重置 DOM**，光标保持不变

DOM 文本提取：遍历子节点，chip span 取 `data-token` 属性值，普通文本取 `textContent`。

- [ ] **Step 1: 写失败测试 — ComposerTextarea.test.tsx**

创建 `packages/frontend/tests/ComposerTextarea.test.tsx`：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ComposerTextarea } from "../src/components/ui/ComposerTextarea";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("渲染初始文本", () => {
  render(<ComposerTextarea text="hello" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
});

test("渲染文件 chip", () => {
  render(<ComposerTextarea text="看 @[App.tsx]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("@App.tsx");
  expect(chip.className).toContain("chip-file");
  expect(chip.getAttribute("data-token")).toBe("@[App.tsx]");
});

test("渲染技能 chip", () => {
  render(<ComposerTextarea text="用 $[brainstorm]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("$brainstorm");
  expect(chip.className).toContain("chip-skill");
});

test("输入时回调 onTextChange", () => {
  const onTextChange = mock();
  render(<ComposerTextarea text="" onTextChange={onTextChange} onKeyDown={mock()} onPaste={mock()} />);
  const el = screen.getByRole("textbox") as HTMLElement;
  el.focus();
  el.textContent = "typed";
  fireEvent.input(el);
  expect(onTextChange).toHaveBeenCalledWith("typed");
});

test("外部 setText 清空时 DOM 同步更新", async () => {
  const { rerender } = render(<ComposerTextarea text="hello" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  expect(screen.getByRole("textbox").textContent).toBe("hello");
  // 模拟发送后清空
  rerender(<ComposerTextarea text="" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  await waitFor(() => {
    expect(screen.getByRole("textbox").textContent).toBe("");
  });
});

test("chip 是不可编辑的", () => {
  render(<ComposerTextarea text="@[file.ts]" onTextChange={mock()} onKeyDown={mock()} onPaste={mock()} />);
  const chip = screen.getByText("@file.ts");
  expect(chip.getAttribute("contenteditable")).toBe("false");
});

test("chip 的 data-token 在 DOM 文本提取时保留", () => {
  const onTextChange = mock();
  render(<ComposerTextarea text="@[file.ts] end" onTextChange={onTextChange} onKeyDown={mock()} onPaste={mock()} />);
  const el = screen.getByRole("textbox") as HTMLElement;
  // 模拟在 chip 后输入
  el.focus();
  // 在末尾追加文本节点
  el.appendChild(document.createTextNode(" more"));
  fireEvent.input(el);
  // onTextChange 应该收到 token + 新文本
  expect(onTextChange).toHaveBeenCalledWith("@[file.ts] end more");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/frontend && bun test tests/ComposerTextarea.test.tsx -v`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 ComposerTextarea**

创建 `packages/frontend/src/components/ui/ComposerTextarea.tsx`：

```tsx
import { useRef, useEffect, useCallback } from "react";
import { textToHtml } from "../../quick-invoke/tokens";

interface Props {
  text: string;
  onTextChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

/**
 * 从 contenteditable DOM 提取纯文本 token 字符串。
 * chip span 取 data-token 属性，普通文本取 textContent。
 */
function extractText(el: HTMLElement): string {
  let result = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      const token = elem.getAttribute("data-token");
      if (token) {
        result += token;
      } else {
        result += extractText(elem);
      }
    }
  }
  return result;
}

/**
 * contenteditable 输入框，支持内联 chip 渲染。
 * 采用半受控模式：text 作为目标值，仅在 DOM 与 text 不一致时同步 DOM。
 */
export function ComposerTextarea({
  text, onTextChange, placeholder, disabled, onKeyDown, onPaste,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);

  // 半受控同步：仅在 text 与 DOM 当前内容不一致时更新 DOM（如外部清空）
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const currentText = extractText(el);
    if (currentText !== text) {
      el.innerHTML = textToHtml(text);
    }
  }, [text]);

  const handleInput = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    onTextChange(extractText(el));
  }, [onTextChange]);

  return (
    <div
      ref={elRef}
      role="textbox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      data-placeholder={placeholder}
      className="w-full bg-transparent text-primary outline-none resize-none text-sm px-4 py-4 placeholder:text-tertiary overflow-y-auto"
      style={{ maxHeight: 300, minHeight: 60, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    />
  );
}
```

同时在全局 CSS 中添加 chip 样式和 placeholder 样式。先检查现有 CSS 文件位置：

需要确认前端的全局 CSS 入口（通常是 `src/index.css` 或 `src/App.css`），在其中添加 chip 样式。如果不确定，用内联 style 作为 fallback。

在 `ComposerTextarea.tsx` 的返回 JSX 中，为避免 CSS 依赖问题，chip 样式通过内联 `<style>` 标签注入（仅在该组件首次渲染时）：

在 `ComposerTextarea.tsx` 顶部组件外添加一个模块级 style 注入（只执行一次）：

```tsx
// chip 内联样式（避免依赖外部 CSS 文件，确保 chip 颜色一致）
let chipStyleInjected = false;
function ensureChipStyles() {
  if (chipStyleInjected || typeof document === "undefined") return;
  chipStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 0.85em;
      font-weight: 500;
      margin: 0 1px;
      vertical-align: baseline;
      user-select: all;
    }
    .chip-file {
      background-color: #EB933E20;
      color: #EB933E;
      border: 1px solid #EB933E40;
    }
    .chip-skill {
      background-color: #5B5BD620;
      color: #5B5BD6;
      border: 1px solid #5B5BD640;
    }
    [contenteditable][data-placeholder]:empty::before {
      content: attr(data-placeholder);
      color: var(--text-tertiary, #A1A1A6);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}
```

在组件函数体开头调用 `ensureChipStyles();`。

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages/frontend && bun test tests/ComposerTextarea.test.tsx -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/ui/ComposerTextarea.tsx packages/frontend/tests/ComposerTextarea.test.tsx
git commit -m "feat: ComposerTextarea contenteditable 组件 + chip 内联渲染"
```

---

## Task 6: QuickInvokeMenu 弹出面板

**目标：** 实现统一的弹出面板组件，展示文件列表或技能列表，支持键盘导航和鼠标交互。

**Files:**
- Create: `packages/frontend/src/components/ui/QuickInvokeMenu.tsx`
- Test: `packages/frontend/tests/QuickInvokeMenu.test.tsx`

**Interfaces:**
- Consumes: `TriggerType` from `../../quick-invoke/trigger` (Task 4)
- Produces: `<QuickInvokeMenu>` 组件

### Props 设计

```ts
interface MenuItem {
  id: string;          // 唯一标识（文件路径或技能名）
  name: string;        // 显示名称
  description?: string; // 描述（技能用）
  path?: string;        // 相对路径（文件用，显示在名称下方）
  source?: SkillSource; // 来源标签（技能用）
}

interface QuickInvokeMenuProps {
  type: "file" | "skill";   // 面板类型
  items: MenuItem[];        // 已过滤的列表项
  highlightedIndex: number; // 当前高亮索引
  onSelect: (item: MenuItem) => void;
  onHover: (index: number) => void;
  emptyText?: string;       // 无结果时的提示文本
}
```

- [ ] **Step 1: 写失败测试 — QuickInvokeMenu.test.tsx**

创建 `packages/frontend/tests/QuickInvokeMenu.test.tsx`：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickInvokeMenu } from "../src/components/ui/QuickInvokeMenu";
import type { MenuItem } from "../src/components/ui/QuickInvokeMenu";

beforeEach(() => {
  document.body.innerHTML = "";
});

const fileItems: MenuItem[] = [
  { id: "/src/App.tsx", name: "App.tsx", path: "src/App.tsx" },
  { id: "/src/index.ts", name: "index.ts", path: "src/index.ts" },
];

const skillItems: MenuItem[] = [
  { id: "brainstorming", name: "brainstorming", description: "头脑风暴", source: { type: "builtin" } },
  { id: "pdf-tools", name: "pdf-tools", description: "PDF 工具", source: { type: "extension", name: "ext-pkg" } },
];

test("渲染文件列表", () => {
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  expect(screen.getByText("App.tsx")).toBeDefined();
  expect(screen.getByText("src/App.tsx")).toBeDefined();
});

test("渲染技能列表含来源标签", () => {
  render(<QuickInvokeMenu type="skill" items={skillItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  expect(screen.getByText("brainstorming")).toBeDefined();
  expect(screen.getByText("内置")).toBeDefined(); // builtin 来源标签
  expect(screen.getByText("ext-pkg")).toBeDefined(); // extension 来源标签
});

test("高亮第一项", () => {
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  const firstItem = screen.getByTestId("quick-invoke-item-0");
  expect(firstItem.className).toContain("bg-accent-soft");
});

test("点击项触发 onSelect", () => {
  const onSelect = mock();
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={onSelect} onHover={mock()} />);
  fireEvent.click(screen.getByTestId("quick-invoke-item-0"));
  expect(onSelect).toHaveBeenCalledWith(fileItems[0]);
});

test("鼠标 hover 触发 onHover", () => {
  const onHover = mock();
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={onHover} />);
  fireEvent.mouseEnter(screen.getByTestId("quick-invoke-item-1"));
  expect(onHover).toHaveBeenCalledWith(1);
});

test("空列表显示提示文本", () => {
  render(<QuickInvokeMenu type="file" items={[]} highlightedIndex={-1} onSelect={mock()} onHover={mock()} emptyText="无匹配文件" />);
  expect(screen.getByText("无匹配文件")).toBeDefined();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/frontend && bun test tests/QuickInvokeMenu.test.tsx -v`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 QuickInvokeMenu**

创建 `packages/frontend/src/components/ui/QuickInvokeMenu.tsx`：

```tsx
import type { SkillSource } from "@hiagent/shared";

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  path?: string;
  source?: SkillSource;
}

interface Props {
  type: "file" | "skill";
  items: MenuItem[];
  highlightedIndex: number;
  onSelect: (item: MenuItem) => void;
  onHover: (index: number) => void;
  emptyText?: string;
}

/** 来源标签文本 */
function sourceLabel(source?: SkillSource): string | null {
  if (!source) return null;
  switch (source.type) {
    case "builtin": return "内置";
    case "project": return "项目";
    case "user": return "用户";
    case "extension": return source.name ?? "扩展";
    default: return null;
  }
}

export function QuickInvokeMenu({ type, items, highlightedIndex, onSelect, onHover, emptyText }: Props) {
  return (
    <div
      data-testid="quick-invoke-menu"
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[400px] max-h-[300px] overflow-y-auto bg-surface border border-hairline rounded-xl shadow-lg z-50"
    >
      {items.length === 0 ? (
        <div className="px-4 py-3 text-sm text-tertiary text-center">
          {emptyText ?? "无匹配结果"}
        </div>
      ) : (
        <ul className="py-1">
          {items.map((item, i) => (
            <li
              key={item.id}
              data-testid={`quick-invoke-item-${i}`}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${
                i === highlightedIndex ? "bg-accent-soft" : "hover:bg-surface-hover"
              }`}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(i)}
            >
              {type === "file" ? (
                <>
                  <span className="text-base flex-shrink-0">📄</span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.path && (
                      <span className="text-xs text-tertiary truncate">{item.path}</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <span className="text-base flex-shrink-0">⚡</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.description && (
                      <span className="text-xs text-tertiary truncate">{item.description}</span>
                    )}
                  </div>
                  {sourceLabel(item.source) && (
                    <span className="text-xs text-tertiary px-1.5 py-0.5 border border-hairline rounded flex-shrink-0">
                      {sourceLabel(item.source)}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages/frontend && bun test tests/QuickInvokeMenu.test.tsx -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/ui/QuickInvokeMenu.tsx packages/frontend/tests/QuickInvokeMenu.test.tsx
git commit -m "feat: QuickInvokeMenu 弹出面板组件"
```

---

## Task 7: ComposerInput 集成改造

**目标：** 改造 ComposerInput，集成触发检测、面板状态管理、chip 插入、文件/技能数据加载。

**Files:**
- Modify: `packages/frontend/src/components/ui/ComposerInput.tsx`（主要改造）
- Modify: `packages/frontend/tests/ComposerInput.test.tsx`（新增 quick invoke 测试）

**Interfaces:**
- Consumes: `ComposerTextarea` (Task 5), `QuickInvokeMenu` (Task 6), `detectTrigger` / `filterItems` (Task 4), `searchFilesStream` from `../../fs-client`, `useSkillsStore` from `../../store/skills`

### 改造要点

1. `<textarea>` 替换为 `<ComposerTextarea>`
2. 新增 quick invoke 状态：`trigger`（当前触发类型+查询）/ `menuItems`（面板列表项）/ `highlightedIndex`
3. `@` 触发 → 调用 `searchFilesStream` 搜索文件；`$` 触发 → 从 `useSkillsStore.allSkills` 过滤
4. 选中后生成 chip token 插入 text，关闭面板
5. 键盘事件：上下键导航 / Enter 选中 / Esc 关闭面板（在 `onKeyDown` 中拦截，面板打开时阻止默认行为）

- [ ] **Step 1: 写失败测试 — ComposerInput quick invoke 交互**

在 `packages/frontend/tests/ComposerInput.test.tsx` 中，首先需要更新 mock（因为 ComposerInput 现在依赖 useSkillsStore）。在文件顶部已有的 `mock.module("../src/ws-instance", ...)` 之后，确保测试中可以设置 skills store。

新增测试用例（追加到文件末尾，在最后一个 `test()` 之后）：

```tsx
// === Quick Invoke 测试 ===
import { useSkillsStore } from "../src/store/skills";

test("输入 @ 触发文件面板", () => {
  const setText = mock();
  renderComposer({ text: "你好 @App", setText });
  // 面板应该出现（searchFilesStream 是异步的，但面板组件应渲染）
  // 初始状态下 items 可能还没加载，但 menu 容器应存在
  // 注意：searchFilesStream 需要 WS 回复，这里仅验证面板 UI 出现
  waitFor(() => {
    const menu = document.querySelector('[data-testid="quick-invoke-menu"]');
    // 面板可能存在也可能因无数据不渲染——核心是触发检测工作
  });
  // 验证触发了 fs:search WS 请求
  const searchCall = sendMock.mock.calls.find(([e]) => e.type === "fs:search");
  expect(searchCall).toBeTruthy();
});

test("输入 $ 触发技能面板", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "用 $brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
});

test("选中技能后生成 chip token", () => {
  const setText = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "$brain", setText });
  // 点击技能项
  fireEvent.click(screen.getByText("brainstorming"));
  // setText 应被调用，text 中应包含 $[brainstorming]
  expect(setText).toHaveBeenCalled();
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
  expect(lastCall).toContain("$[brainstorming]");
  // 不应再包含原始的 $brain 文本
  expect(lastCall).not.toMatch(/\$brain$/);
});

test("Esc 关闭面板保留触发符文本", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "", path: "/s", source: { type: "builtin" } },
    ],
    skills: [], dirs: [], disabledSkills: [], builtinDir: "",
  });
  renderComposer({ text: "$brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
  // 按 Esc
  const textbox = screen.getByRole("textbox");
  fireEvent.keyDown(textbox, { key: "Escape" });
  // 面板应消失
  expect(screen.queryByText("brainstorming")).toBeNull();
});

test("发送时 chip token 展开为纯文本", () => {
  // ComposerInput 本身不处理发送时的展开——由 Composer.tsx 调用 expandTokens
  // 这里验证 text 状态包含 token 格式
  const setText = mock();
  useSkillsStore.setState({
    allSkills: [{ name: "pdf", description: "", path: "/s", source: { type: "builtin" } }],
    skills: [], dirs: [], disabledSkills: [], builtinDir: "",
  });
  renderComposer({ text: "$pd", setText });
  fireEvent.click(screen.getByText("pdf"));
  const lastCall = setText.mock.calls[setText.mock.calls.length - 1][0] as string;
  // token 格式为 $[pdf]，发送时由 Composer 展开为 $pdf
  expect(lastCall).toContain("$[pdf]");
});
```

注意：需要在 `beforeEach` 中重置 skills store：

```tsx
beforeEach(() => {
  useProvidersStore.setState({ providers: [] });
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [], builtinDir: "", loading: false,
    load: mock(), setAll: mock(), toggleSkill: mock(), addDir: mock(), removeDir: mock(),
  });
  handlers.clear();
  sendMock.mockClear();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/frontend && bun test tests/ComposerInput.test.tsx -v`
Expected: 新测试 FAIL（@/$ 触发尚未实现）

- [ ] **Step 3: 实现 ComposerInput 改造**

修改 `packages/frontend/src/components/ui/ComposerInput.tsx`。以下是完整的改造后文件（保留所有现有功能：附件上传、拖拽、模型选择器、思考选择器、录音按钮）：

在文件顶部添加导入：

```tsx
import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { uploadFile, copyToUploads, searchFilesStream } from "../../fs-client";
import { useProjectsStore } from "../../store/projects";
import { useSkillsStore } from "../../store/skills";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { AttachmentChip } from "./AttachmentChip";
import { FilePicker, type FilePickerSelection } from "./FilePicker";
import { RecordButton } from "./RecordButton";
import { ComposerTextarea } from "./ComposerTextarea";
import { QuickInvokeMenu, type MenuItem } from "./QuickInvokeMenu";
import { detectTrigger, filterItems, type TriggerResult } from "../../quick-invoke/trigger";
```

在组件函数体中（`pickerOpen` 状态之后）新增 quick invoke 状态和逻辑：

```tsx
  // === Quick Invoke 状态 ===
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [fileResults, setFileResults] = useState<MenuItem[]>([]);
  const cancelSearchRef = useRef<(() => void) | null>(null);

  const allSkills = useSkillsStore(s => s.allSkills);
  const projectCwd = useProjectsStore(s => s.projects.find(p => p.id === projectId)?.cwd);

  // 检测当前 text 的触发状态
  const trigger: TriggerResult | null = useMemo(() => detectTrigger(text), [text]);

  // 触发类型
  const triggerType = trigger?.type ?? null;

  // 文件搜索：@ 触发且有 projectCwd 时调用 searchFilesStream
  useEffect(() => {
    if (triggerType !== "file" || !projectCwd) {
      setFileResults([]);
      return;
    }
    // 取消上一次搜索
    cancelSearchRef.current?.();
    cancelSearchRef.current = null;

    const query = trigger!.query;
    // @ 后有路径分隔符时（如 @packages/），query 包含 /，用路径前缀搜索
    // 无分隔符时用文件名搜索
    const cancel = searchFilesStream(
      query,
      { roots: [projectCwd], maxResults: 50 },
      {
        onProgress: (matches) => {
          setFileResults(matches.map(m => ({
            id: m.path,
            name: m.name,
            path: m.path.startsWith(projectCwd) ? m.path.slice(projectCwd.length + 1) : m.path,
          })));
        },
        onDone: () => {},
      },
    );
    cancelSearchRef.current = cancel;
    return () => { cancel(); };
  }, [triggerType, trigger?.query, projectCwd]);

  // $ 技能列表过滤
  const skillItems: MenuItem[] = useMemo(() => {
    if (triggerType !== "skill") return [];
    const filtered = filterItems(allSkills, trigger!.query);
    return filtered.map(s => ({
      id: s.name,
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }, [triggerType, trigger, allSkills]);

  // 当前面板列表项
  const menuItems = triggerType === "file" ? fileResults : triggerType === "skill" ? skillItems : [];

  // 面板是否打开
  const menuOpen = triggerType !== null;

  // highlightedIndex 重置（触发类型或列表变化时）
  useEffect(() => {
    setHighlightedIndex(menuItems.length > 0 ? 0 : -1);
  }, [triggerType, trigger?.query]);

  // 选中项处理：生成 chip token 插入 text，替换末尾的触发符 + 查询文本
  const handleSelect = useCallback((item: MenuItem) => {
    const token = triggerType === "file"
      ? `@[${item.path ?? item.name}]`
      : `$[${item.name}]`;
    const triggerSymbol = triggerType === "file" ? "@" : "$";
    const query = trigger?.query ?? "";
    // 从 text 末尾去掉触发符 + 查询文本，替换为 chip token + 空格
    // 用正则匹配末尾的 @query 或 $query（与 detectTrigger 的正则一致）
    const triggerRe = new RegExp(
      `${triggerSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    );
    const newText = triggerRe.test(text)
      ? text.replace(triggerRe, token + " ")
      : text + token + " "; // fallback：直接追加
    setText(newText);
  }, [triggerType, trigger, text, setText]);

  // 键盘事件处理（覆盖在 ComposerTextarea 的 onKeyDown 之上）
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // 面板打开时拦截导航键
    if (menuOpen && menuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex(i => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex(i => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const item = menuItems[highlightedIndex];
        if (item) handleSelect(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // 关闭面板：通过 setText 去掉触发符后的查询？
        // spec 说「保留 @/$ 文本」，所以不改 text，只是面板消失
        // 面板消失靠 trigger 变 null——但我们不改 text，trigger 仍然是 @query
        // 解决方案：用一个 escapeFlag state
        return;
      }
    }
    // 正常 Enter 发送
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }, [menuOpen, menuItems, highlightedIndex, handleSelect, canSend, onSend]);
```

**注意 Esc 处理**：spec 要求「Esc 关闭面板，保留 `@`/`$` 文本」。但 `detectTrigger` 会持续检测到 `@query`。需要一个 `dismissed` 标志，Esc 后设为 true，text 变化时重置：

在状态区域添加：

```tsx
  const [dismissed, setDismissed] = useState(false);

  // text 变化时重置 dismissed
  useEffect(() => { setDismissed(false); }, [text]);

  // 实际是否显示面板
  const menuOpen = triggerType !== null && !dismissed;
```

Esc 处理改为：
```tsx
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
```

然后替换 JSX 中的 `<textarea>` 为 `<ComposerTextarea>` + `<QuickInvokeMenu>`。

在 `return` 的 JSX 中，把原来的 `<textarea>...</textarea>` 整块替换为：

```tsx
        <div className="relative">
          {menuOpen && (
            <QuickInvokeMenu
              type={triggerType!}
              items={menuItems}
              highlightedIndex={highlightedIndex}
              onSelect={handleSelect}
              onHover={setHighlightedIndex}
              emptyText={triggerType === "file" ? "无匹配文件" : "无匹配技能"}
            />
          )}
          <ComposerTextarea
            text={text}
            onTextChange={setText}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
```

注意：`handlePaste` 的类型从 `React.ClipboardEvent<HTMLTextAreaElement>` 改为 `React.ClipboardEvent<HTMLDivElement>`。

`autoResize` 函数删除（contenteditable 自适应高度由 CSS 控制）。

- [ ] **Step 4: 修改 Composer.tsx 发送时展开 chip token**

修改 `packages/frontend/src/components/Composer.tsx`，在 `handleSend` 中发送前展开 token：

在文件顶部添加导入：

```tsx
import { expandTokens } from "../quick-invoke/tokens";
```

修改 `handleSend`：

```tsx
  const handleSend = () => {
    if (disabled) return;
    // 展开 chip token 为纯文本引用标记
    const expandedText = expandTokens(text);
    if (!expandedText.trim() || !model || sendingRef.current || !projectId) return;
    sendingRef.current = true;
    if (!isRunning) {
      useSessionStore.getState().optimisticSend(sessionId, expandedText, agentName);
    }
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName,
      text: expandedText,
      model,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setSessionPrefs(sessionId, { attachments: [] });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd packages/frontend && bun test tests/ComposerInput.test.tsx -v`
Expected: 全部 PASS

- [ ] **Step 6: 运行全部前端测试确保无破坏**

Run: `cd packages/frontend && bun test -v`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/src/components/Composer.tsx packages/frontend/tests/ComposerInput.test.tsx
git commit -m "feat: ComposerInput 集成 Quick Invoke 触发检测 + chip 插入"
```

---

## Task 8: E2E 测试 + CHANGELOG

**目标：** 编写 E2E 测试验证完整流程，更新 CHANGELOG。

**Files:**
- Create: `tests/e2e/quick-invoke.spec.ts`（或项目现有 E2E 目录）
- Modify: `CHANGELOG.md`（顶部新增条目）

**Interfaces:**
- Consumes: 全部前置任务的成果

- [ ] **Step 1: 确认 E2E 测试目录和工具链**

Run: `find . -type d -name node_modules -prune -o -type f -name "*.spec.ts" -path "*/e2e/*" -print 2>/dev/null | head -5`

确认现有 E2E 测试的位置和 Playwright 配置。如果存在 `tests/e2e/` 目录和 `playwright.config.ts`，在其中新增。

- [ ] **Step 2: 编写 E2E 测试**

创建或追加到 E2E 测试文件。以下是基于 Playwright + agent-browser 的测试框架：

```ts
import { test, expect } from "@playwright/test";

test.describe("Quick Invoke 聊天栏快速调用", () => {
  test("输入 @ 选文件 → chip 显示 → 发送", async ({ page }) => {
    // 前置：通过 API 创建测试项目 + 启动服务
    // 导航到聊天页面
    // 1. 在输入框输入 @
    // 2. 等待文件面板出现
    // 3. 输入文件名过滤
    // 4. Enter 或点击选中
    // 5. 验证 chip 出现在输入框中（橙色 chip）
    // 6. 输入附加文本
    // 7. 点击发送
    // 8. 验证发送的消息中 chip 展开为 @path 纯文本
    // 9. finally: 清理测试数据 + 删除截图
  });

  test("输入 $ 选技能 → chip 显示 → 发送", async ({ page }) => {
    // 1. 在输入框输入 $
    // 2. 等待技能面板出现（含来源标签）
    // 3. 输入技能名过滤
    // 4. Enter 选中
    // 5. 验证 chip 出现（靛蓝 chip）
    // 6. 点击发送
    // 7. 验证消息中 chip 展开为 $skill-name
  });

  test("Esc 关闭面板保留触发符文本", async ({ page }) => {
    // 1. 输入 $brain
    // 2. 面板出现
    // 3. 按 Esc
    // 4. 面板消失，输入框保留 $brain 文本
  });

  test("Backspace 删除整个 chip", async ({ page }) => {
    // 1. 选中一个文件生成 chip
    // 2. 光标在 chip 后按 Backspace
    // 3. 验证整个 chip 被删除
  });
});
```

**重要**：E2E 测试需要真实运行的服务。根据项目现有 E2E setup 调整。如果项目使用 agent-browser CLI 而非 Playwright，需适配。

**截图清理**：E2E 测试中产生的所有截图文件，在测试完成后（`test.afterEach` 或 `test.afterAll`）必须删除。

- [ ] **Step 3: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 顶部（`# 变更日志` 标题之后）新增：

```markdown
## 2026-07-16 — Quick Invoke 聊天栏快速调用

### 新增
- **`@` 文件快速调用** — 在聊天输入框输入 `@` 触发文件选择面板，选中文件以橙色 chip 内联插入消息，发送时展开为 `@相对路径` 纯文本引用标记
- **`$` 技能快速调用** — 输入 `$` 触发技能选择面板，选中技能以靛蓝 chip 内联插入消息，发送时展开为 `$技能名` 标记
- **ComposerTextarea 组件** — 从原生 textarea 改为 contenteditable div，支持内联彩色 chip 渲染、半受控光标管理
- **QuickInvokeMenu 组件** — 统一弹出面板，支持键盘上下导航、Enter 选中、Esc 关闭、鼠标 hover/click
- **扩展技能发现** — extension-manager 新增 `getEnabledExtensionSkillPaths()`，自动发现已启用扩展包中的 skills/ 目录并纳入扫描
- **SkillInfo.source 字段** — 技能信息新增来源标记（builtin/user/extension），`$` 面板展示来源标签
- **skill-utils 共享模块** — 从 skill-manager 提取 `hasSkillMd` / `scanSkillsDir` 供 extension-manager 和 skill-manager 共享

### 重构
- **skill-manager.scan()** — 接受扩展技能路径参数，支持扫描 builtin + user + extension 三类来源
- **agent-manager resolveEnabledSkillPaths** — 合并扩展技能路径到 SDK additionalSkillPaths
- **ws-server** — 4 处 skillManager.scan() 调用统一走 scanSkillsWithExtensions 辅助方法

### 测试
- 单元测试：tokens 序列化/反序列化、触发检测正则、skill-utils 共享函数
- 组件测试：ComposerTextarea chip 渲染、QuickInvokeMenu 列表交互、ComposerInput 触发+选中+Esc
- 集成测试：extension-manager 扩展技能发现、skill-manager 扩展技能扫描
- E2E：@ 选文件 → chip → 发送；$ 选技能 → chip → 发送；Esc 关闭；Backspace 删 chip

### 影响范围
- `packages/shared/src/skills.ts` — SkillInfo 类型扩展
- `packages/kernel/src/skill-utils.ts`（新建）— 共享扫描函数
- `packages/kernel/src/skill-manager.ts` — scan 扩展技能
- `packages/kernel/src/extension-manager.ts` — 新增方法
- `packages/kernel/src/ws-server.ts` — scan 调用集成
- `packages/kernel/src/agent-manager.ts` — additionalSkillPaths 合并
- `packages/frontend/src/quick-invoke/`（新建）— tokens + trigger 纯函数
- `packages/frontend/src/components/ui/ComposerTextarea.tsx`（新建）
- `packages/frontend/src/components/ui/QuickInvokeMenu.tsx`（新建）
- `packages/frontend/src/components/ui/ComposerInput.tsx` — 集成改造
- `packages/frontend/src/components/Composer.tsx` — 发送时展开 token

---
```

- [ ] **Step 4: 运行全部测试**

Run: `bun test -v`
Expected: 全部 PASS

Run: `bun run typecheck`
Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add tests/e2e/quick-invoke.spec.ts CHANGELOG.md
git commit -m "test: Quick Invoke E2E 测试 + CHANGELOG"
```

---

## Self-Review 清单

### Spec 覆盖检查

| Spec 要求 | 对应任务 |
|-----------|---------|
| `@` 触发文件选择面板 | Task 4 (detectTrigger) + Task 7 (ComposerInput) |
| `$` 触发技能选择面板 | Task 4 + Task 7 |
| chip 以内联彩色 chip 形式插入 | Task 4 (tokens) + Task 5 (ComposerTextarea) |
| `@` chip 橙色 `#EB933E` | Task 5 (ensureChipStyles) |
| `$` chip 靛蓝 `#5B5BD6` | Task 5 |
| 文件搜索复用 searchFilesStream | Task 7 |
| 技能数据来自 useSkillsStore.allSkills | Task 7 |
| 键盘上下键导航 + Enter + Esc | Task 6 (QuickInvokeMenu) + Task 7 (handleKeyDown) |
| 发送时 token 展开 | Task 4 (expandTokens) + Task 7 (Composer.tsx) |
| 扩展技能发现 getEnabledExtensionSkillPaths | Task 2 |
| skill-utils 提取 hasSkillMd / scanSkillsDir | Task 1 |
| skill-manager.scan 纳入扩展技能 | Task 1 (scan 参数) + Task 2 (ws-server 调用) |
| agent-manager additionalSkillPaths 合并 | Task 3 |
| SkillInfo.source 字段 + 来源标签 | Task 1 (类型) + Task 6 (sourceLabel) |
| 保护性检测（hasSkillMd 入口过滤） | Task 1 (skill-utils) + Task 2 (getEnabledExtensionSkillPaths) |

### 已知简化（spec 中明确不在范围）

- ❌ `@` 文件引用发送时附带文件内容作为 context — spec 明确「当前仅传文本标记」
- ❌ 扩展包 package.json 中 pi.skills 字段声明技能
- ❌ MCP 工具在 `$` 面板中展示
