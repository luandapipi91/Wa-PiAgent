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
	loadLanguage,
	saveLanguage,
} from "../src/settings-store";
import { errorCodeOf } from "./helpers/kernel-error-code";

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
	).rejects.toThrow();
	expect(
		await errorCodeOf(
			saveRetrySettings(
				{ maxRetries: MAX_RETRIES_LIMIT + 1, baseDelayMs: 2000 },
				file,
			),
		),
	).toBe("settings.invalidRetries");
});

test("saveRetrySettings：拒绝非整数 / 负数 / 越界间隔", async () => {
	expect(
		await errorCodeOf(
			saveRetrySettings({ maxRetries: 1.5, baseDelayMs: 2000 }, file),
		),
	).toBe("settings.invalidRetries");
	expect(
		await errorCodeOf(
			saveRetrySettings({ maxRetries: -1, baseDelayMs: 2000 }, file),
		),
	).toBe("settings.invalidRetries");
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
	expect(JSON.parse(await readFile(file, "utf8")).httpIdleTimeoutMs).toBe(
		90_000,
	);

	await writeFile(file, JSON.stringify({ httpIdleTimeoutMs: "120000" }), "utf8");
	await ensureHttpIdleTimeout(file);
	expect(JSON.parse(await readFile(file, "utf8")).httpIdleTimeoutMs).toBe(
		DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	);
});

test("saveHttpIdleTimeoutMs：拒绝 0 / 负数 / 小数 / Infinity（0 会被 pi 翻译成永不超时）", async () => {
	await writeFile(file, JSON.stringify({}), "utf8");
	expect(await errorCodeOf(saveHttpIdleTimeoutMs(0, file))).toBe(
		"settings.invalidIdleTimeout",
	);
	expect(await errorCodeOf(saveHttpIdleTimeoutMs(-1000, file))).toBe(
		"settings.invalidIdleTimeout",
	);
	expect(await errorCodeOf(saveHttpIdleTimeoutMs(1500.5, file))).toBe(
		"settings.invalidIdleTimeout",
	);
	expect(await errorCodeOf(saveHttpIdleTimeoutMs(Infinity, file))).toBe(
		"settings.invalidIdleTimeout",
	);
	// 合法值正常保存
	await expect(saveHttpIdleTimeoutMs(60_000, file)).resolves.toBe(60_000);
});

// —— defaultTools（默认内置工具清单：pi 引擎默认激活集仅 read/bash/edit/write，
// grep/find/ls 注册但未激活；用 settings.json.defaultTools 替换默认激活集，
// 不生成硬白名单，扩展/MCP 工具仍全放行）——
import {
	loadDefaultTools,
	saveDefaultTools,
	defaultToolsForPlatform,
	ensureDefaultTools,
	WINDOWS_DEFAULT_TOOLS,
	UNIX_DEFAULT_TOOLS,
	LEGACY_WINDOWS_DEFAULT_TOOLS,
} from "../src/settings-store";

test("saveDefaultTools/loadDefaultTools: 写入并读回（保留其他字段）", async () => {
	const p = join(dir, "settings-defaulttools.json");
	await writeFile(p, JSON.stringify({ retry: { maxRetries: 3 } }), "utf8");
	await saveDefaultTools(["read", "powershell", "edit", "write"], p);
	const raw = JSON.parse(await readFile(p, "utf8"));
	expect(raw.defaultTools).toEqual(["read", "powershell", "edit", "write"]);
	// 保留其他字段（read-modify-write）
	expect(raw.retry.maxRetries).toBe(3);
	expect(await loadDefaultTools(p)).toEqual([
		"read",
		"powershell",
		"edit",
		"write",
	]);
});

test("loadDefaultTools: 未配置/格式非法返回 undefined", async () => {
	const p1 = join(dir, "settings-no-defaulttools.json");
	await writeFile(p1, JSON.stringify({}), "utf8");
	expect(await loadDefaultTools(p1)).toBeUndefined();
	// 非字符串数组的脏数据视同未配置
	const p2 = join(dir, "settings-bad-defaulttools.json");
	await writeFile(p2, JSON.stringify({ defaultTools: ["read", 42] }), "utf8");
	expect(await loadDefaultTools(p2)).toBeUndefined();
});

test("defaultToolsForPlatform: 全平台返回清单，均含 grep/find/ls；win 用 powershell 换 bash", () => {
	expect(defaultToolsForPlatform("win32")).toEqual(WINDOWS_DEFAULT_TOOLS);
	expect(defaultToolsForPlatform("darwin")).toEqual(UNIX_DEFAULT_TOOLS);
	expect(defaultToolsForPlatform("linux")).toEqual(UNIX_DEFAULT_TOOLS);
	// 全平台清单都必须补齐 pi 注册表里的 grep/find/ls（根因修复：默认激活集缺失）
	for (const list of [WINDOWS_DEFAULT_TOOLS, UNIX_DEFAULT_TOOLS]) {
		for (const t of ["grep", "find", "ls"]) {
			expect(list).toContain(t);
		}
	}
	// Windows 平台语义：bash 由 powershell 接管
	expect(WINDOWS_DEFAULT_TOOLS).toContain("powershell");
	expect(WINDOWS_DEFAULT_TOOLS).not.toContain("bash");
	// macOS/Linux 平台语义：bash 在列、无 powershell
	expect(UNIX_DEFAULT_TOOLS).toContain("bash");
	expect(UNIX_DEFAULT_TOOLS).not.toContain("powershell");
});

test("ensureDefaultTools: 未配置 → 写入当前平台清单（written）", async () => {
	const p = join(dir, "settings-ensure-missing.json");
	await writeFile(p, JSON.stringify({ retry: { maxRetries: 3 } }), "utf8");
	await expect(ensureDefaultTools(p)).resolves.toBe("written");
	expect(await loadDefaultTools(p)).toEqual(defaultToolsForPlatform());
});

test("ensureDefaultTools: 旧版自动写入的清单 → 升级为新清单（upgraded）", async () => {
	const p = join(dir, "settings-ensure-legacy.json");
	await saveDefaultTools([...LEGACY_WINDOWS_DEFAULT_TOOLS], p);
	await expect(ensureDefaultTools(p)).resolves.toBe("upgraded");
	expect(await loadDefaultTools(p)).toEqual(defaultToolsForPlatform());
});

test("ensureDefaultTools: 用户自定义清单 → 不覆盖（kept）", async () => {
	const p = join(dir, "settings-ensure-custom.json");
	const custom = ["read", "bash"];
	await saveDefaultTools(custom, p);
	await expect(ensureDefaultTools(p)).resolves.toBe("kept");
	expect(await loadDefaultTools(p)).toEqual(custom);
});

test("ensureDefaultTools: 已是新清单 → 幂等 kept", async () => {
	const p = join(dir, "settings-ensure-current.json");
	await saveDefaultTools(defaultToolsForPlatform(), p);
	await expect(ensureDefaultTools(p)).resolves.toBe("kept");
	expect(await loadDefaultTools(p)).toEqual(defaultToolsForPlatform());
});

// —— language（界面语言偏好：前端切换语言时双写 kernel settings.json，后端 i18n 基建）——

test("loadLanguage：文件不存在/未配置 → 返回 undefined（跟随前端，不落默认值）", async () => {
	expect(await loadLanguage(file)).toBeUndefined();
	await writeFile(file, JSON.stringify({ retry: { maxRetries: 3 } }), "utf8");
	expect(await loadLanguage(file)).toBeUndefined();
});

// 照抄 loadDefaultTools 的语义：磁盘脏数据（白名单外/非字符串）视同未配置
test("loadLanguage：磁盘脏数据（白名单外字符串/非字符串）→ 视同未配置返回 undefined", async () => {
	await writeFile(file, JSON.stringify({ language: "fr" }), "utf8");
	expect(await loadLanguage(file)).toBeUndefined();
	await writeFile(file, JSON.stringify({ language: 42 }), "utf8");
	expect(await loadLanguage(file)).toBeUndefined();
});

test("saveLanguage/loadLanguage：zh 与 en 写入并持久化，保留其他字段（read-modify-write）", async () => {
	await writeFile(
		file,
		JSON.stringify({ retry: { maxRetries: 5 }, defaultModel: "m1" }),
		"utf8",
	);
	expect(await saveLanguage("en", file)).toBe("en");
	const onDisk = JSON.parse(await readFile(file, "utf8"));
	expect(onDisk.language).toBe("en");
	// 其他字段不被冲掉
	expect(onDisk.retry.maxRetries).toBe(5);
	expect(onDisk.defaultModel).toBe("m1");
	expect(await loadLanguage(file)).toBe("en");

	// 切回 zh 同样可写可读
	expect(await saveLanguage("zh", file)).toBe("zh");
	expect(await loadLanguage(file)).toBe("zh");
});

test("saveLanguage：白名单外（fr/空串/非字符串）→ throw 且不落盘", async () => {
	await writeFile(file, JSON.stringify({ language: "zh" }), "utf8");
	await expect(saveLanguage("fr" as any, file)).rejects.toThrow();
	await expect(saveLanguage("" as any, file)).rejects.toThrow();
	await expect(saveLanguage(42 as any, file)).rejects.toThrow();
	// 非法值不落盘：文件内容保持原样
	expect(JSON.parse(await readFile(file, "utf8")).language).toBe("zh");
});
