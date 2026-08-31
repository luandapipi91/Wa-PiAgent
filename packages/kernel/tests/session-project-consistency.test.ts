// agent:prompt 会话归属一致性：
// - 占位会话（getCommands 预热创建，无真实消息）projectId 与请求不一致 → 以请求为准纠正归属
//   （占位无内容，纠正无损失；否则会话记录归属与实际工作目录错位——顶栏显示 A 项目、进程跑 B 目录）
// - 真实会话 projectId 与请求不一致 → 拒绝（防静默移动用户历史会话）
import { test, expect } from "bun:test";
import { WSServer } from "../src/ws-server";

function makeServer(opts: {
	sessions: any[];
	replies: any[];
	setSessionProjectIdCalls: string[][];
	ensureStartedCalls: string[][];
}) {
	const server = new WSServer({
		projectStore: {
			load: async () => ({ projects: [], sessions: opts.sessions }),
			touchSession: async () => {},
			setSessionAgent: async () => {},
			fillSessionTitleIfEmpty: async () => false,
			setSessionProjectId: async (id: string, projectId: string) => {
				opts.setSessionProjectIdCalls.push([id, projectId]);
			},
		},
		configStore: { getAgent: async () => ({ displayName: "dev" }) },
		agentManager: {
			ensureStarted: async (projectId: string, agentName: string, sessionId: string) => {
				opts.ensureStartedCalls.push([projectId, agentName, sessionId]);
			},
			getCommands: async () => [],
			prompt: async () => {},
		},
	} as any);
	(server as any).broadcast = () => {};
	return server;
}

function baseSession(over: Record<string, unknown> = {}): any {
	return {
		id: "s1",
		projectId: "p_hlk",
		primaryAgent: "dev",
		title: "t",
		createdAt: 1,
		lastActivity: 0,
		piSessionFile: "x.jsonl",
		...over,
	};
}

const PROMPT = {
	type: "agent:prompt",
	sessionId: "s1",
	// 请求项目与 existing 不一致（existing 归 p_hlk，请求 p_hia = HiAgent）
	projectId: "p_hia",
	agentName: "dev",
	model: "anthropic/test-model",
	text: "你好",
} as const;

test("占位会话 projectId 不一致 → 纠正归属到请求项目，正常继续", async () => {
	const calls = { setSessionProjectIdCalls: [] as string[][], ensureStartedCalls: [] as string[][], replies: [] as any[] };
	const server = makeServer({
		sessions: [baseSession({ placeholder: true, title: "" })],
		replies: calls.replies,
		setSessionProjectIdCalls: calls.setSessionProjectIdCalls,
		ensureStartedCalls: calls.ensureStartedCalls,
	});
	const res = await server.callApi({ ...PROMPT } as any);
	const body = await res.json();
	// 不拒绝（占位无内容，纠正无损失）
	expect(body.type).not.toBe("error");
	expect(calls.setSessionProjectIdCalls).toEqual([["s1", "p_hia"]]);
	// 进程按请求项目启动（与纠正后的归属一致）
	expect(calls.ensureStartedCalls[0]?.[0]).toBe("p_hia");
});

test("真实会话 projectId 不一致 → 拒绝，不改归属、不启动进程", async () => {
	const calls = { setSessionProjectIdCalls: [] as string[][], ensureStartedCalls: [] as string[][], replies: [] as any[] };
	const server = makeServer({
		sessions: [baseSession()],
		replies: calls.replies,
		setSessionProjectIdCalls: calls.setSessionProjectIdCalls,
		ensureStartedCalls: calls.ensureStartedCalls,
	});
	const res = await server.callApi({ ...PROMPT } as any);
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(body.error).toContain("属于其他项目");
	expect(calls.setSessionProjectIdCalls).toHaveLength(0);
	expect(calls.ensureStartedCalls).toHaveLength(0);
});

test("projectId 一致 → 不受影响，正常回显", async () => {
	const calls = { setSessionProjectIdCalls: [] as string[][], ensureStartedCalls: [] as string[][], replies: [] as any[] };
	const server = makeServer({
		sessions: [baseSession({ projectId: "p_hia" })],
		replies: calls.replies,
		setSessionProjectIdCalls: calls.setSessionProjectIdCalls,
		ensureStartedCalls: calls.ensureStartedCalls,
	});
	const res = await server.callApi({ ...PROMPT } as any);
	const body = await res.json();
	expect(body.type).toBe("session:echo_user");
	expect(calls.setSessionProjectIdCalls).toHaveLength(0);
	expect(calls.ensureStartedCalls[0]?.[0]).toBe("p_hia");
});
