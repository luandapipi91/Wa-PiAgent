// 等端口进入 LISTEN，超时返回 false。复用 scripts/port.ts 的 isPortInUse 思路。
const { createServer } = require("node:net");
const { spawnSync } = require("node:child_process");

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 从 startPort 开始顺序探测，返回第一个可用端口 */
async function findAvailablePort(startPort, maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`未找到可用端口（${startPort} ~ ${startPort + maxTries - 1}）`);
}

/**
 * 查找并杀掉占用指定端口的进程（一键重启用）。
 * mac/linux：lsof -ti:${port} 取 PID 后 kill -9
 * windows：netstat -ano 解析 PID 后 taskkill /PID /F
 *
 * @param {number} port 端口号
 * @param {typeof spawnSync} [spawnFn] 依赖注入 spawnSync，便于单测
 * @returns {number[]} 被杀掉的 PID 列表（杀失败或无占用时为空数组）
 */
function killPortOccupants(port, spawnFn = spawnSync) {
  const pids = [];
  try {
    if (process.platform === "win32") {
      // netstat 输出形如：TCP  127.0.0.1:9778  0.0.0.0:0  LISTENING  12345
      const out = spawnFn("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).stdout ?? "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`[:\\.]${port}\\b.*LISTENING\\s+(\\d+)`));
        if (m) pids.push(m[1]);
      }
      for (const pid of pids) {
        spawnFn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
      }
    } else {
      // lsof -ti:${port} 直接输出占用进程的 PID（每行一个）
      const out = spawnFn("lsof", ["-ti:" + port], { encoding: "utf8" }).stdout ?? "";
      for (const pid of out.split(/\n/).map((s) => s.trim()).filter(Boolean)) {
        pids.push(pid);
        spawnFn("kill", ["-9", pid], { stdio: "ignore" });
      }
    }
  } catch {}
  return pids.map((p) => Number(p)).filter((n) => Number.isFinite(n));
}

module.exports = { isPortInUse, waitForPort, findAvailablePort, killPortOccupants };
