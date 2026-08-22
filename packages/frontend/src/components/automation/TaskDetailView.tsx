import { useEffect, type ReactNode } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useToastStore } from "../../store/toast";
import { useContactsStore } from "../../store/contacts";
import {
	SYSTEM_PROJECT_ID,
	type ScheduledTask,
	type ExecutionRecord,
} from "@wa-pi/shared";
import {
	parseImPushTokens,
	toPromptHtml,
	type ContactChipMeta,
} from "./prompt-tokens";

/**
 * 任务详情视图：四宫格信息（计划/角色/联系人/目录）+ 任务指令高亮 + 最近执行记录。
 * 选中任务变化时拉取该任务的执行记录。
 */
export function TaskDetailView() {
	const {
		tasks,
		selectedTaskId,
		records,
		loadRecords,
		startEdit,
		runTaskNow,
		openRecordDetail,
	} = useSchedulerStore();
	const { contacts } = useContactsStore();
	const task = tasks.find((t) => t.id === selectedTaskId);

	useEffect(() => {
		if (selectedTaskId) loadRecords(selectedTaskId);
	}, [selectedTaskId, loadRecords]);

	if (!task) {
		return (
			<div
				className="flex items-center justify-center h-full text-sm"
				style={{ color: "var(--text-tertiary)" }}
			>
				选择一个任务查看详情，或点击「新建」创建
			</div>
		);
	}

	const imTokens = parseImPushTokens(task.prompt);
	// 查通讯录显人名；查无（联系人已删除）灰化显示 id，不报错
	const contactMeta = (ctId: string): ContactChipMeta => {
		const c = contacts.find((x) => x.id === ctId);
		return c
			? { label: c.remark || c.userId || ctId, valid: true }
			: { label: ctId, valid: false };
	};
	const contactLabel = (ctId: string) => contactMeta(ctId).label;
	const recentRecords = records.filter((r) => r.taskId === task.id).slice(0, 3);
	// 工作目录展示：未绑定或绑定默认工作区（__system__）都显示「默认工作区」
	// （产品概念中工作区只有默认工作区与项目，不存在「默认」）
	const projectLabel =
		!task.projectId || task.projectId === SYSTEM_PROJECT_ID
			? "默认工作区"
			: task.projectId;

	return (
		<div data-testid="task-detail-view">
			{/* 操作按钮 */}
			<div className="flex justify-end gap-2 mb-4">
				<button
					onClick={async () => {
						// 触发即返回（执行结果经 scheduled-task:completed SSE 刷新）
						try {
							await runTaskNow(task.id);
							useToastStore.getState().add("已触发执行", "success");
						} catch {
							useToastStore.getState().add("触发执行失败，请稍后重试", "error");
						}
					}}
					className="text-[10px] px-2 py-1 rounded cursor-pointer border"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					▶ 立即执行
				</button>
				<button
					onClick={() => startEdit(task)}
					className="text-[10px] px-2 py-1 rounded cursor-pointer border"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					✏️ 编辑
				</button>
			</div>

			{/* 四宫格信息 */}
			<div className="grid grid-cols-2 gap-3 mb-4">
				<InfoCard label="计划时间" value={`🕐 ${formatSchedule(task.schedule)}`} />
				<InfoCard label="执行角色" value={`🤖 ${task.agentId}`} />
				<InfoCard
					label="推送联系人"
					value={
						imTokens.length > 0
							? `📨 ${imTokens.map((t) => contactLabel(t.contactId)).join("、")}`
							: "无"
					}
				/>
				<InfoCard label="工作目录" value={`📂 ${projectLabel}`} />
			</div>

			{/* 任务指令 */}
			<div
				className="rounded-md p-3 mb-4"
				style={{ background: "var(--surface-hover)" }}
			>
				<div
					className="text-[10px] mb-1.5"
					style={{ color: "var(--text-tertiary)" }}
				>
					任务指令
				</div>
				<div
					className="text-xs leading-relaxed"
					style={{ color: "var(--text-primary)" }}
				>
					{renderPrompt(task.prompt, contactMeta)}
				</div>
			</div>

			{/* 最近执行 */}
			{recentRecords.length > 0 && (
				<div>
					<div
						className="text-[11px] mb-2"
						style={{ color: "var(--text-secondary)" }}
					>
						最近执行
					</div>
					{recentRecords.map((r) => (
						<RecordRow key={r.id} record={r} onOpenDetail={openRecordDetail} />
					))}
				</div>
			)}
		</div>
	);
}

function InfoCard({ label, value }: { label: string; value: string }) {
	return (
		<div
			className="rounded-md p-2.5"
			style={{ background: "var(--surface-hover)" }}
		>
			<div
				className="text-[10px] mb-0.5"
				style={{ color: "var(--text-tertiary)" }}
			>
				{label}
			</div>
			<div className="text-xs" style={{ color: "var(--text-primary)" }}>
				{value}
			</div>
		</div>
	);
}

function RecordRow({
	record,
	onOpenDetail,
}: {
	record: ExecutionRecord;
	onOpenDetail: (recordId: string, from: "records" | "detail") => void;
}) {
	const icon =
		record.status === "success" ? "✓" : record.status === "failed" ? "✕" : "⟳";
	const color =
		record.status === "success"
			? "#4ade80"
			: record.status === "failed"
				? "#f87171"
				: "#60a5fa";
	const open = () => onOpenDetail(record.id, "detail");
	return (
		<div
			className="flex gap-2.5 p-2.5 rounded-md mb-1.5 cursor-pointer"
			style={{ background: "var(--surface-hover)" }}
			onClick={open}
			data-testid={`record-row-${record.id}`}
		>
			<span style={{ color }}>{icon}</span>
			<div className="flex-1">
				<div className="text-xs" style={{ color: "var(--text-primary)" }}>
					{new Date(record.startedAt).toLocaleString("zh-CN")}
				</div>
				<div
					className="text-[10px] flex gap-2"
					style={{ color: "var(--text-tertiary)" }}
				>
					{record.durationMs && (
						<span>耗时 {(record.durationMs / 1000).toFixed(0)}s</span>
					)}
					{record.pushResults?.some((p) => p.success) && (
						<span style={{ color: "#4ade80" }}>已推送</span>
					)}
					{record.error && <span style={{ color: "#f87171" }}>{record.error}</span>}
				</div>
			</div>
			<button
				onClick={(e) => {
					e.stopPropagation();
					open();
				}}
				className="text-[10px] px-2 py-1 rounded border cursor-pointer flex-shrink-0 self-center"
				style={{
					background: "var(--surface)",
					borderColor: "var(--hairline)",
					color: "var(--text-secondary)",
				}}
			>
				详情
			</button>
		</div>
	);
}

// 渲染 prompt：复用 toPromptHtml（技能 chip + 联系人 chip，与输入框一致），
// 转义链完整（escapeHtmlLocal + textToHtml 全量转义）
function renderPrompt(
	prompt: string,
	contactMeta: (contactId: string) => ContactChipMeta,
): ReactNode {
	// pi-lens-ignore: ts-xss-dom-sink
	return (
		<div
			dangerouslySetInnerHTML={{ __html: toPromptHtml(prompt, contactMeta) }}
		/>
	);
}

function formatSchedule(schedule: ScheduledTask["schedule"]): string {
	const time = schedule.time;
	switch (schedule.type) {
		case "minute":
			return "每分钟";
		case "hourly":
			return `每 ${schedule.intervalHours ?? 1} 小时${
				schedule.startTime ? `，从 ${schedule.startTime} 开始` : ""
			}`;
		case "daily":
			return `每天 ${time}`;
		case "weekdays":
			return `工作日 ${time}`;
		case "weekly":
			return `每周${
				["日", "一", "二", "三", "四", "五", "六"][schedule.dayOfWeek ?? 1]
			} ${time}`;
		case "monthly":
			return `每月${schedule.dayOfMonth ?? 1}日 ${time}`;
		case "custom":
			return schedule.cronExpression ?? "自定义";
	}
}
// （AutomationSidebar 的 formatSchedule 同样修正，两处保持一致）
