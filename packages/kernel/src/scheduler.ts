import type {
	TaskSchedule,
	ScheduledTask,
	ExecutionRecord,
	ModelProvider,
} from "@wa-pi/shared";
import { loadScheduledTasks } from "./scheduler-store";

/**
 * 将「本地时刻」换算为 UTC 的时/分，并返回本地日相对 UTC 日的偏移天数。
 *
 * Bun.cron 的 cron 表达式固定按 UTC 解析（bun-types 文档明确：
 * "Schedules are interpreted in UTC — `0 9 * * *` fires at 9:00 UTC, regardless of TZ"），
 * 而 UI 中用户配置的 time 是本地时间（如 09:00 表示早上 9 点）。
 * 因此生成 cron 前必须先把本地时刻换算成 UTC 时刻，否则任务会在错误的时点触发
 * （曾出现：配置 09:00 实际在北京时间 17:00 执行）。
 *
 * @param hour 本地小时 0-23
 * @param minute 本地分钟 0-59
 * @param now 参照日（默认今天；测试可注入固定日期）
 */
function localToUtc(
	hour: number,
	minute: number,
	now: Date = new Date(),
): { utcHour: number; utcMinute: number; dayOffset: number } {
	// 以「今天」为参照日，把 h:m 作为本地时刻构造 Date（自动处理跨天与夏令时）
	const local = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
		hour,
		minute,
		0,
		0,
	);
	const ms = local.getTime();
	// 本地日序 - UTC 日序（UTC+8 下本地 00:00-07:59 跨到 UTC 前一天 → dayOffset=1）
	const localDay = Math.floor(
		(ms - local.getTimezoneOffset() * 60000) / 86400000,
	);
	const utcDay = Math.floor(ms / 86400000);
	return {
		utcHour: local.getUTCHours(),
		utcMinute: local.getUTCMinutes(),
		dayOffset: localDay - utcDay,
	};
}

/**
 * 把「本地工作日（周一~周五）」集合换算成 UTC 侧的工作日 DOW 列表（0-6，0=周日）。
 * 跨天时（如本地凌晨触发）UTC 的工作日集合会整体前移/后移一天。
 */
function weekdaysToUtcDowExpr(dayOffset: number): string {
	const dowList = [1, 2, 3, 4, 5]
		.map((d) => (d - dayOffset + 7) % 7)
		.sort((a, b) => a - b);
	// 连续区间合并为 a-b，其余用逗号（cron DOW 两种写法均支持）
	const parts: string[] = [];
	let start = dowList[0];
	let prev = dowList[0];
	for (let i = 1; i <= dowList.length; i++) {
		const cur = dowList[i];
		if (cur === prev + 1) {
			prev = cur;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = cur;
		prev = cur;
	}
	return parts.join(",");
}

/** 将 schedule 配置转换为标准 5 字段 cron 表达式（分 时 日 月 周，按 UTC） */
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
				// 指定开始时间：从本地 startTime 起每 n 小时
				const [sh, sm] = schedule.startTime.split(":").map(Number);
				const { utcHour, utcMinute } = localToUtc(sh, sm);
				// 已知限制：cron 的 a-b/n 步进不能跨天折返，startTime 换算到 UTC 跨天时当天触发点会减少
				return `${utcMinute} ${utcHour}-23/${n} * * *`;
			}
			// 不指定：整点对齐（午夜起每 n 小时），与具体时刻无关，无需换算
			return `0 ${n === 1 ? "*" : `*/${n}`} * * *`;
		}
		case "daily": {
			const { utcHour, utcMinute } = localToUtc(h, m);
			return `${utcMinute} ${utcHour} * * *`;
		}
		case "weekdays": {
			const { utcHour, utcMinute, dayOffset } = localToUtc(h, m);
			return `${utcMinute} ${utcHour} * * ${weekdaysToUtcDowExpr(dayOffset)}`;
		}
		case "weekly": {
			const { utcHour, utcMinute, dayOffset } = localToUtc(h, m);
			// 本地 dayOfWeek(0-6, 0=周日) 换算为 UTC 侧星期几
			const dow = ((schedule.dayOfWeek ?? 1) - dayOffset + 7) % 7;
			return `${utcMinute} ${utcHour} * * ${dow}`;
		}
		case "monthly": {
			const { utcHour, utcMinute, dayOffset } = localToUtc(h, m);
			// 跨天时 day-of-month 同步前移；若落到上月（<1）无法用单条 cron 表达，
			// 回退到 1（会延迟到本地次月 2 号凌晨触发，属已知限制）
			const dom = Math.max(1, (schedule.dayOfMonth ?? 1) - dayOffset);
			return `${utcMinute} ${utcHour} ${dom} * *`;
		}
		case "custom":
			// custom 直通：用户手写 cron 时请按 UTC 时刻书写（Bun.cron 固定 UTC 解析）
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
