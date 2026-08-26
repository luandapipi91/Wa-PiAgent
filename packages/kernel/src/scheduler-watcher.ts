/**
 * 定时任务文件夹热加载：fs.watch 各项目 tasks 目录，外部改动（CLI/agent 直接改文件）
 * 防抖 300ms 后重新扫描并回调 applyTasks。
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
	type ProjectRef,
} from "./scheduler-task-store";

const DEBOUNCE_MS = 300;

export class TaskFolderWatcher {
	private deps: {
		store: FolderTaskStore;
		projectsProvider: () => Promise<ProjectRef[]>;
		applyTasks: (tasks: ScheduledTask[], errors: TaskFileError[]) => void;
	};
	private watchers = new Map<string, FSWatcher>(); // key: tasksDir
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(deps: TaskFolderWatcher["deps"]) {
		this.deps = deps;
	}

	/** 启动：对当前全部项目建 watch（目录不存在先由调用方确保） */
	async start(): Promise<void> {
		await this.syncProjects();
	}

	/** 项目增删时调用：新项目补 watch，消失的停 watch */
	async syncProjects(): Promise<void> {
		if (this.stopped) return;
		const projects = await this.deps.projectsProvider();
		const wanted = new Map<string, string>(); // tasksDir → projectId（去重：同 cwd 只 watch 一次）
		for (const p of projects) wanted.set(tasksDirOf(p.cwd), p.id);
		for (const [dir, w] of this.watchers) {
			if (!wanted.has(dir)) {
				w.close();
				this.watchers.delete(dir);
			}
		}
		for (const dir of wanted.keys()) {
			if (this.watchers.has(dir)) continue;
			try {
				const w = watch(dir, () => this.scheduleReload());
				this.watchers.set(dir, w);
			} catch (err) {
				console.warn(`[scheduler] watch 失败 ${dir}:`, err);
			}
		}
	}

	private scheduleReload(): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.reload(), DEBOUNCE_MS);
	}

	private async reload(): Promise<void> {
		if (this.stopped) return;
		const { tasks, errors } = await this.deps.store.listAll();
		// 防自写：若所有变更文件的当前内容哈希都等于 store 自写哈希，则跳过。
		// 简化判定：逐任务文件比对太细，这里用「任务集合指纹」——
		// 重新扫描结果与自写内容一致时，applyTasks 本身幂等（调度器重复注册同 cron 无害），
		// 因此只对「全部文件均为自写」的常见场景短路：
		const allSelf = await this.allWritesAreSelf(tasks);
		if (allSelf) return;
		this.deps.applyTasks(tasks, errors);
	}

	/** 当前任务文件内容是否全部来自 store 自写（无外部改动） */
	private async allWritesAreSelf(tasks: ScheduledTask[]): Promise<boolean> {
		const projects = await this.deps.projectsProvider();
		const cwdOf = new Map(projects.map((p) => [p.id, p.cwd]));
		let sawAny = false;
		for (const t of tasks) {
			const cwd = cwdOf.get(t.projectId ?? "");
			if (!cwd) continue;
			const file = join(tasksDirOf(cwd), `${t.id}.md`);
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
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
	}
}
