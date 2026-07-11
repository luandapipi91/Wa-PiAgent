// extensions.ts — Pi 扩展集中管理
//
// 设计要点：
// - 用 DefaultResourceLoader.additionalExtensionPaths 纯内存注入扩展，
//   替代旧的「每个扩展一个 *-setup.ts 写 settings.json.packages」模式。
// - 加扩展只需在 PKG_EXTENSIONS 追加一行 + package.json 加依赖。
// - 启动时 migrateSettingsPackages() 清空 settings.json.packages，
//   避免「packages 残留 + additionalExtensionPaths」双重加载同一扩展。
//
// 入口解析 resolveExtensionEntryFile：
// - import.meta.resolve 返回包 main 入口；Pi 扩展包 main 通常即扩展入口（如 index.ts）。
// - 三级 fallback：package.json 的 pi.extensions 清单 → 约定 index → 包 main。

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR, HIAGENT_DIR } from "@hiagent/shared";

const require = createRequire(import.meta.url);

/**
 * 把 Pi 扩展声明项解析为实际入口文件路径。
 * 声明可能是文件（如 pi-intercom 的 `./index.ts`）或目录（如 `./extensions`，
 * 目录约定取其下的 index.ts / index.js）。
 */
function resolveDeclaredEntry(declared: string): string | undefined {
  if (!existsSync(declared)) return undefined;
  for (const idx of ["index.ts", "index.js"]) {
    const p = join(declared, idx);
    if (existsSync(p)) return p;
  }
  // declared 本身已是文件（join 后 index 路径不存在）
  return declared;
}

/**
 * 解析 npm Pi 扩展的入口文件路径。
 * 优先级：package.json 的 pi.extensions 声明 → 约定 extensions/index 或 index → 包 main。
 */
export function resolveExtensionEntryFile(pkgName: string): string {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkgRoot = dirname(pkgJsonPath);
  const pkg = require(`${pkgName}/package.json`) as { pi?: { extensions?: string[] } };

  // 1. Pi 扩展标准声明：package.json 的 pi.extensions（可指向文件或目录）
  const piExts = pkg?.pi?.extensions;
  if (Array.isArray(piExts) && piExts.length > 0) {
    const declared = resolve(pkgRoot, piExts[0]);
    const entry = resolveDeclaredEntry(declared);
    if (entry) return entry;
  }

  // 2. 约定入口
  for (const candidate of ["extensions/index.ts", "extensions/index.js", "index.ts", "index.js"]) {
    const p = join(pkgRoot, candidate);
    if (existsSync(p)) return p;
  }

  // 3. 兜底：包 main 入口（import.meta.resolve）
  return fileURLToPath(import.meta.resolve(pkgName));
}

/**
 * 第三方 npm Pi 扩展清单。
 * 加扩展：在此追加一行 + packages/kernel/package.json 加依赖。
 */
const PKG_EXTENSIONS = [
  "pi-intercom",
  "pi-web-access",
] as const;

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
    displayName: "LSP 诊断",
    description: "实时代码反馈：LSP 诊断、lint、类型检查、结构分析",
    defaultEnabled: true,
  },
];

/**
 * 构造注入 DefaultResourceLoader.additionalExtensionPaths 的全部扩展入口。
 * 含 hiagent 自生成的 provider-extension（运行时从 providers.json 生成到 GENERATED_DIR）。
 */
export function buildAdditionalExtensionPaths(): string[] {
  const paths = PKG_EXTENSIONS.map(resolveExtensionEntryFile);
  // provider-extension 由 main()/ws-server 动态生成，首启或测试前可能尚未存在
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  if (existsSync(providerExt)) paths.push(providerExt);
  return paths;
}

/**
 * 一次性迁移：清空 settings.json.packages。
 *
 * 旧版本把扩展本地路径写进 packages（由 DefaultResourceLoader 读取）；
 * 现在改用 additionalExtensionPaths 纯内存注入，若不清理会与 additionalExtensionPaths 双重加载同一扩展。
 * packages 字段 hiagent 不再使用；skills/disabledSkills 仍由 SkillManager 独立读写，互不影响。
 *
 * 幂等：无 packages 字段或无 settings.json 则 no-op。
 *
 * @param dir 数据目录，默认 HIAGENT_DIR；测试时注入临时目录以隔离
 */
export async function migrateSettingsPackages(dir: string = HIAGENT_DIR): Promise<void> {
  const settingsPath = join(dir, "settings.json");
  let settings: { packages?: unknown; [k: string]: unknown };
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    // 文件不存在或解析失败 —— 无需迁移
    return;
  }
  if (settings.packages !== undefined) {
    delete settings.packages;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    console.log("[kernel] 已迁移：清空 settings.json.packages（扩展改用 additionalExtensionPaths）");
  }
}
