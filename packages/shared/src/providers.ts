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
