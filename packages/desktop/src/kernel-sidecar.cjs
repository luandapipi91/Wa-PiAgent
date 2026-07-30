// spawn 解释运行的 kernel sidecar：dev 下 bun run <repo>/packages/kernel/src/desktop-server.ts；
// packaged 下 <kernelDir>/wa-pi-kernel(.exe) run <kernelDir>/kernel.js。等 9778 ready；退出时 kill 子进程树。
// 崩溃（被信号杀 code=null）时自动限次重启（auto-respawn），避免前端永远卡"连接已断开"。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForPort } = require("./util/port.cjs");
const { shouldRespawn, MAX_RESPAWN, RESPAWN_DELAY_MS } = require("./util/auto-respawn.cjs");

const WS_PORT = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : 9778;

function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

async function startSidecar({ isPackaged, kernelDir, webDir, kernelExe, log, port }) {
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

  // 重启状态：用户主动 stop() 后禁止重启；记录重启次数防止崩溃循环
  const respawnState = { stopped: false, attempts: 0 };
  let current = null; // 当前 child 引用（重启时替换）

  // 创建一个 kernel 子进程并绑定日志/崩溃重启。返回 child。
  function spawnOnce() {
    const child = spawn(cmd, finalArg, spawnOpts);
    child.on("error", (e) => log.error(`[kernel] spawn error: ${e.message}`));
    child.stdout.on("data", (d) => log.info(`[kernel] ${d.toString().trim()}`));
    child.stderr.on("data", (d) => log.error(`[kernel] ${d.toString().trim()}`));
    child.on("exit", (code, signal) => {
      // code=null 表示被信号杀；signal 才是定位根因的关键（SIGTERM=被主动杀，
      // SIGKILL=强制杀/可能 OOM，SIGSEGV=段错误）。crash-logger 只能抓 JS 异常，
      // 信号杀死不进 JS，故这里必须记录 signal。
      log.info(`[kernel] 退出 code=${code} signal=${signal ?? "none"}`);
      // 崩溃（被信号杀 code=null）且非用户主动退出且未超上限 → 延迟后自动重启
      if (shouldRespawn(code, respawnState)) {
        respawnState.attempts++;
        log.info(`[kernel] 崩溃自动重启 ${respawnState.attempts}/${MAX_RESPAWN}，${RESPAWN_DELAY_MS}ms 后 respawn...`);
        setTimeout(() => {
          if (respawnState.stopped) return; // 退避期间用户退出了
          current = spawnOnce();
          // 重启后等待端口就绪（不就绪则下次 exit 会再触发）
          waitForPort(wsPort, 30000).then((ready) => {
            if (ready) { log.info(`[kernel] 重启就绪 @${wsPort}`); respawnState.attempts = 0; }
            else log.error(`[kernel] 重启后 30s 未就绪`);
          });
        }, RESPAWN_DELAY_MS);
      } else if (code === null && !respawnState.stopped) {
        log.error(`[kernel] 崩溃且已达重启上限(${MAX_RESPAWN})，放弃自动重启`);
      }
    });
    return child;
  }

  current = spawnOnce();
  log.info(`kernel sidecar pid=${current.pid} cmd=${cmd} ${arg.join(" ")} port=${wsPort}`);
  const ready = await waitForPort(wsPort, 30000);
  if (!ready) { log.error("kernel sidecar 30s 未就绪"); killTree(current.pid); throw new Error("kernel not ready"); }
  log.info(`kernel 就绪 @${wsPort}`);
  return {
    child: current,
    pid: current.pid,
    port: wsPort,
    // 主动停止：置 stopped 标志后 kill，防止 exit handler 误判为崩溃而重启
    stop: () => { respawnState.stopped = true; killTree(current?.pid); },
  };
}

module.exports = { startSidecar, WS_PORT, killTree };
