// 移植自 pi-knowledge@0.13.0 dist/src/engine.js（MIT）
//
// 上游把「对外 mode（工具参数的 12 个取值）」和「检索策略（管线怎么跑）」分开：
// mode 先经 retrievalModeFor 归一到策略，auto 另用 chooseAutoMode + fallbackModesFor +
// isWeakAutoResponse 做判据与弱结果回退；matchReasonFor 只用于 provenance 的 match_reason。
import type { KbMatchReason, KbRetrievalMode, KbSearchMode } from "@wa-pi/shared";

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
] as const satisfies readonly SearchMode[];

export type SearchMode = KbSearchMode;

/** 真正落到检索管线的策略（12 个对外取值经 retrievalModeFor 归一到这 6 个） */
export type RetrievalMode = KbRetrievalMode;

/** provenance 的 match_reason 取值 */
export type MatchReason = KbMatchReason;

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
