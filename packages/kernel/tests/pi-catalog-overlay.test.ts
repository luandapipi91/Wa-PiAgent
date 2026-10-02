// pi-catalog 的「远程覆盖层合并」测试
//
// 为什么测：kernel 侧（模型预设列表、provider-extension 生成的模型参数）读的都是这份
// 目录。若合并语义与 pi 不一致（尤其「远程只比内置新时才生效」这条），会出现
// 「pi 子进程看到的参数」与「wa-pi 写进 extension 的参数」两套值——比不更新更难排查。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllCatalogModels } from "../src/pi-catalog.ts";
import { writeModelsStore } from "../src/model-catalog-refresh.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "catalog-overlay-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

/** 取一个确定存在的内置模型（借真实目录，避免硬编码某个模型 id 随上游变动而失效） */
async function pickBuiltinModel(dir: string) {
	const models = await getAllCatalogModels(dir);
	expect(models.length).toBeGreaterThan(0);
	return models[0];
}

describe("getAllCatalogModels：叠加 models-store.json 的远程覆盖层", () => {
	test("没有覆盖层时 = 内置目录（数量与内容不变）", async () => {
		const base = await getAllCatalogModels(await tempDir());
		const again = await getAllCatalogModels(await tempDir());
		expect(again.length).toBe(base.length);
	});

	test("远程比内置新：新增的模型进入目录，且带上 provider", async () => {
		const dir = await tempDir();
		const base = await getAllCatalogModels(dir);
		await writeModelsStore(dir, {
			deepseek: {
				models: [{ id: "wa-pi-test-only-model", contextWindow: 4242 }],
				checkedAt: Date.now(),
				lastModified: Date.now(),
			},
		});
		const models = await getAllCatalogModels(dir);
		const hit = models.find((m) => m.id === "wa-pi-test-only-model");
		expect(hit).toBeDefined();
		expect(hit!.provider).toBe("deepseek");
		expect(hit!.contextWindow).toBe(4242);
		// 只是「多了一条」，不是「换了一份」
		expect(models.length).toBe(base.length + 1);
	});

	test("远程比内置新：同 id 的条目被覆盖（价格/上下文长度以远程为准）", async () => {
		const dir = await tempDir();
		const target = await pickBuiltinModel(dir);
		await writeModelsStore(dir, {
			[target.provider]: {
				models: [
					{
						id: target.id,
						contextWindow: 777777,
						cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
					},
				],
				checkedAt: Date.now(),
				lastModified: Date.now(),
			},
		});
		const models = await getAllCatalogModels(dir);
		const hit = models.find(
			(m) => m.id === target.id && m.provider === target.provider,
		);
		expect(hit?.contextWindow).toBe(777777);
	});

	test("远程比内置旧（lastModified 早于内置数据生成时间）→ 不生效", async () => {
		const dir = await tempDir();
		const base = await getAllCatalogModels(dir);
		await writeModelsStore(dir, {
			deepseek: {
				models: [{ id: "wa-pi-test-stale-model" }],
				checkedAt: Date.now(),
				// 1 毫秒时间戳必然早于内置目录（2026 年生成的）→ 与 pi 的 localGeneratedAt 规则一样应被忽略
				lastModified: 1,
			},
		});
		const models = await getAllCatalogModels(dir);
		expect(models.find((m) => m.id === "wa-pi-test-stale-model")).toBeUndefined();
		expect(models.length).toBe(base.length);
	});

	test("lastModified=0（服务端 404/501 记的「无远程目录」）→ 不生效", async () => {
		const dir = await tempDir();
		await writeModelsStore(dir, {
			gone: {
				models: [{ id: "wa-pi-test-absent-model" }],
				checkedAt: Date.now(),
				lastModified: 0,
			},
		});
		const models = await getAllCatalogModels(dir);
		expect(models.find((m) => m.id === "wa-pi-test-absent-model")).toBeUndefined();
	});

	test("覆盖层文件损坏 → 静默退回内置目录，不抛错", async () => {
		const dir = await tempDir();
		const base = await getAllCatalogModels(dir);
		await Bun.write(join(dir, "models-store.json"), "{ broken");
		expect((await getAllCatalogModels(dir)).length).toBe(base.length);
	});
});
