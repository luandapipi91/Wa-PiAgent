import type {
	TaskSchedule,
	ScheduledTask,
	ExecutionRecord,
	ModelProvider,
} from "@wa-pi/shared";

/**
 * 将 schedule 配置转换为标准 5 字段 cron 表达式（分 时 日 月 周，按本地时间）。
 *
 * Bun.cron 自 v1.4 起按系统本地时区解析 cron 表达式（与 crontab/launchd/
 * Windows 任务计划程序一致；旧版 1.3.x 固定按 UTC 解析——当时的 workaround 是
 * 生成 cron 前先做本地→UTC 换算，1.4 行为变更后必须反转，否则任务会在
 * 错误时点触发）。UI 中用户配置的 time 即本地时间（如 09:00 表示早上 9 点），
 * 因此直接以本地时刻生成 cron 即可。
 */
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
				// 指定开始时间：从本地 startTime 起每 n 小时（Bun.cron 按本地时间解析）
				const [sh, sm] = schedule.startTime.split(":").map(Number);
				// 已知限制：cron 的 a-b/n 步进不能跨天折返，startTime 跨天时当天触发点会减少
				return `${sm} ${sh}-23/${n} * * *`;
			}
			// 不指定：整点对齐（午夜起每 n 小时），与具体时刻无关
			return `0 ${n === 1 ? "*" : `*/${n}`} * * *`;
		}
		case "daily":
			return `${m} ${h} * * *`;
		case "weekdays":
			// 本地周一~周五（1-5）
			return `${m} ${h} * * 1-5`;
		case "weekly":
			// 本地 dayOfWeek(0-6, 0=周日)
			return `${m} ${h} * * ${schedule.dayOfWeek ?? 1}`;
		case "monthly":
			return `${m} ${h} ${schedule.dayOfMonth ?? 1} * *`;
		case "custom":
			// custom 直通：用户手写 cron 时请按本地时刻书写（Bun.cron 按本地时间解析）
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
	/** 全量任务加载（由文件夹存储层注入） */
	loadTasks: () => Promise<ScheduledTask[]>;
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
		const tasks = await this.deps.loadTasks();
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
		const task = (await this.deps.loadTasks()).find((t) => t.id === taskId);
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

	/** 返回当前已注册调度的任务 id 列表（文件夹 watcher 对账用） */
	scheduledIds(): string[] {
		return [...this.jobs.keys()];
	}

	/** 停止所有任务 */
	stopAll(): void {
		for (const job of this.jobs.values()) {
			job.stop();
		}
		this.jobs.clear();
	}
}
