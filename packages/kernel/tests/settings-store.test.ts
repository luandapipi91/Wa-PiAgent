import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASE_DELAY_MAX_MS,
	BASE_DELAY_MIN_MS,
	MAX_RETRIES_LIMIT,
	RETRY_DEFAULTS,
	loadRetrySettings,
	saveRetrySettings,
} from "../src/settings-store";

// settings-store 直接读写磁盘 settings.json：用临时目录隔离，不碰真实 ~/.wa-pi
let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-settings-test-"));
	file = join(dir, "settings.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("loadRetrySettings：文件不存在 → 返回 pi 默认值（3 次 / 2000ms）", async () => {
	expect(await loadRetrySettings(file)).toEqual(RETRY_DEFAULTS);
});

test("loadRetrySettings：retry 字段缺失/类型错误 → 逐字段回退默认值", async () => {
	await writeFile(file, JSON.stringify({ defaultModel: "m1" }), "utf8");
	expect(await loadRetrySettings(file)).toEqual(RETRY_DEFAULTS);

	await writeFile(
		file,
		JSON.stringify({ retry: { maxRetries: "abc" } }),
		"utf8",
	);
	expect(await loadRetrySettings(file)).toEqual({
		maxRetries: RETRY_DEFAULTS.maxRetries,
		baseDelayMs: RETRY_DEFAULTS.baseDelayMs,
	});
});

test("saveRetrySettings：写入 retry 并保留其他字段（read-modify-write）", async () => {
	await writeFile(
		file,
		JSON.stringify({ defaultProvider: "deepseek", waPiPackages: ["a"] }),
		"utf8",
	);
	const saved = await saveRetrySettings(
		{ maxRetries: 5, baseDelayMs: 3000 },
		file,
	);
	expect(saved).toEqual({ maxRetries: 5, baseDelayMs: 3000 });

	const onDisk = JSON.parse(await readFile(file, "utf8"));
	expect(onDisk.retry).toEqual({ maxRetries: 5, baseDelayMs: 3000 });
	// 其他字段不被冲掉
	expect(onDisk.defaultProvider).toBe("deepseek");
	expect(onDisk.waPiPackages).toEqual(["a"]);

	// 回读一致
	expect(await loadRetrySettings(file)).toEqual({
		maxRetries: 5,
		baseDelayMs: 3000,
	});
});

test("saveRetrySettings：边界值 0 次与上限 10 次均可保存，11 次拒绝", async () => {
	await saveRetrySettings({ maxRetries: 0, baseDelayMs: 2000 }, file);
	await saveRetrySettings(
		{ maxRetries: MAX_RETRIES_LIMIT, baseDelayMs: 2000 },
		file,
	);
	await expect(
		saveRetrySettings({ maxRetries: MAX_RETRIES_LIMIT + 1, baseDelayMs: 2000 }, file),
	).rejects.toThrow("0-10");
});

test("saveRetrySettings：拒绝非整数 / 负数 / 越界间隔", async () => {
	await expect(
		saveRetrySettings({ maxRetries: 1.5, baseDelayMs: 2000 }, file),
	).rejects.toThrow("整数");
	await expect(
		saveRetrySettings({ maxRetries: -1, baseDelayMs: 2000 }, file),
	).rejects.toThrow("0-10");
	await expect(
		saveRetrySettings({ maxRetries: 3, baseDelayMs: BASE_DELAY_MIN_MS - 1 }, file),
	).rejects.toThrow();
	await expect(
		saveRetrySettings({ maxRetries: 3, baseDelayMs: BASE_DELAY_MAX_MS + 1 }, file),
	).rejects.toThrow();
});
