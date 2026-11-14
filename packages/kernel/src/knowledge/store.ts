// 知识库登记层：库 CRUD、状态、索引任务进度的唯一读写入口。
// 登记行在 <WA_PI_DIR>/knowledge.db（由调用方建库后注入），每库块数据在
// 独立 db 文件（kb-db.ts），本层只在 deleteKb 时负责删掉该文件。
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { KbInfo } from "@wa-pi/shared";
import { closeAllKbDbs, evictKbDb } from "./kb-db";
import { mirrorDirFor } from "./mirror";
import { kbDbPath } from "./paths";

type KbPhase = NonNullable<KbInfo["progress"]>["phase"];
type KbStatus = KbInfo["status"];

/** 卡死阈值：owner 已失联的 job 超过 10 分钟无心跳视为卡死（watcher 兜底重索引用） */
export const JOB_STUCK_MS = 10 * 60_000;

/** 本进程的 owner 标识（pid + 启动随机串）：kernel 单进程，进程退出这个串就不再出现 */
const PROC_OWNER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * 本进程写下过（或自身持有）的存活 owner。
 * 存活判定不查系统进程表：同进程登记的 owner 一律视为存活；不在表里的（重启残留、他进程旧行）
 * 视为已失联，交回心跳阈值判定。进程重启后本表清空，旧 owner 自然失联——这正是要修的 bug。
 */
const liveOwners = new Set<string>([PROC_OWNER_ID]);

/** 当前进程的 owner 标识（indexer 起任务时写入 indexing_jobs.owner） */
export function processOwnerId(): string {
  return PROC_OWNER_ID;
}

/** 仅供测试：把存活 owner 表归位到「只有本进程」（模块级状态的用例间污染清理） */
export function resetJobOwnerStateForTest(): void {
  liveOwners.clear();
  liveOwners.add(PROC_OWNER_ID);
}

/** 默认描述模板（规格 §6.8：不填时告诉智能体这是哪来的资料、何时该查） */
function defaultDescription(name: string): string {
  return `来自文件夹「${name}」的资料索引，回答与「${name}」相关的问题前可检索本库`;
}

/** 索引任务行（indexing_jobs 的 camelCase 投影） */
export interface KbJob {
  kbId: string;
  phase: KbPhase;
  filesTotal: number | null;
  filesDone: number | null;
  chunksDone: number | null;
  /** 本轮待嵌入块总量（embedding 阶段前为 null） */
  chunksTotal: number | null;
  /** 跳过原因 → 数量（skip_stats JSON 解析结果） */
  skipStats: Record<string, number> | null;
  /** 执行进程标识；null = 无主/已失联（旧库行、进程重启残留） */
  owner: string | null;
  /** 最近一次心跳时刻（失联 owner 的卡死判定依据） */
  heartbeatAt: number;
  lastProgressAt: number;
  createdAt: number;
}

/** mirror 转换统计（knowledge_bases.mirror_meta 列的 JSON 结构；indexer 整轮收尾写入） */
export interface MirrorMeta {
  converterVersion: number; // 写入时的转换器版本（CONVERTER_VERSION），据以判断是否需要重转
  converted: number; // 本轮成功转换（有副本）的文件数
  degraded: number; // 本轮降级（无副本，原文直读索引）的文件数
  images: number; // 本轮外联落盘的图片总数
}

interface KbRow {
  id: string;
  name: string;
  description: string;
  folder_path: string;
  status: KbStatus;
  file_count: number | null;
  chunk_count: number | null;
  failed_count: number | null;
  auto_watch: number;
  last_indexed_at: number | null;
  last_error: string | null;
  mirror_meta: string | null;
  created_at: number;
}

/** mirror_meta 列 JSON 解析：旧库无值/脏数据（parse 失败或字段缺失）一律 null（前端不渲染副本行） */
function parseMirrorMeta(raw: string | null): KbInfo["mirrorMeta"] {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as NonNullable<KbInfo["mirrorMeta"]>;
    const ok =
      typeof meta.converterVersion === "number" &&
      typeof meta.converted === "number" &&
      typeof meta.degraded === "number" &&
      typeof meta.images === "number";
    return ok ? meta : null;
  } catch {
    return null;
  }
}

function rowToKb(row: KbRow, job: KbJob | null): KbInfo {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folderPath: row.folder_path,
    status: row.status,
    fileCount: row.file_count ?? 0,
    chunkCount: row.chunk_count ?? 0,
    failedCount: row.failed_count ?? 0,
    autoWatch: row.auto_watch === 1,
    lastIndexedAt: row.last_indexed_at,
    lastError: row.last_error ?? null,
    mirrorMeta: parseMirrorMeta(row.mirror_meta),
    progress: job
      ? {
          phase: job.phase,
          filesTotal: job.filesTotal ?? 0,
          filesDone: job.filesDone ?? 0,
          chunksDone: job.chunksDone ?? 0,
          chunksTotal: job.chunksTotal ?? 0,
        }
      : undefined,
  };
}

export class KnowledgeStore {
  constructor(
    private readonly db: Database,
    /** WA_PI_DIR：deleteKb 定位每库 db 文件用；routes 层构建 KbContext 也读它（openKbDb） */
    readonly waPiDir: string,
  ) {
    this.migrateJobTable();
  }

  /**
   * 轻量迁移：已发布版本的 knowledge.db 里缺列，CREATE TABLE IF NOT EXISTS 不会补——
   * 按实际列名检查后 ALTER 补齐（幂等）。
   *   · indexing_jobs.chunks_total（embedding 阶段进度）
   *   · indexing_jobs.owner / heartbeat_at（卡死判定按 owner 失联 + 心跳）
   *   · knowledge_bases.last_error（失败原因上界面）
   *   · knowledge_bases.mirror_meta / last_snapshot（mirror 转换统计 / 目录快照基线）
   */
  private migrateJobTable(): void {
    const ensure = (table: string, column: string, ddl: string) => {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === column)) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    ensure("indexing_jobs", "chunks_total", "chunks_total INTEGER");
    ensure("indexing_jobs", "owner", "owner TEXT");
    ensure("indexing_jobs", "heartbeat_at", "heartbeat_at INTEGER");
    ensure("knowledge_bases", "last_error", "last_error TEXT");
    ensure("knowledge_bases", "mirror_meta", "mirror_meta TEXT");
    ensure("knowledge_bases", "last_snapshot", "last_snapshot TEXT");
  }

  /** 记录/清空最近一次整轮索引失败原因（成功收尾传 null） */
  setLastError(id: string, message: string | null): void {
    this.db.run(`UPDATE knowledge_bases SET last_error = ? WHERE id = ?`, [message, id]);
  }

  /** 删库回调（悬挂绑定清理）：接线处经 setOnKbDeleted 注册，deleteKb 时按注册顺序遍历调用 */
  private onKbDeletedCbs: Array<(kbId: string) => void> = [];

  /** 注册删库回调（如：从智能体绑定的 knowledgeBaseIds 中清理悬挂引用）。支持多个。 */
  setOnKbDeleted(cb: (kbId: string) => void): void {
    this.onKbDeletedCbs.push(cb);
  }

  /**
   * 登记新库。name/description 不填时的默认值规则（规格 §6.8）：
   * 名称取文件夹 basename，描述用默认模板。
   */
  createKb(input: { folderPath: string; name?: string; description?: string }): KbInfo {
    const name = input.name?.trim() || basename(input.folderPath);
    const description = input.description?.trim() || defaultDescription(name);
    const kb: KbInfo = {
      id: randomUUID(),
      name,
      description,
      folderPath: input.folderPath,
      status: "scanning",
      fileCount: 0,
      chunkCount: 0,
      failedCount: 0,
      autoWatch: true,
      lastIndexedAt: null,
    };
    this.db.run(
      `INSERT INTO knowledge_bases (id, name, description, folder_path, status, auto_watch, created_at)
       VALUES (?, ?, ?, ?, 'scanning', 1, ?)`,
      [kb.id, kb.name, kb.description, kb.folderPath, Date.now()],
    );
    return kb;
  }

  listKbs(): KbInfo[] {
    const rows = this.db
      .query(`SELECT * FROM knowledge_bases ORDER BY created_at ASC, id ASC`)
      .all() as KbRow[];
    return rows.map((row) => rowToKb(row, this.getJob(row.id)));
  }

  getKb(id: string): KbInfo | null {
    const row = this.db.query(`SELECT * FROM knowledge_bases WHERE id = ?`).get(id) as
      | KbRow
      | null;
    return row ? rowToKb(row, this.getJob(id)) : null;
  }

  /** 级联清理：删 job 行 + 登记行 + 每库 db 文件（含 WAL/SHM 伴生文件）+ 触发删库回调 */
  deleteKb(id: string): void {
    // bun:sqlite 默认 foreign_keys=OFF，ON DELETE CASCADE 不生效，必须显式删
    this.db.run(`DELETE FROM indexing_jobs WHERE kb_id = ?`, [id]);
    // 副本目录在【源文件夹】下（知识库资源），删行前先取 folderPath 定位
    const kbRow = this.getKb(id);
    const kbMirrorDir = kbRow ? mirrorDirFor(kbRow.folderPath) : null;
    this.db.run(`DELETE FROM knowledge_bases WHERE id = ?`, [id]);
    // 先关缓存连接再删文件：Windows 上句柄占用会让 unlinkSync 静默失败，
    // 留下登记行已删、db 文件成孤儿的半删除状态（S7）。传 path：只关本目录下该库的连接
    const p = kbDbPath(this.waPiDir, id);
    evictKbDb(id, p);
    for (const f of [p, `${p}-wal`, `${p}-shm`]) {
      try {
        unlinkSync(f);
      } catch (err) {
        // 文件不存在即目标状态；其他原因（占用/权限）删不掉会留孤儿文件——留痕便于排障
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[knowledge] 删库遗留文件未清掉: ${f}`, err);
        }
      }
    }
    // mirror 目录（md 副本 + _assets 外联图片）在【源文件夹】下（知识库资源），随库一并清掉；
    // force+recursive 幂等（库行缺失/从未转过索引时无目录可删，跳过）
    if (kbMirrorDir) {
      try {
        rmSync(kbMirrorDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[knowledge] 删库遗留 mirror 目录未清掉: ${kbMirrorDir}`, err);
      }
    }
    // 登记行已删，回调清理绑定中的悬挂引用（回调自身失败不阻断删除流程）
    for (const cb of this.onKbDeletedCbs) {
      try {
        cb(id);
      } catch (err) {
        console.warn(`[knowledge] 删库回调执行失败 (kbId=${id}):`, err);
      }
    }
  }

  /**
   * 关闭登记库 + 全部每库 db 连接（kernel 优雅退出用；Windows 上句柄挂着会锁住目录无法删除）。
   * 每库连接归 kb-db 的缓存所有，本层只在此刻统一释放；下次访问惰性重连。
   */
  close(): void {
    closeAllKbDbs();
    this.db.close();
  }

  /** 更新状态；counters 提供时一并更新对应计数（embedMeta 为库级模型指纹；lastIndexedAt 由索引收尾写入） */
  updateStatus(
    id: string,
    status: KbStatus,
    counters?: {
      fileCount?: number;
      chunkCount?: number;
      failedCount?: number;
      embedMeta?: string;
      lastIndexedAt?: number;
    },
  ): void {
    if (!counters) {
      this.db.run(`UPDATE knowledge_bases SET status = ? WHERE id = ?`, [status, id]);
      return;
    }
    const sets = ["status = ?"];
    const args: (string | number)[] = [status];
    if (counters.fileCount !== undefined) {
      sets.push("file_count = ?");
      args.push(counters.fileCount);
    }
    if (counters.chunkCount !== undefined) {
      sets.push("chunk_count = ?");
      args.push(counters.chunkCount);
    }
    if (counters.failedCount !== undefined) {
      sets.push("failed_count = ?");
      args.push(counters.failedCount);
    }
    if (counters.embedMeta !== undefined) {
      sets.push("embed_meta = ?");
      args.push(counters.embedMeta);
    }
    if (counters.lastIndexedAt !== undefined) {
      sets.push("last_indexed_at = ?");
      args.push(counters.lastIndexedAt);
    }
    args.push(id);
    this.db.run(`UPDATE knowledge_bases SET ${sets.join(", ")} WHERE id = ?`, args);
  }

  setAutoWatch(id: string, on: boolean): void {
    this.db.run(`UPDATE knowledge_bases SET auto_watch = ? WHERE id = ?`, [on ? 1 : 0, id]);
  }

  /** 更新库元信息（名称/描述）；未提供的字段不动。autoWatch 走 setAutoWatch（语义独立） */
  updateKbMeta(id: string, meta: { name?: string; description?: string }): void {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    if (meta.name !== undefined) {
      sets.push("name = ?");
      args.push(meta.name);
    }
    if (meta.description !== undefined) {
      sets.push("description = ?");
      args.push(meta.description);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db.run(`UPDATE knowledge_bases SET ${sets.join(", ")} WHERE id = ?`, args);
  }

  /** 库级模型指纹（embed_meta）；从未索引过为 null。不进 KbInfo 投影——索引器增量判定专用 */
  getEmbedMeta(id: string): string | null {
    const row = this.db.query(`SELECT embed_meta FROM knowledge_bases WHERE id = ?`).get(id) as
      | { embed_meta: string | null }
      | null;
    return row?.embed_meta ?? null;
  }

  /** 读上一轮 mirror 转换统计；未写入或列内不是合法 JSON（手改/残留脏数据）一律视为 null */
  getMirrorMeta(kbId: string): MirrorMeta | null {
    const row = this.db.query(`SELECT mirror_meta FROM knowledge_bases WHERE id = ?`).get(kbId) as
      | { mirror_meta: string | null }
      | null;
    if (!row?.mirror_meta) return null;
    try {
      return JSON.parse(row.mirror_meta) as MirrorMeta;
    } catch {
      return null;
    }
  }

  /** 写上一轮 mirror 转换统计（JSON 序列化落 mirror_meta 列；indexer 整轮收尾时调用） */
  setMirrorMeta(kbId: string, meta: MirrorMeta): void {
    this.db.run(`UPDATE knowledge_bases SET mirror_meta = ? WHERE id = ?`, [JSON.stringify(meta), kbId]);
  }

  /** 读目录快照基线（离线变更补偿用）；未设置为 null。快照串格式由 watcher 层定义，本层透传不解析 */
  getLastSnapshot(kbId: string): string | null {
    const row = this.db.query(`SELECT last_snapshot FROM knowledge_bases WHERE id = ?`).get(kbId) as
      | { last_snapshot: string | null }
      | null;
    return row?.last_snapshot ?? null;
  }

  /** 写目录快照基线（watcher/索引收尾时调用）；本层透传不解析，格式由调用方定义 */
  setLastSnapshot(kbId: string, snapshot: string): void {
    this.db.run(`UPDATE knowledge_bases SET last_snapshot = ? WHERE id = ?`, [snapshot, kbId]);
  }

  /**
   * 开始一轮索引任务（同库同时只允许一个活动 job——kb_id 是主键）；已有活动 job 时拒绝，不静默覆盖。
   *
   * owner 缺省 = 本进程 owner（processOwnerId）：**忘传 owner 不会静默失去活任务保护**；
   * 只有显式传 `owner: null` 才表示无 owner（旧库/外来行语义，回落心跳阈值判定）。
   */
  startJob(kbId: string, phase: KbPhase, opts?: { owner?: string | null }): void {
    if (this.getJob(kbId)) {
      throw new Error(`知识库 ${kbId} 已有进行中的索引任务，拒绝重复启动`);
    }
    const now = Date.now();
    const owner = opts?.owner === undefined ? processOwnerId() : opts.owner;
    this.db.run(
      `INSERT INTO indexing_jobs (kb_id, phase, owner, last_progress_at, heartbeat_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [kbId, phase, owner, now, now, now],
    );
    if (owner !== null) liveOwners.add(owner);
  }

  /**
   * 部分更新 job 进度；每次调用都刷新心跳（last_progress_at + heartbeat_at）——
   * 心跳是 owner 失联后判卡死的唯一依据。opts.heartbeatAt 供测试/离线推演指定心跳时刻。
   */
  updateJobProgress(
    kbId: string,
    patch: Partial<{ phase: KbPhase; filesTotal: number; filesDone: number; chunksDone: number; chunksTotal: number; skipStats: Record<string, number> }>,
    opts?: { heartbeatAt?: number },
  ): void {
    const beat = opts?.heartbeatAt ?? Date.now();
    const sets = ["last_progress_at = ?", "heartbeat_at = ?"];
    const args: (string | number)[] = [beat, beat];
    if (patch.phase !== undefined) {
      sets.push("phase = ?");
      args.push(patch.phase);
    }
    if (patch.filesTotal !== undefined) {
      sets.push("files_total = ?");
      args.push(patch.filesTotal);
    }
    if (patch.filesDone !== undefined) {
      sets.push("files_done = ?");
      args.push(patch.filesDone);
    }
    if (patch.chunksDone !== undefined) {
      sets.push("chunks_done = ?");
      args.push(patch.chunksDone);
    }
    if (patch.chunksTotal !== undefined) {
      sets.push("chunks_total = ?");
      args.push(patch.chunksTotal);
    }
    if (patch.skipStats !== undefined) {
      sets.push("skip_stats = ?");
      args.push(JSON.stringify(patch.skipStats));
    }
    args.push(kbId);
    this.db.run(`UPDATE indexing_jobs SET ${sets.join(", ")} WHERE kb_id = ?`, args);
  }

  /**
   * 任务收尾：删 job 行（KbInfo.progress 随之清除）。
   * 不动 liveOwners：存活表登的是「进程」，不是「这一轮 job」——进程还活着，owner 就该继续被豁免；
   * job 行的存在与否才是活动任务的唯一真源（startJob 插入、本方法删除）。
   */
  finishJob(kbId: string): void {
    this.db.run(`DELETE FROM indexing_jobs WHERE kb_id = ?`, [kbId]);
  }

  getJob(kbId: string): KbJob | null {
    const row = this.db.query(`SELECT * FROM indexing_jobs WHERE kb_id = ?`).get(kbId) as
      | {
          kb_id: string;
          phase: KbPhase;
          files_total: number | null;
          files_done: number | null;
          chunks_done: number | null;
          chunks_total: number | null;
          skip_stats: string | null;
          owner: string | null;
          heartbeat_at: number | null;
          last_progress_at: number;
          created_at: number;
        }
      | null;
    if (!row) return null;
    return {
      kbId: row.kb_id,
      phase: row.phase,
      filesTotal: row.files_total,
      filesDone: row.files_done,
      chunksDone: row.chunks_done,
      chunksTotal: row.chunks_total,
      skipStats: row.skip_stats ? (JSON.parse(row.skip_stats) as Record<string, number>) : null,
      owner: row.owner ?? null,
      // 旧库迁移补列后存量行为 NULL：回落到 last_progress_at（迁移前它承担的就是心跳职责）
      heartbeatAt: row.heartbeat_at ?? row.last_progress_at,
      lastProgressAt: row.last_progress_at,
      createdAt: row.created_at,
    };
  }

  /**
   * 把 job 的 owner 置空 = 该 job 的 owner 失联（进程重启后旧 owner 必然不存在，这也是测试模拟失联的钩子）。
   * 置空后该 job 回落到「心跳超过 JOB_STUCK_MS」判定。
   * 刻意不动模块级 liveOwners：owner 是进程级标识，同一进程可能还挂着别的 kb 的 job，
   * 全局摘除会误伤它们；本 job 靠 owner=NULL 就已足够脱离活任务豁免。
   */
  expireJobOwner(kbId: string): void {
    this.db.run(`UPDATE indexing_jobs SET owner = NULL WHERE kb_id = ?`, [kbId]);
  }

  /**
   * 卡死判定（watcher 兜底回收残骸的唯一依据）：
   *   · owner 是本进程写下的存活 owner → 恒为 false。活任务可能长时间不刷新心跳
   *     （大目录扫描、单个超大文件抽取、嵌入模型慢），按「多久没进度」判会误杀正在跑的索引；
   *   · owner 为 null 或已失联（重启残留 / expireJobOwner 置空）→ 心跳超过 JOB_STUCK_MS 即卡死。
   * at 显式传入时替代心跳时刻（确定性测试/离线推演用）；无进行中 job 恒为 false。
   *
   * ⚠️ 已知边界（本计划不覆盖，勿误当 bug）：本进程 owner 存活时**永不**判卡死，因此 runIndex
   * 自身挂死（网络盘 scanFolder 卡住、embed 永不返回）会把该库锁到进程重启——兜底轮询不会回收，
   * 重索引也会因 job 行仍存在而被重入防护一直挡回。后续以软看门狗（心跳超时后主动 abort 该轮）或
   * 强制重置 job 入口解决，不在「卡死判定」里加阈值（那会退回误杀活任务的老坑）。
   */
  isJobStuck(kbId: string, at?: number): boolean {
    const job = this.getJob(kbId);
    if (!job) return false;
    if (job.owner !== null && liveOwners.has(job.owner)) return false;
    return Date.now() - (at ?? job.heartbeatAt) > JOB_STUCK_MS;
  }
}
