/**
 * 定时任务热加载：fs.watch 全局 tasks 目录（~/.pi/agent/scheduled-tasks/tasks），
 * 外部改动（CLI/agent 直接改文件）防抖 300ms 后重新扫描并回调 applyTasks。
 *
 * 全局化后只 watch 一个目录（不再每项目一个），任务归属由 frontmatter 的 projectId 决定。
 *
 * 防自写循环：kernel 自身经 store 写入的文件记录了内容哈希，事件触发时比对，
 * 哈希一致说明是自己写的（REST 已同步调度），跳过重载。
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScheduledTask, TaskFileError } from "@wa-pi/shared";
import {
	tasksDirOf,
	taskContentHash,
	type FolderTaskStore,
} from "./scheduler-task-store";

const DEBOUNCE_MS = 300;

export class TaskFolderWatcher {
	private deps: {
		store: FolderTaskStore;
		applyTasks: (tasks: ScheduledTask[], errors: TaskFileError[]) => void;
	};
	private watcher: FSWatcher | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(deps: TaskFolderWatcher["deps"]) {
		this.deps = deps;
	}

	/** 启动：对全局 tasks 目录建 watch（目录不存在由调用方/ensure 确保） */
	async start(): Promise<void> {
		if (this.stopped) return;
		const dir = tasksDirOf();
		try {
			this.watcher = watch(dir, () => this.scheduleReload());
			// FSWatcher 是 EventEmitter：目录被外部删除等会异步 emit 'error'，
			// 无 listener 会进程级崩溃。捕获后关闭，避免持续崩溃。
			this.watcher.on("error", (err) => {
				console.warn(`[scheduler] watch 出错 ${dir}:`, err);
				this.watcher?.close();
				this.watcher = null;
			});
		} catch (err) {
			console.warn(`[scheduler] watch 失败 ${dir}:`, err);
		}
	}

	private scheduleReload(): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.reload(), DEBOUNCE_MS);
	}

	private async reload(): Promise<void> {
		if (this.stopped) return;
		try {
			const { tasks, errors } = await this.deps.store.listAll();
			// 防自写：若所有变更文件的当前内容哈希都等于 store 自写哈希，则跳过。
			// 简化判定：逐任务文件比对太细，这里用「任务集合指纹」——
			// 重新扫描结果与自写内容一致时，applyTasks 本身幂等（调度器重复注册同 cron 无害），
			// 因此只对「全部文件均为自写」的常见场景短路：
			const allSelf = await this.allWritesAreSelf(tasks, errors);
			if (allSelf) return;
			this.deps.applyTasks(tasks, errors);
		} catch (err) {
			// 兜底：listAll 抛错不能成为 unhandled rejection，
			// 本次变更丢失，下一次文件事件会再次触发重扫
			console.warn("[scheduler] 热加载重扫失败:", err);
		}
	}

	/** 当前任务文件内容是否全部来自 store 自写（无外部改动） */
	private async allWritesAreSelf(
		tasks: ScheduledTask[],
		errors: TaskFileError[],
	): Promise<boolean> {
		// 存在解析/校验失败文件时不得短路：即便全是自写有效任务，也要 applyTasks 把 error 广播出去（无效文件不静默跳过）
		if (errors.length > 0) return false;
		let sawAny = false;
		for (const t of tasks) {
			const file = join(tasksDirOf(), `${t.id}.md`);
			const selfHash = this.deps.store.lastWrittenHash(file);
			if (!selfHash) return false; // 存在非自写文件 → 不短路
			sawAny = true;
			try {
				const content = await readFile(file, "utf8");
				if (taskContentHash(content) !== selfHash) return false; // 自写后又被外部改过
			} catch {
				return false;
			}
		}
		return sawAny;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = null;
	}
}
