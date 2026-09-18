// process-registry 异步清扫测试（启动关键路径用）。
//
// 为什么要异步版：`sweepRegistry` 内部是 `spawnSync("powershell", …)`，实测 Windows 上
// **1 条残留登记就冻住主线程 1061ms**（启动页停在那不动、进度不刷新）；清扫还是逐条循环，
// N 条残留 = N × ~1s 冻屏。异步版用 execFile，语义逐条对齐同步版（TTL + 三重校验 +
// 失败保留登记），但不在主线程上同步等命令行进程。
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeFs from "node:fs";
import {
  sweepRegistryAsync,
  getProcessIdentityAsync,
} from "../src/util/process-registry.cjs";

const KERNEL_EXE = "C:\\wa-pi\\runtime\\WaPiKernel.exe";

async function makeWaPiDir(entries: object[] = []) {
  const base = await mkdtemp(join(tmpdir(), "registry-async-"));
  const reg = join(base, "run", "registry");
  await mkdir(reg, { recursive: true });
  for (const e of entries) {
    await writeFile(join(reg, `${(e as any).pid}.json`), JSON.stringify(e));
  }
  return { base, reg };
}

/** 造注入 opts：默认无任何子进程、绝不真杀 */
function makeOpts(
  waPiDir: string,
  over: {
    execFile?: any;
    kill?: (pid: number, sig?: string) => void;
    log?: (m: string) => void;
    platform?: string;
    scanProcesses?: () => any[];
  } = {},
) {
  const logs: string[] = [];
  const killed: number[] = [];
  const execCalls: string[] = [];
  const opts = {
    fs: nodeFs,
    spawnSync: () => {
      throw new Error("异步清扫不得调用 spawnSync（会冻住主线程）");
    },
    execFile: (file: string, args: string[], _o: any, cb: any) => {
      execCalls.push(file);
      return over.execFile ? over.execFile(file, args, _o, cb) : cb(null, "", "");
    },
    now: () => Date.now(),
    waPiDir,
    platform: over.platform ?? "win32",
    kill: (pid: number, sig?: string) => {
      // 只记真正的杀伐（SIGKILL）；不带信号的调用是 isProcessAlive 的存活探测，不算杀
      if (sig === "SIGKILL") killed.push(pid);
      if (over.kill) over.kill(pid);
    },
    log: (m: string) => {
      logs.push(m);
      over.log?.(m);
    },
    selfPid: 999999,
    scanProcesses: over.scanProcesses ?? (() => []),
  };
  return { opts, logs, killed, execCalls };
}

test("空登记簿：不产生任何子进程，结果全空（正常启动零开销）", async () => {
  const { base } = await makeWaPiDir([]);
  try {
    const { opts, execCalls } = makeOpts(base);
    const r = await sweepRegistryAsync(opts);
    expect(execCalls).toEqual([]);
    expect(r).toEqual({ killed: [], deleted: [], skipped: [], errors: [] });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("存活且匹配的残留（我方内核）：走异步身份查询 → 杀 → 删登记", async () => {
  const createdAt = Date.now() - 5000;
  const { base, reg } = await makeWaPiDir([
    { pid: 4242, exe: KERNEL_EXE, createdAt, registeredAt: Date.now() },
  ]);
  try {
    const { opts, killed, execCalls } = makeOpts(base, {
      // 模拟 powershell -Command 的 CIM JSON 输出（CreationDate 为 ISO 8601）
      execFile: (_f: string, _a: string[], _o: any, cb: any) =>
        cb(
          null,
          JSON.stringify({
            ProcessId: 4242,
            ExecutablePath: KERNEL_EXE,
            CreationDate: new Date(createdAt).toISOString(),
          }),
          "",
        ),
    });
    const r = await sweepRegistryAsync(opts);
    // Windows 上身份查询与杀伐都走 execFile（powershell / taskkill），不走 spawnSync
    expect(execCalls).toContain("powershell");
    expect(execCalls).toContain("taskkill");
    expect(r.killed).toEqual([4242]);
    expect(await readdir(reg)).toEqual([]); // 登记已删
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("身份查询失败（非 not-found）→ 保留登记 + errors 记录（不静默丢名单）", async () => {
  const { base, reg } = await makeWaPiDir([
    { pid: 4243, exe: KERNEL_EXE, createdAt: Date.now(), registeredAt: Date.now() },
  ]);
  try {
    const { opts, killed, execCalls } = makeOpts(base, {
      execFile: (_f: string, _a: string[], _o: any, cb: any) =>
        cb(Object.assign(new Error("exit 1"), { code: 1 }), "", ""),
    });
    const r = await sweepRegistryAsync(opts);
    expect(killed).toEqual([]);
    expect(execCalls).not.toContain("taskkill"); // 查询失败不杀
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].pid).toBe(4243);
    expect(await readdir(reg)).toEqual(["4243.json"]); // 登记保留，下轮重试
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("非我方（PID 复用 / exe 不符）：只删登记，绝不杀", async () => {
  const { base, reg } = await makeWaPiDir([
    { pid: 4244, exe: "C:\\other\\thing.exe", createdAt: Date.now(), registeredAt: Date.now() },
  ]);
  try {
    const { opts, killed, execCalls } = makeOpts(base, {
      execFile: (_f: string, _a: string[], _o: any, cb: any) =>
        cb(
          null,
          JSON.stringify({
            ProcessId: 4244,
            ExecutablePath: "C:\\other\\thing.exe",
            CreationDate: new Date().toISOString(),
          }),
          "",
        ),
    });
    const r = await sweepRegistryAsync(opts);
    expect(killed).toEqual([]);
    expect(execCalls).not.toContain("taskkill"); // 非我方 → 绝不杀
    expect(r.skipped).toEqual([4244]);
    expect(await readdir(reg)).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("进程不存在（ps/powershell 空输出）→ 只删登记", async () => {
  const { base, reg } = await makeWaPiDir([
    { pid: 4245, exe: KERNEL_EXE, createdAt: Date.now(), registeredAt: Date.now() },
  ]);
  try {
    const { opts, killed, execCalls } = makeOpts(base, {
      execFile: (_f: string, _a: string[], _o: any, cb: any) => cb(null, "", ""),
    });
    const r = await sweepRegistryAsync(opts);
    expect(killed).toEqual([]);
    expect(execCalls).not.toContain("taskkill");
    expect(r.deleted).toEqual([4245]);
    expect(await readdir(reg)).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("清扫内部异常不抛出（best-effort，不炸启动）", async () => {
  const { base } = await makeWaPiDir([
    { pid: 4246, exe: KERNEL_EXE, createdAt: Date.now(), registeredAt: Date.now() },
  ]);
  try {
    // execFile 同步抛（例如命令行工具缺失/参数非法）——清扫必须把它吞成 errors 记录
    const { opts } = makeOpts(base, {
      execFile: () => {
        throw new Error("boom");
      },
    });
    const r = await sweepRegistryAsync(opts); // 不得 reject
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors[0].pid).toBe(4246);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("getProcessIdentityAsync 与同步版对同一输出结果一致（语义等价）", async () => {
  const iso = "2026-09-18T09:00:00.1234567Z";
  const out = JSON.stringify({ ProcessId: 77, ExecutablePath: KERNEL_EXE, CreationDate: iso });
  const { base } = await makeWaPiDir([]);
  try {
    const { opts } = makeOpts(base, {
      execFile: (_f: string, _a: string[], _o: any, cb: any) => cb(null, out, ""),
    });
    const asyncRes = await getProcessIdentityAsync(77, opts);
    expect(asyncRes.ok).toBe(true);
    expect(asyncRes.identity.exe).toBe(KERNEL_EXE);
    // 同步版用同一份 stdout 解释 → 结果必须一致
    const syncRes = require("../src/util/process-registry.cjs").getProcessIdentity(77, {
      spawnSync: () => ({ status: 0, stdout: out }),
      platform: "win32",
      waPiDir: base,
    });
    expect(syncRes).toEqual(asyncRes);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
