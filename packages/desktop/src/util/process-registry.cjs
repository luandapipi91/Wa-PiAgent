// 进程登记簿（G）：解决 Windows 升级后端口 9778 幽灵占用问题的第一步。
// 每次启动 kernel 时把 { pid, exe, createdAt, registeredAt } 登记到 <waPiDir>/run/registry/<pid>.json，
// 退出时 best-effort 自删；下次启动先 sweepRegistry 清掉上轮残留（TTL 兜底 + 三重校验）。
// 杀进程前三重校验（任一不匹配只删登记不动进程）：
//   ① 进程存活（process.kill(pid, 0) 探测，ESRCH=已死 / EPERM=活着但无权限）；
//   ② 进程创建时间与登记的 createdAt 一致（防 PID 复用——校验②是核心）；
//   ③ exe 路径匹配我方特征（wa-pi-kernel 或路径含 waPiDir）——纵深防御。
// opts 全程依赖注入：{ fs, spawnSync, now, waPiDir, log }；
//   另支持可选注入 kill（默认 process.kill）与 platform（默认 process.platform），
//   保证测试绝不真杀进程、且能在任意平台覆盖两个平台分支。
const { join } = require("node:path");

/** TTL：7 天。超期记录只删文件不碰进程（pid 可能早已被别的进程复用） */
const TTL_MS = 7 * 24 * 3600 * 1000;

/** 创建时间一致性容差（ms）：ps lstart 只有秒级精度，严格相等会让 mac/linux 恒判定复用；
 *  PID 复用的创建时间差异远大于 2s，容差不削弱防复用效果 */
const START_TIME_TOLERANCE_MS = 2000;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function registryDir(opts) {
  return join(opts.waPiDir, "run", "registry");
}

/** 登记 kernel 进程：写 run/registry/<pid>.json，registeredAt 取注入 now */
function registerProcess(pid, meta, opts) {
  const dir = registryDir(opts);
  opts.fs.mkdirSync(dir, { recursive: true });
  const entry = { pid, exe: meta.exe, createdAt: meta.createdAt, registeredAt: opts.now() };
  opts.fs.writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry));
  return entry;
}

/** 删除登记文件；文件不存在不报错（best-effort 自删） */
function unregisterProcess(pid, opts) {
  try {
    opts.fs.unlinkSync(join(registryDir(opts), `${pid}.json`));
  } catch {}
}

/** 读目录 → [{ pid, exe, createdAt, registeredAt }]；坏 JSON 跳过并删坏文件，目录不存在返回 [] */
function loadRegistry(opts) {
  const dir = registryDir(opts);
  let names;
  try {
    names = opts.fs.readdirSync(dir);
  } catch {
    return []; // 目录不存在 → 无登记
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    let entry;
    try {
      entry = JSON.parse(opts.fs.readFileSync(full, "utf8"));
    } catch {
      try { opts.fs.unlinkSync(full); } catch {} // 坏 JSON：删文件并跳过
      continue;
    }
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid)) {
      try { opts.fs.unlinkSync(full); } catch {}
      continue;
    }
    entries.push({ pid, exe: entry.exe, createdAt: entry.createdAt, registeredAt: entry.registeredAt });
  }
  entries.sort((a, b) => a.pid - b.pid);
  return entries;
}

/** 校验①：进程存活探测（信号 0，不杀）。ESRCH=已死；EPERM=活着但无权限 */
function isProcessAlive(pid, opts) {
  try {
    const kill = opts.kill ?? process.kill;
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

/** ISO 8601（可能带 >3 位小数）→ 毫秒；解析失败返回 null */
function parseIsoMs(s) {
  const ms = Date.parse(s.replace(/\.(\d{3})\d+/, ".$1"));
  return Number.isFinite(ms) ? ms : null;
}

/** ps lstart（"Mon Aug 10 14:48:27 2026"，本地时间）→ 毫秒；解析失败返回 null */
function parseLstart(s) {
  const t = s.split(/\s+/); // [Day, Mon, DD, HH:MM:SS, YYYY]
  if (t.length !== 5) return null;
  const mon = MONTHS[t[1]];
  if (mon === undefined) return null;
  const [h, mi, sec] = t[3].split(":").map(Number);
  const d = new Date(Number(t[4]), mon, Number(t[2]), h, mi, sec);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/** 校验②③原料：{ exe, createdAt } | null（进程已死 / 查询失败返回 null） */
function getProcessIdentity(pid, opts) {
  try {
    if ((opts.platform ?? process.platform) === "win32") {
      // Windows：PowerShell 取 CreationDate（CIM DateTime，ISO 8601）与 ExecutablePath
      const cmd =
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        "Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress";
      const res = opts.spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }) ?? {};
      const out = String(res.stdout ?? "").trim();
      if (!out || out === "null") return null; // 进程不存在 → CIM 无输出
      const obj = JSON.parse(out);
      if (!obj || obj.ProcessId == null) return null;
      const createdAt = parseIsoMs(String(obj.CreationDate ?? ""));
      if (createdAt === null) return null;
      return { exe: String(obj.ExecutablePath ?? ""), createdAt };
    }
    // mac/linux：ps 取 lstart（创建时间，本地时间）+ command（exe 取首 token）
    const res = opts.spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
    }) ?? {};
    const out = String(res.stdout ?? "").trim();
    // 进程不存在时 ps 输出为空 → null
    const m = out.match(/^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (!m) return null;
    const createdAt = parseLstart(m[1]);
    if (createdAt === null) return null;
    return { exe: m[2].split(/\s+/)[0], createdAt };
  } catch {
    return null;
  }
}

/** 校验②+③：创建时间一致（容差见 START_TIME_TOLERANCE_MS）且 exe 匹配我方特征 */
function isOurs(entry, identity, opts) {
  if (!identity) return false;
  // ② 创建时间一致（防 PID 复用）
  if (Math.abs(identity.createdAt - entry.createdAt) >= START_TIME_TOLERANCE_MS) return false;
  // ③ exe 含 wa-pi-kernel 或路径含 waPiDir（纵深防御）
  const exe = String(identity.exe ?? "").toLowerCase();
  const dir = String(opts.waPiDir ?? "").toLowerCase();
  return exe.includes("wa-pi-kernel") || (dir !== "" && exe.includes(dir));
}

/** 执行杀伐：Windows taskkill /T /F（进程树）；其他 process.kill SIGKILL。返回是否成功 */
function killProcess(pid, opts) {
  if ((opts.platform ?? process.platform) === "win32") {
    const res = opts.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }) ?? {};
    if (res.status !== 0) {
      opts.log?.(`[registry] taskkill 失败: PID ${pid}（退出码 ${res.status ?? "未知"}）`);
      return false;
    }
    return true;
  }
  try {
    const kill = opts.kill ?? process.kill;
    kill(pid, "SIGKILL");
    return true;
  } catch (e) {
    opts.log?.(`[registry] kill ${pid} 失败: ${e?.message ?? e}`);
    return false;
  }
}

/**
 * sweep 的杀伐部分（可被 restart-after-port-kill 复用）：
 * 对每条登记：① 已死 → 删文件记 deleted；② 身份查询失败 → 删文件记 deleted；
 * ③ 非我方（PID 复用 / exe 不符）→ 删文件记 skipped 不杀；
 * ④ 三重校验全过 → 杀：成功删文件记 killed，失败保留文件记 skipped（下轮再试）。
 */
function killRegisteredProcesses(opts) {
  const result = { killed: [], deleted: [], skipped: [] };
  for (const entry of loadRegistry(opts)) {
    // ① 进程已死 → 只删登记
    if (!isProcessAlive(entry.pid, opts)) {
      unregisterProcess(entry.pid, opts);
      result.deleted.push(entry.pid);
      continue;
    }
    // ②③ 原料：查询失败（进程刚消失/权限不足）→ 只删登记
    const identity = getProcessIdentity(entry.pid, opts);
    if (!identity) {
      unregisterProcess(entry.pid, opts);
      result.deleted.push(entry.pid);
      continue;
    }
    // ②+③ 非我方（PID 复用 / exe 不符）→ 只删登记不动进程
    if (!isOurs(entry, identity, opts)) {
      unregisterProcess(entry.pid, opts);
      result.skipped.push(entry.pid);
      continue;
    }
    // 三重校验全过 → 杀
    if (killProcess(entry.pid, opts)) {
      unregisterProcess(entry.pid, opts);
      result.killed.push(entry.pid);
    } else {
      result.skipped.push(entry.pid); // 杀失败保留文件，下轮 TTL/启动清扫再试
    }
  }
  return result;
}

/**
 * 启动清扫：返回 { killed:[], deleted:[], skipped:[] }。
 * 先做 TTL 兜底（超期只删文件不碰进程），再把其余条目交给杀伐部分。
 */
function sweepRegistry(opts) {
  const result = { killed: [], deleted: [], skipped: [] };
  const now = opts.now();
  for (const entry of loadRegistry(opts)) {
    // TTL 兜底：超期记录只删文件不碰进程（pid 可能早已换主）
    if (now - entry.registeredAt > TTL_MS) {
      unregisterProcess(entry.pid, opts);
      result.deleted.push(entry.pid);
    }
  }
  const r = killRegisteredProcesses(opts);
  result.killed.push(...r.killed);
  result.deleted.push(...r.deleted);
  result.skipped.push(...r.skipped);
  return result;
}

module.exports = {
  registerProcess,
  unregisterProcess,
  loadRegistry,
  isProcessAlive,
  getProcessIdentity,
  isOurs,
  sweepRegistry,
  killRegisteredProcesses,
};
