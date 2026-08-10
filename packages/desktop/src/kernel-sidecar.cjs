// spawn 解释运行的 kernel sidecar：dev 下 bun run <repo>/packages/kernel/src/desktop-server.ts；
// packaged 下 <kernelDir>/wa-pi-kernel(.exe) run <kernelDir>/kernel.js。等 9778 ready；退出时 kill 子进程树。
// 守护策略：无限自动重启（固定间隔 2s）+ 端口健康探活（5s 间隔，连续 3 次失败强杀重启）。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForPort } = require("./util/port.cjs");
const { shouldRespawn, RESPAWN_DELAY_MS } = require("./util/auto-respawn.cjs");
const {
  checkPort,
  updateHealthState,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_FAIL_THRESHOLD,
} = require("./util/health-check.cjs");

const WS_PORT = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : 9778;

function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

// 强杀（探活判定挂了时用）：POSIX SIGKILL / Windows taskkill /F，保证 exit code=null 走统一崩溃重启路径。
// 不能用 killTree（POSIX 下 SIGTERM 会被 kernel 优雅退出 code=0，shouldRespawn 不重启）。
function forceKill(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

async function startSidecar({ isPackaged, kernelDir, webDir, kernelExe, log, port, deps = {} }) {
  // 依赖注入（测试用，可选）：默认全走真实实现，生产行为不变。
  //   spawnFn        替换 spawn（测试返回 fake child）
  //   waitForPortFn  替换 waitForPort（测试立即就绪，不真等端口）
  //   checkPortFn    替换探活 checkPort（测试恒健康，避免真探活/真杀）
  //   killFn         替换 killTree（测试记录被杀 pid，绝不真杀进程）
  //   respawnDelayMs 替换重启间隔（测试缩短，避免真等 2s）
  //   now            替换时钟（测试可控 createdAt，避免真时间不确定）
  const {
    spawnFn = spawn,
    waitForPortFn = waitForPort,
    checkPortFn = checkPort,
    killFn = killTree,
    respawnDelayMs = RESPAWN_DELAY_MS,
    now = Date.now,
  } = deps;
  // dev: repo 下用 bun 跑 kernel 源码入口；packaged: kernelDir 里 wa-pi-kernel(.exe) run kernel.js
  // Windows dev 路径上 "bun" 是 .cmd shim——Node 20+ 出于 CVE-2024-27980 默认拒绝 spawn
  // .cmd/.bat（spawn EINVAL），必须 shell:true 让 cmd.exe 解析 PATHEXT。
  const wsPort = port ?? WS_PORT;
  const isWin = process.platform === "win32";
  const cmd = isPackaged ? kernelExe : "bun";
  const arg = isPackaged
    ? ["run", path.join(kernelDir, "kernel.js")]
    : ["run", path.join(kernelDir, "src", "desktop-server.ts")];
  // shell 模式下需手动引用含空格的参数（路径里若有空格）
  const finalArg = (!isPackaged && isWin) ? arg.map((a) => /\s/.test(a) ? `"${a}"` : a) : arg;
  const spawnOpts = {
    cwd: kernelDir,
    env: { ...process.env, WA_PI_WEB_DIR: webDir, WA_PI_WS_PORT: String(wsPort) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: !isPackaged && isWin,
  };

  // 守护状态：stopped（用户主动退出）+ attempts（重启计数，仅日志）+ failures（探活连续失败计数）
  const respawnState = { stopped: false, attempts: 0, failures: 0, failThreshold: HEALTH_FAIL_THRESHOLD };
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
    log.info(`[kernel] ${reason} → 第 ${respawnState.attempts} 次自动重启，${respawnDelayMs}ms 后 respawn...`);
    setTimeout(() => {
      if (respawnState.stopped) return; // 退避期间用户退出了
      current = spawnOnce();
      // 重启后等待端口就绪（不就绪则下次 exit/error 会再触发）
      waitForPortFn(wsPort, 30000).then((ready) => {
        if (ready) {
          log.info(`[kernel] 重启就绪 @${wsPort}`);
          respawnState.attempts = 0;
          respawnState.failures = 0;
        } else log.error(`[kernel] 重启后 30s 未就绪`);
      });
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
    child.stderr.on("data", (d) => log.error(`[kernel] ${d.toString().trim()}`));
    child.on("exit", (code, signal) => {
      childExited = true;
      // code=null 表示被信号杀；signal 才是定位根因的关键（SIGTERM=被主动杀，
      // SIGKILL=强制杀/可能 OOM，SIGSEGV=段错误）。crash-logger 只能抓 JS 异常，
      // 信号杀死不进 JS，故这里必须记录 signal。
      log.info(`[kernel] 退出 code=${code} signal=${signal ?? "none"}`);
      // 崩溃（被信号杀 code=null / Windows 强杀 code=1）且非用户主动退出 → 统一重启入口
      if (shouldRespawn(code, respawnState)) scheduleRespawn("崩溃");
    });
    return child;
  }

  // 探活循环：每 5s 探测端口；连续 3 次失败 → 强杀走统一重启。stopped / 重启间隙 / 上轮未完成 跳过。
  function startHealthCheck() {
    let inFlight = false;
    healthTimer = setInterval(async () => {
      if (respawnState.stopped || childExited || inFlight || !current?.pid) return;
      inFlight = true;
      try {
        const healthy = await checkPortFn(wsPort);
        const { shouldRestart, failures } = updateHealthState(respawnState, healthy);
        respawnState.failures = failures;
        if (shouldRestart) {
          log.error(`[kernel] 端口 ${wsPort} 连续 ${respawnState.failThreshold} 次探测失败，判定挂死，强杀重启`);
          forceKill(current.pid); // exit 事件会触发统一崩溃重启
        }
      } finally {
        inFlight = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    if (healthTimer.unref) healthTimer.unref(); // 不阻塞主进程退出
  }

  current = spawnOnce();
  log.info(`kernel sidecar pid=${current.pid} cmd=${cmd} ${arg.join(" ")} port=${wsPort}`);
  const ready = await waitForPortFn(wsPort, 30000);
  if (!ready) { respawnState.stopped = true; log.error("kernel sidecar 30s 未就绪"); killFn(current.pid); throw new Error("kernel not ready"); }
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
      if (pid != null) killFn(pid);
      else log.error("[kernel] stop 时无可用 pid（从未成功 spawn），跳过杀进程");
    },
  };
}

module.exports = { startSidecar, WS_PORT, killTree };
