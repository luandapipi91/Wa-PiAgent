// 把用户查询串转成安全的 FTS5 MATCH 表达式。
//
// 背景（已实测）：查询串直接拼进 MATCH 时，`(`、`*`、`a"b` 会抛 SQLiteError
// （unterminated string / syntax error / unknown special query）。因此：
// - 先经 bigram() 切成 token
// - 每个 token 用双引号包裹（引号内 FTS5 不解析运算符语义）
// - token 内部的 " 翻倍转义
// - token 之间空格连接（FTS5 隐式 AND）
// 不构造 AND/OR/NEAR 运算符，用户输入永远不被当作 FTS5 语法。

import { bigram } from "./bigram";

export function buildMatchExpr(raw: string): string | null {
	const tokens = bigram(raw).split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
