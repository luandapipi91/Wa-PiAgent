// 移植自 pi-knowledge@0.13.0 dist/src/search/tuning.js（MIT）
// 一次查询的「调优参数」：按 profile 给默认预算，再允许环境变量逐项覆盖并夹紧到安全区间。
import type { KbSearchProfile } from "@wa-pi/shared";
import { MAX_SEARCH_RESULTS, MAX_SEARCH_WINDOW } from "./contracts";
import { MIN_HYBRID_SCORE } from "./ranking";

/** 对外可选的 profile（auto = 由查询内容与 mode 自动选） */
export type SearchProfile = KbSearchProfile;

/** 解析后的具体 profile（auto 之外七种，对应 PROFILE_DEFAULTS 的键） */
type ConcreteProfile = Exclude<SearchProfile, "auto">;

interface ProfileDefaults {
  defaultLimit: number;
  snippetMaxLength: number;
  minHybridScore: number;
  candidateMin: number;
  candidateMultiplier: number;
  adaptiveContextLines: number;
  adaptiveMaxContextChars: number;
  adaptiveNeighborTarget: number;
  deepRerankCandidates: number;
  deepRerankTopKMultiplier: number;
}

export interface SearchTuningInput {
  query: string;
  mode: string;
  profile?: SearchProfile;
  kbSourceTypes: string[];
}

export interface SearchTuning extends ProfileDefaults {
  requestedProfile: SearchProfile;
  selectedProfile: ConcreteProfile;
}

export const PROFILE_DEFAULTS: Record<ConcreteProfile, ProfileDefaults> = {
  balanced: {
    defaultLimit: 10,
    snippetMaxLength: 240,
    minHybridScore: MIN_HYBRID_SCORE,
    candidateMin: 50,
    candidateMultiplier: 12,
    adaptiveContextLines: 80,
    adaptiveMaxContextChars: 6_000,
    adaptiveNeighborTarget: 5,
    deepRerankCandidates: 30,
    deepRerankTopKMultiplier: 3,
  },
  low_token: {
    defaultLimit: 5,
    snippetMaxLength: 768,
    minHybridScore: 0.4,
    candidateMin: 35,
    candidateMultiplier: 8,
    adaptiveContextLines: 80,
    adaptiveMaxContextChars: 6_000,
    adaptiveNeighborTarget: 5,
    deepRerankCandidates: 20,
    deepRerankTopKMultiplier: 2,
  },
  precision: {
    defaultLimit: 5,
    snippetMaxLength: 400,
    minHybridScore: 0.4,
    candidateMin: 30,
    candidateMultiplier: 6,
    adaptiveContextLines: 60,
    adaptiveMaxContextChars: 4_000,
    adaptiveNeighborTarget: 4,
    deepRerankCandidates: 20,
    deepRerankTopKMultiplier: 2,
  },
  recall: {
    defaultLimit: 15,
    snippetMaxLength: 320,
    minHybridScore: 0.12,
    candidateMin: 75,
    candidateMultiplier: 16,
    adaptiveContextLines: 100,
    adaptiveMaxContextChars: 8_000,
    adaptiveNeighborTarget: 6,
    deepRerankCandidates: 40,
    deepRerankTopKMultiplier: 3,
  },
  long_context: {
    defaultLimit: 5,
    snippetMaxLength: 1_000,
    minHybridScore: 0.25,
    candidateMin: 50,
    candidateMultiplier: 10,
    adaptiveContextLines: 120,
    adaptiveMaxContextChars: 10_000,
    adaptiveNeighborTarget: 7,
    deepRerankCandidates: 30,
    deepRerankTopKMultiplier: 2,
  },
  code: {
    defaultLimit: 10,
    snippetMaxLength: 320,
    minHybridScore: 0.25,
    candidateMin: 50,
    candidateMultiplier: 12,
    adaptiveContextLines: 80,
    adaptiveMaxContextChars: 6_000,
    adaptiveNeighborTarget: 5,
    deepRerankCandidates: 30,
    deepRerankTopKMultiplier: 3,
  },
  docs: {
    defaultLimit: 8,
    snippetMaxLength: 768,
    minHybridScore: 0.22,
    candidateMin: 60,
    candidateMultiplier: 12,
    adaptiveContextLines: 120,
    adaptiveMaxContextChars: 9_000,
    adaptiveNeighborTarget: 7,
    deepRerankCandidates: 30,
    deepRerankTopKMultiplier: 3,
  },
};

const SEARCH_PROFILES = new Set<string>([
  "auto",
  "balanced",
  "low_token",
  "precision",
  "recall",
  "long_context",
  "code",
  "docs",
]);

function parseProfile(value: string | undefined): SearchProfile | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return SEARCH_PROFILES.has(normalized) ? (normalized as SearchProfile) : undefined;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 精确符号 / 代码风格查询（全大写常量、文件名、函数调用、a.b、驼峰、snake_case 片段） */
function looksExactOrCodeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed)) return true;
  if (/^[\w./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|yml|yaml|toml)$/.test(lower)) return true;
  return /[A-Za-z_$][\w$]*\([^)]*\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*|\b[A-Z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b|\b[a-z]+[A-Z][A-Za-z0-9_$]*\b/.test(
    trimmed,
  );
}

/** 排错型查询 */
function looksErrorQuery(query: string): boolean {
  return /\b(error|exception|failed|failure|stack|trace|enoent|eacces|timeout|abort|cancelled|錯誤|失敗)\b/i.test(
    query,
  );
}

/** 长上下文型查询（问句/文档语汇，或 ≥10 个词） */
function looksLongContextQuery(query: string): boolean {
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  return (
    wordCount >= 10 ||
    /\b(explain|why|how|architecture|design|overview|docs?|spec|manual|guide)\b|流程|架構|概念|為什麼|如何|文件|規格/i.test(
      query,
    )
  );
}

/** auto 的判据：mode 优先（代码类→precision、文档类→long_context、语义类→recall），再看查询形状与来源类型 */
function chooseRuntimeProfile(input: SearchTuningInput): ConcreteProfile {
  if (input.mode === "code" || input.mode === "config" || input.mode === "errors" || input.mode === "fast") {
    return "precision";
  }
  if (input.mode === "docs" || input.mode === "decision" || input.mode === "adaptive") return "long_context";
  if (input.mode === "semantic" || input.mode === "semantic_hybrid") return "recall";
  if (looksErrorQuery(input.query) || looksExactOrCodeQuery(input.query)) return "precision";
  const hasDocumentSource = input.kbSourceTypes.some((sourceType) => sourceType === "url" || sourceType === "text");
  if (looksLongContextQuery(input.query) || hasDocumentSource) return "long_context";
  return "balanced";
}

/** 分页窗口校验：limit 1-50、offset 非负、offset+limit ≤ 800 */
export function resolveSearchWindow(
  limit: number | undefined,
  offset: number | undefined,
  defaultLimit: number,
): { limit: number; offset: number } {
  const resolvedLimit = limit ?? defaultLimit;
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > MAX_SEARCH_RESULTS) {
    throw new Error(`Search limit must be an integer from 1 to ${MAX_SEARCH_RESULTS}`);
  }
  const resolvedOffset = offset ?? 0;
  if (!Number.isInteger(resolvedOffset) || resolvedOffset < 0) {
    throw new Error("Search offset must be a non-negative integer");
  }
  if (resolvedOffset + resolvedLimit > MAX_SEARCH_WINDOW) {
    throw new Error(
      `Search offset + limit must not exceed ${MAX_SEARCH_WINDOW}; narrow the query or use a more specific knowledge base`,
    );
  }
  return { limit: resolvedLimit, offset: resolvedOffset };
}

/** 解析本次查询的调优参数：显式 profile > 环境变量 PI_KNOWLEDGE_SEARCH_PROFILE > auto，再逐项夹紧 */
export function resolveSearchTuning(input: SearchTuningInput): SearchTuning {
  // 非法 profile（外部调用方/历史环境变量写入脏值）回落 auto，不让脏值抛 TypeError
  const requestedProfile =
    parseProfile(input.profile) ?? parseProfile(process.env.PI_KNOWLEDGE_SEARCH_PROFILE) ?? "auto";
  const selectedProfile = requestedProfile === "auto" ? chooseRuntimeProfile(input) : requestedProfile;
  const base = PROFILE_DEFAULTS[selectedProfile];
  return {
    requestedProfile,
    selectedProfile,
    defaultLimit: clampInt(envNumber("PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT"), base.defaultLimit, 1, 50),
    snippetMaxLength: clampInt(envNumber("PI_KNOWLEDGE_SNIPPET_MAX_LENGTH"), base.snippetMaxLength, 80, 4_000),
    minHybridScore: clampNumber(envNumber("PI_KNOWLEDGE_MIN_HYBRID_SCORE"), base.minHybridScore, 0, 1),
    candidateMin: clampInt(envNumber("PI_KNOWLEDGE_SEARCH_CANDIDATE_MIN"), base.candidateMin, 10, 500),
    candidateMultiplier: clampInt(
      envNumber("PI_KNOWLEDGE_SEARCH_CANDIDATE_MULTIPLIER"),
      base.candidateMultiplier,
      2,
      30,
    ),
    adaptiveContextLines: clampInt(envNumber("PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES"), base.adaptiveContextLines, 10, 500),
    adaptiveMaxContextChars: clampInt(
      envNumber("PI_KNOWLEDGE_ADAPTIVE_MAX_CHARS"),
      base.adaptiveMaxContextChars,
      1_000,
      50_000,
    ),
    adaptiveNeighborTarget: clampInt(
      envNumber("PI_KNOWLEDGE_ADAPTIVE_NEIGHBOR_TARGET"),
      base.adaptiveNeighborTarget,
      1,
      20,
    ),
    deepRerankCandidates: clampInt(envNumber("PI_KNOWLEDGE_DEEP_RERANK_CANDIDATES"), base.deepRerankCandidates, 5, 100),
    deepRerankTopKMultiplier: clampInt(
      envNumber("PI_KNOWLEDGE_DEEP_RERANK_TOPK_MULTIPLIER"),
      base.deepRerankTopKMultiplier,
      1,
      10,
    ),
  };
}

/** 调优参数 → 检索结果里的诊断字段（下划线命名，对齐上游输出契约） */
export function summarizeSearchTuning(tuning: SearchTuning, limit: number, candidateLimit: number) {
  return {
    requested_profile: tuning.requestedProfile,
    selected_profile: tuning.selectedProfile,
    limit,
    snippet_max_length: tuning.snippetMaxLength,
    min_hybrid_score: tuning.minHybridScore,
    candidate_limit: candidateLimit,
    retrieval_limit_per_kb: candidateLimit,
    retrieved_candidates: 0,
    filtered_candidates: 0,
    diversity_candidates: 0,
    candidate_pool_truncated: false,
    candidate_min: tuning.candidateMin,
    candidate_multiplier: tuning.candidateMultiplier,
    adaptive_context_lines: tuning.adaptiveContextLines,
    adaptive_max_context_chars: tuning.adaptiveMaxContextChars,
    adaptive_neighbor_target: tuning.adaptiveNeighborTarget,
    deep_rerank_candidates: tuning.deepRerankCandidates,
    deep_rerank_top_k_multiplier: tuning.deepRerankTopKMultiplier,
  };
}
