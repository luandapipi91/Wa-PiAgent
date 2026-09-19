/**
 * 定时任务文件夹存储层：全部任务统一存放全局目录 WA_PI_DIR/scheduled-tasks/。
 *
 * - tasks/<任务id>.md：任务文件（frontmatter + prompt 正文，含 projectId 归属），id = 文件名
 * - logs/<任务id>.log：执行日志（append-only；同 id 记录读取时去重取最新，
 *   running → 终态 的回写就是追加一条同 id 新行）
 * - logs/<任务id>.latest.json：每任务最新一条记录的索引（appendRecord 同步维护，
 *   供状态点等消费方免全量读日志；读取时缺失/损坏则退化为读日志尾）
 * - 所有写文件 tmp+rename 原子写；写入时记录内容哈希（lastWrittenHash），
 *   供 watcher 识别自身写入、避免热加载循环。
 */
import {
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
	type FileHandle,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { WA_PI_DIR, KernelError } from "@wa-pi/shared";
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
	if (!isValidTaskId(taskId))
		throw new KernelError("scheduler.invalidTaskId", { taskId });
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

/** 读文件尾部 maxBytes 字节并按行切分；起点落在行中间时丢弃首个不完整行。
 *  返回 reachedStart 表示是否已覆盖到文件头（尾读去重不足 limit 时判断能否停止扩读）。 */
async function readTailLines(
	file: string,
	maxBytes: number,
): Promise<{ lines: string[]; reachedStart: boolean }> {
	let fh: FileHandle;
	try {
		fh = await open(file, "r");
	} catch {
		return { lines: [], reachedStart: true }; // 文件不存在（任务从未执行过）视为空
	}
	try {
		const { size } = await fh.stat();
		if (size === 0) return { lines: [], reachedStart: true };
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		let text = buf.toString("utf8");
		if (start > 0) {
			const nl = text.indexOf("\n");
			if (nl < 0) return { lines: [], reachedStart: false }; // 整窗都在同一行内
			text = text.slice(nl + 1); // 丢弃被截断的半行，只保留完整行
		}
		return {
			lines: text.split("\n").filter((l) => l.trim() !== ""),
			reachedStart: start === 0,
		};
	} finally {
		await fh.close();
	}
}

/** 单任务悬空对账的尾读窗口：悬空 running 恒是「该任务最后一次执行的记录」，
 *  多条残留只可能来自旧版并发执行，几十条窗口足够覆盖 */
const RECONCILE_TAIL_LIMIT = 50;

/** 从日志尾部读取最近 limit 条记录（去重后，startedAt 倒序）。
 *  正确性依赖 append-only 性质：同一次执行的终态行恒在其 running 行之后追加
	⇒ 尾读方向先遇到的是同 id 最新状态，「首次遇到即赢」等价于全量读的「后写覆盖先写」。
 *  行不定长（实测 173B~1.5KB，超长 summary 可达 ~3KB），按估算窗口读，不足时扩读重试。 */
async function listRecordsTail(
	taskId: string,
	limit: number,
): Promise<ExecutionRecord[]> {
	assertValidTaskId(taskId);
	const file = join(logsDirOf(), `${taskId}.log`);
	// 每次执行 2 行（running+终态），首否按 4KB/行给余量；最多扩读 2 次（×16 上限）防异常行分布
	let windowBytes = Math.max(limit, 1) * 2 * 4096;
	let result: ExecutionRecord[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		const { lines, reachedStart } = await readTailLines(file, windowBytes);
		const byId = new Map<string, ExecutionRecord>();
		for (let i = lines.length - 1; i >= 0; i--) {
			const rec = parseLogLine(lines[i]);
			if (!rec || byId.has(rec.id)) continue;
			byId.set(rec.id, rec);
			if (byId.size >= limit) break;
		}
		result = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
		// 凑够 limit 条，或已覆盖到文件头（全量也就这么多），无需再扩读
		if (byId.size >= limit || reachedStart) break;
		windowBytes *= 4;
	}
	return result;
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
		/** 最多返回条数（≤200）。taskId+limit 且无 status/since 时走日志尾部读取，避免全量解析历史 */
		limit?: number;
		/** 只返回 startedAt >= since 的记录（执行记录列表按时间范围加载用） */
		since?: number;
	}): Promise<ExecutionRecord[]>;
	/** 每任务最新一条执行记录（侧栏状态点用）：读 <taskId>.latest.json 索引，
	 *  无索引（旧数据）时退化为读该任务日志尾 1 条，不触发全量日志解析 */
	listLatestRecords(): Promise<ExecutionRecord[]>;
	/** 对账悬空执行：把残留在 running 的记录改写成「已中断」并同步 latest 索引，
	 *  返回被改写的记录。传 taskId 只对账该任务（尾读窗口内），缺省对账全部任务（全量）。幂等。
	 *  opts.startedBefore：只收尾 startedAt 早于该时刻的记录——避免把「对账期间刚起的新执行」
	 *  误判成残留（并发时 cancelRun 与 runTaskNow 可交错）。 */
	markInterrupted(
		taskId?: string,
		opts?: { startedBefore?: number },
	): Promise<ExecutionRecord[]>;
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
		if (!project) throw new KernelError("project.notFound", { id: projectId });
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

	const store: FolderTaskStore = {
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
			// 同步维护「每任务最新一条」索引（tmp+rename 原子写，logs/ 下不参与 watch 哈希）：
			// appendRecord 是该任务记录的唯一写入口 ⇒ latest 恒等于日志最后一行，
			// 侧栏状态点等消费方读这个小文件即可，无需全量解析历史日志
			const tmp = `${file}.latest.json.tmp-${process.pid}-${tmpCounter++}`;
			const latestFile = join(dir, `${taskId}.latest.json`);
			await writeFile(tmp, JSON.stringify(record), "utf8");
			await rename(tmp, latestFile);
		},

		async listRecords(filter) {
			// 指定任务 + limit 且无 status/since 筛选时走尾部读取：最新记录恒在文件尾部，
			// 无需全量解析历史日志（读放大随日志增长线性恶化，是长期运行卡顿的隐患）
			if (filter.taskId && filter.limit && !filter.status && !filter.since) {
				return listRecordsTail(filter.taskId, filter.limit);
			}
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
			if (filter.since != null)
				records = records.filter((r) => r.startedAt >= filter.since!);
			if (filter.status)
				records = records.filter((r) => r.status === filter.status);
			return records
				.sort((a, b) => b.startedAt - a.startedAt)
				.slice(0, filter.limit ?? 200);
		},

		async listLatestRecords() {
			const dir = logsDirOf();
			let entries: string[] = [];
			try {
				entries = await readdir(dir);
			} catch {
				return [];
			}
			const records: ExecutionRecord[] = [];
			for (const entry of entries) {
				if (!entry.endsWith(".log")) continue;
				const taskId = entry.slice(0, -4);
				try {
					const raw = await readFile(
						join(dir, `${taskId}.latest.json`),
						"utf8",
					);
					const rec = JSON.parse(raw) as ExecutionRecord;
					if (
						typeof rec?.id === "string" &&
						typeof rec?.startedAt === "number"
					) {
						records.push(rec);
						continue;
					}
				} catch {
					// 无索引（旧数据）或索引损坏：退化为读该任务日志尾 1 条
				}
				records.push(...(await listRecordsTail(taskId, 1)));
			}
			return records.sort((a, b) => b.startedAt - a.startedAt);
		},

		/** 对账悬空执行：kernel 被 kill / 崩溃 / 关机时，running 记录的终态行来不及落盘，
		 *  「执行中」会永久卡住（状态点、记录列表、详情页都按 running 渲染）。
		 *  启动时全量对账一次，立即执行前对目标任务对账一次，把残留 running 收尾为 failed。
		 *  幂等：只改写 running 态记录（同 id 追加一条终态行，读取去重即覆盖）。 */
		async markInterrupted(taskId, opts) {
			// 单任务对账走尾读窗口（悬空 running 恒在日志尾部）：markInterrupted 在
			// 「每次立即执行/定时触发」的热路径上，全量解析历史日志会随日志增长线性恶化。
			// 启动对账（无 taskId）只发生一次，用全量扫描兜住历史遗留。
			const candidates = taskId
				? await listRecordsTail(taskId, RECONCILE_TAIL_LIMIT)
				: await store.listRecords({ status: "running" });
			const before = opts?.startedBefore;
			const interrupted: ExecutionRecord[] = [];
			for (const rec of candidates) {
				if (rec.status !== "running") continue;
				if (before != null && rec.startedAt >= before) continue;
				const fixed: ExecutionRecord = {
					...rec,
					status: "failed",
					// 收尾时刻（进程何时退出无从得知，故不写 durationMs）
					finishedAt: Date.now(),
					// 文案由前端按 errorCode 查字典渲染（kernel 不拼中文）
					error: "scheduler.taskInterrupted",
					errorCode: "scheduler.taskInterrupted",
				};
				delete fixed.errorParams;
				// 耗时不可知：running 的 startedAt 到「本次对账」之间可能隔着应用关闭的整段时间，
				// 保留会显示成「耗时 18 天」这类假数据
				delete fixed.durationMs;
				await store.appendRecord("", rec.taskId, fixed);
				interrupted.push(fixed);
			}
			return interrupted;
		},

		lastWrittenHash(file) {
			return writeHashes.get(file) ?? null;
		},
	};
	return store;
}

export { hashOf as taskContentHash };
