import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	handleBridgeRequest,
	handleBridgeStream,
	registerBridgeSession,
	unregisterBridgeSession,
	getBridgeToken,
} from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { runAskTool } from "../src/ask-runner";
import type { AskParams } from "@wa-pi/shared";

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

beforeEach(() => askRegistry.reset());
afterEach(() => unregisterBridgeSession("s1"));

// 僵尸提问回归：pi 侧 bridge fetch 超时/断连后，kernel 侧 askRegistry 条目必须
// 被清理（以 cancelled 解决），否则前端卡片看似有效、用户回答被静默吞掉。
// 修复手段：ws-server 把 req.signal 透传给 handleBridgeRequest → ctx.handleTool
// → runAskTool → askRegistry.ask 的 signal；客户端断连时条目自动作废。

test("handleBridgeRequest 透传 signal：abort 后 pending ask 以 cancelled 解决（僵尸清理）", async () => {
	registerBridgeSession("s1", {
		cwd: "/tmp",
		handleTool: (_tool, toolCallId, p, signal) =>
			runAskTool("s1", toolCallId, p, signal),
	});
	const ctrl = new AbortController();
	const responseP = handleBridgeRequest(
		{
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "ask_user_question",
			params,
		},
		ctrl.signal,
	);
	// 注册完成后模拟客户端断连
	await new Promise((r) => setTimeout(r, 20));
	expect(askRegistry.pendingToolCallIds("s1")).toEqual(["tc1"]);
	ctrl.abort();
	const res = await responseP;
	expect(res.ok).toBe(true);
	// 条目已清理，不再残留 pending
	expect(askRegistry.pendingToolCallIds("s1")).toEqual([]);
});

// Bun 行为探针：Bun.serve 在客户端断连时是否 abort req.signal。
// 若本测试失败，说明 Bun 不支持该语义，ws-server 透传 req.signal 的修复无效，
// 需要换方案（如 kernel 侧与 bridge 对齐的硬超时）。
test("Bun.serve：客户端 abort fetch → 服务端 req.signal 触发 abort", async () => {
	let serverSawAbort = false;
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			return new Promise<Response>((resolve) => {
				req.signal.addEventListener("abort", () => {
					serverSawAbort = true;
					resolve(Response.json({ ok: true }));
				});
			});
		},
	});
	try {
		const ctrl = new AbortController();
		const clientP = fetch(`http://127.0.0.1:${server.port}/`, {
			signal: ctrl.signal,
		}).catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		ctrl.abort();
		await clientP;
		// Bun 的 abort 传播到服务端 req.signal 有延迟（重负载下 >1.5s），
		// 固定 sleep 不可靠：轮询等待事件，最多 8s
		const deadline = Date.now() + 8000;
		while (!serverSawAbort && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(serverSawAbort).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("handleBridgeStream 透传 opts.signal：abort 后 delegate 执行收到中止信号", async () => {
	let seenSignal: AbortSignal | undefined;
	registerBridgeSession("s1", {
		cwd: "/tmp",
		handleTool: (_tool, _id, _params, signal) => {
			seenSignal = signal;
			// 模拟长执行：直到信号中止才返回
			return new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => resolve({ content: [{ type: "text" as const, text: "aborted" }] }),
					{ once: true },
				);
			});
		},
	});
	const ctrl = new AbortController();
	const frames: string[] = [];
	const doneP = handleBridgeStream(
		{
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "delegate",
			params: { agent: "Explore", task: "x" },
		},
		(line) => frames.push(line),
		{ signal: ctrl.signal, heartbeatMs: 50 },
	);
	await new Promise((r) => setTimeout(r, 30));
	ctrl.abort();
	await doneP;
	expect(seenSignal?.aborted).toBe(true);
	const final = frames
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.find((f) => f.type === "final");
	expect(final?.ok).toBe(true);
});

// Bun 行为探针：客户端 abort 流式 fetch → 服务端 ReadableStream 的 cancel() 触发。
// ws-server 靠 cancel 回调中止子代理执行；若本测试失败说明 Bun 不支持该语义，
// 任务 2 的 ws-server 接线无效，需改用心跳缺失检测等替代方案。
test("Bun.serve 探针：客户端 abort NDJSON 流式 fetch → 服务端 stream cancel 触发", async () => {
	let serverSawCancel = false;
	const server = Bun.serve({
		port: 0,
		fetch() {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"type":"started"}\n'));
					// 不再写数据、不关闭：模拟长执行中的流
				},
				cancel() {
					serverSawCancel = true;
				},
			});
			return new Response(stream, {
				headers: { "content-type": "application/x-ndjson" },
			});
		},
	});
	try {
		const ctrl = new AbortController();
		const clientP = fetch(`http://127.0.0.1:${server.port}/`, {
			signal: ctrl.signal,
		}).catch(() => {});
		await new Promise((r) => setTimeout(r, 200));
		ctrl.abort();
		await clientP;
		await new Promise((r) => setTimeout(r, 1500));
		expect(serverSawCancel).toBe(true);
	} finally {
		server.stop(true);
	}
});

// ask 改流式后的僵尸清理回归：ask 走 NDJSON 流式分支，stream signal abort
// 必须级联到 pending ask（以 cancelled 解决），防「连接断了但提问条目残留」。
test("流式 ask：stream signal abort 后 pending ask 以 cancelled 解决（僵尸清理）", async () => {
	registerBridgeSession("s1", {
		cwd: "/tmp",
		handleTool: (_tool, toolCallId, p, signal) =>
			runAskTool("s1", toolCallId, p, signal),
	});
	const ctrl = new AbortController();
	const frames: string[] = [];
	const doneP = handleBridgeStream(
		{
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc-ask",
			tool: "ask_user_question",
			params,
		},
		(line) => frames.push(line),
		{ signal: ctrl.signal, heartbeatMs: 50 },
	);
	await new Promise((r) => setTimeout(r, 30));
	expect(askRegistry.pendingToolCallIds("s1")).toEqual(["tc-ask"]);
	ctrl.abort();
	await doneP;
	expect(askRegistry.pendingToolCallIds("s1")).toEqual([]);
	// 流以 final 帧正常收尾（cancelled 结果帧），不是中断无帧
	const final = frames
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.find((f) => f.type === "final");
	expect(final).toBeDefined();
});

// Bun 行为探针：idleTimeout=1s 下，流式心跳（100ms）能否让 1.5s 才完成的请求正常交付。
// 若本测试失败，说明心跳不足以对抗 Bun idleTimeout，ask 流式化方案无效，需回炉。
// 注意：idleTimeout=1s 是 Bun 极限值，高负载下偶发时序抖动（~3%）；产品默认心跳 15s vs
// pi 600s 空闲余量 40 倍，无实际风险。retry:2 消除 CI 抖动，真失败（心跳失效）仍会报出。
test(
	"Bun 探针：idleTimeout=1s 下流式心跳保活，1.5s 后正常收到 final 帧",
	async () => {
		registerBridgeSession("s1", {
			cwd: "/tmp",
			handleTool: async () => {
				// 1.5s 后才返回：远超 1s idleTimeout，无心跳必然断连
				await new Promise((r) => setTimeout(r, 1500));
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		});
		const server = Bun.serve({
			port: 0,
			idleTimeout: 1, // 1s 空闲断连（Bun 上限 255s，测试取最小值加速验证）
			async fetch(req) {
				const body = await req.json();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const enc = new TextEncoder();
						const write = (l: string) => {
							try {
								controller.enqueue(enc.encode(l));
							} catch {
								/* 已关闭 */
							}
						};
						void handleBridgeStream(body, write, { heartbeatMs: 100 }).then(() => {
							try {
								controller.close();
							} catch {
								/* 已关闭 */
							}
						});
					},
				});
				return new Response(stream, {
					headers: { "content-type": "application/x-ndjson" },
				});
			},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/bridge/tool`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token: getBridgeToken(),
					sessionId: "s1",
					toolCallId: "tc1",
					tool: "ask_user_question",
					params,
				}),
				// Bun 专属：关闭 300s 原生硬超时（与 wa-pi-bridge.extension.ts 同处理）
				...({ timeout: false } as object),
			});
			const text = await res.text();
			const final = text
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.find((f) => f.type === "final");
			expect(final?.ok).toBe(true);
		} finally {
			server.stop(true);
		}
	},
	{ retry: 2, timeout: 10_000 },
);
