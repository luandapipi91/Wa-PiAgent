// vanilla SQLite dylib 的解析与切换（macOS 扩展加载前提）。
//
// 背景：bun:sqlite 在 macOS 用 Apple 专有 SQLite 构建，不支持动态扩展加载
// （sqlite-vector 语义检索的硬前提）。Bun 官方解法：在任何 Database 实例创建前
// 调用 Database.setCustomSQLite(path) 切换到标准构建的 libsqlite3.dylib。
// Windows/Linux 的 bun 构建原生支持扩展加载，setCustomSQLite 在那些平台是 no-op。
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 候选路径：WA_PI_SQLITE_DYLIB 显式指定优先，编译脚本产物（assets/sqlite）兜底 */
export function buildDylibCandidates(): string[] {
	const candidates: string[] = [];
	const fromEnv = process.env.WA_PI_SQLITE_DYLIB;
	if (fromEnv) candidates.push(fromEnv);
	candidates.push(join(import.meta.dir, "..", "..", "assets", "sqlite", "libsqlite3.dylib"));
	return candidates;
}

/** 返回首个实际存在的路径；都不存在返回 null（纯文件系统检查，便于测试） */
export function resolveFromCandidates(candidates: string[]): string | null {
	for (const p of candidates) if (existsSync(p)) return p;
	return null;
}

export function resolveSqliteDylibPath(): string | null {
	return resolveFromCandidates(buildDylibCandidates());
}

/**
 * 切换 vanilla SQLite（macOS）。必须在进程内首个 Database 实例创建前调用，
 * 幂等。失败（无 dylib / 非 macOS）返回 false——调用方照旧用 bun 内嵌构建，
 * 语义通道按既有路径降级，词法检索不受影响。
 *
 * bun 实测限制：同进程内第二次调 setCustomSQLite（即使同路径）会被拒——
 * 而 bun test 同进程多文件时模块注册表按文件隔离，db.ts 顶层调用会被多次
 * evaluate。因此成功状态挂在 globalThis 上：首次成功后全进程直接复用，
 * 后续模块实例不再重碰该 API。
 */
const STATE_KEY = "__wa_pi_custom_sqlite";

/**
 * 探针：临时内存库能否真的加载 sqlite-vector——这是「切换已生效」的直接证据。
 * 用于裁定 setCustomSQLite 被拒时的真伪：同 worker 二调被拒可能是「早已生效」
 * （bun 拒绝重复切换）而非「环境不行」。
 */
function probeVectorExtensionWorks(): boolean {
	try {
		const { getExtensionPath } = require("@sqliteai/sqlite-vector");
		const db = new Database(":memory:");
		try {
			db.loadExtension(getExtensionPath());
			db.query("select vector_version() v").get();
			return true;
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

export function ensureCustomSqlite(): boolean {
	const state = (globalThis as any)[STATE_KEY] as boolean | undefined;
	if (state === true) return true;
	if (process.platform !== "darwin") {
		(globalThis as any)[STATE_KEY] = false;
		return false;
	}
	const dylib = resolveSqliteDylibPath();
	let ok = false;
	if (dylib) {
		try {
			ok = Database.setCustomSQLite(dylib);
		} catch {
			ok = false;
		}
		if (!ok) {
			// 二调被拒 ≠ 环境不行：同 worker 内首次切换早已生效时，bun 会抛
			// 「SQLite already loaded」。切换一旦成功进程内不可逆，以探针为准。
			ok = probeVectorExtensionWorks();
		}
	}
	(globalThis as any)[STATE_KEY] = ok;
	return ok;
}
