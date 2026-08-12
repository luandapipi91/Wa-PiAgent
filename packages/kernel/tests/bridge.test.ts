// bridge 扩展层测试：
// - ensureBridgeExtension 生成文件 + 幂等覆盖
// - 契约：生成的扩展与现有实现（ask-tool / amaster-memory / delegate-tool）的
//   name/description/schema 完全一致（agent 可见契约不变）
// - 真实 pi --mode rpc 加载扩展不崩（get_state / get_commands）
// - handleBridgeRequest：token / session 校验与结果透传
// - makeDefaultBridgeContext：ask 复用逻辑、memory 回路、delegate/fleet 桩
// - ws-server /bridge/tool 路由 + 扩展 execute 经真实 HTTP 的全链路
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	rmSync,
	mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ensureBridgeExtension,
	generateBridgeExtension,
	BRIDGE_EXTENSION_PATH,
} from "../src/bridge-extension";
import {
	registerBridgeSession,
	unregisterBridgeSession,
	getBridgeToken,
	handleBridgeRequest,
	handleBridgeStream,
	makeDefaultBridgeContext,
	type BridgeSessionContext,
} from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { makeAskTool } from "../src/ask-tool";
import {
	createAgentMemoryTools,
	getGlobalMemoryStore,
	getProjectMemoryStore,
} from "../src/amaster-memory";
import { makeDelegateTool, makeFleetTool } from "../src/delegate-tool";
import { WSServer, type WSServerOpts } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { RpcClient, buildPiArgs, resolvePiCliPath } from "../src/rpc-client";
import type { AskParams, SubagentProgressEvent } from "@wa-pi/shared";

const SEVEN_TOOLS = [
	"ask_user_question",
	"memory_add",
	"memory_replace",
	"memory_remove",
	"memory_read",
	"delegate",
	"fleet",
];

const validAskParams: AskParams = {
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

let tmpDir: string;
const tmpFiles: string[] = [];
const clients: RpcClient[] = [];

beforeEach(() => {
	askRegistry.reset();
	tmpDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
});

afterEach(async () => {
	unregisterBridgeSession("s1");
	unregisterBridgeSession("s-bridge");
	rmSync(tmpDir, { recursive: true, force: true });
	for (const f of tmpFiles.splice(0)) rmSync(f, { force: true });
	for (const c of clients.splice(0)) await c.dispose().catch(() => {});
	delete process.env.WA_PI_BRIDGE_URL;
	delete process.env.WA_PI_BRIDGE_TOKEN;
	delete process.env.WA_PI_SESSION_ID;
});

// 生成的扩展文件是 kernel 启动产物（startKernel 会幂等重写），测完删除不污染环境
afterAll(() => {
	rmSync(BRIDGE_EXTENSION_PATH, { force: true });
	rmSync(join(BRIDGE_EXTENSION_PATH, "..", "tool-schemas.ts"), { force: true });
});

/** 把 bridge 扩展源码 + tool-schemas 依赖写到 tests 内的临时目录并动态 import，
 *  返回捕获到的 7 个 registerTool 定义。 */
async function loadBridgeTools(env?: Record<string, string>) {
	for (const [k, v] of Object.entries(env ?? {})) process.env[k] = v;
	const file = join(
		import.meta.dir,
		`.tmp-bridge-${Math.random().toString(36).slice(2)}.ts`,
	);
	// 静态 bridge 扩展 import "./tool-schemas.ts"，需把 tool-schemas 复制到同目录
	const schemasFile = join(import.meta.dir, "tool-schemas.ts");
	const schemasSrc = join(
		import.meta.dir,
		"..",
		"..",
		"shared",
		"src",
		"tool-schemas.ts",
	);
	const { copyFileSync } = await import("node:fs");
	copyFileSync(schemasSrc, schemasFile);
	tmpFiles.push(schemasFile);
	writeFileSync(file, generateBridgeExtension(), "utf8");
	tmpFiles.push(file);
	const mod = await import(pathToFileURL(file).href);
	const tools: any[] = [];
	mod.default({
		registerTool: (def: any) => tools.push(def),
		// bridge 扩展注册的内部命令（__!wa_pi_reload 热重载）——测试桩不收集命令
		registerCommand: () => {},
		on: () => {},
	});
	return tools;
}

function makeMemoryStores() {
	return {
		global: getGlobalMemoryStore(tmpDir),
		project: getProjectMemoryStore(tmpDir, join(tmpDir, "repos", "my-app")),
	};
}

// ---- ensureBridgeExtension ----

test("ensureBridgeExtension 生成文件存在且包含 7 个工具名，幂等覆盖", async () => {
	const p1 = await ensureBridgeExtension();
	expect(p1).toBe(BRIDGE_EXTENSION_PATH);
	expect(existsSync(p1)).toBe(true);
	const code = readFileSync(p1, "utf8");
	for (const name of SEVEN_TOOLS) {
		expect(code).toContain(`name: "${name}"`);
	}
	// 幂等：再次调用覆盖写，不报错、内容一致
	const p2 = await ensureBridgeExtension();
	expect(p2).toBe(p1);
	expect(readFileSync(p2, "utf8")).toBe(code);
});

// ---- 契约：生成的扩展与现有实现完全一致 ----

test("契约：扩展工具的 name/description/schema 与现有实现一致", async () => {
	const bridgeTools = await loadBridgeTools();
	expect(bridgeTools.map((t) => t.name).sort()).toEqual(
		[...SEVEN_TOOLS].sort(),
	);

	// ask：name/label/description/promptGuidelines/parameters 全等
	const askReal = makeAskTool("s1") as any;
	const askBridge = bridgeTools.find((t) => t.name === "ask_user_question");
	expect(askBridge.label).toBe(askReal.label);
	expect(askBridge.description).toBe(askReal.description);
	expect(askBridge.promptGuidelines).toEqual(askReal.promptGuidelines);
	expect(JSON.parse(JSON.stringify(askBridge.parameters))).toEqual(
		JSON.parse(JSON.stringify(askReal.parameters)),
	);

	// memory_*：4 个工具逐一比对（含 promptSnippet）
	const stores = makeMemoryStores();
	const memReal = createAgentMemoryTools(
		stores.global,
		stores.project,
	) as any[];
	for (const real of memReal) {
		const bridge = bridgeTools.find((t) => t.name === real.name);
		expect(bridge, `缺少 ${real.name}`).toBeTruthy();
		expect(bridge.label).toBe(real.label);
		expect(bridge.description).toBe(real.description);
		expect(bridge.promptSnippet).toBe(real.promptSnippet);
		expect(JSON.parse(JSON.stringify(bridge.parameters))).toEqual(
			JSON.parse(JSON.stringify(real.parameters)),
		);
	}

	// delegate / fleet
	const spawn = async () => ({ text: "", isError: false });
	const delegateReal = makeDelegateTool({ askTo: [], spawn });
	const delegateBridge = bridgeTools.find((t) => t.name === "delegate");
	expect(delegateBridge.label).toBe(delegateReal.label);
	expect(delegateBridge.description).toBe(delegateReal.description);
	expect(JSON.parse(JSON.stringify(delegateBridge.parameters))).toEqual(
		JSON.parse(JSON.stringify(delegateReal.parameters)),
	);

	const fleetReal = makeFleetTool({ askTo: [], spawn });
	const fleetBridge = bridgeTools.find((t) => t.name === "fleet");
	expect(fleetBridge.label).toBe(fleetReal.label);
	expect(fleetBridge.description).toBe(fleetReal.description);
	expect(JSON.parse(JSON.stringify(fleetBridge.parameters))).toEqual(
		JSON.parse(JSON.stringify(fleetReal.parameters)),
	);
});

// ---- 真实 pi 加载 ----

test("真实 pi --mode rpc 加载 bridge 扩展不崩（get_state / get_commands）", async () => {
	const extPath = await ensureBridgeExtension();
	const client = new RpcClient({
		cliPath: resolvePiCliPath(),
		runtime: process.execPath,
		args: buildPiArgs({
			noSession: true,
			offline: true,
			extensionPaths: [extPath],
		}),
		cwd: import.meta.dir,
		env: {
			PI_CODING_AGENT_DIR: join(
				import.meta.dir,
				"fixtures",
				"pi-agent-dir-test",
			),
		},
		onEvent: () => {},
	});
	clients.push(client);
	await client.start();
	const state = await client.getState();
	expect(typeof state.sessionId).toBe("string");
	// 扩展加载失败会让进程出错或命令失败；能拿到 commands 即说明注册没把进程弄崩
	const data = await client.command({ type: "get_commands" });
	expect(Array.isArray(data?.commands)).toBe(true);
}, 30_000);

// ---- handleBridgeRequest ----

test("handleBridgeRequest：token 错误 → 401 invalid_token", async () => {
	const r = await handleBridgeRequest({
		token: "wrong",
		sessionId: "s1",
		toolCallId: "tc1",
		tool: "delegate",
		params: {},
	});
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe(401);
		expect(r.error).toBe("invalid_token");
	}
});

test("handleBridgeRequest：非法 body / 缺字段 → 400", async () => {
	const r1 = await handleBridgeRequest(null);
	expect(r1.ok).toBe(false);
	if (!r1.ok) expect(r1.status).toBe(400);
	const r2 = await handleBridgeRequest({ token: getBridgeToken() });
	expect(r2.ok).toBe(false);
	if (!r2.ok) expect(r2.status).toBe(400);
});

test("handleBridgeRequest：sessionId 未注册 → 404 unknown_session", async () => {
	const r = await handleBridgeRequest({
		token: getBridgeToken(),
		sessionId: "nobody",
		toolCallId: "tc1",
		tool: "delegate",
		params: {},
	});
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe(404);
		expect(r.error).toBe("unknown_session");
	}
});

test("handleBridgeRequest：已注册 → 调用 ctx.handleTool 并透传结果", async () => {
	const seen: Array<{ tool: string; toolCallId: string; params: unknown }> = [];
	const ctx: BridgeSessionContext = {
		cwd: "/tmp",
		async handleTool(tool, toolCallId, params) {
			seen.push({ tool, toolCallId, params });
			return {
				content: [{ type: "text", text: "宿主结果" }],
				details: { ok: 1 },
			};
		},
	};
	registerBridgeSession("s1", ctx);
	const r = await handleBridgeRequest({
		token: getBridgeToken(),
		sessionId: "s1",
		toolCallId: "tc9",
		tool: "memory_read",
		params: { target: "memory" },
	});
	expect(r.ok).toBe(true);
	if (r.ok) {
		expect(r.result.content[0].text).toBe("宿主结果");
		expect((r.result.details as any).ok).toBe(1);
	}
	expect(seen).toEqual([
		{ tool: "memory_read", toolCallId: "tc9", params: { target: "memory" } },
	]);
});

// ---- makeDefaultBridgeContext：ask 复用逻辑 ----

test("default ctx：ask 校验失败 → details.error，不阻塞", async () => {
	const ctx = makeDefaultBridgeContext({
		sessionId: "s1",
		cwd: tmpDir,
		memoryStores: makeMemoryStores(),
	});
	const out = await ctx.handleTool(
		"ask_user_question",
		"tc1",
		{ questions: [] },
		new AbortController().signal,
	);
	expect((out.details as any).error).toBe("no_questions");
	expect((out.details as any).cancelled).toBe(false);
});

test("default ctx：ask cancel → details.cancelled=true", async () => {
	const ctx = makeDefaultBridgeContext({
		sessionId: "s1",
		cwd: tmpDir,
		memoryStores: makeMemoryStores(),
	});
	const p = ctx.handleTool(
		"ask_user_question",
		"tc1",
		validAskParams,
		new AbortController().signal,
	);
	askRegistry.cancel("s1", "tc1");
	const out = await p;
	expect((out.details as any).cancelled).toBe(true);
	expect(out.content[0].text).toBe("用户取消了提问");
});

test("default ctx：ask 正常 answers 文本拼接", async () => {
	const ctx = makeDefaultBridgeContext({
		sessionId: "s1",
		cwd: tmpDir,
		memoryStores: makeMemoryStores(),
	});
	const p = ctx.handleTool(
		"ask_user_question",
		"tc1",
		validAskParams,
		new AbortController().signal,
	);
	askRegistry.resolve("s1", "tc1", {
		replies: [{ questionIndex: 0, selected: ["A"] }],
	});
	const out = await p;
	expect((out.details as any).cancelled).toBe(false);
	expect((out.details as any).answers[0]).toMatchObject({
		kind: "option",
		answer: "A",
	});
	expect(out.content[0].text).toBe("Q: Q?\nA: A");
});

// ---- makeDefaultBridgeContext：memory 回路 / delegate 桩 ----

test("default ctx：memory_add 后 memory_read 能读回", async () => {
	const ctx = makeDefaultBridgeContext({
		sessionId: "s1",
		cwd: tmpDir,
		memoryStores: makeMemoryStores(),
	});
	const signal = new AbortController().signal;
	await ctx.handleTool(
		"memory_add",
		"tc1",
		{ target: "memory", content: "bridge 记忆条目" },
		signal,
	);
	const out = await ctx.handleTool(
		"memory_read",
		"tc2",
		{ target: "memory" },
		signal,
	);
	expect(out.content[0].text).toContain("bridge 记忆条目");
});

test("default ctx：delegate/fleet 返回 not_wired 桩", async () => {
	const ctx = makeDefaultBridgeContext({
		sessionId: "s1",
		cwd: tmpDir,
		memoryStores: makeMemoryStores(),
	});
	const signal = new AbortController().signal;
	for (const tool of ["delegate", "fleet"]) {
		const out = await ctx.handleTool(tool, "tc1", {}, signal);
		expect((out.details as any).error).toBe("not_wired");
		expect(out.content[0].text).toContain("尚未接入 bridge");
	}
});

// ---- ws-server /bridge/tool 路由 ----

/** 起最小 WSServer（mock agentManager），返回端口与停止函数。
 *  所有 store 路径落在 tmpDir 内，afterEach 统一清理，不在 tests/ 下留残留。
 *  extraOpts 用于注入测试钩子（如 onBridgeStreamCancel）。 */
async function startTestServer(extraOpts: Partial<WSServerOpts> = {}) {
	const rand = () =>
		join(tmpDir, "ws-bridge-" + Math.random().toString(36).slice(2));
	const dataDir = rand();
	const server = new WSServer({
		configStore: new ConfigStore(rand()),
		projectStore: new ProjectStore(rand() + ".json"),
		providerStore: new ProviderStore(rand() + ".json"),
		skillManager: new SkillManager(rand()),
		extensionManager: new ExtensionManager(dataDir),
		memoryStore: null as any,
		mcpStore: null as any,
		dataDir,
		agentManager: { disposeAll: async () => {} } as any,
		channelManager: null,
		port: 0,
		...extraOpts,
	});
	await server.start();
	return { server, port: server.actualPort };
}

test("/bridge/tool 路由：401 / 404 / 200", async () => {
	const { server, port } = await startTestServer();
	try {
		const post = (body: unknown) =>
			fetch(`http://127.0.0.1:${port}/bridge/tool`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		// 读取 NDJSON 响应体并返回解析后的帧数组（delegate/fleet 现在走流式 NDJSON）
		const readNdjson = async (res: Response) => {
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/x-ndjson");
			const text = await res.text();
			return text
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l));
		};

		// token 错误 → HTTP 200 + NDJSON 单帧 final ok=false error=invalid_token
		// （流式分支把校验错误合成成 final 帧，HTTP 恒 200，不再走旧 401 JSON）
		const r401 = await post({
			token: "wrong",
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "delegate",
			params: {},
		});
		const frames401 = await readNdjson(r401);
		expect(frames401).toHaveLength(1);
		expect(frames401[0]).toMatchObject({
			type: "final",
			tool: "delegate",
			ok: false,
			error: "invalid_token",
		});

		// session 未注册 → HTTP 200 + NDJSON final ok=false error=unknown_session
		const r404 = await post({
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "delegate",
			params: {},
		});
		const frames404 = await readNdjson(r404);
		expect(frames404).toHaveLength(1);
		expect(frames404[0]).toMatchObject({
			type: "final",
			tool: "delegate",
			ok: false,
			error: "unknown_session",
		});

		// 注册后 → 200 + NDJSON started→final，final.result 透传 { content, details }
		registerBridgeSession("s1", {
			cwd: "/tmp",
			async handleTool() {
				return {
					content: [{ type: "text", text: "路由结果" }],
					details: { via: "http" },
				};
			},
		});
		const r200 = await post({
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "delegate",
			params: {},
		});
		const frames200 = await readNdjson(r200);
		expect(frames200.map((f) => f.type)).toEqual(["started", "final"]);
		expect(frames200[0]).toMatchObject({
			type: "started",
			protocol: 1,
			tool: "delegate",
			toolCallId: "tc1",
		});
		expect(frames200[1]).toMatchObject({
			type: "final",
			tool: "delegate",
			toolCallId: "tc1",
			ok: true,
		});
		expect(frames200[1].result.content[0].text).toBe("路由结果");
		expect(frames200[1].result.details.via).toBe("http");
	} finally {
		await server.stop();
	}
});

test("/bridge/tool 流式分支：消费方中断（停止消息）后继续 progress/final 不抛 unhandledRejection", async () => {
	// 复现线上崩溃：用户停止消息 → pi 侧 abort fetch → Bun cancel 服务端 ReadableStream
	// → 子代理仍产出 progress → enqueue 已关闭的 controller → "Controller is already closed"
	let fireStreamCancel!: () => void;
	const streamCancelled = new Promise<void>((r) => (fireStreamCancel = r));
	const { server, port } = await startTestServer({
		onBridgeStreamCancel: fireStreamCancel,
	});
	const rejections: unknown[] = [];
	const onRej = (r: unknown) => rejections.push(r);
	process.on("unhandledRejection", onRej);
	try {
		let progressFn: ((e: SubagentProgressEvent) => void) | undefined;
		let finish!: (r: unknown) => void;
		const finished = new Promise((res) => (finish = res));
		registerBridgeSession("s-abort", {
			cwd: "/tmp",
			handleTool(_tool, _tcId, _params, _signal, onProgress) {
				progressFn = onProgress;
				return finished as Promise<never>;
			},
		});
		const ac = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/bridge/tool`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: ac.signal,
			body: JSON.stringify({
				token: getBridgeToken(),
				sessionId: "s-abort",
				toolCallId: "tc-abort",
				tool: "delegate",
				params: {},
			}),
		});
		expect(res.status).toBe(200);
		// 模拟「停止消息」：abort fetch 销毁 socket（与 pi 侧 abort 行为一致）
		ac.abort();
		// 确定性等待服务端感知断连（ReadableStream cancel 钩子），替代固定 sleep 猜测。
		// 若 Bun 未触发 cancel 会在测试超时上显性失败，而非静默跳过真正的断连后路径。
		await streamCancelled;
		// 断连后子代理仍在跑：继续产出进度帧（真实 SubagentProgressEvent 载荷）、最终完成。
		// 在异步上下文里触发，模拟真实场景（子代理 stdout 回调链），同步 throw 会变成 rejection。
		for (let i = 0; i < 5; i++) {
			void Promise.resolve().then(() =>
				progressFn?.({
					agent: "a",
					status: "running",
					output: `p${i}`,
					tools: [],
					elapsedMs: i * 100,
				}),
			);
		}
		finish({ content: [{ type: "text", text: "done" }] });
		// 负断言需要一个安静窗口让潜在 rejection 冒泡（微任务 + 一轮定时器足够）
		await new Promise((r) => setTimeout(r, 100));
		expect(rejections).toEqual([]);
	} finally {
		process.off("unhandledRejection", onRej);
		unregisterBridgeSession("s-abort");
		await server.stop();
	}
});

// ---- 扩展 execute 经真实 HTTP 的全链路 ----

test("扩展 execute：缺 env 报 missing_env；配好 env 后经 ws-server 全链路执行", async () => {
	// 缺 env：明确错误文本，不抛出
	const noEnvTools = await loadBridgeTools();
	const miss = await noEnvTools
		.find((t: any) => t.name === "delegate")
		.execute("tc1", { agent: "a", task: "b" }, undefined);
	expect(miss.details.error).toBe("missing_env");
	expect(miss.content[0].text).toContain("只在 wa-pi 宿主下可用");

	// 配好 env：ask 走完整 HTTP 链路（扩展 → ws-server → registry → askRegistry）
	const { server, port } = await startTestServer();
	try {
		const ctx = makeDefaultBridgeContext({
			sessionId: "s-bridge",
			cwd: tmpDir,
			memoryStores: makeMemoryStores(),
		});
		registerBridgeSession("s-bridge", ctx);
		const tools = await loadBridgeTools({
			WA_PI_BRIDGE_URL: `http://127.0.0.1:${port}`,
			WA_PI_BRIDGE_TOKEN: getBridgeToken(),
			WA_PI_SESSION_ID: "s-bridge",
		});

		// ask：阻塞等回答，resolve 后文本经 HTTP 回传到 pi 侧
		const askTool = tools.find((t: any) => t.name === "ask_user_question");
		const p = askTool.execute("tc-http", validAskParams, undefined);
		// 等请求到达 kernel 并挂上 pending 再回答
		await new Promise((r) => setTimeout(r, 300));
		askRegistry.resolve("s-bridge", "tc-http", {
			replies: [{ questionIndex: 0, selected: ["B"] }],
		});
		const askOut = await p;
		expect(askOut.details.cancelled).toBe(false);
		expect(askOut.content[0].text).toBe("Q: Q?\nA: B");

		// delegate 桩：Task 6 起 /bridge/tool 对 delegate 返回 NDJSON 流，
		// Task 7 起扩展 callBridge 逐帧解析 NDJSON，final 帧组装结果。
		// s-bridge 下 delegate 桩返回 not_wired，经 NDJSON final 帧（ok=true）透传回扩展。
		const delegateTool = tools.find((t: any) => t.name === "delegate");
		const stub = await delegateTool.execute(
			"tc2",
			{ agent: "a", task: "b" },
			undefined,
		);
		expect(stub.details.error).toBe("not_wired");
		expect(stub.content[0].text).toContain("尚未接入 bridge");
	} finally {
		await server.stop();
	}
});

// ---- handleBridgeStream：流式分支 ----

test("handleBridgeStream 对 delegate 输出 started→progress→final NDJSON 序列", async () => {
	const token = getBridgeToken();
	const sessionId = "stream-test-sid";
	const toolCallId = "tc-stream-001";
	const frames: string[] = [];
	registerBridgeSession(sessionId, {
		cwd: "/tmp",
		async handleTool(tool, tcId, _params, _signal, onProgress) {
			// 模拟子代理产生一次进度后完成
			onProgress?.({
				agent: "general-purpose",
				status: "running",
				output: "working",
				tools: [],
				elapsedMs: 10,
			});
			return { content: [{ type: "text", text: "子代理完成" }] };
		},
	});
	try {
		await handleBridgeStream(
			{
				token,
				sessionId,
				toolCallId,
				tool: "delegate",
				params: { agent: "general-purpose", task: "hi" },
			},
			(frame) => frames.push(frame),
		);
	} finally {
		unregisterBridgeSession(sessionId);
	}
	// 解析帧
	const parsed = frames.map((f) => JSON.parse(f));
	expect(parsed.map((f) => f.type)).toEqual(["started", "progress", "final"]);
	expect(parsed[0]).toMatchObject({
		type: "started",
		protocol: 1,
		tool: "delegate",
		toolCallId,
	});
	expect(parsed[1]).toMatchObject({
		type: "progress",
		tool: "delegate",
		toolCallId,
	});
	expect(parsed[1].progress).toMatchObject({
		agent: "general-purpose",
		output: "working",
	});
	expect(parsed[2]).toMatchObject({
		type: "final",
		tool: "delegate",
		toolCallId,
		ok: true,
	});
	expect(parsed[2].result.content[0].text).toBe("子代理完成");
});

test("handleBridgeStream 对 memory_add 返回 null（非流式工具走旧路径）", async () => {
	const token = getBridgeToken();
	const sessionId = "stream-test-sid2";
	registerBridgeSession(sessionId, {
		cwd: "/tmp",
		async handleTool() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
	try {
		const ret = await handleBridgeStream(
			{ token, sessionId, toolCallId: "tc", tool: "memory_add", params: {} },
			() => {},
		);
		// 非流式工具返回结构化结果（不走帧），由调用方走旧 JSON 路径
		expect(ret).not.toBeNull();
		expect((ret as any).ok).toBe(true);
	} finally {
		unregisterBridgeSession(sessionId);
	}
});

test("handleBridgeStream 静默期间周期性输出 ping 心跳帧（子代理长时间无 progress 时保活）", async () => {
	const token = getBridgeToken();
	const sessionId = "stream-test-heartbeat";
	const toolCallId = "tc-heartbeat";
	const frames: string[] = [];
	registerBridgeSession(sessionId, {
		cwd: "/tmp",
		async handleTool() {
			// 模拟子代理长时间静默（长推理/慢首 token/单个长工具调用）：250ms 无任何 progress
			await new Promise((r) => setTimeout(r, 250));
			return { content: [{ type: "text", text: "done" }] };
		},
	});
	try {
		await handleBridgeStream(
			{
				token,
				sessionId,
				toolCallId,
				tool: "delegate",
				params: { agent: "a", task: "b" },
			},
			(frame) => frames.push(frame),
			{ heartbeatMs: 50 },
		);
	} finally {
		unregisterBridgeSession(sessionId);
	}
	const types = frames.map((f) => JSON.parse(f).type);
	// started 之后、final 之前应有多个 ping；结束后不再追加（定时器已清）
	expect(types[0]).toBe("started");
	expect(types[types.length - 1]).toBe("final");
	const pings = types.filter((t) => t === "ping").length;
	expect(pings).toBeGreaterThanOrEqual(3);
	await new Promise((r) => setTimeout(r, 150));
	expect(
		frames.map((f) => JSON.parse(f).type).filter((t) => t === "ping").length,
	).toBe(pings);
});
