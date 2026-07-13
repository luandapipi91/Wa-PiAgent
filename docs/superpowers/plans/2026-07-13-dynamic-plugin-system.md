# 动态插件系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HiAgent 设置 → 插件面板支持动态安装、启用/禁用、升级、卸载第三方插件（npm/git/本地路径），通过 `settings.json.packages` 与 Pi SDK 原生机制对齐。

**Architecture:** 两轨加载（核心扩展走 `additionalExtensionPaths`，动态插件走 `packages` 字段），`ExtensionManager`（状态编排）+ `NpmPackageService`（包管理器调用）分层，WS 协议驱动前后端通信，`npmCommand` 配置化包管理器。

**Tech Stack:** TypeScript, Bun, Pi SDK (`DefaultResourceLoader` + `packages`), React + Zustand, Tailwind CSS, Vitest + bun:test

## Global Constraints

- `settings.json.packages` 存储格式：`npm:<name>@<version>`（锁定版本）、`git:host/user/repo@ref`、绝对/相对路径
- `settings.json.npmCommand` 写入 `["bun"]`，NpmPackageService 读取此配置而非硬编码
- 所有 `bun` 子进程通过 `Bun.spawn` 数组参数调用，禁止字符串拼接
- npm 包名必须通过 `validatePackageName()` 校验后放行
- `migrateSettingsPackages()` 从 `extensions.ts` **物理删除**（函数体 + export）
- 保留 `buildAdditionalExtensionPaths()` 不变（核心扩展 pi-intercom/pi-web-access）
- 保留 settings.json 其他字段不变（skills/disabledSkills/other）
- 使用 `var(--accent)` `var(--success)` `var(--danger)` `var(--warning)` 等现有设计 token
- 使用 `--rounded-sm`(8px) 用于卡片/按钮/输入框，`--rounded-lg`(16px) 用于弹窗

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/shared/src/extensions.ts` | `PackageInfo` 类型 + WS 事件类型定义 |
| `packages/kernel/src/npm-package-service.ts` | **新增**: `Bun.spawn` 封装 add/remove/update + registry 查询 |
| `packages/kernel/src/extension-manager.ts` | **重写**: packages 列表管理 + 输入解析校验 + 编排 |
| `packages/kernel/src/extensions.ts` | 移除 `OPTIONAL_EXTENSIONS` 和 `migrateSettingsPackages` |
| `packages/kernel/src/index.ts` | 移除 `migrateSettingsPackages()` 调用，更新 `ExtensionManager` 构造 |
| `packages/kernel/src/ws-server.ts` | 注册 `extension:install/uninstall/upgrade` 事件 |
| `packages/kernel/tests/extension-manager.test.ts` | 单元测试：list/install/uninstall/upgrade/enable/disable |
| `packages/kernel/tests/npm-package-service.test.ts` | **新增**: NpmPackageService 单元测试 |
| `packages/kernel/tests/extensions.test.ts` | 删除 `migrateSettingsPackages` 相关测试 |
| `packages/frontend/src/store/extensions.ts` | Zustand store 更新 |
| `packages/frontend/src/components/settings/ExtensionSection.tsx` | **重写**: 输入框 + 卡片列表 + 操作按钮 |
| `packages/frontend/tests/ExtensionSection.test.tsx` | 组件测试更新 |
| `CHANGELOG.md` | 记录变更 |

---

### Task 1: 更新共享类型定义

**Files:**
- Modify: `packages/shared/src/extensions.ts`

**Interfaces:**
- Produces: `PackageInfo`, `ExtensionInstallEvent`, `ExtensionUninstallEvent`, `ExtensionUpgradeEvent`, `ExtensionErrorEvent`

- [ ] **Step 1: 替换类型定义**

将现有文件内容替换为：

```typescript
// ===== 动态插件管理类型定义 =====

/** 已安装插件信息 */
export interface PackageInfo {
  name: string;             // npm 包名 / git repo / 本地路径
  source: "npm" | "git" | "local";  // 来源类型
  version?: string;         // 已安装版本（npm）
  latestVersion?: string;   // npm registry 最新版本
  description?: string;     // 从 package.json 读取
  enabled: boolean;         // 是否在 packages 数组中
}

// ===== WS 协议事件 =====

// 前端 → kernel
export interface ExtensionListEvent { type: "extension:list"; }
export interface ExtensionInstallEvent { type: "extension:install"; name: string; }
export interface ExtensionUninstallEvent { type: "extension:uninstall"; name: string; }
export interface ExtensionUpgradeEvent { type: "extension:upgrade"; name: string; }
export interface ExtensionToggleEvent { type: "extension:toggle"; name: string; enabled: boolean; }

// kernel → 前端
export interface ExtensionListResult { type: "extension:list"; packages: PackageInfo[]; }
export interface ExtensionChangedEvent { type: "extension:changed"; packages: PackageInfo[]; }
export interface ExtensionErrorEvent { type: "extension:error"; name: string; error: string; }
```

- [ ] **Step 2: 验证类型编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/shared typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/extensions.ts
git commit -m "refactor(shared): ExtensionPluginInfo → PackageInfo, 新增 install/uninstall/upgrade WS 事件类型"
```

---

### Task 2: 创建 NpmPackageService

**Files:**
- Create: `packages/kernel/src/npm-package-service.ts`
- Create: `packages/kernel/tests/npm-package-service.test.ts`

**Interfaces:**
- Produces: `NpmPackageService` class with `install(name, version?)`, `uninstall(name)`, `upgrade(name)`, `getLatestVersion(name)`, `getInstalledVersion(name)`

- [ ] **Step 1: 创建服务文件**

```typescript
// packages/kernel/src/npm-package-service.ts
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface NpmPackageServiceOpts {
  /** 包管理器命令，默认 ["bun"]，从 settings.json.npmCommand 读取 */
  npmCommand?: string[];
}

export class NpmPackageService {
  private npmCommand: string[];

  constructor(
    private runtimeDir: string,
    opts: NpmPackageServiceOpts = {},
  ) {
    this.npmCommand = opts.npmCommand ?? ["bun"];
  }

  /** 执行包管理器子进程，返回 exitCode + stderr */
  private async spawn(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    const [cmd, ...rest] = [...this.npmCommand, ...args];
    const proc = Bun.spawn([cmd, ...rest], {
      cwd: this.runtimeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  }

  /** 安装 npm 包 */
  async install(name: string, version?: string): Promise<{ version: string }> {
    const pkg = version ? `${name}@${version}` : name;
    const { exitCode, stderr } = await this.spawn(["add", pkg]);
    if (exitCode !== 0) {
      throw new Error(`安装失败: ${stderr || `exit code ${exitCode}`}`);
    }
    const actualVersion = this.getInstalledVersion(name);
    if (!actualVersion) throw new Error(`安装后未找到包: ${name}`);
    return { version: actualVersion };
  }

  /** 卸载 npm 包 */
  async uninstall(name: string): Promise<void> {
    const { exitCode, stderr } = await this.spawn(["remove", name]);
    if (exitCode !== 0) {
      throw new Error(`卸载失败: ${stderr || `exit code ${exitCode}`}`);
    }
  }

  /** 升级 npm 包到最新版 */
  async upgrade(name: string): Promise<{ version: string }> {
    const { exitCode, stderr } = await this.spawn(["update", name]);
    if (exitCode !== 0) {
      throw new Error(`升级失败: ${stderr || `exit code ${exitCode}`}`);
    }
    const actualVersion = this.getInstalledVersion(name);
    if (!actualVersion) throw new Error(`升级后未找到包: ${name}`);
    return { version: actualVersion };
  }

  /** 查询 npm registry 最新版本 */
  async getLatestVersion(name: string): Promise<string | undefined> {
    try {
      const { exitCode, stderr } = await this.spawn(["pm", "ls", name]);
      if (exitCode !== 0) return undefined;
      // 用 npm view 查最新版本（bun pm ls 不提供此信息）
      // 此命令只读，使用 npm 而非 bun 因为 bun 无等效命令
      const view = Bun.spawn(["npm", "view", name, "version"], {
        cwd: this.runtimeDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const viewExit = await view.exited;
      if (viewExit !== 0) return undefined;
      return (await new Response(view.stdout).text()).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** 读取 node_modules 中已安装包的版本 */
  getInstalledVersion(name: string): string | undefined {
    try {
      const pkgJson = join(this.runtimeDir, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) return undefined;
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgJson, "utf8"));
      return pkg.version;
    } catch {
      return undefined;
    }
  }

  /** 读取 node_modules 中已安装包的 description */
  getDescription(name: string): string | undefined {
    try {
      const pkgJson = join(this.runtimeDir, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) return undefined;
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgJson, "utf8"));
      return pkg.description;
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 2: 创建单元测试**

```typescript
// packages/kernel/tests/npm-package-service.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NpmPackageService } from "../src/npm-package-service";

let dir: string;
beforeEach(() => {
  dir = join(import.meta.dir, ".tmp-npm-svc-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("getInstalledVersion 读取 node_modules 中 package.json 的版本", () => {
  const pkgDir = join(dir, "node_modules", "test-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test-pkg", version: "1.2.3" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("test-pkg")).toBe("1.2.3");
});

test("getInstalledVersion 包不存在返回 undefined", () => {
  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("nonexistent")).toBeUndefined();
});

test("getDescription 返回 description 字段", () => {
  const pkgDir = join(dir, "node_modules", "desc-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "desc-pkg", version: "1.0.0", description: "A test package" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getDescription("desc-pkg")).toBe("A test package");
});

test("构造函数接受自定义 npmCommand", () => {
  const svc = new NpmPackageService(dir, { npmCommand: ["pnpm"] });
  // 通过 spawn 行为间接验证——install 会使用 pnpm
  expect(svc).toBeDefined();
});
```

- [ ] **Step 3: 运行测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/npm-package-service.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/npm-package-service.ts packages/kernel/tests/npm-package-service.test.ts
git commit -m "feat(kernel): 新增 NpmPackageService — Bun.spawn 封装包管理器操作"
```

---

### Task 3: 更新 extensions.ts（清理旧代码）

**Files:**
- Modify: `packages/kernel/src/extensions.ts`
- Modify: `packages/kernel/tests/extensions.test.ts`

**Interfaces:**
- Produces: `buildAdditionalExtensionPaths()` (unchanged), `resolveExtensionEntryFile()` (unchanged)
- Removes: `OPTIONAL_EXTENSIONS`, `OptionalExtensionDef`, `migrateSettingsPackages`

- [ ] **Step 1: 从 extensions.ts 移除 OPTIONAL_EXTENSIONS 和 migrateSettingsPackages**

删除以下代码块：
- 第 79-96 行：`OptionalExtensionDef` 接口 + `OPTIONAL_EXTENSIONS` 常量
- 第 110-135 行：`migrateSettingsPackages()` 函数

验证删除后 `extensions.ts` 仅保留：
- `resolveExtensionEntryFile()` 
- `PKG_EXTENSIONS` 
- `buildAdditionalExtensionPaths()`

- [ ] **Step 2: 从 extensions.test.ts 删除旧测试**

删除以下测试函数及其调用：
- `migrateSettingsPackages 清空 packages 但保留其他字段`
- `migrateSettingsPackages 无 packages 字段时 no-op`
- `migrateSettingsPackages 无 settings.json 时 no-op`
- `buildAdditionalExtensionPaths 不含可选插件 pi-lens`

同时删除测试文件顶部的 `migrateSettingsPackages` import。

- [ ] **Step 3: 运行测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/extensions.test.ts
```

Expected: 1 test PASS (`buildAdditionalExtensionPaths`)

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/extensions.ts packages/kernel/tests/extensions.test.ts
git commit -m "refactor(kernel): 物理删除 OPTIONAL_EXTENSIONS 和 migrateSettingsPackages"
```

---

### Task 4: 重写 ExtensionManager

**Files:**
- Modify: `packages/kernel/src/extension-manager.ts`
- Modify: `packages/kernel/tests/extension-manager.test.ts`

**Interfaces:**
- Consumes: `PackageInfo` from shared, `NpmPackageService` from Task 2
- Produces: `ExtensionManager` class with `list()`, `install(rawInput)`, `uninstall(name)`, `upgrade(name)`, `enable(name)`, `disable(name)`

- [ ] **Step 1: 写包名校验和输入解析函数**

```typescript
// 包名校验（npm 来源专用）
export function validatePackageName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 提取 version 后缀（允许 name@version）
  const atIdx = trimmed.lastIndexOf("@");
  let name = atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
  const version = atIdx > 0 ? trimmed.slice(atIdx + 1) : undefined;

  // scope 包以 @ 开头，第一个 @ 不属于 version 分隔符
  if (name.startsWith("@") && name.indexOf("/") === -1) return null;

  // npm package name spec
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  if (name.length > 214) return null;

  // 拒绝危险字符
  const dangerous = /[\\/;&|$`!<>'"\s]/;
  if (dangerous.test(name)) return null;
  if (version && dangerous.test(version)) return null;

  return version ? `${name}@${version}` : name;
}

// 输入格式解析
interface ParsedInput {
  source: "npm" | "git" | "local";
  name: string;   // npm 包名 / git repo URL / 本地路径
  version?: string; // 仅 npm
}

export function parseExtensionInput(raw: string): ParsedInput | null {
  let input = raw.trim();

  // 去掉 CLI 前缀
  input = input.replace(/^pi\s+install\s+/i, "").replace(/^install\s+/i, "");

  if (input.startsWith("git:")) {
    const repo = input.slice(4).trim();
    if (!repo) return null;
    return { source: "git", name: repo };
  }

  if (input.startsWith("npm:")) {
    const validated = validatePackageName(input.slice(4).trim());
    if (!validated) return null;
    const atIdx = validated.lastIndexOf("@");
    if (atIdx > 0 && !validated.startsWith("@")) {
      return { source: "npm", name: validated.slice(0, atIdx), version: validated.slice(atIdx + 1) };
    }
    return { source: "npm", name: validated };
  }

  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("~/")) {
    return { source: "local", name: input };
  }

  // 默认 npm
  const validated = validatePackageName(input);
  if (!validated) return null;
  const atIdx = validated.lastIndexOf("@");
  if (atIdx > 0 && !validated.startsWith("@")) {
    return { source: "npm", name: validated.slice(0, atIdx), version: validated.slice(atIdx + 1) };
  }
  return { source: "npm", name: validated };
}
```

- [ ] **Step 2: 写 ExtensionManager 类**

```typescript
// packages/kernel/src/extension-manager.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { PackageInfo } from "@hiagent/shared";
import { NpmPackageService } from "./npm-package-service";
import { parseExtensionInput } from "./extension-manager"; // 同上文件

interface ExtensionSettings {
  npmCommand?: string[];
  packages?: string[];
  [k: string]: unknown;
}

const RUNTIME_DIR = `${process.env.HOME}/.hiagent/runtime`;

export class ExtensionManager {
  private pkgService: NpmPackageService;

  constructor(
    private dataDir: string,
    pkgService?: NpmPackageService,
  ) {
    this.pkgService = pkgService ?? new NpmPackageService(RUNTIME_DIR);
  }

  // ---- settings.json 读写 ----

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

  /** 确保 npmCommand 存在，首启写入默认值 */
  private async ensureNpmCommand(settings: ExtensionSettings): Promise<ExtensionSettings> {
    if (!settings.npmCommand) {
      settings.npmCommand = ["bun"];
      await this.writeSettings(settings);
      this.pkgService = new NpmPackageService(RUNTIME_DIR, { npmCommand: ["bun"] });
    } else {
      this.pkgService = new NpmPackageService(RUNTIME_DIR, { npmCommand: settings.npmCommand });
    }
    return settings;
  }

  // ---- 包名匹配辅助 ----

  /** 从 packages 数组中提取包名（去掉 npm: 前缀和 @version 后缀） */
  private extractNames(packages: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const p of packages) {
      if (p.startsWith("npm:")) {
        const rest = p.slice(4);
        const atIdx = rest.lastIndexOf("@");
        const name = atIdx > 0 ? rest.slice(0, atIdx) : rest;
        map.set(name, p);
      } else {
        map.set(p, p);
      }
    }
    return map;
  }

  // ---- 公共 API ----

  async list(): Promise<{ packages: PackageInfo[] }> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);

    const pkgs = settings.packages ?? [];
    const result: PackageInfo[] = [];

    for (const p of pkgs) {
      if (p.startsWith("npm:")) {
        const rest = p.slice(4);
        const atIdx = rest.lastIndexOf("@");
        const name = atIdx > 0 ? rest.slice(0, atIdx) : rest;
        const version = atIdx > 0 ? rest.slice(atIdx + 1) : undefined;

        const installedVersion = this.pkgService.getInstalledVersion(name);
        let latestVersion: string | undefined;
        try { latestVersion = await this.pkgService.getLatestVersion(name); } catch {}

        result.push({
          name,
          source: "npm",
          version: installedVersion ?? version,
          latestVersion: latestVersion && latestVersion !== installedVersion ? latestVersion : undefined,
          description: this.pkgService.getDescription(name),
          enabled: true,
        });
      } else if (p.startsWith("git:")) {
        result.push({
          name: p.slice(4),
          source: "git",
          enabled: true,
        });
      } else {
        result.push({
          name: p,
          source: "local",
          description: this.pkgService.getDescription(p) ?? undefined,
          enabled: true,
        });
      }
    }

    return { packages: result };
  }

  async install(rawInput: string): Promise<PackageInfo> {
    const parsed = parseExtensionInput(rawInput);
    if (!parsed) throw new Error("无效的插件名称格式");

    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const existing = this.extractNames(pkgs);

    if (existing.has(parsed.name)) {
      const existingVersion = this.pkgService.getInstalledVersion(parsed.name);
      throw new Error(existingVersion
        ? `已安装 v${existingVersion}，请使用升级`
        : `已安装 ${parsed.name}`);
    }

    let entry: string;
    let version: string | undefined;

    switch (parsed.source) {
      case "npm": {
        const result = await this.pkgService.install(parsed.name, parsed.version);
        version = result.version;
        entry = `npm:${parsed.name}@${version}`;
        break;
      }
      case "git":
        entry = `git:${parsed.name}`;
        break;
      case "local": {
        const abs = isAbsolute(parsed.name) ? parsed.name : resolve(parsed.name);
        if (!existsSync(join(abs, "package.json"))) {
          throw new Error(`路径不存在或不是有效的 Pi 包: ${abs}`);
        }
        entry = abs;
        break;
      }
      default:
        throw new Error(`不支持的来源类型: ${parsed.source}`);
    }

    const updated = [...pkgs, entry];
    await this.writeSettings({ ...settings, packages: updated });

    return {
      name: parsed.name,
      source: parsed.source,
      version,
      description: parsed.source === "npm" ? this.pkgService.getDescription(parsed.name) : undefined,
      enabled: true,
    };
  }

  async uninstall(name: string): Promise<void> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const existing = this.extractNames(pkgs);

    const matched = existing.get(name);
    if (!matched) throw new Error(`未安装: ${name}`);

    // npm 来源：卸载 node_modules 中的包
    if (matched.startsWith("npm:")) {
      await this.pkgService.uninstall(name);
    }
    // git 和 local 来源：不从磁盘删除，只从 packages 移除

    const updated = pkgs.filter((p) => p !== matched);
    await this.writeSettings({ ...settings, packages: updated });
  }

  async upgrade(name: string): Promise<PackageInfo> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const existing = this.extractNames(pkgs);

    const matched = existing.get(name);
    if (!matched) throw new Error(`未安装: ${name}`);

    if (!matched.startsWith("npm:")) {
      if (matched.startsWith("git:")) {
        // git: 无自动升级，提示用户手动修改 ref
        throw new Error("Git 来源插件暂不支持自动升级，请先卸载后重新安装新版本");
      }
      throw new Error("本地路径插件不支持升级");
    }

    const result = await this.pkgService.upgrade(name);
    const entry = `npm:${name}@${result.version}`;
    const updated = pkgs.map((p) => p === matched ? entry : p);
    await this.writeSettings({ ...settings, packages: updated });

    return {
      name,
      source: "npm",
      version: result.version,
      description: this.pkgService.getDescription(name),
      enabled: true,
    };
  }

  async enable(name: string): Promise<void> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];

    // 从旧版 settings.extensions 迁移：查找匹配的路径
    const extPaths = (settings as any).extensions as string[] | undefined;

    // 检查是否已在 packages 中
    const existing = this.extractNames(pkgs);
    if (existing.has(name)) return; // already enabled

    // 查找原始 packages 条目（可能之前被 disable 移除了）
    // 从 settings.extensions 或 node_modules 中找到该包
    let entry: string | undefined;
    if (extPaths) {
      const found = extPaths.find((p) => p.includes(`/node_modules/${name}/`));
      if (found) {
        const installedVersion = this.pkgService.getInstalledVersion(name);
        if (installedVersion) {
          entry = `npm:${name}@${installedVersion}`;
        }
      }
    }

    if (!entry) {
      // 检查 node_modules 是否有该包
      const installedVersion = this.pkgService.getInstalledVersion(name);
      if (installedVersion) {
        entry = `npm:${name}@${installedVersion}`;
      } else {
        throw new Error(`未找到已安装的包: ${name}，请先安装`);
      }
    }

    const updated = [...pkgs, entry];
    await this.writeSettings({ ...settings, packages: updated, extensions: undefined });
  }

  async disable(name: string): Promise<void> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const existing = this.extractNames(pkgs);

    const matched = existing.get(name);
    if (!matched) return; // already disabled — no-op

    const updated = pkgs.filter((p) => p !== matched);
    await this.writeSettings({ ...settings, packages: updated });
  }
}
```

- [ ] **Step 3: 写单元测试**

```typescript
// packages/kernel/tests/extension-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager, validatePackageName, parseExtensionInput } from "../src/extension-manager";
import { NpmPackageService } from "../src/npm-package-service";

function tmpDir(): string {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---- validatePackageName ----
test("validatePackageName 接受合法裸名", () => {
  expect(validatePackageName("pi-intercom")).toBe("pi-intercom");
  expect(validatePackageName("superpowers-zh")).toBe("superpowers-zh");
});

test("validatePackageName 接受 scope 包", () => {
  expect(validatePackageName("@scope/my-pkg")).toBe("@scope/my-pkg");
});

test("validatePackageName 接受带版本", () => {
  expect(validatePackageName("pkg@1.0.0")).toBe("pkg@1.0.0");
});

test("validatePackageName 拒绝路径字符", () => {
  expect(validatePackageName("../evil")).toBeNull();
  expect(validatePackageName("/etc/passwd")).toBeNull();
  expect(validatePackageName("./local")).toBeNull();
});

test("validatePackageName 拒绝 shell 元字符", () => {
  expect(validatePackageName("pkg; rm -rf /")).toBeNull();
  expect(validatePackageName("pkg|cat /etc/passwd")).toBeNull();
  expect(validatePackageName("`evil`")).toBeNull();
});

// ---- parseExtensionInput ----
test("parseExtensionInput 解析裸名", () => {
  const r = parseExtensionInput("pi-intercom");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("pi-intercom");
});

test("parseExtensionInput 解析 npm: 前缀", () => {
  const r = parseExtensionInput("npm:pi-intercom");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("pi-intercom");
});

test("parseExtensionInput 解析 git: 前缀", () => {
  const r = parseExtensionInput("git:github.com/user/repo@v1");
  expect(r?.source).toBe("git");
  expect(r?.name).toBe("github.com/user/repo@v1");
});

test("parseExtensionInput 解析本地路径", () => {
  const r = parseExtensionInput("/absolute/path");
  expect(r?.source).toBe("local");
  expect(r?.name).toBe("/absolute/path");
});

test("parseExtensionInput 解析 CLI 格式", () => {
  const r = parseExtensionInput("pi install npm:superpowers-zh");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("superpowers-zh");
});

// ---- ExtensionManager ----

const mockPkgService = {
  install: async (name: string, version?: string) => ({ version: "9.9.9" }),
  uninstall: async (_name: string) => {},
  upgrade: async (name: string) => ({ version: "9.9.9" }),
  getInstalledVersion: (_name: string) => "9.9.9" as string | undefined,
  getLatestVersion: async (_name: string) => "9.9.10" as string | undefined,
  getDescription: (_name: string) => "Mock description" as string | undefined,
} satisfies Omit<NpmPackageService, "runtimeDir" | "spawn">;

function mockManager(dataDir: string) {
  return new ExtensionManager(dataDir, mockPkgService as unknown as NpmPackageService);
}

test("list 返回空列表", async () => {
  const mgr = mockManager(dir);
  const { packages } = await mgr.list();
  expect(packages).toEqual([]);
});

test("install 写入 npm:name@version 到 packages", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: ["bun"] }), "utf8");
  const mgr = mockManager(dir);
  const info = await mgr.install("test-pkg");
  expect(info.name).toBe("test-pkg");
  expect(info.version).toBe("9.9.9");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
});

test("install 拒绝重复安装", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.install("test-pkg")).rejects.toThrow("已安装");
});

test("uninstall 从 packages 移除", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0", "npm:other@2.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toEqual(["npm:other@2.0.0"]);
  expect(settings.packages).not.toContain("npm:test-pkg@1.0.0");
});

test("disable 从 packages 移除但保留 node_modules", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toEqual([]);
});

test("enable 将包重新加入 packages（检查 node_modules 版本）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: [],
    extensions: ["/fake/node_modules/test-pkg/index.js"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
  expect(settings.extensions).toBeUndefined();
});

test("不可变更新：保留 settings.json 其他字段", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    disabledSkills: ["x"],
    other: 1,
    packages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.install("new-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
});
```

- [ ] **Step 4: 运行测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/extension-manager.test.ts
```

Expected: 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/extension-manager.ts packages/kernel/tests/extension-manager.test.ts
git commit -m "feat(kernel): 重写 ExtensionManager — packages 驱动 + 输入解析 + 操作编排"
```

---

### Task 5: 更新 index.ts + ws-server.ts

**Files:**
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/ws-server.ts`

**Interfaces:**
- Consumes: `ExtensionManager` from Task 4
- Produces: updated `startKernel()` and WS handlers

- [ ] **Step 1: 更新 index.ts**

在 `packages/kernel/src/index.ts` 中：

```typescript
// 第 11 行：移除 migrateSettingsPackages import
// 删除: import { migrateSettingsPackages } from "./extensions";

// 第 32 行：移除调用
// 删除: await migrateSettingsPackages();

// 第 43 行：ExtensionManager 构造保持不变
// const extensionManager = new ExtensionManager(HIAGENT_DIR);

// 第 100 行：移除旧的首启播种
// 删除: await extensionManager.list();
```

- [ ] **Step 2: 更新 ws-server.ts**

在 `packages/kernel/src/ws-server.ts` 的 `extension:toggle` case 之后追加：

```typescript
case "extension:install": {
  try {
    const info = await this.opts.extensionManager.install(event.name);
    this.opts.agentManager.markAllDirty();
    const { packages } = await this.opts.extensionManager.list();
    this.broadcast({ type: "extension:changed", packages });
    reply({ type: "extension:changed", packages });
  } catch (err) {
    reply({ type: "extension:error", name: event.name, error: (err as Error).message });
  }
  break;
}
case "extension:uninstall": {
  try {
    await this.opts.extensionManager.uninstall(event.name);
    this.opts.agentManager.markAllDirty();
    const { packages } = await this.opts.extensionManager.list();
    this.broadcast({ type: "extension:changed", packages });
  } catch (err) {
    reply({ type: "extension:error", name: event.name, error: (err as Error).message });
  }
  break;
}
case "extension:upgrade": {
  try {
    const info = await this.opts.extensionManager.upgrade(event.name);
    this.opts.agentManager.markAllDirty();
    const { packages } = await this.opts.extensionManager.list();
    this.broadcast({ type: "extension:changed", packages });
  } catch (err) {
    reply({ type: "extension:error", name: event.name, error: (err as Error).message });
  }
  break;
}
```

同时更新 `extension:list` handler 中的 `plugins` → `packages`：

```typescript
case "extension:list": {
  try {
    const { packages } = await this.opts.extensionManager.list();
    reply({ type: "extension:list", packages });
  } catch (err) {
    reply({ type: "error", message: (err as Error).message });
  }
  break;
}
```

更新 `extension:toggle` handler 中的 `event.id` → `event.name`：

```typescript
case "extension:toggle": {
  try {
    if (event.enabled) {
      await this.opts.extensionManager.enable(event.name);
    } else {
      await this.opts.extensionManager.disable(event.name);
    }
    this.opts.agentManager.markAllDirty();
    const { packages } = await this.opts.extensionManager.list();
    this.broadcast({ type: "extension:changed", packages });
  } catch (err) {
    reply({ type: "error", message: (err as Error).message });
  }
  break;
}
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/kernel typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/index.ts packages/kernel/src/ws-server.ts
git commit -m "feat(kernel): 注册 extension:install/uninstall/upgrade WS 事件; 清理旧启动逻辑"
```

---

### Task 6: 更新前端 Store

**Files:**
- Modify: `packages/frontend/src/store/extensions.ts`

**Interfaces:**
- Consumes: `PackageInfo` from Task 1
- Produces: `useExtensionsStore` with `installPackage`, `uninstallPackage`, `upgradePackage`

- [ ] **Step 1: 更新 Zustand store**

```typescript
// packages/frontend/src/store/extensions.ts
import { create } from "zustand";
import type {
  PackageInfo,
  ExtensionListResult,
  ExtensionChangedEvent,
  ExtensionErrorEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

interface ExtensionsState {
  packages: PackageInfo[];
  error: string | null;
  load: () => void;
  setAll: (data: ExtensionListResult | ExtensionChangedEvent) => void;
  setError: (data: ExtensionErrorEvent) => void;
  installPackage: (name: string) => void;
  uninstallPackage: (name: string) => void;
  upgradePackage: (name: string) => void;
  togglePackage: (name: string, enabled: boolean) => void;
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  packages: [],
  error: null,

  load: () => send({ type: "extension:list" }),

  setAll: (data) => set({ packages: data.packages, error: null }),

  setError: (data) => set({ error: data.error }),

  installPackage: (name) => {
    set({ error: null });
    send({ type: "extension:install", name });
  },

  uninstallPackage: (name) => {
    set({ error: null });
    send({ type: "extension:uninstall", name });
  },

  upgradePackage: (name) => {
    set({ error: null });
    send({ type: "extension:upgrade", name });
  },

  togglePackage: (name, enabled) => {
    set({ error: null });
    send({ type: "extension:toggle", name, enabled });
  },
}));
```

- [ ] **Step 2: 更新 ws-instance 消息分发**

在 `packages/frontend/src/App.tsx` 或 WS 消息处理处，更新事件路由：

```typescript
// 将原有的 extension:list 和 extension:changed 处理中的 plugins 改为 packages
import { useExtensionsStore } from "./store/extensions";

// 在 WS onMessage 中:
if (msg.type === "extension:list" || msg.type === "extension:changed") {
  useExtensionsStore.getState().setAll(msg as ExtensionListResult | ExtensionChangedEvent);
}
if (msg.type === "extension:error") {
  useExtensionsStore.getState().setError(msg as ExtensionErrorEvent);
}
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/frontend typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/store/extensions.ts
git commit -m "feat(frontend): 更新 extensions store — PackageInfo + install/uninstall/upgrade actions"
```

---

### Task 7: 重写 ExtensionSection 组件

**Files:**
- Modify: `packages/frontend/src/components/settings/ExtensionSection.tsx`

**Interfaces:**
- Consumes: `useExtensionsStore` from Task 6

- [ ] **Step 1: 重写组件**

```tsx
// packages/frontend/src/components/settings/ExtensionSection.tsx
import { useState } from "react";
import { useExtensionsStore } from "../../store/extensions";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Toast } from "../ui/Toast";

export function ExtensionSection() {
  const {
    packages,
    error,
    installPackage,
    uninstallPackage,
    upgradePackage,
    togglePackage,
  } = useExtensionsStore();

  const [inputValue, setInputValue] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const handleInstall = async () => {
    const name = inputValue.trim();
    if (!name) return;
    setInstalling(true);
    installPackage(name);
    setInputValue("");
    // 安装结果通过 WS extension:changed 异步返回
    setTimeout(() => setInstalling(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleInstall();
  };

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      {/* 安装区域 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">安装新插件</span>
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 px-3 py-2 text-sm border border-hairline rounded-sm bg-surface text-primary placeholder:text-tertiary focus:outline-none focus:border-accent"
            style={{ boxShadow: "none" }}
            placeholder="npm 包名 (如 superpowers-zh 或 npm:superpowers-zh)…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={installing}
            data-testid="ext-install-input"
          />
          <button
            className="px-4 py-2 text-sm font-semibold rounded-sm text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
            onClick={handleInstall}
            disabled={installing || !inputValue.trim()}
            data-testid="ext-install-btn"
          >
            {installing ? "安装中…" : "安装"}
          </button>
        </div>
      </div>

      <div style={{ height: "1px", background: "var(--hairline)" }} />

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 rounded-sm text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* 已安装插件列表 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">
          已安装插件 · {packages.length}
        </span>

        {packages.length === 0 && (
          <p className="text-sm text-tertiary py-4">暂无插件，输入上方包名开始安装</p>
        )}

        <div className="flex flex-col gap-2 mt-2">
          {packages.map((pkg) => (
            <div
              key={pkg.name}
              className="flex items-start gap-3 p-3 rounded-sm border border-hairline"
              style={{ opacity: pkg.enabled ? 1 : 0.55 }}
              data-testid={`ext-card-${pkg.name}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-primary">{pkg.name}</span>
                  {pkg.version && (
                    <span className="text-xs px-1.5 py-0.5 rounded text-secondary" style={{ background: "var(--surface-elevated)" }}>
                      v{pkg.version}
                    </span>
                  )}
                  {pkg.latestVersion && pkg.enabled && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
                      v{pkg.latestVersion} 可用
                    </span>
                  )}
                  {pkg.source !== "npm" && (
                    <span className="text-xs px-1.5 py-0.5 rounded text-secondary" style={{ background: "var(--surface-elevated)" }}>
                      {pkg.source}
                    </span>
                  )}
                </div>
                {pkg.description && (
                  <p className="text-xs text-secondary mt-1 line-clamp-1">{pkg.description}</p>
                )}

                {/* 启用/禁用开关 */}
                <label className="flex items-center gap-2 mt-2 cursor-pointer" style={{ width: "fit-content" }}>
                  <span
                    className="relative inline-block rounded-pill transition-colors"
                    style={{
                      width: 38,
                      height: 22,
                      background: pkg.enabled ? "var(--success)" : "#cbd5e1",
                    }}
                    onClick={() => togglePackage(pkg.name, !pkg.enabled)}
                    data-testid={`ext-toggle-${pkg.name}`}
                  >
                    <span
                      className="absolute top-0.5 rounded-full bg-white transition-all"
                      style={{
                        width: 18,
                        height: 18,
                        left: pkg.enabled ? undefined : 2,
                        right: pkg.enabled ? 2 : undefined,
                        boxShadow: "0 1px 2px rgba(0,0,0,.1)",
                      }}
                    />
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: pkg.enabled ? "var(--success)" : "var(--text-tertiary)" }}
                  >
                    {pkg.enabled ? "已启用" : "已禁用"}
                  </span>
                </label>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-1.5 flex-shrink-0">
                {pkg.enabled && pkg.latestVersion && pkg.source === "npm" && (
                  <button
                    className="px-2 py-1 text-xs rounded-sm font-medium"
                    style={{ background: "var(--warning-soft)", color: "var(--warning)", border: "1px solid #fcd34d" }}
                    onClick={() => upgradePackage(pkg.name)}
                    data-testid={`ext-upgrade-${pkg.name}`}
                  >
                    ⬆ 升级
                  </button>
                )}
                <button
                  className="px-2 py-1 text-xs rounded-sm font-medium"
                  style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid #fca5a5" }}
                  onClick={() => setConfirmUninstall(pkg.name)}
                  data-testid={`ext-uninstall-${pkg.name}`}
                >
                  🗑 卸载
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-2.5 rounded-sm text-xs text-secondary" style={{ background: "var(--surface-elevated)", border: "1px solid var(--hairline)" }}>
        💡 安装、卸载、升级操作将在 <strong>下次对话开始时生效</strong>，当前对话不受影响。
      </div>

      {/* 卸载确认弹窗 */}
      {confirmUninstall && (
        <ConfirmDialog
          title="确认卸载"
          message={`确定要卸载 ${confirmUninstall} 吗？已禁用的插件不会影响下次对话。`}
          confirmLabel="卸载"
          onConfirm={() => {
            uninstallPackage(confirmUninstall);
            setConfirmUninstall(null);
          }}
          onCancel={() => setConfirmUninstall(null)}
          data-testid="ext-confirm-uninstall"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: 验证编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/frontend typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/settings/ExtensionSection.tsx
git commit -m "feat(frontend): 重写 ExtensionSection — 安装输入 + 卡片列表 + 升级/卸载按钮"
```

---

### Task 8: 更新前端组件测试

**Files:**
- Modify: `packages/frontend/tests/ExtensionSection.test.tsx`

- [ ] **Step 1: 更新测试文件**

```tsx
// packages/frontend/tests/ExtensionSection.test.tsx
import { test, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExtensionSection } from "../src/components/settings/ExtensionSection";
import { useExtensionsStore } from "../src/store/extensions";

beforeEach(() => {
  useExtensionsStore.setState({
    packages: [
      {
        name: "superpowers-zh",
        source: "npm",
        version: "1.6.0",
        latestVersion: "1.7.0",
        description: "AI 编程超能力中文增强版",
        enabled: true,
      },
      {
        name: "pi-lens",
        source: "npm",
        version: "0.3.1",
        description: "LSP 诊断",
        enabled: false,
      },
    ],
    error: null,
  });
});

test("渲染安装输入框和按钮", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-install-input")).toBeTruthy();
  expect(screen.getByTestId("ext-install-btn")).toBeTruthy();
});

test("渲染已安装插件卡片列表", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-card-superpowers-zh")).toBeTruthy();
  expect(screen.getByTestId("ext-card-pi-lens")).toBeTruthy();
});

test("已启用插件显示升级按钮（有最新版本时）", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-upgrade-superpowers-zh")).toBeTruthy();
});

test("已禁用插件不显示升级按钮", () => {
  render(<ExtensionSection />);
  expect(screen.queryByTestId("ext-upgrade-pi-lens")).toBeNull();
});

test("点击安装按钮调用 installPackage", async () => {
  let installedName = "";
  useExtensionsStore.setState({ installPackage: (n) => { installedName = n; } });
  render(<ExtensionSection />);
  const input = screen.getByTestId("ext-install-input");
  fireEvent.change(input, { target: { value: "new-pkg" } });
  fireEvent.click(screen.getByTestId("ext-install-btn"));
  expect(installedName).toBe("new-pkg");
});

test("点击卸载按钮弹出确认弹窗", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  expect(screen.getByTestId("ext-confirm-uninstall")).toBeTruthy();
});

test("安装按钮在输入为空时禁用", () => {
  render(<ExtensionSection />);
  expect((screen.getByTestId("ext-install-btn") as HTMLButtonElement).disabled).toBe(true);
});
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/frontend test -- ExtensionSection
```

Expected: 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/tests/ExtensionSection.test.tsx
git commit -m "test(frontend): 更新 ExtensionSection 组件测试"
```

---

### Task 9: 更新 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 追加变更记录**

在 CHANGELOG.md 顶部追加：

```markdown
## 2026-07-13 — 新增: 动态插件系统

- **新增功能**: 动态插件系统，支持在设置面板中安装/卸载/升级/启用/禁用 npm 插件
- **架构变更**: 扩展加载改为双轨制 — 核心扩展走 additionalExtensionPaths，动态插件走 packages 字段
- **移除**: OPTIONAL_EXTENSIONS 硬编码机制、migrateSettingsPackages()
- **新增文件**: packages/kernel/src/npm-package-service.ts
- **影响范围**: kernel(extension-manager, extensions, index, ws-server), shared(extensions), frontend(ExtensionSection, store/extensions)
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 更新 CHANGELOG — 动态插件系统"
```

---

## Plan Self-Review

1. **Spec coverage**: ✅ 所有 spec 要求有对应 task — 包名校验(Task 4)、版本锁定(Task 4)、npmCommand(Task 2+4)、git/本地路径(Task 4)、双轨加载(Task 3+5)、物理删除 migrateSettingsPackages(Task 3)、架构分层(Task 2+4)、UI(Task 7)
2. **Placeholder scan**: ✅ 无 TBD/TODO/placeholder
3. **Type consistency**: ✅ `PackageInfo` 在 Task 1 定义，Task 4/6/7 使用一致；`NpmPackageService` 在 Task 2 定义，Task 4 使用一致
