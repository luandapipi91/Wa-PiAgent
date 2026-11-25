// GET /api/sessions/:sessionId/asks 的真实 HTTP 契约（第三层：路由 → ws-server.handle → askRegistry）。
//
// 背景：用户答完后 registry 条目立刻消失，而 toolResult 可能被同一批并行工具扣住数分钟。
// 旧回包只有 pending 列表，「不在列表」既可能是"已答完"也可能是"重启残留"，前端只能一律判失效
// ——用户看到"我明明答了，界面却说提问已失效且点不动"。新增 states 让前端能区分两种终态。
import { test, expect, beforeEach } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerProjectSessionRoutes } from "../src/routes/projects-sessions";
import { WSServer } from "../src/ws-server";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@wa-pi/shared";

// 与 ws-server-ask.test.ts 同款最小桩：session:asks 不依赖 configStore/projectStore 等重依赖
function makeStubServer(): WSServer {
	return new WSServer({
		configStore: {},
		projectStore: {},
		providerStore: {},
		skillManager: {},
		extensionManager: {},
		memoryStore: {},
		agentManager: {},
	} as any);
}

const params: AskParams = {
	questions: [
		{
			question: "Q?",
			header: "h",
			options: [
				{ label: "A", description: "x" },
				{ label: "B", description: "y" },
			],
		},
	],
};
const reply = { replies: [{ questionIndex: 0, selected: ["A"] }] };

let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
	askRegistry.reset();
});

async function startServer(): Promise<string> {
	const ws = makeStubServer();
	const router = new HttpRouter();
	// callApi 直达真实 WSServer（session:asks 的组装逻辑就是生产代码本身）
	registerProjectSessionRoutes(router, (e) => ws.callApi(e), {
		projectStore: null as any,
	});
	server = Bun.serve({
		port: 0,
		fetch: async (req) => (await router.handle(req)) ?? new Response("nf", { status: 404 }),
	});
	return `http://127.0.0.1:${server.port}`;
}

test("GET /asks：states 区分 pending / answered（回执在途不算失效）", async () => {
	const base = await startServer();
	try {
		const p = askRegistry.ask("s1", "tc1", params, new AbortController().signal);
		askRegistry.ask("s1", "tc2", params, new AbortController().signal);

		let res = await fetch(`${base}/api/sessions/s1/asks`);
		expect(res.status).toBe(200);
		let body: any = await res.json();
		expect(body.pending.sort()).toEqual(["tc1", "tc2"]);
		expect(
			[...body.states].sort((a: any, b: any) => a.toolCallId.localeCompare(b.toolCallId)),
		).toEqual([
			{ toolCallId: "tc1", state: "pending" },
			{ toolCallId: "tc2", state: "pending" },
		]);

		// 用户答完 tc1：pending 消失，但 states 必须说 answered（前端据此收起卡片）
		askRegistry.resolve("s1", "tc1", reply);
		await p;
		res = await fetch(`${base}/api/sessions/s1/asks`);
		body = await res.json();
		expect(body.pending).toEqual(["tc2"]);
		expect(
			[...body.states].sort((a: any, b: any) => a.toolCallId.localeCompare(b.toolCallId)),
		).toEqual([
			{ toolCallId: "tc1", state: "answered" },
			{ toolCallId: "tc2", state: "pending" },
		]);
	} finally {
		server?.stop();
		server = null;
	}
});

test("GET /asks：重启残留（从未注册）→ states 里查无此问，前端才判失效", async () => {
	const base = await startServer();
	try {
		const res = await fetch(`${base}/api/sessions/s1/asks`);
		const body: any = await res.json();
		expect(body.pending).toEqual([]);
		expect(body.states).toEqual([]);
	} finally {
		server?.stop();
		server = null;
	}
});
