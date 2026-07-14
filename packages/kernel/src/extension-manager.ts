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
  const dangerous = /[\\;&|$`!<>'"\s]/;
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
    // lastIndexOf("@") 对 "@scope/pkg" 返回 0（scope 的 @），对 "@scope/pkg@1.0.0" 返回 version 分隔符位置。
    // "> 0" 已正确排除 scope-only 名；旧版 `&& !startsWith("@")` 守卫会让 @scope/pkg@1.0.0 永远无法拆分。
    const atIdx = validated.lastIndexOf("@");
    if (atIdx > 0) {
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
  if (atIdx > 0) {
    return { source: "npm", name: validated.slice(0, atIdx), version: validated.slice(atIdx + 1) };
  }
  return { source: "npm", name: validated };
}

// packages/kernel/src/extension-manager.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { PackageInfo } from "@hiagent/shared";
import { HIAGENT_DIR } from "@hiagent/shared";
import { NpmPackageService } from "./npm-package-service";

interface ExtensionSettings {
  npmCommand?: string[];
  packages?: string[];
  disabledPackages?: string[];
  [k: string]: unknown;
}

// 复用 @hiagent/shared 的 HIAGENT_DIR（已跨平台解析 HOME/USERPROFILE/HIAGENT_DIR），
// 避免 Windows + Electron 下 HOME 未定义导致 cwd 变成 "undefined/.hiagent/runtime"。
const RUNTIME_DIR = join(HIAGENT_DIR, "runtime");

export class ExtensionManager {
  private pkgService: NpmPackageService;
  private injected: boolean;

  constructor(
    private dataDir: string,
    pkgService?: NpmPackageService,
  ) {
    this.injected = !!pkgService;
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
    }
    if (!this.injected) {
      this.pkgService = new NpmPackageService(RUNTIME_DIR, { npmCommand: settings.npmCommand });
    }
    return settings;
  }

  // ---- 包名匹配辅助 ----

  /** 从 packages 数组中提取包名（去掉 npm:/git: 前缀和 @version 后缀） */
  private extractNames(packages: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const p of packages) {
      if (p.startsWith("git:")) {
        // git:github.com/user/repo → bare name（与 list() 输出的 name 一致）
        map.set(p.slice(4), p);
      } else if (p.startsWith("npm:")) {
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
    const disabledPkgs = settings.disabledPackages ?? [];
    const result: PackageInfo[] = [];

    const parseEntry = async (p: string, enabled: boolean): Promise<PackageInfo> => {
      if (p.startsWith("npm:")) {
        const rest = p.slice(4);
        const atIdx = rest.lastIndexOf("@");
        const name = atIdx > 0 ? rest.slice(0, atIdx) : rest;
        const version = atIdx > 0 ? rest.slice(atIdx + 1) : undefined;

        const installedVersion = this.pkgService.getInstalledVersion(name);

        if (enabled) {
          let latestVersion: string | undefined;
          try { latestVersion = await this.pkgService.getLatestVersion(name); } catch {}
          return {
            name,
            source: "npm",
            version: installedVersion ?? version,
            latestVersion: latestVersion && latestVersion !== installedVersion ? latestVersion : undefined,
            description: this.pkgService.getDescription(name),
            enabled: true,
          };
        }
        return {
          name,
          source: "npm",
          version: installedVersion ?? version,
          description: this.pkgService.getDescription(name),
          enabled: false,
        };
      }
      if (p.startsWith("git:")) {
        return { name: p.slice(4), source: "git", enabled };
      }
      return {
        name: p,
        source: "local",
        description: this.pkgService.getDescription(p) ?? undefined,
        enabled,
      };
    };

    for (const p of pkgs) {
      result.push(await parseEntry(p, true));
    }
    for (const p of disabledPkgs) {
      result.push(await parseEntry(p, false));
    }

    return { packages: result };
  }

  async install(rawInput: string, onProgress?: (line: string) => void): Promise<PackageInfo> {
    const parsed = parseExtensionInput(rawInput);
    if (!parsed) throw new Error("无效的插件名称格式");

    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const disabledPkgs = settings.disabledPackages ?? [];
    const existing = this.extractNames(pkgs);
    const disabledNames = this.extractNames(disabledPkgs);

    if (existing.has(parsed.name)) {
      const existingVersion = this.pkgService.getInstalledVersion(parsed.name);
      throw new Error(existingVersion
        ? `已安装 v${existingVersion}，请使用升级`
        : `已安装 ${parsed.name}`);
    }
    if (disabledNames.has(parsed.name)) {
      throw new Error(`该插件已禁用，请先启用`);
    }

    let entry: string;
    let version: string | undefined;

    switch (parsed.source) {
      case "npm": {
        const result = await this.pkgService.install(parsed.name, parsed.version, onProgress);
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
    const disabledPkgs = settings.disabledPackages ?? [];
    const existingPkgs = this.extractNames(pkgs);
    const existingDisabled = this.extractNames(disabledPkgs);

    const matchedPkgs = existingPkgs.get(name);
    const matchedDisabled = existingDisabled.get(name);

    if (!matchedPkgs && !matchedDisabled) throw new Error(`未安装: ${name}`);

    // npm 来源：卸载 node_modules 中的包
    const matched = matchedPkgs ?? matchedDisabled!;
    if (matched.startsWith("npm:")) {
      await this.pkgService.uninstall(name);
    }
    // git 和 local 来源：不从磁盘删除，只从对应列表移除

    const updatedPkgs = matchedPkgs ? pkgs.filter((p) => p !== matchedPkgs) : pkgs;
    const updatedDisabled = matchedDisabled ? disabledPkgs.filter((p) => p !== matchedDisabled) : disabledPkgs;
    await this.writeSettings({ ...settings, packages: updatedPkgs, disabledPackages: updatedDisabled });
  }

  async upgrade(name: string): Promise<PackageInfo> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const disabledPkgs = settings.disabledPackages ?? [];
    const existing = this.extractNames(pkgs);
    const disabledNames = this.extractNames(disabledPkgs);

    const matched = existing.get(name);
    if (!matched) {
      if (disabledNames.has(name)) {
        throw new Error(`该插件已禁用，请先启用后升级`);
      }
      throw new Error(`未安装: ${name}`);
    }

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
    const disabledPkgs = settings.disabledPackages ?? [];
    const existingPkgs = this.extractNames(pkgs);
    const existingDisabled = this.extractNames(disabledPkgs);

    // 已启用（在 packages 中）→ no-op
    if (existingPkgs.has(name)) return;

    const matchedDisabled = existingDisabled.get(name);
    if (matchedDisabled) {
      // 从 disabledPackages 移回 packages
      const updatedDisabled = disabledPkgs.filter((p) => p !== matchedDisabled);
      const updatedPkgs = [...pkgs, matchedDisabled];
      await this.writeSettings({ ...settings, packages: updatedPkgs, disabledPackages: updatedDisabled });
      return;
    }

    // 两者皆无 → node_modules 兜底
    const installedVersion = this.pkgService.getInstalledVersion(name);
    if (installedVersion) {
      const entry = `npm:${name}@${installedVersion}`;
      const updatedPkgs = [...pkgs, entry];
      await this.writeSettings({ ...settings, packages: updatedPkgs });
      return;
    }
    throw new Error(`未找到已安装的包: ${name}，请先安装`);
  }

  async disable(name: string): Promise<void> {
    let settings = await this.readSettings();
    settings = await this.ensureNpmCommand(settings);
    const pkgs = settings.packages ?? [];
    const disabledPkgs = settings.disabledPackages ?? [];
    const existingPkgs = this.extractNames(pkgs);
    const existingDisabled = this.extractNames(disabledPkgs);

    const matched = existingPkgs.get(name);
    if (matched) {
      // 从 packages 移到 disabledPackages
      const updatedPkgs = pkgs.filter((p) => p !== matched);
      const updatedDisabled = [...disabledPkgs, matched];
      await this.writeSettings({ ...settings, packages: updatedPkgs, disabledPackages: updatedDisabled });
      return;
    }

    // 已在 disabledPackages → no-op（幂等）
    if (existingDisabled.has(name)) return;

    // 两者皆无 → 未安装
    throw new Error(`未安装: ${name}`);
  }
}
