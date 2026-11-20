/**
 * proxy-relay 上游可用性上报测试。
 *
 * 背景：中继不再回退直连，代理连不上时请求直接失败；前端需要明确知道「代理挂了」
 * 才能弹提示（否则用户只看到请求失败，不知道是代理软件没开）。
 *
 * 期望：
 * - 上游连不上（ECONNREFUSED）→ onStatus unreachable + reason
 * - 上游恢复 → onStatus ok（只在翻转时触发，不重复刷）
 * - 直连模式（upstream 空）→ 不产生任何代理状态事件
 * - 用户关代理（setUpstream("")）→ 补一个 ok(upstream="") 让前端收起告警
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { ProxyRelay, type ProxyStatus } from "../proxy-relay";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

/** 假上游：收到 CONNECT 后回 200 并保持连接（不实际转发，只验证可用性） */
async function startFakeUpstream(port = 0): Promise<{
	port: number;
	close: () => Promise<void>;
	attempts: () => number;
}> {
	let n = 0;
	const socks: Socket[] = [];
	const server = createServer((sock) => {
		n++;
		socks.push(sock);
		sock.on("data", () => sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
		sock.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	const p = (server.address() as AddressInfo).port;
	const close = async () => {
		for (const s of socks) s.destroy();
		await new Promise<void>((r) => server.close(() => r()));
	};
	cleanups.push(close);
	return { port: p, close, attempts: () => n };
}

/** 先占端口再释放，拿到确定无监听的端口 */
async function freePort(): Promise<number> {
	const tmp = await startFakeUpstream();
	const p = tmp.port;
	await tmp.close();
	return p;
}

/** 向中继发 CONNECT 并读完状态行（不关心隧道内容） */
function connectOnce(relayPort: number, target = "203.0.113.1"): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = connect(relayPort, "127.0.0.1");
		let buf = Buffer.alloc(0);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("connectOnce timeout"));
		}, 5000);
		sock.on("connect", () => {
			sock.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`);
		});
		sock.on("data", (c: Buffer) => {
			buf = Buffer.concat([buf, c]);
			const end = buf.indexOf("\r\n\r\n");
			if (end === -1) return;
			clearTimeout(timer);
			const statusLine = buf.slice(0, end).toString("latin1").split("\r\n")[0];
			sock.destroy();
			resolve(statusLine);
		});
		sock.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return cond();
}

describe("proxy-relay 上游可用性上报", () => {
	test("连不上 → unreachable（带 reason）；上游复活后 → ok", async () => {
		const events: ProxyStatus[] = [];
		const deadPort = await freePort();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 500,
			onStatus: (s) => events.push(s),
		});
		await relay.start();
		cleanups.push(() => relay.close());

		const line = await connectOnce(relay.port);
		expect(line).toContain("502");
		await waitFor(() => events.length >= 1);
		expect(events[0].state).toBe("unreachable");
		expect(events[0].upstream).toBe(`http://127.0.0.1:${deadPort}`);
		expect(events[0].reason ?? "").toContain(String(deadPort));

		// 同端口复活上游 → 下一条请求成功，状态翻回 ok
		await startFakeUpstream(deadPort);
		await connectOnce(relay.port);
		await waitFor(() => events.length >= 2);
		expect(events[1].state).toBe("ok");
		expect(events[1].upstream).toBe(`http://127.0.0.1:${deadPort}`);
	});

	test("连续成功不重复上报 ok（只在翻转时触发）", async () => {
		const events: ProxyStatus[] = [];
		const up = await startFakeUpstream();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${up.port}`,
			onStatus: (s) => events.push(s),
		});
		await relay.start();
		cleanups.push(() => relay.close());

		await connectOnce(relay.port);
		await connectOnce(relay.port);
		await waitFor(() => events.length >= 1);
		await new Promise((r) => setTimeout(r, 100));
		expect(events.length).toBe(1);
		expect(events[0].state).toBe("ok");
	});

	test("直连模式（upstream 空）不产生代理状态事件", async () => {
		const events: ProxyStatus[] = [];
		const relay = new ProxyRelay({
			upstream: "",
			onStatus: (s) => events.push(s),
		});
		await relay.start();
		cleanups.push(() => relay.close());

		// 1 端口必然不通，但这是直连目标的失败，不是代理不可达
		await connectOnce(relay.port, "127.0.0.1").catch(() => "502");
		await new Promise((r) => setTimeout(r, 100));
		expect(events.length).toBe(0);
	});

	test("用户关代理（setUpstream 清空）→ 补一个 ok(upstream=\"\") 收起告警", async () => {
		const events: ProxyStatus[] = [];
		const deadPort = await freePort();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 500,
			onStatus: (s) => events.push(s),
		});
		await relay.start();
		cleanups.push(() => relay.close());

		await connectOnce(relay.port);
		await waitFor(() => events.length >= 1);
		expect(events[0].state).toBe("unreachable");

		relay.setUpstream("");
		await waitFor(() => events.length >= 2);
		expect(events[1]).toEqual({ state: "ok", upstream: "" });
	});
});
