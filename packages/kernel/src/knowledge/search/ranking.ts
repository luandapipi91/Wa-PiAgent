// 检索排序的质量层：置信门与词法证据门（移植自 pi-knowledge search/ranking.ts 的判定语义）。
// 目标：低分命中不再凑数——融合分低于门槛、或与查询几乎没有词法重叠的块不进结果。
import { bigram } from "../../memory/bigram";

/** 最低融合分（上游默认 0.18）：低于此分的命中即使排在前面也整体丢弃 */
export const MIN_HYBRID_SCORE = 0.18;

/** 单字与标点不算信号词（中文 bigram 里"的/了"类噪声不参与覆盖率） */
const STOP_CHARS = new Set(["的", "了", "是", "在", "和", "与", "或", "也", "都", "就"]);

/** 查询 token 集：bigram 切分后去掉纯标点与停用单字 */
export function queryTokensOf(query: string): Set<string> {
  const tokens = bigram(query).split(/\s+/).filter(Boolean);
  return new Set(tokens.filter((t) => !(t.length === 1 && STOP_CHARS.has(t))));
}

/** 信号词（用于判定"查询是否足够具体"）：去掉停用词后的 token */
export function signalTokens(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter((t) => !(t.length === 1 && STOP_CHARS.has(t))));
}

/** 查询 token 在文本中的命中比例（0~1） */
export function queryCoverage(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 1;
  let hit = 0;
  for (const t of queryTokens) if (text.includes(t)) hit++;
  return hit / queryTokens.size;
}

/**
 * 词法证据门：与查询几乎没有词法重叠的块不进结果。
 * - 信号词 ≤1（短查询/单个术语）：直接放行（此时全靠语义通道）
 * - 信号词 ≤3：要求覆盖率达到 1/signals
 * - 更多信号词：要求覆盖率 ≥ 0.34（长问句允许部分重叠）
 */
export function hasEnoughLexicalEvidence(text: string, queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  if (signals.size <= 1) return true;
  const coverage = queryCoverage(text, queryTokens);
  if (signals.size <= 3) return coverage >= 1 / signals.size;
  return coverage >= 0.34;
}

/** 测试路径（与文档库无关但偶有出现的同名资料）：非测试意图时降权 */
const TEST_PATH_PATTERNS = ["__tests__/", "/test/", "/tests/", ".test.", ".spec.", "spec/"];

/** 本地化目录：查询没有本地化意图时降权（多语言副本会被反复命中） */
const LOCALIZATION_PATTERNS = ["locales/", "i18n/", ".i18n.", "_i18n."];

function hasAny(text: string, patterns: string[]): boolean {
	const lower = text.toLowerCase();
	return patterns.some((p) => lower.includes(p));
}

/** 查询是否在问测试（"测试/用例/test/spec"） */
export function queryAsksForTests(tokens: Set<string>): boolean {
	return [...tokens].some((t) => /测试|用例|单测|test|spec/i.test(t));
}

/** 查询是否在问本地化文案 */
function queryAsksForLocalization(tokens: Set<string>): boolean {
	return [...tokens].some((t) => /i18n|国际化|本地化|翻译|locale/i.test(t));
}

/** 路径段/文件名命中查询 token 的加分（最多 0.12） */
export function pathTokenBoost(filePath: string, tokens: Set<string>): number {
	const lower = filePath.toLowerCase();
	let hits = 0;
	for (const t of tokens) if (t.length >= 2 && lower.includes(t.toLowerCase())) hits++;
	return Math.min(0.12, hits * 0.04);
}

/** 文档意图加权：README / quickstart / install / getting-started 类文件（0.85），docs/ 前缀（0.35） */
export function documentationBoost(filePath: string, tokens: Set<string>): number {
	const lower = filePath.toLowerCase();
	const wantsGuide = [...tokens].some((t) =>
		/readme|install|getting-started|quickstart|入门|安装|快速开始/i.test(t),
	);
	if (wantsGuide && /readme|install|getting-started|quickstart/.test(lower)) return 0.85;
	if (lower.startsWith("docs/") || lower.includes("/docs/")) return 0.35;
	return 0;
}

export interface RankingScore {
	adjustedScore: number;
	baseScore: number;
	coverage: number;
	pathBoost: number;
	docBoost: number;
	isTest: boolean;
	isLocalization: boolean;
}

/**
 * 融合分 → 加权分：路径/文件名命中加分、文档意图加权、测试与本地化副本降权。
 * 纯函数，只依赖 file_path / file_type 与查询 token；返回诊断字段供后续排查。
 */
export function scoreChunkForQuery(
	baseScore: number,
	chunk: { file_path: string; file_type: string },
	queryTokens: Set<string>,
): RankingScore {
	const pathBoost = pathTokenBoost(chunk.file_path, queryTokens);
	const docBoost = documentationBoost(chunk.file_path, queryTokens);
	const isTest = hasAny(chunk.file_path, TEST_PATH_PATTERNS);
	const isLocalization = hasAny(chunk.file_path, LOCALIZATION_PATTERNS);
	let adjustedScore = baseScore + pathBoost + docBoost;
	if (isTest && !queryAsksForTests(queryTokens)) adjustedScore *= 0.48;
	if (isLocalization && !queryAsksForLocalization(queryTokens)) adjustedScore *= 0.2;
	return {
		adjustedScore,
		baseScore,
		coverage: queryCoverage(chunk.file_path, queryTokens),
		pathBoost,
		docBoost,
		isTest,
		isLocalization,
	};
}
