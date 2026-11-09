// 知识库登记层：库 CRUD、状态、索引任务进度的唯一读写入口。
// 登记行在 <WA_PI_DIR>/knowledge.db（由调用方建库后注入），每库块数据在
// 独立 db 文件（kb-db.ts），本层只在 deleteKb 时负责删掉该文件。
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { KbInfo } from "@wa-pi/shared";
import { kbDbPath } from "./paths";

type KbPhase = NonNullable<KbInfo["progress"]>["phase"];
type KbStatus = KbInfo["status"];

/** 卡死阈值：job 超过 10 分钟无进度更新视为卡死（watcher 兜底重索引用） */
export const JOB_STUCK_MS = 10 * 60_000;

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
  /** 跳过原因 → 数量（skip_stats JSON 解析结果） */
  skipStats: Record<string, number> | null;
  lastProgressAt: number;
  createdAt: number;
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
  created_at: number;
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
    progress: job
      ? {
          phase: job.phase,
          filesTotal: job.filesTotal ?? 0,
          filesDone: job.filesDone ?? 0,
          chunksDone: job.chunksDone ?? 0,
        }
      : undefined,
  };
}

export class KnowledgeStore {
  constructor(
    private readonly db: Database,
    private readonly waPiDir: string,
  ) {}

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

  /** 级联清理：删 job 行 + 登记行 + 每库 db 文件（含 WAL/SHM 伴生文件） */
  deleteKb(id: string): void {
    // bun:sqlite 默认 foreign_keys=OFF，ON DELETE CASCADE 不生效，必须显式删
    this.db.run(`DELETE FROM indexing_jobs WHERE kb_id = ?`, [id]);
    this.db.run(`DELETE FROM knowledge_bases WHERE id = ?`, [id]);
    const p = kbDbPath(this.waPiDir, id);
    for (const f of [p, `${p}-wal`, `${p}-shm`]) {
      try {
        unlinkSync(f);
      } catch {
        // 文件不存在即目标状态，跳过
      }
    }
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

  /** 库级模型指纹（embed_meta）；从未索引过为 null。不进 KbInfo 投影——索引器增量判定专用 */
  getEmbedMeta(id: string): string | null {
    const row = this.db.query(`SELECT embed_meta FROM knowledge_bases WHERE id = ?`).get(id) as
      | { embed_meta: string | null }
      | null;
    return row?.embed_meta ?? null;
  }

  /** 开始一轮索引任务（同库同时只允许一个活动 job——kb_id 是主键）；已有活动 job 时拒绝，不静默覆盖 */
  startJob(kbId: string, phase: KbPhase): void {
    if (this.getJob(kbId)) {
      throw new Error(`知识库 ${kbId} 已有进行中的索引任务，拒绝重复启动`);
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO indexing_jobs (kb_id, phase, last_progress_at, created_at)
       VALUES (?, ?, ?, ?)`,
      [kbId, phase, now, now],
    );
  }

  /** 部分更新 job 进度；每次调用都刷新 last_progress_at（卡死判定依据） */
  updateJobProgress(
    kbId: string,
    patch: Partial<{ phase: KbPhase; filesTotal: number; filesDone: number; chunksDone: number; skipStats: Record<string, number> }>,
  ): void {
    const sets = ["last_progress_at = ?"];
    const args: (string | number)[] = [Date.now()];
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
    if (patch.skipStats !== undefined) {
      sets.push("skip_stats = ?");
      args.push(JSON.stringify(patch.skipStats));
    }
    args.push(kbId);
    this.db.run(`UPDATE indexing_jobs SET ${sets.join(", ")} WHERE kb_id = ?`, args);
  }

  /** 任务收尾：删 job 行（KbInfo.progress 随之清除） */
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
          skip_stats: string | null;
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
      skipStats: row.skip_stats ? (JSON.parse(row.skip_stats) as Record<string, number>) : null,
      lastProgressAt: row.last_progress_at,
      createdAt: row.created_at,
    };
  }

  /**
   * 卡死判定：时刻 at 距当前时间超过 JOB_STUCK_MS 即卡死；无进行中 job 恒为 false。
   * at 缺省取该库 job 的 last_progress_at（watcher 兜底判「10 分钟无进度」的常规用法）；
   * 显式传 at 用于确定性测试/离线推演（以过去时刻询问「此刻算卡死吗」）。
   */
  isJobStuck(kbId: string, at?: number): boolean {
    const job = this.getJob(kbId);
    if (!job) return false;
    return Date.now() - (at ?? job.lastProgressAt) > JOB_STUCK_MS;
  }
}
