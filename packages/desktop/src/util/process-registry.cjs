// 进程登记簿（G）：解决 Windows 升级后端口 9778 幽灵占用问题的第一步。
// 每次启动 kernel 时把 { pid, exe, createdAt, registeredAt } 登记到 <waPiDir>/run/registry/<pid>.json，
// 退出时 best-effort 自删；下次启动先 sweepRegistry 清掉上轮残留（TTL 兜底 + 三重校验）。
// 杀进程前三重校验（任一不匹配只删登记不动进程）：
//   ① 进程存活（process.kill(pid, 0) 探测，ESRCH=已死 / EPERM=活着但无权限）；
//   ② 进程创建时间与登记的 createdAt 一致（防 PID 复用——校验②是核心）；
//   ③ exe 路径匹配我方特征（WaPiKernel 新编译产物名 / wa-pi-kernel 旧名 / 路径含 waPiDir）——纵深防御。
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
    // createdAt/registeredAt 非法（缺失/非数字/NaN）→ 删文件跳过：NaN 会让 isOurs 的
    // 时间差比较恒 false（可能误杀）且 TTL 判断恒不超期（登记永久残留）
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(entry?.createdAt) ||
      !Number.isFinite(entry?.registeredAt)
    ) {
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

/**
 * 校验②③原料（三态结果，区分「进程不存在」与「查询失败」，避免静默失效不可观测）：
 *   { ok: true, identity: { exe, createdAt } }     查询成功
 *   { ok: false, reason: "not-found" }             进程确实不存在（命令成功执行但无输出）
 *   { ok: false, reason: "error", detail }         查询失败（命令执行出错/非 0 退出码/输出或时间格式异常）
 * 两者必须区分：not-found 是正常清理路径（删登记）；error 可能是工具/权限/格式问题，
 * 调用方应保留登记+记日志，避免「只删不杀 → 幽灵进程继续占 9778 且登记被删」的静默失效。
 */
function getProcessIdentity(pid, opts) {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === "win32") {
      // Windows：PowerShell 取 CreationDate（CIM DateTime，ISO 8601）与 ExecutablePath
      const cmd =
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        "Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress";
      const res = opts.spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }) ?? {};
      if (res.error) return { ok: false, reason: "error", detail: `命令执行失败: ${res.error.message ?? res.error}` };
      if (res.status !== 0) return { ok: false, reason: "error", detail: `PowerShell 退出码 ${res.status}` };
      const out = String(res.stdout ?? "").trim();
      if (!out || out === "null") return { ok: false, reason: "not-found" }; // 进程不存在 → CIM 无输出
      let obj;
      try {
        obj = JSON.parse(out);
      } catch (e) {
        return { ok: false, reason: "error", detail: `输出非 JSON: ${e?.message ?? e}` };
      }
      if (!obj || obj.ProcessId == null) return { ok: false, reason: "not-found" }; // 空集合边缘情况
      const createdAt = parseIsoMs(String(obj.CreationDate ?? ""));
      if (createdAt === null) return { ok: false, reason: "error", detail: "CreationDate 解析失败（格式不符）" };
      return { ok: true, identity: { exe: String(obj.ExecutablePath ?? ""), createdAt } };
    }
    // mac/linux：ps 取 lstart（创建时间，本地时间）+ command（exe 取首 token）
    const res = opts.spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
    }) ?? {};
    if (res.error) return { ok: false, reason: "error", detail: `命令执行失败: ${res.error.message ?? res.error}` };
    const out = String(res.stdout ?? "").trim();
    // 进程不存在时 ps 无输出（退出码 1）→ not-found
    if (!out) return { ok: false, reason: "not-found" };
    if (res.status !== 0) return { ok: false, reason: "error", detail: `ps 退出码 ${res.status}` };
    const m = out.match(/^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (!m) return { ok: false, reason: "error", detail: "ps 输出格式不符" };
    const createdAt = parseLstart(m[1]);
    if (createdAt === null) return { ok: false, reason: "error", detail: "lstart 解析失败（格式不符）" };
    return { ok: true, identity: { exe: m[2].split(/\s+/)[0], createdAt } };
  } catch (e) {
    return { ok: false, reason: "error", detail: `未预期异常: ${e?.message ?? e}` };
  }
}

/** 校验②+③：创建时间一致（容差见 START_TIME_TOLERANCE_MS）且 exe 匹配我方特征 */
function isOurs(entry, identity, opts) {
  if (!identity) return false;
  // ② 创建时间一致（防 PID 复用）
  if (Math.abs(identity.createdAt - entry.createdAt) >= START_TIME_TOLERANCE_MS) return false;
  // ③ exe 含 WaPiKernel（新编译产物名）或 wa-pi-kernel（≤0.2.15 旧名，升级期幽灵进程兜底）
  //    或路径含 waPiDir（纵深防御）
  const exe = String(identity.exe ?? "");
  const lower = exe.toLowerCase();
  const dir = String(opts.waPiDir ?? "").toLowerCase();
  return lower.includes("wapikernel") || lower.includes("wa-pi-kernel") || (dir !== "" && exe.includes(dir));
}

/** 命令行摘要（日志用，压缩空白并截断到 80 字符） */
function summarizeCmd(cmd) {
  const s = String(cmd ?? "").replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

/**
 * 从 rootPids 出发 BFS 收集所有存活子孙（不含根自身，不含 selfPid），
 * 用于清扫时连带清理仍挂在 kernel 进程树上的 pi 子进程（方案 B）。
 * 先建 ppid → children 映射，再逐层向下遍历；visited Set 防环
 * （进程表异常出现环时不死循环）；selfPid 命中即整棵子树跳过。
 * @param {number[]} rootPids 根 pid 列表（如登记的 kernel pid）
 * @param {{pid:number, ppid:number, cmd:string}[]} procs 全量进程表（scanProcesses 输出）
 * @param {number} [selfPid] 自身 pid（排除，避免杀到自己）
 * @returns {{pid:number, ppid:number, cmd:string}[]} 从根出发的所有子孙（不含根自身，不含 selfPid）
 */
function collectDescendants(rootPids, procs, selfPid) {
  const childrenOf = new Map();
  for (const p of procs) {
    const list = childrenOf.get(p.ppid) ?? [];
    list.push(p);
    childrenOf.set(p.ppid, list);
  }
  const visited = new Set(rootPids); // root 预标记：防环回指 root（root 自身不入结果）
  const queue = [...rootPids];
  const out = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const c of childrenOf.get(pid) ?? []) {
      if (c.pid === selfPid || visited.has(c.pid)) continue; // 入队即标记，防重复入队
      visited.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
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
 * 对每条登记：① 已死 → 删文件记 deleted；
 * ② 进程不存在（not-found）→ 删文件记 deleted；
 * ②' 身份查询失败（error：工具/权限/输出格式问题）→ 保留登记记 errors 并记日志（下轮再试，不静默丢名单）；
 * ③ 非我方（PID 复用 / exe 不符）→ 删文件记 skipped 不杀；
 * ④ 三重校验全过 → 杀：成功删文件记 killed，失败保留文件记 skipped（下轮再试）。
 */
function killRegisteredProcesses(opts) {
  const result = { killed: [], deleted: [], skipped: [], errors: [] };
  for (const entry of loadRegistry(opts)) {
    // ① 进程已死 → 只删登记
    if (!isProcessAlive(entry.pid, opts)) {
      unregisterProcess(entry.pid, opts);
      result.deleted.push(entry.pid);
      continue;
    }
    // ②③ 原料：三态结果——区分「进程不存在」与「查询失败」
    const q = getProcessIdentity(entry.pid, opts);
    if (!q.ok) {
      if (q.reason === "not-found") {
        // 进程确实不存在（命令成功执行但无输出）→ 正常清理：只删登记
        unregisterProcess(entry.pid, opts);
        result.deleted.push(entry.pid);
      } else {
        // 查询失败（工具/权限/格式问题）→ 保留登记（下轮再试）+ 记日志，避免静默丢名单
        opts.log?.(`[registry] 身份查询失败 PID ${entry.pid}: ${q.detail ?? q.reason}（保留登记，下轮重试）`);
        result.errors.push({ pid: entry.pid, reason: q.detail ?? q.reason });
      }
      continue;
    }
    // ②+③ 非我方（PID 复用 / exe 不符）→ 只删登记不动进程
    if (!isOurs(entry, q.identity, opts)) {
      unregisterProcess(entry.pid, opts);
      result.skipped.push(entry.pid);
      continue;
    }
    // 三重校验全过 → 杀：先连带清理 kernel 子孙（仍挂树上的 pi 子进程，未单独登记），
    // 再杀 root。scanProcesses 非 Windows/查询失败返回 [] 时子孙链为空，行为与现状一致。
    const procs = opts.scanProcesses?.() ?? [];
    const descendants = collectDescendants([entry.pid], procs, opts.selfPid ?? process.pid);
    for (const child of descendants) {
      opts.log?.(`[registry] 连带清理 kernel 子孙 PID ${child.pid}（${summarizeCmd(child.cmd)}）`);
      if (killProcess(child.pid, opts)) {
        result.killed.push(child.pid);
      } else {
        result.skipped.push(child.pid); // 子孙杀失败不阻断杀 root
      }
    }
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
 * 启动清扫：返回 { killed:[], deleted:[], skipped:[], errors:[] }。
 * 先做 TTL 兜底（超期只删文件不碰进程），再把其余条目交给杀伐部分；
 * errors 为身份查询失败（非进程不存在）的条目 [{ pid, reason }]，失败不杀且保留登记。
 */
function sweepRegistry(opts) {
  const result = { killed: [], deleted: [], skipped: [], errors: [] };
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
  result.errors.push(...r.errors);
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
  collectDescendants,
};
