/**
 * MCP 域接口测试（对齐 572317fd 重构后的契约：GET /api/mcp 立即回配置骨架，
 * 运行状态由后台并发池逐台探测并广播；test / listTools 走单台探测，不再依赖全量 `pi mcp list`）
 *
 * 两层证据：
 *   1. HttpRouter 直测（本仓惯例：不启服务，见 tests/routes-git.test.ts）——list / save /
 *      delete / test / tools 的成功路径 + 错误路径（非法输入 400、server 不存在 404）；
 *   2. 真实 WSServer + SSE 长连接——REST 受理 → handler 广播 → `/api/events` 收到
 *      mcp:probe / mcp:changed / mcp:testResult（前端 store 据此逐台亮灯与刷新列表）。
 *
 * 假件边界：配置读写用**真实 McpFile**（globalPath 指向 tmpdir）——校验（validateMcpServer）
 * 与落盘行为都是真跑的；状态读取者用 canned `pi mcp list --json` 结果，绝不 spawn 真实 pi
 * （新契约下 list / test / listTools 都不再调用它，注入只为证明回包不被状态层拖住）。
 * 探测（mcp-probe）是真跑的：可探测台用本文件的 mock stdio server，失败台用无监听端口。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRouter } from "../src/http-router";
import { McpFile } from "../src/mcp-file";
import type { McpListResult, McpServerReport } from "../src/mcp-admin";
import { createMcpRoutes } from "../src/routes/mcp";
import { WSServer } from "../src/ws-server";
import type { McpServerConfig, WSServerEvent } from "@wa-pi/shared";

/** 全局作用域的 cwd 假件（只有「按 cwd 取实例」用得到，不参与任何落盘） */
const GLOBAL_CWD = join(tmpdir(), "wa-pi-mcp-global-cwd");

/** 无监听端口：http 探测的稳定失败面（connect refused 即时返回，不等超时档） */
const DEAD_PORT = 59999;

/** 一条 `pi mcp list --json` 的 servers[] 条目 */
function report(
  name: string,
  extra: Partial<McpServerReport> = {},
): McpServerReport {
  return {
    name,
    scope: "global",
    enabled: true,
    exposure: "codemode",
    state: "connected",
    tools: [],
    ...extra,
  };
}

/** 一次 list() 的结果（与 McpAdmin.list() 同形） */
function listResult(
  servers: McpServerReport[],
  extra: Partial<McpListResult & { stale: boolean }> = {},
): McpListResult & { stale: boolean } {
  return {
    servers,
    errors: [],
    commandFailed: false,
    hasProblems: false,
    stale: false,
    ...extra,
  };
}

/** 可控的状态读取者：记录 force 参数，返回 canned 结果；cached 模拟 McpAdmin 的缓存状态 */
function makeAdmin(result: McpListResult & { stale: boolean }, opts: { cached?: boolean } = {}) {
  const forceArgs: (boolean | undefined)[] = [];
  let invalidations = 0;
  // 缺省视为「有缓存」：既有用例的语义都是状态可即时取回（走 listWithState）
  const cachedNow = opts.cached ?? true;
  return {
    forceArgs,
    invalidations: () => invalidations,
    cached: () => cachedNow,
    list: async (force?: boolean) => {
      forceArgs.push(force);
      return result;
    },
    invalidate: () => {
      invalidations++;
    },
  };
}

/** 每个用例一个干净的 tmpdir：globalPath 就是 <dir>/mcp.json */
let dir: string;
let globalPath: string;
let file: McpFile;
let broadcasts: WSServerEvent[];
let invalidations: number;
/** 让 cwdForProject 可注入「项目不存在」等失败面 */
let cwdForProject: (projectId?: string) => Promise<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-pi-mcp-routes-"));
  globalPath = join(dir, "mcp.json");
  // stdio 探测的兜底 cwd 是 GLOBAL_CWD（cwdForProject 的返回值）：目录不存在会让 spawn 直接失败，
  // 探测出的就全是「无法启动命令」——与配置本身无关的假失败，必须先把目录建出来
  mkdirSync(GLOBAL_CWD, { recursive: true });
  file = new McpFile({
    globalPath,
    // 与生产同构：项目的 <cwd>/.pi/mcp.json 由 projectId → cwd 解析而来（生产走
    // resolveCwdForFsRequest），幽灵项目在**写盘路径**上就抛 project.notFound。
    // 若这里忽略 projectId（旧假件），404 就只能从状态读取路径冒出来——而状态读取已移到
    // 后台任务里、回包不再依赖它（见「不占回包路径」用例），那样测的就不是生产契约了。
    projectPathFor: async (projectId) =>
      join(await cwdForProject(projectId), ".pi", "mcp.json"),
  });
  broadcasts = [];
  invalidations = 0;
  cwdForProject = async () => GLOBAL_CWD;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 建路由：deps 全注入，broadcast / invalidateCaches 用计数器观测 */
function makeRouter(admin: ReturnType<typeof makeAdmin>) {
  const router = new HttpRouter();
  createMcpRoutes({
    mcpFile: file,
    cwdForProject: (projectId) => cwdForProject(projectId),
    adminForCwd: () => admin as never,
    invalidateCaches: () => {
      invalidations++;
    },
    broadcast: (e) => broadcasts.push(e),
    // 本文件的用例不跑登录/登出；只需满足依赖形状。agentDir 指向 tmpdir：
    // 列表里的 signedIn（F19）读的是它下面的 mcp-auth.json，不存在即「未登录」。
    piSpawn: { runtime: process.execPath, cliPath: "unused-cli.js", agentDir: dir },
  })(router, (async () => Response.json({})) as never, {
    projectStore: { load: async () => ({ projects: [], sessions: [] }) } as never,
  });
  return router;
}

function get(router: HttpRouter, path: string): Promise<Response | null> {
  return router.handle(new Request(`http://localhost${path}`));
}

function post(
  router: HttpRouter,
  path: string,
  body: unknown,
): Promise<Response | null> {
  return router.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function del(router: HttpRouter, path: string): Promise<Response | null> {
  return router.handle(
    new Request(`http://localhost${path}`, { method: "DELETE" }),
  );
}

/** 保存/删除的回包不含广播（广播在后台任务里）：轮询等服务端把它推出来 */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 在 timeoutMs 内必须拿到响应，否则失败。
 * 用于断言「回包不依赖状态读取」：假 admin 的 list 永不返回时，超时就说明回包被它挂住了。
 */
async function within<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`响应未在 ${timeoutMs}ms 内返回（回包被状态读取挂住了）`)),
        timeoutMs,
      ),
    ),
  ]);
}

async function writeGlobal(cfg: unknown): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(globalPath, JSON.stringify(cfg, null, 2), "utf8");
}

/** mock stdio MCP server：initialize + tools/list 正常应答（探测器真跑，绝不 spawn 真实 pi） */
const MOCK_STDIO_SCRIPT = `// 行分隔 JSON-RPC mock
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
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { tools: [{ name: "tool_x" }, { name: "tool_y" }] },
      }) + "\\n");
    }
  }
});
`;

/** 把 mock stdio server 写进当前用例的 tmpdir，返回脚本路径（探测台用 process.execPath 跑它） */
function writeMockScript(): string {
  const scriptPath = join(dir, "mock-stdio-server.js");
  writeFileSync(scriptPath, MOCK_STDIO_SCRIPT);
  return scriptPath;
}

async function readGlobal(): Promise<any> {
  return JSON.parse(await readFile(globalPath, "utf8"));
}

describe("GET /api/mcp", () => {
  test("立即回配置骨架：配置面字段同步在，运行态不再同步下发（状态走 mcp:probe 逐台广播）", async () => {
    // 探测台用必失败的 stdio 命令（spawn ENOENT 即时 failed）：骨架用例只看回包，
    // 但 list 触发的后台探测必须能即时收尾，否则迟到的广播会污染后续用例的断言
    const deadCmd = join(dir, "no-such-cmd");
    await writeGlobal({
      mcpServers: { echo: { command: deadCmd, args: ["x.js"] } },
    });
    const router = makeRouter(
      makeAdmin(
        listResult([
          report("echo", { state: "connected", tools: ["echo", "ping"] }),
        ]),
      ),
    );

    const res = await get(router, "/api/mcp");
    expect(res?.status).toBe(200);
    const body = await res!.json();

    expect(body.servers).toHaveLength(1);
    // 配置面（表单编辑要用）：来自 mcp-file，同步返回
    expect(body.servers[0].name).toBe("echo");
    expect(body.servers[0].command).toBe(deadCmd);
    expect(body.servers[0].args).toEqual(["x.js"]);
    // 运行态不再同步等待 pi 全量（单台拖垮全量的根源）；逐台探测经 mcp:probe 广播
    expect(body.servers[0].state).toBeUndefined();
    expect(body.servers[0].tools).toBeUndefined();
    // 骨架语义：状态未知恒 stale=true，等后台逐台探测 + mcp:changed 收尾
    expect(body.stale).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.commandFailed).toBe(false);
    expect(body.hasProblems).toBe(false);
    // 排干后台探测：事件必须落在本用例的数组里，不能跨用例泄漏
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("登录态只对可能走 OAuth 的 server 下发（带 Authorization 头 / auth 的一律不给）", async () => {
    // 探测台全部用本地即时失败面（无监听端口 / 不存在的命令）：
    // 后台探测会真连这些台，必须毫秒级收尾，不能拖外网也不能在装有 node 的机器上挂 REPL
    await writeGlobal({
      mcpServers: {
        plainHttp: { url: `http://127.0.0.1:${DEAD_PORT}` },
        staticHeader: {
          url: `http://127.0.0.1:${DEAD_PORT}`,
          headers: { Authorization: "Bearer x" },
        },
        lowerCaseHeader: {
          url: `http://127.0.0.1:${DEAD_PORT}`,
          headers: { authorization: "Bearer y" },
        },
        providerAuth: {
          url: `http://127.0.0.1:${DEAD_PORT}`,
          auth: { provider: "openai" },
        },
        stdioSrv: { command: join(dir, "no-such-cmd"), args: ["x.js"] },
      },
    });
    const router = makeRouter(
      makeAdmin(
        listResult([
          report("plainHttp"),
          report("staticHeader"),
          report("lowerCaseHeader"),
          report("providerAuth"),
          report("stdioSrv"),
        ]),
      ),
    );

    const res = await get(router, "/api/mcp");
    const body = await res!.json();
    const byName = Object.fromEntries(
      body.servers.map((s: { name: string }) => [s.name, s]),
    );
    // 不带 Authorization 头的 HTTP：可能走 OAuth → 未登录下发 false（前端据此画登录按钮）
    expect(byName.plainHttp.signedIn).toBe(false);
    // 带静态 Authorization 头（大小写不敏感）或 auth：pi 的 login 会直接拒绝
    // （"does not use OAuth. Only HTTP servers without an Authorization header do."）
    // → 不下发 signedIn（前端把 undefined 当未知，两边按钮都不画）
    expect("signedIn" in byName.staticHeader).toBe(false);
    expect("signedIn" in byName.lowerCaseHeader).toBe(false);
    expect("signedIn" in byName.providerAuth).toBe(false);
    expect("signedIn" in byName.stdioSrv).toBe(false);
    // 排干后台探测（5 台）：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("骨架响应登录态按键存在性下发（state 恒无；needs-auth 覆写移至 mcp:probe 广播）", async () => {
    await writeGlobal({ mcpServers: { oauthSrv: { url: `http://127.0.0.1:${DEAD_PORT}/mcp` } } });
    // 模拟「登录过但凭据已失效」：mcp-auth.json 里键残留
    await Bun.write(
      join(dir, "mcp-auth.json"),
      JSON.stringify({
        [`mcp__oauthSrv|http://127.0.0.1:${DEAD_PORT}/mcp`]: { tokens: {} },
      }),
    );
    const router = makeRouter(
      makeAdmin(listResult([report("oauthSrv", { state: "needs-auth" })])),
    );

    const res = await get(router, "/api/mcp");
    const body = await res!.json();
    const byName = Object.fromEntries(
      body.servers.map((s: { name: string }) => [s.name, s]),
    );
    // 骨架无运行态：state 恒 undefined；登录态按 mcp-auth.json 键存在性下发，
    // 「键存在≠凭据有效」的 needs-auth 覆写在逐台探测广播（mcp:probe）里裁决
    expect(byName.oauthSrv.state).toBeUndefined();
    expect(byName.oauthSrv.signedIn).toBe(true);
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("connected 且键存在时 signedIn=true 不受影响（登出按钮照常）", async () => {
    await writeGlobal({ mcpServers: { oauthSrv: { url: `http://127.0.0.1:${DEAD_PORT}/mcp` } } });
    await Bun.write(
      join(dir, "mcp-auth.json"),
      JSON.stringify({
        [`mcp__oauthSrv|http://127.0.0.1:${DEAD_PORT}/mcp`]: { tokens: {} },
      }),
    );
    const router = makeRouter(
      makeAdmin(listResult([report("oauthSrv", { state: "connected" })])),
    );

    const res = await get(router, "/api/mcp");
    const body = await res!.json();
    const byName = Object.fromEntries(
      body.servers.map((s: { name: string }) => [s.name, s]),
    );
    expect(byName.oauthSrv.signedIn).toBe(true);
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("骨架元信息恒定：stale 恒 true、errors=[]，admin 状态层的 note/raw 不透传", async () => {
    await writeGlobal({ mcpServers: {} });
    const router = makeRouter(
      makeAdmin(
        listResult([], {
          stale: false,
          hasProblems: true,
          errors: ["global 配置损坏"],
          note: "项目未受信任，已忽略 .pi/mcp.json",
          raw: "{\"servers\":[]}",
        }),
      ),
    );

    const body = await (await get(router, "/api/mcp"))!.json();
    // 骨架恒定语义：状态未知 → stale 恒 true；错误元信息不再来自全量 list（单台探测各自广播）
    expect(body.stale).toBe(true);
    expect(body.hasProblems).toBe(false);
    expect(body.errors).toEqual([]);
    // 无 projectId → 不做受信判断，note 为空；admin 的 note/raw 一律不透传
    expect(body.note).toBeUndefined();
    expect(body.raw).toBeUndefined();
    // 排干后台探测（空配置也有收尾广播）：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("项目配置仍在骨架清单里（无运行态；未受信项目经 mcp:probe 广播后由前端提示）", async () => {
    await writeGlobal({
      mcpServers: { proj_srv: { command: join(dir, "no-such-cmd") } },
    });
    const router = makeRouter(
      makeAdmin(
        listResult([], {
          note: "the project is not trusted，已忽略 <cwd>/.pi/mcp.json",
        }),
      ),
    );

    const body = await (await get(router, "/api/mcp"))!.json();
    expect(body.servers.map((s: any) => s.name)).toEqual(["proj_srv"]);
    expect(body.servers[0].state).toBeUndefined();
    // 无 projectId → 不做受信判断；admin 的 note 不透传
    expect(body.note).toBeUndefined();
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("骨架响应 commandFailed 恒 false（命令失败语义随单台探测各自广播）", async () => {
    await writeGlobal({ mcpServers: { echo: { command: join(dir, "no-such-cmd") } } });
    const router = makeRouter(
      makeAdmin(listResult([], { commandFailed: true, stale: true, hasProblems: true })),
    );

    const body = await (await get(router, "/api/mcp"))!.json();
    expect(body.commandFailed).toBe(false);
    expect(body.stale).toBe(true);
    expect(body.servers.map((s: any) => s.name)).toEqual(["echo"]);
    expect(body.servers[0].state).toBeUndefined();
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("冷缓存场景：骨架立即回（无 state、stale=true），状态随后经 mcp:probe/mcp:changed 广播补上", async () => {
    // 场景：盘上有一台连不上的 server。旧实现冷缓存要真 spawn pi 全量等完（单台可耗 60s+），
    // 回包若等状态，GUI 首开就是「加载中…」→ 前端超时 → 空列表。新契约：回包只含配置骨架，
    // 状态由后台并发池逐台探测（每台独立截止），完成一台广播一台、全部结束 mcp:changed 收尾。
    await writeGlobal({
      mcpServers: { srv: { url: `http://127.0.0.1:${DEAD_PORT}/mcp` } },
    });
    const admin = makeAdmin(listResult([report("srv")]), { cached: false });
    const router = makeRouter(admin);
    const res = (await within(get(router, "/api/mcp"), 500))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.servers.map((s: any) => s.name)).toEqual(["srv"]);
    // 骨架不带运行态：探测还没回来，不能捏造状态
    expect(body.servers[0].state).toBeUndefined();
    // stale=true：这份清单不是刚跑出来的状态（前端显示「状态未知」横幅，广播到了再刷新）
    expect(body.stale).toBe(true);
    expect(body.commandFailed).toBe(false);
    // 状态随后经广播补上：连接拒绝的台按 failed 落地，收尾事件带全量状态并清 stale
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
    const probe = broadcasts.find((e) => e.type === "mcp:probe") as any;
    expect(probe).toMatchObject({ serverName: "srv", state: "failed" });
    const ev = broadcasts.find((e) => e.type === "mcp:changed") as any;
    expect(ev.servers[0]).toMatchObject({ name: "srv", state: "failed" });
    expect(ev.stale).toBe(false);
    // 收尾元信息由探测池生成：有启用中的台 failed → hasProblems=true、errors 恒空
    expect(ev.hasProblems).toBe(true);
    expect(ev.errors).toEqual([]);
  });

  test("热缓存（cached=true）：行为一致——同样立即回骨架，后台探测广播照常收尾", async () => {
    await writeGlobal({ mcpServers: { srv: { url: `http://127.0.0.1:${DEAD_PORT}/mcp` } } });
    const admin = makeAdmin(listResult([report("srv")]), { cached: true });
    const router = makeRouter(admin);
    const res = (await get(router, "/api/mcp"))!;
    const body = await res.json();
    // admin 是否有缓存不再影响回包：运行态一律不同步下发，状态未知恒 stale=true
    expect(body.servers[0].state).toBeUndefined();
    expect(body.stale).toBe(true);
    // 后台探测照常：连接拒绝的台按 failed 广播，mcp:changed 收尾清 stale
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
    const ev = broadcasts.find((e) => e.type === "mcp:changed") as any;
    expect(ev.servers[0]).toMatchObject({ name: "srv", state: "failed" });
    expect(ev.stale).toBe(false);
  });

  test("项目不存在 → 404 project.notFound（cwd 解析失败不吞成 400）", async () => {
    cwdForProject = async () => {
      const { KernelError } = await import("@wa-pi/shared");
      throw new KernelError("project.notFound", { id: "ghost" });
    };
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await get(router, "/api/mcp?projectId=ghost");
    expect(res?.status).toBe(404);
    expect((await res!.json()).failure.code).toBe("project.notFound");
  });
});

describe("POST /api/mcp（新增 / 编辑）", () => {
  test("非法名 → 400 + 字段级错误，且不落盘、不广播、不失效缓存", async () => {
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await post(router, "/api/mcp", {
      config: { name: "bad name!", command: "x" },
    });

    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.errors[0].field).toBe("name");
    expect(existsSync(globalPath)).toBe(false); // 校验失败不写盘（规格 §8）
    expect(broadcasts).toEqual([]);
    expect(invalidations).toBe(0);
  });

  test("改名时原 server 不存在 → 400 mcp.originalServerNotFound（旧 McpStore 的契约）", async () => {
    await writeGlobal({ mcpServers: {} });
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await post(router, "/api/mcp", {
      config: { name: "new-name", command: "x" },
      originalName: "ghost",
    });

    expect(res?.status).toBe(400);
    expect((await res!.json()).failure.code).toBe("mcp.originalServerNotFound");
    expect((await readGlobal()).mcpServers["new-name"]).toBeUndefined();
  });

  test("成功 → 200 {ok:true}、写盘、失效所有状态缓存、后台探测广播 mcp:probe + mcp:changed", async () => {
    // 探测台用 mock stdio server（探测真跑）：结果稳定 connected，事件序列可精确断言
    const scriptPath = writeMockScript();
    const router = makeRouter(
      makeAdmin(listResult([report("echo", { tools: ["echo"] })])),
    );

    const res = await post(router, "/api/mcp", {
      config: { name: "echo", command: process.execPath, args: [scriptPath] },
    });

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect((await readGlobal()).mcpServers.echo).toEqual({
      command: process.execPath,
      args: [scriptPath],
    });
    // 缓存失效同步发生在回包路径上（广播在后台任务里）：广播里的 servers 才是写盘后的新状态
    expect(invalidations).toBe(1);
    // 广播不占回包路径：等单台 probe 与收尾 changed 都推出来再断言内容
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
    expect(broadcasts.map((e) => e.type)).toEqual(["mcp:probe", "mcp:changed"]);
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:probe",
      serverName: "echo",
      state: "connected",
      tools: ["tool_x", "tool_y"],
    });
    // 收尾事件带全量状态（servers 含探测出的运行态）且 stale 已清零
    expect(broadcasts[1]).toMatchObject({
      type: "mcp:changed",
      stale: false,
      servers: [{ name: "echo", command: process.execPath, state: "connected" }],
    });
  });

  test("mcp:changed 元信息由探测池生成：errors 恒 []、stale false；admin 状态层的 note/errors 不透传", async () => {
    // 与 GET /api/mcp 的骨架元信息同形：前端 store 靠它们决定「状态未知」与「项目未受信」两处说明
    const scriptPath = writeMockScript();
    const router = makeRouter(
      makeAdmin(
        listResult([report("echo", { tools: ["echo"] })], {
          stale: true,
          errors: ["warn: 读状态超时"],
          note: "…/.pi/mcp.json is ignored because the project is not trusted.",
        }),
      ),
    );

    const res = await post(router, "/api/mcp", {
      config: { name: "echo", command: process.execPath, args: [scriptPath] },
    });
    expect(res?.status).toBe(200);

    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
    const ev = broadcasts.find((e) => e.type === "mcp:changed") as any;
    // 元信息由探测池重新生成，不是 admin 状态层的透传
    expect(ev).toMatchObject({
      type: "mcp:changed",
      stale: false,
      errors: [],
      commandFailed: false,
      // 探测成功（connected）→ 无启用中的台处于异常态
      hasProblems: false,
    });
    // 无 projectId → 不做受信判断；admin canned 的 note（状态层产物）一律不透传
    expect(ev.note).toBeUndefined();
  });

  test("项目不存在 → 404（不把 project.notFound 吞成 400）", async () => {
    cwdForProject = async () => {
      const { KernelError } = await import("@wa-pi/shared");
      throw new KernelError("project.notFound", { id: "ghost" });
    };
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await post(router, "/api/mcp", {
      projectId: "ghost",
      config: { name: "echo", command: "node" },
    });
    expect(res?.status).toBe(404);
  });
});

describe("DELETE /api/mcp/:serverName", () => {
  test("server 不存在 → 404 mcp.serverNotFound", async () => {
    await writeGlobal({ mcpServers: {} });
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await del(router, "/api/mcp/ghost");
    expect(res?.status).toBe(404);
    expect((await res!.json()).failure.code).toBe("mcp.serverNotFound");
    expect(broadcasts).toEqual([]);
  });

  test("成功 → 200 {ok:true}、从盘上删除、失效缓存并广播 mcp:probe + mcp:changed（余下清单带状态）", async () => {
    const scriptPath = writeMockScript();
    await writeGlobal({
      mcpServers: {
        echo: { command: process.execPath, args: [scriptPath] },
        keep: { command: process.execPath, args: [scriptPath] },
      },
    });
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await del(router, "/api/mcp/echo");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(Object.keys((await readGlobal()).mcpServers)).toEqual(["keep"]);
    expect(invalidations).toBe(1);
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
    // 广播序列：余下清单逐台探测广播（mcp:probe）+ mcp:changed 收尾（带全量状态）
    expect(broadcasts.map((e) => e.type)).toEqual(["mcp:probe", "mcp:changed"]);
    expect(broadcasts[1]).toMatchObject({
      type: "mcp:changed",
      stale: false,
      servers: [{ name: "keep", state: "connected" }],
    });
  });
});

describe("save / delete：状态读取（冷 pi mcp list，上限 70s）不占回包路径", () => {
  /** list() 永不返回的 admin：模拟盘上有一台卡死的 server */
  function hangingAdmin() {
    let listCalls = 0;
    return {
      listCalls: () => listCalls,
      list: () => {
        listCalls++;
        return new Promise<never>(() => {});
      },
      invalidate: () => {},
    };
  }

  test("save：状态读取永不返回时仍立即回 200，且配置已落盘、缓存已失效", async () => {
    const router = makeRouter(hangingAdmin() as never);

    // 探测台用必失败的命令（spawn ENOENT 即时 failed）：后台探测要能即时收尾，不跨用例泄漏事件
    const res = await within(
      post(router, "/api/mcp", {
        config: { name: "echo", command: join(dir, "no-such-cmd") },
      }),
      1000,
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect((await readGlobal()).mcpServers.echo).toEqual({
      command: join(dir, "no-such-cmd"),
    });
    expect(invalidations).toBe(1);
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });

  test("delete：状态读取永不返回时仍立即回 200，且盘上已删除", async () => {
    await writeGlobal({
      mcpServers: {
        echo: { command: join(dir, "no-such-cmd") },
        keep: { command: join(dir, "no-such-cmd") },
      },
    });
    const router = makeRouter(hangingAdmin() as never);

    const res = await within(del(router, "/api/mcp/echo"), 1000);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(Object.keys((await readGlobal()).mcpServers)).toEqual(["keep"]);
    expect(invalidations).toBe(1);
    // 排干后台探测：事件必须落在本用例的数组里
    await waitFor(() => broadcasts.some((e) => e.type === "mcp:changed"));
  });
});

describe("POST /api/mcp/test", () => {
  test("已连接 → 200 {ok:true} + 广播 mcp:testResult（connected + 工具数），不再走状态读取层", async () => {
    // 探测台用 mock stdio server（探测真跑，应答 initialize + tools/list）
    const scriptPath = writeMockScript();
    await writeGlobal({
      mcpServers: { echo: { command: process.execPath, args: [scriptPath] } },
    });
    // canned 結果留空：新契约下 test 与全量 `pi mcp list` 彻底解耦，结果只取决于探测本身
    const admin = makeAdmin(listResult([]));
    const router = makeRouter(admin);

    const res = await post(router, "/api/mcp/test", { serverName: "echo" });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true }); // fire-and-forget：结果只走 SSE

    expect(broadcasts).toEqual([
      {
        type: "mcp:testResult",
        serverName: "echo",
        success: true,
        status: "connected",
        toolCount: 2,
      },
    ]);
    // 不再调用状态读取层（无「强制重跑」概念，也就没有 force 参数）
    expect(admin.forceArgs).toEqual([]);
  });

  test("探测失败（连接拒绝）→ testResult(status:error) 带上探测的错误文案", async () => {
    // 失败台用无监听端口：connect refused 即时返回，不依赖外部服务也不等超时档
    await writeGlobal({
      mcpServers: { bad: { url: `http://127.0.0.1:${DEAD_PORT}/mcp` } },
    });
    const router = makeRouter(makeAdmin(listResult([])));

    await post(router, "/api/mcp/test", { serverName: "bad" });
    const ev = broadcasts[0] as any;
    expect(ev).toMatchObject({
      type: "mcp:testResult",
      serverName: "bad",
      success: false,
      status: "error",
    });
    // 错误文案来自单台探测本身（不再是 pi 全量输出的错误段落）
    expect(typeof ev.error).toBe("string");
    expect(ev.error.length).toBeGreaterThan(0);
  });

  test("enabled:false 的 server → 探测直接报 disconnected，不发起连接也不误报错误", async () => {
    await writeGlobal({
      mcpServers: { off: { command: "node", enabled: false } },
    });
    const router = makeRouter(makeAdmin(listResult([])));

    await post(router, "/api/mcp/test", { serverName: "off" });
    // 探测对 enabled:false 不发起连接（command 填什么都行）：state=disabled → status=disconnected，无 error
    expect(broadcasts).toEqual([
      {
        type: "mcp:testResult",
        serverName: "off",
        success: false,
        status: "disconnected",
      },
    ]);
  });

  test("未知 server → testResult(success:false, status:error)，带 code 供前端字典渲染", async () => {
    const router = makeRouter(makeAdmin(listResult([report("echo")])));

    await post(router, "/api/mcp/test", { serverName: "not-exist" });
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:testResult",
      serverName: "not-exist",
      success: false,
      status: "error",
      code: "mcp.serverNotFound",
      params: { name: "not-exist" },
    });
  });

  test("探测命令跑不起来（spawn 失败）→ testResult 报启动失败文案，无字典条目（code 为空）", async () => {
    // command 指向不存在的可执行文件：探测 spawn 直接失败，报「无法启动命令」而不是进状态读取层
    await writeGlobal({
      mcpServers: { echo: { command: join(dir, "no-such-cmd") } },
    });
    const router = makeRouter(makeAdmin(listResult([])));

    await post(router, "/api/mcp/test", { serverName: "echo" });
    const ev = broadcasts[0] as any;
    expect(ev).toMatchObject({
      type: "mcp:testResult",
      serverName: "echo",
      success: false,
      status: "error",
    });
    expect(ev.error).toContain("无法启动命令"); // 探测器的启动失败文案
    expect(ev.code).toBeUndefined(); // 探测失败无字典条目 → 让前端原样展示文案
  });
});

describe("GET /api/mcp/:serverName/tools", () => {
  test("→ 200 {ok:true} + 广播 mcp:tools（单台探测的工具名清单），不再走状态读取层", async () => {
    // 探测台用 mock stdio server（探测真跑，应答 initialize + tools/list）
    const scriptPath = writeMockScript();
    await writeGlobal({
      mcpServers: { echo: { command: process.execPath, args: [scriptPath] } },
    });
    // canned 結果留空：新契约下 listTools 与全量 `pi mcp list` 彻底解耦
    const admin = makeAdmin(listResult([]));
    const router = makeRouter(admin);

    const res = await get(router, "/api/mcp/echo/tools");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(broadcasts).toEqual([
      {
        type: "mcp:tools",
        serverName: "echo",
        tools: [{ name: "tool_x" }, { name: "tool_y" }],
      },
    ]);
    // 不再调用状态读取层（无「强制重跑」概念，也就没有 force 参数）
    expect(admin.forceArgs).toEqual([]);
  });

  test("未知 server → 广播出错事件（tools 与 error 互斥）", async () => {
    const router = makeRouter(makeAdmin(listResult([report("echo")])));

    await get(router, "/api/mcp/ghost/tools");
    const ev = broadcasts[0] as any;
    expect(ev.type).toBe("mcp:tools");
    expect(ev.tools).toBeUndefined();
    expect(ev.error).toBeDefined();
  });
});

// ===== 第三层：真实 WSServer + SSE（REST → handler → 广播 → 前端收到）=====

describe("SSE 链路（真实 WSServer）", () => {
  let server: WSServer;
  let base: string;
  let sseReader: ReadableStreamDefaultReader<Uint8Array>;
  let sseBuf = "";
  let sseDir: string;
  let adminResult: McpListResult & { stale: boolean };

  beforeAll(async () => {
    sseDir = mkdtempSync(join(tmpdir(), "wa-pi-mcp-sse-"));
    adminResult = listResult([
      report("echo", { state: "connected", tools: ["echo", "ping"] }),
    ]);
    // echo 用 mock stdio server（探测真跑）：test / save 的广播要能拿到真实探测结果；
    // 新契约下状态不再走 canned admin（它已不被 list / test / listTools 调用），配置必须在盘上
    writeFileSync(join(sseDir, "mock-stdio-server.js"), MOCK_STDIO_SCRIPT);
    writeFileSync(
      join(sseDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [join(sseDir, "mock-stdio-server.js")],
          },
        },
      }),
    );
    const sseFile = new McpFile({
      globalPath: join(sseDir, "mcp.json"),
      projectPathFor: async () => join(sseDir, ".pi", "mcp.json"),
    });
    server = new WSServer({
      mcpFile: sseFile,
      // 项目级开关端点要解析 projectId → cwd：给一条真实项目（cwd = sseDir），
      // 其余项目/会话读法本文件用不到
      projectStore: {
        load: async () => ({
          projects: [{ id: "sse-proj", name: "SSE 项目", cwd: sseDir, createdAt: 0 }],
          sessions: [],
        }),
      } as never,
      agentManager: {
        disposeAll: async () => {},
        onEvent: () => {},
        mcpAdminForCwd: () => makeAdmin(adminResult) as never,
        invalidateMcpCaches: () => {},
      } as never,
      configStore: {} as never,
      providerStore: {} as never,
      skillManager: {} as never,
      extensionManager: {} as never,
      memoryStore: {} as never,
      channelManager: null,
      port: 0,
    });
    await server.start();
    base = `http://localhost:${server.actualPort}`;

    const sse = await fetch(`${base}/api/events`);
    sseReader = sse.body!.getReader();
  });

  afterAll(async () => {
    await sseReader?.cancel().catch(() => {});
    server?.stop();
    await rm(sseDir, { recursive: true, force: true });
  });

  /** 从 SSE 流读出下一条 data: 帧（跳过注释行/心跳） */
  async function readSseEvent(timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        sseReader.read(),
        new Promise<{ done: true }>((r) =>
          setTimeout(() => r({ done: true }), deadline - Date.now()),
        ),
      ]);
      if ((chunk as any).done) continue;
      sseBuf += new TextDecoder().decode((chunk as any).value);
      const idx = sseBuf.indexOf("\n\n");
      if (idx === -1) continue;
      const frame = sseBuf.slice(0, idx);
      sseBuf = sseBuf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        return JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
    }
    throw new Error("readSseEvent 超时未收到事件");
  }

  test("POST /api/mcp/test → SSE 广播 mcp:testResult（前端据此翻转 testingServers）", async () => {
    const res = await fetch(`${base}/api/mcp/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "echo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const ev = await readSseEvent();
    expect(ev.type).toBe("mcp:testResult");
    expect(ev.serverName).toBe("echo");
    expect(ev.success).toBe(true);
    expect(ev.status).toBe("connected");
    expect(ev.toolCount).toBe(2);
  });

  test("POST /api/mcp（保存）→ 200 + SSE 广播 mcp:changed（写盘后的清单带探测状态）", async () => {
    sseBuf = "";
    const scriptPath = join(sseDir, "mock-stdio-server.js");
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { name: "echo", command: process.execPath, args: [scriptPath] },
      }),
    });
    expect(res.status).toBe(200);

    // 后台逐台探测广播（mcp:probe）在前、mcp:changed 收尾在后；两帧可能合并在同一个
    // chunk 里到达（readSseEvent 单帧解析后残留不优先消费），所以这里持续消费缓冲，
    // 直到解析出收尾帧（心跳帧 / 注释帧跳过）
    let ev: any;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const idx = sseBuf.indexOf("\n\n");
      if (idx === -1) {
        const chunk = await Promise.race([
          sseReader.read(),
          new Promise((r) =>
            setTimeout(() => r({ timeout: true }), deadline - Date.now()),
          ),
        ]);
        if ((chunk as any).timeout) break;
        sseBuf += new TextDecoder().decode((chunk as any).value);
        continue;
      }
      const frame = sseBuf.slice(0, idx);
      sseBuf = sseBuf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine || !dataLine.slice(5).trim()) continue;
      try {
        ev = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === "mcp:changed") break;
    }
    expect(ev.type).toBe("mcp:changed");
    expect(ev.servers.map((s: any) => s.name)).toEqual(["echo"]);
    expect(ev.servers.map((s: any) => s.name)).toEqual(["echo"]);
    // 收尾事件带探测出的运行态（mock server 应答 → connected）且 stale 已清零
    expect(ev.servers[0]).toMatchObject({ state: "connected" });
    expect(ev.stale).toBe(false);
    // 盘上确实写了（保存不是只广播）
    expect(
      JSON.parse(await readFile(join(sseDir, "mcp.json"), "utf8")).mcpServers.echo
        .command,
    ).toBe(process.execPath);
  });

  test("GET /api/mcp 走真实路由（全局作用域）：立即回配置骨架（状态由后台探测广播）", async () => {
    const res = await fetch(`${base}/api/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: McpServerConfig[];
      stale?: boolean;
    };
    expect(body.servers.map((s) => s.name)).toEqual(["echo"]);
    // 骨架不带运行态：state 不同步下发（逐台探测经 mcp:probe / mcp:changed 广播）
    expect((body.servers[0] as any).state).toBeUndefined();
    expect(body.stale).toBe(true);
  });

  test("GET / POST /api/mcp/project-scope 走真实路由：真值来自 trust.json（缺口①）", async () => {
    const readScope = async () =>
      (await (
        await fetch(`${base}/api/mcp/project-scope?projectId=sse-proj`)
      ).json()) as { enabled: boolean | null };
    const postScope = (enabled: boolean) =>
      fetch(`${base}/api/mcp/project-scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "sse-proj", enabled }),
      });

    // 未设置（trust.json 里无条目）→ null，而不是乐观地报「已开」
    expect(await readScope()).toEqual({ enabled: null });

    expect((await postScope(true)).status).toBe(200);
    expect(await readScope()).toEqual({ enabled: true });

    expect((await postScope(false)).status).toBe(200);
    expect(await readScope()).toEqual({ enabled: false });
  });
});
