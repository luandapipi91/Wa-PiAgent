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
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR, WA_PI_DIR } from "@wa-pi/shared";

const require = createRequire(import.meta.url);
// runtimeRequire：dev 模式下内核源码跑在 packages/kernel/src/，require 从 repo 解析不到
// 运行时安装的动态包（bun add 在 ~/.pi/agent/runtime/node_modules）。用 runtimeRequire 兜底。
// 生产模式内核 bundle 已在 runtime 目录，两个 require 解析结果一致（都从 runtime 出发）。
const runtimeRequire = createRequire(join(WA_PI_DIR, "runtime", "package.json"));

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
 * 本地路径扩展（local 来源，settings 存绝对路径）解析入口：直接读文件系统，
 * 绕过 createRequire——它会把 Windows 反斜杠路径损毁（H:\a\b → H:ab）。
 * 优先级与 resolveExtensionEntryFile 对齐：pi.extensions 声明 → 约定入口。
 */
function resolveLocalExtensionEntry(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: string[] } };
      const piExts = pkg?.pi?.extensions;
      if (Array.isArray(piExts) && piExts.length > 0) {
        const entry = resolveDeclaredEntry(resolve(dir, piExts[0]));
        if (entry) return entry;
      }
    } catch {}
  }
  for (const candidate of ["extensions/index.ts", "extensions/index.js", "index.ts", "index.js"]) {
    const p = join(dir, candidate);
    if (existsSync(p)) return p;
  }
  throw new Error(`本地扩展无有效入口: ${dir}`);
}

/**
 * 第三方 npm Pi 扩展清单。
 * 加扩展：在此追加一行 + packages/kernel/package.json 加依赖。
 *
 * 注：pi-open-agents 已于 2026-08-04 移除——子代理执行为 wa-pi 自实现
 * （subagent-runner 直接 spawn pi RPC 子进程），其进程内能力（原生 subagent
 * 工具被 allowlist 屏蔽、/agent 命令、banner）均无消费，仅残留误报 banner。
 */
const PKG_EXTENSIONS = [
  "pi-web-access",
  "pi-mcp-adapter",
] as const;

/**
 * 读取 npm 包 package.json 的 pi.extensions 声明。
 * 用作「该包是否为 Pi 扩展」的判定信号：非 Pi 扩展 / 无声明 / 无法解析时返回 undefined。
 * 动态加载时据此 gate，避免把任意已启用 npm 包的 main 当扩展入口导入（执行其副作用）。
 *
 * 先尝试 require（dev 模式下包在 repo node_modules；生产 bundle 已在 runtime），
 * 解析失败再尝试 runtimeRequire（dev 模式下运行时安装的动态包在 ~/.pi/agent/runtime）。
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
 * 构造传给 pi 进程 -e 参数的扩展入口（仅内置 + wa-pi 自生成）。
 * 含 PKG_EXTENSIONS（pi-web-access/pi-mcp-adapter 等 wa-pi 内置依赖）、
 * provider-extension（providers.json → GENERATED_DIR）、
 * wa-pi-bridge（ask/memory/delegate/fleet 宿主工具，见 bridge-extension.ts）。
 *
 * 动态安装的第三方扩展不再走 -e：改由 pi 官方 packages 机制自动加载
 * （settings.json 的 packages 字段 + 包装在 ~/.pi/agent/npm/node_modules/）。
 * 这样 session.reload() 能重读 packages 让装卸立即生效，不受 -e spawn 时固化限制。
 */
export function buildAdditionalExtensionPaths(): string[] {
  const paths = PKG_EXTENSIONS.map((name) => resolveExtensionEntryFile(name));
  // provider-extension / wa-pi-bridge 由 main()/ws-server 动态生成，首启或测试前可能尚未存在
  for (const generated of ["provider-extension.ts", "wa-pi-bridge.ts"]) {
    const p = join(GENERATED_DIR, generated);
    if (existsSync(p)) paths.push(p);
  }
  return paths;
}
