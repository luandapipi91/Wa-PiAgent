import { useState, useEffect } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useAgentsStore } from "../../store/agents";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { AgentDropdown } from "../ui/AgentDropdown";
import { TaskPromptComposer } from "./TaskPromptComposer";
import type { TaskSchedule } from "@wa-pi/shared";

/**
 * 定时任务新建/编辑表单。
 *
 * editingTask === null 时为「新建」，否则回填已有任务字段。
 * 必填项（名称 / 智能体 / 指令）齐全后保存按钮才可用；
 * 保存调用 store 的 createTask 或 updateTask（两者内部都会切回 detail 视图）。
 *
 * 说明：AgentConfig 以 displayName 为唯一标识（无 id 字段），故 agentId 取
 * agent.displayName；与后端 ScheduledTask.agentId 约定一致。
 */
export function TaskEditForm() {
	const { editingTask, createTask, updateTask, setView } = useSchedulerStore();
	const { list: agents } = useAgentsStore();
	const { projects } = useProjectsStore();

	const [name, setName] = useState("");
	const [scheduleType, setScheduleType] =
		useState<TaskSchedule["type"]>("daily");
	const [time, setTime] = useState("09:00");
	const [dayOfWeek, setDayOfWeek] = useState(1);
	const [dayOfMonth, setDayOfMonth] = useState(1);
	const [cronExpression, setCronExpression] = useState("");
	const [agentId, setAgentId] = useState("");
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState("");

	useEffect(() => {
		if (!editingTask) return;
		setName(editingTask.name);
		setScheduleType(editingTask.schedule.type);
		setTime(editingTask.schedule.time);
		setDayOfWeek(editingTask.schedule.dayOfWeek ?? 1);
		setDayOfMonth(editingTask.schedule.dayOfMonth ?? 1);
		setCronExpression(editingTask.schedule.cronExpression ?? "");
		setAgentId(editingTask.agentId);
		setPrompt(editingTask.prompt);
		setProjectId(editingTask.projectId ?? "");
	}, [editingTask]);

	const handleSave = async () => {
		const schedule: TaskSchedule = { type: scheduleType, time };
		if (scheduleType === "weekly") schedule.dayOfWeek = dayOfWeek;
		if (scheduleType === "monthly") schedule.dayOfMonth = dayOfMonth;
		if (scheduleType === "custom") schedule.cronExpression = cronExpression;

		const data = {
			name,
			schedule,
			agentId,
			prompt,
			projectId: projectId || undefined,
		};
		try {
			if (editingTask) {
				await updateTask(editingTask.id, data);
			} else {
				await createTask(data);
			}
		} catch {
			useToastStore.getState().add("保存任务失败，请稍后重试", "error");
		}
	};

	const canSave = Boolean(
		name &&
			agentId &&
			prompt &&
			(scheduleType !== "custom" || cronExpression.trim() !== ""),
	);
	const inputStyle: React.CSSProperties = {
		background: "var(--surface-hover)",
		borderColor: "var(--hairline)",
		color: "var(--text-primary)",
	};

	return (
		<div className="max-w-[560px] mx-auto" data-testid="task-edit-form">
			{/* 任务名称 */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					任务名称
				</label>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="给任务起个名字"
					className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none border"
					style={inputStyle}
					data-testid="task-name-input"
				/>
			</div>

			{/* 计划时间 */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					计划时间
				</label>
				<div className="flex gap-2">
					<select
						value={scheduleType}
						onChange={(e) => setScheduleType(e.target.value as TaskSchedule["type"])}
						className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
						style={inputStyle}
					>
						<option value="minute">每分钟</option>
						<option value="hourly">每小时</option>
						<option value="daily">每天</option>
						<option value="weekdays">工作日</option>
						<option value="weekly">每周</option>
						<option value="monthly">每月</option>
						<option value="custom">自定义 Cron</option>
					</select>
					{scheduleType === "custom" ? (
						<input
							value={cronExpression}
							onChange={(e) => setCronExpression(e.target.value)}
						placeholder="*/15 * * * *"
						className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border"
						style={inputStyle}
					/>
				) : scheduleType === "minute" ? (
					// 每分钟：无需附加输入，说明文案占位保持行高一致
					<div
						className="flex-1 rounded-md px-2.5 py-1.5 text-xs border flex items-center"
						style={{ ...inputStyle, color: "var(--text-tertiary)" }}
					>
						每分钟自动执行
					</div>
				) : scheduleType === "hourly" ? (
					// 每小时：仅取分钟段（小时忽略），分钟下拉更直观；存回 time 侜 kernel 复用
					<select
						value={time.split(":")[1] ?? "00"}
						onChange={(e) => setTime(`00:${e.target.value}`)}
						data-testid="task-minute-input"
						className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
						style={inputStyle}
					>
						{Array.from({ length: 60 }, (_, i) =>
							String(i).padStart(2, "0"),
						).map((mm) => (
							<option key={mm} value={mm}>
								第 {mm} 分钟
							</option>
						))}
					</select>
				) : (
					<input
						type="time"
							value={time}
							onChange={(e) => setTime(e.target.value)}
							// 原生 time 输入只点右侧时钟图标才弹选择器；点击任意位置都调 showPicker 弹出
							onClick={(e) => {
								const el = e.currentTarget;
								if (typeof el.showPicker === "function") {
									try {
										el.showPicker();
									} catch {
										// showPicker 需用户手势且已聚焦，异常时忽略（原生点击行为兜底）
									}
								}
							}}
							data-testid="task-time-input"
							className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
							style={inputStyle}
						/>
					)}
				</div>
				{scheduleType === "weekly" && (
					<select
						value={dayOfWeek}
						onChange={(e) => setDayOfWeek(Number(e.target.value))}
						// w-full：与上方选择器同宽（原收缩为内容宽，视觉不齐）
						className="mt-1.5 w-full rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
						style={inputStyle}
					>
						{["日", "一", "二", "三", "四", "五", "六"].map((d, i) => (
							<option key={i} value={i}>
								周{d}
							</option>
						))}
					</select>
				)}
				{scheduleType === "monthly" && (
					<select
						value={dayOfMonth}
						onChange={(e) => setDayOfMonth(Number(e.target.value))}
						// w-full：与上方选择器同宽
						className="mt-1.5 w-full rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
						style={inputStyle}
					>
						{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
							<option key={d} value={d}>
								{d} 日
							</option>
						))}
					</select>
				)}
			</div>

			{/* 执行角色（智能体） */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					执行角色（智能体）
				</label>
				{/* 执行角色（智能体）：复用通用 AgentDropdown（搜索 + 头像 + 描述） */}
				<AgentDropdown
					agents={agents}
					value={agentId || null}
					onPick={(name) => setAgentId(name)}
					pillTestId="task-agent-select"
					itemTestIdPrefix="task-agent"
				/>
			</div>

			{/* 任务指令 */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					任务指令{" "}
					<span style={{ color: "var(--text-tertiary)" }}>（$ 技能，@ 联系人）</span>
				</label>
				<TaskPromptComposer value={prompt} onChange={setPrompt} />
			</div>

			{/* 工作目录 */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					工作目录
				</label>
				<select
					value={projectId}
					onChange={(e) => setProjectId(e.target.value)}
					className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
					style={inputStyle}
				>
					<option value="">默认</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
			</div>

			{/* 操作按钮 */}
			<div
				className="flex justify-end gap-2 mt-4 pt-3 border-t"
				style={{ borderColor: "var(--hairline)" }}
			>
				<button
					onClick={() => setView("detail")}
					className="text-[11px] px-3.5 py-1 rounded border cursor-pointer"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					取消
				</button>
				<button
					onClick={handleSave}
					disabled={!canSave}
					className="text-[11px] px-3.5 py-1 rounded border-0 cursor-pointer font-medium disabled:cursor-not-allowed"
					style={{
						background: "var(--accent)",
						color: "white",
						opacity: canSave ? 1 : 0.5,
					}}
					data-testid="task-save-btn"
				>
					保存任务
				</button>
			</div>
		</div>
	);
}
