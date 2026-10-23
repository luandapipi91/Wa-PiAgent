import type {
	TaskSchedule,
	ScheduledTask,
	ExecutionRecord,
	ModelProvider,
} from "@wa-pi/shared";
import { KernelError } from "@wa-pi/shared";

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
		throw new KernelError("scheduler.noProvider");
	}
	return `${first.slug ?? first.name}/${firstModel.id}`;
}

/** 一次执行的运行时上下文：由 scheduler 创建，executeTask 消费
 *  （取消检查 + 回填会话 id 供取消时中止）。 */
export interface RunContext {
	readonly taskId: string;
	/** 是否已被请求取消（执行链在关键节点检查，及时收敛为终态） */
	isCancelled(): boolean;
	/** 会话创建后回填：取消时据此中止对应 agent 会话 */
	setSessionId(sessionId: string): void;
}

export interface SchedulerDeps {
	/** 全量任务加载（由文件夹存储层注入） */
	loadTasks: () => Promise<ScheduledTask[]>;
	dataDir: string;
	/** 阶段一：落盘 running 记录 + 广播（快返回；「立即执行」据此把 running 记录同步回给前端） */
	prepareRun: (task: ScheduledTask, ctx: RunContext) => Promise<ExecutionRecord>;
	/** 阶段二：真正执行并把终态写回（长跑，调用方 fire-and-forget） */
	executeRun: (
		task: ScheduledTask,
		record: ExecutionRecord,
		ctx: RunContext,
	) => Promise<ExecutionRecord>;
	/** 对账悬空 running 记录（应用重启/进程退出后残留），返回被改写的记录。
	 *  startedBefore：只收尾早于该时刻的记录（避免误伤对账期间刚起的新执行）。 */
	markInterruptedRuns: (
		taskId?: string,
		opts?: { startedBefore?: number },
	) => Promise<ExecutionRecord[]>;
	/** 中止执行中的 agent 会话（取消执行时调用） */
	abortSession: (sessionId: string) => Promise<void>;
	broadcast: (event: { type: string; [key: string]: unknown }) => void;
}

/** 在飞执行的内存登记项（仅存活于本进程；进程重启后的残留由 markInterrupted 对账） */
interface InFlightRun {
	/** 是否已被请求取消 */
	cancelled: boolean;
	/** 会话创建后回填，取消时据此中止会话 */
	sessionId?: string;
	/** 后台执行链收敛 promise（取消时要等它写终态；测试也用它同步） */
	done?: Promise<void>;
}

/** 取消时等执行链收敛/等会话中止的上限（超过则先响应，前端靠 SSE 拿终态） */
const CANCEL_WAIT_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bun.cron 返回的 CronJob 句柄（我们只用 stop()，故用最小结构类型） */
interface CronJobHandle {
	stop(): void;
}

export class TaskScheduler {
	private deps: SchedulerDeps;
	private jobs: Map<string, CronJobHandle> = new Map();
	/** 在飞执行登记表：同一任务同时只允许一次执行（并发闸门 + 取消寻址） */
	private inFlight: Map<string, InFlightRun> = new Map();

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
			// 已在执行中（通常是上一轮定时触发或手动「立即执行」未结束）→ 跳过本次，
			// 避免同一任务并发两次执行（会话/记录/推送都会互相干扰）
			if (this.inFlight.has(task.id)) {
				console.warn(
					`[scheduler] 任务「${task.name}」正在执行中，跳过本次定时触发`,
				);
				return;
			}
			try {
				// 定时触发等本轮跑完（同一任务的并发触发由 inFlight 跳过，不会堆叠）
				const { done } = await this.startRun(task);
				await done;
			} catch (err) {
				console.error(`[scheduler] 定时触发任务「${task.name}」失败:`, err);
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

	/** 手动立即执行指定任务（不受 cron 调度控制）。
	 *  返回时 running 记录已落盘（前端收到响应即可刷新出「执行中」），执行链在后台继续。
	 *  已有执行在跑时抛 scheduler.taskAlreadyRunning（不允许重复执行）。 */
	async runTaskNow(taskId: string): Promise<ExecutionRecord> {
		const task = (await this.deps.loadTasks()).find((t) => t.id === taskId);
		if (!task) throw new KernelError("scheduler.taskNotFound", { taskId });
		const { record } = await this.startRun(task);
		return record;
	}

	/** 取消执行中的任务：标记取消 + 中止该次执行的 agent 会话，
	 *  等执行链把记录收敛为终态（失败 + scheduler.taskCancelled）。
	 *  无在飞执行时退化为对账悬空状态：应用重启后卡住的「执行中」也能被清除。 */
	async cancelRun(
		taskId: string,
	): Promise<{ cancelled: boolean; reconciled: number }> {
		// 下界取进入本方法前的时刻：此次调用期间新起的执行（另一请求的 runTaskNow）不属于残留
		const requestedAt = Date.now();
		const run = this.inFlight.get(taskId);
		if (!run) {
			const reconciled = await this.deps.markInterruptedRuns(taskId, {
				startedBefore: requestedAt,
			});
			return { cancelled: false, reconciled: reconciled.length };
		}
		run.cancelled = true;
		if (run.sessionId) {
			await Promise.race([
				this.deps.abortSession(run.sessionId).catch((err) => {
					console.error(`[scheduler] 中止任务 ${taskId} 的会话失败:`, err);
				}),
				sleep(CANCEL_WAIT_MS),
			]);
		}
		// 等终态记录落盘（取消后 executeTask 会走 cancelled 分支写回 failed）
		if (run.done) await Promise.race([run.done, sleep(CANCEL_WAIT_MS)]);
		return { cancelled: true, reconciled: 0 };
	}

	/** 启动时对账：把上次进程残留的 running 记录收尾为「已中断」（应用重启后状态自愈） */
	async reconcileStaleRuns(): Promise<ExecutionRecord[]> {
		return this.deps.markInterruptedRuns();
	}

	/** 任务当前是否有在飞执行（服务端侧的真相源，供接口层/排障用） */
	isRunning(taskId: string): boolean {
		return this.inFlight.has(taskId);
	}

	/** 启动一次执行：占位 → 对账悬空 running → 落盘 running 记录并广播；
	 *  真正执行在后台继续（结束时广播 scheduled-task:completed），经 done 可等它收敛。
	 *  调用方可捕获的异常：scheduler.taskAlreadyRunning / prepareRun 的失败。 */
	private async startRun(
		task: ScheduledTask,
	): Promise<{ record: ExecutionRecord; done: Promise<void> }> {
		const run = this.reserve(task.id);
		const startedAt = Date.now();
		try {
			// 悬空 running（上次进程被杀留下的「执行中」）先收尾，否则本次执行会与它共存。
			// 下界 = 占位时刻：本次执行自己的记录（prepareRun 之后才写）不在对账范围内。
			await this.deps.markInterruptedRuns(task.id, { startedBefore: startedAt });
			const ctx: RunContext = {
				taskId: task.id,
				isCancelled: () => run.cancelled,
				setSessionId: (sessionId) => {
					run.sessionId = sessionId;
				},
			};
			const record = await this.deps.prepareRun(task, ctx);
			// continueRun 内部已 catch 执行异常，这里再吞一层：广播抛错不应变成 unhandled rejection
			run.done = this.continueRun(task, record, ctx).catch(() => {});
			return { record, done: run.done };
		} catch (err) {
			// 预检失败（任务文件损坏/落盘失败）：释放槽位，否则该任务将永远无法再执行
			this.inFlight.delete(task.id);
			throw err;
		}
	}

	/** 同步占用执行槽位：并发点「立即执行」/ 定时触发与手动触发撞车时的唯一闸门 */
	private reserve(taskId: string): InFlightRun {
		if (this.inFlight.has(taskId)) {
			throw new KernelError("scheduler.taskAlreadyRunning");
		}
		const run: InFlightRun = { cancelled: false };
		this.inFlight.set(taskId, run);
		return run;
	}

	/** 后台执行链：跑完写终态 + 广播；释放槽位。自身不抛错（失败已落盘为 failed 记录） */
	private async continueRun(
		task: ScheduledTask,
		record: ExecutionRecord,
		ctx: RunContext,
	): Promise<void> {
		try {
			const final = await this.deps.executeRun(task, record, ctx);
			this.deps.broadcast({
				type: "scheduled-task:completed",
				taskId: task.id,
				recordId: final.id,
				status: final.status,
			});
		} catch (err) {
			console.error(`[scheduler] 任务「${task.name}」执行异常:`, err);
			this.deps.broadcast({
				type: "scheduled-task:completed",
				taskId: task.id,
				recordId: record.id,
				status: "failed",
				error: String(err),
			});
		} finally {
			this.inFlight.delete(task.id);
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
