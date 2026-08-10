// 等端口进入 LISTEN，超时返回 false。复用 scripts/port.ts 的 isPortInUse 思路。
const { createServer } = require("node:net");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const { join } = require("node:path");

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
 * 幽灵占用回退扫描（Windows）：
 * Bun 的监听 socket 句柄可继承——kernel/pi 被杀后，若其子孙进程（pi 子代理、
 * 子代理跑的后台命令等）仍存活，端口会以「死 PID 占 LISTENING」的幽灵形态残留，
 * netstat 给出的 PID 已不存在，taskkill 无从下手。
 * 此时枚举存活进程，按「确认 wa-pi 相关进程的子孙链」圈定清理范围，避免误杀
 * 其他工作区 / CLI 模式的正常进程：
 * - 种子：命令行含 wa-pi 数据目录路径（~/.wa-pi 或 WA_PI_DIR）——pi 会话/子代理
 *   进程带 --session <dir>/sessions/... 参数，packaged kernel 带 <dir>/runtime/kernel.js。
 *   仅含 pi-coding-agent / wa-pi-kernel 字样但与我方数据目录无关的进程不匹配。
 * - 子孙链：种子的后代进程（cmd/bun shim、子代理起的后台命令）即使命令行无特征，
 *   也因进程树关联被纳入——继承的幽灵句柄往往就捏在这类进程手里。
 * 与数据目录无关的普通用户进程（如 agent 帮用户起的 dev server）不在此列。
 */
const GHOST_SCAN_PS =
  "Get-CimInstance Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/** wa-pi 数据目录（与 kernel 侧 WA_PI_DIR 解析一致；调用时读取，便于测试注入 env） */
function resolveWaPiDir() {
  return process.env.WA_PI_DIR || join(homedir(), ".wa-pi");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 目录路径 → 大小写不敏感、/ 与 \ 分隔符兼容的匹配正则（末尾带边界，避免误配同前缀兄弟目录如 .wa-pi-backup） */
function dirToRegExp(dir) {
  const segs = dir.replace(/[\\/]+$/, "").split(/[\\/]+/).map(escapeRegExp);
  return new RegExp(segs.join("[\\\\/]") + "(?=$|[\\\\/])", "i");
}

/** 拉取全量进程列表（pid/ppid/cmdline）；查询或解析失败返回空数组 */
function scanProcesses(spawnFn) {
  try {
    const out =
      spawnFn("powershell", ["-NoProfile", "-Command", GHOST_SCAN_PS], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }).stdout ?? "";
    const parsed = JSON.parse(out);
    // ConvertTo-Json 单结果时返回对象而非数组，统一归一化
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((p) => ({
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId),
        cmd: String(p.CommandLine ?? ""),
      }))
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/**
 * 圈定幽灵清理范围：数据目录特征种子 + 种子的子孙链（BFS），排除自身进程。
 * 返回 [{ pid, cmd }]（cmd 供日志记录杀的是谁）。
 */
function selectGhostPids(procs, dirRe, selfPid) {
  const childrenOf = new Map();
  for (const p of procs) {
    const list = childrenOf.get(p.ppid) ?? [];
    list.push(p);
    childrenOf.set(p.ppid, list);
  }
  const picked = new Map();
  const queue = procs.filter((p) => p.pid !== selfPid && dirRe.test(p.cmd));
  while (queue.length > 0) {
    const p = queue.shift();
    if (p.pid === selfPid || picked.has(p.pid)) continue;
    picked.set(p.pid, p.cmd);
    for (const c of childrenOf.get(p.pid) ?? []) queue.push(c);
  }
  return [...picked.entries()].map(([pid, cmd]) => ({ pid, cmd }));
}

/** 命令行摘要（日志用，压缩空白并截断） */
function summarizeCmd(cmd) {
  const s = String(cmd ?? "").replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/**
 * 执行 taskkill /T /F 并校验退出码。权限不足 / PID 已死时 status 非 0，
 * 不视为成功（返回 false 并记日志），避免后续判断建立在"已杀掉"的错误前提上。
 */
function taskkillTree(pid, spawnFn, logFn) {
  const res = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }) ?? {};
  if (res.status !== 0) {
    logFn(`[port] taskkill 失败: PID ${pid}（退出码 ${res.status ?? "未知"}）`);
    return false;
  }
  return true;
}

/**
 * 轮询等待端口释放：Windows 上 taskkill 返回不代表 socket 句柄已销毁，
 * 立即 isPortInUse 会误报「仍占用」进而触发不必要的全量幽灵扫描，
 * 给一个短等待窗口（默认 3×200ms）确认。
 */
async function waitPortReleased(port, tries = 3, intervalMs = 200) {
  for (let i = 0; i <= tries; i++) {
    if (!(await isPortInUse(port))) return true;
    if (i < tries) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * 查找并杀掉占用指定端口的进程（一键重启用）。
 * mac/linux：lsof -ti:${port} 取 PID 后 kill -9
 * windows：netstat -ano 解析 PID 后 taskkill /T /F（带进程树——子进程可能继承了
 *   监听 socket，只杀父进程端口不会释放）；杀完短轮询确认端口仍占用，才回退
 *   幽灵扫描（见 GHOST_SCAN_PS）。taskkill 退出码非 0 的 PID 记入失败列表，
 *   最终连同端口占用结果一并输出日志。
 *
 * @param {number} port 端口号
 * @param {typeof spawnSync} [spawnFn] 依赖注入 spawnSync，便于单测
 * @param {(msg: string) => void} [logFn] 日志回调（幽灵 PID 摘要 / taskkill 失败 / 清理结果）
 * @returns {Promise<number[]>} 确认杀掉的 PID 列表（taskkill 失败或无占用时不含）
 */
async function killPortOccupants(port, spawnFn = spawnSync, logFn = console.log) {
  const pids = [];
  const failed = [];
  try {
    if (process.platform === "win32") {
      // netstat 输出形如：TCP  127.0.0.1:9778  0.0.0.0:0  LISTENING  12345
      const occupants = [];
      const out = spawnFn("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).stdout ?? "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`[:\\.]${port}\\b.*LISTENING\\s+(\\d+)`));
        if (m) occupants.push(m[1]);
      }
      for (const pid of occupants) {
        if (taskkillTree(pid, spawnFn, logFn)) pids.push(pid);
        else failed.push(pid);
      }
      // 幽灵占用兜底：netstat PID 已死 / 子孙进程持有继承的 socket 句柄，
      // 短轮询确认端口仍占用时，按「数据目录特征 + 进程树子孙链」圈定我方残留进程清理
      if (occupants.length > 0 && !(await waitPortReleased(port))) {
        const dirRe = dirToRegExp(resolveWaPiDir());
        const ghosts = selectGhostPids(scanProcesses(spawnFn), dirRe, process.pid)
          .filter((g) => !occupants.includes(String(g.pid)));
        for (const g of ghosts) {
          logFn(`[port] 幽灵进程清理: PID ${g.pid}（${summarizeCmd(g.cmd)}）`);
          if (taskkillTree(g.pid, spawnFn, logFn)) pids.push(String(g.pid));
          else failed.push(String(g.pid));
        }
      }
      // 失败 PID 与最终端口结果一并输出，便于定位权限不足 / 幽灵句柄未清的场景
      const occupied = await isPortInUse(port);
      logFn(
        `[port] 端口 ${port} 清理结果：成功 [${pids.join(", ") || "无"}]，` +
        `失败 [${failed.join(", ") || "无"}]，端口${occupied ? "仍被占用" : "已释放"}`,
      );
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

module.exports = { isPortInUse, waitForPort, findAvailablePort, killPortOccupants, waitPortReleased, scanProcesses };
