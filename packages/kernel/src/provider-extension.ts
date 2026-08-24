// SPDX-License-Identifier: MIT
import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync as nodeExistsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProviderSlug, GENERATED_DIR } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";
import type { ProviderStore } from "./provider-store";
import { getAllCatalogModels, type CatalogModel } from "./pi-catalog";

// ---- 内置模型目录查询（pi-ai 数据目录，见 pi-catalog.ts） ----

/** 从目录查询到的模型详细信息 */
type SdkModelInfo = Pick<
	CatalogModel,
	| "contextWindow"
	| "maxTokens"
	| "reasoning"
	| "input"
	| "cost"
	| "name"
	| "baseUrl"
	| "api"
>;

/** 默认模型参数（目录查询失败时的 fallback） */
const DEFAULT_SDK_MODEL: SdkModelInfo = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	name: "",
	baseUrl: "",
	api: "",
};

/**
 * 校验 extension 文件是否注册了指定的 provider slug。
 * 用于子智能体派发前自愈：若 extension 文件缺失/空壳/不含所需 provider，
 * 调用方应触发 ensureProviderExtensionRegistered 重新生成，避免子进程报
 * "No API key found"（provider-extension 与 providers.json 不同步所致）。
 *
 * 通过扫描 `pi.registerProvider("<slug>"` 子串判定，无需解析 TS。
 * existsSync 用同步版（派发是热路径，校验必须廉价）。
 */
export function extensionCoversProvider(
	extFilePath: string,
	slug: string,
): boolean {
	if (!nodeExistsSync(extFilePath)) return false;
	let code: string;
	try {
		code = readFileSync(extFilePath, "utf8");
	} catch {
		return false;
	}
	// 生成的 extension 用 registerProvider("<slug>", 调用注册，slug 经 JSON.stringify 含引号
	return code.includes(`registerProvider(${JSON.stringify(slug)}`);
}

/**
 * 在内置模型目录中按 provider + model ID 查找匹配模型。
 * 支持精确匹配和大小写不敏感匹配。
 * providerKey 过滤未命中时回退忽略 provider 按裸 id 匹配——重名去重出的派生 slug
 * （如 opencode-go-2）在目录中不存在，不回退的话元数据会整体落默认值。
 */
function lookupSdkModel(
	modelId: string,
	allModels: CatalogModel[],
	providerKey?: string,
): SdkModelInfo | null {
	const byId = (list: CatalogModel[]): CatalogModel | null => {
		// 精确匹配
		const exact = list.find((m) => m.id === modelId);
		if (exact) return exact;
		// 大小写不敏感匹配
		const lower = modelId.toLowerCase();
		return list.find((m) => m.id.toLowerCase() === lower) ?? null;
	};
	if (providerKey) {
		const scoped = byId(allModels.filter((m) => m.provider === providerKey));
		if (scoped) return modelToInfo(scoped);
	}
	const hit = byId(allModels);
	return hit ? modelToInfo(hit) : null;
}

function modelToInfo(m: CatalogModel): SdkModelInfo {
	return {
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		reasoning: m.reasoning,
		input: m.input as SdkModelInfo["input"],
		cost: {
			input: m.cost.input,
			output: m.cost.output,
			cacheRead: m.cost.cacheRead,
			cacheWrite: m.cost.cacheWrite,
		},
		name: m.name,
		baseUrl: m.baseUrl,
		api: m.api,
	};
}

/**
 * 决定最终生效的 baseUrl：用户显式配置优先。
 * 仅当用户未配置、或与内置目录值同源（相等 / 互为前缀，仅差 /v1 等后缀）时
 * 才采用目录值——用于纠正 providers.json 里缺后缀的旧数据；
 * 用户把 baseUrl 改成无关地址（如自建网关 tokenhub）时尊重用户配置，
 * 否则 key 会被发到目录里的官方端点导致 401。
 */
export function resolveEffectiveBaseUrl(
	userBaseUrl: string,
	catalogBaseUrl?: string,
): string {
	const user = userBaseUrl.replace(/\/+$/, "");
	const catalog = catalogBaseUrl?.replace(/\/+$/, "") ?? "";
	if (!catalog) return user;
	if (!user) return catalog;
	const sameOrigin =
		catalog === user ||
		catalog.startsWith(`${user}/`) ||
		user.startsWith(`${catalog}/`);
	return sameOrigin ? catalog : user;
}

/**
 * 解析测试连接用的 baseUrl。
 * 在内置目录里按 slug（+ api 分节）定位匹配模型，找到后用 resolveEffectiveBaseUrl
 * 裁决：同源时采用目录值（含正确 /v1 后缀），用户改成无关地址时保留用户配置；
 * 找不到则回退用户配置的 baseUrl。
 * 内置目录按 api 分节（同 slug 下 anthropic-messages 与 openai-completions 的 baseUrl
 * 可能不同，如 opencode-go 相差 /v1），传 api 时只认同 api 的目录条目，避免拿错前缀。
 * allModels 由调用方注入（便于测试），生产传 getAllCatalogModels() 的结果。
 */
export function resolveProviderBaseUrl(
	slug: string | undefined,
	modelIds: string[],
	fallbackBaseUrl: string,
	allModels: CatalogModel[],
	api?: string,
): string {
	let matches = slug ? allModels.filter((m) => m.provider === slug) : allModels;
	if (api) matches = matches.filter((m) => m.api === api);
	for (const id of modelIds) {
		const exact = matches.find((m) => m.id === id);
		if (exact?.baseUrl)
			return resolveEffectiveBaseUrl(fallbackBaseUrl, exact.baseUrl);
		const ci = matches.find((m) => m.id.toLowerCase() === id.toLowerCase());
		if (ci?.baseUrl) return resolveEffectiveBaseUrl(fallbackBaseUrl, ci.baseUrl);
	}
	return fallbackBaseUrl.replace(/\/+$/, "");
}

// ---- Extension 代码生成 ----

/**
 * 给每个 provider 分配唯一 slug（基于已分配列表做冲突检测）。
 * 优先用 provider.slug（对齐内置 provider id，预设场景），否则 fallback 到 name 派生。
 * slug 决定 extension 里 pi.registerProvider 的第一参数（providerId），
 * 必须与前端 ModelSelector / 发送闸门 isModelAvailable 的派生规则保持一致。
 */
export function slugifyProviders(
	providers: ModelProvider[],
): { provider: ModelProvider; slug: string }[] {
	const usedSlugs: string[] = [];
	return providers.map((p) => {
		const slug = resolveProviderSlug(p, usedSlugs);
		usedSlugs.push(slug);
		return { provider: p, slug };
	});
}

/**
 * 生成 Pi extension TS 文件内容。
 * 每个 provider 一个 pi.registerProvider() 调用。
 * 模型参数优先使用 SDK 内置数据（sdkModelMap），找不到则 fallback 到用户配置。
 */
export function generateProviderExtension(
	providers: ModelProvider[],
	sdkModelMap: Map<string, SdkModelInfo>,
): string {
	const entries = slugifyProviders(providers);
	const registrations = entries
		.map(({ provider, slug }) => {
			// baseUrl 由 resolveEffectiveBaseUrl 裁决：与内置目录同源（仅差 /v1 等后缀）时
			// 采用目录值纠正 providers.json 缺后缀的旧值；用户显式改成无关地址（自建网关等）
			// 时尊重用户配置，否则 key 会被发到目录里的官方端点导致 401。
			// 内置目录按 api 分节：只认同 api 的条目，否则 anthropic-messages provider 可能拿到
			// openai-completions 的 /v1 baseUrl，Anthropic SDK 再拼 /v1/messages → /v1/v1/messages 404。
			const firstSdk = provider.models
				.map((m) => sdkModelMap.get(`${slug}/${m.id}`) ?? sdkModelMap.get(m.id))
				.find((s) => s?.baseUrl && s.api === provider.api);
			const baseUrl = resolveEffectiveBaseUrl(provider.baseUrl, firstSdk?.baseUrl);
			// 自建网关（生效 baseUrl 与目录值不同）无法被 pi 的 detectCompat 识别，会被当作
			// 标准 OpenAI 端点：reasoning 模型的 system prompt 以 developer role 发送，
			// tokenhub 等网关直接 400（developer is not one of [system, ...]）。
			// 对这类端点的 reasoning 模型显式关闭 developer role（回退 system，普适）。
			const catalogBaseUrl = firstSdk?.baseUrl?.replace(/\/+$/, "");
			const customEndpoint = !!catalogBaseUrl && baseUrl !== catalogBaseUrl;
			const modelsCode = provider.models
				.map((m) => {
					const sdk = sdkModelMap.get(`${slug}/${m.id}`) ?? sdkModelMap.get(m.id);
					const name = sdk?.name || m.id;
					const reasoning = sdk?.reasoning ?? DEFAULT_SDK_MODEL.reasoning;
					// input 默认跟随 SDK 内置目录；但用户显式设置了 supportsVision 时以用户意图为准
					// （增/删 image）。否则「模型 ID 不在目录里 + 用户勾了图片」会落 ["text"]，
					// pi 引擎据此把图片降级为 (image omitted)——页面的「图片」开关需要真正生效。
					const baseInput = sdk?.input ?? DEFAULT_SDK_MODEL.input;
					const input =
						m.supportsVision === true
							? baseInput.includes("image")
								? baseInput
								: [...baseInput, "image"]
							: m.supportsVision === false
								? baseInput.filter((x) => x !== "image")
								: baseInput;
					const cost = sdk?.cost ?? DEFAULT_SDK_MODEL.cost;
					// contextWindow / maxTokens：内置目录优先，其次用户配置，最后默认值。
					// 目录缺失（含派生 slug 错位）时若静默落 128000，pi 会按错误窗口
					// 提前触发自动压缩（回归：用户配置 1M 却在 ~122K 被压缩）。
					const contextWindow =
						sdk?.contextWindow ??
						(m.contextWindow > 0 ? m.contextWindow : DEFAULT_SDK_MODEL.contextWindow);
					const maxTokens =
						sdk?.maxTokens ??
						(m.maxTokens > 0 ? m.maxTokens : DEFAULT_SDK_MODEL.maxTokens);
					return `      {
        id: ${JSON.stringify(m.id)},
        name: ${JSON.stringify(name)},
        // reasoning 从 SDK 内置模型数据获取，SDK 查找失败时默认 false
        reasoning: ${reasoning},
        input: ${JSON.stringify(input)},
        cost: ${JSON.stringify(cost)},
        contextWindow: ${contextWindow},
        maxTokens: ${maxTokens},${
									customEndpoint && reasoning
										? `
        compat: { supportsDeveloperRole: false },`
										: ""
								}
      }`;
				})
				.join(",\n");
			return `  pi.registerProvider(${JSON.stringify(slug)}, {
    name: ${JSON.stringify(provider.name)},
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: ${JSON.stringify(provider.apiKey)},
    api: ${JSON.stringify(provider.api)},
    models: [
${modelsCode}
    ],
  });`;
		})
		.join("\n\n");

	return `// 自动生成，勿手改 — 由 WaPi provider-extension.ts 从 providers.json + SDK 内置模型数据生成
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
${registrations}
}
`;
}

/**
 * 生成 provider extension 文件到 GENERATED_DIR/provider-extension.ts。
 *
 * 该文件由 pi 进程经 -e 参数加载（RPC 迁移前由 DefaultResourceLoader
 * additionalExtensionPaths 纯内存注入加载）。
 *
 * providers 变更时由 index.ts（启动）/ ws-server.ts（provider:save/delete）重新调用，
 * 新创建的 session 会读到最新内容（热更新机制不变）。
 *
 * 生成前从 pi 内置模型目录（pi-catalog.ts）查询每个模型的参数
 * （contextWindow / maxTokens / cost 等），目录中找不到的回退用户在
 * providers.json 里配置的 contextWindow / maxTokens，最后才用默认值。
 *
 * generatedDir 可注入输出目录（默认 GENERATED_DIR）：测试必须传临时目录，
 * 否则会覆盖真实 ~/.pi/agent/.generated/provider-extension.ts。
 */
export async function ensureProviderExtensionRegistered(
	store: ProviderStore,
	generatedDir: string = GENERATED_DIR,
): Promise<void> {
	const providers = await store.load();

	// 查询内置模型目录（key = `${slug}/${modelId}` 复合键，避免同名模型跨 provider 冲突）
	const sdkModelMap = new Map<string, SdkModelInfo>();
	try {
		const allModels = await getAllCatalogModels();
		// slug 必须与 generateProviderExtension 内部的 slugifyProviders 一致（重名去重），
		// 否则第二个重名 provider（如 opencode-go-2）的模型查询全部落空、元数据落默认值
		for (const { provider: p, slug } of slugifyProviders(providers)) {
			for (const m of p.models) {
				const key = `${slug}/${m.id}`;
				if (!sdkModelMap.has(key)) {
					const info = lookupSdkModel(m.id, allModels, slug);
					if (info) sdkModelMap.set(key, info);
				}
			}
		}
	} catch (err) {
		// 目录查询失败不阻塞 extension 生成，使用默认参数降级
		console.error(
			"[provider-extension] 内置模型目录查询失败，将使用默认模型参数:",
			err,
		);
	}

	const code = generateProviderExtension(providers, sdkModelMap);

	// 写 extension 文件（每次覆盖，保证与 providers.json 同步）
	await mkdir(generatedDir, { recursive: true });
	await writeFile(join(generatedDir, "provider-extension.ts"), code, "utf8");
}

/**
 * 判断 provider-extension.ts 是否过期（需要重新生成）。
 * - providers.json 比 extension 文件更新（mtime 不早于）→ 过期。
 * - providers.json 不存在 → 无配置，不视为过期（避免为空的 providers.json 反复生成）。
 * - extension 文件不存在而 providers.json 存在 → 必须重新生成。
 * - mtime 用 >=：provider:save 先写 providers.json 后生成 extension，同刻写入时边界
 *   mtime 相同；此时触发重生成是幂等（generate 一次结果相同，无副作用），不漏也不浪费。
 * 用于兜底「手改 providers.json（绕过 provider:save）导致 extension 不自动刷新」的场景。
 */
export async function isProviderExtensionStale(
	providersFilePath: string,
	extensionPath: string,
): Promise<boolean> {
	const [providersStat, extStat] = await Promise.all([
		stat(providersFilePath).catch(() => null),
		stat(extensionPath).catch(() => null),
	]);
	// providers.json 不存在：无配置，不视为过期
	if (!providersStat) return false;
	// extension 文件不存在而 providers 存在：需要生成
	if (!extStat) return true;
	return providersStat.mtimeMs >= extStat.mtimeMs;
}
