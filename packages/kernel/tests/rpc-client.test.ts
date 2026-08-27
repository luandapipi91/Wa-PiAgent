import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { collectProxyEnv, resolvePiRuntime } from "../src/rpc-client";

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

describe("resolvePiRuntime", () => {
	// globalThis.Bun 在 bun 下只读无法 mock；Bun.which 又用启动时的 PATH 快照，
	// 动态改 process.env.PATH 无效。因此直接依赖本机真实环境：桌面版会往
	// ~/.pi/agent/bin 放 bun 链接，Bun.which("bun") 命中它且 ≠ process.execPath。
	const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
	const originalEnvRuntime = process.env.WA_PI_PI_RUNTIME;

	afterEach(() => {
		if (platformDesc) Object.defineProperty(process, "platform", platformDesc);
		if (originalEnvRuntime === undefined) delete process.env.WA_PI_PI_RUNTIME;
		else process.env.WA_PI_PI_RUNTIME = originalEnvRuntime;
	});

	test("env 覆盖 WA_PI_PI_RUNTIME 优先级最高", () => {
		process.env.WA_PI_PI_RUNTIME = "/custom/bun";
		expect(resolvePiRuntime()).toBe("/custom/bun");
	});

	test("win32：跳过 PATH 上的 bun（含 .cmd shim），用 process.execPath", () => {
		// 回归背景：桌面端把 bun.cmd shim 放上 PATH，cmd.exe 按 GBK 解析含中文
		// 安装路径的批处理导致 pi rpc 全部启动失败。Windows 上必须绕开 shim。
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(resolvePiRuntime()).toBe(process.execPath);
	});

	test("非 win32：Bun.which 命中的 bun 仍被使用", () => {
		const which = (globalThis as any).Bun?.which;
		if (typeof which !== "function") return; // 非 bun 运行时，无可断言
		const found = which("bun");
		if (!found || !existsSync(found)) return; // 环境无 bun，跳过
		expect(resolvePiRuntime()).toBe(found);
	});
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
