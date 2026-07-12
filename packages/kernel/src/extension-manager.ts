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
import type { ExtensionPluginInfo } from "@hiagent/shared";
import { OPTIONAL_EXTENSIONS, resolveExtensionEntryFile } from "./extensions";

const require = createRequire(import.meta.url);

/** settings.json 中与扩展相关的字段 */
interface ExtensionSettings {
  /** SDK 原生字段：已解析入口路径数组，由 DefaultResourceLoader 读取 */
  extensions?: string[];
  [k: string]: unknown;
}

/**
 * 判断一条 settings.extensions 路径是否属于指定 npm 包。
 * npm/bun 布局下，包入口路径必含 `node_modules/<pkgName>/` 片段
 * （含 .bun 缓存的 `pi-lens@hash/node_modules/pi-lens/` 形态）。
 * 用于收敛同包历史路径，避免 bun install 产生新 hash 后旧路径残留导致双重加载。
 */
function pathBelongsToPackage(extPath: string, pkgName: string): boolean {
  const sep = /[\\/]/;  // 跨平台：兼容 Windows 反斜杠与 POSIX 正斜杠
  const segments = extPath.split(sep);
  const nodeModulesIdx = segments.lastIndexOf("node_modules");
  if (nodeModulesIdx === -1 || nodeModulesIdx === segments.length - 1) return false;
  // node_modules 后第一个段即包名（scoped 包含 @scope/name，这里可选插件都是裸名）
  return segments[nodeModulesIdx + 1] === pkgName;
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
   * 首启播种：settings.extensions 字段尚不存在时，把 defaultEnabled 的插件入口路径
   * 补写并持久化。字段一旦存在（即便被 toggle 清空成 []），视为用户已有明确意图，不再重播——
   * 否则禁用后下次 list() 又会把 defaultEnabled 插件加回来，导致无法真正禁用。
   * 包未安装时该插件标记为 enabled: false，不播种（避免写入无效路径）。
   *
   * 路径收敛：每个可选插件在 settings.extensions 中的历史路径（bun install 产生新 .bun
   * 缓存 hash 后遗留的旧路径）会被收敛为当前解析到的唯一路径。避免同包多路径导致 SDK
   * 双重加载——两实例互判并发副实例而双双跳过 LSP 初始化（pi-lens 回归 bug）。
   */
  async list(): Promise<{ plugins: ExtensionPluginInfo[] }> {
    const settings = await this.readSettings();
    const isFirstBoot = settings.extensions === undefined;
    const rawPaths = settings.extensions ?? [];
    let changed = false;

    // 收敛后的路径集合：先保留不属于任何可选插件的外部路径
    const current: string[] = rawPaths.filter(
      (p) => !OPTIONAL_EXTENSIONS.some((d) => pathBelongsToPackage(p, d.package)),
    );

    const plugins: ExtensionPluginInfo[] = OPTIONAL_EXTENSIONS.map((def) => {
      let path: string;
      try {
        path = this.resolveEntryPath(def.package);
      } catch {
        return { id: def.id, displayName: def.displayName, description: def.description, enabled: false };
      }
      // 该插件在旧 settings 中的历史路径（含已失效的 .bun hash 变体）
      const legacyPaths = rawPaths.filter((p) => pathBelongsToPackage(p, def.package));
      const wasEnabled = legacyPaths.length > 0;

      if (isFirstBoot && def.defaultEnabled) {
        current.push(path);
        changed = true;
      } else if (wasEnabled) {
        // 启用态：用当前路径替换所有历史路径（收敛去重）
        if (!current.includes(path)) {
          current.push(path);
        }
        // 历史路径多于 1 条或含非当前路径 → 需要写入收敛结果
        if (legacyPaths.length > 1 || !legacyPaths.includes(path)) {
          changed = true;
        }
      }
      return {
        id: def.id,
        displayName: def.displayName,
        description: def.description,
        enabled: wasEnabled || (isFirstBoot && def.defaultEnabled),
        version: this.readVersion(def.package),
      };
    });

    if (changed) {
      await this.writeSettings({ ...settings, extensions: current });
    }

    return { plugins };
  }

  /**
   * 启用/禁用插件：把对应入口路径不可变地加入/移出 settings.extensions。
   * 同 list()，对同包历史路径做收敛：禁用时移除该包所有历史路径（含失效的 .bun hash 变体）。
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
    const rawPaths = settings.extensions ?? [];
    // 移除该插件所有历史路径（收敛），保留外部路径；启用时加回当前唯一路径
    const current = rawPaths.filter((p) => !pathBelongsToPackage(p, def.package));
    if (enabled && !current.includes(path)) {
      current.push(path);
    }
    await this.writeSettings({ ...settings, extensions: current });
  }
}
