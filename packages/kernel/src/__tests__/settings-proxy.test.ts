import { describe, test, expect, afterEach } from "bun:test";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadProxySettings,
	saveProxySettings,
	applySystemProxy,
	PROXY_DEFAULTS,
} from "../settings-store";
import { stopProxyRelay } from "../proxy-relay";

// 与 settings-trash.test.ts 一致：用 TEST_FILE 隔离路径，避免触碰真实 settings.json。
const TEST_FILE = join(tmpdir(), `test-settings-proxy-${Date.now()}.json`);

// env 代理不再直接写上游地址，而是本地中继（proxy-relay）地址
const RELAY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+$/;

describe("Proxy settings", () => {
	afterEach(async () => {
		await rm(TEST_FILE, { force: true });
		// Bun 的代理变量是特殊 getter/setter：delete 清不掉（同进程后续测试文件
		// 的 fetch/node:http 仍会被残留代理劫持），置空串才能清除
		process.env.HTTP_PROXY = "";
		process.env.HTTPS_PROXY = "";
		process.env.http_proxy = "";
		process.env.https_proxy = "";
		await stopProxyRelay();
	});

	test("loadProxySettings 无文件时返回默认值（关闭 + 空代理）", async () => {
		const settings = await loadProxySettings(TEST_FILE);
		expect(settings).toEqual(PROXY_DEFAULTS);
	});

	test("saveProxySettings 持久化并可读回", async () => {
		const custom = { useSystemProxy: true, httpProxy: "http://127.0.0.1:7890" };
		await saveProxySettings(custom, TEST_FILE);
		const loaded = await loadProxySettings(TEST_FILE);
		expect(loaded).toEqual(custom);
	});

	test("saveProxySettings 保留 settings.json 其他字段（read-modify-write）", async () => {
		await writeFile(
			TEST_FILE,
			JSON.stringify({ retry: { maxRetries: 5 } }),
			"utf8",
		);
		await saveProxySettings(
			{ useSystemProxy: true, httpProxy: "http://x" },
			TEST_FILE,
		);
		const raw = JSON.parse(await readFile(TEST_FILE, "utf8"));
		expect(raw.retry).toEqual({ maxRetries: 5 });
		expect(raw.useSystemProxy).toBe(true);
		expect(raw.httpProxy).toBe("http://x");
	});

	test("applySystemProxy：开启且有代理 → env 指向本地中继（大小写齐全）", async () => {
		await saveProxySettings(
			{ useSystemProxy: true, httpProxy: "http://127.0.0.1:7890" },
			TEST_FILE,
		);
		await applySystemProxy(TEST_FILE, () => "");
		for (const key of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"http_proxy",
			"https_proxy",
		]) {
			expect(process.env[key]).toMatch(RELAY_URL_PATTERN);
		}
	});

	test("applySystemProxy：关闭 → env 同样指向中继（上游为空 = 直连）", async () => {
		await saveProxySettings({ useSystemProxy: false, httpProxy: "" }, TEST_FILE);
		process.env.HTTP_PROXY = "http://stale";
		process.env.HTTPS_PROXY = "http://stale";
		process.env.http_proxy = "http://stale";
		process.env.https_proxy = "http://stale";
		await applySystemProxy(TEST_FILE, () => "");
		for (const key of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"http_proxy",
			"https_proxy",
		]) {
			expect(process.env[key]).toMatch(RELAY_URL_PATTERN);
		}
	});

	test("applySystemProxy：开启但 httpProxy 空且读不到 → env 指向中继（上游为空 = 直连）", async () => {
		await saveProxySettings({ useSystemProxy: true, httpProxy: "" }, TEST_FILE);
		process.env.HTTP_PROXY = "http://stale";
		process.env.http_proxy = "http://stale";
		await applySystemProxy(TEST_FILE, () => "");
		expect(process.env.HTTP_PROXY).toMatch(RELAY_URL_PATTERN);
		expect(process.env.http_proxy).toMatch(RELAY_URL_PATTERN);
	});

	test("applySystemProxy：开启但 httpProxy 空 → readProxy 兜底读系统代理", async () => {
		await saveProxySettings({ useSystemProxy: true, httpProxy: "" }, TEST_FILE);
		await applySystemProxy(TEST_FILE, () => "http://127.0.0.1:7890");
		expect(process.env.HTTP_PROXY).toMatch(RELAY_URL_PATTERN);
		expect(process.env.http_proxy).toMatch(RELAY_URL_PATTERN);
	});
});
