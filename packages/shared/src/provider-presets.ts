import type { ProviderApi, ProviderModel } from "./providers";

/** 供应商预设（填表模板，不含 id / apiKey） */
export interface ProviderPreset {
  /** 唯一标识，如 "glm" / "glm-coding-plan" / "deepseek" */
  key: string;
  /** 默认显示名，如 "智谱 GLM（编程计划）" */
  name: string;
  baseUrl: string;
  /** "openai-completions" | "anthropic-messages" */
  api: ProviderApi;
  models: ProviderModel[];
  /** 是否「计划」接入（独立端点）→ 下拉加 🏷 前缀 */
  plan?: boolean;
  /** 可选提示文案（计划类 / 聚合代理用于说明 Key 要求 / 合规限制） */
  hint?: string;
}

/**
 * 10 条主流供应商预设。模型数值（contextWindow / maxTokens / supportsVision）
 * 为 2026-07 各官方文档的最佳近似，用户在表单里均可改。详见
 * docs/superpowers/specs/2026-07-10-provider-presets-design.md。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "glm",
    name: "智谱 GLM（标准）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    api: "openai-completions",
    models: [
      { id: "glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "glm-4.7", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
  {
    key: "glm-coding-plan",
    name: "智谱 GLM（编程计划）",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
    plan: true,
    hint: "智谱编程套餐专用端点，需购买 Coding Plan 并使用套餐 Key；套餐 Key 与标准端点不通用，用错端点会报余额不足。",
    models: [
      { id: "glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "glm-4.7", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", contextWindow: 64000, maxTokens: 8192 },
      { id: "deepseek-reasoner", contextWindow: 64000, maxTokens: 32768 },
    ],
  },
  {
    key: "kimi",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      { id: "kimi-k2.7-code", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
      { id: "kimi-k2.7-code-highspeed", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
    ],
  },
  {
    key: "claude",
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      { id: "claude-opus-4-8", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-fable-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 128000, supportsVision: true },
    ],
  },
  {
    key: "gpt",
    name: "OpenAI GPT",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [
      { id: "gpt-5.5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "gpt-5", contextWindow: 400000, maxTokens: 128000, supportsVision: true },
    ],
  },
  {
    key: "qwen",
    name: "阿里通义 Qwen（标准）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: [
      { id: "qwen3-max", contextWindow: 131072, maxTokens: 16384 },
      { id: "qwen3-coder-plus", contextWindow: 262144, maxTokens: 65536 },
      { id: "qwen3-plus", contextWindow: 1048576, maxTokens: 16384 },
    ],
  },
  {
    key: "doubao",
    name: "火山豆包 Doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    hint: "豆包模型 ID 带版本日期、易变；也可在方舟控制台创建推理接入点，用 ep-xxx 接入点 ID 替代。",
    models: [
      { id: "doubao-seed-2.1", contextWindow: 262144, maxTokens: 32768 },
      { id: "doubao-seed-2-0-lite-260428", contextWindow: 262144, maxTokens: 16384 },
    ],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    hint: "OpenRouter 为聚合代理，模型 slug 形如 提供商/模型名；具体上下文 / 输出上限以 openrouter.ai/models 为准。",
    models: [
      { id: "z-ai/glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "anthropic/claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "openai/gpt-5.5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "moonshotai/kimi-k2.7-code", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
    ],
  },
  {
    key: "bailian-coding-plan",
    name: "阿里云百炼编程计划",
    baseUrl: "https://coding.dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    plan: true,
    hint: "阿里云百炼编程计划专属端点，需 sk-sp- 开头专属 Key；官方限制仅限交互式编程工具使用，禁止用于自动化脚本 / 自定义应用后端 —— HiAgent 作为应用后端调用存在合规风险，使用前请确认。OpenAI 兼容端点确切路径公开资料有限，需核对。",
    models: [
      { id: "qwen3-coder-plus", contextWindow: 262144, maxTokens: 65536 },
      { id: "qwen3-max", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
];
