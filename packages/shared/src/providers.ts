// ===== 模型供应商类型定义 =====

/** API 格式（对齐 Pi 的 api 字段子集） */
export type ProviderApi = "openai-completions" | "anthropic-messages";

/** 单个模型 */
export interface ProviderModel {
  id: string;              // 模型 ID，如 "deepseek-chat"
  contextWindow: number;   // 上下文窗口（tokens），默认 128000
  maxTokens: number;       // 最大输出（tokens），默认 4096
  supportsVision?: boolean; // 是否支持视觉/图片输入
}

/** 供应商（纯自定义） */
export interface ModelProvider {
  id: string;              // 内部 uuid，前端生成，用于增删改
  name: string;            // 显示名，如 "My DeepSeek"
  baseUrl: string;         // 如 "https://api.deepseek.com/v1"
  apiKey: string;          // 明文存储（本地单用户应用）
  api: ProviderApi;        // "openai-completions" | "anthropic-messages"
  models: ProviderModel[]; // 模型列表
  /**
   * Provider slug（对齐 pi 内置 provider id）。
   * 预设来源时存 preset.key（如 "opencode-go"），extension 注册用此 slug
   * 会增强内置 provider（补 apiKey），模型从内置目录出，必定可用。
   * 为空/undefined（自定义 provider 或旧数据）时 fallback 到 slugifyProviderName(name)。
   */
  slug?: string;
}

// ===== WS 协议事件（provider 管理）=====

// 前端 → kernel
export interface ProviderListEvent { type: "provider:list"; }
export interface ProviderSaveEvent {
  type: "provider:save";
  provider: ModelProvider;   // 有 id 则更新，无则新增
}
export interface ProviderDeleteEvent {
  type: "provider:delete";
  id: string;
}
export interface ProviderTestEvent {
  type: "provider:test";
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];   // anthropic 探测需用真实 model id
}

// kernel → 前端
export interface ProviderListResult {
  type: "provider:list";
  providers: ModelProvider[];
}
export interface ProviderTestResult {
  type: "provider:test";
  ok: boolean;
  error?: string;
}
export interface ProviderChangedEvent {
  type: "provider:changed";
  providers: ModelProvider[];
}

// 前端 → kernel：获取 SDK 内置供应商列表（用于快捷选择下拉）
export interface ModelPresetsRequest {
  type: "model:presets";
}

// 单个供应商预设（聚合自 SDK 内置模型，结构和原 ProviderPreset 对齐）
export interface ModelPreset {
  /** 唯一 key = provider slug，如 "deepseek" / "anthropic" / "openai" */
  key: string;
  /** 显示名，如 "DeepSeek" / "Anthropic Claude" */
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{
    id: string;
    contextWindow: number;
    maxTokens: number;
    supportsVision: boolean;
  }>;
}

// kernel → 前端
export interface ModelPresetsResult {
  type: "model:presets";
  presets: ModelPreset[];
}

// ===== 纯函数 =====

/**
 * 把供应商显示名转成 Pi provider 名（slug）。
 * 规则：小写、空格转 -、移除非 [a-z0-9-]、collapse 连续 -。
 * 结果为空（如纯中文/符号）则 fallback provider-<6位随机>。
 * 冲突（slug 已在 existingSlugs 中）则加 -2/-3 后缀。
 */
export function slugifyProviderName(name: string, existingSlugs: string[]): string {
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")   // 移除非英文/数字/空格/连字符（中文等移除）
    .replace(/\s+/g, "-")            // 空格转 -
    .replace(/-+/g, "-")            // collapse 连续 -
    .replace(/^-|-$/g, "");          // 去首尾 -

  // slug 为空（纯非 ASCII）→ fallback
  if (!slug) {
    const rand = Math.random().toString(36).slice(2, 8);
    slug = `provider-${rand}`;
  }

  // 冲突检测：若 slug 在 existingSlugs 中，加 -2/-3/...
  if (existingSlugs.includes(slug)) {
    let i = 2;
    while (existingSlugs.includes(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }
  return slug;
}

/**
 * 统一的 provider slug 解析：优先用 provider.slug（对齐内置 provider id），
 * 为空时 fallback 到 slugifyProviderName(name)。
 *
 * 所有依赖 slug 的地方（extension 注册、发送闸门、前端下拉、contextWindow 反查、
 * AgentConfig 校验）都应调用此函数，而不是直接调 slugifyProviderName(p.name, ...)，
 * 保证"预设 provider 走内置 id、自定义 provider 走 name 派生"的全链路一致。
 *
 * 冲突检测规则与 slugifyProviderName 相同：slug 已在 existingSlugs 中则加 -2/-3 后缀。
 */
export function resolveProviderSlug(provider: ModelProvider, existingSlugs: string[]): string {
  // slug 为空串也视为未设置，fallback 到 name 派生（兼容脏数据）
  const explicit = provider.slug?.trim();
  if (explicit) {
    // 显式 slug 仍需冲突检测：两个预设指向同一内置 provider 时加后缀区分
    if (existingSlugs.includes(explicit)) {
      let i = 2;
      while (existingSlugs.includes(`${explicit}-${i}`)) i++;
      return `${explicit}-${i}`;
    }
    return explicit;
  }
  return slugifyProviderName(provider.name, existingSlugs);
}

/**
 * 把含 | 的输入拆成模型 id 列表（trim + 过滤空串）。
 * "a|b|c" → ["a","b","c"]；"a|" → ["a"]；"  " → []。
 * 用于 TagInput 的分隔逻辑和粘贴批量解析。
 */
export function splitModelIds(input: string): string[] {
  return input
    .split("|")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * 校验持久化的模型标识（"slug/id"）是否仍存在于当前 providers 中。
 * 派生规则统一走 resolveProviderSlug（优先 provider.slug，否则 name 派生），
 * 与 ModelSelector / kernel slugifyProviders 保持一致。provider 被删除后 prefs 里
 * 残留的过期 model 会返回 false，发送闸门据此拦截，避免"未配置模型也能发出消息"。
 * 类型谓词：返回 true 时把 model 收窄为 string，方便调用方直接透传。
 */
export function isModelAvailable(model: string | null | undefined, providers: ModelProvider[]): model is string {
  if (!model) return false;
  const slugs: string[] = [];
  return providers.some(p => {
    const slug = resolveProviderSlug(p, slugs);
    slugs.push(slug);
    return p.models.some(m => `${slug}/${m.id}` === model);
  });
}
