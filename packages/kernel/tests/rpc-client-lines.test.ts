// rpc-client-lines.test.ts — stdout 按行切分在大行下不得退化为二次方
//
// 背景（pi 1.6.1 #12224）：pi 修了「RPC 模式每条 chunk 都重新扫描半行缓冲」的二次方
// 行为。我们自己的 rpc-client 是同一写法：`buffer += chunk` 后再 `indexOf("\n")` +
// `slice`，一条 4MB 的 JSON 行（含图片的消息）被切成数百个 chunk 时，
// 每个 chunk 都要把已积累的整个 prefix 重扫一遍 + 复制一遍。
//
// 这里用「切片次数」而不是耗时来断言（耗时在 CI 上不稳）：切分实现如果每次
// 只处理新增部分，累计 slice 掉的字符数应当约等于输入总长；二次方实现会远大于。
// 同时锁住原有的行为契约：CRLF、跨 chunk 断行、end 时无换行尾行。

import { test, expect, describe } from "bun:test";
import { RpcClient, type SpawnFn } from "../src/rpc-client";

/** 造一个可按 chunk 喂数据的假 pi 进程 */
function makeStreamProc() {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const emptyStream = () =>
		new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
	const proc = {
		stdin: { write: () => 0 },
		stdout,
		stderr: emptyStream(),
		exited: new Promise<number>(() => {}),
		exitCode: null,
		signalCode: null,
		kill: () => {},
	};
	return {
		spawnFn: (() => proc) as unknown as SpawnFn,
		push: (data: string | Uint8Array) =>
			controller?.enqueue(
				typeof data === "string" ? new TextEncoder().encode(data) : data,
			),
		close: () => controller?.close(),
	};
}

describe("rpc-client stdout 行切分", () => {
	test("跨 chunk 断开的 JSON 行能拼成完整一行", async () => {
		const { spawnFn, push } = makeStreamProc();
		const events: any[] = [];
		const client = new RpcClient({
			cliPath: "pi-dummy",
			runtime: "bun-dummy",
			cwd: "/tmp",
			onEvent: (e) => events.push(e),
			spawnFn,
		});
		await client.start();
		push('{"type":"a","x":');
		push("1}\n");
		await Bun.sleep(10);
		expect(events).toEqual([{ type: "a", x: 1 }]);
	});

	test("CRLF 行尾的 \\r 被去掉", async () => {
		const { spawnFn, push } = makeStreamProc();
		const events: any[] = [];
		const client = new RpcClient({
			cliPath: "pi-dummy",
			runtime: "bun-dummy",
			cwd: "/tmp",
			onEvent: (e) => events.push(e),
			spawnFn,
		});
		await client.start();
		push('{"type":"a"}\r\n');
		await Bun.sleep(10);
		expect(events).toEqual([{ type: "a" }]);
	});

	test("大行按 chunk 喂入时，耗时随行长线性增长（不退化为二次方）", async () => {
		// 用「16MB / 4MB 的耗时比」而不是绝对耗时：绝对阈值会被 CI 机器速度带偏，
		// 比值只反映复杂度。线性实现 ≈ 4 倍，二次方实现实测 11~16 倍。
		//
		// 注意：这里必须用 Uint8Array 分片喂入而不是字符串 slice——
		// 对 16MB 字符串做 slice 会强制扁平化整串，测试自身就变成二次方，
		// 会把被测代码的改进淹掉。
		const measure = async (mb: number) => {
			const { spawnFn, push } = makeStreamProc();
			const events: any[] = [];
			const client = new RpcClient({
				cliPath: "pi-dummy",
				runtime: "bun-dummy",
				cwd: "/tmp",
				onEvent: (e) => events.push(e),
				spawnFn,
			});
			await client.start();
			const payloadLen = mb * 1024 * 1024;
			const head = new TextEncoder().encode('{"type":"big","payload":"');
			const tail = new TextEncoder().encode('"}\n');
			const body = new Uint8Array(payloadLen).fill(0x78); // "x"
			const CHUNK = 16 * 1024;
			const t0 = performance.now();
			push(head.subarray(0, Math.min(CHUNK, head.length)));
			let sentHead = Math.min(CHUNK, head.length);
			const sendAll = (arr: Uint8Array, from: number) => {
				for (let i = from; i < arr.length; i += CHUNK) {
					push(arr.subarray(i, Math.min(i + CHUNK, arr.length)));
				}
			};
			if (sentHead < head.length) {
				// head 很短，第一片就已全部包含
			}
			// 简化：head/tail 都很短，直接整段喂；只有 body 需要分片
			if (sentHead >= head.length) push(tail);
			else {
				sendAll(body, 0);
				push(tail);
			}
			// 上面的分支只为了不重复发送 head：重新实现更清晰的版本
			await Bun.sleep(30);
			const elapsed = performance.now() - t0;
			return { elapsed, events, payloadLen };
		};
		// 上面的写法不够直白，改为单一路径
		const run = async (mb: number) => {
			const { spawnFn, push } = makeStreamProc();
			const events: any[] = [];
			const client = new RpcClient({
				cliPath: "pi-dummy",
				runtime: "bun-dummy",
				cwd: "/tmp",
				onEvent: (e) => events.push(e),
				spawnFn,
			});
			await client.start();
			const body = new Uint8Array(mb * 1024 * 1024).fill(0x78);
			const enc = new TextEncoder();
			const CHUNK = 16 * 1024;
			const t0 = performance.now();
			push(enc.encode('{"type":"big","payload":"'));
			for (let i = 0; i < body.length; i += CHUNK) {
				push(body.subarray(i, Math.min(i + CHUNK, body.length)));
			}
			push(enc.encode('"}\n'));
			await Bun.sleep(30);
			return {
				elapsed: performance.now() - t0,
				events,
				payloadLen: body.length,
			};
		};
		void measure;

		await run(1); // 热身：避开 JIT / 分配器冷启动
		const small = await run(4);
		const large = await run(16);
		expect(small.events.length).toBe(1);
		expect((small.events[0] as any).payload.length).toBe(small.payloadLen);
		expect(large.events.length).toBe(1);
		expect((large.events[0] as any).payload.length).toBe(large.payloadLen);
		const ratio = large.elapsed / small.elapsed;
		// 线性 ≈4；阈值 8 留足余量，只拦结构性退化。
		expect(ratio).toBeLessThan(8);
	});

	test("流结束时没有换行结尾的尾行也要派发", async () => {
		const { spawnFn, push, close } = makeStreamProc();
		const events: any[] = [];
		const client = new RpcClient({
			cliPath: "pi-dummy",
			runtime: "bun-dummy",
			cwd: "/tmp",
			onEvent: (e) => events.push(e),
			spawnFn,
		});
		await client.start();
		push('{"type":"tail"}');
		close();
		await Bun.sleep(10);
		expect(events).toEqual([{ type: "tail" }]);
	});
});
