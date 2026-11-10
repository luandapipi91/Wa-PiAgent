// 知识库医生：把单库诊断汇总成健康分 + 问题清单（100 分制扣分取自 pi-knowledge engine#doctor）。
import type { KbContext } from "./index";
import { diagnoseKb, type KbDiagnostic } from "./diagnostics";
import { knowledgeFingerprint } from "./fingerprint";

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
	}

	const blocking = issues.filter((i) => i.severity === "blocking").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const summary =
		issues.length === 0
			? "知识库状态健康"
			: `${blocking} 个阻塞问题、${warnings} 个警告、${issues.length - blocking - warnings} 条提示`;
	return { health_score: scoreFromIssues(issues), summary, issues, diagnostics };
}
