// 记忆 / 检索路由测试（任务 11）
//
// 分两层，都不启动完整 kernel（不调 startKernel，也不快照 WA_PI_DIR 到模块常量，
// 故无需进 scripts/test.ts 的 INTEGRATION_TESTS 串行组——与 bridge.test.ts 同款做法）：
// 1. 路由注册层：HttpRouter + 记录型 callApi，断言 HTTP 查询参数到 WS 事件的映射
// 2. 真实 WSServer（进程内，port 0）：HTTP → callApi → handle 分发 → MemoryStore → DAO
//    覆盖「空串参数归一为 undefined」与「UI projectId 解析为项目名」两条链路
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClientEvent } from "@wa-pi/shared";
import { HttpRouter } from "../src/http-router";
import { registerMemoryRoutes } from "../src/routes/memory";
import { MemoryStore } from "../src/memory-store";
import { closeAllMemoryDbs } from "../src/memory/db";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer, type WSServerOpts } from "../src/ws-server";

const PROJECT_CWD = "/repos/my-app";
let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "memory-routes-"));
});

afterEach(() => {
	closeAllMemoryDbs();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** 记录型 callApi：只记录事件、固定回 200 */
function makeRecordingRouter() {
	const seen: WSClientEvent[] = [];
	const r = new HttpRouter();
	registerMemoryRoutes(
		r,
		async (e) => {
			seen.push(e);
			return Response.json({ ok: true });
		},
		{ projectStore: {} as any },
	);
	return { r, seen };
}

// ===== 路由注册层：query → 事件映射 =====

test("GET /api/memories/search 全量参数映射为 memory:search 事件", async () => {
	const { r, seen } = makeRecordingRouter();
	const res = await r.handle(
		new Request(
			"http://x/api/memories/search?q=sqlite&scope=global&kind=knowledge&projectId=p1&limit=3&includeArchived=true",
		),
	);
	expect(res!.status).toBe(200);
	expect(seen).toEqual([
		{
			type: "memory:search",
			query: "sqlite",
			scope: "global",
			kind: "knowledge",
			projectId: "p1",
			limit: 3,
			includeArchived: true,
		},
	]);
});

test("GET /api/memories/search 缺参 → 空串 + limit 10 + includeArchived false", async () => {
	const { r, seen } = makeRecordingRouter();
	await r.handle(new Request("http://x/api/memories/search"));
	expect(seen).toEqual([
		{
			type: "memory:search",
			query: "",
			scope: "",
			kind: "",
			projectId: "",
			limit: 10,
			includeArchived: false,
		},
	]);
});

test("GET /api/memories/search 非法 limit 回落到默认 10", async () => {
	const { r, seen } = makeRecordingRouter();
	await r.handle(new Request("http://x/api/memories/search?q=a&limit=abc"));
	expect((seen[0] as any).limit).toBe(10);

	seen.length = 0;
	await r.handle(new Request("http://x/api/memories/search?q=a&limit=0"));
	expect((seen[0] as any).limit).toBe(10);
});

test("既有记忆路由未被改动：list / purge 仍映射原事件", async () => {
	const { r, seen } = makeRecordingRouter();
	await r.handle(new Request("http://x/api/memories?projectId=p1"));
	await r.handle(new Request("http://x/api/memories/abc?projectId=p1", { method: "DELETE" }));
	expect(seen).toEqual([
		{ type: "memory:list", projectId: "p1" },
		{ type: "memory:purge", projectId: "p1", entryId: "abc" },
	]);
});

// ===== 真实 WSServer：分发层 =====

/** 起最小 WSServer（内存记忆库落在 tmpDir），返回端口与停止函数 */
async function startTestServer() {
	const projectFile = join(tmpDir, "projects.json");
	writeFileSync(
		projectFile,
		JSON.stringify({
			projects: [{ id: "p1", name: "test", cwd: PROJECT_CWD, createdAt: Date.now() }],
			sessions: [],
		}),
		"utf8",
	);
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
	return { server, port: server.actualPort };
}

async function seedViaApi(port: number, body: Record<string, unknown>) {
	const res = await fetch(`http://127.0.0.1:${port}/api/memories`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
}

test("GET /api/memories/search：空串 scope 归一为 undefined，跨作用域命中", async () => {
	const { server, port } = await startTestServer();
	try {
		await seedViaApi(port, { scope: "global", text: "sqlite 全局索引优化" });
		await seedViaApi(port, { scope: "project", projectId: "p1", text: "sqlite 项目索引优化" });

		// scope 显式传空串：若原样下传，DAO 会按 scope='' 过滤 → 0 结果
		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=sqlite&scope=&kind=&projectId=&limit=&includeArchived=`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.type).toBe("memory:search");
		expect(body.results.map((r: any) => r.title).sort()).toEqual(
			["sqlite 全局索引优化", "sqlite 项目索引优化"].sort(),
		);
		expect(body.results.every((r: any) => typeof r.score === "number")).toBe(true);
		const scopes = body.results.map((r: any) => r.scope).sort();
		expect(scopes).toEqual(["global", "project"]);
		// 归档标记与 updatedAt 均为 UI 可直接渲染的值
		expect(body.results.every((r: any) => r.archived === false)).toBe(true);
		expect(body.results.every((r: any) => r.updatedAt.includes("T"))).toBe(true);
	} finally {
		await server.stop();
	}
});

test("GET /api/memories/search：UI projectId 解析为项目名后过滤", async () => {
	const { server, port } = await startTestServer();
	try {
		await seedViaApi(port, { scope: "global", text: "sqlite 全局索引优化" });
		await seedViaApi(port, { scope: "project", projectId: "p1", text: "sqlite 项目索引优化" });

		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=sqlite&scope=project&projectId=p1`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.results).toHaveLength(1);
		expect(body.results[0].scope).toBe("project");
		expect(body.results[0].projectId).toBe("my-app");
	} finally {
		await server.stop();
	}
});

test("GET /api/memories/search：project 作用域下无法解析 projectId → 400 + 错误码", async () => {
	const { server, port } = await startTestServer();
	try {
		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=sqlite&scope=project&projectId=nope`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBeTruthy();
		expect(body.code).toBe("project.notFound");
	} finally {
		await server.stop();
	}
});

test("GET /api/memories/search：totalMatched 是未截断的真实命中总数（与 results.length 不同）", async () => {
	const { server, port } = await startTestServer();
	try {
		for (const s of ["一", "二", "三"]) {
			await seedViaApi(port, { scope: "global", text: `pagination 样本 ${s}` });
		}

		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=pagination&limit=1`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.type).toBe("memory:search");
		expect(body.results).toHaveLength(1);
		expect(body.totalMatched).toBe(3);
	} finally {
		await server.stop();
	}
});

test("GET /api/memories/search：未传 scope 不再限定项目（给了 projectId 也仍是跨域）", async () => {
	const { server, port } = await startTestServer();
	try {
		await seedViaApi(port, { scope: "global", text: "sqlite 全局索引优化" });
		await seedViaApi(port, { scope: "project", projectId: "p1", text: "sqlite 项目索引优化" });

		// 不传 scope + 传了可解析的 projectId：仍是跨域检索（spec §5），全局条目不得被排除
		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=sqlite&projectId=p1`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.results.map((r: any) => r.scope).sort()).toEqual(["global", "project"]);
		expect(body.totalMatched).toBe(2);
	} finally {
		await server.stop();
	}
});

test("GET /api/memories/search：未传 scope 但 projectId 解析不到 → 400 + project.notFound", async () => {
	const { server, port } = await startTestServer();
	try {
		await seedViaApi(port, { scope: "global", text: "sqlite 全局索引优化" });

		const res = await fetch(
			`http://127.0.0.1:${port}/api/memories/search?q=sqlite&projectId=nope`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("project.notFound");
	} finally {
		await server.stop();
	}
});

test("GET /api/memories：列表仍返回全局 + 当前项目（DB 后端）", async () => {
	const { server, port } = await startTestServer();
	try {
		await seedViaApi(port, { scope: "global", text: "全局记忆" });
		await seedViaApi(port, { scope: "project", projectId: "p1", text: "项目记忆" });

		const res = await fetch(`http://127.0.0.1:${port}/api/memories?projectId=p1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.type).toBe("memory:list");
		expect(body.memories.map((m: any) => m.text).sort()).toEqual(["全局记忆", "项目记忆"]);
		expect(body.memories.every((m: any) => /^[0-9a-f-]{36}$/.test(m.id))).toBe(true);
		expect(body.archived).toEqual([]);
	} finally {
		await server.stop();
	}
});
