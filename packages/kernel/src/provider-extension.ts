import { readFile, writeFile, mkdir } from "node:fs/promises";
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
        reasoning: false,
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
 * 写 extension 文件到 dir/.generated/provider-extension.ts，
 * 并把该路径加入 dir/settings.json 的 packages（幂等）。
 * 参照 intercom-setup.ts 的 settings.json 写入模式。
 */
export async function ensureProviderExtensionRegistered(
  dir: string,
  store: ProviderStore,
): Promise<void> {
  const providers = await store.load();
  const code = generateProviderExtension(providers);

  // 写 extension 文件（每次覆盖，保证与 providers.json 同步）
  const extDir = join(dir, ".generated");
  await mkdir(extDir, { recursive: true });
  const extFile = join(extDir, "provider-extension.ts");
  await writeFile(extFile, code, "utf8");

  // 把 extension 路径加入 settings.json.packages（幂等）
  const settingsPath = join(dir, "settings.json");
  let settings: { packages?: string[]; [k: string]: unknown } = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    // 文件不存在，用空对象
  }
  const packages = settings.packages ?? [];
  if (!packages.includes(extFile)) {
    packages.push(extFile);
    settings.packages = packages;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }
}
