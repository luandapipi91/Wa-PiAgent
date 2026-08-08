/**
 * 扩展命令域路由测试（阶段二·去 WS 化）
 *
 * 覆盖任务 5 新增的两个 API：
 * - GET  /api/extensions/commands            → 命令列表透传（开关状态已由 AgentManager._fetchCommands 合并）
 * - POST /api/extensions/commands/toggle     → 切换命令开关（extension:commands:toggle）
 *
 * 使用真实 HTTP 请求打 WSServer（port 0 随机端口），agentManager / extensionManager
 * 用可配置 spy 桩：list 断言命令与开关状态合并结果，toggle 断言 setCommandToggle 调用参数，
 * 非法参数断言 400。
 */
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { WSServer } from "../src/ws-server";
import { extUiRegistry } from "../src/ext-ui-registry";

// 可配置 spy 桩：每个测试通过 mockImplementation 覆盖行为
const getCommandsSpy = mock(async (): Promise<any[]> => []);
const getCommandTogglesSpy = mock(async () => ({}));
const setCommandToggleSpy = mock(async () => {});

/** 最小 agentManager 桩：仅满足 WSServer 构造与 list/toggle 两条链路 */
function makeAgentManager() {
	return {
		getCommands: getCommandsSpy,
		disposeAll: async () => {},
		onEvent: () => {},
	};
}

/** 最小 extensionManager 桩：仅满足命令 list/toggle 链路 */
function makeExtensionManager() {
	return {
		getCommandToggles: getCommandTogglesSpy,
		setCommandToggle: setCommandToggleSpy,
	};
}

/** 最小 projectStore 桩：仅满足 WSServer 构造 */
function makeProjectStore() {
	return { load: async () => ({ projects: [], sessions: [] }) };
}

let server: WSServer;
let base: string;

beforeAll(async () => {
	server = new WSServer({
		agentManager: makeAgentManager() as any,
		extensionManager: makeExtensionManager() as any,
		projectStore: makeProjectStore() as any,
		// 本测试不涉及的 store/manager：空桩满足 WSServerOpts 结构
		configStore: {} as any,
		providerStore: {} as any,
		skillManager: {} as any,
		memoryStore: {} as any,
		mcpStore: {} as any,
		channelManager: null,
		port: 0, // 随机端口
	});
	await server.start();
	base = `http://localhost:${server.actualPort}`;
});

afterAll(async () => {
	server?.stop();
});

test("GET /api/extensions/commands 返回 { commands: [] } 结构（无命令时）", async () => {
	getCommandsSpy.mockImplementation(async () => []);
	getCommandTogglesSpy.mockImplementation(async () => ({}));

	const res = await fetch(`${base}/api/extensions/commands`);
	expect(res.status).toBe(200);
	const body = await res.json();
	// 结构断言：HTTP 响应体即 handler 的最后一个 reply
	expect(body.type).toBe("extension:commands:list");
	expect(Array.isArray(body.commands)).toBe(true);
	expect(body.commands).toEqual([]);
	// list 链路确实借用了 agentManager.getCommands（空 sessionId 借用活跃进程）
	expect(getCommandsSpy).toHaveBeenCalledWith("");
});

test("GET /api/extensions/commands 透传 agentManager 已合并的开关状态（enabled 由 kernel 填充）", async () => {
	// 合并逻辑已下沉到 AgentManager._fetchCommands（对齐 session:commands 路径）：
	// 这里模拟 getCommands 已返回带 enabled 的命令，ws-server 应原样透传、不再二次合并。
	getCommandsSpy.mockImplementation(async () => [
		{
			name: "goal",
			description: "设定目标",
			source: "extension",
			packageName: "pkg-a",
			enabled: true,
		},
		{
			name: "hello",
			source: "extension",
			packageName: "pkg-b",
			enabled: false,
		},
		{ name: "review", description: "代码审查模板", source: "prompt" },
	]);

	const res = await fetch(`${base}/api/extensions/commands`);
	expect(res.status).toBe(200);
	const body = await res.json();

	// 原样透传（含 enabled），无任何二次改写
	expect(body.commands).toEqual([
		{
			name: "goal",
			description: "设定目标",
			source: "extension",
			packageName: "pkg-a",
			enabled: true,
		},
		{
			name: "hello",
			source: "extension",
			packageName: "pkg-b",
			enabled: false,
		},
		{ name: "review", description: "代码审查模板", source: "prompt" },
	]);
});

test("POST /api/extensions/commands/toggle 成功 → 调 setCommandToggle", async () => {
	setCommandToggleSpy.mockClear();

	const res = await fetch(`${base}/api/extensions/commands/toggle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			packageName: "pkg-a",
			command: "goal",
			enabled: false,
		}),
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		type: "extension:commands:toggle",
		ok: true,
	});
	// 正确透传 packageName/command/enabled 到 ExtensionManager
	expect(setCommandToggleSpy).toHaveBeenCalledWith("pkg-a", "goal", false);
});

test("POST /api/extensions/commands/toggle 缺 packageName → 400", async () => {
	setCommandToggleSpy.mockClear();
	const res = await fetch(`${base}/api/extensions/commands/toggle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ command: "goal", enabled: true }),
	});
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(body.error).toBe("参数缺失或类型错误");
	expect(setCommandToggleSpy).not.toHaveBeenCalled();
});

test("POST /api/extensions/commands/toggle 缺 command → 400", async () => {
	setCommandToggleSpy.mockClear();
	const res = await fetch(`${base}/api/extensions/commands/toggle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ packageName: "pkg-a", enabled: true }),
	});
	expect(res.status).toBe(400);
	expect((await res.json()).error).toBe("参数缺失或类型错误");
});

test("POST /api/extensions/commands/toggle enabled 非 boolean → 400", async () => {
	setCommandToggleSpy.mockClear();
	const res = await fetch(`${base}/api/extensions/commands/toggle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			packageName: "pkg-a",
			command: "goal",
			enabled: "yes",
		}),
	});
	expect(res.status).toBe(400);
	expect((await res.json()).error).toBe("参数缺失或类型错误");
	expect(setCommandToggleSpy).not.toHaveBeenCalled();
});

test("POST toggle 成功 → 广播 extension:commands:changed（前端 / 菜单刷新）", async () => {
	setCommandToggleSpy.mockClear();

	// 连接 SSE 事件总线（首读触发 bus.add，确保广播能送达本连接）
	const res = await fetch(`${base}/api/events`);
	const reader = res.body!.getReader();
	await reader.read(); // 消费首帧（": connected"）

	const toggleRes = await fetch(`${base}/api/extensions/commands/toggle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			packageName: "pkg-a",
			command: "goal",
			enabled: false,
		}),
	});
	expect(toggleRes.status).toBe(200);

	// 断言广播帧：type 为 extension:commands:changed
	const frame = await readSseFrameWithTimeout(reader);
	expect(frame.type).toBe("extension:commands:changed");
	reader.releaseLock();
});

test("POST /api/extensions/dialog/respond 缺 requestId → 400", async () => {
	const res = await fetch(`${base}/api/extensions/dialog/respond`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ confirmed: true }),
	});
	expect(res.status).toBe(400);
	expect((await res.json()).error).toBe("参数缺失");
});

test("POST /api/extensions/dialog/respond 未知/已应答 id → 400「对话不存在或已应答」", async () => {
	const res = await fetch(`${base}/api/extensions/dialog/respond`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "dlg-nope", cancelled: true }),
	});
	expect(res.status).toBe(400);
	expect((await res.json()).error).toBe("对话不存在或已应答");
});

test("POST /api/extensions/dialog/respond 正常 body → 解决 registry pending 对话", async () => {
	// 真实注册表：先挂起一个 pending 对话，POST 应答后 promise 应以业务字段解决
	const pending = extUiRegistry.register("s1", {
		type: "extension_ui_request",
		id: "dlg-1",
		method: "confirm",
	});

	const res = await fetch(`${base}/api/extensions/dialog/respond`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "dlg-1", confirmed: true }),
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		type: "extension:dialog:respond",
		ok: true,
	});
	// toEqual 忽略 undefined 属性：ws case 透传的 value/cancelled 缺省不影响断言
	await expect(pending).resolves.toEqual({ confirmed: true });
});

// ─── SSE 帧读取辅助（与 ws-extension-skill-refresh.test.ts 同模式）─────────────────
async function readSseFrameWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs = 3000,
): Promise<Record<string, unknown>> {
	const dec = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = Math.max(0, deadline - Date.now());
		const { value, done } = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value?: undefined }>((r) =>
				setTimeout(() => r({ done: true, value: undefined }), remaining),
			),
		]);
		if (done)
			throw new Error("SSE 流超时/关闭，未收到 extension:commands:changed");
		buffer += dec.decode(value, { stream: true });
		let idx: number;
		while ((idx = buffer.indexOf("\n\n")) !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (raw.trim().startsWith(":")) continue; // 心跳/注释帧
			const line = raw.split("\n").find((l) => l.startsWith("data:"));
			if (!line) continue;
			return JSON.parse(line.slice(5).trim());
		}
	}
}
