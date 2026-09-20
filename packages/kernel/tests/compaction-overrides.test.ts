// compaction-overrides.test.ts — 按 0.2×contextWindow 规则同步压缩预算（先红后绿）
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	desiredOverridesFromProviders,
	syncCompactionOverrides,
} from "../src/compaction-overrides";

describe("compaction-overrides：按 0.2×contextWindow 规则同步 settings.json", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cmp-ov-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const providers = {
		providers: [
			{
				id: "slug-a",
				name: "A",
				models: [{ id: "m1", contextWindow: 1048576 }, { id: "bad", contextWindow: 0 }],
			},
			{ id: "slug-b", name: "B", models: [{ id: "m2", contextWindow: 200000 }] },
		],
	};

	test("desiredOverridesFromProviders：0.2×窗口取整、跳过非法项", () => {
		expect(desiredOverridesFromProviders(providers.providers as any)).toEqual({
			"slug-a/m1": { reserveTokens: 209715 },
			"slug-b/m2": { reserveTokens: 40000 },
		});
	});

	test("syncCompactionOverrides：新增键、只动 modelOverrides 子树、幂等", async () => {
		const sf = join(dir, "settings.json");
		writeFileSync(
			sf,
			JSON.stringify({ theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } }),
		);
		const pf = join(dir, "providers.json");
		writeFileSync(pf, JSON.stringify(providers));

		const r1 = await syncCompactionOverrides(sf, pf);
		expect(r1.changed).toBe(true);
		const after = JSON.parse(readFileSync(sf, "utf8"));
		expect(after.theme).toBe("dark"); // 其他键不动
		expect(after.compaction.enabled).toBe(true); // compaction 其他键不动
		expect(after.compaction.reserveTokens).toBe(16384); // 全局默认不写
		expect(after.compaction.modelOverrides["slug-a/m1"].reserveTokens).toBe(209715);
		expect(after.compaction.modelOverrides["slug-b/m2"].reserveTokens).toBe(40000);
		expect(after.compaction.modelOverrides["slug-a/bad"]).toBeUndefined(); // 非法窗口跳过

		const r2 = await syncCompactionOverrides(sf, pf); // 幂等
		expect(r2.changed).toBe(false);
	});

	test("syncCompactionOverrides：窗口变化时更新同键；settings 缺失/坏 JSON 时 no-op", async () => {
		const sf = join(dir, "settings.json");
		const pf = join(dir, "providers.json");
		writeFileSync(pf, JSON.stringify(providers));

		expect((await syncCompactionOverrides(sf, pf)).changed).toBe(false); // settings 不存在 → 不创建
		writeFileSync(sf, "{oops");
		expect((await syncCompactionOverrides(sf, pf)).changed).toBe(false); // 坏 JSON → 不动

		writeFileSync(
			sf,
			JSON.stringify({
				compaction: { modelOverrides: { "slug-a/m1": { reserveTokens: 1 } } },
			}),
		);
		await syncCompactionOverrides(sf, pf);
		const after = JSON.parse(readFileSync(sf, "utf8"));
		expect(after.compaction.modelOverrides["slug-a/m1"].reserveTokens).toBe(209715); // 真源覆盖
	});
});
