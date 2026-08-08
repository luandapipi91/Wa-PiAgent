/** token 数字格式化：<1000 原值，≥1000 用 K，≥1M 用 M，无小数省略 */
export function fmtTok(n: number): string {
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return v % 1 === 0 ? `${v}M` : `${v.toFixed(1)}M`;
	}
	if (n >= 1_000) {
		const v = n / 1_000;
		return v % 1 === 0 ? `${v}K` : `${v.toFixed(1)}K`;
	}
	return String(n);
}
