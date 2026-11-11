// MCP 与溢出识别契约回执（真 pi，锁 pi 1.5.2，供后续升级比对）。
//
// 五组断言（探针实测见 task-4-report.md）：
//   1. pi mcp list --json 的 servers[].state 落在 connected/failed/needs-auth/disabled
//      （四态全实证）；pi 1.5.2 新增的 authProvider 字段被 parseMcpListOutput 原样透传，
//      不影响解析。
//   2. 配置 auth:{provider} 的 server：kernel canUseOAuth 判 false（不给登录按钮）；
//      真 `pi mcp login` 直接拒绝，报错文案（stderr）能被 lastNonEmptyLine 提取。
//   3. 凭据键：写入 pi 1.0.0+ 的 "mcp__<server>|<规范化URL>" 形态 mcp-auth.json 后，
//      readMcpAuthKeys / mcpAuthKeysOf 判为已登录。
//   4. 含 "-" 的 server 名：kernel 的 mcpNamespace 复刻与上游 pi-mcp naming.js 的
//      mcpNamespace / createMcpToolName 行为一致（- → _）。
//   5. 溢出识别兜底：isContextOverflow 认不出的三条中文上游文案（火山方舟 / 百度千帆 /
//      智谱），kernel 的 estimateContextTokens（CJK 加权）在同一消息序列上的占用高于
//      chars/4 口径并越过发送前压缩阈值——kernel 在发送前触发压缩，pi 只能等上游 400
//      且事后认不出。
//
// 手段：第 1、2 组真 spawn pi（McpAdmin / McpLoginRunner 同生产消费路径），
// 第 3、4、5 组是纯函数比对，不起 pi 子进程。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import {
  canUseOAuth,
  McpAdmin,
  mcpAuthKey,
  mcpAuthKeysOf,
  mcpNamespace,
  parseMcpListOutput,
  readMcpAuthKeys,
} from "../src/mcp-admin";
import { lastNonEmptyLine, McpLoginRunner } from "../src/mcp-login";
import { resolvePiCliPath, resolvePiRuntime } from "../src/rpc-client";
import { estimateContextTokens } from "../src/context-estimate";
import { shouldCompactBeforeSend } from "../src/auto-compact";

// ---- 上游 pi-mcp naming.js（kernel 未直接依赖，从 bun store 物理路径导入）----
// 版本目录用 readdir 定位而非硬编码：升级 pi 后 store 里是新版本目录，仍能导入比对。
const storeRoot = join(import.meta.dir, "..", "..", "..", "node_modules", ".bun");
const piMcpEntry = readdirSync(storeRoot).find((d) =>
  d.startsWith("@earendil-works+pi-mcp@"),
);
if (!piMcpEntry) throw new Error(`bun store 里找不到 pi-mcp（${storeRoot}）`);
const piNaming = await import(
  join(storeRoot, piMcpEntry, "node_modules/@earendil-works/pi-mcp/dist/naming.js")
);

// ---- 第 1 组共用夹具：五台真实 server（探针同款）----
let baseDir = "";
let admin: McpAdmin | null = null;
let listResult: ReturnType<typeof parseMcpListOutput> | null = null;
const tempDirs: string[] = [];
// HTTP 401 假 server（第 1、2 组共用），afterAll 统一停
const stoppedServers: Array<{ stop: (opts?: boolean) => void }> = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 最小 stdio MCP server：行式 JSON-RPC，只应 initialize 与 tools/list（pi-mcp 行式分帧） */
async function writeMiniServer(dir: string): Promise<string> {
  const fixture = join(dir, "mini-server.mjs");
  await writeFile(
    fixture,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mini", version: "0.0.1" },
    } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: "ping", description: "reply pong", inputSchema: { type: "object", properties: {} } }],
    } }) + "\\n");
  } else if (msg.id !== undefined && msg.method?.startsWith("tools/")) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
}
`,
  );
  return fixture;
}

// 全文件统一清理（放顶层而非某个 describe 内：describe 级 afterAll 会在该组结束时
// 立即删掉 baseDir，后续 describe 的真 pi 用例还需要它）
afterAll(async () => {
  admin?.invalidate();
  for (const srv of stoppedServers) srv.stop(true);
  stoppedServers.length = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

describe("第 1 组：pi mcp list --json 的 state 值域与 authProvider 字段（真 pi）", () => {
  beforeAll(async () => {
    baseDir = await tempDir("mcp-contract-list-");
    const agentDir = join(baseDir, "agent-dir");
    await mkdir(agentDir, { recursive: true });
    const fixture = await writeMiniServer(baseDir);
    // HTTP 401 server：一台裸 401（needs-auth），一台带 auth:{provider}（第 2 组共用）
    const httpSrv = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="mini"' },
        });
      },
    });
    tempDirs.push("http-server-holder"); // 占位：保证 tempDirs 非空时目录清理顺序无碍
    stoppedServers.push(httpSrv);
    const mcpConfig = {
      mcpServers: {
        "ok-stdio": { command: process.execPath, args: [fixture] },
        "broken-stdio": { command: "definitely-not-a-real-binary-xyz" },
        "auth-401": { url: `http://127.0.0.1:${httpSrv.port}/auth401` },
        "provider-srv": {
          url: `http://127.0.0.1:${httpSrv.port}/provider`,
          auth: { provider: "volcengine" },
        },
        "off-server": { command: "definitely-not-a-real-binary-xyz", enabled: false },
      },
    };
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig));
    admin = new McpAdmin({
      runtime: resolvePiRuntime(),
      cliPath: resolvePiCliPath(),
      agentDir,
      cwd: baseDir,
      timeoutMs: 30_000,
    });
    listResult = await admin.list();
  }, 60_000);

  test("五台 server 全部报出，state 逐台落在 connected/failed/needs-auth/disabled 内", () => {
    expect(listResult!.commandFailed).toBe(false);
    const byName = new Map(listResult!.servers.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([
      "auth-401",
      "broken-stdio",
      "off-server",
      "ok-stdio",
      "provider-srv",
    ]);
    // 探针实证的四态逐台锁定（pi 1.5.2 的完整状态集）
    expect(byName.get("ok-stdio")!.state).toBe("connected");
    expect(byName.get("broken-stdio")!.state).toBe("failed");
    expect(byName.get("auth-401")!.state).toBe("needs-auth");
    expect(byName.get("provider-srv")!.state).toBe("needs-auth");
    expect(byName.get("off-server")!.state).toBe("disabled");
    const KNOWN_STATES = ["connected", "failed", "needs-auth", "disabled"];
    for (const s of listResult!.servers) {
      expect(KNOWN_STATES).toContain(s.state);
    }
    // stdio 握手成功连工具清单都拿到了（connected 不是空壳状态）
    expect(byName.get("ok-stdio")!.tools).toEqual(["ping"]);
  });

  test("authProvider 字段被 parseMcpListOutput 原样透传，不影响解析", () => {
    // pi 1.5.2 对配置 auth:{provider} 的 server 输出 authProvider 字段（探针实证）
    const providerSrv = listResult!.servers.find((s) => s.name === "provider-srv");
    expect((providerSrv as any)?.authProvider).toBe("volcengine");
    expect(providerSrv!.state).toBe("needs-auth");
    // 解析层不炸：commandFailed false、exposure 归一化照常、无解析错误
    expect(listResult!.errors).toEqual([]);
    expect(listResult!.servers.every((s) => typeof s.exposure === "string")).toBe(true);
    // 直接喂一段带 authProvider 的输出：多余字段透传，解析结构与探针一致
    const parsed = parseMcpListOutput(
      JSON.stringify({
        servers: [
          { name: "x", scope: "global", enabled: true, exposure: "direct", state: "connected", tools: [], authProvider: "volcengine" },
        ],
        errors: [],
      }),
      { exitCode: 0 },
    );
    expect(parsed.commandFailed).toBe(false);
    expect((parsed.servers[0] as any).authProvider).toBe("volcengine");
    expect(parsed.servers[0].state).toBe("connected");
  });
});

describe("第 2 组：auth:{provider} 的 server 不走 OAuth（真 pi mcp login）", () => {
  test("canUseOAuth 判 false（不给登录按钮），无 auth 配置时为 true", () => {
    expect(canUseOAuth({ url: "https://x.example.com/mcp", auth: { provider: "volcengine" } })).toBe(false);
    // 对照：同 URL 不带 auth → 可能走 OAuth；stdio 无 url → 永不
    expect(canUseOAuth({ url: "https://x.example.com/mcp" })).toBe(true);
    expect(canUseOAuth({})).toBe(false);
  });

  test("真 pi mcp login 直接拒绝，报错文案能被 lastNonEmptyLine 提取", async () => {
    const agentDir = join(baseDir!, "agent-dir");
    const runner = new McpLoginRunner(
      { invalidate: () => {} }, // 测试里无需失效缓存
      {
        runtime: resolvePiRuntime(),
        cliPath: resolvePiCliPath(),
        agentDir,
        cwd: baseDir!,
        killGraceSec: 3,
      },
    );
    const result = await runner.run({
      server: "provider-srv",
      timeoutSec: 10,
      onLine: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.url).toBeNull();
    // pi 1.5.2 实际文案（探针实证，stderr；runner 的 output = stdout + stderr 组合）：
    // 旧版 "does not use OAuth. Only HTTP servers..." 已变为 provider 凭据指引。
    expect(lastNonEmptyLine(result.output)).toBe(
      'MCP server "provider-srv" uses the credentials of provider "volcengine". Run "pi auth login volcengine".',
    );
  }, 30_000);
});

describe("第 3 组：凭据键形态与已登录判定（纯函数 + 临时文件）", () => {
  test("写入 mcp__<server>|<规范化URL> 形态后，readMcpAuthKeys / mcpAuthKeysOf 判已登录", async () => {
    const agentDir = await tempDir("mcp-contract-auth-");
    // server 名含 "-"（命名空间要换 _）；URL 带路径与端口（规范化形态要逐字对上）
    const serverUrl = "https://api.example.com:8443/v1/mcp";
    const expectedKey = mcpAuthKey("my-srv", serverUrl);
    expect(expectedKey).toBe("mcp__my_srv|https://api.example.com:8443/v1/mcp");
    await writeFile(
      join(agentDir, "mcp-auth.json"),
      JSON.stringify({ [expectedKey!]: { accessToken: "tok", refreshToken: "r" } }),
    );
    const keys = await readMcpAuthKeys(agentDir);
    expect(keys.has(expectedKey!)).toBe(true);
    expect(mcpAuthKeysOf(keys, "my-srv", serverUrl)).toBe(true);
    // 未写入凭据的另一台 server：判未登录；URL 非法 → null（未知，不当未登录处理）
    expect(mcpAuthKeysOf(keys, "other-srv", serverUrl)).toBe(false);
    expect(mcpAuthKeysOf(keys, "my-srv", "not-a-url")).toBeNull();
  });
});

describe("第 4 组：含 \"-\" 的 server 名，mcpNamespace 与上游 naming.js 一致（纯比对）", () => {
  test("kernel mcpNamespace ≡ pi-mcp mcpNamespace，未退化名是 createMcpToolName 的前缀", () => {
    // 常规名：两边逐字一致，且命名空间是完整注册名的前缀（- 在 server 段的替换规则两边一致）
    const serverNames = [
      "chrome-devtools", // - → _
      "my_srv",          // 无 -：原样
      "a-b-c",           // 多个 -
    ];
    for (const server of serverNames) {
      expect(mcpNamespace(server)).toBe(piNaming.mcpNamespace(server));
      const tool = "get-page_1";
      expect(piNaming.createMcpToolName(server, tool).startsWith(mcpNamespace(server))).toBe(true);
    }
    // 逐字实例：- 被换、mcp__ 前缀
    expect(mcpNamespace("chrome-devtools")).toBe("mcp__chrome_devtools");
    expect(piNaming.createMcpToolName("chrome-devtools", "click")).toBe("mcp__chrome_devtools__click");
    // 撞名来源：a-b 与 a_b 的 sanitize 同名（裸函数不传 isTaken 不退化，返回同一名字，
    // 由注册器的 isTaken 回调检测后对后到者退化）
    expect(piNaming.createMcpToolName("a-b", "t")).toBe("mcp__a_b__t");
    expect(piNaming.createMcpToolName("a-b", "t")).toBe(piNaming.createMcpToolName("a_b", "t"));
    // 传 isTaken（注册器同款）：撞名者退化为截断 + 8 位 hash
    const degradedAb = piNaming.createMcpToolName("a_b", "t", (c: string) => c === "mcp__a_b__t");
    expect(degradedAb).toMatch(/^mcp__a_b__t_[0-9a-f]{8}$/);
    // 超长名（>64）→ hash 退化：恒长 64 且与工具名无关；退化名不再以完整命名空间为前缀
    // （server 段被截断到 55 字符）——这是上游行为，一并锁定
    const longServer = "x".repeat(70);
    expect(mcpNamespace(longServer)).toBe(piNaming.mcpNamespace(longServer));
    const degraded = piNaming.createMcpToolName(longServer, "t");
    // 恒长 64：sanitize 全名截断到 55 字符 + "_" + sha256(server\0tool) 前 8 位
    expect(degraded).toHaveLength(64);
    expect(degraded).toMatch(/^mcp__x{50}_[0-9a-f]{8}$/);
  });
});

describe("第 5 组：溢出识别兜底——CJK 估算先于上游 400（纯比对）", () => {
  // 三条 pi 1.5.2 认不出的中文上游文案（简报指定；探针已逐条核过 OVERFLOW_PATTERNS 不匹配）
  const UNRECOGNIZED_OVERFLOWS = [
    { provider: "volcengine", text: "InvalidParameter: The length of messages exceeds the maximum limit" },
    { provider: "qianfan", text: "input token length exceeds the maximum limit" },
    // CEREBRAS_BODYLESS_OVERFLOW_PATTERN 只认 provider === "cerebras"
    { provider: "zhipu", text: "400 status code (no body)" },
  ];

  test("isContextOverflow 对三条中文上游文案全部认不出（上游 400 后 pi 无自救）", () => {
    for (const { provider, text } of UNRECOGNIZED_OVERFLOWS) {
      const msg = {
        role: "assistant",
        provider,
        model: "test-model",
        stopReason: "error",
        errorMessage: text,
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      expect(isContextOverflow(msg as any)).toBe(false);
    }
    // 对照：同一文案在 cerebras provider 下被 pi 认出——盲区只在 provider 特判之外
    const cerebrasMsg = {
      role: "assistant", provider: "cerebras", model: "test-model",
      stopReason: "error", errorMessage: "400 status code (no body)", content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(isContextOverflow(cerebrasMsg as any)).toBe(true);
  });

  test("同一 CJK 消息序列：kernel 估算越过发送前压缩阈值，chars/4 口径不越过", () => {
    // 8 条 × 500 汉字的 user 消息（无 assistant usage 锚点 → 全量估算 ×1.15）：
    // kernel = ceil(4000字 × 4当量 / 4) × 1.15 = 4600 tok；pi 的 chars/4 = 1000 tok。
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user",
      content: `压缩占位第${i}段：`.padEnd(0, "") + "上下文内容测试".repeat(71) + "。", // ≈500 个 CJK 字符
    }));
    const estimate = estimateContextTokens(messages);
    const chars = messages.reduce((n, m) => n + (m.content as string).length, 0);
    const charsOver4 = Math.ceil(chars / 4); // pi 引擎口径（compaction.estimateTokens 同式）
    expect(charsOver4).toBeGreaterThan(0);
    // CJK 加权显著高于 chars/4（中文实测 ≈1 tok/字 vs 口径 0.25 tok/字）
    expect(estimate.tokens).toBeGreaterThan(charsOver4);

    // 窗口 4000：阈值 = 0.8 × 4000 = 3200（AUTO_COMPACT_USAGE_RATIO）
    const window = 4000;
    // kernel：4600 > 3200 → 发送前压缩触发（先于请求发出）
    expect(estimate.tokens).toBeGreaterThan(window * 0.8);
    expect(shouldCompactBeforeSend(estimate.tokens, window)).toBe(true);
    // pi 引擎口径：1000 < 3200 → 不触发；叠加三条文案认不出 → 请求发出 → 上游 400
    // 且 isContextOverflow 无法识别 → pi 卡死在错误循环里。
    expect(charsOver4).toBeLessThanOrEqual(window * 0.8);
    expect(shouldCompactBeforeSend(charsOver4, window)).toBe(false);
  });
});
