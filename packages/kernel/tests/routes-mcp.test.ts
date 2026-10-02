/**
 * MCP 域接口测试（任务 8：数据来源切到 mcp-file.ts + mcp-admin.ts 之后）
 *
 * 两层证据：
 *   1. HttpRouter 直测（本仓惯例：不启服务，见 tests/routes-git.test.ts）——list / save /
 *      delete / test / tools 的成功路径 + 错误路径（非法输入 400、server 不存在 404）；
 *   2. 真实 WSServer + SSE 长连接——REST 受理 → handler 广播 → `/api/events` 收到
 *      mcp:changed / mcp:testResult（前端 store 据此刷新列表与 testingServers）。
 *
 * 假件边界：配置读写用**真实 McpFile**（globalPath 指向 tmpdir）——校验（validateMcpServer）
 * 与落盘行为都是真跑的；状态读取者用 canned `pi mcp list --json` 结果，绝不 spawn 真实 pi。
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
import { existsSync, mkdtempSync } from "node:fs";
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

/** 可控的状态读取者：记录 force 参数，返回 canned 结果 */
function makeAdmin(result: McpListResult & { stale: boolean }) {
  const forceArgs: (boolean | undefined)[] = [];
  let invalidations = 0;
  return {
    forceArgs,
    invalidations: () => invalidations,
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

async function readGlobal(): Promise<any> {
  return JSON.parse(await readFile(globalPath, "utf8"));
}

describe("GET /api/mcp", () => {
  test("合并「盘上配置 + pi 报的状态」：配置字段与 state/tools 同时在，stale 透传", async () => {
    await writeGlobal({
      mcpServers: { echo: { command: "node", args: ["x.js"] } },
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
    // 配置面（表单编辑要用）：来自 mcp-file
    expect(body.servers[0].name).toBe("echo");
    expect(body.servers[0].command).toBe("node");
    expect(body.servers[0].args).toEqual(["x.js"]);
    // 状态面（规格 §7）：来自 pi mcp list --json
    expect(body.servers[0].state).toBe("connected");
    expect(body.servers[0].tools).toEqual(["echo", "ping"]);
    expect(body.stale).toBe(false);
    expect(body.commandFailed).toBe(false);
    expect(body.hasProblems).toBe(false);
  });

  test("登录态只对可能走 OAuth 的 server 下发（带 Authorization 头 / auth 的一律不给）", async () => {
    await writeGlobal({
      mcpServers: {
        plainHttp: { url: "https://host" },
        staticHeader: {
          url: "https://host2",
          headers: { Authorization: "Bearer x" },
        },
        lowerCaseHeader: {
          url: "https://host3",
          headers: { authorization: "Bearer y" },
        },
        providerAuth: { url: "https://host4", auth: { provider: "openai" } },
        stdioSrv: { command: "node", args: ["x.js"] },
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
  });

  test("stale / hasProblems / note 原样透传，且不外泄 pi 的原始 stdout（raw）", async () => {
    await writeGlobal({ mcpServers: {} });
    const router = makeRouter(
      makeAdmin(
        listResult([], {
          stale: true,
          hasProblems: true,
          errors: ["global 配置损坏"],
          note: "项目未受信任，已忽略 .pi/mcp.json",
          raw: "{\"servers\":[]}",
        }),
      ),
    );

    const body = await (await get(router, "/api/mcp"))!.json();
    expect(body.stale).toBe(true);
    expect(body.hasProblems).toBe(true);
    expect(body.errors).toEqual(["global 配置损坏"]);
    expect(body.note).toBe("项目未受信任，已忽略 .pi/mcp.json");
    expect(body.raw).toBeUndefined();
  });

  test("项目未受信（pi 没报该 server）：配置仍在列表里、无 state，配 note 解释为何不生效", async () => {
    await writeGlobal({
      mcpServers: { proj_srv: { command: "node" } },
    });
    // pi 在未受信项目里只会报别的（这里模拟：一条都没报）
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
    expect(body.note).toContain("not trusted");
  });

  test("pi 命令失败（commandFailed）：配置清单仍返回（用户可继续编辑），靠 stale 提示状态未知", async () => {
    await writeGlobal({ mcpServers: { echo: { command: "node" } } });
    const router = makeRouter(
      makeAdmin(listResult([], { commandFailed: true, stale: true, hasProblems: true })),
    );

    const body = await (await get(router, "/api/mcp"))!.json();
    expect(body.commandFailed).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.servers.map((s: any) => s.name)).toEqual(["echo"]);
    expect(body.servers[0].state).toBeUndefined();
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

  test("成功 → 200 {ok:true}、写盘、失效所有状态缓存、广播带状态的 mcp:changed", async () => {
    const router = makeRouter(
      makeAdmin(listResult([report("echo", { tools: ["echo"] })])),
    );

    const res = await post(router, "/api/mcp", {
      config: { name: "echo", command: "node", args: ["x.js"] },
    });

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect((await readGlobal()).mcpServers.echo).toEqual({
      command: "node",
      args: ["x.js"],
    });
    // 缓存失效必须在广播之前：广播里的 servers 才是写盘后的新状态
    expect(invalidations).toBe(1);
    // 广播不占回包路径（后台任务）：等它推出来再断言内容
    await waitFor(() => broadcasts.length >= 1);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:changed",
      servers: [{ name: "echo", command: "node", state: "connected", tools: ["echo"] }],
    });
  });

  test("广播带完整清单元信息（stale/note/errors）：事件不是「无元信息的裸清单」", async () => {
    // 与 GET /api/mcp 同形：前端 store 靠它们决定「状态未知」与「项目未受信」两处说明
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
      config: { name: "echo", command: "node" },
    });
    expect(res?.status).toBe(200);

    await waitFor(() => broadcasts.length >= 1);
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:changed",
      stale: true,
      errors: ["warn: 读状态超时"],
      note: "…/.pi/mcp.json is ignored because the project is not trusted.",
      commandFailed: false,
      hasProblems: false,
    });
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

  test("成功 → 200 {ok:true}、从盘上删除、失效缓存并广播 mcp:changed", async () => {
    await writeGlobal({
      mcpServers: { echo: { command: "node" }, keep: { command: "node" } },
    });
    const router = makeRouter(makeAdmin(listResult([])));

    const res = await del(router, "/api/mcp/echo");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(Object.keys((await readGlobal()).mcpServers)).toEqual(["keep"]);
    expect(invalidations).toBe(1);
    await waitFor(() => broadcasts.length >= 1);
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:changed",
      servers: [{ name: "keep" }],
    });
  });
});

describe("save / delete：状态读取（冷 pi mcp list，上限 30s）不占回包路径", () => {
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

    const res = await within(
      post(router, "/api/mcp", { config: { name: "echo", command: "node" } }),
      1000,
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect((await readGlobal()).mcpServers.echo).toEqual({ command: "node" });
    expect(invalidations).toBe(1);
  });

  test("delete：状态读取永不返回时仍立即回 200，且盘上已删除", async () => {
    await writeGlobal({
      mcpServers: { echo: { command: "node" }, keep: { command: "node" } },
    });
    const router = makeRouter(hangingAdmin() as never);

    const res = await within(del(router, "/api/mcp/echo"), 1000);
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(Object.keys((await readGlobal()).mcpServers)).toEqual(["keep"]);
    expect(invalidations).toBe(1);
  });
});

describe("POST /api/mcp/test", () => {
  test("已连接 → 200 {ok:true} + 广播 mcp:testResult（connected + 工具数），且强制重跑（force）", async () => {
    const admin = makeAdmin(
      listResult([report("echo", { state: "connected", tools: ["echo", "ping"] })]),
    );
    const router = makeRouter(admin);

    const res = await post(router, "/api/mcp/test", { serverName: "echo" });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true }); // fire-and-forget：结果只走 SSE

    expect(admin.forceArgs).toEqual([true]); // 点「测试」不能拿缓存糊弄
    expect(broadcasts).toEqual([
      {
        type: "mcp:testResult",
        serverName: "echo",
        success: true,
        status: "connected",
        toolCount: 2,
      },
    ]);
  });

  test("pi 报 failed → testResult(status:error) 带上 pi 的错误文案", async () => {
    const router = makeRouter(
      makeAdmin(
        listResult([
          report("bad", { state: "failed", error: "MCP connection closed" }),
        ]),
      ),
    );

    await post(router, "/api/mcp/test", { serverName: "bad" });
    expect(broadcasts[0]).toMatchObject({
      type: "mcp:testResult",
      serverName: "bad",
      success: false,
      status: "error",
      error: "MCP connection closed",
    });
  });

  test("enabled:false 的 server（pi 报 state:disabled）→ disconnected，不误报成错误", async () => {
    const router = makeRouter(
      makeAdmin(listResult([report("off", { enabled: false, state: "disabled" })])),
    );

    await post(router, "/api/mcp/test", { serverName: "off" });
    const ev = broadcasts[0] as any;
    expect(ev.status).toBe("disconnected");
    expect(ev.success).toBe(false);
    expect(ev.error).toBeUndefined();
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

  test("pi 命令没跑起来 → testResult 报「状态读不到」而不是「服务器不存在」", async () => {
    const router = makeRouter(
      makeAdmin(listResult([], { commandFailed: true, hasProblems: true })),
    );

    await post(router, "/api/mcp/test", { serverName: "echo" });
    const ev = broadcasts[0] as any;
    expect(ev.success).toBe(false);
    expect(ev.status).toBe("error");
    expect(ev.code).toBeUndefined(); // 无字典条目 → 让前端原样展示文案
    expect(ev.error).toContain("pi mcp list");
  });
});

describe("GET /api/mcp/:serverName/tools", () => {
  test("→ 200 {ok:true} + 广播 mcp:tools（名字列表包装成工具摘要）", async () => {
    const admin = makeAdmin(
      listResult([report("echo", { tools: ["echo", "ping"] })]),
    );
    const router = makeRouter(admin);

    const res = await get(router, "/api/mcp/echo/tools");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(admin.forceArgs).toEqual([true]);
    expect(broadcasts).toEqual([
      {
        type: "mcp:tools",
        serverName: "echo",
        tools: [{ name: "echo" }, { name: "ping" }],
      },
    ]);
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

  test("POST /api/mcp（保存）→ 200 + SSE 广播 mcp:changed（写盘后的清单）", async () => {
    sseBuf = "";
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { name: "echo", command: "node" } }),
    });
    expect(res.status).toBe(200);

    let ev: any;
    for (let i = 0; i < 5; i++) {
      ev = await readSseEvent();
      if (ev.type === "mcp:changed") break;
    }
    expect(ev.type).toBe("mcp:changed");
    expect(ev.servers.map((s: any) => s.name)).toEqual(["echo"]);
    // 盘上确实写了（保存不是只广播）
    expect(
      JSON.parse(await readFile(join(sseDir, "mcp.json"), "utf8")).mcpServers.echo
        .command,
    ).toBe("node");
  });

  test("GET /api/mcp 走真实路由（全局作用域）：返回配置 + 状态", async () => {
    const res = await fetch(`${base}/api/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: McpServerConfig[] };
    expect(body.servers.map((s) => s.name)).toEqual(["echo"]);
    expect((body.servers[0] as any).state).toBe("connected");
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
