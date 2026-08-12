// node-runtime.cjs 单元测试。
// 覆盖每个判断节点：IP 检测、下载源选择、系统 node 探测、已下载缓存、下载失败 fallback。
// 所有网络请求 mock，不依赖真实网络。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectIsCN,
	findSystemNode,
	ensureNodeRuntime,
	nodeDownloadSpecs,
	NODE_LTS,
} from "../src/util/node-runtime.cjs";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as any;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = originalFetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

// 辅助：mock fetch 返回同时支持 .json() 和 .arrayBuffer() 的响应
function mockFetch(opts: {
	json?: () => Promise<unknown>;
	arrayBuffer?: () => Promise<ArrayBuffer>;
	ok?: boolean;
	status?: number;
}) {
	globalThis.fetch = (() =>
		Promise.resolve({
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			body: {},
			redirect: "follow",
			json: opts.json ?? (() => Promise.resolve({})),
			arrayBuffer:
				opts.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
		})) as any;
}

// ===================== detectIsCN =====================

test("detectIsCN: IP 返回 CN → true", async () => {
	mockFetch({
		json: () => Promise.resolve({ country: "CN" }),
	});
	expect(await detectIsCN(noopLog)).toBe(true);
});

test("detectIsCN: IP 返回 US → false", async () => {
	mockFetch({
		json: () =>
			Promise.resolve({
				countryCode: "US",
				country: "United States",
			}),
	});
	expect(await detectIsCN(noopLog)).toBe(false);
});

test("detectIsCN: fetch 抛异常 → 默认 true（国内源安全 fallback）", async () => {
	globalThis.fetch = (() =>
		Promise.reject(new Error("network timeout"))) as any;
	expect(await detectIsCN(noopLog)).toBe(true);
});

// ===================== nodeDownloadSpecs =====================

test("nodeDownloadSpecs: isCN=true → npmmirror 优先", () => {
	const { urls } = nodeDownloadSpecs(true);
	expect(urls[0]).toContain("npmmirror.com");
	expect(urls[1]).toContain("nodejs.org");
});

test("nodeDownloadSpecs: isCN=false → nodejs.org 优先", () => {
	const { urls } = nodeDownloadSpecs(false);
	expect(urls[0]).toContain("nodejs.org");
	expect(urls[1]).toContain("npmmirror.com");
});

test("nodeDownloadSpecs: archive 文件名含 NODE_LTS 版本号", () => {
	const { archive } = nodeDownloadSpecs(true);
	expect(archive).toContain(NODE_LTS);
});

test("nodeDownloadSpecs: 当前平台 archive 后缀正确", () => {
	const { archive } = nodeDownloadSpecs(true);
	if (process.platform === "win32") {
		expect(archive).toMatch(/\.zip$/);
	} else if (process.platform === "darwin") {
		expect(archive).toMatch(/\.tar\.gz$/);
	} else {
		expect(archive).toMatch(/\.tar\.xz$/);
	}
});

test("nodeDownloadSpecs: URL 含两个源", () => {
	const { urls } = nodeDownloadSpecs(true);
	expect(urls).toHaveLength(2);
});

// ===================== findSystemNode =====================

test("findSystemNode: 返回 null 或有效路径（不抛异常）", () => {
	const result = findSystemNode();
	expect(result === null || typeof result === "string").toBe(true);
});

// ===================== ensureNodeRuntime =====================

test("ensureNodeRuntime: 已下载且版本匹配 → 跳过下载（fetch 不被调用）", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	let fetchCalled = false;
	try {
		const nodeDir = join(base, "node");
		await mkdir(nodeDir, { recursive: true });
		if (process.platform === "win32") {
			await writeFile(join(nodeDir, "node.exe"), "fake");
		} else {
			await mkdir(join(nodeDir, "bin"), { recursive: true });
			await writeFile(join(nodeDir, "bin", "node"), "fake");
		}
		await writeFile(join(nodeDir, ".installed-version"), NODE_LTS);

		globalThis.fetch = (() => {
			fetchCalled = true;
			return Promise.resolve({} as any);
		}) as any;

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: false,
		} as any);
		// 无论走系统 node 还是 marker 缓存，都不应触发下载
		expect(result).toBeTruthy();
		expect(fetchCalled).toBe(false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureNodeRuntime: 已下载但版本不匹配 → 触发重新下载", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	let fetchCalled = false;
	const savedPath = process.env.PATH;
	try {
		const nodeDir = join(base, "node");
		await mkdir(nodeDir, { recursive: true });
		if (process.platform === "win32") {
			await writeFile(join(nodeDir, "node.exe"), "old");
		} else {
			await mkdir(join(nodeDir, "bin"), { recursive: true });
			await writeFile(join(nodeDir, "bin", "node"), "old");
		}
		// marker 版本不匹配
		await writeFile(join(nodeDir, ".installed-version"), "v0.0.0");

		// 临时清空 PATH，模拟无系统 node（否则 PATH 检测会找到本机 node 直接返回）
		process.env.PATH = "";

		mockFetch({
			json: () => Promise.resolve({ country: "CN" }),
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)), // 太小 → 下载失败
		});
		globalThis.fetch = ((..._args: unknown[]) => {
			fetchCalled = true;
			return Promise.resolve({
				ok: true,
				status: 200,
				body: {},
				redirect: "follow",
				json: () => Promise.resolve({ country: "CN" }),
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
			}) as any;
		}) as any;

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: false,
		} as any);
		expect(fetchCalled).toBe(true);
		expect(result).toBeNull(); // 下载失败
	} finally {
		process.env.PATH = savedPath;
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureNodeRuntime: forceDownload=true + 下载文件过小 → null", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	try {
		mockFetch({
			json: () => Promise.resolve({ country: "CN" }),
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
		});

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: true,
		} as any);
		expect(result).toBeNull();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureNodeRuntime: forceDownload=true + HTTP 错误 → null", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	try {
		mockFetch({
			ok: false,
			status: 404,
			json: () => Promise.resolve({ country: "CN" }),
		});

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: true,
		} as any);
		expect(result).toBeNull();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureNodeRuntime: forceDownload=true + 网络异常 → null", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	try {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as any;

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: true,
		} as any);
		expect(result).toBeNull();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureNodeRuntime: forceDownload=true 跳过 marker 缓存", async () => {
	const base = await mkdtemp(join(tmpdir(), "node-rt-test-"));
	let fetchCalled = false;
	try {
		const nodeDir = join(base, "node");
		await mkdir(nodeDir, { recursive: true });
		if (process.platform === "win32") {
			await writeFile(join(nodeDir, "node.exe"), "cached");
		} else {
			await mkdir(join(nodeDir, "bin"), { recursive: true });
			await writeFile(join(nodeDir, "bin", "node"), "cached");
		}
		await writeFile(join(nodeDir, ".installed-version"), NODE_LTS);

		// forceDownload=true 应跳过 marker 缓存，触发下载
		globalThis.fetch = ((..._args: unknown[]) => {
			fetchCalled = true;
			return Promise.resolve({
				ok: false,
				status: 500,
				body: null,
				redirect: "follow",
				json: () => Promise.resolve({ country: "CN" }),
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
			}) as any;
		}) as any;

		const result = await ensureNodeRuntime({
			waPiDir: base,
			log: noopLog,
			forceDownload: true,
		} as any);
		// forceDownload 跳过了 marker 缓存，触发了 fetch（下载失败）
		expect(fetchCalled).toBe(true);
		expect(result).toBeNull();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
