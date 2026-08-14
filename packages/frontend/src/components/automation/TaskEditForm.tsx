import { useState, useEffect } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useAgentsStore } from "../../store/agents";
import { useProjectsStore } from "../../store/projects";
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
		if (editingTask) {
			await updateTask(editingTask.id, data);
		} else {
			await createTask(data);
		}
	};

	const canSave = Boolean(name && agentId && prompt);
	const inputStyle: React.CSSProperties = {
		background: "var(--surface-hover)",
		borderColor: "var(--hairline)",
		color: "var(--text-primary)",
	};

	return (
		<div className="max-w-[560px]" data-testid="task-edit-form">
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
						onChange={(e) =>
							setScheduleType(e.target.value as TaskSchedule["type"])
						}
						className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
						style={inputStyle}
					>
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
					) : (
						<input
							type="time"
							value={time}
							onChange={(e) => setTime(e.target.value)}
							className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border"
							style={inputStyle}
						/>
					)}
				</div>
				{scheduleType === "weekly" && (
					<select
						value={dayOfWeek}
						onChange={(e) => setDayOfWeek(Number(e.target.value))}
						className="mt-1.5 rounded-md px-2.5 py-1 text-[10px] outline-none border cursor-pointer"
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
						className="mt-1.5 rounded-md px-2.5 py-1 text-[10px] outline-none border cursor-pointer"
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
				<div className="flex gap-1.5 flex-wrap">
					{agents.map((agent) => {
						const selected = agentId === agent.displayName;
						return (
							<div
								key={agent.displayName}
								onClick={() => setAgentId(agent.displayName)}
								className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] cursor-pointer border"
								style={{
									borderColor: selected
										? "var(--accent)"
										: "var(--hairline)",
									background: selected
										? "var(--accent-soft)"
										: "var(--surface-hover)",
									color: selected
										? "var(--accent)"
										: "var(--text-secondary)",
								}}
							>
								<span>{agent.avatar || "🤖"}</span>
								<span>{agent.displayName}</span>
							</div>
						);
					})}
					{agents.length === 0 && (
						<span
							className="text-[10px]"
							style={{ color: "var(--text-tertiary)" }}
						>
							暂无智能体
						</span>
					)}
				</div>
			</div>

			{/* 任务指令 */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					任务指令{" "}
					<span style={{ color: "var(--text-tertiary)" }}>
						（$ 技能，@ 渠道）
					</span>
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
