// SPDX-License-Identifier: MIT
import { writeFile, mkdir } from "node:fs/promises";
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
	"contextWindow" | "maxTokens" | "reasoning" | "input" | "cost" | "name"
>;

/** 默认模型参数（目录查询失败时的 fallback） */
const DEFAULT_SDK_MODEL: SdkModelInfo = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	name: "",
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
 * 在内置模型目录中按 model ID 查找匹配模型。
 * 支持精确匹配和大小写不敏感匹配，返回第一个匹配的模型信息。
 */
function lookupSdkModel(
	modelId: string,
	allModels: CatalogModel[],
): SdkModelInfo | null {
	// 精确匹配
	const exact = allModels.find((m) => m.id === modelId);
	if (exact) return modelToInfo(exact);

	// 大小写不敏感匹配
	const lower = modelId.toLowerCase();
	const ci = allModels.find((m) => m.id.toLowerCase() === lower);
	if (ci) return modelToInfo(ci);

	return null;
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
	};
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
			const modelsCode = provider.models
				.map((m) => {
					const sdk = sdkModelMap.get(m.id) ?? DEFAULT_SDK_MODEL;
					const name = sdk.name || m.id;
					const reasoning = sdk.reasoning;
					const input = sdk.input;
					const cost = sdk.cost;
					return `      {
        id: ${JSON.stringify(m.id)},
        name: ${JSON.stringify(name)},
        // reasoning 从 SDK 内置模型数据获取，SDK 查找失败时默认 false
        reasoning: ${reasoning},
        input: ${JSON.stringify(input)},
        cost: ${JSON.stringify(cost)},
        contextWindow: ${sdk.contextWindow},
        maxTokens: ${sdk.maxTokens},
      }`;
				})
				.join(",\n");
			return `  pi.registerProvider(${JSON.stringify(slug)}, {
    name: ${JSON.stringify(provider.name)},
    baseUrl: ${JSON.stringify(provider.baseUrl.replace(/\/+$/, ""))},
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
 * （contextWindow / maxTokens / cost 等），目录中找不到的模型使用默认值。
 *
 * generatedDir 可注入输出目录（默认 GENERATED_DIR）：测试必须传临时目录，
 * 否则会覆盖真实 ~/.pi/agent/.generated/provider-extension.ts。
 */
export async function ensureProviderExtensionRegistered(
	store: ProviderStore,
	generatedDir: string = GENERATED_DIR,
): Promise<void> {
	const providers = await store.load();

	// 查询内置模型目录
	const sdkModelMap = new Map<string, SdkModelInfo>();
	try {
		const allModels = await getAllCatalogModels();
		for (const p of providers) {
			for (const m of p.models) {
				if (!sdkModelMap.has(m.id)) {
					const info = lookupSdkModel(m.id, allModels);
					if (info) sdkModelMap.set(m.id, info);
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
