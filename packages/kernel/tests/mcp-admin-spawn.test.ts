// McpAdmin 的 spawn 层测试。
//
// 两个层次：
//   1. 假 pi（tests/fixtures/fake-mcp-list-pi.ts）—— 覆盖缓存命中、输出不可解析时的
//      缓存回退（规格 §8）以及超时 kill 两条分支：这些分支用真 pi 造不出来。
//   2. 真 pi（resolvePiCliPath / resolvePiRuntime）—— 锁住 F14 的真实输出形态：
//      空配置退 0，而"某台 server 起不来"时**退 1 但 stdout 仍是合法 JSON**，
//      后者正是 commandFailed 只认解析结果的依据。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIST_TIMEOUT_MS, McpAdmin } from "../src/mcp-admin.ts";
import { resolvePiCliPath, resolvePiRuntime } from "../src/rpc-client.ts";

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-mcp-list-pi.ts");

/** pi 的配置目录名（<cwd>/.pi/mcp.json 就是项目级配置） */
const CONFIG_DIR_NAME = ".pi";

afterEach(() => {
  delete process.env.MCP_ADMIN_TEST_MODE;
  delete process.env.MCP_ADMIN_ACTIVITY_FILE;
});

/** 造一个走假 pi 的 McpAdmin；activityFile 记录假进程的存活痕迹 */
async function fakeAdmin(opts: { timeoutMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "admin-fake-"));
  const activityFile = join(dir, "activity.log");
  process.env.MCP_ADMIN_ACTIVITY_FILE = activityFile;
  const admin = new McpAdmin({
    runtime: process.execPath,
    cliPath: FAKE_PI,
    agentDir: dir,
    cwd: dir,
    timeoutMs: opts.timeoutMs,
  });
  return { admin, activityFile };
}

function activityLength(file: string): number {
  try {
    return readFileSync(file, "utf8").length;
  } catch {
    return 0; // 还没被创建
  }
}

/** 子进程真被杀掉的证据：留痕文件在两个采样点之间不再增长 */
async function expectStopped(file: string): Promise<void> {
  await Bun.sleep(300);
  const first = activityLength(file);
  await Bun.sleep(300);
  expect(activityLength(file)).toBe(first);
}

async function realAdmin(config: unknown): Promise<McpAdmin> {
  const agentDir = await mkdtemp(join(tmpdir(), "admin-real-"));
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config), "utf8");
  return new McpAdmin({
    runtime: resolvePiRuntime(),
    cliPath: resolvePiCliPath(),
    agentDir,
    cwd: agentDir,
    timeoutMs: 30_000,
  });
}

describe("McpAdmin 缓存与失败回退（假 pi）", () => {
  test("输出可解析：结果进缓存，非 force 调用不再 spawn", async () => {
    const { admin, activityFile } = await fakeAdmin();
    process.env.MCP_ADMIN_TEST_MODE = "ok";
    const first = await admin.list();
    expect(first.commandFailed).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.servers.map((s) => s.name)).toEqual(["srv"]);
    expect(first.servers[0].tools).toEqual(["t1", "t2"]);

    const spawns = activityLength(activityFile);
    const second = await admin.list();
    expect(second.stale).toBe(false);
    expect(second.servers).toEqual(first.servers);
    expect(activityLength(activityFile)).toBe(spawns); // 没再起子进程

    const third = await admin.list(true); // force 才重新读
    expect(third.stale).toBe(false);
    expect(activityLength(activityFile)).toBeGreaterThan(spawns);
  });

  test("stdout 按 UTF-8 解码：中文原样读出（规格 §7）", async () => {
    const { admin } = await fakeAdmin();
    process.env.MCP_ADMIN_TEST_MODE = "utf8";
    const res = await admin.list();
    expect(res.commandFailed).toBe(false);
    expect(res.errors).toEqual(["配置损坏：mcp.json 第 1 行无法解析"]);
  });

  test("输出不可解析且无缓存：commandFailed（不抛错、不进缓存伪装成成功）", async () => {
    const { admin } = await fakeAdmin();
    process.env.MCP_ADMIN_TEST_MODE = "garbage";
    const res = await admin.list();
    expect(res.commandFailed).toBe(true);
    expect(res.servers).toEqual([]);
    expect(res.stale).toBe(false);
  });

  test("首次失败进缓存：回读时标 stale，不再谎报新鲜（且失败没被固化）", async () => {
    const { admin, activityFile } = await fakeAdmin();
    process.env.MCP_ADMIN_TEST_MODE = "garbage";
    // 第一次真的跑过 → 这份失败是新鲜的
    const first = await admin.list();
    expect(first.commandFailed).toBe(true);
    expect(first.servers).toEqual([]);
    expect(first.stale).toBe(false);
    const spawns = activityLength(activityFile);

    // 非 force：缓存短路，本次根本没跑 → 旧失败必须标 stale，否则调用方分不清新旧
    const second = await admin.list();
    expect(second.commandFailed).toBe(true);
    expect(second.servers).toEqual([]);
    expect(second.stale).toBe(true);
    expect(activityLength(activityFile)).toBe(spawns); // 确实没再 spawn

    // force 重试仍失败：没有新鲜数据，依旧 stale
    const third = await admin.list(true);
    expect(third.commandFailed).toBe(true);
    expect(third.stale).toBe(true);
    expect(activityLength(activityFile)).toBeGreaterThan(spawns);

    // 恢复后拿得到新鲜数据：失败缓存不会把状态永久固化
    process.env.MCP_ADMIN_TEST_MODE = "ok";
    const fourth = await admin.list(true);
    expect(fourth.commandFailed).toBe(false);
    expect(fourth.stale).toBe(false);
    expect(fourth.servers.map((s) => s.name)).toEqual(["srv"]);
  });

  test("输出不可解析但有缓存：回退上一条缓存并标 stale（规格 §8）", async () => {
    const { admin, activityFile } = await fakeAdmin();
    process.env.MCP_ADMIN_TEST_MODE = "ok";
    const first = await admin.list();
    expect(first.stale).toBe(false);

    process.env.MCP_ADMIN_TEST_MODE = "garbage";
    const res = await admin.list(true);
    expect(res.stale).toBe(true); // UI 据此显示"状态未知"
    expect(res.commandFailed).toBe(false); // 回的是上一条成功的缓存
    expect(res.servers.map((s) => s.name)).toEqual(["srv"]);

    // 缓存没有被失败结果覆盖：下一次 force 成功仍拿得到数据
    process.env.MCP_ADMIN_TEST_MODE = "ok";
    expect((await admin.list(true)).servers.map((s) => s.name)).toEqual(["srv"]);
    expect(activityLength(activityFile)).toBeGreaterThan(0);
  });

  test("卡住的 pi 被超时截断：kill 子进程且不挂住调用方（无缓存分支）", async () => {
    const { admin, activityFile } = await fakeAdmin({ timeoutMs: 300 });
    process.env.MCP_ADMIN_TEST_MODE = "hang";
    const startedAt = Date.now();
    const res = await admin.list();
    expect(Date.now() - startedAt).toBeLessThan(5000); // 300ms 超时，远不该等这么久
    expect(res.commandFailed).toBe(true);
    expect(res.servers).toEqual([]);
    expect(res.stale).toBe(false);
    await expectStopped(activityFile); // kill 真的生效
  });

  test("卡住的 pi 被超时截断：有缓存时回退缓存并标 stale", async () => {
    const { admin, activityFile } = await fakeAdmin({ timeoutMs: 300 });
    process.env.MCP_ADMIN_TEST_MODE = "ok";
    expect((await admin.list()).stale).toBe(false);

    process.env.MCP_ADMIN_TEST_MODE = "hang";
    const startedAt = Date.now();
    const res = await admin.list(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(res.stale).toBe(true);
    expect(res.commandFailed).toBe(false);
    expect(res.servers.map((s) => s.name)).toEqual(["srv"]);
    await expectStopped(activityFile);
  });

  test("缺省 list 上限必须大于 pi 单台 server 的默认超时（60s）", () => {
    // pi 引擎 McpServerConnection 对单台 server 的请求超时缺省 60s（实测：一台不合规
    // server 会让 `pi mcp list` 整体跑 61s 才退出并报出各台真实状态）。kernel 上限若
    // ≤ 60s，pi 还没报出状态就被 kill → commandFailed → GUI 整页「状态未知」。
    expect(DEFAULT_LIST_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("漏传 timeoutMs：缺省上限生效，卡住的 pi 仍被截断（不会无限等待）", async () => {
    const { admin, activityFile } = await fakeAdmin(); // 不传 timeoutMs
    process.env.MCP_ADMIN_TEST_MODE = "hang";
    const startedAt = Date.now();
    const res = await admin.list();
    const elapsed = Date.now() - startedAt;
    expect(res.commandFailed).toBe(true);
    expect(res.servers).toEqual([]);
    expect(res.stale).toBe(false);
    // 等到的是缺省上限（不是立即返回、也不是无限等）
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_LIST_TIMEOUT_MS - 500);
    await expectStopped(activityFile); // kill 真的生效
  }, DEFAULT_LIST_TIMEOUT_MS + 15_000);
});

describe("McpAdmin 真实 spawn（真 pi，F14）", () => {
  test("项目作用域随 cwd 生效：未受信项目的 .pi/mcp.json 被忽略，受信后带上（F11/F12/F13）", async () => {
    // 白名单只取 direct+connected，但 "能不能看到项目级 server" 完全看 spawn 的 cwd：
    // pi 用 process.cwd() 去找 <cwd>/.pi/mcp.json。本用例用真 pi 锁住这条链。
    const agentDir = await mkdtemp(join(tmpdir(), "admin-proj-"));
    const projectCwd = await mkdtemp(join(tmpdir(), "admin-proj-cwd-"));
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { global_srv: { command: "definitely-not-a-real-binary-xyz" } },
      }),
      "utf8",
    );
    await mkdir(join(projectCwd, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(projectCwd, CONFIG_DIR_NAME, "mcp.json"),
      JSON.stringify({
        mcpServers: { proj_srv: { command: "definitely-not-a-real-binary-xyz" } },
      }),
      "utf8",
    );
    const admin = new McpAdmin({
      runtime: resolvePiRuntime(),
      cliPath: resolvePiCliPath(),
      agentDir,
      cwd: projectCwd,
      timeoutMs: 30_000,
    });

    // 未受信：项目配置被静默忽略，只有全局 server，且带 note（唯一的信号，F12）
    const untrusted = await admin.list();
    expect(untrusted.commandFailed).toBe(false);
    expect(untrusted.servers.map((s) => s.name)).toEqual(["global_srv"]);
    expect(untrusted.note).toContain("not trusted");

    // 受信（键 = realpath 原样，与 pi 的 ProjectTrustStore 一致）：项目 server 出现
    await writeFile(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(projectCwd)]: true }),
      "utf8",
    );
    const trusted = await admin.list(true);
    expect(trusted.commandFailed).toBe(false);
    expect(trusted.servers.map((s) => s.name).sort()).toEqual([
      "global_srv",
      "proj_srv",
    ]);
    expect(trusted.servers.find((s) => s.name === "proj_srv")?.scope).toBe(
      "project",
    );
  });

  test("空配置下返回空列表且命令成功", async () => {
    const admin = await realAdmin({ mcpServers: {} });
    const res = await admin.list();
    expect(res.commandFailed).toBe(false);
    expect(res.hasProblems).toBe(false);
    expect(res.servers).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  test("server 起不来：pi 退 1 但 stdout 仍合法 → 报异常态而非命令失败", async () => {
    const admin = await realAdmin({
      mcpServers: { broken: { command: "definitely-not-a-real-binary-xyz" } },
    });
    const res = await admin.list();
    expect(res.commandFailed).toBe(false); // 退出码 1 ≠ 命令失败（F14）
    expect(res.hasProblems).toBe(true);
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0].name).toBe("broken");
    expect(res.servers[0].state).toBe("failed");
    expect(res.servers[0].tools).toEqual([]);
    expect(res.servers[0].error).toBeTruthy();
  });

  test("server 被停用：pi 输出 state=disabled 且退 0 → 不算异常（F14）", async () => {
    const admin = await realAdmin({
      mcpServers: {
        off: { command: "definitely-not-a-real-binary-xyz", enabled: false },
      },
    });
    const res = await admin.list();
    expect(res.commandFailed).toBe(false);
    expect(res.hasProblems).toBe(false); // 用户刚关掉一台 server，pi 自己认为没问题
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0].enabled).toBe(false);
    expect(res.servers[0].state).toBe("disabled");
  });
});
