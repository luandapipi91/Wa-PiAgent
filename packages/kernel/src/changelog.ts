// packages/kernel/src/changelog.ts
// CHANGELOG.md 区段提取：对齐 pi 1.5.0 官方「只显示上次见过版本之后的新条目」语义
// （上游 utils/changelog.js getNewEntries 的项目内实现——kernel 对 pi 仅 import 类型、
// 不 import 其运行时（RPC 约定），故解析自实现，不引入对 pi 包的运行时依赖）。

/** 三段数值比较；任一解析失败返回 undefined（调用方按「不匹配」处理） */
export function compareSemver(a: string, b: string): number | undefined {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return undefined;
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
	}
	return 0;
}

function parseVersion(v: string): [number, number, number] | undefined {
	const m = /^[~^]?v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// 版本标题行：## [1.2.0] / ### 1.1.0 / ## v0.9.0 等（## 到 #### 皆认）
const VERSION_HEADING = /^#{2,4}\s+\[?v?(\d+\.\d+\.\d+)\]?/;

/**
 * 提取 (from, to] 版本区间的条目，保持文件原顺序原样拼接（含标题行）。
 * fromVersion 不在文件中 → 取全部 ≤ to 的条目（版本记录缺失时看到全部近期更新）。
 * 无命中返回空串。
 */
export function extractChangelogEntries(
	md: string,
	fromVersion: string,
	toVersion: string,
): string {
	type Section = { version: string; text: string[] };
	const sections: Section[] = [];
	for (const line of md.split("\n")) {
		const m = VERSION_HEADING.exec(line);
		if (m) sections.push({ version: m[1]!, text: [line] });
		else if (sections.length) sections[sections.length - 1]!.text.push(line);
	}
	const picked = sections.filter((s) => {
		const from = compareSemver(s.version, fromVersion);
		const to = compareSemver(s.version, toVersion);
		if (from === undefined || to === undefined) return false;
		return from > 0 && to <= 0;
	});
	return picked
		.map((s) => s.text.join("\n"))
		.join("\n")
		.trim();
}
