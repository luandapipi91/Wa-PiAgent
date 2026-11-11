// 七种检索模式（完整对齐 pi-knowledge 的策略集合）：
//   hybrid / fast / semantic / semantic_hybrid / adaptive / deep / auto
// 每种模式由一张规格表描述「词法、语义、词法锚定、门控、扩窗、候选倍数、是否重排」，
// search.ts 按规格参数化管线；auto 另有一层判据 + 弱结果回退链。
import { queryCoverage, queryTokensOf } from "./ranking";

/** 对外可选模式（工具参数 mode 的取值） */
export type SearchMode =
	| "hybrid"
	| "fast"
	| "semantic"
	| "semantic_hybrid"
	| "adaptive"
	| "deep"
	| "auto";

/** 解析后的具体模式（auto 之外的六种；也是 KbSearchResult.mode 的取值域） */
export type ResolvedMode = Exclude<SearchMode, "auto">;

/** 词法通道行为：off=不跑 FTS；and_only=只跑严格短语（关 OR 回退）；and_or=短语零命中降级 OR */
export type LexicalPolicy = "off" | "and_only" | "and_or";

/**
 * 门控策略：
 * - strong：分数 ≥ 0.18 且词法证据足够（hybrid / adaptive / deep）
 * - score：只要分数达标（semantic_hybrid：去掉词法证据约束）
 * - coverage：只要该块被词法命中（fast：任一词命中即放行）
 * - none：不过门（semantic：纯向量，靠距离门把关）
 */
export type GatePolicy = "strong" | "score" | "coverage" | "none";

/** 扩窗策略：blocks=±5 邻块（既有行为）；lines=±80 行 / 5 邻居 / 6000 字符；none=不扩 */
export type ExpandPolicy = "blocks" | "lines" | "none";

export interface ModeSpec {
	lexical: LexicalPolicy;
	semantic: boolean;
	/** 词法锚定：词法零命中就把整库跳过（hybrid 系列的硬规则，压住低证据的语义误召回） */
	lexicalAnchor: boolean;
	gate: GatePolicy;
	expand: ExpandPolicy;
	/** 回读候选倍数：deep 取 limit×3（重排广度），其余 limit×2 */
	candidateMultiplier: number;
	/** 是否做 cross-encoder 重排（仅 deep） */
	rerank: boolean;
}

export const MODE_SPECS: Record<ResolvedMode, ModeSpec> = {
	// 默认：双路融合 + 词法锚定 + 强门控 + 块扩窗
	hybrid: {
		lexical: "and_or",
		semantic: true,
		lexicalAnchor: true,
		gate: "strong",
		expand: "blocks",
		candidateMultiplier: 2,
		rerank: false,
	},
	// 精确查找：只走 BM25 严格短语，关掉 OR 回退与向量，任一词命中即放行
	fast: {
		lexical: "and_only",
		semantic: false,
		lexicalAnchor: false,
		gate: "coverage",
		expand: "none",
		candidateMultiplier: 2,
		rerank: false,
	},
	// 只按意思找：纯向量 top-K，无词法、无置信门（距离门由语义通道自身负责）
	semantic: {
		lexical: "off",
		semantic: true,
		lexicalAnchor: false,
		gate: "none",
		expand: "none",
		candidateMultiplier: 2,
		rerank: false,
	},
	// 中间档：双路融合但去掉词法锚定与词法证据门，只留分数门
	semantic_hybrid: {
		lexical: "and_or",
		semantic: true,
		lexicalAnchor: false,
		gate: "score",
		expand: "blocks",
		candidateMultiplier: 2,
		rerank: false,
	},
	// 带上下文回来：hybrid 召回 + 同文件行窗扩展
	adaptive: {
		lexical: "and_or",
		semantic: true,
		lexicalAnchor: true,
		gate: "strong",
		expand: "lines",
		candidateMultiplier: 2,
		rerank: false,
	},
	// 慢但更准：hybrid 召回更宽的候选，再逐对重排
	deep: {
		lexical: "and_or",
		semantic: true,
		lexicalAnchor: true,
		gate: "strong",
		expand: "blocks",
		candidateMultiplier: 3,
		rerank: true,
	},
};

/** 各模式在 auto 里的回退链（第一项以外按顺序尝试，跳过已尝试过的） */
const AUTO_FALLBACK: Record<ResolvedMode, ResolvedMode[]> = {
	hybrid: ["fast", "semantic", "adaptive"],
	fast: ["hybrid", "semantic"],
	semantic: ["hybrid", "adaptive"],
	semantic_hybrid: ["hybrid", "semantic"],
	adaptive: ["hybrid", "fast"],
	deep: ["hybrid"],
};

/** auto 最多尝试几次（含主模式） */
export const AUTO_MAX_ATTEMPTS = 3;

/** 精确查找特征：引号串 / 路径 / 驼峰 / 常量 / 文件名 / 工单号 */
const EXACT_FILE_RE =
	/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|ini|py|go|rs|java|kt|sql|html|css|sh|env)\b/gi;
const EXACT_TICKET_RE = /\b[A-Z]{2,}-\d+\b/g;
const EXACT_CONST_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
const CONCEPT_RE = /how|why|架构|流程|原理|怎么|如何|为什么|机制|设计/i;

/**
 * auto 的主模式判据（对齐 pi-knowledge）：
 * - 看起来像精确查找（引号/路径/驼峰/常量/文件名/工单号）→ fast
 * - 长问题（≥10 词）或含概念词（how/why/架构/流程…）→ semantic
 * - 其余 → hybrid
 * 顺序有意义：精确特征优先（`"refreshToken"` 应走 fast 而不是 semantic）。
 */
export function pickPrimaryMode(query: string): ResolvedMode {
	const q = query.trim();
	if (!q) return "hybrid";
	const hasQuote = /["'“”‘’]/.test(q);
	const exactFile = new RegExp(EXACT_FILE_RE.source, "i");
	const exactTicket = new RegExp(EXACT_TICKET_RE.source);
	const exactConst = new RegExp(EXACT_CONST_RE.source);
	const camel = new RegExp(CAMEL_RE.source);
	const hasPath = /[/\\]/.test(q);
	if (
		hasQuote ||
		hasPath ||
		exactFile.test(q) ||
		exactTicket.test(q) ||
		exactConst.test(q) ||
		camel.test(q)
	) {
		return "fast";
	}
	const words = q.split(/\s+/).filter(Boolean).length;
	if (words >= 10 || CONCEPT_RE.test(q)) return "semantic";
	return "hybrid";
}

/** auto 每次尝试后的信号 */
export interface AttemptSignal {
	mode: ResolvedMode;
	resultCount: number;
	/** 查询里的精确串是否出现在结果（内容或路径）中 */
	exactHit: boolean;
	/** 结果里的最高词法覆盖率（0~1） */
	coverage: number;
}

/**
 * 弱结果判定（对齐 pi-knowledge）：
 * - 空结果一律弱
 * - fast：精确串没命中且 coverage < 0.67 → 弱（说明严格短语没真正对上）
 * - semantic：coverage = 0 → 弱（纯向量一条词都没有，多半是误召回）
 * - hybrid / adaptive：门控已经把关，有结果即不弱
 */
export function isWeakResult(sig: AttemptSignal): boolean {
	if (sig.resultCount === 0) return true;
	if (sig.mode === "fast") return !sig.exactHit && sig.coverage < 0.67;
	if (sig.mode === "semantic") return sig.coverage === 0;
	return false;
}

/** 按回退链选下一个还没尝试过的模式；没有则 null */
export function pickNextFallback(
	primary: ResolvedMode,
	attempted: ResolvedMode[],
): ResolvedMode | null {
	for (const m of AUTO_FALLBACK[primary]) {
		if (!attempted.includes(m)) return m;
	}
	return null;
}

/** 从查询里抽「精确串」：引号内容、路径、文件名、常量、工单号（用于 fast 的命中判定） */
export function extractExactSpans(query: string): string[] {
	const spans = new Set<string>();
	for (const m of query.matchAll(/["'“”‘’]([^"'“”‘’]{1,200})["'“”‘’]/g)) {
		const s = m[1].trim();
		if (s) spans.add(s);
	}
	for (const m of query.matchAll(/[\w./\\-]*[/\\][\w./\\-]+/g)) spans.add(m[0]);
	for (const m of query.matchAll(EXACT_FILE_RE)) spans.add(m[0]);
	for (const m of query.matchAll(EXACT_TICKET_RE)) spans.add(m[0]);
	for (const m of query.matchAll(EXACT_CONST_RE)) spans.add(m[0]);
	for (const m of query.matchAll(CAMEL_RE)) spans.add(m[0]);
	return [...spans];
}

/** 结果里的最高词法覆盖率 */
export function maxCoverage(
	tokens: Set<string>,
	results: Array<{ content: string }>,
): number {
	let best = 0;
	for (const r of results) {
		const c = queryCoverage(r.content, tokens);
		if (c > best) best = c;
	}
	return best;
}

/** 组装一次尝试的信号（供 auto 判定） */
export function attemptSignal(
	mode: ResolvedMode,
	query: string,
	results: Array<{ content: string; filePath: string }>,
): AttemptSignal {
	const spans = extractExactSpans(query);
	const exactHit =
		spans.length > 0 &&
		results.some((r) => spans.some((s) => r.content.includes(s) || r.filePath.includes(s)));
	return {
		mode,
		resultCount: results.length,
		exactHit,
		coverage: maxCoverage(queryTokensOf(query), results),
	};
}
