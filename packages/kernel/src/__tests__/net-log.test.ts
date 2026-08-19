// net-log 测试：上限计算（按磁盘）、URL 脱敏、滚动写文件、中继日志接入

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	NetLogger,
	NET_LOG_HARD_CAP,
	formatBytes,
	resolveNetLogMaxBytes,
	sanitizeUrlForLog,
} from "../net-log";

const dirs: string[] = [];
afterEach(async () => {
	while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "net-log-test-"));
	dirs.push(d);
	return d;
}

describe("resolveNetLogMaxBytes（按实际磁盘定上限）", () => {
	test("读不到空闲（undefined/0/负数）→ 硬顶 50MB", () => {
		expect(resolveNetLogMaxBytes(undefined)).toBe(NET_LOG_HARD_CAP);
		expect(resolveNetLogMaxBytes(0)).toBe(NET_LOG_HARD_CAP);
		expect(resolveNetLogMaxBytes(-1)).toBe(NET_LOG_HARD_CAP);
	});

	test("空闲充足（10GB）→ 顶到 50MB 硬上限", () => {
		expect(resolveNetLogMaxBytes(10 * 1024 ** 3)).toBe(NET_LOG_HARD_CAP);
	});

	test("空闲 500MB → 1% = 5MB", () => {
		expect(resolveNetLogMaxBytes(500 * 1024 ** 2)).toBe(5 * 1024 ** 2);
	});

	test("空闲极小（10MB）→ 兜底 1MB 下限", () => {
		expect(resolveNetLogMaxBytes(10 * 1024 ** 2)).toBe(1 * 1024 ** 2);
	});
});

describe("sanitizeUrlForLog（不记敏感信息）", () => {
	test("去掉 query 和 hash", () => {
		expect(sanitizeUrlForLog("https://api.example.com/v1/chat?key=sk-secret#frag")).toBe(
			"https://api.example.com/v1/chat",
		);
	});

	test("去掉 userinfo", () => {
		expect(sanitizeUrlForLog("http://user:pass@proxy.local:8080/x?a=1")).toBe(
			"http://proxy.local:8080/x",
		);
	});

	test("非 URL（CONNECT 的 host:port）原样返回", () => {
		expect(sanitizeUrlForLog("api.example.com:443")).toBe("api.example.com:443");
	});
});

describe("NetLogger 滚动", () => {
	test("超过上限改名 .1 重开，当前文件从 0 增长", async () => {
		const dir = await tempDir();
		const file = join(dir, "network.log");
		// 上限 100B：每行约 40B（时间戳+内容），写 10 行必然滚动
		const logger = new NetLogger(file, 100);
		for (let i = 0; i < 10; i++) logger.log(`CONNECT example.com:443 → 直连 #${i}`);

		expect(existsSync(`${file}.1`)).toBe(true);
		const cur = await stat(file);
		expect(cur.size).toBeLessThanOrEqual(100 + 100); // 当前文件 <= 上限 + 单行
		const backup = await readFile(`${file}.1`, "utf8");
		expect(backup).toContain("CONNECT example.com:443");
	});

	test("未超上限不滚动", async () => {
		const dir = await tempDir();
		const file = join(dir, "network.log");
		const logger = new NetLogger(file, 10 * 1024);
		logger.log("relay 上游变更 → 直连");
		logger.log("CONNECT example.com:443 → 直连隧道建立");
		expect(existsSync(`${file}.1`)).toBe(false);
		const content = await readFile(file, "utf8");
		expect(content).toContain("relay 上游变更");
		expect(content).toContain("隧道建立");
	});
});

describe("formatBytes", () => {
	test("B/KB/MB 分档", () => {
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(1023)).toBe("1023B");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("中继日志接入", () => {
	test("CONNECT 与普通 HTTP 均产出含 url/路由/状态码/耗时的日志行", async () => {
		const { ProxyRelay } = await import("../proxy-relay");
		const { createServer, Socket } = await import("node:net");
		const { createServer: httpCreateServer } = await import("node:http");
		const lines: string[] = [];
		// 回显目标（CONNECT 用）
		const target = createServer((s) => s.pipe(s));
		await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
		const tPort = (target.address() as import("node:net").AddressInfo).port;
		// HTTP 目标（普通请求用）
		const httpTarget = httpCreateServer((req, res) => {
			res.writeHead(201).end("ok");
		});
		await new Promise<void>((r) => httpTarget.listen(0, "127.0.0.1", r));
		const hPort = (httpTarget.address() as import("node:net").AddressInfo).port;

		const relay = new ProxyRelay({ upstream: "", logger: (l) => lines.push(l) });
		await relay.start();

		// CONNECT 隧道
		await new Promise<void>((resolve, reject) => {
			const c = new Socket();
			c.connect(relay.port, "127.0.0.1", () =>
				c.write(`CONNECT 127.0.0.1:${tPort} HTTP/1.1\r\nHost: 127.0.0.1:${tPort}\r\n\r\n`),
			);
			let buf = Buffer.alloc(0);
			c.on("data", (d: Buffer) => {
				buf = Buffer.concat([buf, d]);
				if (buf.indexOf("\r\n\r\n") !== -1) {
					c.write("ping");
					c.once("data", () => {
						c.destroy();
						resolve();
					});
				}
			});
			c.on("error", reject);
		});

		// 普通 HTTP GET（absolute-form）
		await new Promise<void>((resolve, reject) => {
			const c = new Socket();
			c.connect(relay.port, "127.0.0.1", () =>
				c.write(
					`GET http://127.0.0.1:${hPort}/api/chat?key=sk-secret HTTP/1.1\r\nHost: 127.0.0.1:${hPort}\r\nConnection: close\r\n\r\n`,
				),
			);
			c.on("data", () => {});
			c.on("close", () => resolve());
			c.on("error", reject);
		});
		// 日志在响应状态行读取/隧道关闭后写入，稍作等待
		await new Promise((r) => setTimeout(r, 50));

		expect(lines.some((l) => l.includes("relay 上游变更 → 直连"))).toBe(true);

		// CONNECT：隧道关闭后一条，含目标/路由/结果/时长/上下行字节
		const connectLine = lines.find(
			(l) => l.includes(`CONNECT 127.0.0.1:${tPort}`) && l.includes("via=direct"),
		);
		expect(connectLine).toBeDefined();
		expect(connectLine).toContain("result=ok");
		expect(connectLine).toMatch(/durMs=\d+/);
		expect(connectLine).toMatch(/up=\d+B/);
		expect(connectLine).toMatch(/down=\d+B/);
		// 隧道日志只在关闭时记一条
		expect(
			lines.filter((l) => l.includes(`CONNECT 127.0.0.1:${tPort}`)).length,
		).toBe(1);

		// 普通 HTTP：含真实状态码
		const getLine = lines.find(
			(l) => l.startsWith("GET ") && l.includes(`127.0.0.1:${hPort}`),
		);
		expect(getLine).toBeDefined();
		expect(getLine).toContain("via=direct");
		expect(getLine).toContain("result=ok");
		expect(getLine).toContain("status=201");
		expect(getLine).toMatch(/durMs=\d+/);
		// 脱敏：query 里的密钥不落日志
		expect(getLine).not.toContain("sk-secret");

		// 上游变更去重：再次 setUpstream("") 不刷重复行
		const before = lines.filter((l) => l.includes("relay 上游变更")).length;
		relay.setUpstream("");
		expect(lines.filter((l) => l.includes("relay 上游变更")).length).toBe(before);

		await relay.close();
		target.close();
		httpTarget.close();
	});

	test("CONNECT 失败：立即记 result=fail + 状态码 + 错误原因", async () => {
		const { ProxyRelay } = await import("../proxy-relay");
		const { Socket } = await import("node:net");
		const lines: string[] = [];
		const relay = new ProxyRelay({ upstream: "", logger: (l) => lines.push(l) });
		await relay.start();

		// 1 端口几乎不可能有监听
		await new Promise<void>((resolve, reject) => {
			const c = new Socket();
			c.connect(relay.port, "127.0.0.1", () =>
				c.write("CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n"),
			);
			c.on("data", () => {});
			c.on("close", () => resolve());
			c.on("error", reject);
		});
		await new Promise((r) => setTimeout(r, 50));

		const failLine = lines.find((l) => l.includes("CONNECT 127.0.0.1:1"));
		expect(failLine).toBeDefined();
		expect(failLine).toContain("result=fail");
		expect(failLine).toContain("status=502");
		expect(failLine).toContain("err=");
		expect(failLine).toMatch(/durMs=\d+/);

		await relay.close();
	});
});
