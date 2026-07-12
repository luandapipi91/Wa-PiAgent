// spawn 解释运行的 kernel sidecar：dev 下 bun.exe run <repo>/packages/kernel/src/desktop-server.ts；
// packaged 下 <kernelDir>/bun.exe run <kernelDir>/kernel.js。等 9776 ready；退出时 kill 子进程树。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForPort } = require("./util/port.cjs");

const WS_PORT = Number(process.env.HIAGENT_WS_PORT) > 0 ? Number(process.env.HIAGENT_WS_PORT) : 9776;

function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

async function startSidecar({ isPackaged, kernelDir, webDir, bunExe, log }) {
  // dev: repo 下用 bun 跑 kernel 源码入口；packaged: kernelDir 里 bun.exe run kernel.js
  // Windows dev 路径上 "bun" 是 .cmd shim——Node 20+ 出于 CVE-2024-27980 默认拒绝 spawn
  // .cmd/.bat（spawn EINVAL），必须 shell:true 让 cmd.exe 解析 PATHEXT。
  const isWin = process.platform === "win32";
  const cmd = isPackaged ? bunExe : "bun";
  const arg = isPackaged
    ? ["run", path.join(kernelDir, "kernel.js")]
    : ["run", path.join(kernelDir, "src", "desktop-server.ts")];
  // shell 模式下需手动引用含空格的参数（路径里若有空格）
  const finalArg = (!isPackaged && isWin) ? arg.map((a) => /\s/.test(a) ? `"${a}"` : a) : arg;
  const child = spawn(cmd, finalArg, {
    cwd: kernelDir,
    env: { ...process.env, HIAGENT_WEB_DIR: webDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: !isPackaged && isWin,
  });
  child.on("error", (e) => log.error(`[kernel] spawn error: ${e.message}`));
  child.stdout.on("data", (d) => log.info(`[kernel] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => log.error(`[kernel] ${d.toString().trim()}`));
  child.on("exit", (code) => log.info(`[kernel] 退出 code=${code}`));
  log.info(`kernel sidecar pid=${child.pid} cmd=${cmd} ${arg.join(" ")}`);
  const ready = await waitForPort(WS_PORT, 30000);
  if (!ready) { log.error("kernel sidecar 30s 未就绪"); killTree(child.pid); throw new Error("kernel not ready"); }
  log.info(`kernel 就绪 @${WS_PORT}`);
  return { child, pid: child.pid, stop: () => killTree(child.pid) };
}

module.exports = { startSidecar, WS_PORT, killTree };
