// 移植自 pi-knowledge@0.13.0 dist/src/search/bm25.js（MIT）
// FTS5 词法检索：查询先经 normalizedQueryText（bigram 化 + 词干/纠错）切词，每个词
// 加引号做短语项，先严格 AND；命中为零且是多词查询时降级 OR 兜底（allowOrFallback
// 为 false 或单词查询不兜底）。MATCH 语法出错一律返空，不影响向量通道。
//
// 与上游的差异：
// 1. bun:sqlite 用 db.query(...).all(...)，上游是 db.prepare(...).all(...)；
// 2. Wa-Pi 每库独立 DB，没有 kb_id 过滤；chunks 主键是 TEXT uuid（非 rowid），
//    FTS 侧用 chunks_fts.chunk_id 列直接 join chunks.id。
import type { Database } from "bun:sqlite";
import { normalizedQueryText } from "./query";

function prepareFtsTerms(query: string): string[] {
	return normalizedQueryText(query)
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

function quoteFtsTerm(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

function runSearch(
	db: Database,
	ftsQuery: string,
	limit: number,
): Array<{ chunkId: string; score: number }> {
	return db
		.query(
			`SELECT c.id AS chunkId, -bm25(chunks_fts) AS score
			   FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
			  WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
		)
		.all(ftsQuery, limit) as Array<{ chunkId: string; score: number }>;
}

export function searchBM25(
	db: Database,
	query: string,
	limit = 50,
	options: { allowOrFallback?: boolean } = {},
): Array<{ chunkId: string; score: number }> {
	const terms = prepareFtsTerms(query);
	if (terms.length === 0) return [];
	try {
		const quotedTerms = terms.map(quoteFtsTerm);
		const strict = runSearch(db, quotedTerms.join(" AND "), limit);
		if (strict.length > 0 || terms.length === 1 || options.allowOrFallback === false) return strict;
		return runSearch(db, quotedTerms.join(" OR "), limit);
	} catch {
		return [];
	}
}
