/**
 * 定时任务文件夹存储层：全部任务统一存放全局目录 WA_PI_DIR/scheduled-tasks/。
 *
 * - tasks/<任务id>.md：任务文件（frontmatter + prompt 正文，含 projectId 归属），id = 文件名
 * - logs/<任务id>.log：执行日志（append-only；同 id 记录读取时去重取最新，
 *   running → 终态 的回写就是追加一条同 id 新行）
 * - 所有写文件 tmp+rename 原子写；写入时记录内容哈希（lastWrittenHash），
 *   供 watcher 识别自身写入、避免热加载循环。
 */
import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { ExecutionRecord, ScheduledTask } from "@wa-pi/shared";
import {
	formatLogLine,
	parseLogLine,
	parseTaskFile,
	sanitizeTaskId,
	serializeTaskFile,
	validateTaskData,
	type TaskFileData,
	type TaskFileError,
} from "@wa-pi/shared";

export interface ProjectRef {
	id: string;
	cwd: string;
}

/** 定时任务全局统一存放根：`~/.pi/agent/scheduled-tasks/`（WA_PI_DIR/scheduled-tasks/）。
 *  任务定义 md + CLI + README + 执行记录 logs 全部在此，不再按项目分散。
 *  默认取 WA_PI_DIR/scheduled-tasks；单测用 setScheduledTasksRoot 切到 tmpdir。 */
export const SCHEDULED_TASKS_ROOT = join(WA_PI_DIR, "scheduled-tasks");
let scheduledTasksRoot = SCHEDULED_TASKS_ROOT;
export function setScheduledTasksRoot(dir: string): void {
	scheduledTasksRoot = dir;
}
export function getScheduledTasksRoot(): string {
	return scheduledTasksRoot;
}

export function tasksDirOf(): string {
	return join(scheduledTasksRoot, "tasks");
}

export function logsDirOf(): string {
	return join(scheduledTasksRoot, "logs");
}

function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** taskId 合法性：拒绝空串与路径穿越（/ \ ..），写入路径前统一校验 */
function isValidTaskId(taskId: string): boolean {
	return (
		taskId !== "" &&
		!taskId.includes("/") &&
		!taskId.includes("\\") &&
		!taskId.includes("..")
	);
}

function assertValidTaskId(taskId: string): void {
	if (!isValidTaskId(taskId)) throw new Error(`taskId 非法: ${taskId}`);
}

// tmp 文件名的模块级自增后缀：同进程并发写同一文件时避免 tmp 名互相覆盖/ENOENT
let tmpCounter = 0;

/** 原子写：tmp + rename，并记录内容哈希 */
async function atomicWrite(
	file: string,
	content: string,
	writeHashes: Map<string, string>,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, file);
	writeHashes.set(file, hashOf(content));
}

export interface FolderTaskStore {
	listAll(): Promise<{ tasks: ScheduledTask[]; errors: TaskFileError[] }>;
	findById(
		taskId: string,
	): Promise<{ task: ScheduledTask; projectId: string } | null>;
	create(
		input: TaskFileData & { prompt: string },
		projectId: string,
	): Promise<ScheduledTask>;
	update(
		taskId: string,
		input: TaskFileData & { prompt: string },
	): Promise<ScheduledTask | null>;
	remove(taskId: string): Promise<boolean>;
	appendRecord(
		projectId: string,
		taskId: string,
		record: ExecutionRecord,
	): Promise<void>;
	listRecords(filter: {
		taskId?: string;
		status?: string;
	}): Promise<ExecutionRecord[]>;
	/** watcher 防自写循环：返回 store 最近一次写入该文件的内容哈希；非自写/未知 → null */
	lastWrittenHash(file: string): string | null;
}

export function createFolderTaskStore(deps: {
	projectsProvider: () => Promise<ProjectRef[]>;
}): FolderTaskStore {
	const writeHashes = new Map<string, string>();

	// store 级写队列：create/update/remove 串行化（promise 链，同 scheduler-store 的
	// enqueueWrite 模式）。并发同名 create 的 id 检测→写文件必须整体排队，
	// 否则两个 create 会选中同一 id 互相覆盖（TOCTOU）。
	// 注意：入队 op 内部不得再调用入队版函数（嵌套等待自身前置 → 死锁）。
	let writeChain: Promise<void> = Promise.resolve();
	function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
		const result = writeChain.then(op);
		writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function findProject(projectId: string): Promise<ProjectRef | null> {
		const projects = await deps.projectsProvider();
		return projects.find((p) => p.id === projectId) ?? null;
	}

	/** 全局扫描单个 tasks 目录（项目归属由任务 frontmatter 的 projectId 决定） */
	async function listGlobalTasks(): Promise<{
		tasks: ScheduledTask[];
		errors: TaskFileError[];
	}> {
		const dir = tasksDirOf();
		const tasks: ScheduledTask[] = [];
		const errors: TaskFileError[] = [];
		let entries: string[] = [];
		try {
			entries = await readdir(dir);
		} catch {
			return { tasks, errors }; // 目录不存在 = 无任务
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const file = join(dir, entry);
			const taskId = entry.slice(0, -3);
			try {
				const [content, st] = await Promise.all([
					readFile(file, "utf8"),
					stat(file),
				]);
				const task = parseTaskFile(content, {
					taskId,
					projectId: "",
					createdAt: Math.round(st.birthtimeMs || st.mtimeMs),
					updatedAt: Math.round(st.mtimeMs),
				});
				tasks.push(task);
			} catch (err) {
				errors.push({
					taskId,
					projectId: "", // projectId 从 frontmatter 解析失败时设为空，调用方可从文件内容再读
					file,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return { tasks, errors };
	}

	/** 按 id 定位任务文件（含解析失败的文件——PUT 修复/DELETE 需要）。全局单目录，无需遍历项目。 */
	async function locateFile(taskId: string): Promise<{ file: string } | null> {
		if (!isValidTaskId(taskId)) return null; // 路径穿越防护：非法 id 视为不存在
		const file = join(tasksDirOf(), `${taskId}.md`);
		return (await stat(file).then(
			() => true,
			() => false,
		))
			? { file }
			: null;
	}

	async function findTaskById(
		taskId: string,
	): Promise<{ task: ScheduledTask; projectId: string } | null> {
		const loc = await locateFile(taskId);
		if (!loc) return null;
		try {
			const [content, st] = await Promise.all([
				readFile(loc.file, "utf8"),
				stat(loc.file),
			]);
			const task = parseTaskFile(content, {
				taskId,
				projectId: "",
				createdAt: Math.round(st.birthtimeMs || st.mtimeMs),
				updatedAt: Math.round(st.mtimeMs),
			});
			return { task, projectId: task.projectId ?? "" };
		} catch {
			return null; // 文件存在但解析失败：findById 只看有效任务
		}
	}

	// ---- 写操作内部实现（非入队版；入队包装只负责排队，op 内不得再调用入队版，否则死锁） ----

	async function createImpl(
		input: TaskFileData & { prompt: string },
		projectId: string,
	): Promise<ScheduledTask> {
		const project = await findProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		const error = validateTaskData(input);
		if (error) throw new Error(error);
		// 同名冲突追加 -2/-3…（全局唯一，跨项目同名也追加后缀）
		const base = sanitizeTaskId(input.name);
		let taskId = base;
		for (
			let i = 2;
			await stat(join(tasksDirOf(), `${taskId}.md`)).then(
				() => true,
				() => false,
			);
			i++
		) {
			taskId = `${base}-${i}`;
		}
		const file = join(tasksDirOf(), `${taskId}.md`);
		// 把 projectId 并入序列化数据（全局化后任务文件自带归属）
		await atomicWrite(
			file,
			serializeTaskFile({ ...input, projectId }, input.prompt),
			writeHashes,
		);
		const st = await stat(file);
		return {
			id: taskId,
			projectId,
			name: input.name,
			schedule: input.schedule,
			agentId: input.agentId,
			model: input.model,
			prompt: input.prompt,
			enabled: input.enabled,
			createdAt: Math.round(st.birthtimeMs || st.mtimeMs),
			updatedAt: Math.round(st.mtimeMs),
		};
	}

	async function updateImpl(
		taskId: string,
		input: TaskFileData & { prompt: string },
	): Promise<ScheduledTask | null> {
		assertValidTaskId(taskId);
		const loc = await locateFile(taskId);
		if (!loc) return null;
		const error = validateTaskData(input);
		if (error) throw new Error(error);
		// 保留原 projectId（若 input 未显式传，则从原文件读回，避免更新时丢失归属）
		const prev = await findTaskById(taskId);
		const projectId = input.projectId?.trim()
			? input.projectId
			: (prev?.projectId ?? "");
		// 保留原 createdAt（birthtime 不因覆盖写改变，但显式读回最稳）
		await atomicWrite(
			loc.file,
			serializeTaskFile({ ...input, projectId }, input.prompt),
			writeHashes,
		);
		const found = await findTaskById(taskId);
		return found?.task ?? null;
	}

	async function removeImpl(taskId: string): Promise<boolean> {
		// 非法 taskId 由 locateFile 判空 → 返回 false（删除幂等，不抛错）
		const loc = await locateFile(taskId);
		if (!loc) return false;
		await rm(loc.file, { force: true });
		writeHashes.delete(loc.file);
		return true;
	}

	return {
		async listAll() {
			return listGlobalTasks();
		},

		findById: findTaskById,

		// create/update/remove 整体串行化：同名检测→写文件之间不被并发插队
		create: (input, projectId) =>
			enqueueWrite(() => createImpl(input, projectId)),
		update: (taskId, input) => enqueueWrite(() => updateImpl(taskId, input)),
		remove: (taskId) => enqueueWrite(() => removeImpl(taskId)),

		async appendRecord(_projectId, taskId, record) {
			assertValidTaskId(taskId); // log 文件名直接来自 taskId，先挡路径穿越
			// 全局化后 log 按 taskId 命名（全局唯一），projectId 不再用于定位目录
			const dir = logsDirOf();
			await mkdir(dir, { recursive: true });
			const line = formatLogLine(record);
			const file = join(dir, `${taskId}.log`);
			await writeFile(file, `${line}\n`, { flag: "a" }); // 追加不写哈希：log 不参与 watch
		},

		async listRecords(filter) {
			const byId = new Map<string, ExecutionRecord>();
			const dir = logsDirOf();
			let entries: string[] = [];
			try {
				entries = await readdir(dir);
			} catch {
				return [];
			}
			for (const entry of entries) {
				if (!entry.endsWith(".log")) continue;
				const taskId = entry.slice(0, -4);
				if (filter.taskId && filter.taskId !== taskId) continue;
				const content = await readFile(join(dir, entry), "utf8");
				for (const line of content.split("\n")) {
					if (!line.trim()) continue;
					const rec = parseLogLine(line);
					if (!rec) continue;
					byId.set(rec.id, rec); // 同 id 后写覆盖先写：running → 终态
				}
			}
			let records = [...byId.values()];
			if (filter.status)
				records = records.filter((r) => r.status === filter.status);
			return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 200);
		},

		lastWrittenHash(file) {
			return writeHashes.get(file) ?? null;
		},
	};
}

export { hashOf as taskContentHash };
