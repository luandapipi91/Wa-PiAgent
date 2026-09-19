// 回归：/api/fs/stat-batch（一次探测多个路径）+ statIsFile 语义。
//
// 背景（2026-09-16 卡顿定位）：消息里每个路径 chip 挂载即各发一次 /api/fs/stat，
// 虚拟滚动重挂载会重复发；同一时刻的大量 stat 集中返回、集中 setState 是界面卡顿成因之一。
// 修复：前端按同一 tick 合并成一次 stat-batch 请求；后端把原来「existsSync + stat」两次
// 磁盘操作收敛为一次 stat。这里在真实 HTTP 层锁住契约。
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import { WSServer } from "../src/ws-server";
import { statIsFile } from "../src/routes/fs";

const root = mkdtempSync(join(tmpdir(), "wa-pi-stat-batch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tmpDir(name: string): string {
	const p = join(root, name + "-" + Math.random().toString(36).slice(2));
	mkdirSync(p, { recursive: true });
	return p;
}

async function setup() {
	const cfgDir = tmpDir("cfg");
	const projFile = join(
		root,
		"proj-" + Math.random().toString(36).slice(2) + ".json",
	);
	const server = new WSServer({
		configStore: new ConfigStore(cfgDir),
		projectStore: new ProjectStore(projFile),
		providerStore: {
			save: async () => {},
			load: async () => ({ providers: [] }),
		} as any,
		skillManager: new SkillManager(join(cfgDir, "skills")),
		extensionManager: null as any,
		memoryStore: null as any,
		mcpStore: null as any,
		channelManager: null,
		agentManager: { markAllDirty: () => {}, disposeAll: async () => {} } as any,
		port: 0,
	});
	await server.start();
	return {
		base: `http://127.0.0.1:${server.actualPort}`,
		cleanup: async () => {
			await server.stop();
			rmSync(cfgDir, { recursive: true, force: true });
			rmSync(projFile, { force: true });
		},
	};
}

async function post(base: string, path: string, body: unknown) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("statIsFile：文件 true / 目录 false / 不存在 false", async () => {
	const dir = tmpDir("sem");
	const file = join(dir, "a.txt");
	writeFileSync(file, "hi");
	expect(await statIsFile(file)).toBe(true);
	expect(await statIsFile(dir)).toBe(false);
	expect(await statIsFile(join(dir, "nope.txt"))).toBe(false);
});

test("POST /api/fs/stat-batch 一次返回多路径结果（顺序与入参一致）", async () => {
	const ctx = await setup();
	const dir = tmpDir("batch");
	const a = join(dir, "a.txt");
	const b = join(dir, "b.txt");
	writeFileSync(a, "a");
	try {
		const paths = [a, b, dir];
		const res = await post(ctx.base, "/api/fs/stat-batch", { paths });
		expect(res.ok).toBe(true);
		const data: any = await res.json();
		expect(data.type).toBe("fs:statBatch");
		expect(data.results.map((r: any) => r.path)).toEqual(paths);
		expect(data.results.map((r: any) => r.exists)).toEqual([true, false, false]);
	} finally {
		await ctx.cleanup();
	}
});

test("stat-batch 缺 paths → 参数错误响应", async () => {
	const ctx = await setup();
	try {
		const res = await post(ctx.base, "/api/fs/stat-batch", {});
		expect(res.ok).toBe(false);
		expect(res.status).toBe(400);
	} finally {
		await ctx.cleanup();
	}
});

test("单路径 /api/fs/stat 与批量结果一致", async () => {
	const ctx = await setup();
	const dir = tmpDir("single");
	const f = join(dir, "c.txt");
	writeFileSync(f, "c");
	try {
		const res = await post(ctx.base, "/api/fs/stat", { path: f });
		const data: any = await res.json();
		expect(data).toEqual({ type: "fs:stat", path: f, exists: true });

		const miss = await post(ctx.base, "/api/fs/stat", {
			path: join(dir, "no.txt"),
		});
		const missData: any = await miss.json();
		expect(missData.exists).toBe(false);
	} finally {
		await ctx.cleanup();
	}
});
