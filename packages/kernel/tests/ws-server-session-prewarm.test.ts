// session:messages 后台预热：冷会话 ensureStarted 完成后广播 session:activated，
// 前端据此重拉 /stats 补齐 contextUsage（占比/进度条）；热会话不重复广播。
import { test, expect } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";

const dir = join(import.meta.dir, ".tmp-prewarm");
mkdirSync(dir, { recursive: true });

function makeServer(opts: { alive: { v: boolean }; broadcasts: any[] }) {
	const file = join(dir, "s1.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "x" }) + "\n");
	const session = {
		id: "s1",
		projectId: "p1",
		primaryAgent: "dev",
		title: "t",
		createdAt: 0,
		lastActivity: 0,
		piSessionFile: file,
	};
	const server = new WSServer({
		projectStore: {
			load: async () => ({ projects: [], sessions: [session] }),
			touchSession: async () => {},
		},
		agentManager: {
			isSessionBusy: () => false,
			getThinkingSince: () => null,
			isSessionAlive: () => opts.alive.v,
			ensureStarted: async () => {
				opts.alive.v = true;
				return {};
			},
		},
	} as any);
	(server as any).broadcast = (e: any) => opts.broadcasts.push(e);
	return server;
}

test("冷会话预热完成后广播 session:activated", async () => {
	const alive = { v: false };
	const broadcasts: any[] = [];
	const server = makeServer({ alive, broadcasts });

	const res = await server.callApi({ type: "session:messages", sessionId: "s1" } as any);
	expect(res.status).toBe(200);
	// 等预热的 promise 链完成
	await new Promise((r) => setTimeout(r, 0));

	expect(broadcasts).toContainEqual({ type: "session:activated", sessionId: "s1" });
});

test("热会话（进程已存活）预热后不重复广播", async () => {
	const alive = { v: true }; // 进程已存活
	const broadcasts: any[] = [];
	const server = makeServer({ alive, broadcasts });

	const res = await server.callApi({ type: "session:messages", sessionId: "s1" } as any);
	expect(res.status).toBe(200);
	await new Promise((r) => setTimeout(r, 0));

	expect(broadcasts).toHaveLength(0);
});

test("预热失败不广播也不影响 messages 响应", async () => {
	const alive = { v: false };
	const broadcasts: any[] = [];
	const server = makeServer({ alive, broadcasts });
	(server as any).opts.agentManager.ensureStarted = async () => {
		throw new Error("启动失败");
	};

	const res = await server.callApi({ type: "session:messages", sessionId: "s1" } as any);
	expect(res.status).toBe(200);
	await new Promise((r) => setTimeout(r, 0));
	expect(broadcasts).toHaveLength(0);

	rmSync(dir, { recursive: true, force: true });
});
