import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSchedulerStore } from "../../store/scheduler";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useClampMenu } from "../ProjectItem";
import type { ScheduledTask, ExecutionStatus } from "@wa-pi/shared";

/** 右键菜单打开状态：屏幕坐标 + 目标任务 */
interface TaskMenuState {
	x: number;
	y: number;
	task: ScheduledTask;
}

/**
 * 自动化侧边栏：紧凑的任务卡片列表。
 * 点击卡片选中（再点取消），「+ 新建」进入新建弹窗；右键卡片弹上下文菜单
 * （立即执行 / 删除，删除需二次确认）——菜单模式对齐会话列表（portal + 视口钳制）。
 * 卡片右侧显示该任务最近一次执行状态（✓/✕/⟳，由执行记录推导）。
 */
export function AutomationSidebar() {
	const {
		tasks,
		records,
		selectedTaskId,
		selectTask,
		startCreate,
		loadTasks,
		loadRecords,
		deleteTask,
		runTaskNow,
	} = useSchedulerStore();
	// 右键上下文菜单（taskMenu 非空时 portal 渲染）
	const [taskMenu, setTaskMenu] = useState<TaskMenuState | null>(null);
	// 删除确认（菜单点「删除」后弹 ConfirmDialog）
	const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	useClampMenu(menuRef, taskMenu);

	// 每任务最近一条执行记录（状态点 + 上次执行时间数据源；records 无序保证，取 startedAt 最大）
	const lastRunByTask = useMemo(() => {
		const latest = new Map<
			string,
			{ status: ExecutionStatus; startedAt: number }
		>();
		for (const r of records) {
			const prev = latest.get(r.taskId);
			if (!prev || r.startedAt > prev.startedAt) {
				latest.set(r.taskId, { status: r.status, startedAt: r.startedAt });
			}
		}
		return latest;
	}, [records]);

	useEffect(() => {
		void loadTasks();
		// 状态点需要全量执行记录（不限任务）；loadRecords 无参 = 全部
		void loadRecords();
	}, [loadTasks, loadRecords]);

	// 菜单关闭：点任意处 / ESC（延迟注册，避免右键当次事件立即关闭）
	useEffect(() => {
		if (!taskMenu) return;
		const close = () => setTaskMenu(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		const id = setTimeout(() => {
			document.addEventListener("click", close);
			document.addEventListener("keydown", onKey);
		}, 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [taskMenu]);

	// 跨组件菜单互斥：其他组件（会话/项目右键菜单）打开时关闭自己的
	useEffect(() => {
		const onCloseAll = () => setTaskMenu(null);
		window.addEventListener("project-menu-close", onCloseAll);
		return () => window.removeEventListener("project-menu-close", onCloseAll);
	}, []);

	return (
		<div className="flex flex-col h-full" data-testid="automation-sidebar">
			{/* 工具栏 */}
			<div className="flex items-center justify-between px-2 py-1.5">
				<span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
					定时任务 ({tasks.length})
				</span>
				<div className="flex gap-1">
					<button
						onClick={startCreate}
						className="text-[10px] px-2 py-0.5 rounded border-0 cursor-pointer"
						style={{ background: "var(--accent)", color: "white" }}
						data-testid="automation-new-btn"
					>
						+ 新建自动化
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
						lastRun={lastRunByTask.get(task.id)}
						onClick={() => selectTask(task.id)}
						onContextMenu={(e) => {
							e.preventDefault();
							window.dispatchEvent(new CustomEvent("project-menu-close"));
							setTaskMenu({ x: e.clientX, y: e.clientY, task });
						}}
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

			{/* 右键上下文菜单（portal 到 body，模式对齐会话列表右键菜单） */}
			{taskMenu &&
				createPortal(
					<div
						ref={menuRef}
						className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
						style={{
							left: taskMenu.x,
							top: taskMenu.y,
							background: "var(--surface)",
							boxShadow: "var(--shadow-lg)",
							minWidth: 140,
						}}
						onClick={(e) => e.stopPropagation()}
						data-testid="task-context-menu"
					>
						<button
							onClick={() => {
								void runTaskNow(taskMenu.task.id);
								setTaskMenu(null);
							}}
							className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover text-xs"
							data-testid="task-menu-run"
						>
							▶ 立即执行
						</button>
						<button
							onClick={() => {
								setDeletingTask(taskMenu.task);
								setTaskMenu(null);
							}}
							className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft text-xs"
							data-testid="task-menu-delete"
						>
							🗑 删除
						</button>
					</div>,
					document.body,
				)}

			{/* 删除确认弹窗（菜单「删除」后二次确认） */}
			{deletingTask && (
				<ConfirmDialog
					title="删除自动化任务"
					message={`确定删除「${deletingTask.name}」？删除后不可恢复。`}
					confirmText="删除"
					danger
					onCancel={() => setDeletingTask(null)}
					onConfirm={() => {
						void deleteTask(deletingTask.id);
						setDeletingTask(null);
					}}
				/>
			)}
		</div>
	);
}

/** 状态点颜色（与 ExecutionRecords 页面三色映射一致） */
function statusStyle(status: ExecutionStatus) {
	return status === "success"
		? { color: "#4ade80", title: "上次执行：成功" }
		: status === "failed"
			? { color: "#f87171", title: "上次执行：失败" }
			: { color: "#60a5fa", title: "执行中" };
}

function TaskCard({
	task,
	selected,
	lastRun,
	onClick,
	onContextMenu,
}: {
	task: ScheduledTask;
	selected: boolean;
	lastRun?: { status: ExecutionStatus; startedAt: number };
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}) {
	const scheduleText = formatSchedule(task.schedule);

	return (
		<div
			onClick={onClick}
			onContextMenu={onContextMenu}
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
				<span className="flex items-center gap-1 shrink-0">
					{/* 最近执行状态点（执行记录推导，无记录不显示） */}
					{lastRun && (
						<span
							className="text-[10px] font-bold"
							style={statusStyle(lastRun.status)}
							data-testid={`task-last-status-${task.id}`}
						>
							{lastRun.status === "success"
								? "✓"
								: lastRun.status === "failed"
									? "✕"
									: "⟳"}
						</span>
					)}
					<span
						className="text-[10px]"
						style={{
							color: task.enabled ? "var(--accent)" : "var(--text-tertiary)",
						}}
					>
						{task.enabled ? "●" : "○"}
					</span>
				</span>
			</div>
			<div className="flex items-center justify-between">
				<span className="text-[10px]" style={{ color: "var(--accent)" }}>
					🕐 {scheduleText}
				</span>
				{/* 上次执行时间（执行记录推导，无记录不显示） */}
				{lastRun && (
					<span
						className="text-[10px] shrink-0"
						style={{ color: "var(--text-tertiary)" }}
						title={new Date(lastRun.startedAt).toLocaleString("zh-CN")}
						data-testid={`task-last-run-${task.id}`}
					>
						{lastRunTimeOf(lastRun.startedAt)}
					</span>
				)}
			</div>
		</div>
	);
}

/** 上次执行时间格式化：当天 HH:mm，非当天 M-D HH:mm（now 供测试注入）。 */
export function lastRunTimeOf(ts: number, now = Date.now()): string {
	const d = new Date(ts);
	const today = new Date(now);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (d.toDateString() === today.toDateString()) {
		return `${hh}:${mm}`;
	}
	return `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
}

function formatSchedule(schedule: ScheduledTask["schedule"]): string {
	const time = schedule.time;
	switch (schedule.type) {
		case "minute":
			return `每 ${schedule.intervalMinutes ?? 1} 分钟`;
		case "hourly":
			return `每 ${schedule.intervalHours ?? 1} 小时${
				schedule.startTime ? ` · ${schedule.startTime} 起` : ""
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
