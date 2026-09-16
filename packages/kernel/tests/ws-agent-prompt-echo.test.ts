// agent:prompt 的 session:echo_user 回显抑制测试
//
// pi 官方行为：RPC prompt 收到已注册的扩展命令时直接执行 handler（拦截），
// 不写 transcript、不发 user message 事件。因此 kernel 对这类文本不能
// 回显用户气泡，否则聊天窗会多出一条并不存在的用户消息（如 /uidemo）。
// 未注册 slash / prompt / skill 来源命令会展开为用户消息发给 LLM，仍回显。
import { test, expect } from "bun:test";
import { WSServer } from "../src/ws-server";

interface Harness {
	commands: any[];
	getCommandsCalls: string[];
	promptCalls: any[];
}

function makeServer(h: Harness) {
	const session = {
		id: "s1",
		projectId: "p1",
		primaryAgent: "dev",
		title: "t",
		createdAt: 1,
		lastActivity: 0,
		piSessionFile: "x.jsonl",
	};
	const server = new WSServer({
		projectStore: {
			load: async () => ({ projects: [], sessions: [session] }),
			touchSession: async () => {},
			setSessionAgent: async () => {},
			fillSessionTitleIfEmpty: async () => false,
		},
		configStore: { getAgent: async () => ({ displayName: "dev" }) },
		agentManager: {
			ensureStarted: async () => ({}),
			getCommands: async (sid: string) => {
				h.getCommandsCalls.push(sid);
				return h.commands;
			},
			prompt: async (...args: any[]) => {
				h.promptCalls.push(args);
			},
		},
	} as any);
	(server as any).broadcast = () => {};
	return server;
}

function makeHarness(commands: any[] = []): Harness {
	return { commands, getCommandsCalls: [], promptCalls: [] };
}

const PROMPT = {
	type: "agent:prompt",
	sessionId: "s1",
	projectId: "p1",
	agentName: "dev",
	model: "anthropic/test-model",
} as const;

test("普通文本：立即回显 echo_user，不查命令清单", async () => {
	const h = makeHarness();
	const server = makeServer(h);
	const res = await server.callApi({ ...PROMPT, text: "你好" } as any);
	const body = await res.json();
	expect(body.type).toBe("session:echo_user");
	expect(body.text).toBe("你好");
	expect(h.getCommandsCalls).toHaveLength(0);
	expect(h.promptCalls).toHaveLength(1);
});

test("已注册扩展命令：不回显 echo_user（pi 拦截执行，无用户消息）", async () => {
	const h = makeHarness([
		{ name: "uidemo", source: "extension", packageName: "ext-ui-bridge-demo" },
	]);
	const server = makeServer(h);
	const res = await server.callApi({ ...PROMPT, text: "/uidemo notify" } as any);
	const body = await res.json();
	// echo 被抑制：callApi 无 kept reply 时返回 { ok: true }
	expect(body.type).not.toBe("session:echo_user");
	// 命令仍原样交给 pi 分发
	expect(h.promptCalls).toHaveLength(1);
	expect(h.promptCalls[0][1]).toBe("/uidemo notify");
});

test("未注册 slash 文本：照常回显（会作为普通消息发给 LLM）", async () => {
	const h = makeHarness([
		{ name: "uidemo", source: "extension" },
	]);
	const server = makeServer(h);
	const res = await server.callApi({ ...PROMPT, text: "/not-a-command" } as any);
	const body = await res.json();
	expect(body.type).toBe("session:echo_user");
	expect(body.text).toBe("/not-a-command");
});

test("prompt 来源命令：照常回显（展开为用户消息发给 LLM）", async () => {
	const h = makeHarness([
		{ name: "review", source: "prompt" },
	]);
	const server = makeServer(h);
	const res = await server.callApi({ ...PROMPT, text: "/review src/" } as any);
	const body = await res.json();
	expect(body.type).toBe("session:echo_user");
});

test("命令清单查询失败：兜底回显（宁可多显示，不丢用户消息）", async () => {
	const h = makeHarness();
	const server = makeServer(h);
	(server as any).opts.agentManager.getCommands = async () => {
		throw new Error("进程异常");
	};
	const res = await server.callApi({ ...PROMPT, text: "/uidemo" } as any);
	const body = await res.json();
	expect(body.type).toBe("session:echo_user");
});
