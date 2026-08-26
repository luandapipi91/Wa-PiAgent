/**
 * 定时任务文件（.md）的解析/序列化/校验，以及执行日志行、cron 表达式求值。
 *
 * frontmatter 为受限 YAML 子集：每行 `key: <JSON 值>`。
 * 不引入 yaml 依赖——本文件是纯函数零依赖，kernel 与独立分发的 CLI 脚本
 * （packages/kernel/assets/scheduled-tasks/cron-task.ts 内嵌同规则副本）共用同一格式。
 */
import type { ExecutionRecord, ScheduledTask, TaskSchedule } from "./types";

// TaskFileError 以 types.ts 为唯一定义来源，此处 re-export 供调用方便捷引用
export type { TaskFileError } from "./types";

/** 任务文件 frontmatter 数据（prompt 为正文，不在 frontmatter 内） */
export interface TaskFileData {
	name: string;
	schedule: TaskSchedule;
	agentId: string;
	model?: string;
	enabled: boolean;
}

/** 文件名 → 任务 id：保留中英文，剔除路径分隔符/控制字符/前导点；空名回退 "task" */
export function sanitizeTaskId(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.replace(/^\.+/, "")
		.trim();
	return cleaned || "task";
}

const SCHEDULE_TYPES = [
	"minute", "hourly", "daily", "weekdays", "weekly", "monthly", "custom",
] as const;

const TIME_RE = /^(\d{2}):(\d{2})$/;

function isValidTime(time: string): boolean {
	const m = TIME_RE.exec(time);
	if (!m) return false;
	return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** POST/PUT 请求体与任务文件共用校验。返回 null 表示合法，否则返回中文错误信息。 */
export function validateTaskData(body: {
	name?: unknown;
	agentId?: unknown;
	prompt?: unknown;
	schedule?: unknown;
	model?: unknown;
}): string | null {
	if (typeof body.name !== "string" || !body.name.trim()) return "name 不能为空";
	if (typeof body.agentId !== "string" || !body.agentId.trim())
		return "agentId 不能为空";
	if (typeof body.prompt !== "string" || !body.prompt.trim())
		return "prompt 不能为空";
	if (body.model != null && typeof body.model !== "string")
		return "model 必须是字符串（providerSlug/modelId）";
	const schedule = body.schedule as Partial<TaskSchedule> | undefined;
	if (!schedule || typeof schedule !== "object") return "schedule 不能为空";
	if (!SCHEDULE_TYPES.includes(schedule.type as (typeof SCHEDULE_TYPES)[number]))
		return `schedule.type 必须是 ${SCHEDULE_TYPES.join("/")} 之一`;
	if (typeof schedule.time !== "string" || !isValidTime(schedule.time))
		return "schedule.time 必须是 HH:MM 格式（如 09:30，00-23:00-59）";
	if (schedule.type === "custom") {
		if (
			typeof schedule.cronExpression !== "string" ||
			!schedule.cronExpression.trim()
		)
			return "schedule.type 为 custom 时 cronExpression 不能为空";
	}
	return null;
}

/** 序列化为任务 md 文件内容（frontmatter + 空行 + prompt 正文） */
export function serializeTaskFile(data: TaskFileData, prompt: string): string {
	const lines = [
		`name: ${JSON.stringify(data.name)}`,
		`schedule: ${JSON.stringify(data.schedule)}`,
		`agentId: ${JSON.stringify(data.agentId)}`,
	];
	if (data.model != null) lines.push(`model: ${JSON.stringify(data.model)}`);
	lines.push(`enabled: ${JSON.stringify(data.enabled)}`);
	return `---\n${lines.join("\n")}\n---\n\n${prompt.trim()}\n`;
}

/**
 * 解析任务 md 文件。createdAt/updatedAt 来自文件 stat（birthtime/mtime），
 * 不写进 frontmatter——保持文件对 agent 的最小噪音。
 * 解析/校验失败抛 Error（中文原因），调用方收集为 TaskFileError。
 */
export function parseTaskFile(
	content: string,
	ctx: { taskId: string; projectId: string; createdAt: number; updatedAt: number },
): ScheduledTask {
	if (!content.startsWith("---\n")) {
		throw new Error("缺少 frontmatter（文件须以 --- 开头）");
	}
	const end = content.indexOf("\n---", 4);
	if (end < 0) throw new Error("frontmatter 未闭合（缺少结尾 ---）");
	const block = content.slice(4, end);
	const prompt = content.slice(end + 4).trim();
	const data: Record<string, unknown> = {};
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const sep = line.indexOf(":");
		if (sep < 0) throw new Error(`frontmatter 行缺少冒号: ${line}`);
		const key = line.slice(0, sep).trim();
		try {
			data[key] = JSON.parse(line.slice(sep + 1).trim());
		} catch {
			throw new Error(`frontmatter 字段 ${key} 的值不是合法 JSON: ${line}`);
		}
	}
	const candidate = {
		name: data.name,
		schedule: data.schedule,
		agentId: data.agentId,
		model: data.model ?? undefined,
		enabled: data.enabled ?? true,
		prompt,
	};
	const error = validateTaskData(candidate);
	if (error) throw new Error(error);
	return {
		id: ctx.taskId,
		projectId: ctx.projectId,
		name: candidate.name as string,
		schedule: candidate.schedule as TaskSchedule,
		agentId: candidate.agentId as string,
		model: typeof candidate.model === "string" ? candidate.model : undefined,
		prompt,
		enabled: candidate.enabled as boolean,
		createdAt: ctx.createdAt,
		updatedAt: ctx.updatedAt,
	};
}

// ===== 执行日志行（logs/<任务id>.log） =====
// 行格式：[本地时间] 状态 耗时Ns 摘要首行 | <完整 ExecutionRecord JSON>
// agent 直接可读；kernel 解析行尾 JSON 还原结构化记录（REST 响应结构不变）。

const STATUS_TEXT: Record<string, string> = {
	running: "运行中",
	success: "成功",
	failed: "失败",
};

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function formatLocalTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatLogLine(record: ExecutionRecord): string {
	const time = formatLocalTime(record.startedAt);
	const dur =
		record.durationMs != null
			? ` 耗时${(record.durationMs / 1000).toFixed(0)}s`
			: "";
	const note = record.error
		? ` ${record.error.split("\n")[0]}`
		: record.summary
			? ` ${record.summary.split("\n")[0]}`
			: "";
	return `[${time}] ${STATUS_TEXT[record.status] ?? record.status}${dur}${note} | ${JSON.stringify(record)}`;
}

/** 解析 log 行尾 JSON 负载；普通文本行/损坏行返回 null（不抛错） */
export function parseLogLine(line: string): ExecutionRecord | null {
	const idx = line.lastIndexOf(" | ");
	if (idx < 0) return null;
	try {
		const rec = JSON.parse(line.slice(idx + 3)) as ExecutionRecord;
		return typeof rec?.id === "string" && typeof rec?.startedAt === "number"
			? rec
			: null;
	} catch {
		return null;
	}
}

// ===== cron 求值（5 字段，本地时间；支持 *、*/n、单值、a-b、a-b/n、逗号列表） =====

const FIELD_RANGES = [
	[0, 59], // 分
	[0, 23], // 时
	[1, 31], // 日
	[1, 12], // 月
	[0, 6], // 周（0=周日）
] as const;

function parseField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const stepMatch = /^(.+)\/(\d+)$/.exec(part);
		const base = stepMatch ? stepMatch[1] : part;
		const step = stepMatch ? Number(stepMatch[2]) : 1;
		if (!Number.isInteger(step) || step < 1)
			throw new Error(`cron 步进非法: ${part}`);
		let lo: number, hi: number;
		if (base === "*") {
			lo = min;
			hi = max;
		} else {
			const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
			if (rangeMatch) {
				lo = Number(rangeMatch[1]);
				hi = Number(rangeMatch[2]);
			} else if (/^\d+$/.test(base)) {
				lo = hi = Number(base);
			} else {
				throw new Error(`cron 字段非法: ${part}`);
			}
		}
		if (lo < min || hi > max || lo > hi)
			throw new Error(`cron 字段越界: ${part}（允许 ${min}-${max}）`);
		for (let v = lo; v <= hi; v += step) values.add(v);
	}
	if (values.size === 0) throw new Error(`cron 字段为空: ${field}`);
	return values;
}

/** 判断 date（本地时间）是否匹配 5 字段 cron 表达式；非法表达式抛 Error */
export function cronMatches(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron 表达式必须是 5 个字段: ${expr}`);
	const sets = fields.map((f, i) =>
		parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]),
	);
	const values = [
		date.getMinutes(),
		date.getHours(),
		date.getDate(),
		date.getMonth() + 1,
		date.getDay(),
	];
	return values.every((v, i) => sets[i].has(v));
}

/** 从 from 起按分钟扫描，返回未来 count 个触发时间（上限扫描 2 年，找不到则返回已找到的） */
export function nextRunTimes(expr: string, count: number, from: Date = new Date()): Date[] {
	// 先验证表达式合法性（throws on invalid）
	cronMatches(expr, from);
	const result: Date[] = [];
	const cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const deadline = from.getTime() + 366 * 2 * 24 * 60 * 60 * 1000;
	while (result.length < count && cursor.getTime() < deadline) {
		if (cronMatches(expr, cursor)) result.push(new Date(cursor.getTime()));
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	return result;
}
