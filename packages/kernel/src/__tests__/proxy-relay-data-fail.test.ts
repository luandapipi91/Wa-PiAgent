/**
 * proxy-relay 数据面失败测试。
 *
 * 背景：上游代理「TCP 可连 + CONNECT 返回 200 + 隧道数据面死」是节点全挂的常见形态。
 * 中继在 200 之后连接层看不到失败，靠「隧道关闭时目标零回应」兜底判出口死。
 *
 * 但「零回应」也可能是浏览器 preconnect（连上不发数据就关）这种正常行为。
 * 判定必须排除它们：要求确实发过请求数据、且隧道持续超过 1s。
 *
 * 期望：
 * - 出口真死（发过请求 + 零回应 + 持续 >1s）→ 记冷却，后续请求快速 502（不回退直连）
 * - preconnect（不发数据即关）→ 不判死，后续请求照旧走上游
 * - 健康出口 → 不判死
 */
import { describe, test, expect } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { ProxyRelay } from "../proxy-relay";

/** 非内网目标（绕过 isDirectHost 直连豁免），实际不通也无妨——断言只看中继行为 */
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
 *   deadOutlet=true：等 deadDelayMs 后 destroy（模拟出口死后拖到超时的 RST）
 *   deadOutlet=false：回一段目标响应再关（健康出口）
 */
async function makeUpstream(
	deadOutlet: boolean,
	deadDelayMs = 0,
): Promise<{
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
				// 出口死：数据有去无回，连接要拖一会儿才断
				setTimeout(() => sock.destroy(), deadDelayMs);
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

/** 客户端：连中继发 CONNECT，resolve 于收到状态行（或连接被销毁） */
function connectVia(
	port: number,
): Promise<{ sock: Socket; statusLine: string; established: boolean }> {
	return new Promise((resolve) => {
		const sock = connect(port, "127.0.0.1");
		let buf = Buffer.alloc(0);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			const text = buf.toString("latin1");
			const end = text.indexOf("\r\n");
			resolve({
				sock,
				statusLine: end === -1 ? text : text.slice(0, end),
				established: text.includes("200 Connection"),
			});
		};
		sock.on("connect", () => {
			sock.write(`CONNECT ${TARGET} HTTP/1.1\r\nHost: ${TARGET}\r\n\r\n`);
		});
		sock.on("data", (c: Buffer) => {
			buf = Buffer.concat([buf, c]);
			if (buf.includes("\r\n\r\n")) finish();
		});
		sock.on("close", finish);
		sock.on("error", () => {});
	});
}

async function makeHarness(
	deadOutlet: boolean,
	deadDelayMs = 0,
): Promise<Harness> {
	const up = await makeUpstream(deadOutlet, deadDelayMs);
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
	timeoutMs = 5000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

describe("proxy-relay 上游数据面失败", () => {
	test("出口死（发过请求 + 零回应 + 持续 >1s）：记冷却，后续请求快速 502 不撞上游", async () => {
		const h = await makeHarness(true, 1200);
		try {
			// 第一条：隧道"建立"（200）后出口死，客户端发数据有去无回
			const c1 = await connectVia(h.port);
			expect(c1.established).toBe(true);
			c1.sock.write("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
			await waitFor(() => h.logs.some((l) => l.includes("出口疑似不可用")));

			// 第二条：冷却期直接 502，不再连上游（也不偷偷回退直连）
			const connsBefore = h.upConns();
			const c2 = await connectVia(h.port);
			expect(c2.established).toBe(false);
			expect(c2.statusLine).toContain("502");
			c2.sock.destroy();
			expect(h.upConns()).toBe(connsBefore);
		} finally {
			await h.cleanup();
		}
	});

	test("preconnect（连上不发数据即关）：不判出口死，后续照旧走上游", async () => {
		const h = await makeHarness(true, 1200);
		try {
			// 浏览器预连接：建立隧道后立刻关，一个字节都不发
			const c1 = await connectVia(h.port);
			expect(c1.established).toBe(true);
			c1.sock.destroy();
			// 给它足够时间越过 1s 门槛（若误判就会在这段时间里触发冷却）
			await new Promise((r) => setTimeout(r, 1500));
			expect(h.logs.some((l) => l.includes("出口疑似不可用"))).toBe(false);

			// 第二条仍会尝试上游
			const connsBefore = h.upConns();
			const c2 = await connectVia(h.port);
			await waitFor(() => h.upConns() > connsBefore);
			expect(h.upConns()).toBeGreaterThan(connsBefore);
			c2.sock.destroy();
		} finally {
			await h.cleanup();
		}
	});

	test("健康出口（有数据往返）：不记冷却", async () => {
		const h = await makeHarness(false);
		try {
			const c1 = await connectVia(h.port);
			expect(c1.established).toBe(true);
			c1.sock.write("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
			await waitFor(() => h.logs.some((l) => l.includes("via=upstream")));
			c1.sock.end();
			expect(h.logs.some((l) => l.includes("出口疑似不可用"))).toBe(false);

			const connsBefore = h.upConns();
			const c2 = await connectVia(h.port);
			await waitFor(() => h.upConns() > connsBefore);
			expect(h.upConns()).toBeGreaterThan(connsBefore);
			c2.sock.destroy();
		} finally {
			await h.cleanup();
		}
	});
});
