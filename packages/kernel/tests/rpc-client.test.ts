import { describe, test, expect, afterEach } from "bun:test";
import { collectProxyEnv } from "../src/rpc-client";

// 代理变量列表（与 collectProxyEnv 内部一致）
const PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"ALL_PROXY",
	"all_proxy",
];

afterEach(() => {
	for (const k of PROXY_KEYS) delete process.env[k];
});

describe("collectProxyEnv", () => {
	test("显式收集代理变量（Bun 的 Object.keys 不含它们，但直接读能拿到）", () => {
		process.env.HTTP_PROXY = "http://127.0.0.1:7890";
		process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
		const out = collectProxyEnv();
		expect(out.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(out.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	test("未设置的代理变量不返回", () => {
		const out = collectProxyEnv();
		expect(out.HTTP_PROXY).toBeUndefined();
		expect(out.NO_PROXY).toBeUndefined();
	});

	test("大小写都收集", () => {
		process.env.http_proxy = "http://127.0.0.1:7890";
		process.env.https_proxy = "http://127.0.0.1:7890";
		const out = collectProxyEnv();
		expect(out.http_proxy).toBe("http://127.0.0.1:7890");
		expect(out.https_proxy).toBe("http://127.0.0.1:7890");
	});
});
