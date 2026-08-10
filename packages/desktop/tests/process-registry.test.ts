// process-registry 单元测试：全程依赖注入（memfs 风格 fake fs / fake spawnSync / 注入 now），
// 平台分支通过注入 platform 覆盖，kill 一律注入 fake——绝不真杀进程、绝不真写 ~/.wa-pi。
import { test, expect, mock } from "bun:test";
import path from "node:path";
import {
  registerProcess,
  unregisterProcess,
  loadRegistry,
  isProcessAlive,
  getProcessIdentity,
  isOurs,
  sweepRegistry,
  killRegisteredProcesses,
  collectDescendants,
} from "../src/util/process-registry.cjs";

const TTL = 7 * 24 * 3600 * 1000;
const NOW = 1700000000000;
const WAPI_DIR = "/data/wa-pi";
const REG_DIR = path.join(WAPI_DIR, "run", "registry");

/** memfs 风格 fake fs：store 为 path→content 的 Map，记录 write/unlink 调用 */
function makeMemFs(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const written: string[] = [];
  const unlinked: string[] = [];
  return {
    store,
    written,
    unlinked,
    mkdirSync() {},
    writeFileSync(p: string, content: string) {
      const s = String(p);
      store.set(s, String(content));
      written.push(s);
    },
    readdirSync(p: string): string[] {
      const prefix = String(p).replace(/\/+$/, "");
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix + "/"))
        .map((k) => k.slice(prefix.length + 1))
        .filter((n) => !n.includes("/"));
    },
    readFileSync(p: string) {
      return store.get(String(p));
    },
    unlinkSync(p: string) {
      const s = String(p);
      store.delete(s);
      unlinked.push(s);
    },
  } as any;
}

/** 构造注入 opts：默认 win32 平台 + fake kill（绝不真杀）；spawnResult 可按 cmd 定制返回 */
function makeOpts(overrides: any = {}) {
  const fs = makeMemFs(overrides.seed ?? {});
  const spawnCalls: { cmd: string; args: string[] }[] = [];
  const killCalls: [number, unknown][] = [];
  const logs: string[] = [];
  const spawnSync = mock((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return overrides.spawnResult ? overrides.spawnResult(cmd, args) : { stdout: "", status: 0 };
  }) as any;
  const kill = mock((pid: number, sig: unknown) => {
    killCalls.push([pid, sig]);
    return overrides.killResult ? overrides.killResult(pid, sig) : undefined;
  }) as any;
  return {
    fs,
    spawnCalls,
    killCalls,
    logs,
    opts: {
      fs,
      spawnSync,
      now: () => overrides.now ?? NOW,
      waPiDir: overrides.waPiDir ?? WAPI_DIR,
      log: (m: string) => {
        logs.push(m);
      },
      platform: overrides.platform ?? "win32",
      kill,
      // scanProcesses 默认不注入（undefined）：模拟 main.cjs 现有调用不传时的行为
      scanProcesses: overrides.scanProcesses,
    },
  };
}

const entry1001 = {
  pid: 1001,
  exe: path.join(WAPI_DIR, "runtime", "kernel.exe"),
  createdAt: NOW,
  registeredAt: NOW,
};

function seedOne() {
  return { [path.join(REG_DIR, "1001.json")]: JSON.stringify(entry1001) };
}

/** NOW 对应的本地时间 lstart 字符串（parseLstart 秒级精度，落在 2s 容差内） */
function lstartFor(ts: number) {
  const d = new Date(ts);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}

/** 返回 powershell 身份查询的 fake spawnResult（CreationDate 由传入时间生成） */
function identityResult(createdAt: number, exe = entry1001.exe) {
  return (cmd: string) =>
    cmd === "powershell"
      ? {
          stdout: JSON.stringify({
            ProcessId: 1001,
            ExecutablePath: exe,
            CreationDate: new Date(createdAt).toISOString(),
          }),
          status: 0,
        }
      : { stdout: "", status: 0 };
}

test("registerProcess: 写入 run/registry/<pid>.json，字段齐全，registeredAt 取注入 now", () => {
  const ctx = makeOpts();
  registerProcess(1234, { exe: entry1001.exe, createdAt: NOW }, ctx.opts);
  const p = path.join(REG_DIR, "1234.json");
  expect(ctx.fs.store.get(p)).not.toBeUndefined();
  expect(JSON.parse(ctx.fs.store.get(p)!)).toEqual({
    pid: 1234,
    exe: entry1001.exe,
    createdAt: NOW,
    registeredAt: NOW,
  });
});

test("unregisterProcess: 删除登记文件；文件不存在不抛错", () => {
  const ctx = makeOpts({ seed: seedOne() });
  unregisterProcess(1001, ctx.opts);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
  expect(() => unregisterProcess(9999, ctx.opts)).not.toThrow();
});

test("loadRegistry: 读取多条登记；坏 JSON 文件被删除且不阻塞其他条目", () => {
  const seed = {
    [path.join(REG_DIR, "1001.json")]: JSON.stringify(entry1001),
    [path.join(REG_DIR, "1002.json")]: "not-json{{{",
    [path.join(REG_DIR, "1003.json")]: JSON.stringify({
      pid: 1003,
      exe: "/x/kernel",
      createdAt: NOW - 1000,
      registeredAt: NOW,
    }),
  };
  const ctx = makeOpts({ seed });
  const entries = loadRegistry(ctx.opts);
  expect(entries.map((e) => e.pid)).toEqual([1001, 1003]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1002.json"))).toBe(false); // 坏文件已删
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(true);
});

test("loadRegistry: createdAt/registeredAt 非法（缺失/非数字）→ 删文件跳过，不阻塞其他条目", () => {
  const seed = {
    [path.join(REG_DIR, "1001.json")]: JSON.stringify(entry1001),
    [path.join(REG_DIR, "2001.json")]: JSON.stringify({
      pid: 2001,
      exe: "/x/kernel",
      createdAt: "garbage", // 非数字 → 非法
      registeredAt: NOW,
    }),
    [path.join(REG_DIR, "3001.json")]: JSON.stringify({
      pid: 3001,
      exe: "/x/kernel",
      createdAt: NOW,
      registeredAt: null, // null → 非法
    }),
  };
  const ctx = makeOpts({ seed });
  const entries = loadRegistry(ctx.opts);
  expect(entries.map((e) => e.pid)).toEqual([1001]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "2001.json"))).toBe(false); // createdAt 非法 → 已删
  expect(ctx.fs.store.has(path.join(REG_DIR, "3001.json"))).toBe(false); // registeredAt 非法 → 已删
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(true); // 合法条目不受影响
});

test("sweepRegistry: 超 TTL → 只删文件不杀（不查身份不杀进程）", () => {
  const expired = { ...entry1001, registeredAt: NOW - TTL - 1 };
  const ctx = makeOpts({ seed: { [path.join(REG_DIR, "1001.json")]: JSON.stringify(expired) } });
  const r = sweepRegistry(ctx.opts);
  expect(r.deleted).toEqual([1001]);
  expect(r.killed).toEqual([]);
  expect(r.skipped).toEqual([]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
  expect(ctx.spawnCalls.some((c) => ["powershell", "ps", "taskkill"].includes(c.cmd))).toBe(false);
  expect(ctx.killCalls.length).toBe(0);
});

test("sweepRegistry: 进程已死（kill 探测抛 ESRCH）→ 只删不杀", () => {
  const ctx = makeOpts({
    seed: seedOne(),
    killResult: () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.deleted).toEqual([1001]);
  expect(r.killed).toEqual([]);
  expect(ctx.spawnCalls.length).toBe(0); // 已死 → 不查身份不杀
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("sweepRegistry: 进程不存在（查询成功但无输出 → not-found）→ 正常删登记", () => {
  const ctx = makeOpts({ seed: seedOne() }); // powershell 返回空 stdout → not-found
  const r = sweepRegistry(ctx.opts);
  expect(r.deleted).toEqual([1001]);
  expect(r.errors).toEqual([]);
  expect(ctx.spawnCalls.some((c) => c.cmd === "powershell")).toBe(true);
  expect(ctx.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(false);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("sweepRegistry: createdAt 不匹配（PID 复用）→ 只删不杀，记 skipped", () => {
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: identityResult(NOW + 86400000), // 创建时间差一天 → 判定 PID 复用
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.skipped).toEqual([1001]);
  expect(r.deleted).toEqual([]);
  expect(r.killed).toEqual([]);
  expect(ctx.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(false);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false); // 只删登记不动进程
});

test("sweepRegistry: exe 路径不含我方特征 → 只删不杀，记 skipped", () => {
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: identityResult(NOW, "C:\\Windows\\System32\\unknown.exe"),
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.skipped).toEqual([1001]);
  expect(r.deleted).toEqual([]);
  expect(ctx.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(false);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("sweepRegistry: 三重校验全过 → taskkill /T /F 带正确 pid，杀成功删文件记 killed", () => {
  const ctx = makeOpts({ seed: seedOne(), spawnResult: identityResult(NOW) });
  const r = sweepRegistry(ctx.opts);
  expect(r.killed).toEqual([1001]);
  expect(r.deleted).toEqual([]);
  expect(r.skipped).toEqual([]);
  const tk = ctx.spawnCalls.find((c) => c.cmd === "taskkill");
  expect(tk).toEqual({ cmd: "taskkill", args: ["/PID", "1001", "/T", "/F"] });
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false); // 杀成功删文件
  expect(ctx.killCalls.some(([, sig]) => sig === "SIGKILL")).toBe(false); // win 分支不走 SIGKILL
});

test("sweepRegistry: kill 失败（taskkill 退出码非 0）→ 保留文件记 skipped", () => {
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: (cmd: string) => {
      if (cmd === "powershell") return identityResult(NOW)(cmd);
      if (cmd === "taskkill") return { stdout: "", status: 128 }; // 权限不足/死 PID
      return { stdout: "", status: 0 };
    },
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.skipped).toEqual([1001]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(true); // 失败保留文件，下轮再试
});

test("sweepRegistry: 非 Windows 平台走 process.kill SIGKILL（注入 fake，不真杀）", () => {
  const ctx = makeOpts({
    platform: "darwin",
    seed: seedOne(),
    spawnResult: (cmd: string) =>
      cmd === "ps"
        ? { stdout: `${lstartFor(NOW)}     ${entry1001.exe} run kernel.js\n`, status: 0 }
        : { stdout: "", status: 0 },
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.killed).toEqual([1001]);
  expect(ctx.killCalls).toEqual([
    [1001, 0], // 校验①存活探测（信号 0，不杀）
    [1001, "SIGKILL"],
  ]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("killRegisteredProcesses: 复用于重启前清杀——全过则杀并删文件", () => {
  const ctx = makeOpts({ seed: seedOne(), spawnResult: identityResult(NOW) });
  const r = killRegisteredProcesses(ctx.opts);
  expect(r.killed).toEqual([1001]);
  expect(r.deleted).toEqual([]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("getProcessIdentity: Windows 走 PowerShell 解析 CreationDate/ExecutablePath", () => {
  const ctx = makeOpts({
    spawnResult: (cmd: string) =>
      cmd === "powershell"
        ? {
            stdout: JSON.stringify({
              ProcessId: 555,
              ExecutablePath: "C:\\wa-pi\\kernel.exe",
              CreationDate: "2023-11-14T22:13:20.123+08:00",
            }),
            status: 0,
          }
        : { stdout: "", status: 0 },
  });
  const id = getProcessIdentity(555, ctx.opts);
  expect(id).toEqual({
    ok: true,
    identity: { exe: "C:\\wa-pi\\kernel.exe", createdAt: Date.parse("2023-11-14T22:13:20.123+08:00") },
  });
  const ps = ctx.spawnCalls.find((c) => c.cmd === "powershell");
  // args = ["-NoProfile", "-Command", <CIM 查询串>]
  expect(ps!.args).toEqual(["-NoProfile", "-Command", expect.stringContaining("Get-CimInstance Win32_Process -Filter \"ProcessId=555\"") as any]);
  expect(ps!.args[2]).toContain("CreationDate");
});

test("getProcessIdentity: Windows 进程不存在（stdout 空）→ not-found 结果", () => {
  const ctx = makeOpts(); // powershell 空 stdout
  expect(getProcessIdentity(999999, ctx.opts)).toEqual({ ok: false, reason: "not-found" });
});

test("getProcessIdentity: Windows 查询失败（res.error：命令无法执行）→ reason=error", () => {
  const ctx = makeOpts({
    spawnResult: () => ({ error: new Error("spawn powershell ENOENT"), stdout: "", status: null }),
  });
  const id = getProcessIdentity(555, ctx.opts) as any;
  expect(id.ok).toBe(false);
  expect(id.reason).toBe("error");
});

test("getProcessIdentity: Windows 查询失败（PowerShell 退出码非 0）→ reason=error", () => {
  const ctx = makeOpts({
    spawnResult: () => ({ stdout: "", status: 1 }),
  });
  const id = getProcessIdentity(555, ctx.opts) as any;
  expect(id.ok).toBe(false);
  expect(id.reason).toBe("error");
});

test("getProcessIdentity: Windows 查询失败（CreationDate 格式不符）→ reason=error", () => {
  const ctx = makeOpts({
    spawnResult: (cmd: string) =>
      cmd === "powershell"
        ? {
            stdout: JSON.stringify({ ProcessId: 555, ExecutablePath: "C:\\x.exe", CreationDate: "not-a-date" }),
            status: 0,
          }
        : { stdout: "", status: 0 },
  });
  const id = getProcessIdentity(555, ctx.opts) as any;
  expect(id.ok).toBe(false);
  expect(id.reason).toBe("error");
});

test("getProcessIdentity: 非 Windows 走 ps 解析 lstart，exe 取 command 首 token", () => {
  const ctx = makeOpts({
    platform: "darwin",
    spawnResult: (cmd: string) =>
      cmd === "ps"
        ? { stdout: "Mon Aug 10 14:48:27 2026     /data/wa-pi/runtime/kernel.exe run kernel.js\n", status: 0 }
        : { stdout: "", status: 0 },
  });
  const id = getProcessIdentity(777, ctx.opts);
  expect(id).toEqual({
    ok: true,
    identity: { exe: "/data/wa-pi/runtime/kernel.exe", createdAt: new Date(2026, 7, 10, 14, 48, 27).getTime() },
  });
  const ps = ctx.spawnCalls.find((c) => c.cmd === "ps");
  expect(ps!.args).toEqual(["-o", "lstart=,command=", "-p", "777"]);
});

test("getProcessIdentity: ps 输出格式不符（stdout 非空但不匹配）→ reason=error", () => {
  const ctx = makeOpts({
    platform: "darwin",
    spawnResult: (cmd: string) =>
      cmd === "ps" ? { stdout: "boom garbage output\n", status: 0 } : { stdout: "", status: 0 },
  });
  const id = getProcessIdentity(777, ctx.opts) as any;
  expect(id.ok).toBe(false);
  expect(id.reason).toBe("error");
});

test("sweepRegistry: 身份查询失败 → 保留登记 + errors 可观测 + 日志记录，不杀进程", () => {
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: () => ({ error: new Error("spawn powershell ENOENT"), stdout: "", status: null }),
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.deleted).toEqual([]);
  expect(r.killed).toEqual([]);
  expect(r.skipped).toEqual([]);
  expect(r.errors).toEqual([{ pid: 1001, reason: expect.stringContaining("命令执行失败") as any }]);
  expect(ctx.logs.some((m) => m.includes("1001") && m.includes("身份查询失败"))).toBe(true);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(true); // 保留登记，下轮再试，避免静默丢名单
  expect(ctx.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(false); // 查询失败不杀
});

test("sweepRegistry: 进程不存在（ps 空输出 + status 1）→ 正常 deleted 路径不受影响", () => {
  const ctx = makeOpts({
    platform: "darwin",
    seed: seedOne(),
    spawnResult: (cmd: string) => (cmd === "ps" ? { stdout: "", status: 1 } : { stdout: "", status: 0 }),
  });
  const r = sweepRegistry(ctx.opts);
  expect(r.deleted).toEqual([1001]);
  expect(r.errors).toEqual([]);
  expect(ctx.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(false);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("isProcessAlive: 真实存活进程（自身 pid，信号 0 仅探测）→ true", () => {
  expect(isProcessAlive(process.pid, {})).toBe(true);
});

test("isProcessAlive: 不存在的 PID → false（真实探测抛 ESRCH）", () => {
  // 2147483647 远超任何系统 pid_max，保证不存在；信号 0 仅探测不杀
  expect(isProcessAlive(2147483647, {})).toBe(false);
});

test("isOurs: ②③ 组合判断——创建时间一致且 exe 含我方特征 → true，任一不符 → false", () => {
  const opts = { waPiDir: WAPI_DIR } as any;
  const entry = { pid: 1001, exe: entry1001.exe, createdAt: NOW, registeredAt: NOW };
  expect(isOurs(entry, { exe: entry1001.exe, createdAt: NOW }, opts)).toBe(true);
  expect(isOurs(entry, { exe: entry1001.exe, createdAt: NOW + 86400000 }, opts)).toBe(false); // ②创建时间不符
  expect(isOurs(entry, { exe: "/usr/bin/other", createdAt: NOW }, opts)).toBe(false); // ③exe 不符
  expect(isOurs(entry, null as any, opts)).toBe(false);
});

// ---------- collectDescendants 纯函数（方案 B：清扫连带 kernel 子孙链） ----------

test("collectDescendants: 单根多直接子 → 全部收集，不含无关进程", () => {
  const procs = [
    { pid: 2001, ppid: 1001, cmd: "child-a" },
    { pid: 2002, ppid: 1001, cmd: "child-b" },
    { pid: 3001, ppid: 999, cmd: "unrelated" },
  ];
  const out = collectDescendants([1001], procs);
  expect(out.map((p) => p.pid)).toEqual([2001, 2002]);
});

test("collectDescendants: 多层链 root→a→b→c 按 BFS 顺序全收集，且不含 root 自身", () => {
  const procs = [
    { pid: 1001, ppid: 1, cmd: "kernel root" },
    { pid: 2001, ppid: 1001, cmd: "a" },
    { pid: 2002, ppid: 2001, cmd: "b" },
    { pid: 2003, ppid: 2002, cmd: "c" },
  ];
  const out = collectDescendants([1001], procs);
  expect(out.map((p) => p.pid)).toEqual([2001, 2002, 2003]); // root 自身不在结果
});

test("collectDescendants: 环（子指向父）不陷入死循环", () => {
  const procs = [
    { pid: 2001, ppid: 1001, cmd: "a" },
    { pid: 2002, ppid: 2001, cmd: "b" },
    { pid: 1001, ppid: 2002, cmd: "root-back-edge" }, // 环：2002 的“子”是 root
  ];
  const out = collectDescendants([1001], procs);
  expect(out.map((p) => p.pid)).toEqual([2001, 2002]);
});

test("collectDescendants: 排除 selfPid，且不遍历其子树", () => {
  const procs = [
    { pid: 2001, ppid: 1001, cmd: "a" },
    { pid: 2002, ppid: 2001, cmd: "b" },
    { pid: 2003, ppid: 2002, cmd: "c" },
  ];
  // selfPid=2002：2002 及其子树 2003 都不收集
  expect(collectDescendants([1001], procs, 2002).map((p) => p.pid)).toEqual([2001]);
});

test("collectDescendants: 多个 rootPids 分别收集", () => {
  const procs = [
    { pid: 2001, ppid: 1001, cmd: "a1" },
    { pid: 2002, ppid: 2001, cmd: "b1" },
    { pid: 3001, ppid: 1002, cmd: "a2" },
    { pid: 9999, ppid: 1, cmd: "unrelated" },
  ];
  const out = collectDescendants([1001, 1002], procs);
  // BFS：两个 root 的直接子先出，再下一层
  expect(out.map((p) => p.pid)).toEqual([2001, 3001, 2002]);
});

// ---------- killRegisteredProcesses 连带子孙杀伐（方案 B） ----------

test("killRegisteredProcesses: 连带清理 kernel 子孙——先杀子孙再杀 root，killed 含全部", () => {
  const procs = [
    { pid: 2001, ppid: 1001, cmd: "pi child agent" },
    { pid: 2002, ppid: 2001, cmd: "bun shim" },
  ];
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: (cmd: string) => {
      if (cmd === "powershell") return identityResult(NOW)(cmd);
      return { stdout: "", status: 0 }; // taskkill 一律成功
    },
  });
  ctx.opts.scanProcesses = () => procs;
  const r = killRegisteredProcesses(ctx.opts);
  const taskkills = ctx.spawnCalls.filter((c) => c.cmd === "taskkill");
  // 调用顺序：子孙（BFS 顺序）先于 root
  expect(taskkills.map((c) => c.args[1])).toEqual(["2001", "2002", "1001"]);
  expect(r.killed).toEqual([2001, 2002, 1001]);
  expect(r.skipped).toEqual([]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false); // root 杀成功删登记
  // 子孙杀伐日志含 PID 与命令行摘要
  expect(ctx.logs.some((m) => m.includes("连带清理") && m.includes("2001") && m.includes("pi child agent"))).toBe(true);
});

test("killRegisteredProcesses: scanProcesses 返回 []（非 Windows/查询失败）→ 与现状一致，只杀 root", () => {
  const ctx = makeOpts({ seed: seedOne(), spawnResult: identityResult(NOW) });
  ctx.opts.scanProcesses = () => [];
  const r = killRegisteredProcesses(ctx.opts);
  expect(r.killed).toEqual([1001]);
  expect(r.skipped).toEqual([]);
  expect(ctx.spawnCalls.filter((c) => c.cmd === "taskkill").map((c) => c.args[1])).toEqual(["1001"]);
});

test("killRegisteredProcesses: 未传 scanProcesses（默认空表）→ 行为与现状完全一致", () => {
  const ctx = makeOpts({ seed: seedOne(), spawnResult: identityResult(NOW) });
  const r = killRegisteredProcesses(ctx.opts); // 不设 scanProcesses
  expect(r.killed).toEqual([1001]);
  expect(r.skipped).toEqual([]);
  expect(ctx.spawnCalls.filter((c) => c.cmd === "taskkill").map((c) => c.args[1])).toEqual(["1001"]);
});

test("killRegisteredProcesses: 子孙在进程表但已死（taskkill 非 0）→ 记 skipped，不阻断杀 root", () => {
  const procs = [{ pid: 2001, ppid: 1001, cmd: "dead child" }];
  const ctx = makeOpts({
    seed: seedOne(),
    spawnResult: (cmd: string, args: string[]) => {
      if (cmd === "powershell") return identityResult(NOW)(cmd);
      if (cmd === "taskkill" && args[1] === "2001") return { stdout: "", status: 128 }; // 进程已死
      return { stdout: "", status: 0 };
    },
  });
  ctx.opts.scanProcesses = () => procs;
  const r = killRegisteredProcesses(ctx.opts);
  expect(r.skipped).toContain(2001);
  expect(r.killed).toEqual([1001]); // root 照常杀
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});

test("killRegisteredProcesses: 子孙杀失败（kill 抛错）→ 记 skipped，不阻断杀 root（非 win 平台）", () => {
  const procs = [{ pid: 2001, ppid: 1001, cmd: "child" }];
  const ctx = makeOpts({
    platform: "darwin",
    seed: seedOne(),
    spawnResult: (cmd: string) =>
      cmd === "ps"
        ? { stdout: `${lstartFor(NOW)}     ${entry1001.exe} run kernel.js\n`, status: 0 }
        : { stdout: "", status: 0 },
  });
  ctx.opts.kill = mock((pid: number) => {
    if (pid === 2001) throw new Error("no such process"); // 子孙已死
    return undefined; // root 成功
  }) as any;
  ctx.opts.scanProcesses = () => procs;
  const r = killRegisteredProcesses(ctx.opts);
  expect(r.skipped).toContain(2001);
  expect(r.killed).toEqual([1001]);
  expect(ctx.fs.store.has(path.join(REG_DIR, "1001.json"))).toBe(false);
});
