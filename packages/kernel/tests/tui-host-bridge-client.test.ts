import { describe, expect, test } from "bun:test";
import {
	backoffDelay,
	connectInputChannel,
	createFrameSink,
	createFrameStream,
	splitNdjson,
} from "../src/tui-host/host.ts";

describe("splitNdjson", () => {
	test("逐行切分，半行保留在缓冲", () => {
		const r1 = splitNdjson("", '{"a":1}\n{"b"');
		expect(r1.lines).toEqual(['{"a":1}']);
		expect(r1.rest).toBe('{"b"');
	});

	test("空行跳过；多行一次到达全部切出", () => {
		const r = splitNdjson("", '{"a":1}\n\n{"b":2}\n');
		expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
		expect(r.rest).toBe("");
	});
});

describe("createFrameSink", () => {
	test("未连接时帧入队；连接后按序 flush，且继续直写", () => {
		const written: string[] = [];
		const sink = createFrameSink();
		sink.push({ type: "open", panelId: "p1" });
		sink.push({ type: "frame", panelId: "p1" });
		sink.attach((line) => written.push(line));
		expect(written).toHaveLength(2);
		sink.push({ type: "close", panelId: "p1" });
		expect(written).toHaveLength(3);
		expect(JSON.parse(written[0]!)).toEqual({ type: "open", panelId: "p1" });
	});

	test("队列有上限，溢出丢最旧的帧（保留最新画面）", () => {
		const sink = createFrameSink({ maxQueue: 3 });
		for (let i = 0; i < 10; i++) sink.push({ type: "frame", panelId: "p1", n: i });
		const written: string[] = [];
		sink.attach((l) => written.push(l));
		expect(written).toHaveLength(3);
		expect(JSON.parse(written.at(-1)!).n).toBe(9);
	});

	test("溢出优先丢画面帧：open/close 控制帧被保留", () => {
		const sink = createFrameSink({ maxQueue: 3 });
		sink.push({ type: "open", panelId: "p1" });
		sink.push({ type: "close", panelId: "p1", reason: "done" });
		for (let i = 0; i < 10; i++) sink.push({ type: "frame", panelId: "p1", n: i });
		const written: string[] = [];
		sink.attach((l) => written.push(l));
		expect(written.map((l) => JSON.parse(l).type)).toEqual(["open", "close", "frame"]);
		expect(JSON.parse(written.at(-1)!).n).toBe(9);
	});

	test("队列里全是控制帧时退化为丢最旧（保住最新的 open/close）", () => {
		const sink = createFrameSink({ maxQueue: 2 });
		sink.push({ type: "open", panelId: "p1" });
		sink.push({ type: "open", panelId: "p2" });
		sink.push({ type: "close", panelId: "p2", reason: "done" });
		const written: string[] = [];
		sink.attach((l) => written.push(l));
		expect(written.map((l) => JSON.parse(l).panelId)).toEqual(["p2", "p2"]);
	});

	test("detach 后帧回到队列，重新 attach 时按序补发", () => {
		const written: string[] = [];
		const sink = createFrameSink();
		sink.attach((l) => written.push(l));
		sink.push({ type: "frame", n: 1 });
		sink.detach();
		sink.push({ type: "frame", n: 2 });
		sink.attach((l) => written.push(l));
		expect(written.map((l) => JSON.parse(l).n)).toEqual([1, 2]);
	});
});

/** 造一个可手动推入 NDJSON 文本的响应流，代替真实 kernel */
function ndjsonResponse(): { response: Response; push: (text: string) => void } {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		response: new Response(stream),
		push: (text) => controller.enqueue(encoder.encode(text)),
	};
}

describe("connectInputChannel", () => {
	test("订阅 kernel 输入流，按行分发事件（跨 chunk 的半行拼接）", async () => {
		const events: unknown[] = [];
		const requests: Array<{ url: string; body: string }> = [];
		const fake = ndjsonResponse();
		type FetchArgs = Parameters<typeof fetch>;
		const channel = connectInputChannel({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			onEvent: (e) => events.push(e),
			fetchImpl: (async (url: FetchArgs[0], init?: FetchArgs[1]) => {
				requests.push({ url: String(url), body: String(init?.body) });
				return fake.response;
			}) as unknown as typeof fetch,
		});
		channel.start();
		fake.push('{"type":"key","panelId":"p1","data":"\\u001b[A"}\n{"type":"can');
		await Bun.sleep(10);
		fake.push('cel","panelId":"p1"}\n');
		await Bun.sleep(10);
		channel.stop();

		expect(requests[0]!.url).toBe("http://127.0.0.1:9/bridge/tui-host/subscribe");
		expect(JSON.parse(requests[0]!.body)).toEqual({ token: "tok", sessionId: "s1" });
		expect(events).toEqual([
			{ type: "key", panelId: "p1", data: "\u001b[A" },
			{ type: "cancel", panelId: "p1" },
		]);
	});

	test("单个事件处理抛错不打断后续事件", async () => {
		const seen: string[] = [];
		const fake = ndjsonResponse();
		const channel = connectInputChannel({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			onEvent: (e) => {
				seen.push(e.type);
				if (e.type === "key") throw new Error("扩展监听器炸了");
			},
			fetchImpl: (async () => fake.response) as unknown as typeof fetch,
		});
		channel.start();
		fake.push('{"type":"key","panelId":"p1"}\n{"type":"cancel","panelId":"p1"}\n');
		await Bun.sleep(10);
		channel.stop();
		expect(seen).toEqual(["key", "cancel"]);
	});

	test("订阅流出错或结束时按间隔重连", async () => {
		let calls = 0;
		const channel = connectInputChannel({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			onEvent: () => {},
			retryMs: 5,
			log: () => {},
			fetchImpl: (async () => {
				calls += 1;
				if (calls === 1) return new Response("");
				throw new Error("kernel 不在");
			}) as unknown as typeof fetch,
		});
		channel.start();
		await Bun.sleep(60);
		channel.stop();
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	test("stop 后不再重连（不泄定时器）", async () => {
		let calls = 0;
		const channel = connectInputChannel({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			onEvent: () => {},
			retryMs: 5,
			log: () => {},
			fetchImpl: (async () => {
				calls += 1;
				throw new Error("kernel 不在");
			}) as unknown as typeof fetch,
		});
		channel.start();
		await Bun.sleep(30);
		expect(calls).toBeGreaterThan(1);
		channel.stop();
		const after = calls;
		await Bun.sleep(60);
		expect(calls).toBe(after);
	});

	test("401 按指数退避重连，日志带 sessionId 与状态码", async () => {
		const logs: string[] = [];
		const channel = connectInputChannel({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			onEvent: () => {},
			retryMs: 10,
			maxRetryMs: 40,
			log: (m) => logs.push(m),
			fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
		});
		channel.start();
		await Bun.sleep(80);
		channel.stop();
		expect(logs[0]).toContain("401");
		expect(logs[0]).toContain("session=s1");
		expect(logs[0]).toContain("10ms 后重连");
		expect(logs[1]).toContain("20ms 后重连");
	});
});

describe("backoffDelay", () => {
	test("指数增长并封顶", () => {
		expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
	});
});

/**
 * 模拟 kernel 侧：读请求体行，响应挂到连接结束才返回（真实 kernel 不提前回响应，
 * 否则客户端会立刻 detach 并 1s 重连）。
 */
function kernelStub() {
	const lines: string[] = [];
	let rest = "";
	let finish: (() => void) | null = null;
	let requests = 0;
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		requests += 1;
		const reader = (init.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = splitNdjson(rest, decoder.decode(value, { stream: true }));
				rest = chunk.rest;
				lines.push(...chunk.lines);
			}
			finish?.();
		})();
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return new Response("");
	}) as unknown as typeof fetch;
	return { lines, requests: () => requests, fetchImpl };
}

describe("createFrameStream", () => {
	test("先发鉴权行再逐行送帧；stop 后优雅断流且不再重连", async () => {
		const sink = createFrameSink();
		const kernel = kernelStub();
		const stream = createFrameStream({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			sink,
			retryMs: 20,
			fetchImpl: kernel.fetchImpl,
		});
		stream.start();
		sink.push({ type: "open", panelId: "p1" });
		sink.push({ type: "frame", panelId: "p1", lines: ["hi"] });
		await Bun.sleep(20);

		expect(JSON.parse(kernel.lines[0]!)).toEqual({ token: "tok", sessionId: "s1" });
		expect(kernel.lines.slice(1).map((l) => JSON.parse(l).type)).toEqual(["open", "frame"]);

		stream.stop();
		await Bun.sleep(60);
		expect(kernel.requests()).toBe(1);
	});

	test("401 按指数退避重连，日志带 sessionId 与状态码", async () => {
		const logs: string[] = [];
		let calls = 0;
		const stream = createFrameStream({
			bridgeUrl: "http://127.0.0.1:9",
			token: "tok",
			sessionId: "s1",
			sink: createFrameSink(),
			retryMs: 10,
			maxRetryMs: 40,
			log: (m) => logs.push(m),
			fetchImpl: (async () => {
				calls += 1;
				return new Response("", { status: 401 });
			}) as unknown as typeof fetch,
		});
		stream.start();
		await Bun.sleep(80);
		stream.stop();
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(logs[0]).toContain("401");
		expect(logs[0]).toContain("session=s1");
		expect(logs[0]).toContain("10ms 后重连");
		expect(logs[1]).toContain("20ms 后重连");
	});
});
