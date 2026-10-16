import { useEffect, useState, type ReactNode } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useToastStore } from "../../store/toast";
import { formatApiError, formatRecordError } from "../../util/kernel-error";
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
import { recordShowsDuration, recordVisual } from "./record-visual";

/**
 * 任务详情视图：四宫格信息（计划/角色/联系人/目录）+ 任务指令高亮 + 最近执行记录。
 * 选中任务变化时拉取该任务的执行记录。
 */
export function TaskDetailView() {
	const {
		tasks,
		selectedTaskId,
		recentRecords,
		recentRecordsTaskId,
		latestByTask,
		loadRecentRecords,
		startEdit,
		runTaskNow,
		cancelTaskRun,
		openRecordDetail,
	} = useSchedulerStore();
	const { contacts } = useContactsStore();
	const task = tasks.find((t) => t.id === selectedTaskId);
	// 点击到响应之间（running 记录未回来）的本地抑制：防抖双击触发第二次执行（服务端会 409）
	const [runPending, setRunPending] = useState(false);

	useEffect(() => {
		if (selectedTaskId) loadRecentRecords(selectedTaskId);
	}, [selectedTaskId, loadRecentRecords]);

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
	// 仅展示与当前选中任务一致的尾读结果（防切换任务时的旧请求竞态回写）
	const shownRecords =
		recentRecordsTaskId === task.id ? recentRecords : [];
	// 工作目录展示：未绑定或绑定默认工作区（__system__）都显示「默认工作区」
	// （产品概念中工作区只有默认工作区与项目，不存在「默认」）
	const projectLabel =
		!task.projectId || task.projectId === SYSTEM_PROJECT_ID
			? "默认工作区"
			: task.projectId;

	// 当前是否有在飞执行（服务端状态点数据源 ?latest=1）：执行中禁止再点「立即执行」
	const running = latestByTask[task.id]?.status === "running";

	// 立即执行：kernel 先落盘 running 记录再返 200 → store 刷完「最近执行」即时可见；
	// 已在执行中时 kernel 返 409（scheduler.taskAlreadyRunning），按字典文案提示
	const runNow = async () => {
		setRunPending(true);
		try {
			await runTaskNow(task.id);
			useToastStore.getState().add("已触发执行", "success");
		} catch (e) {
			// 错误按 code 字典渲染；无结构化信息时保留原兜底文案
			useToastStore
				.getState()
				.add(
					formatApiError(e) === (e as Error)?.message
						? "触发执行失败，请稍后重试"
						: formatApiError(e),
					"error",
				);
		} finally {
			setRunPending(false);
		}
	};

	// 取消执行：中止本次运行的 agent 会话，记录收敛为「已取消」终态（SSE 回推刷新）
	const cancelRun = async () => {
		try {
			const res = await cancelTaskRun(task.id);
			useToastStore
				.getState()
				.add(
					res.cancelled
						? "已取消执行"
						: res.reconciled > 0
							? "任务未在执行中，已清理卡住的状态"
							: "任务未在执行中",
					"success",
				);
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	return (
		<div data-testid="task-detail-view">
			{/* 操作按钮 */}
			<div className="flex justify-end gap-2 mb-4">
				{/* 执行中不做前端硬禁用：服务端才是闸门（在飞 → 409；进程被杀留下的悬空
				    「执行中」→ 先对账收尾再执行），前端误判卡死时按钮仍可用作自愈入口 */}
				{running && (
					<span
						data-testid="task-running-chip"
						className="text-[10px] px-2 py-1 rounded self-center"
						style={{ background: "rgba(59,130,246,0.1)", color: "#60a5fa" }}
					>
						⟳ 执行中
					</span>
				)}
				<button
					onClick={() => void runNow()}
					disabled={runPending}
					data-testid="task-run-now-btn"
					className="text-[10px] px-2 py-1 rounded border"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
						cursor: runPending ? "not-allowed" : "pointer",
						opacity: runPending ? 0.5 : 1,
					}}
				>
					▶ 立即执行
				</button>
				{running && (
					<button
						onClick={() => void cancelRun()}
						data-testid="task-cancel-run-btn"
						className="text-[10px] px-2 py-1 rounded cursor-pointer border"
						style={{
							background: "rgba(239,68,68,0.08)",
							borderColor: "rgba(239,68,68,0.4)",
							color: "#f87171",
						}}
					>
						■ 取消执行
					</button>
				)}
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
			{shownRecords.length > 0 && (
				<div>
					<div
						className="text-[11px] mb-2"
						style={{ color: "var(--text-secondary)" }}
					>
						最近执行
					</div>
					{shownRecords.map((r) => (
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
	// 已取消（errorCode=scheduler.taskCancelled）走灰色 ⊘，与真正的失败区分
	const { icon, color } = recordVisual(record);
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
					{record.durationMs != null &&
						recordShowsDuration(record) && (
							<span>耗时 {(record.durationMs / 1000).toFixed(0)}s</span>
						)}
					{record.pushResults?.some((p) => p.success) && (
						<span style={{ color: "#4ade80" }}>已推送</span>
					)}
					{record.error && (
						<span style={{ color: "#f87171" }}>{formatRecordError(record)}</span>
					)}
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
