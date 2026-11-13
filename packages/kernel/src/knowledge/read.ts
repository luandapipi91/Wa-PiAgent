// knowledge_read：按 file_path / chunk_id 从库 DB 取回**已抽取的文本**。
// 存在的意义：检索命中的是相对路径，而 docx/pdf 是二进制——模型拿到路径后若自己 read 只能失败，
// 于是再去找文件、再写脚本抽取。这里直接返回索引时抽好的正文（同一份 chunks.content），
// 模型一次调用就能读到内容，不需要碰磁盘。
//
// markdown 副本（任务 9）：有副本的文件改读副本 md 全文（markdown 完整可读，比按块拼接的抽取
// 正文保留更多结构）；无副本（降级抽取/纯文本）维持 chunks.content 路径。
//
// 数据源：每库独立 DB 的 chunks 表（file_path / start_line / end_line / content）+ mirror 目录副本。
// 库选择：opts.kbId 指定时只查该库（且必须在绑定清单内）；否则按 kbIds 顺序找第一个命中的库。
// 路径：既接受相对库根的路径（= chunks.file_path）、绝对路径（按库根前缀换算），
// 还接受检索 hit 出参的两种回传形态：副本相对路径（源 rel + ".md"）与副本绝对路径
// （filePathAbs，mirror 目录下，换算回源 rel）。
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { mirrorDirFor, mirrorMdPath, readMirrorMd } from "./mirror";
import type { KbContext } from "./index";
import { openKbDbExisting } from "./kb-db";

export interface ReadOptions {
	/** 相对库根的路径（与检索结果的 sourcePath 一致），或检索 hit 的副本路径（源 rel + ".md"），或绝对路径 */
	filePath?: string;
	/** 已知块 id（检索结果的 chunk_id）：取该块 ± before/after 块 */
	chunkId?: string;
	/** 限定单个库（必须是绑定清单里的 id） */
	kbId?: string;
	/** chunkId 模式下向前带几块（默认 1） */
	before?: number;
	/** chunkId 模式下向后带几块（默认 1） */
	after?: number;
	/** 返回正文的字符上限（默认 20000） */
	maxChars?: number;
}

/** 读取失败原因：文件/块不存在或目标库不在绑定清单里 */
export type ReadFailureReason = "file_not_found" | "chunk_not_found" | "kb_not_bound";

export interface ReadResult {
	found: boolean;
	/** 失败原因（found=false 时给） */
	reason?: ReadFailureReason;
	kbId?: string;
	kbName?: string;
	/** 相对库根的路径（有副本时为源相对路径，与检索结果 sourcePath 一致） */
	filePath?: string;
	/** 绝对路径：有 markdown 副本时指向副本 md（模型可直接 read）；无副本时为源绝对路径
	 *  （= 库根 + 相对路径）。模型可直接交给 read/编辑器 */
	filePathAbs?: string;
	content?: string;
	startLine?: number | null;
	endLine?: number | null;
	/** 本次返回包含的块数 */
	chunkCount?: number;
	/** 是否因 maxChars 被截断 */
	truncated?: boolean;
}

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_BEFORE = 1;
const DEFAULT_AFTER = 1;

interface ChunkRow {
	id: string;
	file_path: string;
	start_line: number | null;
	end_line: number | null;
	content: string;
}

/** 绝对路径 → 库根内相对路径；不在库根下返回 null */
function toRelative(kbRoot: string, filePath: string): string | null {
	if (!isAbsolute(filePath)) return normalize(filePath);
	const root = normalize(kbRoot);
	const abs = normalize(filePath);
	if (!abs.startsWith(root + "/") && abs !== root) return null;
	return abs.slice(root.length + 1);
}

/**
 * 读取知识库文本。两个入口二选一：
 * - `filePath`：该文件的全部块（按 start_line 升序拼接），适合「读完整篇文档」
 * - `chunkId`：该块 ± before/after 块，适合「命中一处，看看上下文」
 * 超出 maxChars 时按块累加截断（不切半句），并置 truncated。
 */
export async function readKnowledge(
	ctx: KbContext,
	kbIds: string[],
	opts: ReadOptions,
): Promise<ReadResult> {
	if (!opts.filePath && !opts.chunkId) {
		return { found: false, reason: "file_not_found" };
	}
	const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS;
	const before = Math.max(0, opts.before ?? DEFAULT_BEFORE);
	const after = Math.max(0, opts.after ?? DEFAULT_AFTER);
	const targets = opts.kbId ? kbIds.filter((id) => id === opts.kbId) : kbIds;
	if (targets.length === 0) return { found: false, reason: "kb_not_bound" };


	for (const id of targets) {
		const kb = ctx.store.getKb(id);
		if (!kb) continue;
		let db;
		try {
			db = openKbDbExisting(ctx.waPiDir, id);
		} catch {
			continue; // 库文件缺失/损坏：跳过该库，找下一个
		}
		const mirrorDir = mirrorDirFor(ctx.waPiDir, id);

		// chunkId 模式：仍读 chunks（±N 块的行窗上下文按块切，副本全文替代不了）；
		// 库里有该文件的 markdown 副本时 filePathAbs 指向副本，模型想读全文可顺着它读
		if (opts.chunkId) {
			const rows = selectByChunkId(db, opts.chunkId, before, after);
			// chunkId 给了但该库没有这个块：继续找别的库
			if (rows === null || rows.length === 0) continue;
			const { content, truncated } = joinChunks(rows, maxChars);
			const srcRel = rows[0].file_path;
			const mirrorAbs = mirrorMdPath(mirrorDir, srcRel);
			return {
				found: true,
				kbId: id,
				kbName: kb.name,
				filePath: srcRel,
				filePathAbs: existsSync(mirrorAbs) ? mirrorAbs : join(kb.folderPath, srcRel),
				content,
				startLine: rows[0].start_line,
				endLine: rows[rows.length - 1].end_line,
				chunkCount: rows.length,
				truncated,
			};
		}

		// filePath 模式：入参三种形态都接受——源相对路径（chunks.file_path）、检索 hit 的
		// 副本相对路径（源 rel + ".md"，去 .md 后定位同一文件）、检索 hit 的 filePathAbs
		// （mirror 目录下的绝对路径：KB_READ_PARAMS_SCHEMA 承诺 file_path 接受绝对路径，
		// bridge 错误文案亦引导此用法；不在库根内，需换算回源 rel）。
		// 逐候选「先副本后 chunks」：
		//   副本存在 → 读副本全文返回（filePathAbs 指副本）；
		//   无副本（降级抽取/纯文本） → 维持既有 chunks.content 路径（filePathAbs 源绝对路径）。
		const rawPath = opts.filePath!;
		const rawNorm = normalize(rawPath);
		let rel = toRelative(kb.folderPath, rawPath) ?? rawPath;
		// mirror 副本绝对路径回传：取 mirrorRoot 下相对路径并去掉副本 .md 后缀 → 源 rel；
		// mirror 外的绝对路径维持既有源绝对路径换算（toRelative 不匹配则保留原样）
		const mirrorRoot = normalize(mirrorDir);
		if (isAbsolute(rawPath) && rawNorm.startsWith(mirrorRoot + sep)) {
			rel = rawNorm.slice(mirrorRoot.length + 1).replace(/\.md$/, "");
		}
		const candidates = rel.endsWith(".md") ? [rel, rel.slice(0, -".md".length)] : [rel];
		for (const srcRel of candidates) {
			const mirrorContent = readMirrorMd(mirrorDir, srcRel);
			if (mirrorContent !== null) {
				return {
					found: true,
					kbId: id,
					kbName: kb.name,
					filePath: srcRel,
					filePathAbs: mirrorMdPath(mirrorDir, srcRel),
					content: mirrorContent.slice(0, maxChars),
					startLine: 1,
					endLine: null,
					chunkCount: 1,
					truncated: mirrorContent.length > maxChars,
				};
			}
			const rows = selectByFilePath(db, srcRel, kb.folderPath);
			if (rows.length === 0) continue;
			const { content, truncated } = joinChunks(rows, maxChars);
			return {
				found: true,
				kbId: id,
				kbName: kb.name,
				filePath: srcRel,
				filePathAbs: join(kb.folderPath, srcRel),
				content,
				startLine: rows[0].start_line,
				endLine: rows[rows.length - 1].end_line,
				chunkCount: rows.length,
				truncated,
			};
		}
	}
	return { found: false, reason: opts.chunkId ? "chunk_not_found" : "file_not_found" };
}

/** 按块 id 取该块 ± before/after 块（同文件按 start_line 排序） */
function selectByChunkId(
	db: ReturnType<typeof openKbDbExisting>,
	chunkId: string,
	before: number,
	after: number,
): ChunkRow[] | null {
	const hit = db
		.query("SELECT id, file_path, start_line, end_line, content FROM chunks WHERE id = ?")
		.get(chunkId) as ChunkRow | null;
	if (!hit) return null;
	const rows = db
		.query(
			`SELECT id, file_path, start_line, end_line, content FROM chunks
			  WHERE file_path = ? ORDER BY start_line`,
		)
		.all(hit.file_path) as ChunkRow[];
	const idx = rows.findIndex((r) => r.id === hit.id);
	if (idx < 0) return [hit];
	const from = Math.max(0, idx - before);
	const to = Math.min(rows.length, idx + after + 1);
	return rows.slice(from, to);
}

/** 按文件路径取全部块；绝对路径先换算成库根相对路径 */
function selectByFilePath(
	db: ReturnType<typeof openKbDbExisting>,
	filePath: string,
	kbRoot: string,
): ChunkRow[] {
	const rel = toRelative(kbRoot, filePath) ?? filePath;
	return db
		.query(
			`SELECT id, file_path, start_line, end_line, content FROM chunks
			  WHERE file_path = ? ORDER BY start_line`,
		)
		.all(rel) as ChunkRow[];
}

/** 按块拼正文：块间空行分隔，超预算按整块截断（不切半句） */
function joinChunks(rows: ChunkRow[], maxChars: number): { content: string; truncated: boolean } {
	const parts: string[] = [];
	let total = 0;
	for (const row of rows) {
		const sep = parts.length > 0 ? 2 : 0; // "\n\n"
		if (total + sep + row.content.length > maxChars) {
			const room = maxChars - total - sep;
			if (room > 0) parts.push(row.content.slice(0, room));
			return { content: parts.join("\n\n"), truncated: true };
		}
		parts.push(row.content);
		total += sep + row.content.length;
	}
	return { content: parts.join("\n\n"), truncated: false };
}
