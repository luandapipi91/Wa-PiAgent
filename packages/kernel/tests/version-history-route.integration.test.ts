/**
 * 版本历史路由集成测：真实 WSServer（进程内，port 0）+ 真实 HTTP 请求。
 * 不起完整 kernel、不快照 WA_PI_DIR，故无需登记进 scripts/test.ts 的 INTEGRATION_TESTS
 * （与 memory-routes.test.ts 同款做法）。
 *
 * 不注入 fetch：线上可达性取决于运行环境，两种 source 都算通过——只断言
 * 「接口存在、200、字段结构合法」，测试不依赖外网。
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

let tmpDir: string;

beforeEach(() => {
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
		mcpStore: null as any,
		dataDir,
		agentManager: { disposeAll: async () => {}, markAllDirty: () => {} } as any,
		channelManager: null,
		port: 0,
	};
	const server = new WSServer(opts);
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
		expect(Array.isArray(body.history)).toBe(true);
		expect(["remote", "unavailable"]).toContain(body.source);
	} finally {
		await server.stop();
	}
});
