import { useEffect, type ReactNode } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import type { ScheduledTask, ExecutionRecord } from "@wa-pi/shared";
import { parseChannelMentions } from "../../utils/channel-mentions";

/**
 * 任务详情视图：四宫格信息（计划/角色/渠道/目录）+ 任务指令高亮 + 最近执行记录。
 * 选中任务变化时拉取该任务的执行记录。
 */
export function TaskDetailView() {
	const { tasks, selectedTaskId, records, loadRecords, startEdit, runTaskNow } =
		useSchedulerStore();
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

	const channelIds = parseChannelMentions(task.prompt);
	const recentRecords = records
		.filter((r) => r.taskId === task.id)
		.slice(0, 3);

	return (
		<div data-testid="task-detail-view">
			{/* 操作按钮 */}
			<div className="flex justify-end gap-2 mb-4">
				<button
					onClick={() => runTaskNow(task.id)}
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
				<InfoCard
					label="计划时间"
					value={`🕐 ${formatSchedule(task.schedule)}`}
				/>
				<InfoCard label="执行角色" value={`🤖 ${task.agentId}`} />
				<InfoCard
					label="推送渠道"
					value={
						channelIds.length > 0
							? `📨 ${channelIds.join(", ")}`
							: "无"
					}
				/>
				<InfoCard
					label="工作目录"
					value={`📂 ${task.projectId ?? "默认"}`}
				/>
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
					{renderPrompt(task.prompt)}
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
						<RecordRow key={r.id} record={r} />
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

function RecordRow({ record }: { record: ExecutionRecord }) {
	const icon =
		record.status === "success"
			? "✓"
			: record.status === "failed"
				? "✕"
				: "⟳";
	const color =
		record.status === "success"
			? "#4ade80"
			: record.status === "failed"
				? "#f87171"
				: "#60a5fa";
	return (
		<div
			className="flex gap-2.5 p-2.5 rounded-md mb-1.5"
			style={{ background: "var(--surface-hover)" }}
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
						<span style={{ color: "#4ade80" }}>📨 已推送</span>
					)}
					{record.error && (
						<span style={{ color: "#f87171" }}>{record.error}</span>
					)}
				</div>
			</div>
		</div>
	);
}

// 渲染 prompt 时高亮 $/skill 为紫色标签，@bot_xxx 为绿色标签
function renderPrompt(prompt: string): ReactNode {
	const parts = prompt.split(/(\$\/[a-zA-Z0-9_-]+|@bot_[a-zA-Z0-9_-]+)/g);
	return parts.map((part, i) => {
		if (part.startsWith("$/")) {
			return (
				<span
					key={i}
					className="px-1 rounded text-[10px]"
					style={{ background: "rgba(168,85,247,0.12)", color: "#c084fc" }}
				>
					{part}
				</span>
			);
		}
		if (part.startsWith("@bot_")) {
			return (
				<span
					key={i}
					className="px-1 rounded text-[10px]"
					style={{ background: "rgba(34,197,94,0.12)", color: "#4ade80" }}
				>
					{part}
				</span>
			);
		}
		return <span key={i}>{part}</span>;
	});
}

function formatSchedule(schedule: ScheduledTask["schedule"]): string {
	const time = schedule.time;
	switch (schedule.type) {
		case "daily":
			return `每天 ${time}`;
		case "weekdays":
			return `工作日 ${time}`;
		case "weekly":
			return `每周${
				["日", "一", "二", "三", "四", "五", "六"][schedule.dayOfWeek ?? 1]
			} ${time}`;
		case "monthly":
			return `每月${schedule.dayOfMonth}日 ${time}`;
		case "custom":
			return schedule.cronExpression ?? "自定义";
	}
}
