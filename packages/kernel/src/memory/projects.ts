// 项目身份解析：把「会话的工作目录」映射成稳定的项目登记 id（memory_projects.id）。
//
// 取代旧的 projectNameFromCwd（cwd basename 直接当身份）—— basename 会在
// 「不同路径同名」时串项目、在「改名/移动」后让旧记忆成孤儿、在默认工作区
// （cwd = workdir/<会话时间戳>）每次会话各成一个"项目"。
//
// 解析规则（顺序）：
//   1. 归一化路径（统一分隔符、去尾斜杠、darwin/win32 大小写不敏感）；
//      默认工作区的 <workdir>/<纯数字> 子目录归一到 workdir（所有默认工作区会话共用一个身份）。
//   2. 命中登记表 → 直接用该 id。
//   3. 未命中 → 按末段名（label，大小写不敏感）找候选：唯一候选且它记录的所有旧路径都已
//      不在磁盘上（= 项目被移动/改名）→ 新路径并入该 id（记忆接回）；否则当新项目，发新 id。
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface ResolveProjectOptions {
  /** 默认工作区目录；其下的 <纯数字时间戳> 子目录会被归一到这里（缺省不做此归一） */
  defaultWorkspaceDir?: string | null;
  /** 大小写策略依据的平台（默认 process.platform）：darwin/win32 视为不区分大小写 */
  platform?: NodeJS.Platform;
}

/** 路径归一化：统一分隔符、去尾斜杠、按平台决定是否小写；空串返回 null */
export function normalizeProjectPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!raw) return null;
  let p = raw.replace(/\\/g, "/").trim();
  if (!p) return null;
  p = p.replace(/\/+$/, "");
  if (!p) p = "/";
  // darwin/win32 的文件系统默认大小写不敏感：同一目录的不同大小写写法必须归一到同一身份
  // （linux 保持原样，避免把仅大小写不同的两个目录合并）
  if (platform === "darwin" || platform === "win32") p = p.toLowerCase();
  return p;
}

import { projectNameFromCwd } from "./paths";

/** 项目展示名（末段名，保留原始大小写）——与旧目录约定 projectNameFromCwd 同义，直接转调 */
export function projectLabelOf(raw: string): string {
  return projectNameFromCwd(raw);
}

export interface MemoryProjectRow {
  id: string;
  path: string | null;
  label: string;
}

/** 解析会话 cwd 对应的项目登记 id；无法解析（空路径）返回 null */
export function resolveProjectKey(
  db: Database,
  cwd: string,
  opts: ResolveProjectOptions = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const normalized = normalizeProjectPath(cwd, platform);
  if (!normalized) return null;
  const path = normalizeDefaultWorkspace(normalized, opts, platform);

  const hit = db
    .query("SELECT id FROM memory_projects WHERE path = ?")
    .get(path) as { id: string } | null;
  if (hit) {
    touchProject(db, hit.id, path);
    return hit.id;
  }

  const label = projectLabelOf(cwd);
  const candidates = db
    .query(
      "SELECT DISTINCT id FROM memory_projects WHERE lower(label) = lower(?)",
    )
    .all(label) as Array<{ id: string }>;

  // 唯一同名候选：只有它记录的旧路径全都已不存在时，才判定为「项目被移动/改名」并接回；
  // 旧路径还在 = 另一个同名项目，不能猜。
  if (candidates.length === 1) {
    const candidateId = candidates[0].id;
    const oldPaths = (
      db
        .query(
          "SELECT path FROM memory_projects WHERE id = ? AND path IS NOT NULL",
        )
        .all(candidateId) as Array<{ path: string }>
    ).map((r) => r.path);
    if (oldPaths.every((p) => !existsSync(p))) {
      addProjectPath(db, candidateId, path, label);
      touchProject(db, candidateId, path);
      return candidateId;
    }
  }

  const id = randomUUID();
  addProjectPath(db, id, path, label);
  return id;
}

/** 读登记项（测试与诊断用） */
export function listMemoryProjects(db: Database): MemoryProjectRow[] {
  return db
    .query("SELECT id, path, label FROM memory_projects ORDER BY label, path")
    .all() as MemoryProjectRow[];
}

/**
 * 只有项目名（label）、没有真实路径时解析登记 id —— 旧 markdown 目录导入用
 * （projects-memory/<name>/ 只有目录名，没有完整路径）。
 * 命中已有登记（含迁移生成的 legacy 项）→ 用它；没登记过 → 新建一条 path 为空的
 * 登记项（真实路径等该项目下次被打开时由 resolveProjectKey 补上）。
 */
export function ensureProjectByLabel(db: Database, label: string): string {
  const name = projectLabelOf(label);
  const rows = db
    .query(
      `SELECT id FROM memory_projects WHERE lower(label) = lower(?)
       GROUP BY id ORDER BY MAX(last_seen_at) DESC`,
    )
    .all(name) as Array<{ id: string }>;
  // 多候选取最近使用的（导入场景没有更多线索可用，不新建以免再制造孤儿）
  if (rows.length > 0) return rows[0].id;

  const id = randomUUID();
  const now = Date.now();
  db.run(
    "INSERT INTO memory_projects(id, path, label, created_at, last_seen_at) VALUES(?, NULL, ?, ?, ?)",
    [id, name, now, now],
  );
  return id;
}

function normalizeDefaultWorkspace(
  path: string,
  opts: ResolveProjectOptions,
  platform: NodeJS.Platform,
): string {
  const ws = opts.defaultWorkspaceDir
    ? normalizeProjectPath(opts.defaultWorkspaceDir, platform)
    : null;
  if (!ws) return path;
  if (path === ws) return ws;
  if (path.startsWith(`${ws}/`)) {
    // 默认工作区会话的 cwd = workdir/<会话创建时间戳>（全数字）→ 归一到 workdir，
    // 让所有默认工作区会话共用一份记忆（此前每个会话各成一个项目、互相看不到）
    const rest = path.slice(ws.length + 1);
    if (/^\d+$/.test(rest)) return ws;
  }
  return path;
}

function addProjectPath(
  db: Database,
  id: string,
  path: string,
  label: string,
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO memory_projects(id, path, label, created_at, last_seen_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id, path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [id, path, label, now, now],
  );
}

function touchProject(db: Database, id: string, path: string): void {
  db.run(
    "UPDATE memory_projects SET last_seen_at = ? WHERE id = ? AND path = ?",
    [Date.now(), id, path],
  );
}
