import { useEffect } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import type { ScheduledTask } from "@wa-pi/shared";

/**
 * 自动化侧边栏：紧凑的任务卡片列表。
 * 在 useEffect 中调用 loadTasks 拉取最新任务；点击卡片选中，点击「+ 新建」进入新建态。
 */
export function AutomationSidebar() {
	const { tasks, selectedTaskId, selectTask, startCreate, loadTasks, setView } =
		useSchedulerStore();

	useEffect(() => {
		void loadTasks();
	}, [loadTasks]);

	return (
		<div className="flex flex-col h-full" data-testid="automation-sidebar">
			{/* 工具栏 */}
			<div className="flex items-center justify-between px-2 py-1.5">
				<span
					className="text-[10px]"
					style={{ color: "var(--text-secondary)" }}
				>
					定时任务 ({tasks.length})
				</span>
				<div className="flex gap-1">
					<button
						onClick={() => setView("records")}
						className="text-[10px] px-2 py-0.5 rounded border-0 cursor-pointer"
						style={{
							background: "var(--surface-hover)",
							color: "var(--text-secondary)",
						}}
						data-testid="automation-records-btn"
					>
						执行记录
					</button>
					<button
						onClick={startCreate}
						className="text-[10px] px-2 py-0.5 rounded border-0 cursor-pointer"
						style={{ background: "var(--accent)", color: "white" }}
						data-testid="automation-new-btn"
					>
						+ 新建
					</button>
				</div>
			</div>

			{/* 任务列表 */}
			<div className="flex-1 overflow-y-auto px-2 space-y-1.5">
				{tasks.map((task) => (
					<TaskCard
						key={task.id}
						task={task}
						selected={task.id === selectedTaskId}
						onClick={() => selectTask(task.id)}
					/>
				))}
				{tasks.length === 0 && (
					<div
						className="text-center py-8 text-xs"
						style={{ color: "var(--text-tertiary)" }}
					>
						暂无定时任务
					</div>
				)}
			</div>
		</div>
	);
}

function TaskCard({
	task,
	selected,
	onClick,
}: {
	task: ScheduledTask;
	selected: boolean;
	onClick: () => void;
}) {
	const hasIM = task.prompt.includes("@bot_");
	const scheduleText = formatSchedule(task.schedule);

	return (
		<div
			onClick={onClick}
			className="rounded-md p-2.5 cursor-pointer transition-colors border"
			style={{
				background: selected ? "var(--accent-soft)" : "var(--surface-hover)",
				borderColor: selected ? "var(--accent)" : "transparent",
			}}
			data-testid={`automation-task-${task.id}`}
		>
			<div className="flex items-center justify-between mb-1">
				<span
					className="text-xs font-medium truncate"
					style={{ color: "var(--text-primary)" }}
				>
					{task.name}
				</span>
				<span
					className="text-[10px]"
					style={{
						color: task.enabled ? "var(--accent)" : "var(--text-tertiary)",
					}}
				>
					{task.enabled ? "●" : "○"}
				</span>
			</div>
			<div className="flex items-center justify-between">
				<span className="text-[10px]" style={{ color: "var(--accent)" }}>
					🕐 {scheduleText}
				</span>
				{hasIM && (
					<span
						className="text-[8px] px-1 rounded"
						style={{
							background: "var(--success-soft)",
							color: "var(--success)",
						}}
					>
						📨
					</span>
				)}
			</div>
		</div>
	);
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
			return `每月${schedule.dayOfMonth ?? 1}日 ${time}`;
		case "custom":
			return schedule.cronExpression ?? "自定义";
	}
}
