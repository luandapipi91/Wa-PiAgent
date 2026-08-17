import type {
	TaskSchedule,
	ScheduledTask,
	ExecutionRecord,
	ModelProvider,
} from "@wa-pi/shared";
import { loadScheduledTasks } from "./scheduler-store";

/** 将 schedule 配置转换为标准 5 字段 cron 表达式（分 时 日 月 周） */
export function toCronExpression(schedule: TaskSchedule): string {
	// .map(Number) 归一化：去除 "09"/"00" 的前导零，使输出为标准 cron 字段（如 9、0）
	const [h, m] = schedule.time.split(":").map(Number);
	switch (schedule.type) {
		case "minute": {
			const n = schedule.intervalMinutes ?? 1;
			return `${n === 1 ? "*" : `*/${n}`} * * * *`;
		}
		case "hourly": {
			const n = schedule.intervalHours ?? 1;
			if (schedule.startTime) {
				// 指定开始时间：当天从 H:M 起每 n 小时（H-23/n 步进）
				const [sh, sm] = schedule.startTime.split(":").map(Number);
				return `${sm} ${sh}-23/${n} * * *`;
			}
			// 不指定：整点对齐（午夜起每 n 小时）
			return `0 ${n === 1 ? "*" : `*/${n}`} * * *`;
		}
		case "daily":
			return `${m} ${h} * * *`;
		case "weekdays":
			return `${m} ${h} * * 1-5`;
		case "weekly":
			return `${m} ${h} * * ${schedule.dayOfWeek ?? 1}`;
		case "monthly":
			return `${m} ${h} ${schedule.dayOfMonth ?? 1} * *`;
		case "custom":
			return schedule.cronExpression ?? "* * * * *";
	}
}

/** 解析任务运行时模型：task.model 优先，缺省回退到第一个 provider 的第一个模型 */
export function resolveTaskModel(
	taskModel: string | null | undefined,
	providers: ModelProvider[],
): string {
	if (taskModel) return taskModel;
	const first = providers[0];
	const firstModel = first?.models?.[0];
	if (!first || !firstModel) {
		throw new Error("无可用的模型供应商，请先在设置中配置至少一个供应商");
	}
	return `${first.slug ?? first.name}/${firstModel.id}`;
}

export interface SchedulerDeps {
	tasksFile: string;
	recordsFile: string;
	dataDir: string;
	// 执行回调（由 index.ts 注入，避免循环依赖）
	executeTask: (task: ScheduledTask) => Promise<ExecutionRecord>;
	broadcast: (event: { type: string; [key: string]: unknown }) => void;
}

/** Bun.cron 返回的 CronJob 句柄（我们只用 stop()，故用最小结构类型） */
interface CronJobHandle {
	stop(): void;
}

export class TaskScheduler {
	private deps: SchedulerDeps;
	private jobs: Map<string, CronJobHandle> = new Map();

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	/** 启动时加载所有 enabled 任务 */
	async start(): Promise<void> {
		const tasks = await loadScheduledTasks(this.deps.tasksFile);
		for (const task of tasks) {
			if (!task.enabled) continue;
			try {
				this.scheduleTask(task);
			} catch (err) {
				this.deps.broadcast({
					type: "scheduled-task:error",
					taskId: task.id,
					error: String(err),
				});
			}
		}
	}

	/** 注册/更新单个任务（重新调度同一 id 会先停止旧 job） */
	scheduleTask(task: ScheduledTask): void {
		this.cancelTask(task.id);
		if (!task.enabled) return;

		const expr = toCronExpression(task.schedule);
		const job = Bun.cron(expr, async () => {
			try {
				const record = await this.deps.executeTask(task);
				this.deps.broadcast({
					type: "scheduled-task:completed",
					taskId: task.id,
					recordId: record.id,
					status: record.status,
				});
			} catch (err) {
				this.deps.broadcast({
					type: "scheduled-task:completed",
					taskId: task.id,
					status: "failed",
					error: String(err),
				});
			}
		});
		this.jobs.set(task.id, job);
	}

	/** 取消任务 */
	cancelTask(taskId: string): void {
		const job = this.jobs.get(taskId);
		if (job) {
			job.stop();
			this.jobs.delete(taskId);
		}
	}

	/** 手动立即执行指定任务（不受 cron 调度控制）*/
	async runTaskNow(taskId: string): Promise<void> {
		const tasks = await loadScheduledTasks(this.deps.tasksFile);
		const task = tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`任务不存在: ${taskId}`);
		try {
			const record = await this.deps.executeTask(task);
			this.deps.broadcast({
				type: "scheduled-task:completed",
				taskId: task.id,
				recordId: record.id,
				status: record.status,
			});
		} catch (err) {
			this.deps.broadcast({
				type: "scheduled-task:completed",
				taskId: task.id,
				status: "failed",
				error: String(err),
			});
		}
	}

	/** 停止所有任务 */
	stopAll(): void {
		for (const job of this.jobs.values()) {
			job.stop();
		}
		this.jobs.clear();
	}
}
