// proxy-relay 中继测试：真实 socket 验证「上游代理不可用 → 自动回退直连」。
//
// 拓扑：
//   client → relay(127.0.0.1:R) → [upstream 假代理(127.0.0.1:U)] → target 回显服务(127.0.0.1:T)
// 假代理收到 CONNECT 后记录请求行/鉴权头，回 200 并把隧道 pipe 到 target；
// target 是 TCP 回显服务。client 发 "ping" 应收 "ping"（经谁转发由假代理的记录判断）。

import { describe, test, expect, afterEach } from "bun:test";
import { createServer, Socket, type Server } from "node:net";
import { createServer as httpCreateServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ProxyRelay } from "../proxy-relay";

interface FakeUpstream {
	server: Server;
	port: number;
	/** 收到的 CONNECT 请求头原文（每次隧道一条） */
	connectRequests: string[];
	/** 被尝试连接的总次数（含最终失败的） */
	attempts: number;
	close: () => Promise<void>;
}

interface RunningTarget {
	server: Server;
	port: number;
	close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

/** TCP 回显服务（充当 LLM API 目标） */
async function startTarget(): Promise<RunningTarget> {
	const server = createServer((sock) => sock.pipe(sock));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const close = () =>
		new Promise<void>((r) => server.close(() => r()));
	cleanups.push(close);
	return { server, port, close };
}

/**
 * 假 HTTP 代理：记录 CONNECT 请求，回 200 后把隧道 pipe 到真实目标。
 * port 传 0 = 随机端口；传固定端口用于「先关后开」模拟代理恢复。
 */
async function startFakeUpstream(port = 0): Promise<FakeUpstream> {
	const state: FakeUpstream = {
		server: null as unknown as Server,
		port: 0,
		connectRequests: [],
		attempts: 0,
		close: () => Promise.resolve(),
	};
	const server = createServer((client) => {
		state.attempts++;
		let buf = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if (end === -1) return;
			client.off("data", onData);
			const headerText = buf.slice(0, end).toString("latin1");
			state.connectRequests.push(headerText);
			const m = headerText.match(/^CONNECT\s+(\S+):(\d+)\s/i);
			if (!m) {
				client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				return;
			}
			const target = new Socket();
			target.connect(Number(m[2]), m[1], () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				const rest = buf.slice(end + 4);
				if (rest.length) target.write(rest);
				client.pipe(target).pipe(client);
			});
			target.on("error", () => client.destroy());
		};
		client.on("data", onData);
		client.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	state.server = server;
	state.port = (server.address() as AddressInfo).port;
	state.close = () => new Promise<void>((r) => server.close(() => r()));
	cleanups.push(state.close);
	return state;
}

/** 向中继发 CONNECT，返回 { statusLine, socket }（已建立隧道） */
function connectViaRelay(
	relayPort: number,
	targetHost: string,
	targetPort: number,
): Promise<{ statusLine: string; socket: Socket }> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		let buf = Buffer.alloc(0);
		socket.connect(relayPort, "127.0.0.1", () => {
			socket.write(
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
			);
		});
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onData);
			const statusLine = buf.slice(0, end).toString("latin1").split("\r\n")[0];
			resolve({ statusLine, socket });
		};
		socket.on("data", onData);
		socket.on("error", reject);
	});
}

/** 隧道上发 data 并等回显 */
function echo(socket: Socket, data: string): Promise<string> {
	return new Promise((resolve, reject) => {
		socket.once("data", (chunk) => resolve(chunk.toString()));
		socket.once("error", reject);
		socket.write(data);
	});
}

/**
 * 以 absolute-form 向中继发普通 HTTP GET（模拟 fetch 经代理访问 http:// 目标），
 * 返回 `HTTP <status> <body>`。用原始 socket 而非 node:http 客户端——全量测试
 * 同进程跑 100+ 文件时 Bun 的 node:http 客户端行为会被其他文件污染（真实复现），
 * 原始 TCP 不受全局状态影响。按 Content-Length 收齐 body 即 resolve，不等连接关闭。
 */
function rawHttpGet(relayPort: number, absoluteUrl: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		let buf = Buffer.alloc(0);
		let expected = -1; // 头部结束位置 + Content-Length
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const headEnd = buf.indexOf("\r\n\r\n");
			if (headEnd === -1) return;
			if (expected === -1) {
				const head = buf.slice(0, headEnd).toString("latin1");
				const m = head.match(/content-length:\s*(\d+)/i);
				// 无 Content-Length（如 502 直接 end）：头部收齐即算完
				expected = m ? headEnd + 4 + Number(m[1]) : headEnd + 4;
			}
			if (buf.length >= expected) {
				socket.off("data", onData);
				const statusLine = buf
					.slice(0, buf.indexOf("\r\n"))
					.toString("latin1");
				const body = buf.slice(headEnd + 4, expected).toString("utf8");
				socket.destroy();
				resolve(`${statusLine} ${body}`);
			}
		};
		socket.connect(relayPort, "127.0.0.1", () => {
			socket.write(
				`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${new URL(absoluteUrl).host}\r\n\r\n`,
			);
		});
		socket.on("data", onData);
		socket.on("error", reject);
	});
}

describe("ProxyRelay", () => {
	test("上游可用 → CONNECT 经上游建隧道，数据正常往返", async () => {
		const target = await startTarget();
		const upstream = await startFakeUpstream();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${upstream.port}`,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const { statusLine, socket } = await connectViaRelay(
			relay.port,
			"127.0.0.1",
			target.port,
		);
		expect(statusLine).toContain("200");
		expect(await echo(socket, "ping")).toBe("ping");
		expect(upstream.connectRequests.length).toBe(1);
		expect(upstream.connectRequests[0]).toContain(
			`CONNECT 127.0.0.1:${target.port}`,
		);
		socket.destroy();
	});

	test("上游带 user:pass → CONNECT 注入 Proxy-Authorization", async () => {
		const target = await startTarget();
		const upstream = await startFakeUpstream();
		const relay = new ProxyRelay({
			upstream: `http://alice:s3cret@127.0.0.1:${upstream.port}`,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const { socket } = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(socket, "ping")).toBe("ping");
		const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
		expect(upstream.connectRequests[0]).toContain(
			`Proxy-Authorization: ${expected}`,
		);
		socket.destroy();
	});

	test("上游端口无监听（代理软件被关）→ 自动回退直连", async () => {
		const target = await startTarget();
		// 起一个上游再立刻关掉，拿到一个确定无监听的端口
		const dead = await startFakeUpstream();
		const deadPort = dead.port;
		await dead.close();

		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 500,
			upstreamDownMs: 60_000,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const { statusLine, socket } = await connectViaRelay(
			relay.port,
			"127.0.0.1",
			target.port,
		);
		expect(statusLine).toContain("200");
		expect(await echo(socket, "ping")).toBe("ping");
		socket.destroy();
	});

	test("冷却期内不再尝试死上游；上游恢复后自动切回", async () => {
		const target = await startTarget();
		// 先占一个端口再释放，后续可在同一端口「复活」假代理
		const dead = await startFakeUpstream();
		const port = dead.port;
		await dead.close();

		// 注入假时钟：冷却判定不依赖真实时间，全量并发下不受事件循环卡顿影响
		let fakeNow = 1_000_000;
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${port}`,
			connectTimeoutMs: 500,
			upstreamDownMs: 60_000,
			now: () => fakeNow,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		// 第一次：上游死 → 失败回退直连（触发冷却）
		const first = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(first.socket, "a")).toBe("a");
		first.socket.destroy();

		// 同端口复活假代理（模拟代理软件重新打开）
		const alive = await startFakeUpstream(port);

		// 冷却期内：不尝试上游，直接直连
		const second = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(second.socket, "b")).toBe("b");
		second.socket.destroy();
		expect(alive.attempts).toBe(0);

		// 冷却过期：重新尝试上游并成功走回代理
		fakeNow += 61_000;
		const third = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(third.socket, "c")).toBe("c");
		third.socket.destroy();
		expect(alive.connectRequests.length).toBe(1);
	});

	test("无上游（upstream 空）→ 直接直连", async () => {
		const target = await startTarget();
		const relay = new ProxyRelay({ upstream: "" });
		await relay.start();
		cleanups.push(() => relay.close());

		const { statusLine, socket } = await connectViaRelay(
			relay.port,
			"127.0.0.1",
			target.port,
		);
		expect(statusLine).toContain("200");
		expect(await echo(socket, "ping")).toBe("ping");
		socket.destroy();
	});

	test("setUpstream(\"\") 切直连：模拟用户关闭代理后存量进程继续可用", async () => {
		const target = await startTarget();
		const upstream = await startFakeUpstream();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${upstream.port}`,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		// 关闭代理前：经上游
		const before = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(before.socket, "x")).toBe("x");
		before.socket.destroy();
		expect(upstream.connectRequests.length).toBe(1);

		// 用户关闭代理 → 清上游 → 后续连接直连（不再碰上游）
		relay.setUpstream("");
		const after = await connectViaRelay(relay.port, "127.0.0.1", target.port);
		expect(await echo(after.socket, "y")).toBe("y");
		after.socket.destroy();
		expect(upstream.connectRequests.length).toBe(1);
	});

	test("目标不可达 → 502", async () => {
		const relay = new ProxyRelay({ upstream: "" });
		await relay.start();
		cleanups.push(() => relay.close());

		// 1 端口几乎不可能有监听
		const { statusLine, socket } = await connectViaRelay(
			relay.port,
			"127.0.0.1",
			1,
		);
		expect(statusLine).toContain("502");
		socket.destroy();
	});

	test("普通 HTTP GET（absolute-form）：无上游直连，目标收到 origin-form", async () => {
		// 目标是 HTTP 服务，记录请求行
		let seenUrl = "";
		const httpTarget = httpCreateServer((req, res) => {
			seenUrl = req.url ?? "";
			res.end("ok-direct");
		});
		await new Promise<void>((r) => httpTarget.listen(0, "127.0.0.1", r));
		const tPort = (httpTarget.address() as AddressInfo).port;
		cleanups.push(() => new Promise<void>((r) => httpTarget.close(() => r())));

		const relay = new ProxyRelay({ upstream: "" });
		await relay.start();
		cleanups.push(() => relay.close());

		// 代理语义：客户端向中继发 absolute-form 请求
		const raw = await rawHttpGet(
			relay.port,
			`http://127.0.0.1:${tPort}/api/chat?q=1`,
		);
		expect(raw).toContain("200");
		expect(raw).toContain("ok-direct");
		expect(seenUrl).toBe("/api/chat?q=1");
	});

	test("普通 HTTP GET（absolute-form）：经上游转发并保持 absolute-form + 鉴权头", async () => {
		// 上游是 HTTP 服务：记录请求行与 proxy-authorization，直接回 200
		let seenUrl = "";
		let seenAuth = "";
		const fakeHttpUpstream = httpCreateServer((req, res) => {
			seenUrl = req.url ?? "";
			seenAuth = String(req.headers["proxy-authorization"] ?? "");
			res.end("ok-upstream");
		});
		await new Promise<void>((r) => fakeHttpUpstream.listen(0, "127.0.0.1", r));
		const uPort = (fakeHttpUpstream.address() as AddressInfo).port;
		cleanups.push(
			() => new Promise<void>((r) => fakeHttpUpstream.close(() => r())),
		);

		const relay = new ProxyRelay({
			upstream: `http://alice:s3cret@127.0.0.1:${uPort}`,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const raw = await rawHttpGet(
			relay.port,
			"http://example.com:8080/api/chat?q=1",
		);
		expect(raw).toContain("ok-upstream");
		expect(seenUrl).toBe("http://example.com:8080/api/chat?q=1");
		expect(seenAuth).toBe(
			`Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
		);
	});

	test("普通 HTTP 转发：上游端口无监听（代理软件被关）→ 自动回退直连", async () => {
		// 真实 HTTP 目标（模拟本地 bridge 服务之外的任意 http 目标）
		const httpTarget = httpCreateServer((_req, res) => res.end("ok-direct"));
		await new Promise<void>((r) => httpTarget.listen(0, "127.0.0.1", r));
		const tPort = (httpTarget.address() as AddressInfo).port;
		cleanups.push(() => new Promise<void>((r) => httpTarget.close(() => r())));

		// 起一个上游再立刻关掉，拿到一个确定无监听的端口（复现死端口 53517）
		const dead = await startFakeUpstream();
		const deadPort = dead.port;
		await dead.close();

		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 500,
			upstreamDownMs: 60_000,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const raw = await rawHttpGet(relay.port, `http://127.0.0.1:${tPort}/api`);
		expect(raw).toContain("200");
		expect(raw).toContain("ok-direct");
	});

	test("普通 HTTP 转发：回环目标（127.0.0.1）不送上上游，始终直连", async () => {
		// 本地 HTTP 服务（模拟 127.0.0.1:9778 的 bridge）
		const httpTarget = httpCreateServer((_req, res) => res.end("ok-bridge"));
		await new Promise<void>((r) => httpTarget.listen(0, "127.0.0.1", r));
		const tPort = (httpTarget.address() as AddressInfo).port;
		cleanups.push(() => new Promise<void>((r) => httpTarget.close(() => r())));

		// 上游在线且会记录请求——回环请求不应到达它
		let upstreamHits = 0;
		const fakeHttpUpstream = httpCreateServer((_req, res) => {
			upstreamHits++;
			res.end("ok-upstream");
		});
		await new Promise<void>((r) => fakeHttpUpstream.listen(0, "127.0.0.1", r));
		const uPort = (fakeHttpUpstream.address() as AddressInfo).port;
		cleanups.push(
			() => new Promise<void>((r) => fakeHttpUpstream.close(() => r())),
		);

		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${uPort}`,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const raw = await rawHttpGet(
			relay.port,
			`http://127.0.0.1:${tPort}/bridge/tool`,
		);
		expect(raw).toContain("200");
		expect(raw).toContain("ok-bridge");
		expect(upstreamHits).toBe(0);
	});
});
