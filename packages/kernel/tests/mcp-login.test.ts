/**
 * MCP OAuth 登录 / 登出（规格 F19/F20）—— 本任务的核心测试。
 *
 * 三层证据：
 *   1. 纯函数：`extractAuthorizationUrl`（pi 把授权 URL 打到 stdout，F20）与 `lastNonEmptyLine`
 *      （失败原因在末行）、`normalizeMcpAuthKey`（盘上的键是 `String(new URL(url))`）；
 *   2. 真子进程：`McpLoginRunner` 用假 pi（tests/fixtures/fake-mcp-login-pi.ts）覆盖逐行转发、
 *      argv/环境变量、超时 kill、stderr 捕获、logout 成功/失败——这些分支 mock 不出来；
 *   3. 路由：`POST /api/mcp/login` 立即受理（长任务不押在回包上）+ 经 SSE 回流 URL/结果，
 *      以及列表里下发的 `signedIn`（含「盘上键为 https://host/、传入 https://host」的规范化一例）。
 *
 * 假件边界：配置读写用真实 McpFile（globalPath 指向 tmpdir），状态读取者用 canned 结果；
 * MCP 子进程一律走假 pi，绝不在单测里跑真 pi 的 OAuth。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRouter } from "../src/http-router";
import type { McpListResult } from "../src/mcp-admin";
import { McpAdmin, normalizeMcpAuthKey } from "../src/mcp-admin";
import { McpFile } from "../src/mcp-file";
import {
  LOGIN_KILL_GRACE_SEC,
  MAX_LOGIN_TIMEOUT_SEC,
  McpLoginRunner,
  extractAuthorizationUrl,
  lastNonEmptyLine,
} from "../src/mcp-login";
import type { McpLoginProcess } from "../src/mcp-login";
import { createMcpRoutes } from "../src/routes/mcp";
import type { WSServerEvent } from "@wa-pi/shared";

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-mcp-login-pi.ts");
const AUTH_URL = "http://127.0.0.1:59998/authorize?client_id=x";

/** 假 pi 的行为开关（模式见 fixture 顶部注释） */
function useMode(mode: string): void {
  process.env.MCP_LOGIN_TEST_MODE = mode;
}

/** 本文件建的临时目录（用例结束后统一清理，不往系统 tmp 里扔垃圾） */
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.MCP_LOGIN_TEST_MODE;
  delete process.env.MCP_LOGIN_TEST_URL;
  delete process.env.MCP_LOGIN_TEST_SERVER_URL;
  delete process.env.MCP_LOGIN_ARGV_FILE;
  delete process.env.MCP_LOGIN_ACTIVITY_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/** 造一个走假 pi 的 runner；返回留痕文件路径与「invalidate 被调几次」 */
async function makeRunner(
  opts: { agentDir?: string; killGraceSec?: number } = {},
) {
  const dir = opts.agentDir ?? (await tempDir("mcp-login-"));
  const argvFile = join(dir, "argv.log");
  process.env.MCP_LOGIN_ARGV_FILE = argvFile;
  const real = new McpAdmin({
    runtime: process.execPath,
    cliPath: FAKE_PI,
    agentDir: dir,
    cwd: dir,
  });
  let invalidations = 0;
  const admin = {
    invalidate: () => {
      invalidations++;
      real.invalidate();
    },
    isSignedIn: (url: string) => real.isSignedIn(url),
  };
  const runner = new McpLoginRunner(admin, {
    runtime: process.execPath,
    cliPath: FAKE_PI,
    agentDir: dir,
    cwd: dir,
    killGraceSec: opts.killGraceSec ?? 15,
  });
  return {
    runner,
    admin,
    dir,
    argvFile,
    invalidations: () => invalidations,
    argvs: () => readArgvs(argvFile),
  };
}

/** 假 pi 留痕的 argv / agentDir（没跑过则空数组） */
function readArgvs(file: string): { argv: string[]; agentDir: string }[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function activityLength(file: string): number {
  try {
    return readFileSync(file, "utf8").length;
  } catch {
    return 0;
  }
}

/** 子进程真被杀掉的证据：留痕文件在两个采样点之间不再增长 */
async function expectStopped(file: string): Promise<void> {
  await Bun.sleep(300);
  const first = activityLength(file);
  await Bun.sleep(300);
  expect(activityLength(file)).toBe(first);
}

/**
 * 「在硬上限内收场」的断言：超过 ms 仍未兼现就判失败。
 *
 * 必须自带超时：被断言的正是「上一次会永不返回」的行为——直接 await 的话，红跑会挂成死等，
 * 而不是把缺口变红。
 */
function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}（超过 ${ms}ms）`)), ms),
    ),
  ]);
}

/**
 * 假子进程：stdout / stderr 立刻 EOF（= pi 关掉了输出），但 `exited` 永不兼现（= pi 不退出）。
 * 返回 `signals`：记录收到的终止信号（`undefined` = SIGTERM）。
 */
function closingStdoutProcess(): { proc: McpLoginProcess; signals: string[] } {
  const signals: string[] = [];
  const closed = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const proc: McpLoginProcess = {
    stdout: closed(),
    stderr: closed(),
    exited: new Promise<number>(() => {}),
    exitCode: null,
    kill: (signal) => {
      // 不带信号 = SIGTERM（Bun 的语义），记成名字才好断言
      signals.push(signal ?? "SIGTERM");
    },
  };
  return { proc, signals };
}

describe("extractAuthorizationUrl（F20：非 TTY 下 URL 打到 stdout）", () => {
  test("从 stdout 提取授权 URL", () => {
    const out = `Sign in to MCP server "remote" in your browser:\nhttp://127.0.0.1:59998/authorize?client_id=x\n`;
    expect(extractAuthorizationUrl(out)).toBe(AUTH_URL);
  });

  test("无 URL 时返回 null", () => {
    expect(extractAuthorizationUrl("failed to connect")).toBe(null);
  });

  test("带终端着色时剥掉 ANSI，URL 尾巴不粘转义码", () => {
    const out = `Sign in to MCP server "remote" in your browser:\n\u001b[36m${AUTH_URL}\u001b[0m\n`;
    expect(extractAuthorizationUrl(out)).toBe(AUTH_URL);
  });

  test("只取第一条：说明行在前、URL 未出现时返回 null", () => {
    expect(
      extractAuthorizationUrl(
        `Sign in to MCP server "srv" in your browser:\n`,
      ),
    ).toBe(null);
  });
});

describe("登录超时的上界（防止 setTimeout 溢出）", () => {
  test("上限 + 宽限的毫秒数不过 2^31−1：溢出会被运行时截断成 1ms（= 刚 spawn 就秒杀 pi）", () => {
    expect((MAX_LOGIN_TIMEOUT_SEC + LOGIN_KILL_GRACE_SEC) * 1000).toBeLessThanOrEqual(
      2 ** 31 - 1,
    );
  });
});

describe("lastNonEmptyLine（失败原因在末行）", () => {
  test("取最后一条非空行并剥 ANSI / 去空白", () => {
    const out = `Sign in to MCP server "srv" in your browser:\n${AUTH_URL}\n\n\u001b[31mcancelled or not completed within 3 seconds\u001b[0m\n`;
    expect(lastNonEmptyLine(out)).toBe(
      "cancelled or not completed within 3 seconds",
    );
  });

  test("全是空白 → 空串（调用方自己兜底文案）", () => {
    expect(lastNonEmptyLine("\n  \n")).toBe("");
  });
});

describe("normalizeMcpAuthKey（pi 的键 = String(new URL(url))）", () => {
  test("主机名大小写 / 默认端口 / 无路径尾斜杠差异都归一到同一个键", () => {
    const canonical = "https://host/";
    expect(normalizeMcpAuthKey("https://host/")).toBe(canonical);
    expect(normalizeMcpAuthKey("https://host")).toBe(canonical);
    expect(normalizeMcpAuthKey("https://HOST:443")).toBe(canonical);
    expect(normalizeMcpAuthKey("https://host:443/")).toBe(canonical);
  });

  test("非 URL（含原型链键）→ null", () => {
    expect(normalizeMcpAuthKey("toString")).toBe(null);
    expect(normalizeMcpAuthKey("")).toBe(null);
    expect(normalizeMcpAuthKey("not a url")).toBe(null);
  });
});

describe("McpLoginRunner（真子进程 + 假 pi）", () => {
  test("逐行转发 stdout、提取 URL、按 pi 的形态传 argv 与环境变量", async () => {
    useMode("ok");
    const { runner, argvs, dir } = await makeRunner();
    const lines: string[] = [];

    const res = await runner.run({ server: "srv", timeoutSec: 3, onLine: (l) => lines.push(l) });

    expect(res.ok).toBe(true);
    expect(res.url).toBe(AUTH_URL);
    // 逐行转发：说明行与 URL 行都在（前端据此显示进度并拿到 URL）
    expect(lines).toEqual([
      `Sign in to MCP server "srv" in your browser:`,
      AUTH_URL,
    ]);
    // 命令形态与 POC 一致；凭据目录经 PI_CODING_AGENT_DIR 传给子进程
    const dump = argvs();
    expect(dump).toHaveLength(1);
    expect(dump[0].argv).toEqual(["mcp", "login", "srv", "--timeout", "3"]);
    expect(dump[0].agentDir).toBe(dir);
  });

  test("登录成功后失效状态缓存，且 pi 落的凭据能被 isSignedIn 认出（F19 闭环）", async () => {
    useMode("ok");
    const { runner, admin, invalidations } = await makeRunner();

    await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });

    expect(invalidations()).toBe(1);
    // 假 pi 按 pi 的真实做法写的是规范化键
    expect(await admin.isSignedIn(AUTH_URL)).toBe(true);
  });

  test("超时（pi 退 1 并报 cancelled）：ok:false 但仍把 URL 交出来", async () => {
    useMode("timeout");
    const { runner } = await makeRunner();

    const res = await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });

    expect(res.ok).toBe(false);
    expect(res.url).toBe(AUTH_URL); // 超时前 pi 已经打过 URL，用户仍可手动访问
    expect(lastNonEmptyLine(res.output)).toBe(
      "cancelled or not completed within 3 seconds",
    );
  });

  test("stdio 服务器（原因只打在 stderr）：ok:false、无 URL，错误文案取自 stderr", async () => {
    useMode("stdio");
    const { runner } = await makeRunner();

    const res = await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });

    expect(res.ok).toBe(false);
    expect(res.url).toBe(null);
    // stderr 被排空并计入 output：否则这条原因就丢了（pi 只在这里报「不支持 OAuth」）
    expect(lastNonEmptyLine(res.output)).toContain("does not use OAuth");
  });

  test("pi 一个字都不打就失败：output 为空、仍按失败上报", async () => {
    useMode("stderr-only");
    const { runner } = await makeRunner();

    const res = await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });

    expect(res.ok).toBe(false);
    expect(res.url).toBe(null);
    expect(lastNonEmptyLine(res.output)).toBe("failed to connect to MCP server");
  });

  test("pi 卡住不退出：到（timeout + 宽限）被 kill，不挂住调用方", async () => {
    useMode("hang");
    const dir = await tempDir("mcp-login-hang-");
    const activityFile = join(dir, "activity.log");
    process.env.MCP_LOGIN_ACTIVITY_FILE = activityFile;
    const { runner, invalidations } = await makeRunner({
      agentDir: dir,
      killGraceSec: 0.2,
    });

    const startedAt = Date.now();
    const res = await runner.run({ server: "srv", timeoutSec: 0.2, onLine: () => {} });

    expect(Date.now() - startedAt).toBeLessThan(5000); // 0.4s 就该收场，远不该等成 15s
    expect(res.ok).toBe(false);
    expect(res.url).toBe(null);
    expect(invalidations()).toBe(1); // 失败也失效缓存：状态可能已经变了
    await expectStopped(activityFile); // kill 真的生效
  });

  test("pi 关掉 stdout 却不退出：宽限 kill（SIGTERM→SIGKILL）后按失败收场，不无界等退出", async () => {
    // 为什么用假子进程而不是真假 pi：Bun 的子进程会自己攥着 stdout 管道直到退出（实测
    // process.stdout.end() / closeSync(1) 都不产生父进程侧的 EOF），所以真子进程造不出
    // 「stdout 已关但进程还活着」——而这正是宽限 kill 唯一需要生效的场景。被测的仍然是真的
    // McpLoginRunner.run：读循环、截止时间、kill 与收场全是真的。
    const { proc, signals } = closingStdoutProcess();
    let invalidations = 0;
    const runner = new McpLoginRunner(
      {
        invalidate: () => {
          invalidations++;
        },
      },
      {
        runtime: "-",
        cliPath: "-",
        agentDir: tmpdir(),
        cwd: tmpdir(),
        killGraceSec: 0.2,
        spawnImpl: () => proc,
      },
    );

    const res = await bounded(
      runner.run({ server: "srv", timeoutSec: 0.2, onLine: () => {} }),
      4000,
      "登录没有在硬上限内收场",
    );

    expect(res.ok).toBe(false);
    expect(res.url).toBe(null);
    expect(invalidations).toBe(1); // 失败也失效缓存：登录态可能已经变了
    // 两道防线都发过：不带信号 = SIGTERM（礼貌），SIGKILL 是「连 SIGTERM 都不理」时的兜底
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("logout 成功：argv 正确、凭据条目被删、缓存失效", async () => {
    useMode("ok");
    const { runner, admin, argvs, invalidations } = await makeRunner();
    await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });
    expect(await admin.isSignedIn(AUTH_URL)).toBe(true);

    useMode("logout-ok");
    const res = await runner.logout("srv");

    expect(res.ok).toBe(true);
    expect(argvs().at(-1)?.argv).toEqual(["mcp", "logout", "srv"]);
    expect(await admin.isSignedIn(AUTH_URL)).toBe(false);
    expect(invalidations()).toBe(2);
  });

  test("logout 失败：ok:false，错误文案取自 pi 的 stderr", async () => {
    useMode("logout-fail");
    const { runner } = await makeRunner();

    const res = await runner.logout("ghost");

    expect(res.ok).toBe(false);
    expect(lastNonEmptyLine(res.output)).toContain("not found");
  });

  test("spawn 起不来（运行时不存在）：按失败返回，不抛错", async () => {
    const runner = new McpLoginRunner(
      { invalidate: () => {} },
      {
        runtime: join(tmpdir(), "definitely-not-a-real-runtime"),
        cliPath: FAKE_PI,
        agentDir: tmpdir(),
        cwd: tmpdir(),
      },
    );

    const res = await runner.run({ server: "srv", timeoutSec: 3, onLine: () => {} });

    expect(res.ok).toBe(false);
    expect(res.url).toBe(null);
    expect(lastNonEmptyLine(res.output)).not.toBe("");
  });
});

// ===== 路由层：POST 立即受理 + SSE 回流 =====

describe("POST /api/mcp/login（长任务：受理与结果分离）", () => {
  let dir: string;
  let agentDir: string;
  let broadcasts: WSServerEvent[];
  let invalidations: number;
  let cwdForProject: (projectId?: string) => Promise<string>;

  beforeEach(async () => {
    dir = await tempDir("mcp-login-routes-");
    agentDir = await tempDir("mcp-login-agent-");
    broadcasts = [];
    invalidations = 0;
    cwdForProject = async () => dir;
  });

  afterEach(async () => {
    // 清理在文件级的 afterEach 里统一做（tempDirs）
  });

  /** 假的状态读取者：`pi mcp list` 报一台 HTTP server（已连与否由凭据决定，这里不模拟） */
  function makeAdmin() {
    const result: McpListResult & { stale: boolean } = {
      servers: [
        {
          name: "srv",
          scope: "global",
          enabled: true,
          exposure: "direct",
          state: "needs-auth",
          tools: [],
        },
      ],
      errors: [],
      commandFailed: false,
      hasProblems: false,
      stale: false,
    };
    return {
      list: async () => result,
      invalidate: () => {},
    };
  }

  function makeRouter(opts: { killGraceSec?: number; admin?: unknown; spawnImpl?: () => McpLoginProcess } = {}) {
    const router = new HttpRouter();
    const file = new McpFile({
      globalPath: join(dir, "mcp.json"),
      projectPathFor: async (projectId) =>
        join(await cwdForProject(projectId), ".pi", "mcp.json"),
    });
    createMcpRoutes({
      mcpFile: file,
      cwdForProject: (projectId) => cwdForProject(projectId),
      adminForCwd: () => (opts.admin ?? makeAdmin()) as never,
      invalidateCaches: () => {
        invalidations++;
      },
      broadcast: (e) => broadcasts.push(e),
      piSpawn: {
        runtime: process.execPath,
        cliPath: FAKE_PI,
        agentDir,
        // 让「pi 卡住」的用例秒级收场（生产缺省 15s）
        ...(opts.killGraceSec !== undefined
          ? { killGraceSec: opts.killGraceSec }
          : {}),
        // 同上：注入假子进程（只给「stdout 已关但进程不退出」那条形态用）
        ...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
      },
    })(router, (async () => Response.json({})) as never, {
      projectStore: {
        load: async () => ({ projects: [], sessions: [] }),
      } as never,
    });
    return router;
  }

  function postLogin(router: HttpRouter, body: unknown): Promise<Response | null> {
    return router.handle(
      new Request("http://localhost/api/mcp/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test("缺 serverName / timeoutSec 非法 → 400，且不 spawn、不广播", async () => {
    const router = makeRouter();
    const post = (body: unknown) => postLogin(router, body);

    for (const body of [
      {},
      { serverName: "" },
      { serverName: "srv", timeoutSec: 0 },
      { serverName: "srv", timeoutSec: -1 },
      { serverName: "srv", timeoutSec: "3" },
    ]) {
      const res = await post(body);
      expect(res?.status).toBe(400);
      expect((await res!.json()).failure.code).toBe("common.missingParam");
    }
    expect(broadcasts).toEqual([]);
    expect(invalidations).toBe(0);
  });

  test("项目不存在 → 404（cwd 解析必须在回包前完成）", async () => {
    cwdForProject = async () => {
      const { KernelError } = await import("@wa-pi/shared");
      throw new KernelError("project.notFound", { id: "ghost" });
    };
    const router = makeRouter();

    const res = await postLogin(router, { serverName: "srv", projectId: "ghost" });

    expect(res?.status).toBe(404);
    expect(broadcasts).toEqual([]);
  });

  test("登录成功：立即 200 → SSE 依次给出 running/authorizationUrl/ok，随后广播带 signedIn 的清单", async () => {
    useMode("ok");
    // 盘上的键是 pi 规范化后的 server URL（`https://host/`），而配置里写的是 `https://host`：
    // 两者必须被当成同一个 server，否则登录成功后列表仍报「未登录」
    process.env.MCP_LOGIN_TEST_SERVER_URL = "https://host/";
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: { srv: { url: "https://host" } },
      }),
      "utf8",
    );
    const router = makeRouter();
    const res = await postLogin(router, { serverName: "srv", timeoutSec: 3 });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });

    await waitFor(() => broadcasts.some((e: any) => e.phase === "ok"));
    const loginEvents = broadcasts.filter((e: any) => e.type === "mcp:login") as any[];
    expect(loginEvents[0]).toMatchObject({ serverName: "srv", phase: "running" });
    expect(loginEvents.some((e) => e.phase === "authorizationUrl" && e.url === AUTH_URL)).toBe(true);
    expect(loginEvents.at(-1)).toMatchObject({ phase: "ok" });
    // 成功后失效缓存 + 广播带登录态的清单（否则 UI 不会刷新成「已登录」）
    expect(invalidations).toBe(1);
    await waitFor(() => broadcasts.some((e: any) => e.type === "mcp:changed"));
    const changed = broadcasts.find((e: any) => e.type === "mcp:changed") as any;
    expect(changed.servers[0]).toMatchObject({
      name: "srv",
      url: "https://host",
      signedIn: true, // 规范化键命中（盘上 https://host/ ←→ 配置 https://host）
    });
  });

  test("stdio 服务器（不支持 OAuth）：SSE 报 error，文案取自 pi 的末行输出", async () => {
    useMode("stdio");
    const router = makeRouter();
    await postLogin(router, { serverName: "srv" });

    await waitFor(() => broadcasts.some((e: any) => e.phase === "error"));
    const err = broadcasts.find((e: any) => (e as any).phase === "error") as any;
    expect(err.type).toBe("mcp:login");
    expect(err.error).toContain("does not use OAuth");
    // 失败也不静默：缓存照样失效（凭据可能已变），清单照样广播
    expect(invalidations).toBe(1);
  });

  test("pi 卡住：回包不押在登录上（1000ms 内 200），超时后经 SSE 报 error", async () => {
    useMode("hang");
    const router = makeRouter({ killGraceSec: 0.2 });
    const startedAt = Date.now();
    const res = await Promise.race([
      postLogin(router, { serverName: "srv", timeoutSec: 1 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("回包被登录子进程挂住了")), 1000),
      ),
    ]);

    expect(res?.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await waitFor(() => broadcasts.some((e: any) => e.phase === "error"));
    // 没有任何输出 → 兜底文案，而不是把空串当错误显示
    const err = broadcasts.find((e: any) => (e as any).phase === "error") as any;
    expect(err.error).toBe("登录未完成（pi 没有输出原因）");
  });

  test("pi 关掉 stdout 却不退出：登录仍以 error 终态收场并失效缓存（不永远停在「等待授权」）", async () => {
    const { proc } = closingStdoutProcess();
    const router = makeRouter({ spawnImpl: () => proc, killGraceSec: 0.2 });

    const res = await postLogin(router, { serverName: "srv", timeoutSec: 1 });
    expect(res?.status).toBe(200);

    // 修复前：读循环一结束就清掉 kill 定时器，随后的 await proc.exited 没有上界
    // → 这里永远等不到任何终端事件（前端也就永远停在「等待授权」）
    await waitFor(() => broadcasts.some((e: any) => e.phase === "error"), 5000);
    const err = broadcasts.find((e: any) => (e as any).phase === "error") as any;
    expect(err.type).toBe("mcp:login");
    expect(err.error).toBe("登录未完成（pi 没有输出原因）");
    // 终端事件之前先失效缓存：下一次 mcp:changed 带的必须是最新登录态
    expect(invalidations).toBe(1);
    await waitFor(() => broadcasts.some((e: any) => e.type === "mcp:changed"));
  });

  test("timeoutSec 超过上限 → 400 且不 spawn（超大值会让定时器溢出，把 pi 1ms 秒杀）", async () => {
    useMode("ok");
    const argvFile = join(dir, "argv.log");
    process.env.MCP_LOGIN_ARGV_FILE = argvFile;
    const router = makeRouter();

    for (const timeoutSec of [MAX_LOGIN_TIMEOUT_SEC + 1, 1e9, Number.MAX_SAFE_INTEGER]) {
      const res = await postLogin(router, { serverName: "srv", timeoutSec });
      expect(res?.status).toBe(400);
      expect((await res!.json()).failure.code).toBe("common.missingParam");
    }
    // 关键证据：pi 一次都没被起过。超大毫秒数会被运行时截断成 1ms，子进程刚 spawn 就被 SIGTERM，
    // 而前端只会看到「登录未完成（pi 没有输出原因）」这种误诊我们自己的错的文案。
    await Bun.sleep(200);
    expect(readArgvs(argvFile)).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(invalidations).toBe(0);
  });

  test("timeoutSec 取到上限仍受理，且转给 pi 的 --timeout 就是上限本身（不静默改小）", async () => {
    useMode("ok");
    const argvFile = join(dir, "argv.log");
    process.env.MCP_LOGIN_ARGV_FILE = argvFile;
    const router = makeRouter();

    const res = await postLogin(router, {
      serverName: "srv",
      timeoutSec: MAX_LOGIN_TIMEOUT_SEC,
    });

    expect(res?.status).toBe(200);
    await waitFor(() => readArgvs(argvFile).length === 1);
    expect(readArgvs(argvFile)[0].argv).toEqual([
      "mcp",
      "login",
      "srv",
      "--timeout",
      String(MAX_LOGIN_TIMEOUT_SEC),
    ]);
    await waitFor(() => broadcasts.some((e: any) => e.phase === "ok"));
  });
});

describe("POST /api/mcp/logout", () => {
  let dir: string;
  let agentDir: string;
  let broadcasts: WSServerEvent[];
  let invalidations: number;

  beforeEach(async () => {
    dir = await tempDir("mcp-logout-routes-");
    agentDir = await tempDir("mcp-logout-agent-");
    broadcasts = [];
    invalidations = 0;
  });

  afterEach(async () => {
    // 清理在文件级的 afterEach 里统一做（tempDirs）
  });

  function makeRouter() {
    const router = new HttpRouter();
    createMcpRoutes({
      mcpFile: new McpFile({
        globalPath: join(dir, "mcp.json"),
        projectPathFor: async () => join(dir, ".pi", "mcp.json"),
      }),
      cwdForProject: async () => dir,
      adminForCwd: () =>
        ({
          list: async () => ({
            servers: [],
            errors: [],
            commandFailed: false,
            hasProblems: false,
            stale: false,
          }),
          invalidate: () => {},
        }) as never,
      invalidateCaches: () => {
        invalidations++;
      },
      broadcast: (e) => broadcasts.push(e),
      piSpawn: { runtime: process.execPath, cliPath: FAKE_PI, agentDir },
    })(router, (async () => Response.json({})) as never, {
      projectStore: { load: async () => ({ projects: [], sessions: [] }) } as never,
    });
    return router;
  }

  const postLogout = (router: HttpRouter, body: unknown) =>
    router.handle(
      new Request("http://localhost/api/mcp/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("缺 serverName → 400", async () => {
    const res = await postLogout(makeRouter(), {});
    expect(res?.status).toBe(400);
    expect((await res!.json()).failure.code).toBe("common.missingParam");
  });

  test("成功：200 {ok:true}、凭据条目被删、失效缓存并广播 mcp:changed", async () => {
    useMode("logout-ok");
    // 盘上先有一条规范化键的凭据（pi 的形态）
    await writeFile(
      join(agentDir, "mcp-auth.json"),
      JSON.stringify({ [normalizeMcpAuthKey(AUTH_URL)!]: { tokens: {} } }),
      "utf8",
    );
    const router = makeRouter();

    const res = await postLogout(router, { serverName: "srv" });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(invalidations).toBe(1);
    const auth = JSON.parse(await Bun.file(join(agentDir, "mcp-auth.json")).text());
    expect(Object.keys(auth)).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(broadcasts.some((e: any) => e.type === "mcp:changed")).toBe(true);
  });

  test("失败（pi 报 server 不存在）→ 400 且带上 pi 的原因", async () => {
    useMode("logout-fail");
    const router = makeRouter();

    const res = await postLogout(router, { serverName: "ghost" });
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toContain("not found");
    // 失败不失效、不广播：盘上什么都没变
    expect(invalidations).toBe(0);
    expect(broadcasts).toEqual([]);
  });
});
