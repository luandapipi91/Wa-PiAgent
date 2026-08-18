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
      respawnDelayMs: 5,
      isPortInUseFn: (async () => false), // 永不真探端口（本机 9778 可能真被占）
      killPortOccupantsFn: (async () => []), // 绝不真杀进程
    },
  });
  return { sidecar, children, killed, spawnFn };
}

/** 触发一次崩溃重启：第一个 child 被信号杀 → exit handler → scheduleRespawn → 5ms 后重新 spawn */
async function crashAndRespawn(children: any[]) {
  children[0].emit("exit", null, "SIGKILL");
  await new Promise((r) => setTimeout(r, 30)); // 等 respawn 定时器（5ms）跑完
}

test("stop(): current 无有效 pid（spawn 失败）但 lastPid 有值 → 用 lastPid 兜底杀进程树", async () => {
  const { sidecar, children, killed } = await startSidecarHarness([1234, undefined]);
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
