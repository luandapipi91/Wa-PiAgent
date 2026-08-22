import { test, expect } from "bun:test";
import history from "./version-history.json";

interface VersionEntry {
	version: string;
	date: string;
	// 各版本 sections 键分布不一，JSON 推断缺键为 undefined，断言需允许 undefined
	sections: Record<string, string[] | undefined>;
}

const entries = history as VersionEntry[];

test("version-history.json 格式合法：每条含 version/date/sections", () => {
	expect(Array.isArray(entries)).toBe(true);
	expect(entries.length).toBeGreaterThan(0);
	for (const entry of entries) {
		expect(typeof entry.version).toBe("string");
		expect(typeof entry.date).toBe("string");
		expect(typeof entry.sections).toBe("object");
		// 版本号格式 x.y.z
		expect(/^\d+\.\d+\.\d+$/.test(entry.version)).toBe(true);
		// 日期格式 yyyy-mm-dd
		expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.date)).toBe(true);
		// sections 每个分类至少一项
		for (const [category, items] of Object.entries(entry.sections)) {
			expect(typeof category).toBe("string");
			expect(Array.isArray(items)).toBe(true);
			if (items) expect(items.length).toBeGreaterThan(0);
		}
	}
});

test("version-history.json 按版本倒序排列（最新在前）", () => {
	for (let i = 1; i < entries.length; i++) {
		const prev = entries[i - 1].version.split(".").map(Number);
		const curr = entries[i].version.split(".").map(Number);
		const prevNum = prev[0] * 10000 + prev[1] * 100 + prev[2];
		const currNum = curr[0] * 10000 + curr[1] * 100 + curr[2];
		expect(prevNum).toBeGreaterThanOrEqual(currNum);
	}
});
