// changelog.ts 纯函数测试：CHANGELOG.md 区段提取（pi 1.5.0 官方「只显示新条目」语义的对齐实现）
import { describe, expect, test } from "bun:test";
import { compareSemver, extractChangelogEntries } from "../src/changelog";

const MD = [
	"# Changelog",
	"## [1.2.0] - 2026-11-01",
	"- 新增中文工具搜索",
	"### 1.1.0 - 2026-10-01",
	"- 修复排序",
	"## v0.9.0 - 2026-09-01",
	"- 初始版本",
].join("\n");

describe("extractChangelogEntries", () => {
	test("取 (from, to] 区段且保持原顺序", () => {
		const out = extractChangelogEntries(MD, "1.1.0", "1.2.0");
		expect(out).toContain("## [1.2.0]");
		expect(out).toContain("新增中文工具搜索");
		expect(out).not.toContain("1.1.0");
		expect(out).not.toContain("v0.9.0");
	});
	test("fromVersion 不在文件中 → 取全部 ≤ to", () => {
		const out = extractChangelogEntries(MD, "0.5.0", "1.1.0");
		expect(out).toContain("1.1.0");
		expect(out).toContain("v0.9.0");
		expect(out).not.toContain("1.2.0");
	});
	test("无新条目 → 空串", () => {
		expect(extractChangelogEntries(MD, "1.2.0", "1.2.0")).toBe("");
	});
});

describe("compareSemver", () => {
	test("三段数值比较", () => {
		expect(compareSemver("1.2.0", "1.1.0")).toBe(1);
		expect(compareSemver("1.1.0", "1.1.0")).toBe(0);
		expect(compareSemver("0.9.0", "1.0.0")).toBe(-1);
	});
	test("解析失败返回 undefined", () => {
		expect(compareSemver("abc", "1.0.0")).toBeUndefined();
	});
});
