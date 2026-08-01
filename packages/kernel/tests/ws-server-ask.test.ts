import { test, expect, beforeEach } from "bun:test";
import { WSServer } from "../src/ws-server";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@wa-pi/shared";

// agent:answer / agent:cancel-ask case 不依赖 configStore/projectStore 等重依赖，
// 用 stub opts 构造 WsServer 即可走完整 callApi → handle → askRegistry 链路。
function makeStubServer(): WSServer {
	return new WSServer({
		configStore: {},
		projectStore: {},
		providerStore: {},
		skillManager: {},
		extensionManager: {},
		memoryStore: {},
		mcpStore: {},
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

beforeEach(() => askRegistry.reset());

test("agent:answer 命中 → 200 ok，pending ask 被 resolve", async () => {
	const server = makeStubServer();
	const p = askRegistry.ask("s1", "tc1", params, new AbortController().signal);
	const res = await server.callApi({
		type: "agent:answer",
		sessionId: "s1",
		toolCallId: "tc1",
		reply,
	} as any);
	expect(res.status).toBe(200);
	expect((await p).cancelled).toBe(false);
});

test("agent:answer 未命中（stale ask）→ 400 error，告知提问已失效", async () => {
	const server = makeStubServer();
	const res = await server.callApi({
		type: "agent:answer",
		sessionId: "s1",
		toolCallId: "missing",
		reply,
	} as any);
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(String(body.error)).toContain("失效");
});

test("agent:cancel-ask 命中 → 200，pending ask 被取消", async () => {
	const server = makeStubServer();
	const p = askRegistry.ask("s1", "tc1", params, new AbortController().signal);
	const res = await server.callApi({
		type: "agent:cancel-ask",
		sessionId: "s1",
		toolCallId: "tc1",
	} as any);
	expect(res.status).toBe(200);
	expect((await p).cancelled).toBe(true);
});

test("session:asks 返回该 session 真实 pending toolCallId（double check 接口）", async () => {
	const server = makeStubServer();
	// 无 pending → 空数组
	let res = await server.callApi({
		type: "session:asks",
		sessionId: "s1",
	} as any);
	expect(res.status).toBe(200);
	expect((await res.json()).pending).toEqual([]);
	// 有 pending → 返回 toolCallId；resolve 后不再返回
	const p = askRegistry.ask("s1", "tc1", params, new AbortController().signal);
	res = await server.callApi({ type: "session:asks", sessionId: "s1" } as any);
	expect((await res.json()).pending).toEqual(["tc1"]);
	askRegistry.resolve("s1", "tc1", reply);
	await p;
	res = await server.callApi({ type: "session:asks", sessionId: "s1" } as any);
	expect((await res.json()).pending).toEqual([]);
});
