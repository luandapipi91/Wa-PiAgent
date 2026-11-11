// 移植自 pi-knowledge@0.13.0 dist/src/engine.js（MIT）
//
// 上游把「对外 mode（工具参数的 12 个取值）」和「检索策略（管线怎么跑）」分开：
// mode 先经 retrievalModeFor 归一到策略，auto 另用 chooseAutoMode + fallbackModesFor +
// isWeakAutoResponse 做判据与弱结果回退；matchReasonFor 只用于 provenance 的 match_reason。
import { queryCoverage, queryTokensOf } from "./ranking";

/** 对外可选模式（工具参数 mode 的全部取值，对齐上游 T.Object 的 mode 联合） */
export const SEARCH_MODES = [
	"auto",
	"fast",
	"semantic",
	"hybrid",
	"semantic_hybrid",
	"deep",
	"adaptive",
	"code",
	"config",
	"docs",
	"errors",
	"decision",
] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** 真正落到检索管线的策略（12 个对外取值经 retrievalModeFor 归一到这 6 个） */
export type RetrievalMode =
	| "fast"
	| "semantic"
	| "hybrid"
	| "semantic_hybrid"
	| "adaptive"
	| "deep";

/** provenance 的 match_reason 取值 */
export type MatchReason = "bm25" | "vector" | "hybrid" | "rerank" | "adaptive";

export function retrievalModeFor(mode: SearchMode): RetrievalMode {
	if (mode === "auto") return "hybrid";
	if (mode === "code" || mode === "config" || mode === "errors") return "fast";
	if (mode === "docs" || mode === "decision") return "hybrid";
	return mode;
}

export function matchReasonFor(mode: SearchMode): MatchReason {
	if (mode === "deep") return "rerank";
	if (mode === "adaptive") return "adaptive";
	if (mode === "semantic") return "vector";
	if (mode === "fast" || mode === "code" || mode === "config" || mode === "errors") return "bm25";
	return "hybrid";
}

export function isExactLookupQuery(query: string): boolean {
	const trimmed = query.trim();
	if (/["'`]/.test(trimmed)) return true;
	if (/[./\\][\w.-]+/.test(trimmed)) return true;
	if (/\b[A-Z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/.test(trimmed)) return true;
	if (/\b[A-Z]{2,}[_-]?[A-Z0-9]*\b/.test(trimmed)) return true;
	if (/\b[a-zA-Z_][\w-]*\.(ts|tsx|js|jsx|go|rs|py|java|md|json|ya?ml|toml)\b/.test(trimmed))
		return true;
	if (/\b[A-Z]+-\d+\b/.test(trimmed)) return true;
	return false;
}

export function chooseAutoMode(query: string): RetrievalMode {
	const normalized = query.trim();
	if (isExactLookupQuery(normalized)) return "fast";
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	if (
		wordCount >= 10 ||
		/how|why|explain|concept|architecture|design|流程|架構|概念|為什麼|如何/i.test(normalized)
	) {
		return "semantic";
	}
	return "hybrid";
}

export function fallbackModesFor(mode: RetrievalMode): RetrievalMode[] {
	if (mode === "fast") return ["hybrid", "semantic"];
	if (mode === "semantic") return ["hybrid", "adaptive"];
	if (mode === "adaptive") return ["hybrid", "deep"];
	if (mode === "deep") return ["hybrid", "adaptive"];
	return ["fast", "semantic", "adaptive"];
}

/** isWeakAutoResponse 只看结果里的这几项（上游 SearchResponse 的结构子集） */
export interface AutoResponse {
	results: Array<{
		file_path: string;
		content: string;
		ranking?: { coverage?: number };
	}>;
}

export function isWeakAutoResponse(
	query: string,
	response: AutoResponse,
	primaryMode: RetrievalMode,
	attemptMode: RetrievalMode,
): boolean {
	if (response.results.length === 0) return true;
	if (primaryMode === "fast") {
		const exactNeedle = query
			.trim()
			.replace(/^["'`]|["'`]$/g, "")
			.toLowerCase();
		const hasExactHit = response.results.some(
			(result) =>
				result.file_path.toLowerCase().includes(exactNeedle) ||
				result.content.toLowerCase().includes(exactNeedle),
		);
		if (!hasExactHit && response.results.every((result) => (result.ranking?.coverage ?? 0) < 0.67))
			return true;
	}
	if (primaryMode !== "semantic" && attemptMode === "semantic") {
		return response.results.every((result) => (result.ranking?.coverage ?? 0) === 0);
	}
	return false;
}

// ---------------------------------------------------------------------------
// TODO(T8): 上游无此符号，编排重写后删除。
// 以下为旧自研简化版的过渡适配层，当前 search.ts 仍引用；T8 重写编排后整段删除。
// ---------------------------------------------------------------------------

// TODO(T8): 上游无此符号，编排重写后删除
export type ResolvedMode = RetrievalMode;

// TODO(T8): 上游无此符号，编排重写后删除
/** 词法通道行为：off=不跑 FTS；and_only=只跑严格短语（关 OR 回退）；and_or=短语零命中降级 OR */
export type LexicalPolicy = "off" | "and_only" | "and_or";

// TODO(T8): 上游无此符号，编排重写后删除
/**
 * 门控策略：
 * - strong：分数 ≥ 0.18 且词法证据足够（hybrid / adaptive / deep）
 * - score：只要分数达标（semantic_hybrid：去掉词法证据约束）
 * - coverage：只要该块被词法命中（fast：任一词命中即放行）
 * - none：不过门（semantic：纯向量，靠距离门把关）
 */
export type GatePolicy = "strong" | "score" | "coverage" | "none";

// TODO(T8): 上游无此符号，编排重写后删除
/** 扩窗策略：blocks=±5 邻块（既有行为）；lines=±80 行 / 5 邻居 / 6000 字符；none=不扩 */
export type ExpandPolicy = "blocks" | "lines" | "none";

// TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
/** 各模式在 auto 里的回退链（第一项以外按顺序尝试，跳过已尝试过的） */
const AUTO_FALLBACK: Record<ResolvedMode, ResolvedMode[]> = {
	hybrid: ["fast", "semantic", "adaptive"],
	fast: ["hybrid", "semantic"],
	semantic: ["hybrid", "adaptive"],
	semantic_hybrid: ["hybrid", "semantic"],
	adaptive: ["hybrid", "fast"],
	deep: ["hybrid"],
};

// TODO(T8): 上游无此符号，编排重写后删除
/** auto 最多尝试几次（含主模式） */
export const AUTO_MAX_ATTEMPTS = 3;

// TODO(T8): 上游无此符号，编排重写后删除
/** 精确查找特征：引号串 / 路径 / 驼峰 / 常量 / 文件名 / 工单号 */
const EXACT_FILE_RE =
	/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|ini|py|go|rs|java|kt|sql|html|css|sh|env)\b/gi;
// TODO(T8): 上游无此符号，编排重写后删除
const EXACT_TICKET_RE = /\b[A-Z]{2,}-\d+\b/g;
// TODO(T8): 上游无此符号，编排重写后删除
const EXACT_CONST_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;
// TODO(T8): 上游无此符号，编排重写后删除
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
// TODO(T8): 上游无此符号，编排重写后删除
const CONCEPT_RE = /how|why|架构|流程|原理|怎么|如何|为什么|机制|设计/i;

/**
 * auto 的主模式判据（旧自研版，上游对应 chooseAutoMode）。
 * TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
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
 * 弱结果判定（旧自研版，上游对应 isWeakAutoResponse）。
 * TODO(T8): 上游无此符号，编排重写后删除
 */
export function isWeakResult(sig: AttemptSignal): boolean {
	if (sig.resultCount === 0) return true;
	if (sig.mode === "fast") return !sig.exactHit && sig.coverage < 0.67;
	if (sig.mode === "semantic") return sig.coverage === 0;
	return false;
}

// TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
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

// TODO(T8): 上游无此符号，编排重写后删除
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
