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
import { GENERATED_DIR, HIAGENT_DIR } from "@hiagent/shared";

const require = createRequire(import.meta.url);
// runtimeRequire：dev 模式下内核源码跑在 packages/kernel/src/，require 从 repo 解析不到
// 运行时安装的动态包（bun add 在 ~/.hiagent/runtime/node_modules）。用 runtimeRequire 兜底。
// 生产模式内核 bundle 已在 runtime 目录，两个 require 解析结果一致（都从 runtime 出发）。
const runtimeRequire = createRequire(join(HIAGENT_DIR, "runtime", "package.json"));

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
export function resolveExtensionEntryFile(pkgName: string, req = require): string {
  const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
  const pkgRoot = dirname(pkgJsonPath);
  const pkg = req(`${pkgName}/package.json`) as { pi?: { extensions?: string[] } };

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
  "pi-mcp-adapter",
] as const;

/**
 * 读取 npm 包 package.json 的 pi.extensions 声明。
 * 用作「该包是否为 Pi 扩展」的判定信号：非 Pi 扩展 / 无声明 / 无法解析时返回 undefined。
 * 动态加载时据此 gate，避免把任意已启用 npm 包的 main 当扩展入口导入（执行其副作用）。
 *
 * 先尝试 require（dev 模式下包在 repo node_modules；生产 bundle 已在 runtime），
 * 解析失败再尝试 runtimeRequire（dev 模式下运行时安装的动态包在 ~/.hiagent/runtime）。
 */
function readPiExtensionsDeclaration(pkgName: string): string[] | undefined {
  const parse = (req: NodeRequire) => {
    const pkg = req(`${pkgName}/package.json`) as { pi?: { extensions?: string[] } };
    const exts = pkg?.pi?.extensions;
    return Array.isArray(exts) && exts.length > 0 ? exts : undefined;
  };
  try { return parse(require); } catch {}
  try { return parse(runtimeRequire); } catch {}
  return undefined;
}

/**
 * 构造注入 DefaultResourceLoader.additionalExtensionPaths 的全部扩展入口。
 * 含 hiagent 自生成的 provider-extension（运行时从 providers.json 生成到 GENERATED_DIR）。
 *
 * @param dynamicPkgNames 运行时安装并启用的第三方扩展包名（来自 ExtensionManager.list()）。
 *   仅纳入声明了 pi.extensions 的包（Pi 扩展信号），其余静默跳过。默认空数组（向后兼容）。
 */
export function buildAdditionalExtensionPaths(dynamicPkgNames: string[] = []): string[] {
  const paths = PKG_EXTENSIONS.map((name) => resolveExtensionEntryFile(name));
  // 动态安装的第三方扩展：把已启用且为 Pi 扩展的包入口并入 loader 路径，
  // 否则 SDK 永远不会加载它们 → 它们的工具/钩子不注册（即动态插件「装了但没生效」的根因）。
  for (const name of dynamicPkgNames) {
    if (!readPiExtensionsDeclaration(name)) continue;  // 非 Pi 扩展，跳过
    // dev 模式：源码跑在 packages/kernel/src/，require 从 repo 解析不到 runtime 动态包；
    // 先试 require（builtin / 已装在 repo 的），失败再试 runtimeRequire 兜底。
    // 生产模式：bundle 已在 runtime 目录，require 与 runtimeRequire 等价，第一个就命中。
    try {
      paths.push(resolveExtensionEntryFile(name));
    } catch {
      try {
        paths.push(resolveExtensionEntryFile(name, runtimeRequire));
      } catch (err) {
        console.error(`[kernel] 解析动态扩展入口失败 ${name}:`, err);
      }
    }
  }
  // provider-extension 由 main()/ws-server 动态生成，首启或测试前可能尚未存在
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  if (existsSync(providerExt)) paths.push(providerExt);
  return paths;
}

/**
 * 从 DefaultResourceLoader.getExtensions() 提取已加载扩展注册的工具名。
 * 优先遍历每个扩展的 tools Map（loader.reload() 后即可用）；再尝试 runtime.getAllTools()
 * 作为补充（需要 agent session 运行时初始化，可能抛错，容错忽略）。
 * loader 为空 / 结构不符时返回空数组（绝不抛错）。
 */
export function extractRuntimeToolNames(loader: unknown): string[] {
  try {
    const extResult = (loader as any)?.getExtensions?.();
    if (!extResult) return [];
    const names: string[] = [];
    // 主路径：遍历每个扩展的 tools Map<string, RegisteredTool>（reload 后直接可用）
    for (const ext of (extResult.extensions ?? [])) {
      const tools = ext?.tools;
      if (tools instanceof Map) names.push(...tools.keys());
    }
    // 补充路径：runtime.getAllTools()（需要 agent session 初始化，未初始化时抛错）
    try {
      const getAllTools = extResult.runtime?.getAllTools;
      if (typeof getAllTools === "function") {
        for (const t of (getAllTools() ?? [])) {
          if (typeof t === "string" && !names.includes(t)) names.push(t);
        }
      }
    } catch { /* runtime 未初始化，忽略 */ }
    return names;
  } catch {
    return [];
  }
}
