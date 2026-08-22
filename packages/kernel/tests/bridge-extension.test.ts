// bridge-extension.test.ts —— wa-pi-bridge.extension callBridge 流式 NDJSON 读取测试
//
// 该文件测源扩展的 callBridge（经 delegate 工具 execute 间接调用）：
// - mock globalThis.fetch 返回 NDJSON ReadableStream
// - 注入 bridge 环境变量
// - 复用 bridge.test.ts 的成熟套路：把源扩展写到临时 .ts 文件 + 复制 tool-schemas
//   到同目录（源扩展的 `import "./tool-schemas.ts"` 才能解析），再动态 import 临时文件。
//
// 复制 generateBridgeExtension 源码而不是直接 import 源文件的原因：源文件在
// packages/kernel/src 下，同目录没有 tool-schemas.ts（该文件运行期才复制到 GENERATED_DIR）。

import { test, expect, afterAll, describe } from "bun:test";
import { writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBridgeExtension } from "../src/bridge-extension";

// 临时文件清单，测试结束统一清理
const tmpFiles: string[] = [];
afterAll(() => {
	for (const f of tmpFiles) rmSync(f, { force: true });
});

/** 加载扩展（复制 schema + 源码到临时文件，再动态 import），返回注册的工具数组。 */
async function loadTools(transform?: (src: string) => string): Promise<any[]> {
	const file = join(
		import.meta.dir,
		`.tmp-bridge-ext-${Math.random().toString(36).slice(2)}.ts`,
	);
	const schemasFile = join(import.meta.dir, "tool-schemas.ts");
	const schemasSrc = join(
		import.meta.dir,
		"..",
		"..",
		"shared",
		"src",
		"tool-schemas.ts",
	);
	copyFileSync(schemasSrc, schemasFile);
	tmpFiles.push(schemasFile);
	const snapshotFile = join(import.meta.dir, "file-snapshot.ts");
	const snapshotSrc = join(import.meta.dir, "..", "src", "file-snapshot.ts");
	copyFileSync(snapshotSrc, snapshotFile);
	tmpFiles.push(snapshotFile);
	let src = generateBridgeExtension();
	if (transform) src = transform(src);
	writeFileSync(file, src, "utf8");
	tmpFiles.push(file);
	const mod = await import(pathToFileURL(file).href);
	const tools: any[] = [];
	mod.default({
		registerTool: (def: any) => tools.push(def),
		registerCommand: () => {},
		on: () => {},
	});
	return tools;
}

/** 构造一个 NDJSON ReadableStream。 */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const payload = enc.encode(lines.join("\n") + "\n");
	return new ReadableStream({
		start(c) {
			c.enqueue(payload);
			c.close();
		},
	});
}

/** 注入 bridge env。 */
function injectBridgeEnv() {
	process.env.WA_PI_BRIDGE_URL = "http://test";
	process.env.WA_PI_BRIDGE_TOKEN = "t";
	process.env.WA_PI_SESSION_ID = "s";
}

/** mock fetch 返回给定 NDJSON 行流。返回恢复函数。 */
function mockNdjsonFetch(lines: string[]): () => void {
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		// 流式协议标识：content-type 含 x-ndjson
		headers: new Headers({ "content-type": "application/x-ndjson" }),
		body: ndjsonStream(lines),
		json: async () => ({}),
	})) as any;
	return () => {
		globalThis.fetch = orig;
	};
}

test("delegate execute 读取 NDJSON 流并组装最终结果", async () => {
	const restore = mockNdjsonFetch([
		JSON.stringify({
			type: "started",
			protocol: 1,
			tool: "delegate",
			toolCallId: "tc1",
		}),
		JSON.stringify({
			type: "progress",
			tool: "delegate",
			toolCallId: "tc1",
			progress: {
				agent: "a",
				status: "running",
				output: "x",
				tools: [],
				elapsedMs: 1,
			},
		}),
		JSON.stringify({
			type: "final",
			tool: "delegate",
			toolCallId: "tc1",
			ok: true,
			result: { content: [{ type: "text", text: "子代理结果" }] },
		}),
	]);
	injectBridgeEnv();

	try {
		const tools = await loadTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		const res = await delegateTool.execute(
			"tc1",
			{ agent: "general-purpose", task: "hi" },
			new AbortController().signal,
		);
		expect(res.content[0].text).toBe("子代理结果");
	} finally {
		restore();
	}
});

test("流中断（无 final）退化为错误结果", async () => {
	const restore = mockNdjsonFetch([
		JSON.stringify({
			type: "started",
			protocol: 1,
			tool: "delegate",
			toolCallId: "tc2",
		}),
	]);
	injectBridgeEnv();

	try {
		const tools = await loadTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		const res = await delegateTool.execute(
			"tc2",
			{ agent: "general-purpose", task: "hi" },
			new AbortController().signal,
		);
		expect(res.details?.error).toBe("stream_interrupted");
		expect(res.content[0].text).toContain("连接中断");
	} finally {
		restore();
	}
}, 10_000);

test("fetch init 携带 timeout:false（禁用 Bun 原生 300s 硬超时）", async () => {
	let capturedInit: any = null;
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) => {
		capturedInit = init;
		return {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/x-ndjson" }),
			body: ndjsonStream([
				JSON.stringify({
					type: "final",
					tool: "delegate",
					toolCallId: "tc3",
					ok: true,
					result: { content: [{ type: "text", text: "ok" }] },
				}),
			]),
			json: async () => ({}),
		};
	}) as any;
	injectBridgeEnv();

	try {
		const tools = await loadTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		await delegateTool.execute(
			"tc3",
			{ agent: "general-purpose", task: "hi" },
			new AbortController().signal,
		);
		// Bun 专属选项：false = 关闭原生 300s 硬超时（否则 delegate 超 5 分钟必死）
		expect(capturedInit?.timeout).toBe(false);
	} finally {
		globalThis.fetch = orig;
	}
});

// 空闲超时语义验证：把 DELEGATE_TIMEOUT_MS 缩到 300ms 再测，避免真实等待 10 分钟
const shrinkTimeout = (src: string) =>
	src.replace(
		"const DELEGATE_TIMEOUT_MS = 600_000;",
		"const DELEGATE_TIMEOUT_MS = 300;",
	);

test("持续有帧超过空闲阈值仍成功（收到帧即刷新空闲超时）", async () => {
	// 每 100ms 推一帧，500ms 后才给 final：总时长 > 300ms 阈值，但从不空闲超阈值
	const enc = new TextEncoder();
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/x-ndjson" }),
		body: new ReadableStream<Uint8Array>({
			start(c) {
				const started = JSON.stringify({
					type: "started",
					protocol: 1,
					tool: "delegate",
					toolCallId: "tc4",
				});
				const progress = JSON.stringify({
					type: "progress",
					tool: "delegate",
					toolCallId: "tc4",
					progress: {
						agent: "a",
						status: "running",
						output: "x",
						tools: [],
						elapsedMs: 1,
					},
				});
				const final = JSON.stringify({
					type: "final",
					tool: "delegate",
					toolCallId: "tc4",
					ok: true,
					result: { content: [{ type: "text", text: "长跑完成" }] },
				});
				c.enqueue(enc.encode(started + "\n"));
				let n = 0;
				const iv = setInterval(() => {
					n++;
					if (n < 5) c.enqueue(enc.encode(progress + "\n"));
					else {
						clearInterval(iv);
						c.enqueue(enc.encode(final + "\n"));
						c.close();
					}
				}, 100);
			},
		}),
		json: async () => ({}),
	})) as any;
	injectBridgeEnv();

	try {
		const tools = await loadTools(shrinkTimeout);
		const delegateTool = tools.find((t) => t.name === "delegate");
		const res = await delegateTool.execute(
			"tc4",
			{ agent: "general-purpose", task: "hi" },
			new AbortController().signal,
		);
		expect(res.content[0].text).toBe("长跑完成");
	} finally {
		globalThis.fetch = orig;
	}
});

test("无任何帧超过空闲阈值 → 报空闲超时", async () => {
	// started 帧之后永久停滞；abort 时让挂起的 read() 以 abort reason 拒绝（模拟真实 fetch）
	const enc = new TextEncoder();
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) => ({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/x-ndjson" }),
		body: new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(
					enc.encode(
						JSON.stringify({
							type: "started",
							protocol: 1,
							tool: "delegate",
							toolCallId: "tc5",
						}) + "\n",
					),
				);
			},
			pull() {
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), {
						once: true,
					});
				});
			},
		}),
		json: async () => ({}),
	})) as any;
	injectBridgeEnv();

	try {
		const tools = await loadTools(shrinkTimeout);
		const delegateTool = tools.find((t) => t.name === "delegate");
		const res = await delegateTool.execute(
			"tc5",
			{ agent: "general-purpose", task: "hi" },
			new AbortController().signal,
		);
		expect(res.content[0].text).toContain("空闲超时");
	} finally {
		globalThis.fetch = orig;
	}
});

test("工具忘传 timeoutMs 时默认 60s 空闲兜底（timeout:false 后不再永久挂起）", async () => {
	// 模拟未来新增工具忘传第 5 实参：变换源码去掉 memory_add 的显式 timeoutMs，
	// 并把 DEFAULT_TIMEOUT_MS 缩到 300ms 避免真实等待 60s
	const dropExplicitTimeout = (src: string) =>
		src
			.replace(
				"const DEFAULT_TIMEOUT_MS = 60_000;",
				"const DEFAULT_TIMEOUT_MS = 300;",
			)
			.replace(
				'callBridge("memory_add", toolCallId, params, signal, DEFAULT_TIMEOUT_MS)',
				'callBridge("memory_add", toolCallId, params, signal)',
			);
	// fetch 永久挂起，仅响应 abort（模拟 kernel 无响应）
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		})) as any;
	injectBridgeEnv();

	try {
		const tools = await loadTools(dropExplicitTimeout);
		const memAdd = tools.find((t) => t.name === "memory_add");
		const res = await memAdd.execute(
			"tc6",
			{ target: "memory", content: "x" },
			new AbortController().signal,
		);
		// 默认兜底生效：无响应时按 DEFAULT_TIMEOUT_MS 判死，而非永久挂起
		expect(res.content[0].text).toContain("空闲超时");
	} finally {
		globalThis.fetch = orig;
	}
});

test("session_start 在 RPC 模式将 custom() 替换为同步抛出（解除 custom 挂起）", async () => {
	const file = join(
		import.meta.dir,
		`.tmp-bridge-session-${Math.random().toString(36).slice(2)}.ts`,
	);
	const schemasFile = join(import.meta.dir, "tool-schemas.ts");
	const schemasSrc = join(
		import.meta.dir,
		"..",
		"..",
		"shared",
		"src",
		"tool-schemas.ts",
	);
	copyFileSync(schemasSrc, schemasFile);
	tmpFiles.push(schemasFile);
	const snapshotFile = join(import.meta.dir, "file-snapshot.ts");
	const snapshotSrc = join(import.meta.dir, "..", "src", "file-snapshot.ts");
	copyFileSync(snapshotSrc, snapshotFile);
	tmpFiles.push(snapshotFile);
	const src = generateBridgeExtension();
	writeFileSync(file, src, "utf8");
	tmpFiles.push(file);
	const mod = await import(pathToFileURL(file).href);

	// 捕获事件注册
	const handlers: Record<string, ((...args: any[]) => any)[]> = {};
	mod.default({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: any[]) => any) => {
			(handlers[event] ??= []).push(handler);
		},
	});

	// session_start handler 已注册
	expect(handlers["session_start"]).toBeDefined();
	expect(handlers["session_start"].length).toBe(1);
	const onSessionStart = handlers["session_start"][0];

	// ── RPC 模式：custom() 被替换为先 notify 再同步抛出 ──
	const notifyCalls: { message: string; type: string }[] = [];
	const rpcUi: any = {
		custom: () => undefined,
		notify: (message: string, type: string) =>
			notifyCalls.push({ message, type }),
	};
	onSessionStart(
		{ type: "session_start", reason: "startup" },
		{ mode: "rpc", ui: rpcUi },
	);
	// 调用 custom() 应先 notify 再 throw
	expect(() => rpcUi.custom(() => {}, {})).toThrow("不支持");
	expect(notifyCalls.length).toBe(1);
	expect(notifyCalls[0].message).toContain("不支持");
	expect(notifyCalls[0].type).toBe("warning");

	// 关键验证：在 Promise executor 内同步抛出 → Promise reject（而非永久 pending）
	// 这正是 openMcpPanel 的 `await new Promise(resolve => ctx.ui.custom(factory))` 模式
	await expect(
		new Promise<void>((_resolve) => {
			rpcUi.custom(() => {});
		}),
	).rejects.toThrow("不支持");

	// 模拟 _tryExecuteExtensionCommand 的 try-catch：throw 被外层正常捕获
	let caught: Error | null = null;
	try {
		await new Promise<void>((resolve) => {
			rpcUi.custom(() => {}); // 模拟扩展命令 handler 调用 custom
			resolve(); // 不会到达
		});
	} catch (e) {
		caught = e as Error;
	}
	expect(caught).not.toBeNull();
	expect(caught!.message).toContain("不支持");

	// ── TUI 模式：custom() 不被修改 ──
	const tuiUi: any = { custom: () => undefined };
	onSessionStart(
		{ type: "session_start", reason: "startup" },
		{ mode: "tui", ui: tuiUi },
	);
	expect(tuiUi.custom()).toBeUndefined(); // 未被 patch

	// ── 边界：ui 无 custom 方法时不报错 ──
	const noCustomUi: any = {};
	expect(() =>
		onSessionStart(
			{ type: "session_start", reason: "startup" },
			{ mode: "rpc", ui: noCustomUi },
		),
	).not.toThrow();
});

test("ask execute：bridge socket 断开后自动重试并成功", async () => {
	injectBridgeEnv();
	let calls = 0;
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		if (calls === 1) {
			// 模拟偶发断开：Bun fetch 在 socket 被对端关闭时的报错
			throw new Error("The socket connection was closed unexpectedly.");
		}
		return {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/x-ndjson" }),
			body: ndjsonStream([
				JSON.stringify({
					type: "started",
					protocol: 1,
					tool: "ask_user_question",
					toolCallId: "tc_ask",
				}),
				JSON.stringify({
					type: "final",
					tool: "ask_user_question",
					toolCallId: "tc_ask",
					ok: true,
					result: {
						content: [{ type: "text", text: "用户回答了" }],
						details: {},
					},
				}),
			]),
			json: async () => ({}),
		};
	}) as any;

	try {
		const tools = await loadTools();
		const askTool = tools.find((t) => t.name === "ask_user_question");
		const res = await askTool.execute(
			"tc_ask",
			{
				questions: [
					{
						question: "Q?",
						header: "h",
						options: [
							{ label: "A", description: "a" },
							{ label: "B", description: "b" },
						],
					},
				],
			},
			new AbortController().signal,
		);
		expect(calls).toBe(2);
		expect(res.content[0].text).toBe("用户回答了");
	} finally {
		globalThis.fetch = orig;
	}
}, 10_000);

const askRetryParams = {
	questions: [
		{
			question: "Q?",
			header: "h",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

test("ask execute：断开重试最多 5 次后放弃", async () => {
	injectBridgeEnv();
	let calls = 0;
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error("The socket connection was closed unexpectedly.");
	}) as any;

	try {
		const tools = await loadTools();
		const askTool = tools.find((t) => t.name === "ask_user_question");
		const res = await askTool.execute(
			"tc_ask",
			askRetryParams,
			new AbortController().signal,
		);
		expect(calls).toBe(6); // 首次 + 5 次重试
		expect(res.details?.error).toContain("socket connection was closed");
	} finally {
		globalThis.fetch = orig;
	}
}, 15_000);

test("ask execute：signal 已 abort 时不重试（ask 已失效）", async () => {
	injectBridgeEnv();
	let calls = 0;
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error("The socket connection was closed unexpectedly.");
	}) as any;

	try {
		const tools = await loadTools();
		const askTool = tools.find((t) => t.name === "ask_user_question");
		const ctrl = new AbortController();
		ctrl.abort(); // ask 已失效
		await askTool.execute("tc_ask", askRetryParams, ctrl.signal);
		expect(calls).toBe(1); // 不重试
	} finally {
		globalThis.fetch = orig;
	}
}, 10_000);

// ── browser_* 工具注册（源码级断言，沿用 generateBridgeExtension 模式）──
// 静态扩展文件不参与 tsc 类型检查（ensureBridgeExtension 运行期复制），
// 这里以源码字符串断言 4 个 browser_* registerTool 的 name / ParamsSchema /
// 超时常量引用，并借助 loadTools 动态 import 验证其实际注册与 execute 形态。
describe("generateBridgeExtension 源码包含 4 个 browser_* registerTool", () => {
	const src = generateBridgeExtension();
	const cases = [
		{
			name: "browser_navigate",
			schema: "BrowserNavigateParamsSchema",
			timeout: "BROWSER_NAVIGATE_TIMEOUT_MS",
		},
		{
			name: "browser_evaluate",
			schema: "BrowserEvaluateParamsSchema",
			timeout: "BROWSER_OPERATION_TIMEOUT_MS",
		},
		{
			name: "browser_screenshot",
			schema: "BrowserScreenshotParamsSchema",
			timeout: "BROWSER_OPERATION_TIMEOUT_MS",
		},
		{
			name: "browser_close",
			schema: "BrowserCloseParamsSchema",
			timeout: "BROWSER_OPERATION_TIMEOUT_MS",
		},
	];
	for (const { name, schema, timeout } of cases) {
		test(`含 ${name} registerTool（${schema} + ${timeout}）`, () => {
			expect(src).toContain(`name: "${name}"`);
			expect(src).toContain(`parameters: ${schema}`);
			// callBridge 调用为多行写法（沿用 ask/delegate 风格），压平空白后断言；
			// 末尾带尾随逗号，故只断言到超时常量为止
			const compact = src.replace(/\s+/g, "");
			expect(compact).toContain(
				`callBridge("${name}",toolCallId,params,signal,${timeout}`,
			);
		});
	}

	test("顶部常量区含两个 browser 超时常量（精确数值）", () => {
		expect(src).toContain("const BROWSER_NAVIGATE_TIMEOUT_MS = 150_000;");
		expect(src).toContain("const BROWSER_OPERATION_TIMEOUT_MS = 90_000;");
	});

	test("从 ./tool-schemas.ts import 4 个 DESCRIPTION 与 4 个 ParamsSchema", () => {
		for (const symbol of [
			"BROWSER_NAVIGATE_DESCRIPTION",
			"BrowserNavigateParamsSchema",
			"BROWSER_EVALUATE_DESCRIPTION",
			"BrowserEvaluateParamsSchema",
			"BROWSER_SCREENSHOT_DESCRIPTION",
			"BrowserScreenshotParamsSchema",
			"BROWSER_CLOSE_DESCRIPTION",
			"BrowserCloseParamsSchema",
		]) {
			expect(src).toContain(symbol);
		}
	});

	test("browser_* 工具经 loadTools 实际注册（label/execute 形态）", async () => {
		const tools = await loadTools();
		const labels: Record<string, string> = {
			browser_navigate: "Browser Navigate",
			browser_evaluate: "Browser Evaluate",
			browser_screenshot: "Browser Screenshot",
			browser_close: "Browser Close",
		};
		for (const [name, label] of Object.entries(labels)) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, `应注册 ${name}`).toBeDefined();
			expect(tool.label).toBe(label);
			expect(typeof tool.description).toBe("string");
			expect(tool.parameters).toBeDefined();
			expect(typeof tool.execute).toBe("function");
		}
	});
});
