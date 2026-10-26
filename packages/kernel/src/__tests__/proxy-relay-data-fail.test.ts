/**
 * proxy-relay 数据面失败回退测试。
 *
 * 背景：上游代理「TCP 可连 + CONNECT 返回 200 + 隧道数据面死」是 Clash/v2rayN
 * 节点全挂的最常见形态。修复前中继在 200 后 settled=true，隧道内失败既不记
 * 冷却也不回退直连，导致开关开着时每条请求都撞死节点、永不自愈。
 *
 * 期望行为：经上游的隧道关闭时若目标零回应（连 TLS ServerHello 都没有，
 * downBytes===0），判定上游出口死 → 记冷却，后续请求（含客户端自动重试）
 * 在冷却期内走直连；有数据往返的正常隧道不受影响。
 */
import { describe, test, expect } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { ProxyRelay } from "../proxy-relay";

/** 非内网目标（绕过 isDirectHost 直连豁免），实际不通也无妨——断言只看中继日志 */
const TARGET = "api.example.com:443";

interface Harness {
	relay: ProxyRelay;
	port: number;
	logs: string[];
	upConns: () => number;
	cleanup: () => Promise<void>;
}

/**
 * 上游 mock（状态机）：
 * - 首个含 \r\n\r\n 的 data = CONNECT 头 → 回 200 建立隧道
 * - 之后任意 data = 隧道内客户端请求（如 TLS ClientHello）→
 *   deadOutlet=true：不回任何数据直接 destroy（模拟出口死后 RST）
 *   deadOutlet=false：回一段目标响应再关（健康出口）
 */
async function makeUpstream(deadOutlet: boolean): Promise<{
	server: Server;
	port: number;
	conns: () => number;
}> {
	let n = 0;
	const server = createServer((sock: Socket) => {
		n++;
		let gotConnect = false;
		sock.on("data", () => {
			if (!gotConnect) {
				gotConnect = true;
				sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				return;
			}
			if (deadOutlet) {
				sock.destroy();
			} else {
				sock.write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello");
				sock.end();
			}
		});
		sock.on("error", () => {});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { server, port, conns: () => n };
}

/** 客户端：连中继发 CONNECT，resolve 于收到 200（或连接被销毁）。data 为 getter，始终返回最新累积缓冲 */
function connectVia(
	port: number,
): Promise<{ sock: Socket; established: boolean; data: Buffer }> {
	return new Promise((resolve) => {
		const sock = connect(port, "127.0.0.1");
		const chunks: Buffer[] = [];
		let joined = Buffer.alloc(0);
		let established = false;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve({
				sock,
				established,
				get data() {
					return joined;
				},
			});
		};
		sock.on("connect", () => {
			sock.write(`CONNECT ${TARGET} HTTP/1.1\r\nHost: ${TARGET}\r\n\r\n`);
		});
		sock.on("data", (c: Buffer) => {
			chunks.push(c);
			joined = Buffer.concat(chunks);
			if (!established && joined.includes("200 Connection")) {
				established = true;
				finish();
			}
		});
		sock.on("close", finish);
		sock.on("error", () => {});
	});
}

async function makeHarness(deadOutlet: boolean): Promise<Harness> {
	const up = await makeUpstream(deadOutlet);
	const logs: string[] = [];
	const relay = new ProxyRelay({
		upstream: `http://127.0.0.1:${up.port}`,
		connectTimeoutMs: 800,
		upstreamDownMs: 15_000,
		logger: (line) => logs.push(line),
	});
	const port = await relay.start();
	return {
		relay,
		port,
		logs,
		upConns: up.conns,
		cleanup: async () => {
			await relay.close();
			await new Promise<void>((r) => up.server.close(() => r()));
		},
	};
}

/** 等待条件成立（轮询日志） */
async function waitFor(
	cond: () => boolean,
	timeoutMs = 3000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

describe("proxy-relay 上游数据面失败回退", () => {
	test("上游 200 后出口死：记冷却，后续请求回退直连", async () => {
		const h = await makeHarness(true);
		try {
			// 第一条：隧道"建立"（200）后出口死，客户端发数据即被 RST
			const c1 = await connectVia(h.port);
			expect(c1.established).toBe(true);
			c1.sock.write("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
			await waitFor(() => c1.sock.destroyed || !c1.sock.writable);
			await waitFor(() =>
				h.logs.some((l) => l.includes("出口疑似不可用")),
			);

			// 第二条：应落在冷却期，走直连、不再连上游
			const connsBefore = h.upConns();
			const c2 = await connectVia(h.port);
			await waitFor(() =>
				h.logs.some((l) => l.includes(TARGET) && l.includes("direct(cooldown)")),
			);
			expect(
				h.logs.some((l) => l.includes(TARGET) && l.includes("direct(cooldown)")),
			).toBe(true);
			expect(h.upConns()).toBe(connsBefore); // 上游连接数未增长
			c2.sock.destroy();
		} finally {
			await h.cleanup();
		}
	});

	test("上游隧道有数据往返（健康出口）：不记冷却，后续请求继续走上游", async () => {
		const h = await makeHarness(false);
		try {
			const c1 = await connectVia(h.port);
			expect(c1.established).toBe(true);
			c1.sock.write("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
			await waitFor(() => c1.data.includes(Buffer.from("hello")));
			c1.sock.end();
			// 等隧道关闭、统计落日志
			await waitFor(() => h.logs.some((l) => l.includes("via=upstream")));
			expect(h.logs.some((l) => l.includes("出口疑似不可用"))).toBe(false);

			// 第二条：无冷却，继续走上游（完整走一次数据往返，避免「建立即销毁」
			// 触发零回应探针的误报干扰断言）
			const connsBefore = h.upConns();
			const c2 = await connectVia(h.port);
			await waitFor(() => h.upConns() > connsBefore);
			expect(h.upConns()).toBeGreaterThan(connsBefore);
			c2.sock.write("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
			await waitFor(() => c2.data.includes(Buffer.from("hello")));
			c2.sock.end();
		} finally {
			await h.cleanup();
		}
	});
});
