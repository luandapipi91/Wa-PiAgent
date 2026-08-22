// spawn kernel sidecar：packaged 直接 spawn 编译产物 WaPiKernel(.exe)（bun --compile 单二进制，
// 产物本身即入口）；dev 优先 spawn packages/kernel/dist 下的编译产物（与生产同形态），
// 缺失时回退 bun run <repo>/packages/kernel/src/desktop-server.ts（解释运行，快速迭代）。
// 等 9778 ready；退出时 kill 子进程树。
// 守护策略：无限自动重启（固定间隔 2s）+ 端口健康探活（5s 间隔，连续 3 次失败强杀重启）。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { appendFile, mkdir } = require("node:fs/promises");
const {
  waitForPort,
  isPortInUse,
  killPortOccupants,
  resolveWaPiDir,
} = require("./util/port.cjs");
const { shouldRespawn, RESPAWN_DELAY_MS } = require("./util/auto-respawn.cjs");
const {
  checkPort,
  updateHealthState,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_FAIL_THRESHOLD,
} = require("./util/health-check.cjs");

const WS_PORT =
  Number(process.env.WA_PI_WS_PORT) > 0
    ? Number(process.env.WA_PI_WS_PORT)
    : 9778;

function killTree(pid) {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

// 强杀（探活判定挂了时用）：POSIX SIGKILL / Windows taskkill /F，保证 exit code=null 走统一崩溃重启路径。
// 不能用 killTree（POSIX 下 SIGTERM 会被 kernel 优雅退出 code=0，shouldRespawn 不重启）。
function forceKill(pid) {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

async function startSidecar({
  isPackaged,
  kernelDir,
  webDir,
  kernelExe,
  devKernelExe = undefined,
  log,
  port,
  deps = {},
}) {
  // 依赖注入（测试用，可选）：默认全走真实实现，生产行为不变。
  //   spawnFn        替换 spawn（测试返回 fake child）
  //   waitForPortFn  替换 waitForPort（测试立即就绪，不真等端口）
  //   checkPortFn    替换探活 checkPort（测试恒健康，避免真探活/真杀）
  //   killFn         替换 killTree（测试记录被杀 pid，绝不真杀进程）
  //   respawnDelayMs 替换重启间隔（测试缩短，避免真等 2s）
  //   now            替换时钟（测试可控 createdAt，避免真时间不确定）
  //   isPortInUseFn      替换端口占用检测（测试注入，避免真探端口）
  //   killPortOccupantsFn 替换端口清理（测试注入，绝不真杀进程）
  const {
    spawnFn = spawn,
    waitForPortFn = waitForPort,
    checkPortFn = checkPort,
    killFn = killTree,
    respawnDelayMs = RESPAWN_DELAY_MS,
    now = Date.now,
    isPortInUseFn = isPortInUse,
    killPortOccupantsFn = (p) =>
      killPortOccupants(p, undefined, (m) => log.info(m)),
    // 崩溃现场落盘：默认追加到 <WA_PI_DIR>/logs/kernel-crash.log；测试注入收集
    crashLogFn = (text) => {
      const p = path.join(resolveWaPiDir(), "logs", "kernel-crash.log");
      return mkdir(path.dirname(p), { recursive: true })
        .then(() => appendFile(p, text))
        .catch(() => {});
    },
  } = deps;
  // packaged: 直接 spawn kernelExe（编译产物本身即入口）。
  // dev + devKernelExe: spawn dist 编译产物（与生产同形态）。
  // dev 无产物: bun run src/desktop-server.ts（解释运行）。
  // Windows dev 解释运行路径上 "bun" 是 .cmd shim——Node 20+ 出于 CVE-2024-27980 默认
  // 拒绝 spawn .cmd/.bat（spawn EINVAL），必须 shell:true 让 cmd.exe 解析 PATHEXT。
  const wsPort = port ?? WS_PORT;
  const isWin = process.platform === "win32";
  const useCompiled = isPackaged || !!devKernelExe;
  const cmd = isPackaged ? kernelExe : (devKernelExe ?? "bun");
  const arg = useCompiled
    ? []
    : ["run", path.join(kernelDir, "src", "desktop-server.ts")];
  // shell 模式下需手动引用含空格的参数（路径里若有空格）
  const finalArg =
    !useCompiled && isWin ? arg.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : arg;
  // 编译产物主进程必须以内嵌应用模式启动：env 里剔除 BUN_BE_BUN（若宿主/系统环境
  // 恰好带此变量，编译产物会充当 bun CLI 而非运行内嵌 kernel——打印 usage 后 code=0 退出）。
  // 子进程需要当 CLI 的场景（runtime-deps install、runtime-bin wrapper）各自显式设置
  // BUN_BE_BUN=1；kernel 内部 startKernel 的 ensureBunBeBunEnv() 会为 pi RPC / bun add / MCP
  // 子进程写入。
  const { BUN_BE_BUN: _bunBeBun, ...kernelEnv } = process.env;
  const spawnOpts = {
    cwd: kernelDir,
    env: { ...kernelEnv, WA_PI_WEB_DIR: webDir, WA_PI_WS_PORT: String(wsPort) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: !useCompiled && isWin,
  };

  // 守护状态：stopped（用户主动退出）+ attempts（重启计数，仅日志）+ failures（探活连续失败计数）
  const respawnState = {
    stopped: false,
    attempts: 0,
    failures: 0,
    failThreshold: HEALTH_FAIL_THRESHOLD,
  };
  let current = null; // 当前 child 引用（重启时替换）
  let lastPid = null; // 最近一次成功 spawn 的 pid（stop 兜底：current 无有效 pid 时用它）
  let currentSpawnedAt = null; // 最近一次成功 spawn 的创建时刻（登记簿 createdAt 用它，非端口就绪时刻）
  let childExited = false; // 当前 child 是否已退出（重启间隙探活跳过，避免误判）
  let healthTimer = null;

  // 统一重启入口：exit / spawn error 都走这里。spawn 失败（bun 缺失/ENOENT）时
  // Node 通常只触发 error 不触发 exit——若只 log 不重启，childExited 恒 false、current.pid 为
  // undefined，探活被 !current?.pid 永久挡掉 → sidecar 静默停摆（比旧 3 次上限更糟）。
  // 含 stopped 检查、attempts++、日志，延时后 spawnOnce + waitForPort 就绪时重置计数。
  function scheduleRespawn(reason) {
    if (respawnState.stopped) return; // 用户已主动退出，不再重启
    respawnState.attempts++;
    log.info(
      `[kernel] ${reason} → 第 ${respawnState.attempts} 次自动重启，${respawnDelayMs}ms 后 respawn...`,
    );
    setTimeout(() => {
      if (respawnState.stopped) return; // 退避期间用户退出了
      void (async () => {
        // 重启前先清端口：kernel 崩溃退出后，监听 socket 句柄可能被继承了它的
        // pi 子进程/子代理捏住（Windows 上以死 PID 幽灵形态残留），此时直接 respawn
        // 必然 Bun.serve EADDRINUSE → 退出 → 再 respawn → 无限崩溃循环，前端永久
        // 连不上（聊天中"卡死"、停止/发送全无效的根因）。端口空闲则跳过（清理有成本）。
        try {
          if (await isPortInUseFn(wsPort)) {
            log.info(`[kernel] 端口 ${wsPort} 仍被占用，先清理再 respawn`);
            await killPortOccupantsFn(wsPort);
          }
        } catch (e) {
          log.error(`[kernel] 重启前端口清理失败: ${e?.message ?? e}`);
        }
        if (respawnState.stopped) return; // 清理期间用户退出了
        current = spawnOnce();
        // 重启后等待端口就绪（不就绪则下次 exit/error 会再触发）
        waitForPortFn(wsPort, 30000).then((ready) => {
          if (ready) {
            log.info(`[kernel] 重启就绪 @${wsPort}`);
            respawnState.attempts = 0;
            respawnState.failures = 0;
          } else log.error(`[kernel] 重启后 30s 未就绪`);
        });
      })();
    }, respawnDelayMs);
  }

  // 创建一个 kernel 子进程并绑定日志/崩溃重启。返回 child。
  function spawnOnce() {
    childExited = false;
    const child = spawnFn(cmd, finalArg, spawnOpts);
    // spawn 成功（child.pid 有值）才更新 lastPid/currentSpawnedAt：spawn 失败（bun 缺失/ENOENT 等）pid 为 undefined，不能污染兜底记录
    if (child.pid != null) {
      lastPid = child.pid;
      // 与 lastPid 同步捕获进程创建时刻：main.cjs 用它登记 createdAt，避免启动耗时 >2s
      // 时下轮清扫的 isOurs 时间一致性校验误判 PID 复用（登记簿核心目标静默失效）
      currentSpawnedAt = now();
    }
    child.on("error", (e) => {
      childExited = true;
      log.error(`[kernel] spawn error: ${e.message}`);
      // spawn 失败不触发 exit，须走统一重启入口，否则无限重启语义下静默停摆
      if (shouldRespawn(null, respawnState)) scheduleRespawn("spawn 失败");
    });
    child.stdout.on("data", (d) => log.info(`[kernel] ${d.toString().trim()}`));
    child.stderr.on("data", (d) =>
      log.error(`[kernel] ${d.toString().trim()}`),
    );
    // stderr 环形缓冲：Bun 级崩溃（panic/段错误）不进 JS 的 crash-logger，现场只打在
    // stderr。留存末尾 50 条，崩溃退出时随 code/signal 写入 kernel-crash.log 供定位首因
    // （8/14、8/18 事故静默 exit code=1、desktop.log 无错误输出，首因无从查起）。
    const stderrTail = [];
    child.stderr.on("data", (d) => {
      stderrTail.push(d.toString().trim().slice(0, 500));
      if (stderrTail.length > 50) stderrTail.shift();
    });
    child.on("exit", (code, signal) => {
      childExited = true;
      // code=null 表示被信号杀；signal 才是定位根因的关键（SIGTERM=被主动杀，
      // SIGKILL=强制杀/可能 OOM，SIGSEGV=段错误）。crash-logger 只能抓 JS 异常，
      // 信号杀死不进 JS，故这里必须记录 signal。
      log.info(`[kernel] 退出 code=${code} signal=${signal ?? "none"}`);
      // 崩溃（被信号杀 code=null / Windows 强杀 code=1）且非用户主动退出 → 统一重启入口
      if (shouldRespawn(code, respawnState)) {
        void crashLogFn(
          `\n===== ${new Date().toISOString()} kernel 崩溃退出 pid=${child.pid} code=${code} signal=${signal ?? "none"} =====\n` +
            `最近 stderr（末 ${stderrTail.length} 条）：\n${stderrTail.join("\n") || "(无)"}\n`,
        );
        scheduleRespawn("崩溃");
      }
    });
    return child;
  }

  // 探活循环：每 5s 探测端口；连续 3 次失败 → 强杀走统一重启。stopped / 重启间隙 / 上轮未完成 跳过。
  function startHealthCheck() {
    let inFlight = false;
    healthTimer = setInterval(async () => {
      if (respawnState.stopped || childExited || inFlight || !current?.pid)
        return;
      inFlight = true;
      try {
        const healthy = await checkPortFn(wsPort);
        const { shouldRestart, failures } = updateHealthState(
          respawnState,
          healthy,
        );
        respawnState.failures = failures;
        if (shouldRestart) {
          log.error(
            `[kernel] 端口 ${wsPort} 连续 ${respawnState.failThreshold} 次探测失败，判定挂死，强杀重启`,
          );
          forceKill(current.pid); // exit 事件会触发统一崩溃重启
        }
      } finally {
        inFlight = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    if (healthTimer.unref) healthTimer.unref(); // 不阻塞主进程退出
  }

  current = spawnOnce();
  log.info(
    `kernel sidecar pid=${current.pid} cmd=${cmd} ${arg.join(" ")} port=${wsPort}`,
  );
  const ready = await waitForPortFn(wsPort, 30000);
  if (!ready) {
    respawnState.stopped = true;
    log.error("kernel sidecar 30s 未就绪");
    killFn(current.pid);
    throw new Error("kernel not ready");
  }
  log.info(`kernel 就绪 @${wsPort}`);
  startHealthCheck();
  return {
    child: current,
    pid: current.pid,
    port: wsPort,
    // 进程创建时刻（spawn 成功即记录，非端口就绪时刻）：main.cjs 用它登记 createdAt。
    // 注意返回值只能增不能改——child/pid/port/stop 已有调用方使用
    createdAt: currentSpawnedAt,
    // 主动停止：置 stopped 标志后 kill，防止 exit handler 误判为崩溃而重启；停止探活。
    // 兜底：current 无有效 pid（spawn 失败/重启间隙）时用最近一次成功 spawn 的 lastPid，
    // 避免「current?.pid 为 undefined → killTree 静默跳过」导致 Windows 升级后幽灵残留。
    stop: () => {
      respawnState.stopped = true;
      if (healthTimer) clearInterval(healthTimer);
      const pid = current?.pid ?? lastPid;
      if (pid == null)
        log.error("[kernel] stop 时无可用 pid（从未成功 spawn），跳过杀进程");
      else killFn(pid);
    },
  };
}

module.exports = { startSidecar, WS_PORT, killTree };
