// 知识库医生：把单库诊断汇总成健康分 + 问题清单（100 分制扣分取自 pi-knowledge engine#doctor）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { KbContext } from "./index";
import { diagnoseKb, type KbDiagnostic } from "./diagnostics";
import { knowledgeFingerprint } from "./fingerprint";
import { mirrorDirFor, mirrorMdPath } from "./mirror";
import { openKbDbExisting } from "./kb-db";

export type DoctorSeverity = "blocking" | "warning" | "info";

export interface DoctorIssue {
	severity: DoctorSeverity;
	kbName?: string;
	message: string;
	action: string;
}

export interface DoctorReport {
	health_score: number;
	summary: string;
	issues: DoctorIssue[];
	diagnostics: KbDiagnostic[];
}

/** 扣分规则：blocking 35 / warning 12 / info 2，钳到 0~100 */
export function scoreFromIssues(issues: Array<{ severity: DoctorSeverity }>): number {
	let penalty = 0;
	for (const issue of issues) {
		penalty += issue.severity === "blocking" ? 35 : issue.severity === "warning" ? 12 : 2;
	}
	return Math.max(0, Math.min(100, 100 - penalty));
}

// ===== mirror 副本完整性检查（任务 10）=====
// 副本类问题（降级/残留/孤儿 assets/引用断链）都可自愈或无害，一律 info 级，报告列清单即可。

/** doctor 清单截断上限：报告是给人看的，超长只留前几条 */
const MIRROR_LIST_MAX = 5;
/** 断链样例上限（全量计数在 refBroken，样例只留前几条） */
const MIRROR_BROKEN_MAX = 3;

/** md 文本内的 markdown 引用（图片/链接）目标：取括号内首个 token */
const MD_REF_RE = /\]\(\s*<?([^)\s>]+)/g;

function formatList(items: string[]): string {
	const head = items.slice(0, MIRROR_LIST_MAX).join(", ");
	return items.length > MIRROR_LIST_MAX ? `${head} 等 ${items.length} 项` : head;
}

/** 单库镜像扫描结果（null = 索引库打不开，诊断层已报 diagnosis_error，这里静默跳过） */
interface MirrorScan {
	/** 索引有块、副本 md 缺失（转换降级） */
	degraded: string[];
	/** 副本 md 存在、索引无该文件（残留副本） */
	residual: string[];
	/** _assets 下无对应 md 的一级子项 */
	orphanAssets: string[];
	/** 指向 _assets 的相对引用总数 */
	refTotal: number;
	/** 断链引用总数 */
	refBroken: number;
	/** 断链样例（"<md 相对路径> → <引用>"） */
	brokenSamples: string[];
}

/**
 * 递归收集 assetsRoot 下「直接含文件」的目录（相对 assetsRoot 的 POSIX 路径）。
 * _assets/<srcRel> 落盘保留子目录层级，孤儿判定必须取完整 srcRel 口径与 mdRelSet 比对
 * （一级条目会把 sub/with-img.docx 误报成 _assets/sub 孤儿）。
 */
function assetDirs(assetsRoot: string, prefix = ""): string[] {
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(join(assetsRoot, prefix), { withFileTypes: true });
	} catch {
		return out; // 无 _assets 目录或中途不可读：跳过
	}
	let hasFile = false;
	for (const e of entries) {
		if (e.isFile()) {
			hasFile = true;
		} else if (e.isDirectory()) {
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			out.push(...assetDirs(assetsRoot, rel));
		}
	}
	return hasFile && prefix ? [...out, prefix] : out;
}

/** 扫描单库 mirror 副本与索引的对齐情况（全量遍历，与诊断层逐文件 statSync 同风格） */
function scanKbMirror(waPiDir: string, folderPath: string, kbId: string): MirrorScan | null {
	// 索引文件清单：chunks 去重 file_path；库打不开时静默跳过
	let indexed: string[];
	try {
		const db = openKbDbExisting(waPiDir, kbId);
		const rows = db.query("SELECT DISTINCT file_path FROM chunks").all() as Array<{
			file_path: string;
		}>;
		indexed = rows.map((r) => r.file_path);
	} catch {
		return null;
	}
	const indexedSet = new Set(indexed);
	const mirrorDir = mirrorDirFor(folderPath);
	const assetsRoot = join(mirrorDir, "_assets");
	const scan: MirrorScan = {
		degraded: [],
		residual: [],
		orphanAssets: [],
		refTotal: 0,
		refBroken: 0,
		brokenSamples: [],
	};

	// 降级：索引有块、副本缺失
	for (const rel of indexed) {
		if (!existsSync(mirrorMdPath(mirrorDir, rel))) scan.degraded.push(rel);
	}

	// mirror 目录未建（全库降级等）：副本全缺已由 degraded 覆盖，其余检查无事可做。
	// _assets 排除按首段路径段判断：!p.startsWith("_assets") 会误伤 _assets_backup 等相邻目录名
	let mdRels: string[];
	try {
		mdRels = readdirSync(mirrorDir, { recursive: true, encoding: "utf-8" }).filter((p) => {
			const [head] = p.split(/[\\/]/);
			return p.endsWith(".md") && head !== "_assets";
		});
	} catch {
		return scan;
	}
	const mdRelSet = new Set(mdRels.map((p) => p.slice(0, -".md".length)));

	// 残留：副本存在、索引无该文件（清单项用副本实际文件名，即 srcRel + ".md"）
	for (const rel of mdRelSet) {
		if (!indexedSet.has(rel)) scan.residual.push(`${rel}.md`);
	}

	// 孤儿 assets：_assets 下「直接含文件的资产目录」（完整 srcRel 层级）没有对应副本 md
	for (const dir of assetDirs(assetsRoot)) {
		if (!mdRelSet.has(dir)) scan.orphanAssets.push(`_assets/${dir}`);
	}

	// 引用对齐：收集 md 内解析后落在 _assets 下的相对引用（`../`/`./` 相对 md 目录解析），
	// 逐个核对文件存在；只对齐镜像自有资产，passthrough 文档里的普通相对链接不统计（非镜像职责）
	for (const rel of mdRels) {
		const mdAbs = join(mirrorDir, rel);
		let text: string;
		try {
			text = readFileSync(mdAbs, "utf8");
		} catch {
			continue; // 副本读不到（权限/竞态）：不阻塞体检
		}
		for (const m of text.matchAll(MD_REF_RE)) {
			const ref = m[1];
			if (/^(https?:|data:|mailto:|#|\/)/i.test(ref)) continue; // 外链/data URI/锚点/绝对路径
			let target: string;
			try {
				target = resolve(dirname(mdAbs), decodeURI(ref));
			} catch {
				target = resolve(dirname(mdAbs), ref); // 畸形百分号编码原样解析
			}
			if (target !== assetsRoot && !target.startsWith(assetsRoot + sep)) continue;
			scan.refTotal++;
			if (!existsSync(target)) {
				scan.refBroken++;
				if (scan.brokenSamples.length < MIRROR_BROKEN_MAX) {
					scan.brokenSamples.push(`${rel} → ${ref}`);
				}
			}
		}
	}
	return scan;
}

/** 全库体检：逐库诊断 + 汇总问题 */
export async function runDoctor(ctx: KbContext): Promise<DoctorReport> {
	const kbs = ctx.store.listKbs();
	const diagnostics: KbDiagnostic[] = [];
	const issues: DoctorIssue[] = [];

	if (kbs.length === 0) {
		issues.push({
			severity: "blocking",
			message: "尚未登记任何知识库",
			action: "在设置 → 知识库中新建一个库",
		});
	}

	for (const kb of kbs) {
		const d = await diagnoseKb(ctx, kb.id);
		diagnostics.push(d);
		if (d.stuck_indexing) {
			issues.push({
				severity: "blocking",
				kbName: d.kbName,
				message: `索引疑似卡住（最近一次进度在 ${Math.round(d.last_progress_age_ms / 60000)} 分钟前）`,
				action: "确认没有其他进程在索引后，取消并重建该库",
			});
		}
		if (d.status === "error") {
			issues.push({
				severity: "blocking",
				kbName: d.kbName,
				message: "知识库处于失败状态，检索会跳过它",
				action: "查看失败原因并重建该库",
			});
		}
		if (d.diagnosis_error) {
			issues.push({
				severity: "warning",
				kbName: d.kbName,
				message: `诊断未完成：${d.diagnosis_error}`,
				action: "确认源目录可访问后重新诊断",
			});
		}
		if (!d.diagnosis_error && d.coverage_percent < 80) {
			issues.push({
				severity: "warning",
				kbName: d.kbName,
				message: `索引覆盖率 ${d.coverage_percent}%（${d.indexed_files}/${d.total_source_files} 文件）`,
				action: "检查是否被建议排除/超大文件规则挡掉，必要时重建",
			});
		}
		if (d.stale_files.length > 0) {
			issues.push({
				severity: "warning",
				kbName: d.kbName,
				message: `${d.stale_files.length} 个文件在索引后被修改`,
				action: "运行更新或重建索引",
			});
		}
		// 指纹失配（换模型或切块器版本升级）：检索已自动降级，但存量索引需要重建才恢复语义通道
		const storedMeta = ctx.store.getEmbedMeta(kb.id);
		if (storedMeta !== null && storedMeta !== knowledgeFingerprint()) {
			issues.push({
				severity: "warning",
				kbName: d.kbName,
				message: "索引指纹与当前模型/切块版本不一致（语义通道已降级）",
				action: "重建该库以按当前版本重新索引",
			});
		}
		if (d.orphan_files.length > 0) {
			issues.push({
				severity: "warning",
				kbName: d.kbName,
				message: `${d.orphan_files.length} 个已索引文件在源目录中已不存在`,
				action: "运行更新或重建索引以清理悬挂块",
			});
		}
		const skippedTotal = Object.values(d.skipped).reduce((a, b) => a + b, 0);
		if (skippedTotal > 0) {
			issues.push({
				severity: "info",
				kbName: d.kbName,
				message: `扫描跳过 ${skippedTotal} 项（${Object.entries(d.skipped)
					.map(([k, v]) => `${k}: ${v}`)
					.join(", ")}）`,
				action: "确认排除规则符合预期",
			});
		}
		// mirror 副本完整性（任务 10）：四类问题都可自愈或无害，全 info 级，列清单提示
		const scan = scanKbMirror(ctx.waPiDir, kb.folderPath, kb.id);
		if (scan) {
			if (scan.degraded.length > 0) {
				issues.push({
					severity: "info",
					kbName: d.kbName,
					message: `${scan.degraded.length} 个已索引文件没有 mirror 副本（转换降级）: ${formatList(scan.degraded)}`,
					action: "重建该库可为降级文件补齐副本",
				});
			}
			if (scan.residual.length > 0) {
				issues.push({
					severity: "info",
					kbName: d.kbName,
					message: `${scan.residual.length} 个 mirror 副本在索引中无对应文件: ${formatList(scan.residual)}`,
					action: "运行更新或重建索引以清理残留副本",
				});
			}
			if (scan.orphanAssets.length > 0) {
				issues.push({
					severity: "info",
					kbName: d.kbName,
					message: `${scan.orphanAssets.length} 个 _assets 资源目录没有对应副本 md: ${formatList(scan.orphanAssets)}`,
					action: "运行更新或重建索引以清理孤儿资源目录",
				});
			}
			if (scan.refBroken > 0) {
				issues.push({
					severity: "info",
					kbName: d.kbName,
					message: `mirror 副本内引用 ${scan.refTotal} 处、断链 ${scan.refBroken} 处: ${formatList(scan.brokenSamples)}`,
					action: "重建该库以重转副本、补齐引用文件",
				});
			}
		}
	}

	const blocking = issues.filter((i) => i.severity === "blocking").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const summary =
		issues.length === 0
			? "知识库状态健康"
			: `${blocking} 个阻塞问题、${warnings} 个警告、${issues.length - blocking - warnings} 条提示`;
	return { health_score: scoreFromIssues(issues), summary, issues, diagnostics };
}
