// 中文 bigram 分词：SQLite FTS5 的 unicode61 分词器把连续汉字视作单个 token，
// 导致「中文」「发版」这类查询 0 命中（已实测）。写入与查询都先经此函数，
// 把汉字段切成相邻二元组，使双字词可检索。
//
// 规则：
// - 连续汉字段 → 相邻二元组（"发版流程" → "发版 版流 流程"）
// - 单字汉字段 → 保留原字
// - 非汉字段 → 原文小写（英文/数字保持整体，避免 mac 被切成 ma ac）
// - 结果以空格连接，供 FTS5 按空格切 token

const HAN = /[\u4e00-\u9fa5]+|[^\u4e00-\u9fa5]+/g;
const HAN_ONLY = /^[\u4e00-\u9fa5]+$/;

export function bigram(text: string): string {
	const runs = text.match(HAN) ?? [];
	const out: string[] = [];
	for (const run of runs) {
		if (HAN_ONLY.test(run)) {
			if (run.length === 1) {
				out.push(run);
				continue;
			}
			for (let i = 0; i < run.length - 1; i++) {
				out.push(run.slice(i, i + 2));
			}
		} else {
			const token = run.trim().toLowerCase();
			if (token) out.push(token);
		}
	}
	return out.join(" ");
}
