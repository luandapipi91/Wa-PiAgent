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

/**
 * 上游可用性上报防抖测试。
 *
 * 背景：报障「代理连接失败反复弹」。根因：① 无冷却后每条请求的结果都直接当
 * 翻转信号，半死上游以请求频率产生 ok↔unreachable 抖动；② setUpstream 每次都
 * 重置 lastState，系统代理注册项抖动（""↔7890）时去重防线被反复拆掉。
 * 修复：两处都加 1s 尾沿防抖（测试用短窗口加速）。
 */
describe("上游可用性上报防抖", () => {
	test(
		"unreachable→ok→unreachable 快速抖动只广播最终状态（不再反复弹）",
		async () => {
			const events: ProxyStatus[] = [];
			const deadPort = await freePort();
			const relay = new ProxyRelay({
				upstream: `http://127.0.0.1:${deadPort}`,
				connectTimeoutMs: 100,
				statusDebounceMs: 500,
				onStatus: (s) => events.push(s),
			});
			await relay.start();
			cleanups.push(() => relay.close());

			// 1. 死上游 → 请求 A 失败 → unreachable（防抖后广播）
			await connectOnce(relay.port);
			await waitFor(() => events.length >= 1);
			expect(events[0].state).toBe("unreachable");

			// 2. 500ms 窗口内：复活上游（ok 被调度）→ 立刻杀掉（unreachable 覆盖 ok）
			const up = await startFakeUpstream(deadPort);
			await connectOnce(relay.port); // 请求 B：CONNECT 200 → ok 目标入队
			await up.close(); // 杀上游
			await connectOnce(relay.port); // 请求 C：失败 → unreachable 覆盖 ok

			// 3. 防抖语义：请求 B 的 ok 在窗口内被请求 C 抖回撤销（状态已与已广播的
			//    unreachable 一致，无需再播）→ 全程只广播过一条 unreachable，
			//    前端不会经历「弹恢复→又弹失败」的反复弹
			await new Promise((r) => setTimeout(r, 1000)); // 静置 > statusDebounceMs 确认无后续广播
			expect(events.length).toBe(1);
			expect(events[0].state).toBe("unreachable");
		},
		20000,
	);

	test(
		"同值重复 setUpstream 跳过（不重置去重防线）：失败请求不重复广播 unreachable",
		async () => {
			const events: ProxyStatus[] = [];
			const deadPort = await freePort();
			const relay = new ProxyRelay({
				upstream: `http://127.0.0.1:${deadPort}`,
				connectTimeoutMs: 100,
				statusDebounceMs: 300,
				onStatus: (s) => events.push(s),
			});
			await relay.start();
			cleanups.push(() => relay.close());

			// 请求失败 → unreachable 广播（前端弹告警）
			await connectOnce(relay.port);
			await waitFor(() => events.length >= 1);
			expect(events[0].state).toBe("unreachable");

			// 同值重复调用（保存设置会触发多次 applySystemProxy）：直接跳过，
			// 不重置 lastState —— 去重防线完好，后一条失败请求不重复广播
			relay.setUpstream(`http://127.0.0.1:${deadPort}`);
			relay.setUpstream(`http://127.0.0.1:${deadPort}`);
			await new Promise((r) => setTimeout(r, 600));

			await connectOnce(relay.port);
			await new Promise((r) => setTimeout(r, 800));
			expect(events.length).toBe(1);
		},
		20000,
	);

	test("上游地址变更立即应用（保存设置契约）+ 新上游正常上报", async () => {
		const events: ProxyStatus[] = [];
		const deadPort = await freePort();
		const otherDead = await freePort();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 100,
			statusDebounceMs: 200,
			onStatus: (s) => events.push(s),
		});
		await relay.start();
		cleanups.push(() => relay.close());

		relay.setUpstream(`http://127.0.0.1:${otherDead}`);
		expect(relay.getUpstream()).toBe(`http://127.0.0.1:${otherDead}`);
		// 换了个死上游：一条失败请求照常上报 unreachable（功能不被防抖破坏）
		await connectOnce(relay.port);
		await waitFor(() => events.length >= 1);
		expect(events[0].state).toBe("unreachable");
		expect(events[0].upstream).toBe(`http://127.0.0.1:${otherDead}`);
	}, 20000);
	test(
		"防抖窗口内 getStatus() 只返回已广播的稳定状态（窗口内观测未落地，补拉不读）",
		async () => {
			const deadPort = await freePort();
			const relay = new ProxyRelay({
				upstream: `http://127.0.0.1:${deadPort}`,
				connectTimeoutMs: 100,
				statusDebounceMs: 3000, // 拉长窗口，验证广播未落地时快照不读窗口内观测
				onStatus: () => {},
			});
			await relay.start();
			cleanups.push(() => relay.close());

			// 窗口内观测可能被抖回撤销：补拉若读了 pending，会停留在一个不再有
			// 事件纠正的错误状态上（幽灵告警/告警静默丢失），所以只读已落地状态
			await connectOnce(relay.port); // 失败 → unreachable 入队（3s 窗口内不广播）
			await new Promise((r) => setTimeout(r, 150));
			expect(relay.getStatus()).toBeNull();

			// 广播落地后：快照读到稳定状态
			await new Promise((r) => setTimeout(r, 3200));
			expect(relay.getStatus()?.state).toBe("unreachable");
		},
		20000,
	);
});

describe("上游失败回调（供重读系统代理）", () => {
	test("连不上 → 触发 onUpstreamFail", async () => {
		let fails = 0;
		const deadPort = await freePort();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${deadPort}`,
			connectTimeoutMs: 500,
			onUpstreamFail: () => fails++,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		await connectOnce(relay.port);
		await waitFor(() => fails >= 1);
		expect(fails).toBeGreaterThanOrEqual(1);
	});

	test("上游正常 → 不触发 onUpstreamFail", async () => {
		let fails = 0;
		const up = await startFakeUpstream();
		const relay = new ProxyRelay({
			upstream: `http://127.0.0.1:${up.port}`,
			onUpstreamFail: () => fails++,
		});
		await relay.start();
		cleanups.push(() => relay.close());

		await connectOnce(relay.port);
		await new Promise((r) => setTimeout(r, 100));
		expect(fails).toBe(0);
	});
});
