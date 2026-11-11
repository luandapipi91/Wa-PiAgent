// 移植自 pi-knowledge@0.13.0 dist/src/search/ranking.js（MIT）
// 排序质量层：融合分 → 加权分（路径/文件名命中、文档意图、测试与本地化副本降权），
// 以及词法证据门（覆盖率，源码文件命中可直接放行）。
// 函数与常量逐字搬运上游；仅把 chunk 形状换成 Wa-Pi 的 RankChunk。
// 上游 buildChunkEmbeddingText(chunk) 会拼 `File:`/`Section:` 上下文前缀；Wa-Pi 不复制
// 前缀字符串，改用「title + breadcrumb + content」，保证「文件名/标题精确命中、正文只是
// 引用该词」的块不被词法证据门误杀。
import type { KbSearchRanking } from "@wa-pi/shared";
import { signalTokens, tokenizeForSearch } from "./query";
import type { RankChunk } from "./contracts";

/** 最低融合分（上游默认 0.18）：低于此分的命中即使排在前面也整体丢弃 */
export const MIN_HYBRID_SCORE = 0.18;

export const FILE_TYPE_ALIASES: Record<string, string> = {
  csharp: "csharp",
  cs: "csharp",
  c: "c",
  cc: "cpp",
  cxx: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mdx: "markdown",
  php: "php",
  py: "python",
  qml: "qml",
  rb: "ruby",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

const SOURCE_FILE_TYPES = new Set([
  "bash",
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "javascript",
  "php",
  "python",
  "qml",
  "ruby",
  "rust",
  "typescript",
]);

const TEST_PATH_PATTERNS = ["_test.", ".test.", ".spec.", "/test/", "/tests/", "tests/", "__tests__/", "spec/"];

export function normalizeFileTypeFilter(fileType: string | undefined): string | undefined {
  if (!fileType) return undefined;
  const normalized = fileType.trim().toLowerCase();
  return FILE_TYPE_ALIASES[normalized] ?? normalized;
}

/** Wa-Pi chunks.file_type（scan.ts 的 KbFileType）→ 上游排序词汇。
 * md/txt 在上游别名表里分别有 md→markdown；txt 没有 txt→text 规则，必须自建这张表。
 * docx/pdf 上游没有对应类型，保持原样：天然不参与 documentationBoost /
 * isLocalizationPath / sourceFileBoost（它们的判定集合里都没有 docx/pdf）。 */
const KB_FILE_TYPE_ALIASES: Record<string, string> = {
  md: "markdown",
  txt: "text",
  html: "html",
  docx: "docx",
  pdf: "pdf",
};

/** 把 Wa-Pi 存储的文件类型（或上游别名，如 ts/markdown）归一到排序层词汇 */
export function normalizeKbFileType(fileType: string): string {
  const normalized = fileType.trim().toLowerCase();
  return KB_FILE_TYPE_ALIASES[normalized] ?? normalizeFileTypeFilter(normalized) ?? normalized;
}

/** 覆盖率/词法证据的判定文本：title + breadcrumb + content（对齐上游 buildChunkEmbeddingText 的作用） */
export function buildChunkEmbeddingText(
  chunk: Pick<RankChunk, "content" | "title" | "breadcrumb">,
): string {
  return [chunk.title, chunk.breadcrumb, chunk.content].filter(Boolean).join("\n");
}

export function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return TEST_PATH_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function queryAsksForTests(queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  return ["assert", "fixture", "spec", "test", "testing"].some((token) => signals.has(token));
}

function queryAsksForUserGuide(queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  return ["config", "configuration", "install", "onboard", "quickstart", "setup", "start", "usage"].some((token) => signals.has(token));
}

function queryAsksForLocalization(queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  return ["i18n", "lang", "language", "locale", "localization", "translation"].some((token) => signals.has(token));
}

export function isLocalizationPath(filePath: string, fileType: string): boolean {
  if (!["json", "markdown", "text", "toml", "yaml"].includes(fileType)) return false;
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/locale/") ||
    lower.startsWith("locale/") ||
    lower.includes("/locales/") ||
    lower.startsWith("locales/") ||
    lower.includes("/lang/") ||
    lower.startsWith("lang/") ||
    lower.includes("/i18n/") ||
    lower.startsWith("i18n/") ||
    lower.includes("/translations/") ||
    lower.startsWith("translations/")
  );
}

export function queryCoverage(text: string, queryTokens: Set<string>): number {
  const textTokens = signalTokens(tokenizeForSearch(text));
  const signals = signalTokens(queryTokens);
  if (signals.size === 0) return 0;
  let matched = 0;
  for (const token of signals) {
    if (textTokens.has(token)) matched++;
  }
  return matched / signals.size;
}

export function hasAnyLexicalEvidence(text: string, queryTokens: Set<string>): boolean {
  return queryCoverage(text, queryTokens) > 0;
}

export function pathTokenBoost(filePath: string, queryTokens: Set<string>): number {
  const pathTokens = signalTokens(tokenizeForSearch(filePath.replace(/[./_-]/g, " ")));
  const signals = signalTokens(queryTokens);
  let matched = 0;
  for (const token of signals) {
    if (pathTokens.has(token)) matched++;
  }
  if (matched === 0) return 0;
  return Math.min(0.45, 0.18 * matched);
}

export function basenameTokenBoost(filePath: string, queryTokens: Set<string>): number {
  const basename = filePath.split("/").at(-1) ?? filePath;
  const stem = basename.replace(/\.[^.]+$/, "").replace(/_test$|\.test$|\.spec$/i, "");
  const baseTokens = signalTokens(tokenizeForSearch(stem.replace(/[._-]/g, " ")));
  const signals = signalTokens(queryTokens);
  if (baseTokens.size === 0 || signals.size === 0) return 0;
  for (const token of signals) {
    if (baseTokens.has(token)) return 0.32;
  }
  return 0;
}

export function sourceFileBoost(
  chunk: Pick<RankChunk, "filePath" | "fileType">,
  queryTokens: Set<string>,
): number {
  if (!SOURCE_FILE_TYPES.has(chunk.fileType)) return 0;
  if (queryAsksForUserGuide(queryTokens)) return Math.min(0.05, pathTokenBoost(chunk.filePath, queryTokens));
  const boost = basenameTokenBoost(chunk.filePath, queryTokens);
  if (boost > 0) return boost;
  const boostFromPath = pathTokenBoost(chunk.filePath, queryTokens);
  return Math.min(0.22, boostFromPath);
}

function documentationBoost(
  chunk: Pick<RankChunk, "filePath" | "fileType">,
  queryTokens: Set<string>,
): number {
  if (!queryAsksForUserGuide(queryTokens)) return 0;
  const lower = chunk.filePath.toLowerCase();
  if (chunk.fileType !== "markdown") return 0;
  if (
    lower.includes("install") ||
    lower.includes("readme") ||
    lower.includes("getting-started") ||
    lower.includes("quickstart")
  ) {
    return 0.85;
  }
  if (lower.startsWith("docs/")) return 0.35;
  return 0;
}

export type RankingDiagnostics = KbSearchRanking;

export function scoreChunkForQuery(
  baseScore: number,
  chunk: RankChunk,
  queryTokens: Set<string>,
): RankingDiagnostics {
  const guideIntent = queryAsksForUserGuide(queryTokens);
  const pathBoost =
    guideIntent && SOURCE_FILE_TYPES.has(chunk.fileType)
      ? Math.min(0.08, pathTokenBoost(chunk.filePath, queryTokens))
      : pathTokenBoost(chunk.filePath, queryTokens);
  const sourceBoost = sourceFileBoost(chunk, queryTokens);
  const docBoost = documentationBoost(chunk, queryTokens);
  const testIntent = queryAsksForTests(queryTokens);
  const test = isTestPath(chunk.filePath);
  const localization = isLocalizationPath(chunk.filePath, chunk.fileType);
  const localizationPenalty = localization && !queryAsksForLocalization(queryTokens) ? 0.2 : 1;
  let adjustedScore = baseScore + pathBoost + sourceBoost + docBoost;
  if (test && !testIntent) adjustedScore *= 0.48;
  if (!test && testIntent) adjustedScore *= 0.88;
  adjustedScore *= localizationPenalty;
  return {
    adjusted_score: adjustedScore,
    base_score: baseScore,
    coverage: queryCoverage(buildChunkEmbeddingText(chunk), queryTokens),
    documentation_boost: docBoost,
    is_localization: localization,
    is_test: test,
    localization_penalty: localizationPenalty,
    path_boost: pathBoost,
    source_boost: sourceBoost,
    test_intent: testIntent,
    user_guide_intent: guideIntent,
  };
}

export function hasEnoughLexicalEvidence(chunk: RankChunk, queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  if (signals.size <= 1) return true;
  if (sourceFileBoost(chunk, queryTokens) >= 0.22) return true;
  const coverage = queryCoverage(buildChunkEmbeddingText(chunk), queryTokens);
  if (signals.size <= 3) return coverage >= 1 / signals.size;
  return coverage >= 0.34;
}
