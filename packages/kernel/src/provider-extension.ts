import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { slugifyProviderName, GENERATED_DIR } from "@hiagent/shared";
import type { ModelProvider } from "@hiagent/shared";
import type { ProviderStore } from "./provider-store";

/** 给每个 provider 分配唯一 slug（基于已分配列表做冲突检测） */
export function slugifyProviders(providers: ModelProvider[]): { provider: ModelProvider; slug: string }[] {
  const usedSlugs: string[] = [];
  return providers.map(p => {
    const slug = slugifyProviderName(p.name, usedSlugs);
    usedSlugs.push(slug);
    return { provider: p, slug };
  });
}

/**
 * 生成 Pi extension TS 文件内容。
 * 每个 provider 一个 pi.registerProvider() 调用，cost 全填 0（后续可扩展）。
 */
export function generateProviderExtension(providers: ModelProvider[]): string {
  const entries = slugifyProviders(providers);
  const registrations = entries.map(({ provider, slug }) => {
    const modelsCode = provider.models.map(m => `      {
        id: ${JSON.stringify(m.id)},
        name: ${JSON.stringify(m.id)},
        // 默认 reasoning:true：DeepSeek 等推理模型思考默认 enabled，只有标 reasoning:true，
        // Pi 在 thinkingLevel=off 时才会下发 thinking:{type:"disabled"}，对话框的"关闭思考"才生效。
        // 见 https://pi.dev/docs/latest/models#thinking-level-map
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ${m.contextWindow},
        maxTokens: ${m.maxTokens},
      }`).join(",\n");
    return `  pi.registerProvider(${JSON.stringify(slug)}, {
    name: ${JSON.stringify(provider.name)},
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: ${JSON.stringify(provider.apiKey)},
    api: ${JSON.stringify(provider.api)},
    models: [
${modelsCode}
    ],
  });`;
  }).join("\n\n");

  return `// 自动生成，勿手改 — 由 HiAgent provider-extension.ts 从 providers.json 生成
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
${registrations}
}
`;
}

/**
 * 生成 provider extension 文件到 GENERATED_DIR/provider-extension.ts。
 *
 * 该文件由 extensions.ts 的 buildAdditionalExtensionPaths() 经
 * DefaultResourceLoader.additionalExtensionPaths 纯内存注入加载，
 * 无需再写入 settings.json.packages（旧机制已废弃，见 extensions.ts）。
 *
 * providers 变更时由 index.ts（启动）/ ws-server.ts（provider:save/delete）重新调用，
 * 新创建的 session 会读到最新内容（热更新机制不变）。
 */
export async function ensureProviderExtensionRegistered(
  store: ProviderStore,
): Promise<void> {
  const providers = await store.load();
  const code = generateProviderExtension(providers);

  // 写 extension 文件（每次覆盖，保证与 providers.json 同步）
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(join(GENERATED_DIR, "provider-extension.ts"), code, "utf8");
}
