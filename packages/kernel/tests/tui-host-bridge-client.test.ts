import { describe, expect, test } from "bun:test";
import { connectInputChannel, createFrameSink, splitNdjson } from "../src/tui-host/host.ts";

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
});
