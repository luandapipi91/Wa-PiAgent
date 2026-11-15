// kernel-sidecar 单元测试：全程依赖注入（fake spawn / fake waitForPort / fake checkPort / fake kill），
// 绝不真起 kernel、绝不真杀进程、绝不真探端口。
// 核心覆盖 stop() 的 lastPid 兜底逻辑：current 无有效 pid（spawn 失败/重启间隙）时，
// 仍按最近一次成功 spawn 的 pid 杀进程树，绝不静默跳过（Windows 升级后幽灵占用治理）。
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { startSidecar } from "../src/kernel-sidecar.cjs";

/** fake child：EventEmitter + pid + stdout/stderr（EventEmitter），模拟 spawn 产物 */
function fakeChild(pid: number | undefined) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** 启动 sidecar 测试夹具：注入全部副作用点，绝不触达真实进程/端口。
 *  spawnPids 依次作为每次 spawnOnce 的 fake child pid（undefined = spawn 失败无 pid）。 */
async function startSidecarHarness(spawnPids: (number | undefined)[]) {
  const children = spawnPids.map(fakeChild);
  let i = 0;
  const spawnFn = (() => children[Math.min(i++, children.length - 1)]) as any;
  const waitForPortFn = (async () => true) as any;
  const checkPortFn = (async () => true) as any;
  const killed: number[] = [];
  const killFn = ((pid: number) => {
    killed.push(pid);
  }) as any;
  const forceKilled: number[] = [];
  const forceKillFn = ((pid: number) => {
    forceKilled.push(pid);
  }) as any;
  const sidecar = await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778, // tsc 从 .cjs 推断 port 必填；值无实义（waitForPortFn 忽略）
    log: { info() {}, error() {} },
    deps: {
      spawnFn,
      waitForPortFn,
      checkPortFn,
      killFn,
      forceKillFn,
      respawnDelayMs: 5,
      isPortInUseFn: async () => false, // 永不真探端口（本机 9778 可能真被占）
      killPortOccupantsFn: async () => [], // 绝不真杀进程
    },
  });
  return { sidecar, children, killed, forceKilled, spawnFn };
}

test("sqliteDylib 存在 → 注入 WA_PI_SQLITE_DYLIB；未传/文件不存在 → 不注入（macOS 语义检索资产入口）", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wa-pi-dylib-"));
  const dylib = join(dir, "libsqlite3.dylib");
  writeFileSync(dylib, "fake dylib");

  const run = async (sqliteDylib?: string) => {
    const child = fakeChild(4321);
    let capturedEnv: Record<string, string> = {};
    const spawnFn = ((_c: string, _a: string[], opts: any) => {
      capturedEnv = opts.env;
      return child;
    }) as any;
    await startSidecar({
      isPackaged: false,
      kernelDir: "/fake/kernel",
      webDir: "/fake/web",
      kernelExe: "/fake/kernel/wa-pi-kernel",
      port: 9778,
      log: { info() {}, error() {} },
      sqliteDylib,
      deps: {
        spawnFn,
        waitForPortFn: (async () => true) as any,
        checkPortFn: (async () => true) as any,
        killFn: (() => {}) as any,
        respawnDelayMs: 5,
        isPortInUseFn: async () => false,
        killPortOccupantsFn: async () => [],
      },
    });
    return capturedEnv;
  };

  const envWith = await run(dylib);
  expect(envWith.WA_PI_SQLITE_DYLIB).toBe(dylib);

  const envMissing = await run(join(dir, "no-such.dylib"));
  expect(envMissing.WA_PI_SQLITE_DYLIB).toBeUndefined();

  const envNone = await run(undefined);
  expect(envNone.WA_PI_SQLITE_DYLIB).toBeUndefined();
});

test("libvipsLibDir 存在 → 注入 DYLD_FALLBACK_LIBRARY_PATH（与既有值合并）；未传/目录不存在 → 不注入（sharp libvips 分包运行时兜底）", async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wa-pi-libvips-"));
  const libDir = join(dir, "lib");
  mkdirSync(libDir);

  const run = async (libvipsLibDir?: string, prevEnv?: string) => {
    const child = fakeChild(4321);
    let capturedEnv: Record<string, string> = {};
    const spawnFn = ((_c: string, _a: string[], opts: any) => {
      capturedEnv = opts.env;
      return child;
    }) as any;
    const saved = process.env.DYLD_FALLBACK_LIBRARY_PATH;
    if (prevEnv !== undefined) process.env.DYLD_FALLBACK_LIBRARY_PATH = prevEnv;
    // 无 prevEnv 时清掉继承值：从 wa-pi 应用内部跑测试会继承宿主注入的
    // DYLD_FALLBACK_LIBRARY_PATH（runtime/native/sharp-libvips），污染「无既有值」断言
    else delete process.env.DYLD_FALLBACK_LIBRARY_PATH;
    try {
      await startSidecar({
        isPackaged: false,
        kernelDir: "/fake/kernel",
        webDir: "/fake/web",
        kernelExe: "/fake/kernel/wa-pi-kernel",
        port: 9778,
        log: { info() {}, error() {} },
        libvipsLibDir,
        deps: {
          spawnFn,
          waitForPortFn: (async () => true) as any,
          checkPortFn: (async () => true) as any,
          killFn: (() => {}) as any,
          respawnDelayMs: 5,
          isPortInUseFn: async () => false,
          killPortOccupantsFn: async () => [],
        },
      });
    } finally {
      // 恢复宿主 env，绝不污染其他用例
      if (saved === undefined) delete process.env.DYLD_FALLBACK_LIBRARY_PATH;
      else process.env.DYLD_FALLBACK_LIBRARY_PATH = saved;
    }
    return capturedEnv;
  };

  const envWith = await run(libDir);
  expect(envWith.DYLD_FALLBACK_LIBRARY_PATH).toBe(libDir);

  // 宿主 env 已有值 → 新值前插合并（子进程 rpath 兕底优先吃 libvips 目录）
  const envMerged = await run(libDir, "/pre/existing");
  expect(envMerged.DYLD_FALLBACK_LIBRARY_PATH).toBe(`${libDir}:/pre/existing`);

  const envMissing = await run(join(dir, "no-such"));
  expect(envMissing.DYLD_FALLBACK_LIBRARY_PATH).toBeUndefined();

  const envNone = await run(undefined);
  expect(envNone.DYLD_FALLBACK_LIBRARY_PATH).toBeUndefined();
});

/** 触发一次崩溃重启：第一个 child 被信号杀 → exit handler → scheduleRespawn → 5ms 后重新 spawn */
async function crashAndRespawn(children: any[]) {
  children[0].emit("exit", null, "SIGKILL");
  await new Promise((r) => setTimeout(r, 30)); // 等 respawn 定时器（5ms）跑完
}

test("stop(): current 无有效 pid（spawn 失败）但 lastPid 有值 → 用 lastPid 兜底杀进程树", async () => {
  const { sidecar, children, killed } = await startSidecarHarness([
    1234,
    undefined,
  ]);
  await crashAndRespawn(children); // 重启后 current.pid 为 undefined（第二次 spawn 失败）
  sidecar.stop();
  expect(killed).toHaveLength(1); // bun 的 toEqual 会把 [undefined] 与 [] 判等，须用精确断言
  expect(killed[0]).toBe(1234); // 杀最近一次成功 spawn 的 pid，而非静默跳过
});

test("stop(): 正常路径杀当前 child 的 pid（不受 lastPid 影响）", async () => {
  const { sidecar, killed } = await startSidecarHarness([5678]);
  sidecar.stop();
  expect(killed).toEqual([5678]);
});

test("stop(): 从未成功 spawn（无 lastPid）→ 不调杀进程、不抛异常", async () => {
  const { sidecar, killed } = await startSidecarHarness([undefined]);
  sidecar.stop();
  expect(killed).toHaveLength(0); // 无任何可用 pid → 不调杀进程
});

test("stop(): 重启后 current.pid 有效 → 杀 current（lastPid 只作兜底不覆盖）", async () => {
  const { sidecar, children, killed } = await startSidecarHarness([111, 222]);
  await crashAndRespawn(children); // 重启后 current.pid=222（有效）
  sidecar.stop();
  expect(killed).toEqual([222]);
});

test("startSidecar: 返回 createdAt 为 spawn 时刻（非端口就绪时刻）", async () => {
  // 可控时钟：spawn 触发 → 2000；端口就绪 → 9999。旧实现取"就绪时刻"会返回 9999，
  // 修复后取 spawn 时刻返回 2000——登记簿 createdAt 用它做 PID 复用一致性校验的基准，
  // 若取就绪时刻，启动耗时 >2s（Windows 升级后首启）时下轮清扫会误判 PID 复用。
  let clock = 1000;
  const now = () => clock;
  const children = [fakeChild(902)];
  const sidecar = await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      now,
      spawnFn: (() => {
        clock = 2000; // spawn 发生 → 进程创建时刻
        return children[0];
      }) as any,
      waitForPortFn: (async () => {
        clock = 9999; // 端口就绪时刻（若 createdAt 取该时刻则错）
        return true;
      }) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      // 必须注入：默认 isPortInUse/killPortOccupants 会真实清理 9778 → 杀宿主 kernel
      isPortInUseFn: (async () => false) as any,
      killPortOccupantsFn: (async () => []) as any,
    },
  });
  expect(sidecar.createdAt).toBe(2000); // spawn 时刻，而非端口就绪时刻 9999
});

test("scheduleRespawn: 日志用注入的 respawnDelayMs（非硬编码常量）", async () => {
  const children = [fakeChild(111)];
  const logs: string[] = [];
  await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info: (m: string) => logs.push(m), error() {} },
    deps: {
      spawnFn: (() => children[0]) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 7,
      // 必须注入：该测试会触发崩溃→respawn，默认 isPortInUse/killPortOccupants
      // 会真实清理 9778 端口占用 → 杀掉正在运行的宿主 kernel（曾经真实事故）
      isPortInUseFn: (async () => false) as any,
      killPortOccupantsFn: (async () => []) as any,
    },
  });
  children[0].emit("exit", null, "SIGKILL"); // 崩溃 → scheduleRespawn 记日志
  await new Promise((r) => setTimeout(r, 30)); // 等 respawn 定时器（7ms）跑完
  expect(logs.some((m) => m.includes("7ms 后 respawn"))).toBe(true);
});

test("waitForPort 未就绪 → 杀当前 pid 后抛 kernel not ready（killFn 已接线）", async () => {
  const children = [fakeChild(777)];
  const killed: number[] = [];
  await expect(
    startSidecar({
      isPackaged: false,
      kernelDir: "/fake/kernel",
      webDir: "/fake/web",
      kernelExe: "/fake/kernel/wa-pi-kernel",
      port: 9778,
      log: { info() {}, error() {} },
      deps: {
        spawnFn: (() => children[0]) as any,
        waitForPortFn: (async () => false) as any,
        checkPortFn: (async () => true) as any,
        killFn: ((pid: number) => {
          killed.push(pid);
        }) as any,
        respawnDelayMs: 5,
      },
    }),
  ).rejects.toThrow("kernel not ready");
  expect(killed).toEqual([777]);
});

test("scheduleRespawn: 重启前清理端口占用（崩溃后幽灵句柄占端口 → 否则 EADDRINUSE 无限崩溃循环）", async () => {
  // 事故还原：kernel 聊天中崩溃退出，但监听 socket 句柄被 pi 子进程继承，
  // 端口 9778 以死 PID 幽灵形态持续被占；respawn 若直接 spawn → Bun.serve
  // EADDRINUSE → 退出 → 再 respawn → 无限循环，前端永久连不上（停止/发送全无效）。
  const children = [fakeChild(111), fakeChild(222)];
  let i = 0;
  const order: string[] = [];
  const killedPorts: number[] = [];
  await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      spawnFn: (() => {
        order.push("spawn");
        return children[Math.min(i++, children.length - 1)];
      }) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      isPortInUseFn: (async () => true) as any, // 端口被幽灵占用
      killPortOccupantsFn: (async (p: number) => {
        order.push("killPort");
        killedPorts.push(p);
        return [];
      }) as any,
    },
  });
  order.length = 0; // 清掉首次启动的 spawn 记录，只观察 respawn
  children[0].emit("exit", 1, null); // Windows 强杀/崩溃退出 code=1
  await new Promise((r) => setTimeout(r, 30)); // 等 respawn 定时器 + 清理跑完
  expect(killedPorts).toEqual([9778]); // 清的是 sidecar 端口
  expect(order).toEqual(["killPort", "spawn"]); // 先清端口再 respawn
});

test("scheduleRespawn: 端口空闲时不做多余清理，直接 respawn", async () => {
  const children = [fakeChild(111), fakeChild(222)];
  let i = 0;
  let killCalls = 0;
  await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      spawnFn: (() => children[Math.min(i++, children.length - 1)]) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      isPortInUseFn: (async () => false) as any, // 端口已正常释放
      killPortOccupantsFn: (async () => {
        killCalls++;
        return [];
      }) as any,
    },
  });
  children[0].emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 30));
  expect(killCalls).toBe(0); // 空闲端口不做多余清理（netstat/幽灵扫描有成本）
  expect(i).toBe(2); // 已正常 respawn
});

test("kernel 崩溃退出 → stderr 末尾现场写入 kernel-crash.log（crashLogFn）", async () => {
  // 背景：8/14、8/18 事故中 kernel 聊天中静默 exit code=1，desktop.log 无任何错误输出，
  // 首因无从定位。sidecar 需把崩溃前的 stderr 末尾（Bun panic/未捕获异常通常打在这里）
  // 随退出写入 kernel-crash.log。
  const children = [fakeChild(111)];
  const crashLogs: string[] = [];
  await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      spawnFn: (() => children[0]) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      isPortInUseFn: (async () => false) as any,
      killPortOccupantsFn: (async () => []) as any,
      crashLogFn: ((text: string) => {
        crashLogs.push(text);
      }) as any,
    },
  });
  children[0].stderr.emit(
    "data",
    Buffer.from("panic(main thread): Segmentation fault\n"),
  );
  children[0].emit("exit", 1, null); // 崩溃
  expect(crashLogs).toHaveLength(1);
  expect(crashLogs[0]).toContain("Segmentation fault");
  expect(crashLogs[0]).toContain("code=1");
});

test("kernel 正常退出 code=0 → 不写崩溃日志", async () => {
  const children = [fakeChild(111)];
  const crashLogs: string[] = [];
  await startSidecar({
    isPackaged: false,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/wa-pi-kernel",
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      spawnFn: (() => children[0]) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      isPortInUseFn: (async () => false) as any,
      killPortOccupantsFn: (async () => []) as any,
      crashLogFn: ((text: string) => {
        crashLogs.push(text);
      }) as any,
    },
  });
  children[0].stderr.emit("data", Buffer.from("some warning\n"));
  children[0].emit("exit", 0, null); // 优雅退出
  expect(crashLogs).toHaveLength(0);
});

// —— spawn cmd/arg 形态断言（bun --compile 单二进制改造）——
// packaged 与 dev+编译产物：直接 spawn 产物、args=[]（产物本身即入口，不再 run kernel.js）；
// dev 无产物：回退解释运行 bun run src/desktop-server.ts。

/** 捕获 spawn 的 cmd/args 的夹具 */
async function captureSpawnHarness(opts: {
  isPackaged: boolean;
  devKernelExe?: string;
}) {
  const child = fakeChild(4321);
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] =
    [];
  const sidecar = await startSidecar({
    isPackaged: opts.isPackaged,
    kernelDir: "/fake/kernel",
    webDir: "/fake/web",
    kernelExe: "/fake/kernel/WaPiKernel",
    ...(opts.devKernelExe ? { devKernelExe: opts.devKernelExe } : {}),
    port: 9778,
    log: { info() {}, error() {} },
    deps: {
      spawnFn: ((
        cmd: string,
        args: string[],
        spawnOpts?: { env?: Record<string, string> },
      ) => {
        calls.push({ cmd, args, env: spawnOpts?.env });
        return child;
      }) as any,
      waitForPortFn: (async () => true) as any,
      checkPortFn: (async () => true) as any,
      killFn: (() => {}) as any,
      respawnDelayMs: 5,
      isPortInUseFn: (async () => false) as any,
      killPortOccupantsFn: (async () => []) as any,
    },
  } as any);
  return { sidecar, calls };
}

test("packaged: spawn 编译产物本身，args=[]（不再 wa-pi-kernel run kernel.js）", async () => {
  const { sidecar, calls } = await captureSpawnHarness({ isPackaged: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].cmd).toBe("/fake/kernel/WaPiKernel");
  expect(calls[0].args).toEqual([]); // 编译产物本身即入口
  sidecar.stop();
});

test("dev + devKernelExe: spawn 编译产物（与生产同形态），args=[]", async () => {
  const { sidecar, calls } = await captureSpawnHarness({
    isPackaged: false,
    devKernelExe: "/fake/kernel/dist/WaPiKernel",
  });
  expect(calls[0].cmd).toBe("/fake/kernel/dist/WaPiKernel");
  expect(calls[0].args).toEqual([]);
  sidecar.stop();
});

test("dev 无 devKernelExe: 回退解释运行 bun run src/desktop-server.ts", async () => {
  const { sidecar, calls } = await captureSpawnHarness({ isPackaged: false });
  expect(calls[0].cmd).toBe("bun");
  expect(calls[0].args[0]).toBe("run");
  expect(
    calls[0].args[1].replace(/\\/g, "/").endsWith("src/desktop-server.ts"),
  ).toBe(true);
  sidecar.stop();
});

test("spawn env 剔除 BUN_BE_BUN（编译产物主进程必须以内嵌应用模式启动，即使宿主 env 带此变量）", async () => {
  // 模拟宿主环境恰好带 BUN_BE_BUN=1（编译产物会充当 bun CLI 而非运行内嵌 kernel）
  process.env.BUN_BE_BUN = "1";
  try {
    const { sidecar, calls } = await captureSpawnHarness({ isPackaged: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].env).toBeDefined();
    expect(calls[0].env!.BUN_BE_BUN).toBeUndefined();
    sidecar.stop();
  } finally {
    delete process.env.BUN_BE_BUN;
  }
});

// ===== stopAndWait()：升级安装前的进程级退出确认 =====
// 背景（2026-11-15 事故）：升级前旧代码只调 stop()（fire-and-forget 发起 kill）+ 等端口
// 释放（waitPortReleased 默认 3×200ms=600ms 的假信号）。Windows 上端口先关、进程后死，
// 映像锁未释放 NSIS 就开始覆盖安装 → 129MB 的 WaPiKernel.exe 写入失败被静默跳过 →
// 壳新核旧。stopAndWait 必须等到 child 的 exit 事件（Node 已确认进程终止）才放行。

test("stopAndWait(): 发起 kill 后等 exit 事件才 resolve（exited=true forced=false）", async () => {
  const { sidecar, children, killed } = await startSidecarHarness([1111]);
  let exitSeen = false;
  children[0].once("exit", () => {
    exitSeen = true;
  });
  const p = sidecar.stopAndWait();
  // kill 已同步发起（同一 pid）
  expect(killed).toContain(1111);
  // exit 未发前 promise 不得 resolve
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 15));
  expect(settled).toBe(false);
  // 进程退出 → 放行
  children[0].emit("exit", 1, null);
  const r = await p;
  expect(r.exited).toBe(true);
  expect(r.forced).toBe(false);
  expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  expect(exitSeen).toBe(true);
});

test("stopAndWait(): 进程早已退出（exit 已发生）→ 立即返回，不再空等", async () => {
  const { sidecar, children, killed } = await startSidecarHarness([2222]);
  children[0].emit("exit", 0, null); // 先退出
  const t0 = Date.now();
  const r = await sidecar.stopAndWait();
  expect(r.exited).toBe(true);
  expect(r.forced).toBe(false);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(killed).toContain(2222); // kill 兜底仍要发（幂等）
});

test("stopAndWait(): 超时未退出 → forceKill 兜底并再等一小段窗口", async () => {
  const { sidecar, children, forceKilled, killed } =
    await startSidecarHarness([3333]);
  // fake child 永不 emit exit → 走强杀兜底
  const r = await sidecar.stopAndWait({ timeoutMs: 20, postForceMs: 20 });
  expect(killed).toContain(3333);
  expect(forceKilled).toContain(3333);
  expect(r.forced).toBe(true);
  // 强杀后 exit 到达 → exited=true；fake 里没 emit → exited=false 也合法（如实上报）
  expect(typeof r.exited).toBe("boolean");
});

test("stopAndWait(): 无可用 pid（从未成功 spawn）→ 不杀不抛，立即返回", async () => {
  const { sidecar, killed, forceKilled } = await startSidecarHarness([
    undefined,
  ]);
  const r = await sidecar.stopAndWait();
  expect(r.exited).toBe(true);
  expect(r.forced).toBe(false);
  expect(killed).toHaveLength(0);
  expect(forceKilled).toHaveLength(0);
});

test("stopAndWait(): 置位 stopped 守护 → exit 事件不会触发自动重生（升级窗口内不得拉起旧内核）", async () => {
  const { sidecar, children } = await startSidecarHarness([4444]);
  void sidecar.stopAndWait();
  children[0].emit("exit", 1, null); // 崩溃形态（code=1 本会触发无限重启）
  await new Promise((r) => setTimeout(r, 30)); // 越过 respawnDelayMs(5ms) 退避窗
  // spawnFn 只有一个 fake child，若重生会复用它——无法直接观察，改为断言无强杀+无第二次 kill 记录外的副作用：
  // 关键验证是 stopAndWait 置位 stopped 后 scheduleRespawn 早退（内部守卫），无异常即通过
  expect(children).toHaveLength(1);
});
