import { useState, useEffect } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useAgentsStore } from "../../store/agents";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { AgentDropdown } from "../ui/AgentDropdown";
import { TaskPromptComposer } from "./TaskPromptComposer";
import { pickDefaultAgent } from "../NewSessionPane";
import { resolveProviderSlug, type TaskSchedule } from "@wa-pi/shared";
import { useProvidersStore } from "../../store/providers";

/** 每小时间隔预设选项；预设之外的值通过「自定义」输入（范围 1-23） */
const HOURLY_INTERVAL_PRESETS = [1, 2, 3, 4, 6, 8, 12, 24];

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
	const { projects, sessions } = useProjectsStore();
	const defaultAgent = useUiPrefsStore((s) => s.defaultAgent);
	const providers = useProvidersStore((s) => s.providers);

	const [name, setName] = useState("");
	const [scheduleType, setScheduleType] =
		useState<TaskSchedule["type"]>("daily");
	const [time, setTime] = useState("09:00");
	const [intervalMinutes, setIntervalMinutes] = useState(5);
	const [intervalHours, setIntervalHours] = useState(1);
	const [intervalHoursCustom, setIntervalHoursCustom] = useState(false);
	const [startTime, setStartTime] = useState("");
	const [dayOfWeek, setDayOfWeek] = useState(1);
	const [dayOfMonth, setDayOfMonth] = useState(1);
	const [cronExpression, setCronExpression] = useState("");
	const [agentId, setAgentId] = useState<string>(
		() => pickDefaultAgent(agents, sessions, undefined, defaultAgent) ?? "",
	);
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState("");
	const [model, setModel] = useState("");

	useEffect(() => {
		if (!editingTask) return;
		setName(editingTask.name);
		setScheduleType(editingTask.schedule.type);
		setTime(editingTask.schedule.time);
		setIntervalMinutes(editingTask.schedule.intervalMinutes ?? 5);
		const iv = editingTask.schedule.intervalHours ?? 1;
		setIntervalHours(iv);
		setIntervalHoursCustom(!HOURLY_INTERVAL_PRESETS.includes(iv));
		setStartTime(editingTask.schedule.startTime ?? "");
		setDayOfWeek(editingTask.schedule.dayOfWeek ?? 1);
		setDayOfMonth(editingTask.schedule.dayOfMonth ?? 1);
		setCronExpression(editingTask.schedule.cronExpression ?? "");
		setAgentId(editingTask.agentId);
		setPrompt(editingTask.prompt);
		setProjectId(editingTask.projectId ?? "");
		setModel(editingTask.model ?? "");
	}, [editingTask]);

	// 新建模式：agent 列表晚于挂载回包时回填默认智能体；已选中（编辑回填）则不干预
	useEffect(() => {
		if (!editingTask && !agentId && agents.length > 0) {
			setAgentId(
				pickDefaultAgent(agents, sessions, undefined, defaultAgent) ?? "",
			);
		}
	}, [editingTask, agentId, agents, sessions, defaultAgent]);

	const handleSave = async () => {
		const schedule: TaskSchedule = { type: scheduleType, time };
		if (scheduleType === "minute") schedule.intervalMinutes = intervalMinutes;
		if (scheduleType === "hourly") {
			schedule.intervalHours = intervalHours;
			if (startTime) schedule.startTime = startTime;
		}
		if (scheduleType === "weekly") schedule.dayOfWeek = dayOfWeek;
		if (scheduleType === "monthly") schedule.dayOfMonth = dayOfMonth;
		if (scheduleType === "custom") schedule.cronExpression = cronExpression;

		const data = {
			name,
			schedule,
			agentId,
			prompt,
			projectId: projectId || undefined,
			// 空（跟随默认）显式传 null，让后端能清空已设置的 model
			model: model || null,
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

	// 自定义每小时间隔必须为 1-23 的整数（非法值会生成非法 cron 导致调度注册失败）
	const validIntervalHours =
		scheduleType !== "hourly" ||
		!intervalHoursCustom ||
		(Number.isInteger(intervalHours) &&
			intervalHours >= 1 &&
			intervalHours <= 23);

	// 自定义间隔输入了非法值 → 输入框标红提示（仅 hourly + 自定义时可能为 true）
	const invalidIntervalHours =
		intervalHoursCustom &&
		!(
			Number.isInteger(intervalHours) &&
			intervalHours >= 1 &&
			intervalHours <= 23
		);

	const canSave = Boolean(
		name &&
			agentId &&
			prompt &&
			(scheduleType !== "custom" || cronExpression.trim() !== "") &&
			validIntervalHours,
	);
	// 模型选项（providerSlug/modelId），首项「跟随默认」空值；与 BotsSection 同源
	const modelOptions = (() => {
		const slugs: string[] = [];
		return providers.flatMap((p) => {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			return p.models.map((m) => ({
				value: `${slug}/${m.id}`,
				label: `${p.name} / ${m.id}`,
			}));
		});
	})();
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
						// 每隔 N 分钟：间隔下拉（1-59）
						<select
							value={intervalMinutes}
							onChange={(e) => setIntervalMinutes(Number(e.target.value))}
							data-testid="task-interval-minutes"
							className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
							style={inputStyle}
						>
							{[1, 2, 3, 5, 10, 15, 20, 30, 45, 59].map((n) => (
								<option key={n} value={n}>
									每隔 {n} 分钟
								</option>
							))}
						</select>
					) : scheduleType === "hourly" ? (
						// 每隔 N 小时：间隔下拉（1-23）+ 可选开始时间（空 = 整点对齐）
						<>
							<select
								value={intervalHoursCustom ? "custom" : intervalHours}
								onChange={(e) => {
									const v = e.target.value;
									if (v === "custom") {
										setIntervalHoursCustom(true);
									} else {
										setIntervalHoursCustom(false);
										setIntervalHours(Number(v));
									}
								}}
								data-testid="task-interval-hours"
								className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
								style={inputStyle}
							>
								{HOURLY_INTERVAL_PRESETS.map((n) => (
									<option key={n} value={n}>
										每隔 {n} 小时
									</option>
								))}
								<option value="custom">自定义</option>
							</select>
							{intervalHoursCustom && (
								<input
									type="number"
									value={intervalHours}
									onChange={(e) => setIntervalHours(Number(e.target.value))}
									min={1}
									max={23}
									placeholder="输入小时数"
									data-testid="task-interval-hours-custom"
									aria-invalid={invalidIntervalHours || undefined}
									className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border"
									style={{
										...inputStyle,
										borderColor: invalidIntervalHours ? "var(--danger)" : undefined,
									}}
								/>
							)}
							<input
								type="time"
								value={startTime}
								onChange={(e) => setStartTime(e.target.value)}
								placeholder="可选"
								onClick={(e) => {
									const el = e.currentTarget;
									if (typeof el.showPicker === "function") {
										try {
											el.showPicker();
										} catch {
											// showPicker 需用户手势且已聚焦，异常时忽略（原生点击行为兑底）
										}
									}
								}}
								data-testid="task-hourly-start"
								className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
								style={inputStyle}
							/>
						</>
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
					任务指令
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

			{/* 使用的模型（可选，跟随默认） */}
			<div className="mb-3.5">
				<label
					className="text-[11px] block mb-1.5"
					style={{ color: "var(--text-secondary)" }}
				>
					使用的模型
				</label>
				<select
					value={model}
					onChange={(e) => setModel(e.target.value)}
					className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none border cursor-pointer"
					style={inputStyle}
					data-testid="task-model-select"
				>
					<option value="">跟随默认</option>
					{modelOptions.map((m) => (
						<option key={m.value} value={m.value}>
							{m.label}
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
