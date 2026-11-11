// 移植自 pi-knowledge@0.13.0 dist/src/search/reranker-config.js（MIT）
//
// Wa-Pi 适配点（唯一一处偏离上游）：remoteHost 在既没有设 PI_KNOWLEDGE_RERANKER_REMOTE_HOST、
// 模型也不是完整 URL 时，回落到既有的 WA_PI_HF_ENDPOINT（缺省 https://hf-mirror.com/），
// 与 embedder/reranker 加载器的镜像策略保持一致——国内部署的镜像配置不会因为引入上游
// 配置层而失效。环境变量名一律保留上游 PI_KNOWLEDGE_RERANKER*，不重命名。

export type RerankerProvider = "hf" | "api";
export type ApiRerankerFormat = "cohere" | "jina" | "custom-json" | "tei";
export type ApiScoreDirection = "desc" | "asc";

export interface HfRerankerConfig {
  provider: "hf";
  model: string;
  revision: string;
  dtype?: string;
  remoteHost?: string;
  remotePathTemplate?: string;
  /** true = 直接取模型原始 logit（cross-encoder 的 sigmoid 会把分数压饱和） */
  rawLogits?: boolean;
}

export interface ApiRerankerConfig {
  provider: "api";
  model: string;
  endpoint: string;
  apiKey?: string;
  format: ApiRerankerFormat;
  timeoutMs: number;
  maxDocumentChars: number;
  resultsPath: string;
  indexField: string;
  scoreField: string;
  scoreDirection: ApiScoreDirection;
}

export type RerankerConfig = HfRerankerConfig | ApiRerankerConfig;

export const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-4-v2";
export const DEFAULT_RERANKER_REVISION = "main";
export const DEFAULT_RERANKER_REMOTE_HOST = "https://huggingface.co/";
export const DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE = "{model}/resolve/{revision}/";
export const DEFAULT_RERANKER_API_TIMEOUT_MS = 30_000;
export const DEFAULT_RERANKER_MAX_DOC_CHARS = 12_000;

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripProviderPrefix(raw: string): { provider?: RerankerProvider; value: string } {
  const separator = raw.indexOf(":");
  if (separator <= 0) return { provider: undefined, value: raw };
  const prefix = raw.slice(0, separator).toLowerCase();
  if (prefix !== "hf" && prefix !== "api") return { provider: undefined, value: raw };
  return { provider: prefix, value: raw.slice(separator + 1) };
}

interface ParsedHfUrl {
  model: string;
  revision?: string;
  remoteHost?: string;
}

function parseHuggingFaceUrl(raw: string): ParsedHfUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported reranker model URL protocol: ${url.protocol}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid Hugging Face reranker URL: ${raw}`);
  const model = `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`;
  let revision: string | undefined;
  const treeIndex = parts.indexOf("tree");
  const resolveIndex = parts.indexOf("resolve");
  if (treeIndex >= 0 && parts[treeIndex + 1]) revision = decodeURIComponent(parts[treeIndex + 1]);
  if (resolveIndex >= 0 && parts[resolveIndex + 1])
    revision = decodeURIComponent(parts[resolveIndex + 1]);
  return { model, revision, remoteHost: `${url.origin}/` };
}

function resolveHfModel(raw: string): ParsedHfUrl {
  const parsedUrl = parseHuggingFaceUrl(raw);
  if (parsedUrl) return parsedUrl;
  if (!raw.includes("/") || raw.startsWith("/") || raw.endsWith("/")) {
    throw new Error(`Invalid reranker model id: ${raw}`);
  }
  return { model: raw };
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeApiFormat(value: string | undefined): ApiRerankerFormat {
  if (value === undefined) return "cohere";
  const normalized = value.toLowerCase();
  if (
    normalized === "cohere" ||
    normalized === "jina" ||
    normalized === "custom-json" ||
    normalized === "tei"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported reranker API format: ${value}`);
}

function normalizeScoreDirection(value: string | undefined): ApiScoreDirection {
  if (value === undefined) return "desc";
  const normalized = value.toLowerCase();
  if (normalized === "desc" || normalized === "asc") return normalized;
  throw new Error(`Unsupported reranker score direction: ${value}`);
}

function endpointFromBaseUrl(baseUrl: string): string {
  return new URL("rerank", `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function normalizeHttpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported reranker API endpoint protocol: ${url.protocol}`);
  }
  return url.toString();
}

function resolveApiRerankerConfig(model: string, env: NodeJS.ProcessEnv): ApiRerankerConfig {
  const endpoint = normalizeHttpUrl(
    cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_ENDPOINT) ??
      endpointFromBaseUrl(
        cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_BASE_URL) ??
          cleanEnv(env.OPENAI_BASE_URL) ??
          "https://api.cohere.com/v2",
      ),
  );
  const format = normalizeApiFormat(cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_FORMAT));
  return {
    provider: "api",
    model,
    endpoint,
    apiKey: cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_KEY) ?? cleanEnv(env.OPENAI_API_KEY),
    format,
    timeoutMs: parseNumber(
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_TIMEOUT_MS),
      DEFAULT_RERANKER_API_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    maxDocumentChars: parseNumber(
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_MAX_DOC_CHARS),
      DEFAULT_RERANKER_MAX_DOC_CHARS,
      100,
      200_000,
    ),
    resultsPath:
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_RESULTS_PATH) ?? (format === "tei" ? "" : "results"),
    indexField: cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_INDEX_FIELD) ?? "index",
    scoreField:
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_SCORE_FIELD) ??
      (format === "tei" ? "score" : "relevance_score"),
    scoreDirection: normalizeScoreDirection(
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_API_SCORE_DIRECTION),
    ),
  };
}

/** Wa-Pi 既有镜像端点（与原 reranker/embedder 加载器的回落保持一致） */
function waPiRemoteHost(env: NodeJS.ProcessEnv): string {
  const endpoint = cleanEnv(env.WA_PI_HF_ENDPOINT) ?? "https://hf-mirror.com";
  return `${endpoint.replace(/\/+$/, "")}/`;
}

export function resolveRerankerConfig(env: NodeJS.ProcessEnv = process.env): RerankerConfig {
  const raw = cleanEnv(env.PI_KNOWLEDGE_RERANKER) ?? `hf:${DEFAULT_RERANKER_MODEL}`;
  const { provider, value } = stripProviderPrefix(raw);
  if (provider === "api") {
    const model = value.trim();
    if (!model) throw new Error("PI_KNOWLEDGE_RERANKER=api:<model> requires a model name");
    return resolveApiRerankerConfig(model, env);
  }
  if (provider !== undefined && provider !== "hf")
    throw new Error(`Unsupported reranker provider: ${provider}`);
  const modelSource = value.trim();
  if (!modelSource) throw new Error("PI_KNOWLEDGE_RERANKER requires a model id or URL");
  const resolved = resolveHfModel(modelSource);
  const revision =
    cleanEnv(env.PI_KNOWLEDGE_RERANKER_REVISION) ?? resolved.revision ?? DEFAULT_RERANKER_REVISION;
  const rawLogits = cleanEnv(env.PI_KNOWLEDGE_RERANKER_RAW_LOGITS) === "true";
  return {
    provider: "hf",
    model: resolved.model,
    revision,
    dtype: cleanEnv(env.PI_KNOWLEDGE_RERANKER_DTYPE),
    remoteHost:
      cleanEnv(env.PI_KNOWLEDGE_RERANKER_REMOTE_HOST) ??
      resolved.remoteHost ??
      waPiRemoteHost(env),
    remotePathTemplate: cleanEnv(env.PI_KNOWLEDGE_RERANKER_REMOTE_PATH_TEMPLATE),
    ...(rawLogits ? { rawLogits: true } : {}),
  };
}

export function isHfRerankerConfig(value: unknown): value is HfRerankerConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    config.provider === "hf" &&
    typeof config.model === "string" &&
    config.model.length > 0 &&
    typeof config.revision === "string" &&
    config.revision.length > 0 &&
    (config.dtype === undefined || typeof config.dtype === "string") &&
    (config.remoteHost === undefined || typeof config.remoteHost === "string") &&
    (config.remotePathTemplate === undefined || typeof config.remotePathTemplate === "string") &&
    (config.rawLogits === undefined || typeof config.rawLogits === "boolean")
  );
}

export function rerankerCacheKey(config: HfRerankerConfig): string {
  return [
    config.provider,
    config.model,
    config.revision,
    config.dtype ?? "",
    config.remoteHost ?? "",
    config.remotePathTemplate ?? "",
    config.rawLogits ? "raw" : "sigmoid",
  ].join("\u0000");
}
