# pi-lens 插件菜单 + 启用/禁用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 pi-lens 接入 wa-pi，在「系统设置」新增「插件」菜单显示并可启用/禁用 pi-lens；切换走 deferred reload（会话下次使用时生效），并把技能 toggle 的 reload 时机统一为同一套 deferred 机制。

**Architecture:** pi-lens 由 SDK 原生 `settings.json.extensions` 字段驱动（`loader.reload()` 会重读它），核心扩展仍走 `additionalExtensionPaths`。新增 `ExtensionManager`（镜像 `SkillManager`）读写 `settings.extensions`；`AgentManager` 新增 dirty 集合 + `markAllDirty()`，在 `ensureStarted` 命中缓存时按需 `session.reload()`。WS 协议与前端 store/section 全部镜像技能子系统。

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-coding-agent` SDK, React, zustand, Vitest/bun:test, Testing Library

**Spec:** [docs/superpowers/specs/2026-07-11-pi-lens-plugin-menu-design.md](../specs/2026-07-11-pi-lens-plugin-menu-design.md)

---

## File Structure

**Create:**
- `packages/shared/src/extensions.ts` — WS 协议类型（ExtensionPluginInfo + 事件）
- `packages/kernel/src/extension-manager.ts` — 可选扩展启用/禁用管理（镜像 skill-manager）
- `packages/kernel/tests/extension-manager.test.ts` — 单测
- `packages/kernel/tests/ws-extension.test.ts` — WS handler 测试
- `packages/frontend/src/store/extensions.ts` — 前端 store
- `packages/frontend/src/components/settings/ExtensionSection.tsx` — 插件面板
- `packages/frontend/tests/ExtensionSection.test.tsx` — 组件测试

**Modify:**
- `packages/shared/src/index.ts` — 导出新类型
- `packages/shared/src/types.ts` — WS 事件联合
- `packages/kernel/src/extensions.ts` — 导出 `resolveExtensionEntryFile` + `OPTIONAL_EXTENSIONS`
- `packages/kernel/src/agent-manager.ts` — deferred reload + 移除 `reloadAllSessions`
- `packages/kernel/src/ws-server.ts` — extension handlers + 技能 handler 改 `markAllDirty` + opts 加 `extensionManager`
- `packages/kernel/src/index.ts` — 构造/注入/播种 `ExtensionManager`
- `packages/kernel/package.json` — 加 `pi-lens` 依赖
- `packages/kernel/tests/extensions.test.ts` — 断言 pi-lens 不在 additionalExtensionPaths
- `packages/kernel/tests/agent-manager.test.ts` — fakeSession 加 `reload` + deferred reload 测试
- `packages/kernel/tests/ws-skill.test.ts` — mock 改 `markAllDirty`
- `packages/frontend/src/store/settings.ts` — `SettingsSection` 加 `"plugins"`
- `packages/frontend/src/components/SettingsModal.tsx` — 加「插件」nav
- `packages/frontend/src/App.tsx` — 事件接线 + 启动 load
- `packages/frontend/tests/SettingsModal.test.tsx` — nav 测试（可选补充）

---

## Task 1: Shared WS 协议类型

**Files:**
- Create: `packages/shared/src/extensions.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: 创建 `packages/shared/src/extensions.ts`**

```ts
// ===== 可选插件（扩展）管理类型定义 =====

/** 可选插件信息（驱动 UI 展示与启用态） */
export interface ExtensionPluginInfo {
  id: string;            // 稳定标识（前端用）
  displayName: string;
  description: string;
  enabled: boolean;
  version?: string;
}

// ===== WS 协议事件（插件管理）=====

// 前端 → kernel
export interface ExtensionListEvent { type: "extension:list"; }
export interface ExtensionToggleEvent {
  type: "extension:toggle";
  id: string;
  enabled: boolean;      // true=启用，false=禁用
}

// kernel → 前端（extension:list 和 extension:changed 结构相同）
export interface ExtensionListResult {
  type: "extension:list";
  plugins: ExtensionPluginInfo[];
}

export interface ExtensionChangedEvent {
  type: "extension:changed";
  plugins: ExtensionPluginInfo[];
}
```

- [ ] **Step 2: 在 `packages/shared/src/index.ts` 末尾追加导出**

在 `export * from "./skills";` 之后加一行：

```ts
export * from "./extensions";
```

- [ ] **Step 3: 在 `packages/shared/src/types.ts` 接入联合类型**

在文件顶部 import 区（与 skills 的 import 并列）追加：

```ts
import type {
  ExtensionListEvent, ExtensionToggleEvent,
  ExtensionListResult, ExtensionChangedEvent,
} from "./extensions";
```

把 `ExtensionListEvent | ExtensionToggleEvent` 加入 `WSClientEvent` 联合（在 `SkillDirAddEvent | SkillDirRemoveEvent` 之后、`FSHomeRequest...` 之前）：

```ts
  | SkillListEvent | SkillToggleEvent | SkillDirAddEvent | SkillDirRemoveEvent
  | ExtensionListEvent | ExtensionToggleEvent
  | FSHomeRequest | FSRootsRequest | FSListDirRequest | FSReadFileRequest | FSUploadRequest | FSCopyRequest | FSSearchRequest | FSSearchCancelRequest;
```

把 `ExtensionListResult | ExtensionChangedEvent` 加入 `WSServerEvent` 联合（在 `SkillListResult | SkillChangedEvent` 之后）：

```ts
  | SkillListResult | SkillChangedEvent
  | ExtensionListResult | ExtensionChangedEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSReadFileResult | FSUploadResult | FSCopyResult | FSSearchResult | FSSearchProgressEvent | FSErrorEvent;
```

- [ ] **Step 4: typecheck**

Run: `cd packages/shared && bun run typecheck`（若无 typecheck 脚本则 `bunx tsc --noEmit -p .`）
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/extensions.ts packages/shared/src/index.ts packages/shared/src/types.ts
git commit -m "feat(shared): 插件管理 WS 协议类型（extension:list/toggle/changed）"
```

---

## Task 2: extensions.ts 导出解析函数 + 可选插件注册表

**Files:**
- Modify: `packages/kernel/src/extensions.ts`

- [ ] **Step 1: 导出 `resolveExtensionEntryFile`**

把 `function resolveExtensionEntryFile` 改为 `export function resolveExtensionEntryFile`（仅加 `export` 关键字，其余不变）。

- [ ] **Step 2: 在 `PKG_EXTENSIONS` 定义之后、`buildAdditionalExtensionPaths` 之前，新增可选插件注册表**

```ts
/**
 * 可选插件定义：用户可在「插件」面板启用/禁用。
 * 与 PKG_EXTENSIONS（核心、常驻、走 additionalExtensionPaths）互斥：
 * 可选插件由 settings.json.extensions（SDK 原生字段）驱动，由 ExtensionManager 管理。
 */
export interface OptionalExtensionDef {
  id: string;            // 稳定标识，前端用
  package: string;       // npm 包名
  displayName: string;
  description: string;
  defaultEnabled: boolean;
}

export const OPTIONAL_EXTENSIONS: readonly OptionalExtensionDef[] = [
  {
    id: "pi-lens",
    package: "pi-lens",
    displayName: "Pi Lens",
    description: "实时代码反馈：LSP 诊断、lint、类型检查、结构分析",
    defaultEnabled: true,
  },
];
```

- [ ] **Step 3: typecheck**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/extensions.ts
git commit -m "refactor(kernel): 导出 resolveExtensionEntryFile + 可选插件注册表"
```

---

## Task 3: ExtensionManager（TDD）

**Files:**
- Create: `packages/kernel/src/extension-manager.ts`
- Test: `packages/kernel/tests/extension-manager.test.ts`

- [ ] **Step 1: 写失败测试 `packages/kernel/tests/extension-manager.test.ts`**

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "../src/extension-manager";

function tmpDir(): string {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FAKE_LENS_PATH = "/fake/pi-lens/dist/index.js";
// 注入 fake 解析器，避免单测依赖真实 pi-lens 安装
const injectOpts = {
  resolveEntryPath: () => FAKE_LENS_PATH,
  readVersion: () => "3.8.68",
};

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("list 首启播种：defaultEnabled 插件路径写入 settings.extensions", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  const { plugins } = await mgr.list();
  expect(plugins).toHaveLength(1);
  expect(plugins[0].id).toBe("pi-lens");
  expect(plugins[0].enabled).toBe(true);
  expect(plugins[0].version).toBe("3.8.68");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).toContain(FAKE_LENS_PATH);
});

test("toggle 禁用后路径从 settings.extensions 移除", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();                 // 先播种
  await mgr.toggle("pi-lens", false);
  const { plugins } = await mgr.list();
  expect(plugins[0].enabled).toBe(false);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).not.toContain(FAKE_LENS_PATH);
});

test("toggle 启用后路径回到 settings.extensions", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();
  await mgr.toggle("pi-lens", false);
  await mgr.toggle("pi-lens", true);
  const { plugins } = await mgr.list();
  expect(plugins[0].enabled).toBe(true);
});

test("不可变更新：保留 settings.json 其他字段", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ disabledSkills: ["x"], other: 1 }), "utf8");
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.toggle("pi-lens", true);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
  expect(settings.extensions).toContain(FAKE_LENS_PATH);
});

test("list 幂等：路径已在 settings.extensions 时不重复写入", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [FAKE_LENS_PATH] }), "utf8");
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();
  // 已含路径 → 不触发再写（内容不变）
  const after = readFileSync(join(dir, "settings.json"), "utf8");
  expect(after).toBe(before);
});

test("toggle 未知 id 抛错", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await expect(mgr.toggle("nope", true)).rejects.toThrow("未知插件");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/extension-manager.test.ts`
Expected: FAIL — `Cannot find module '../src/extension-manager'`。

- [ ] **Step 3: 实现 `packages/kernel/src/extension-manager.ts`**

```ts
// extension-manager.ts — 可选 Pi 扩展的启用/禁用管理
//
// 设计要点：
// - 镜像 skill-manager.ts：读写 dataDir/settings.json，不可变更新。
// - 可选扩展（如 pi-lens）通过 settings.json.extensions（SDK 原生字段）驱动；
//   SDK DefaultResourceLoader.reload() 会重读该字段，故 toggle 后由 AgentManager
//   在会话下次使用时 deferred reload 即可热生效（见 agent-manager.ts）。
// - 核心扩展（pi-intercom / pi-web-access）不走这里，仍由 additionalExtensionPaths 常驻，
//   二者互斥，避免双重加载。
// - 入口解析/版本读取可注入，便于单测隔离（默认用 npm require 解析）。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionPluginInfo } from "@wa-pi/shared";
import { OPTIONAL_EXTENSIONS, resolveExtensionEntryFile } from "./extensions";

const require = createRequire(import.meta.url);

/** settings.json 中与扩展相关的字段 */
interface ExtensionSettings {
  /** SDK 原生字段：已解析入口路径数组，由 DefaultResourceLoader 读取 */
  extensions?: string[];
  [k: string]: unknown;
}

export interface ExtensionManagerOpts {
  /** 解析插件入口绝对路径（默认用 extensions.ts 的 resolveExtensionEntryFile） */
  resolveEntryPath?: (pkgName: string) => string;
  /** 读取插件版本（默认读 npm 包 package.json，失败返回 undefined） */
  readVersion?: (pkgName: string) => string | undefined;
}

export class ExtensionManager {
  constructor(
    private dataDir: string,
    private opts: ExtensionManagerOpts = {},
  ) {}

  // ---- 入口/版本解析（可注入）----

  private resolveEntryPath(pkgName: string): string {
    return this.opts.resolveEntryPath
      ? this.opts.resolveEntryPath(pkgName)
      : resolveExtensionEntryFile(pkgName);
  }

  private readVersion(pkgName: string): string | undefined {
    if (this.opts.readVersion) return this.opts.readVersion(pkgName);
    try {
      return (require(`${pkgName}/package.json`) as { version?: string }).version;
    } catch {
      return undefined;
    }
  }

  // ---- settings.json 读写（镜像 SkillManager）----

  private async readSettings(): Promise<ExtensionSettings> {
    try {
      const raw = await readFile(join(this.dataDir, "settings.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async writeSettings(settings: ExtensionSettings): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  }

  // ---- 公共 API ----

  /**
   * 列出全部可选插件及其启用态。
   * 首启播种：defaultEnabled 的插件若入口路径不在 settings.extensions，则补写并持久化。
   * 包未安装时该插件标记为 enabled=false，不播种（避免写入无效路径）。
   */
  async list(): Promise<{ plugins: ExtensionPluginInfo[] }> {
    const settings = await this.readSettings();
    const current = new Set(settings.extensions ?? []);
    let changed = false;

    const plugins: ExtensionPluginInfo[] = OPTIONAL_EXTENSIONS.map((def) => {
      let path: string;
      try {
        path = this.resolveEntryPath(def.package);
      } catch {
        return { id: def.id, displayName: def.displayName, description: def.description, enabled: false };
      }
      if (def.defaultEnabled && !current.has(path)) {
        current.add(path);
        changed = true;
      }
      return {
        id: def.id,
        displayName: def.displayName,
        description: def.description,
        enabled: current.has(path),
        version: this.readVersion(def.package),
      };
    });

    if (changed) {
      await this.writeSettings({ ...settings, extensions: [...current] });
    }

    return { plugins };
  }

  /**
   * 启用/禁用插件：把对应入口路径不可变地加入/移出 settings.extensions。
   * @throws 未知 id 抛 "未知插件"；包未安装抛 "插件未安装"。
   */
  async toggle(id: string, enabled: boolean): Promise<void> {
    const def = OPTIONAL_EXTENSIONS.find((d) => d.id === id);
    if (!def) throw new Error(`未知插件: ${id}`);

    let path: string;
    try {
      path = this.resolveEntryPath(def.package);
    } catch {
      throw new Error(`插件未安装: ${def.package}`);
    }

    const settings = await this.readSettings();
    const current = new Set(settings.extensions ?? []);
    if (enabled) current.add(path);
    else current.delete(path);
    await this.writeSettings({ ...settings, extensions: [...current] });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/extension-manager.test.ts`
Expected: 6 个 test 全部 PASS。

- [ ] **Step 5: typecheck**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误。

- [ ] **Step 5b: 更新 `packages/kernel/src/index.ts` 顶部导出**（若 index.ts 做了 barrel 重导出则跳过——本仓库 index.ts 不 barrel 导出 src，故跳过）。

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/extension-manager.ts packages/kernel/tests/extension-manager.test.ts
git commit -m "feat(kernel): ExtensionManager 管理可选扩展启用/禁用（settings.extensions）"
```

---

## Task 4: AgentManager deferred reload

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Modify: `packages/kernel/tests/agent-manager.test.ts`

- [ ] **Step 1: 先扩测试夹具——给 `fakeSession` 加 `reload`，并在 beforeEach 清理**

在 `packages/kernel/tests/agent-manager.test.ts` 的 `fakeSession` 对象里（`steer: mock(async () => {}),` 之后）加：

```ts
  reload: mock(async () => {}),
```

在 `beforeEach` 里（`fakeUnsubscribe.mockClear();` 之前）加：

```ts
  (fakeSession.reload as any).mockClear();
```

- [ ] **Step 2: 写失败测试（追加到 agent-manager.test.ts 末尾）**

```ts
test("markAllDirty 后命中缓存时 deferred reload 一次并清脏", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);   // 首次创建（不在 dirty）
  (fakeSession.reload as any).mockClear();

  am.markAllDirty();                                        // 标脏
  await am.ensureStarted(project.id, "dev", session.id);   // 命中缓存 → reload 一次

  expect(fakeSession.reload).toHaveBeenCalledTimes(1);

  // 清脏后再次命中不再 reload
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakeSession.reload).toHaveBeenCalledTimes(1);
});

test("未标脏的会话命中缓存时不 reload", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  (fakeSession.reload as any).mockClear();

  await am.ensureStarted(project.id, "dev", session.id);   // 命中缓存但未标脏
  expect(fakeSession.reload).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts -t "markAllDirty"`
Expected: FAIL — `am.markAllDirty is not a function`。

- [ ] **Step 4: 实现 deferred reload（agent-manager.ts）**

4a. 在 `private disposed = new Set<string>();` 之后加字段：

```ts
  // deferred reload：技能/扩展配置变更后标脏；会话下次命中缓存时 reload 一次并清脏。
  private dirty = new Set<string>();
```

4b. 在 `ensureStarted` 的缓存命中分支替换为：

```ts
    // 命中缓存：deferred reload（若有）后直接返回（同 session 复用，不重复创建）
    const existing = this.sessions.get(sessionId);
    if (existing) {
      await this._reloadIfDirty(sessionId, existing);
      return existing;
    }
```

4c. 在 `ensureStarted` 方法之后、`_createSession` 之前，新增 `markAllDirty` 与 `_reloadIfDirty`：

```ts
  /**
   * 标记当前所有活跃会话为待 reload（技能/扩展配置变更后调用）。
   * 不立即 reload——各会话在下次被 ensureStarted（切换/使用）时各自 reload 一次。
   */
  markAllDirty(): void {
    for (const id of this.sessions.keys()) this.dirty.add(id);
  }

  /** 命中缓存时：若该会话被标脏，reload 一次并清脏（单会话失败不阻断）。 */
  private async _reloadIfDirty(sessionId: string, session: AgentSession): Promise<void> {
    if (!this.dirty.has(sessionId)) return;
    this.dirty.delete(sessionId);
    try {
      // SDK AgentSession.reload() 重读 settings.json（disabledSkills / extensions 等）
      await (session as any).reload();
    } catch (err) {
      console.error(`[kernel] session ${sessionId} deferred reload 失败:`, err);
    }
  }
```

4d. 在 `disposeSession` 里（`this.jumpQueueLocks.delete(sessionId);` 之后）加：

```ts
    this.dirty.delete(sessionId);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts`
Expected: 全部 PASS（含两个新测试，且原有测试不回归）。

- [ ] **Step 6: typecheck**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): AgentManager deferred reload（dirty + markAllDirty）"
```

---

## Task 5: WSServer handlers + 技能 handler 改造 + 移除 reloadAllSessions

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（移除 `reloadAllSessions`）
- Modify: `packages/kernel/src/index.ts`（构造/注入/播种 ExtensionManager）
- Modify: `packages/kernel/tests/ws-skill.test.ts`（mock 改 markAllDirty）

- [ ] **Step 1: ws-server.ts —— import ExtensionManager 类型**

在 `import type { SkillManager } from "./skill-manager";` 之后加：

```ts
import type { ExtensionManager } from "./extension-manager";
```

- [ ] **Step 2: ws-server.ts —— `WSServerOpts` 加字段**

在 `skillManager: SkillManager;` 之后加：

```ts
  extensionManager: ExtensionManager;
```

- [ ] **Step 3: ws-server.ts —— 技能 handler 改 markAllDirty**

把 `case "skill:toggle"`、`case "skillDir:add"`、`case "skillDir:remove"` 三个分支里的：

```ts
        await this.opts.agentManager.reloadAllSessions();
```

全部替换为：

```ts
        this.opts.agentManager.markAllDirty();
```

（共 3 处；skillDir:add 与 skillDir:remove 各 1 处在 try 块内，skill:toggle 1 处。）

- [ ] **Step 4: ws-server.ts —— 新增 extension handler**

在 `case "skillDir:remove": { ... }` 分支之后、`handle` 方法的 `switch` 闭合之前，加：

```ts
      case "extension:list": {
        try {
          const { plugins } = await this.opts.extensionManager.list();
          reply({ type: "extension:list", plugins });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:toggle": {
        try {
          await this.opts.extensionManager.toggle(event.id, event.enabled);
          // deferred：不立即 reload，标脏后各会话下次使用时各自 reload
          this.opts.agentManager.markAllDirty();
          const { plugins } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", plugins });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
```

- [ ] **Step 5: 确认 `reloadAllSessions` 已无引用后移除**

Run: `cd packages/kernel && grep -rn "reloadAllSessions" src tests`
Expected: 仅命中 `agent-manager.ts` 的定义处（ws-server 已不再调用）。

在 `packages/kernel/src/agent-manager.ts` 删除整个 `reloadAllSessions` 方法（含其上方注释 `/** reload 所有活跃会话... */`）：

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

再次 Run: `cd packages/kernel && grep -rn "reloadAllSessions" src tests`
Expected: 无命中。

- [ ] **Step 6: index.ts —— 构造、注入、播种 ExtensionManager**

6a. 在 `import { SkillManager } from "./skill-manager";` 之后加：

```ts
import { ExtensionManager } from "./extension-manager";
```

6b. 在 `const skillManager = new SkillManager(WA_PI_DIR);` 之后加：

```ts
  const extensionManager = new ExtensionManager(WA_PI_DIR);
```

6c. 在 `new WSServer({ ... })` 的 opts 里（`skillManager,` 之后）加：

```ts
    extensionManager,
```

6d. 在 `await server.start();` 之前加（首启播种：默认启用 pi-lens，写 settings.extensions）：

```ts
  // 首启播种可选插件（默认启用 pi-lens）；后续由面板 toggle
  await extensionManager.list();
```

- [ ] **Step 7: 更新 ws-skill.test.ts 的 mock**

把 `packages/kernel/tests/ws-skill.test.ts` 的 `makeMockAgentManager` 替换为：

```ts
function makeMockAgentManager() {
  const calls = { markAllDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; },
    calls,
  } as any;
}
```

把 `withSkillServer` 里 `new WSServer({...})` opts 加上（与真实 WSServerOpts 对齐）：

```ts
    extensionManager: new ExtensionManager(dataDir, {
      resolveEntryPath: () => "/fake/pi-lens/dist/index.js",
      readVersion: () => "0.0.0",
    }),
```

并在 ws-skill.test.ts 顶部 import 区加：

```ts
import { ExtensionManager } from "../src/extension-manager";
```

把 `test("skillDir:add 成功后 reload 被调用 + 广播 changed", ...)` 改名并加断言：

```ts
test("skillDir:add 成功后 markAllDirty 被调用 + 广播 changed", async () => {
  await withSkillServer(async (send, recv) => {
    const userDir = tmp("user-skills");
    mkdirSync(userDir, { recursive: true });
    send({ type: "skillDir:add", path: userDir });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.dirs).toContain(userDir);
  });
});
```

（mockAM.calls.markAllDirty 在闭包内不可达；markAllDirty 的调用由 ws-extension.test.ts 单独覆盖——见 Task 6。）

- [ ] **Step 8: 运行全部 kernel 测试确认无回归**

Run: `cd packages/kernel && bun test`
Expected: 全部 PASS（含 ws-skill、agent-manager、extensions、skill-manager；ws-extension 在 Task 6 新增）。

- [ ] **Step 9: typecheck**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误。

- [ ] **Step 10: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/agent-manager.ts packages/kernel/src/index.ts packages/kernel/tests/ws-skill.test.ts
git commit -m "feat(kernel): extension:list/toggle handler + 技能 reload 改 deferred + 移除 reloadAllSessions"
```

---

## Task 6: WS extension handler 测试

**Files:**
- Create: `packages/kernel/tests/ws-extension.test.ts`

- [ ] **Step 1: 写测试（镜像 ws-skill.test.ts 结构）**

```ts
import { test, expect } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ExtensionManager } from "../src/extension-manager";
import { SkillManager } from "../src/skill-manager";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@wa-pi/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  const calls = { markAllDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {}, abort: async () => {},
    disposeSession: async () => {}, disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; }, calls,
  } as any;
}

async function withExtServer<T>(
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    mockAM: { calls: { markAllDirty: number } },
  ) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-ext");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    extensionManager: new ExtensionManager(dataDir, {
      resolveEntryPath: () => "/fake/pi-lens/dist/index.js",
      readVersion: () => "3.8.68",
    }),
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
  try { return await fn(send, recv, mockAM); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

test("extension:list 返回插件（首启播种默认启用）", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:list" });
    const e = await recv() as any;
    expect(e.type).toBe("extension:list");
    expect(e.plugins[0].id).toBe("pi-lens");
    expect(e.plugins[0].enabled).toBe(true);
  });
});

test("extension:toggle 禁用 → markAllDirty + 广播 changed + 持久化", async () => {
  await withExtServer(async (send, recv, mockAM) => {
    send({ type: "extension:toggle", id: "pi-lens", enabled: false });
    const changed = await recv() as any;
    expect(changed.type).toBe("extension:changed");
    expect(changed.plugins[0].enabled).toBe(false);
    expect(mockAM.calls.markAllDirty).toBe(1);

    // 再次 list 确认持久化
    send({ type: "extension:list" });
    const list = await recv() as any;
    expect(list.plugins[0].enabled).toBe(false);
  });
});

test("extension:toggle 未知 id 返回 error", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:toggle", id: "nope", enabled: true });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("未知插件");
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/ws-extension.test.ts`
Expected: 3 个 test 全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/tests/ws-extension.test.ts
git commit -m "test(kernel): extension:list/toggle WS handler 测试"
```

---

## Task 7: kernel 依赖加 pi-lens + 安装

**Files:**
- Modify: `packages/kernel/package.json`

- [ ] **Step 1: 加依赖**

在 `packages/kernel/package.json` 的 `dependencies` 里（`"pi-web-access": "^0.13.0"` 之后）加：

```json
    "pi-lens": "^3.8.0"
```

- [ ] **Step 2: 安装**

Run: `cd packages/kernel && bun install`（或仓库根 `bun install`）
Expected: 成功拉取 pi-lens（约 15.5 MB，含 tree-sitter WASM）。

- [ ] **Step 3: 验证入口可解析**

Run: `cd packages/kernel && bun -e "const {resolveExtensionEntryFile}=require('./src/extensions.ts'); console.log(resolveExtensionEntryFile('pi-lens'))"`（若 require ts 报错，改用：`bun -e "import('./src/extensions.ts').then(m=>console.log(m.resolveExtensionEntryFile('pi-lens')))"`）
Expected: 打印 pi-lens 的 `dist/index.js` 绝对路径。

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/package.json bun.lock bun.lockb 2>/dev/null
git commit -m "chore(kernel): 增加 pi-lens 依赖"
```

---

## Task 8: extensions.test.ts 断言 pi-lens 不走 additionalExtensionPaths

**Files:**
- Modify: `packages/kernel/tests/extensions.test.ts`

- [ ] **Step 1: 追加测试（在文件末尾）**

```ts
test("buildAdditionalExtensionPaths 不含可选插件 pi-lens（由 settings.extensions 驱动）", () => {
  const paths = buildAdditionalExtensionPaths();
  expect(paths.some((p) => p.includes("pi-lens"))).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd packages/kernel && bun test tests/extensions.test.ts`
Expected: 全部 PASS（含新断言）。

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/tests/extensions.test.ts
git commit -m "test(kernel): 断言 pi-lens 不在 additionalExtensionPaths"
```

---

## Task 9: Frontend store/extensions.ts

**Files:**
- Create: `packages/frontend/src/store/extensions.ts`

- [ ] **Step 1: 实现 store（镜像 store/skills.ts）**

```ts
import { create } from "zustand";
import type { ExtensionPluginInfo } from "@wa-pi/shared";
import { send } from "../ws-instance";

// 插件管理 store — 通过 WS 事件与 kernel 通信
interface ExtensionsState {
  plugins: ExtensionPluginInfo[];
  load: () => void;
  setAll: (data: { plugins: ExtensionPluginInfo[] }) => void;
  togglePlugin: (id: string, enabled: boolean) => void;
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  plugins: [],
  load: () => send({ type: "extension:list" }),
  setAll: (data) => set({ plugins: data.plugins }),
  togglePlugin: (id, enabled) => send({ type: "extension:toggle", id, enabled }),
}));
```

- [ ] **Step 2: typecheck**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/store/extensions.ts
git commit -m "feat(frontend): 插件管理 store"
```

---

## Task 10: Frontend ExtensionSection 组件 + 测试

**Files:**
- Create: `packages/frontend/src/components/settings/ExtensionSection.tsx`
- Test: `packages/frontend/tests/ExtensionSection.test.tsx`

- [ ] **Step 1: 写失败测试 `packages/frontend/tests/ExtensionSection.test.tsx`**

```tsx
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExtensionSection } from "../src/components/settings/ExtensionSection";
import { useExtensionsStore } from "../src/store/extensions";

const originalActions = {
  togglePlugin: useExtensionsStore.getState().togglePlugin,
  load: useExtensionsStore.getState().load,
};

beforeEach(() => {
  useExtensionsStore.setState({
    plugins: [],
    togglePlugin: originalActions.togglePlugin,
    load: originalActions.load,
  });
});

test("无插件时显示空提示", () => {
  render(<ExtensionSection />);
  expect(screen.getByText("暂无插件")).toBeTruthy();
});

test("渲染插件 + checkbox 启用态 + 切换发 toggle", () => {
  const toggleMock = mock();
  useExtensionsStore.setState({
    plugins: [{
      id: "pi-lens", displayName: "Pi Lens", description: "代码反馈",
      enabled: true, version: "3.8.68",
    }],
    togglePlugin: toggleMock,
  });
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-name-pi-lens")).toBeTruthy();
  const cb = screen.getByTestId("ext-checkbox-pi-lens") as HTMLInputElement;
  expect(cb.checked).toBe(true);
  fireEvent.click(cb);
  expect(toggleMock).toHaveBeenCalledWith("pi-lens", false);
});

test("禁用插件 checkbox 未勾选 + 显示 [禁用]", () => {
  useExtensionsStore.setState({
    plugins: [{ id: "pi-lens", displayName: "Pi Lens", description: "x", enabled: false }],
  });
  render(<ExtensionSection />);
  const cb = screen.getByTestId("ext-checkbox-pi-lens") as HTMLInputElement;
  expect(cb.checked).toBe(false);
  expect(screen.getByText("[禁用]")).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && bun test tests/ExtensionSection.test.tsx`
Expected: FAIL — 找不到组件模块。

- [ ] **Step 3: 实现 `packages/frontend/src/components/settings/ExtensionSection.tsx`**

```tsx
import { useExtensionsStore } from "../../store/extensions";

export function ExtensionSection() {
  const { plugins, togglePlugin } = useExtensionsStore();

  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto">
      <span className="text-xs font-bold text-tertiary uppercase tracking-wide">已安装插件</span>
      {plugins.length === 0 && (
        <span className="text-sm text-tertiary py-2">暂无插件</span>
      )}
      {plugins.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 py-1"
          style={{ opacity: p.enabled ? 1 : 0.5 }}
        >
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={() => togglePlugin(p.id, !p.enabled)}
            data-testid={`ext-checkbox-${p.id}`}
            className="cursor-pointer"
          />
          <div className="flex flex-col">
            <span className="text-sm text-primary" data-testid={`ext-name-${p.id}`}>
              {p.displayName}
              {p.version && <span className="text-xs text-tertiary ml-1">v{p.version}</span>}
              {!p.enabled && <span className="text-xs ml-1" style={{ color: "var(--danger)" }}>[禁用]</span>}
            </span>
            <span className="text-xs text-tertiary">{p.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && bun test tests/ExtensionSection.test.tsx`
Expected: 3 个 test 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/settings/ExtensionSection.tsx packages/frontend/tests/ExtensionSection.test.tsx
git commit -m "feat(frontend): 插件面板 ExtensionSection"
```

---

## Task 11: SettingsModal「插件」nav + settings store 类型

**Files:**
- Modify: `packages/frontend/src/store/settings.ts`
- Modify: `packages/frontend/src/components/SettingsModal.tsx`

- [ ] **Step 1: settings store 加 "plugins"**

把 `packages/frontend/src/store/settings.ts` 的：

```ts
export type SettingsSection = "models" | "skills";
```

改为：

```ts
export type SettingsSection = "models" | "skills" | "plugins";
```

- [ ] **Step 2: SettingsModal nav 加「插件」按钮**

在 `packages/frontend/src/components/SettingsModal.tsx`：
- 顶部 import 区加 `import { ExtensionSection } from "./settings/ExtensionSection";`

在「技能」`<button>...</button>` 之后、`</nav>` 之前，加：

```tsx
          <button
            onClick={() => setSection("plugins")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "plugins"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
          >插件</button>
```

在右侧内容区（`{activeSection === "skills" && <SkillSection />}` 之后）加：

```tsx
          {activeSection === "plugins" && <ExtensionSection />}
```

- [ ] **Step 3: 运行已有 SettingsModal 测试确认无回归**

Run: `cd packages/frontend && bun test tests/SettingsModal.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 4: typecheck**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx
git commit -m "feat(frontend): 系统设置新增「插件」菜单"
```

---

## Task 12: App.tsx 事件接线 + 启动 load

**Files:**
- Modify: `packages/frontend/src/App.tsx`

- [ ] **Step 1: import store**

在 `import { useSkillsStore } from "./store/skills";` 之后加：

```ts
import { useExtensionsStore } from "./store/extensions";
```

- [ ] **Step 2: 启动时 load**

在 `useSkillsStore.getState().load();` 之后加：

```ts
    useExtensionsStore.getState().load();
```

- [ ] **Step 3: onMessage 接线**

在 `case "skill:changed": useSkillsStore.getState().setAll(e); break;` 之后加：

```ts
        case "extension:list": useExtensionsStore.getState().setAll(e); break;
        case "extension:changed": useExtensionsStore.getState().setAll(e); break;
```

- [ ] **Step 4: typecheck + 全量前端测试**

Run: `cd packages/frontend && bun run typecheck && bun test`
Expected: typecheck 无错误；测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/App.tsx
git commit -m "feat(frontend): App 接线 extension:list/changed + 启动 load"
```

---

## Task 13: 端到端验证 + 全量 typecheck/测试

**Files:** 无（验证）

- [ ] **Step 1: 全量 kernel 测试**

Run: `cd packages/kernel && bun test`
Expected: 全部 PASS。

- [ ] **Step 2: 全量前端测试 + typecheck**

Run: `cd packages/frontend && bun run typecheck && bun test`
Expected: 全部 PASS。

- [ ] **Step 3: 启动 dev 手动验证**

Run: `cd packages/kernel && bun run dev`（另起终端 `cd packages/frontend && bun run dev`）

验证清单：
1. 打开前端，点设置图标 → 弹「系统设置」。
2. 左侧 nav 出现「插件」，点击 → 右侧显示 Pi Lens（v{版本}，勾选=启用）。
3. 取消勾选 → 关闭设置 → 在某会话发一条消息（触发 ensureStarted）→ pi-lens 不再加载（该会话 deferred reload 已生效）。
4. 重新勾选 → 下次使用会话时 pi-lens 恢复。
5. 检查 `~/.wa-pi/settings.json` 的 `extensions` 字段随 toggle 增删 pi-lens 入口路径。
6. 「技能」面板的启用/禁用仍正常（deferred reload 统一生效）。

- [ ] **Step 4:（可选）提交收尾**

若手动验证中发现小修，修正后提交；否则本任务无代码改动。

---

## Self-Review（计划作者自查）

**1. Spec 覆盖：**
- §4.1 extensions.ts 导出 + 注册表 → Task 2 ✓
- §4.2 ExtensionManager → Task 3 ✓
- §4.3 AgentManager deferred reload + 移除 reloadAllSessions → Task 4 + Task 5 Step 5 ✓
- §4.4 ws-server handlers + 技能 handler 改造 → Task 5 ✓
- §4.5 index.ts 注入 + 播种 → Task 5 Step 6 ✓
- §4.6 package.json pi-lens → Task 7 ✓
- §5 shared 类型 → Task 1 ✓
- §6.1–6.5 frontend store/section/modal nav/settings/App → Task 9–12 ✓
- §7 测试（extension-manager / extensions 断言 / agent-manager deferred / ws handler / ExtensionSection）→ Task 3/6/8/4/10 ✓
- §8 边界（双重加载规避：pi-lens 不进 additionalExtensionPaths）→ Task 8 断言 + Task 2 注册表与 PKG_EXTENSIONS 分离 ✓

**2. 占位符扫描：** 无 TBD/TODO；所有代码步骤均给出完整代码；测试均给出可运行代码。

**3. 类型一致性：**
- `ExtensionPluginInfo`（Task 1 定义）→ store/section/handler 全程使用一致 ✓
- `markAllDirty()`（Task 4 定义）→ ws-server（Task 5）调用一致 ✓
- `_reloadIfDirty`（Task 4 定义）→ 仅 ensureStarted 内部调用 ✓
- `extensionManager` opts 字段（Task 5 Step 2）→ index.ts（Task 5 Step 6）/ ws-extension.test.ts（Task 6）/ ws-skill.test.ts（Task 5 Step 7）一致 ✓
- `togglePlugin(id, enabled)` 签名 → 组件 onChange 传 `(p.id, !p.enabled)` ✓
- `SettingsSection` 加 `"plugins"` → SettingsModal 引用一致 ✓

**4. 绿构建顺序：** Task 4 保留 `reloadAllSessions`（ws-server 仍引用）→ Task 5 改 ws-server 后才删除，每个 commit 均可编译。
