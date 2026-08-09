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
});

test("预热失败为 dispose 竞态（SESSION_DISPOSED）：不打印「后台预热会话进程失败」", async () => {
const alive = { v: false };
const broadcasts: any[] = [];
const server = makeServer({ alive, broadcasts });
// 模拟 prewarm 撞上 session:delete / 空闲回收：ensureStarted reject 会话已清理
const disposedErr: any = new Error("会话已清理: s1");
disposedErr.code = "SESSION_DISPOSED";
(server as any).opts.agentManager.ensureStarted = async () => {
throw disposedErr;
};

const logs: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
try {
const res = await server.callApi({ type: "session:messages", sessionId: "s1" } as any);
expect(res.status).toBe(200);
await new Promise((r) => setTimeout(r, 0));
} finally {
console.error = origError;
}

// 核心断言：dispose 竞态是预期控制流，不应打印预热失败日志
expect(logs.some((l) => l.includes("后台预热会话进程失败"))).toBe(false);
expect(broadcasts).toHaveLength(0);
});

test("预热失败为其他错误（非 dispose 竞态）：仍打印「后台预热会话进程失败」", async () => {
const alive = { v: false };
const broadcasts: any[] = [];
const server = makeServer({ alive, broadcasts });
(server as any).opts.agentManager.ensureStarted = async () => {
throw new Error("真实启动失败");
};

const logs: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
try {
const res = await server.callApi({ type: "session:messages", sessionId: "s1" } as any);
expect(res.status).toBe(200);
await new Promise((r) => setTimeout(r, 0));
} finally {
console.error = origError;
}

// 真异常仍打印（可排障）
expect(logs.some((l) => l.includes("后台预热会话进程失败"))).toBe(true);
expect(logs.some((l) => l.includes("真实启动失败"))).toBe(true);
expect(broadcasts).toHaveLength(0);

rmSync(dir, { recursive: true, force: true });
});
