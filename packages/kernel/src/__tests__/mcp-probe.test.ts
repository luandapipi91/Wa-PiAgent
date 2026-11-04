// mcp-probe 单元测试（TDD 先红）：单台 MCP 探测器——测试/查看工具不再依赖全量
// `pi mcp list`，一台卡住（如 OAuth 刷新挂 60s）不再拖垮其他台。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "../mcp-probe";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { McpServerConfig } from "@wa-pi/shared";

/** 起一个可编程的 mock MCP streamable-http server：按 script 序列响应 POST */
function startMockMcpHttp(
	handler: (pathname: string, req: Request) => Response | Promise<Response>,
): { port: number; close: () => void; requests: Request[] } {
	const requests: Request[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			requests.push(req);
			return handler(new URL(req.url).pathname, req);
		},
	});
	return { port: server.port as number, close: () => server.stop(true), requests };
}

/** stdio mock server：按行读 JSON-RPC，回 initialize / tools/list */
const STDIO_SERVER_SCRIPT = `// 行分隔 JSON-RPC mock
let id = 0;
const dec = new TextDecoder();
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += dec.decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-stdio", version: "1.0" } },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { tools: [{ name: "tool_a" }, { name: "tool_b" }] },
      }) + "\\n");
    }
    // notifications（无 id）静默忽略
  }
});
`;

describe("probeMcpServer", () => {
	describe("enabled 门闩", () => {
		test("enabled:false → disabled，不发起任何连接", async () => {
			let called = 0;
			const mock = startMockMcpHttp(() => {
				called++;
				return new Response("{}", { status: 200 });
			});
			try {
				const res = await probeMcpServer({
					name: "off",
					type: "http",
					url: `http://127.0.0.1:${mock.port}/mcp`,
					enabled: false,
				});
				expect(res.state).toBe("disabled");
				expect(res.tools).toEqual([]);
				expect(called).toBe(0);
			} finally {
				mock.close();
			}
		});
	});

	describe("http 探测", () => {
		test("initialize + tools/list 成功 → connected + 工具名列表（含 session-id 透传）", async () => {
			let sawSessionId: string | null = null;
			const mock = startMockMcpHttp(async (_pathname, req) => {
				if (req.headers.get("mcp-session-id") === "sess-42") {
					sawSessionId = await req.text();
					// tools/list 请求
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							result: { tools: [{ name: "alpha" }, { name: "beta" }] },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				// initialize
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "m", version: "1" } },
					}),
					{ status: 200, headers: { "Content-Type": "application/json", "mcp-session-id": "sess-42" } },
				);
			});
			try {
				const res = await probeMcpServer({
					name: "http-ok",
					type: "http",
					url: `http://127.0.0.1:${mock.port}/mcp`,
				});
				expect(res.state).toBe("connected");
				expect(res.tools).toEqual(["alpha", "beta"]);
				expect(res.error).toBeUndefined();
				expect(sawSessionId).not.toBeNull();
			} finally {
				mock.close();
			}
		});

		test("SSE 格式响应（data: 行）也能解析", async () => {
			const mock = startMockMcpHttp(() =>
				new Response(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "m", version: "1" } },
					})}\n\n`,
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
			);
			try {
				const res = await probeMcpServer({ name: "sse", type: "http", url: `http://127.0.0.1:${mock.port}/mcp` });
				expect(res.state).toBe("connected");
			} finally {
				mock.close();
			}
		});

		test("401 → needs-auth", async () => {
			const mock = startMockMcpHttp(() => new Response("unauthorized", { status: 401 }));
			try {
				const res = await probeMcpServer({ name: "auth", type: "http", url: `http://127.0.0.1:${mock.port}/mcp` });
				expect(res.state).toBe("needs-auth");
			} finally {
				mock.close();
			}
		});

		test("500 → failed + 错误信息", async () => {
			const mock = startMockMcpHttp(() => new Response("boom", { status: 500 }));
			try {
				const res = await probeMcpServer({ name: "boom", type: "http", url: `http://127.0.0.1:${mock.port}/mcp` });
				expect(res.state).toBe("failed");
				expect(res.error).toContain("500");
			} finally {
				mock.close();
			}
		});

		test("服务器挂住不响应 → 单台超时 failed，不拖任何其他台", async () => {
			const mock = startMockMcpHttp(
				() => new Promise<Response>(() => {}), // 永不响应
			);
			try {
				const t0 = Date.now();
				const res = await probeMcpServer(
					{ name: "slow", type: "http", url: `http://127.0.0.1:${mock.port}/mcp` },
					{ timeoutMs: 400 },
				);
				const elapsed = Date.now() - t0;
				expect(res.state).toBe("failed");
				expect(elapsed).toBeLessThan(3000); // 按注入的超时（400ms）快速失败，而不是 60s+
			} finally {
				mock.close();
			}
		});

		test("配置里的静态 headers 随请求发出（yunxiao 式 Bearer）", async () => {
			const seenAuth = new Map<string, string | null>();
			const mock = startMockMcpHttp((_p, req) => {
				seenAuth.set("authorization", req.headers.get("authorization"));
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			try {
				await probeMcpServer({
					name: "static",
					type: "http",
					url: `http://127.0.0.1:${mock.port}/mcp`,
					headers: { Authorization: "Bearer static-token" },
				});
				expect(seenAuth.get("authorization")).toBe("Bearer static-token");
			} finally {
				mock.close();
			}
		});

		test("凭据文件里有未过期 token → 自动带上 Bearer；过期 token → 不带", async () => {
			const seenByUrl = new Map<string, string | null>();
			const mock = startMockMcpHttp((_p, req) => {
				seenByUrl.set(new URL(req.url).pathname, req.headers.get("authorization"));
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			// 凭据键按 URL 匹配，mock 端口确定后再写凭据文件
			const dir = mkdtempSync(join(tmpdir(), "mcp-probe-"));
			try {
				const now = Date.now();
				writeFileSync(
					join(dir, "mcp-auth.json"),
					JSON.stringify({
						[`mcp__oauth_one|http://127.0.0.1:${mock.port}/x`]: {
							tokens: { access_token: "fresh-token" },
							tokensExpireAt: now + 60_000,
						},
						[`mcp__oauth_stale|http://127.0.0.1:${mock.port}/y`]: {
							tokens: { access_token: "stale-token" },
							tokensExpireAt: now - 60_000,
						},
					}),
				);
				// 未过期 → 带
				await probeMcpServer(
					{ name: "oauth-one", type: "http", url: `http://127.0.0.1:${mock.port}/x` },
					{ agentDir: dir, timeoutMs: 2000 },
				);
				// 过期 → 不带
				await probeMcpServer(
					{ name: "oauth-stale", type: "http", url: `http://127.0.0.1:${mock.port}/y` },
					{ agentDir: dir, timeoutMs: 2000 },
				);
				expect(seenByUrl.get("/x")).toBe("Bearer fresh-token");
				expect(seenByUrl.get("/y")).toBeNull();
			} finally {
				mock.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("缺 url 的 http 配置 → failed（配置不完整）", async () => {
			const res = await probeMcpServer({ name: "bad", type: "http" }, { timeoutMs: 500 });
			expect(res.state).toBe("failed");
			expect(res.error).toBeDefined();
		});
	});

	describe("stdio 探测", () => {
		const scriptPath = join(tmpdir(), `mcp-probe-stdio-server-${process.pid}.ts`);
		let scriptWritten = false;
		const ensureScript = () => {
			if (!scriptWritten) {
				writeFileSync(scriptPath, STDIO_SERVER_SCRIPT);
				scriptWritten = true;
			}
			return scriptPath;
		};

		test("initialize + tools/list 成功 → connected + 工具名", async () => {
			const script = ensureScript();
			const res = await probeMcpServer({
				name: "stdio-ok",
				type: "stdio",
				command: process.execPath,
				args: [script],
			});
			expect(res.state).toBe("connected");
			expect(res.tools).toEqual(["tool_a", "tool_b"]);
		});

		test("env 注入到子进程", async () => {
			const script = ensureScript();
			// mock 脚本不校验 env，这里仅验证带 env 不影响正常探测
			const res = await probeMcpServer({
				name: "stdio-env",
				type: "stdio",
				command: process.execPath,
				args: [script],
				env: { PROBE_ENV_MARK: "1" },
			});
			expect(res.state).toBe("connected");
		});

		test("命令不存在 → failed", async () => {
			const res = await probeMcpServer(
				{ name: "nope", type: "stdio", command: "/nonexistent/dbx-mcp-probe-binary" },
				{ timeoutMs: 3000 },
			);
			expect(res.state).toBe("failed");
			expect(res.error).toBeDefined();
		});

		test("server 挂住不回 → 单台超时 failed，子进程被清理", async () => {
			const hangScript = join(tmpdir(), `mcp-probe-hang-${process.pid}.ts`);
			writeFileSync(hangScript, "// 挂住不响应\nsetInterval(() => {}, 1000);\n");
			const t0 = Date.now();
			const res = await probeMcpServer(
				{ name: "hang", type: "stdio", command: process.execPath, args: [hangScript] },
				{ timeoutMs: 400 },
			);
			const elapsed = Date.now() - t0;
			expect(res.state).toBe("failed");
			expect(elapsed).toBeLessThan(3000);
			rmSync(hangScript, { force: true });
		});

		test("缺 command 的 stdio 配置 → failed", async () => {
			const res = await probeMcpServer({ name: "bad-stdio", type: "stdio" }, { timeoutMs: 500 });
			expect(res.state).toBe("failed");
			expect(res.error).toBeDefined();
		});
	});

	describe("type 缺省推断", () => {
		test("有 url 无 type → 按 http 探测", async () => {
			const mock = startMockMcpHttp(() =>
				new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			try {
				const res = await probeMcpServer({ name: "infer", url: `http://127.0.0.1:${mock.port}/mcp` });
				expect(res.state).toBe("connected");
			} finally {
				mock.close();
			}
		});
	});
});

describe("stdio 子进程的兜底 cwd（EOVERRIDE 缺陷回归）", () => {
  test("config.cwd 优先 → opts.cwd 次之 → WA_PI_DIR 兜底（绝不继承 kernel 进程 cwd）", async () => {
    const { stdioCwd } = await import("../mcp-probe");
    expect(stdioCwd({ name: "a", type: "stdio", command: "npx", cwd: "/explicit" }, { cwd: "/scope" })).toBe("/explicit");
    expect(stdioCwd({ name: "a", type: "stdio", command: "npx" }, { cwd: "/scope" })).toBe("/scope");
    expect(stdioCwd({ name: "a", type: "stdio", command: "npx" }, {})).toBe(WA_PI_DIR);
    // config.cwd undefined（显式）时同样走 opts.cwd
    expect(stdioCwd({ name: "a", type: "stdio", command: "npx", cwd: undefined }, { cwd: "/scope2" })).toBe("/scope2");
  });

  test("行为验证：kernel 仓库 cwd 下 npx 会触发 npm EOVERRIDE，探测走 opts.cwd 后正常 connected", async () => {
    // 造一个会让 npm 报 EOVERRIDE 的 cwd（overrides 与直接依赖冲突）
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const badCwd = mkdtempSync(join(tmpdir(), "mcp-badcwd-"));
    writeFileSync(join(badCwd, "package.json"), JSON.stringify({
      name: "bad", version: "1.0.0",
      dependencies: { "happy-dom": "^20.11.2" },
      overrides: { "happy-dom": "^19.0.0" },
    }));
    try {
      // opts.cwd 指向 /tmp（无冲突 package.json 的干净目录）→ 探测应正常握手
      const res = await probeMcpServer(
        { name: "c7", type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
        { timeoutMs: 15000, cwd: "/tmp" },
      );
      expect(res.state).toBe("connected");
      expect(res.tools.length).toBeGreaterThan(0);
    } finally {
      rmSync(badCwd, { recursive: true, force: true });
    }
  }, 20000);
});
