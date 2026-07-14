// extensions.ts — Pi 扩展集中管理
//
// 设计要点：
// - 用 DefaultResourceLoader.additionalExtensionPaths 纯内存注入扩展，
//   替代旧的「每个扩展一个 *-setup.ts 写 settings.json.packages」模式。
// - 加扩展只需在 PKG_EXTENSIONS 追加一行 + package.json 加依赖。
//
// 入口解析 resolveExtensionEntryFile：
// - import.meta.resolve 返回包 main 入口；Pi 扩展包 main 通常即扩展入口（如 index.ts）。
// - 三级 fallback：package.json 的 pi.extensions 清单 → 约定 index → 包 main。

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@hiagent/shared";

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
 * 读取 npm 包 package.json 的 pi.extensions 声明。
 * 用作「该包是否为 Pi 扩展」的判定信号：非 Pi 扩展 / 无声明 / 无法解析时返回 undefined。
 * 动态加载时据此 gate，避免把任意已启用 npm 包的 main 当扩展入口导入（执行其副作用）。
 */
function readPiExtensionsDeclaration(pkgName: string): string[] | undefined {
  try {
    const pkg = require(`${pkgName}/package.json`) as { pi?: { extensions?: string[] } };
    const exts = pkg?.pi?.extensions;
    return Array.isArray(exts) && exts.length > 0 ? exts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造注入 DefaultResourceLoader.additionalExtensionPaths 的全部扩展入口。
 * 含 hiagent 自生成的 provider-extension（运行时从 providers.json 生成到 GENERATED_DIR）。
 *
 * @param dynamicPkgNames 运行时安装并启用的第三方扩展包名（来自 ExtensionManager.list()）。
 *   仅纳入声明了 pi.extensions 的包（Pi 扩展信号），其余静默跳过。默认空数组（向后兼容）。
 */
export function buildAdditionalExtensionPaths(dynamicPkgNames: string[] = []): string[] {
  const paths = PKG_EXTENSIONS.map(resolveExtensionEntryFile);
  // 动态安装的第三方扩展：把已启用且为 Pi 扩展的包入口并入 loader 路径，
  // 否则 SDK 永远不会加载它们 → 它们的工具/钩子不注册（即动态插件「装了但没生效」的根因）。
  for (const name of dynamicPkgNames) {
    if (!readPiExtensionsDeclaration(name)) continue;  // 非 Pi 扩展，跳过
    try {
      paths.push(resolveExtensionEntryFile(name));
    } catch (err) {
      console.error(`[kernel] 解析动态扩展入口失败 ${name}:`, err);
    }
  }
  // provider-extension 由 main()/ws-server 动态生成，首启或测试前可能尚未存在
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  if (existsSync(providerExt)) paths.push(providerExt);
  return paths;
}

/**
 * 从 DefaultResourceLoader.getExtensions().runtime.tools 提取已加载扩展注册的工具名。
 * runtime.tools 是 Map<string, RegisteredTool>，键即工具名（扩展经 pi.registerTool({name}) 注册）。
 * loader 为空 / 无 getExtensions / 结构不符时返回空数组（容错，绝不抛错）。
 *
 * 注意：runtime.tools 已只含「实际被 loader 加载」的扩展工具——builtin（pi-intercom/pi-web-access）
 * 加 已启用第三方扩展（由 buildAdditionalExtensionPaths 的 dynamicPkgNames gate）。
 * 因此直接全部并入 allowlist 即可，无需再按 enabledExtensionIds 二次过滤。
 */
export function extractRuntimeToolNames(loader: unknown): string[] {
  try {
    const tools = (loader as any)?.getExtensions?.()?.runtime?.tools;
    if (!(tools instanceof Map)) return [];
    return [...tools.keys()];
  } catch {
    return [];
  }
}
