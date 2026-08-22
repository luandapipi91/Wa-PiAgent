// pi-catalog.ts — pi 内置模型目录（只读数据访问）
//
// 背景：RPC 迁移后 kernel 不再 import @earendil-works/pi-coding-agent 的
// AuthStorage/ModelRegistry，但 model:presets 端点与 provider-extension 生成
// 仍需要 pi 内置模型的元数据（contextWindow / maxTokens / reasoning / cost 等）。
// 这里改为读取 pi-ai 包内的 providers/all.js 数据目录：
// 经 createRequire 定位包根，再按绝对路径动态 import（该文件不在 package.json
// exports 里，直接按 specifier import 会被拒）。
// 注意：这只是只读模型元数据目录，不是 agent 引擎 API；agent 驱动一律走 rpc-client。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** pi 内置模型目录中单个模型的元数据（与 providers/*.models.js 条目同构） */
export interface CatalogModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** providers/all.js 的导出形状（只声明用到的部分） */
interface CatalogModule {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): CatalogModel[];
  builtinProviders(): Array<{ id: string; name?: string; baseUrl?: string }>;
}

let catalogPromise: Promise<CatalogModule> | null = null;

/** 加载目录模块（进程内缓存一次；解析失败直接抛错，由调用方决定降级策略） */
function loadCatalog(): Promise<CatalogModule> {
  if (!catalogPromise) {
    // bun --compile 产物内 import.meta.url 指向虚拟 FS，createRequire 解析不到磁盘
    // node_modules；与 resolvePiCliPath 同款回退：运行时 kernel 进程 cwd = runtimeDir
    // （pi-ai 随 pi-coding-agent 传递安装落盘），回退从 cwd 解析。
    let req: NodeRequire;
    try {
      req = createRequire(import.meta.url);
      req.resolve("@earendil-works/pi-ai/package.json");
    } catch {
      req = createRequire(join(process.cwd(), "package.json"));
    }
    const pkgJsonPath = req.resolve("@earendil-works/pi-ai/package.json");
    const allJs = join(dirname(pkgJsonPath), "dist", "providers", "all.js");
    catalogPromise = import(pathToFileURL(allJs).href) as Promise<CatalogModule>;
  }
  return catalogPromise;
}

/** 全部内置模型的扁平列表（所有 provider） */
export async function getAllCatalogModels(): Promise<CatalogModel[]> {
  const catalog = await loadCatalog();
  return catalog.getBuiltinProviders().flatMap((p) => catalog.getBuiltinModels(p));
}

/** provider 显示名（如 "deepseek" → "DeepSeek"）；找不到时回退为 key 本身 */
export async function getProviderDisplayName(providerKey: string): Promise<string> {
  const catalog = await loadCatalog();
  const hit = catalog.builtinProviders().find((p) => p.id === providerKey);
  return hit?.name ?? providerKey;
}

/**
 * 按 model ID 在目录中查找（先精确匹配，再大小写不敏感）。
 * 供 provider-extension 生成时补全用户自定义模型的元数据。
 */
export async function lookupCatalogModel(modelId: string): Promise<CatalogModel | null> {
  const all = await getAllCatalogModels();
  const exact = all.find((m) => m.id === modelId);
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  return all.find((m) => m.id.toLowerCase() === lower) ?? null;
}
