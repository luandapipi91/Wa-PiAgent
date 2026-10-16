// pi-catalog.ts — pi 内置模型目录（只读数据访问）
//
// 背景：RPC 迁移后 kernel 不再 import @earendil-works/pi-coding-agent 的
// AuthStorage/ModelRegistry，但 model:presets 端点与 provider-extension 生成
// 仍需要 pi 内置模型的元数据（contextWindow / maxTokens / reasoning / cost 等）。
//
// 数据来源：pi-ai 包内自带的 **JSON 数据**（`dist/providers/data/.manifest.json` +
// 每家一个 `<provider>.json`），**不执行任何 JS 模块**。
//
// 为什么不再走「动态 import providers/all.js 再向它问数据」：打包产物（bun --compile）
// 里那条路会在启动关键路径上**挂住不返回**——startKernel → await ensureProviderExtensionRegistered
// → getAllCatalogModels → loadCatalog 卡住后，启动 promise 永不 settle、事件循环排空，
// 进程以 code 0 静默退出，应用永远到不了就绪（源码/dev 形态不复现，只有打包版会中招）。
// JSON 数据与那批模块里的模型表同源，实测读出来的目录与执行模块得到的**逐项一致**
// （42 provider / 1532 chat 模型，含 cost/contextWindow 全部字段），且快得多（约 20ms vs 最坏 1.7s）。
// 注意：这只是只读模型元数据目录，不是 agent 引擎 API；agent 驱动一律走 rpc-client。

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

/** 目录数据（一次性读取并缓存；字段与 pi-ai 的模型表同构） */
interface CatalogData {
  /** 全部内置 provider id（= data 目录下的文件名，排序稳定即为 manifest 的键序） */
  providers: string[];
  /** provider id → 该家的 chat 类模型 */
  modelsByProvider: Map<string, CatalogModel[]>;
  /** 内置目录数据的生成时间（`data/.manifest.json` 的 generatedAt，毫秒）；缺失为 undefined */
  generatedAt?: number;
}

let catalogData: CatalogData | null = null;

/** 定位 pi-ai 包根目录 */
function piAiPackageDir(): string {
  // bun --compile 产物内 import.meta.url 指向虚拟 FS，createRequire 解析不到磁盘
  // node_modules；与 resolvePiCliPath 同款回退：运行时 kernel 进程 cwd = runtimeDir
  // （packaged 下 app 传的就是它，pi-ai 随 pi-coding-agent 传递安装落盘）。
  let req = createRequire(import.meta.url);
  try {
    req.resolve("@earendil-works/pi-ai/package.json");
  } catch {
    req = createRequire(join(process.cwd(), "package.json"));
  }
  return dirname(req.resolve("@earendil-works/pi-ai/package.json"));
}

/**
 * 读取目录数据（纯文件读 + JSON.parse，进程内缓存一次）。
 *
 * 只取 `type === "chat"` 的条目：与替换前 `all.js` 的 `getBuiltinModels` 口径一致
 * （实测那批模块的 chat 条目正是 1532 条，classifier 15 / image 57 不在其中）。
 * 数据缺失或形状非法时直接抛错，由调用方决定降级策略（与旧实现一致）。
 */
function loadCatalog(): CatalogData {
  if (catalogData) return catalogData;
  const dataDir = join(piAiPackageDir(), "dist", "providers", "data");
  const manifest = JSON.parse(
    readFileSync(join(dataDir, ".manifest.json"), "utf8"),
  ) as { generatedAt?: string; files?: Record<string, string> };
  const files = Object.keys(manifest.files ?? {});
  if (files.length === 0) {
    throw new Error(
      `pi-ai 模型目录数据缺失: ${join(dataDir, ".manifest.json")} 无 files 字段`,
    );
  }
  const providers: string[] = [];
  const modelsByProvider = new Map<string, CatalogModel[]>();
  for (const file of files) {
    const providerId = file.replace(/\.json$/, "");
    const groups = JSON.parse(
      readFileSync(join(dataDir, file), "utf8"),
    ) as Record<string, Record<string, CatalogModel & { type?: string }>>;
    const models: CatalogModel[] = [];
    for (const api of Object.keys(groups)) {
      for (const key of Object.keys(groups[api])) {
        const model = groups[api][key];
        if (!model || typeof model !== "object") continue;
        if ((model.type ?? "chat") !== "chat") continue;
        models.push(model);
      }
    }
    providers.push(providerId);
    modelsByProvider.set(providerId, models);
  }
  const generatedAt = manifest.generatedAt
    ? Date.parse(manifest.generatedAt)
    : undefined;
  catalogData = {
    providers,
    modelsByProvider,
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : undefined,
  };
  return catalogData;
}

/**
 * provider 显示名（如 "deepseek" → "DeepSeek"）。
 *
 * JSON 数据里只有模型表、没有 provider 级元数据，显示名写在各家模块文件里，这里
 * **按文本提取**而不执行模块——执行正是打包产物会挂住的那条路。pi-ai 1.0.0 里只有两种写法：
 *   · 常见：`createProvider({ id: "deepseek", name: "DeepSeek", … })`
 *   · 工厂（radius）：`const name = options.name ?? "Radius";`
 * 都匹配不到就回退 slug，与旧行为（`?? providerKey`）一致。
 */
function providerDisplayName(providerKey: string): string {
  try {
    const file = join(
      piAiPackageDir(),
      "dist",
      "providers",
      `${providerKey}.js`,
    );
    const text = readFileSync(file, "utf8");
    const patterns = [
      /\bname:\s*"((?:[^"\\]|\\.)*)"/,
      /const\s+name\s*=[^;]*?\?\?\s*"((?:[^"\\]|\\.)*)"/,
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) return m[1].replace(/\\(.)/g, "$1");
    }
  } catch {
    /* 文件不存在/读失败：回退 slug */
  }
  return providerKey;
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
  localGeneratedAt: number | undefined,
  agentDir: string,
): Promise<CatalogModel[]> {
  const store = await readModelsStore(agentDir);
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
 * 全部内置 provider 的 id（拉取远程目录时用它枚举「要拉哪些家」）。
 *
 * 为什么是全量：pi 官方对**每一个**内置 provider 都刷新（每个 provider 各自包一层
 * withRemoteCatalog）。只拉用户已配置的那几家，会让「还没配的服务」在预设列表里继续
 * 显示过期的价格与上下文长度——而预设列表本来就是让人挑还没配的服务用的。
 */
export async function getBuiltinProviderIds(): Promise<string[]> {
  return loadCatalog().providers;
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
  const catalog = loadCatalog();
  const base = catalog.providers.flatMap(
    (p) => catalog.modelsByProvider.get(p) ?? [],
  );
  const overlay = await loadOverlayModels(catalog.generatedAt, agentDir);
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
  return providerDisplayName(providerKey);
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
