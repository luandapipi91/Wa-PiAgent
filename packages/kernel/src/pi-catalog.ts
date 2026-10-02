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
import { WA_PI_DIR } from "@wa-pi/shared";
import { readModelsStore } from "./model-catalog-refresh";

/** pi 内置模型目录中单个模型的元数据（与 providers/*.models.js 条目同构） */
export interface CatalogModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  /** pi 官方为特定网关声明的兼容开关（如 requiresReasoningContentOnAssistantMessages），生成 extension 时透传 */
  compat?: Record<string, unknown>;
  /** 思考档位映射表：值为 null 表示该模型不支持对应档位（如 glm-5.3-flash 始终思考，off:null/medium:null）。
   *  生成 extension 时必须透传——丢失会导致 pi 侧钳制失效，“关闭思考”被原样发给智谱等始终思考模型 → 400 1210。 */
  thinkingLevelMap?: Record<string, string | null>;
}

/** providers/all.js 的导出形状（只声明用到的部分） */
interface CatalogModule {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): CatalogModel[];
  builtinProviders(): Array<{ id: string; name?: string; baseUrl?: string }>;
  /**
   * 内置目录数据的生成时间（`data/.manifest.json` 的 generatedAt，毫秒）。
   * 用于「远程目录只比内置新时才生效」的判定（与 pi 的 localGeneratedAt 同义）；
   * 旧版 pi-ai 可能没导出，故为可选。
   */
  getBuiltinModelDataGeneratedAt?(): number | undefined;
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
    catalogPromise = import(
      pathToFileURL(allJs).href
    ) as Promise<CatalogModule>;
  }
  return catalogPromise;
}

/**
 * 合并用的键：`provider \0 type \0 id`。
 *
 * 为什么带 provider：pi 的去重范围是**单个 provider 内**（`withRemoteCatalog` 对每个
 * provider 各自调 `mergeModels`）。用不带 provider 的键会把不同 provider 下的同名模型
 * （如 openrouter 与 deepseek 都有 deepseek-chat）当成同一个而合并掉，目录会凭空变少。
 * type 同理（同 id 的 chat 与 image 是两个条目）。
 */
function catalogKey(model: {
  id?: unknown;
  type?: unknown;
  provider?: unknown;
}): string {
  const id = typeof model.id === "string" ? model.id : "";
  const type = typeof model.type === "string" ? model.type : "chat";
  const provider = typeof model.provider === "string" ? model.provider : "";
  return `${provider}\0${type}\0${id}`;
}

/**
 * 读 models-store.json 的**远程覆盖层**（由 model-catalog-refresh 后台拉取写入）。
 *
 * 「只比内置新时才生效」（`lastModified > 内置数据生成时间`）是照搬 pi 的同一条规则：
 * 升级 pi 后内置目录可能比远程缓存新，此时用远程会把参数改旧；404/501 记的
 * `lastModified: 0` 也正好在这一步被排除（该 provider 没有远程目录）。
 * 拿不到内置生成时间时（旧版 pi-ai）不判定，一律采用远程（宁可新不可旧）。
 *
 * 读不到文件、形状非法、某条模型不合法——全部静默跳过，绝不抛错。
 */
async function loadOverlayModels(
  catalog: CatalogModule,
  agentDir: string,
): Promise<CatalogModel[]> {
  const store = await readModelsStore(agentDir);
  const localGeneratedAt = catalog.getBuiltinModelDataGeneratedAt?.();
  const out: CatalogModel[] = [];
  for (const [providerId, entry] of Object.entries(store)) {
    if (localGeneratedAt !== undefined && entry.lastModified <= localGeneratedAt) {
      continue;
    }
    for (const model of entry.models) {
      if (!model || typeof model !== "object" || !("id" in model)) continue;
      out.push({ ...(model as CatalogModel), provider: providerId });
    }
  }
  return out;
}

/**
 * 全部内置模型的扁平列表（所有 provider），并叠加已落盘的远程目录。
 *
 * agentDir 可注入（测试用临时目录）；缺省 = WA_PI_DIR，与 pi 的 `getAgentDir()` 同源
 * （kernel spawn pi 时注入的 PI_CODING_AGENT_DIR 就是它）。
 */
export async function getAllCatalogModels(
  agentDir: string = WA_PI_DIR,
): Promise<CatalogModel[]> {
  const catalog = await loadCatalog();
  const base = catalog
    .getBuiltinProviders()
    .flatMap((p) => catalog.getBuiltinModels(p));
  const overlay = await loadOverlayModels(catalog, agentDir);
  if (overlay.length === 0) return base;
  // 覆盖 + 追加，**不删除**：
  //   · 同键的内置条目就地换成远程值（下游 lookupSdkModel 用 find 取第一条命中，拿到的就是新值）；
  //   · 只是重新排序/去重会让「目录条目数」莫名变少（内置目录里本来就有跨 provider 的同名模型），
  //     而目录大小会直接影响前端预设列表与统计。
  const merged = [...base];
  const slot = new Map<string, number>();
  base.forEach((model, index) => {
    const key = catalogKey(model);
    if (!slot.has(key)) slot.set(key, index);
  });
  for (const model of overlay) {
    const key = catalogKey(model);
    const at = slot.get(key);
    if (at === undefined) {
      slot.set(key, merged.length);
      merged.push(model);
    } else {
      merged[at] = model;
    }
  }
  return merged;
}

/** provider 显示名（如 "deepseek" → "DeepSeek"）；找不到时回退为 key 本身 */
export async function getProviderDisplayName(
  providerKey: string,
): Promise<string> {
  const catalog = await loadCatalog();
  const hit = catalog.builtinProviders().find((p) => p.id === providerKey);
  return hit?.name ?? providerKey;
}

/**
 * 按 model ID 在目录中查找（先精确匹配，再大小写不敏感）。
 * 供 provider-extension 生成时补全用户自定义模型的元数据。
 */
export async function lookupCatalogModel(
  modelId: string,
): Promise<CatalogModel | null> {
  const all = await getAllCatalogModels();
  const exact = all.find((m) => m.id === modelId);
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  return all.find((m) => m.id.toLowerCase() === lower) ?? null;
}
