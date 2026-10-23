/**
 * 版本历史路由集成测：真实 WSServer（进程内，port 0）+ 真实 HTTP 请求。
 * 不起完整 kernel、不快照 WA_PI_DIR，故无需登记进 scripts/test.ts 的 INTEGRATION_TESTS
 * （与 memory-routes.test.ts 同款做法）。
 *
 * 不注入 fetchImpl 给服务端，改为在 server.start() 之前用 fetchImpl 预热内核模块缓存
 * （同一进程内 WSServer 与测试文件共享同一模块实例，故缓存对服务端可见）：预热后接口
 * 命中缓存、不发网请求，source 可确定断言为 remote，测试自包含、不依赖外网。
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { MemoryStore } from "../src/memory-store";
import { WSServer, type WSServerOpts } from "../src/ws-server";
import {
	getRemoteVersionHistory,
	__resetVersionHistoryCacheForTest,
} from "../src/version-history";

let tmpDir: string;

beforeEach(() => {
	// 每个用例前清缓存，保证确定性（不依赖上一用例的残留缓存）
	__resetVersionHistoryCacheForTest();
	tmpDir = mkdtempSync(join(tmpdir(), "version-history-route-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /api/version-history 返回结构合法的历史", async () => {
	const projectFile = join(tmpDir, "projects.json");
	writeFileSync(projectFile, JSON.stringify({ projects: [], sessions: [] }), "utf8");
	const dataDir = join(tmpDir, "data");
	mkdirSync(dataDir, { recursive: true });
	const opts: WSServerOpts = {
		configStore: new ConfigStore(join(tmpDir, "config")),
		projectStore: new ProjectStore(projectFile),
		providerStore: new ProviderStore(join(tmpDir, "providers.json")),
		skillManager: new SkillManager(join(tmpDir, "skills")),
		extensionManager: new ExtensionManager(dataDir),
		memoryStore: new MemoryStore({
			waPiDir: tmpDir,
			projectStore: new ProjectStore(projectFile),
		}),
		dataDir,
		agentManager: { disposeAll: async () => {}, markAllDirty: () => {} } as any,
		channelManager: null,
		port: 0,
	};
	const server = new WSServer(opts);
	// 起服务之前预热内核模块缓存：服务端 getRemoteVersionHistory() 直接命中缓存，不发网请求
	await getRemoteVersionHistory({
		fetchImpl: (async () =>
			new Response(
				JSON.stringify([
					{
						version: "0.6.10",
						date: "2026-09-24",
						sections: { 修复: ["预热条目"] },
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch,
	});
	await server.start();
	try {
		const res = await fetch(
			`http://127.0.0.1:${server.actualPort}/api/version-history`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			type: string;
			history: unknown[];
			source: string;
		};
		expect(body.type).toBe("version-history:get");
		expect(body.source).toBe("remote");
		expect(body.history).toEqual([
			{
				version: "0.6.10",
				date: "2026-09-24",
				sections: { 修复: ["预热条目"] },
			},
		]);
	} finally {
		await server.stop();
	}
});

test("GET /api/version-history?refresh=1 绕过 6h 缓存立即重拉（发版后不必等缓存过期）", async () => {
	const projectFile = join(tmpDir, "projects.json");
	writeFileSync(projectFile, JSON.stringify({ projects: [], sessions: [] }), "utf8");
	const dataDir = join(tmpDir, "data");
	mkdirSync(dataDir, { recursive: true });
	const opts: WSServerOpts = {
		configStore: new ConfigStore(join(tmpDir, "config")),
		projectStore: new ProjectStore(projectFile),
		providerStore: new ProviderStore(join(tmpDir, "providers.json")),
		skillManager: new SkillManager(join(tmpDir, "skills")),
		extensionManager: new ExtensionManager(dataDir),
		memoryStore: new MemoryStore({
			waPiDir: tmpDir,
			projectStore: new ProjectStore(projectFile),
		}),
		dataDir,
		agentManager: { disposeAll: async () => {}, markAllDirty: () => {} } as any,
		channelManager: null,
		port: 0,
	};
	const server = new WSServer(opts);
	// 预热旧缓存：普通请求命中它（与真机「发版后内核仍返回旧历史」同形）
	await getRemoteVersionHistory({
		fetchImpl: (async () =>
			new Response(
				JSON.stringify([
					{ version: "0.6.10", date: "2026-09-24", sections: { 修复: ["旧缓存条目"] } },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch,
	});
	// 服务端重拉时走全局 fetch：模拟 OSS 已经更新到新版本
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		if (String(url).includes("version-history.json")) {
			return new Response(
				JSON.stringify([
					{ version: "0.7.15", date: "2026-10-23", sections: { 修复: ["新版本内容"] } },
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return originalFetch(String(url), init);
	}) as unknown as typeof fetch;
	await server.start();
	try {
		const base = `http://127.0.0.1:${server.actualPort}`;
		const cached = (await (await fetch(`${base}/api/version-history`)).json()) as {
			history: Array<{ version: string }>;
		};
		expect(cached.history[0].version).toBe("0.6.10");
		const forced = (await (
			await fetch(`${base}/api/version-history?refresh=1`)
		).json()) as { history: Array<{ version: string }> };
		expect(forced.history[0].version).toBe("0.7.15");
	} finally {
		globalThis.fetch = originalFetch;
		await server.stop();
	}
});
