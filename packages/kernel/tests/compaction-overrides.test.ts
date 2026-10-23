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

	// providers.json 的真实结构：id 是 uuid，provider 标识由 slug（缺则按 name 派生）决定——
	// 必须与 pi 查找 compaction.modelOverrides 的键 `${model.provider}/${model.id}` 对齐
	const providers = {
		providers: [
			{
				id: "679f8d92-bb83-4876-8045-f03ea7e353e9",
				slug: "deepseek",
				name: "DeepSeek",
				models: [{ id: "m1", contextWindow: 1048576 }, { id: "bad", contextWindow: 0 }],
			},
			{
				id: "5f071143-07eb-48b0-ae1e-6779854f2d38",
				name: "B",
				models: [{ id: "m2", contextWindow: 200000 }],
			},
			// 第二个同名 slug：与 provider-extension 的 slugifyProviders 同样加 -2 后缀
			{
				id: "9f9c5468-4d3e-416b-9fc3-d418e4b77d02",
				slug: "deepseek",
				name: "DeepSeek 2",
				models: [{ id: "m3", contextWindow: 100000 }],
			},
		],
	};

	test("desiredOverridesFromProviders：键用 provider slug（非 uuid）、0.2×窗口取整、跳过非法项", () => {
		expect(desiredOverridesFromProviders(providers.providers as any)).toEqual({
			"deepseek/m1": { reserveTokens: 209715 },
			"b/m2": { reserveTokens: 40000 },
			"deepseek-2/m3": { reserveTokens: 20000 },
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
		expect(after.compaction.modelOverrides["deepseek/m1"].reserveTokens).toBe(209715);
		expect(after.compaction.modelOverrides["b/m2"].reserveTokens).toBe(40000);
		expect(after.compaction.modelOverrides["deepseek/bad"]).toBeUndefined(); // 非法窗口跳过

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
				compaction: { modelOverrides: { "deepseek/m1": { reserveTokens: 1 } } },
			}),
		);
		await syncCompactionOverrides(sf, pf);
		const after = JSON.parse(readFileSync(sf, "utf8"));
		expect(after.compaction.modelOverrides["deepseek/m1"].reserveTokens).toBe(209715); // 真源覆盖
	});

	test("syncCompactionOverrides：清掉早期误写的 uuid 键（pi 按 slug 查找，uuid 键永远失效）", async () => {
		const sf = join(dir, "settings.json");
		const pf = join(dir, "providers.json");
		writeFileSync(pf, JSON.stringify(providers));
		writeFileSync(
			sf,
			JSON.stringify({
				compaction: {
					modelOverrides: {
						"679f8d92-bb83-4876-8045-f03ea7e353e9/m1": { reserveTokens: 209715 },
						"user-custom/model-x": { reserveTokens: 1234 },
					},
				},
			}),
		);
		await syncCompactionOverrides(sf, pf);
		const after = JSON.parse(readFileSync(sf, "utf8"));
		expect(
			after.compaction.modelOverrides["679f8d92-bb83-4876-8045-f03ea7e353e9/m1"],
		).toBeUndefined();
		expect(after.compaction.modelOverrides["user-custom/model-x"].reserveTokens).toBe(1234); // 用户手写不动
		expect(after.compaction.modelOverrides["deepseek/m1"].reserveTokens).toBe(209715);
	});
});
