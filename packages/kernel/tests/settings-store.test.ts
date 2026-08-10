import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASE_DELAY_MAX_MS,
	BASE_DELAY_MIN_MS,
	MAX_RETRIES_LIMIT,
	RETRY_DEFAULTS,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	loadRetrySettings,
	saveRetrySettings,
	loadHttpIdleTimeoutMs,
	saveHttpIdleTimeoutMs,
	ensureHttpIdleTimeout,
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
		saveRetrySettings(
			{ maxRetries: MAX_RETRIES_LIMIT + 1, baseDelayMs: 2000 },
			file,
		),
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
		saveRetrySettings(
			{ maxRetries: 3, baseDelayMs: BASE_DELAY_MIN_MS - 1 },
			file,
		),
	).rejects.toThrow();
	await expect(
		saveRetrySettings(
			{ maxRetries: 3, baseDelayMs: BASE_DELAY_MAX_MS + 1 },
			file,
		),
	).rejects.toThrow();
});

test("saveRetrySettings：merge 而非覆盖——保留 retry.provider / retry.enabled 等 pi 子字段", async () => {
	// pi 官方 settings：retry 下还有 provider.timeoutMs / enabled 等 wa-pi 未管理字段
	await writeFile(
		file,
		JSON.stringify({
			retry: {
				enabled: true,
				maxRetries: 5,
				baseDelayMs: 3000,
				provider: { timeoutMs: 60000, maxRetries: 2, maxRetryDelayMs: 30000 },
			},
		}),
		"utf8",
	);
	await saveRetrySettings({ maxRetries: 2, baseDelayMs: 1000 }, file);
	const onDisk = JSON.parse(await readFile(file, "utf8"));
	// wa-pi 管理的两个字段已更新
	expect(onDisk.retry.maxRetries).toBe(2);
	expect(onDisk.retry.baseDelayMs).toBe(1000);
	// pi 的子字段不被覆盖式冲掉
	expect(onDisk.retry.enabled).toBe(true);
	expect(onDisk.retry.provider).toEqual({
		timeoutMs: 60000,
		maxRetries: 2,
		maxRetryDelayMs: 30000,
	});
});

test("loadHttpIdleTimeoutMs：文件不存在 → 返回 wa-pi 默认值（120000ms，非 pi 的 300000）", async () => {
	expect(await loadHttpIdleTimeoutMs(file)).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
});

test("loadHttpIdleTimeoutMs：显式配置则原样读取，非数字回退默认", async () => {
	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: 60000 }), "utf8");
	expect(await loadHttpIdleTimeoutMs(file)).toBe(60000);
	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: 0 }), "utf8");
	expect(await loadHttpIdleTimeoutMs(file)).toBe(0);
	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: "abc" }), "utf8");
	expect(await loadHttpIdleTimeoutMs(file)).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
});

test("saveHttpIdleTimeoutMs：写入并保留其他字段（read-modify-write）", async () => {
	await writeFile(
		file,
		JSON.stringify({
			retry: { maxRetries: 5, baseDelayMs: 3000 },
			defaultModel: "m",
		}),
		"utf8",
	);
	const saved = await saveHttpIdleTimeoutMs(90000, file);
	expect(saved).toBe(90000);

	const onDisk = JSON.parse(await readFile(file, "utf8"));
	expect(onDisk.httpIdleTimeoutMs).toBe(90000);
	// retry 等其他字段不被冲掉
	expect(onDisk.retry).toEqual({ maxRetries: 5, baseDelayMs: 3000 });
	expect(onDisk.defaultModel).toBe("m");
});

test("ensureHttpIdleTimeout：字段缺失时写入默认值，保留文件其他字段", async () => {
	await writeFile(file, JSON.stringify({ retry: { maxRetries: 5 } }), "utf8");
	await ensureHttpIdleTimeout(file);
	const raw = JSON.parse(await readFile(file, "utf8"));
	expect(raw.httpIdleTimeoutMs).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
	expect(raw.retry.maxRetries).toBe(5); // 其他字段不动
});

test("ensureHttpIdleTimeout：已有用户值不覆盖；非数字（如字符串）归一为默认", async () => {
	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: 90_000 }), "utf8");
	await ensureHttpIdleTimeout(file);
	expect(JSON.parse(await readFile(file, "utf8")).httpIdleTimeoutMs).toBe(90_000);

	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: "120000" }), "utf8");
	await ensureHttpIdleTimeout(file);
	expect(JSON.parse(await readFile(file, "utf8")).httpIdleTimeoutMs).toBe(
		DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	);
});

test("saveHttpIdleTimeoutMs：拒绝 0 / 负数 / 小数 / Infinity（0 会被 pi 翻译成永不超时）", async () => {
	await writeFile(file, JSON.stringify({}), "utf8");
	await expect(saveHttpIdleTimeoutMs(0, file)).rejects.toThrow("整数");
	await expect(saveHttpIdleTimeoutMs(-1000, file)).rejects.toThrow("整数");
	await expect(saveHttpIdleTimeoutMs(1500.5, file)).rejects.toThrow("整数");
	await expect(saveHttpIdleTimeoutMs(Infinity, file)).rejects.toThrow("整数");
	// 合法值正常保存
	await expect(saveHttpIdleTimeoutMs(60_000, file)).resolves.toBe(60_000);
});
