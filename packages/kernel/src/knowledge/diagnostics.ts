// 单库诊断：索引与磁盘的偏差（stale / orphan / coverage / 卡死）。
// 只读：扫当前源目录 + 读每库 chunks，不写任何东西；供 /api/knowledge/:id/health 与医生报告使用。
import { statSync } from "node:fs";
import { join } from "node:path";
import type { KbInfo } from "@wa-pi/shared";
import { scanFolder } from "./scan";
import { openKbDbExisting } from "./kb-db";
import type { KbContext } from "./index";

export interface KbDiagnostic {
	kbId: string;
	kbName: string;
	status: KbInfo["status"];
	stuck_indexing: boolean;
	last_progress_age_ms: number;
	/** 索引后被修改过的源文件（相对路径） */
	stale_files: string[];
	/** 库里仍有块、但源文件已不存在（相对路径） */
	orphan_files: string[];
	coverage_percent: number;
	total_source_files: number;
	indexed_files: number;
	/** 扫描阶段的跳过统计（原因 → 数量） */
	skipped: Record<string, number>;
}

/**
 * 诊断一个库：当前可索引清单 vs 每库 chunks 的路径与最后更新时间。
 * 目录不存在/扫描失败/库打不开时返回已获得的部分（不抛），避免诊断本身把接口打挂。
 */
export async function diagnoseKb(ctx: KbContext, kbId: string): Promise<KbDiagnostic> {
	const kb = ctx.store.getKb(kbId);
	const base: KbDiagnostic = {
		kbId,
		kbName: kb?.name ?? kbId,
		status: kb?.status ?? "error",
		stuck_indexing: false,
		last_progress_age_ms: 0,
		stale_files: [],
		orphan_files: [],
		coverage_percent: 100,
		total_source_files: 0,
		indexed_files: kb?.fileCount ?? 0,
		skipped: {},
	};
	if (!kb) return base;

	// 卡死判定：job 存在时按 owner 存活 + 心跳阈值给结论（与 watcher 兜底同一套语义）
	const job = ctx.store.getJob(kbId);
	if (job) {
		base.last_progress_age_ms = Date.now() - job.lastProgressAt;
		base.stuck_indexing = ctx.store.isJobStuck(kbId);
	}

	// 当前可索引清单（扫描失败则跳过 stale/orphan 判定，只给基础信息）
	const current = new Map<string, number>();
	try {
		const preview = await scanFolder(kb.folderPath);
		for (const f of preview.indexable) current.set(f.relPath, f.mtime);
		for (const s of preview.skips) base.skipped[s.reason] = (base.skipped[s.reason] ?? 0) + 1;
	} catch {
		return base;
	}
	base.total_source_files = current.size;

	// 每库 chunks：路径 → 该文件块的最后更新时间
	const indexed = new Map<string, number>();
	try {
		const db = openKbDbExisting(ctx.waPiDir, kbId);
		const rows = db
			.query(`SELECT file_path, MAX(updated_at) AS updated FROM chunks GROUP BY file_path`)
			.all() as Array<{ file_path: string; updated: number }>;
		for (const r of rows) indexed.set(r.file_path, r.updated);
	} catch {
		return base;
	}

	// orphan：块在、源文件没了
	for (const filePath of indexed.keys()) {
		if (!current.has(filePath)) base.orphan_files.push(filePath);
	}
	// stale：源文件 mtime 晚于该文件块的最后更新（只判两边都有的文件）
	for (const [relPath] of current) {
		const updated = indexed.get(relPath);
		if (updated === undefined) continue;
		try {
			const statMtime = statSync(join(kb.folderPath, relPath)).mtimeMs;
			if (statMtime > updated) base.stale_files.push(relPath);
		} catch {
			/* 文件暂不可读：跳过 */
		}
	}
	base.coverage_percent =
		base.total_source_files > 0
			? Math.round((base.indexed_files / base.total_source_files) * 100)
			: 100;
	return base;
}
