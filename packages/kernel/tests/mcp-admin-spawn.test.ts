// McpAdmin 的 spawn 层测试。
//
// 两个层次：
//   1. 假 pi（tests/fixtures/fake-mcp-list-pi.ts）—— 覆盖缓存命中、输出不可解析时的
//      缓存回退（规格 §8）以及超时 kill 两条分支：这些分支用真 pi 造不出来。
//   2. 真 pi（resolvePiCliPath / resolvePiRuntime）—— 锁住 F14 的真实输出形态：
//      空配置退 0，而"某台 server 起不来"时**退 1 但 stdout 仍是合法 JSON**，
//      后者正是 commandFailed 只认解析结果的依据。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAdmin } from "../src/mcp-admin.ts";
import { resolvePiCliPath, resolvePiRuntime } from "../src/rpc-client.ts";

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-mcp-list-pi.ts");

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
});

describe("McpAdmin 真实 spawn（真 pi，F14）", () => {
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
});
