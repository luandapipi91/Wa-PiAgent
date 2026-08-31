// wa-pi-cron-task-asset v3
/**
 * wa-pi 定时任务 CLI（由 wa-pi kernel 自动分发到全局目录，请勿手工编辑——旧版会被自动覆盖升级）。
 *
 * 用法：bun cron-task.ts <command>
 * 命令：
 *   help                          显示本说明
 *   list                          列出全部任务（含解析失败的文件）
 *   show <id>                     显示任务详情（id = 文件名，不含 .md）
 *   add --name N --agent A --schedule '<json>' [--model M] [--project P] [--im-push 渠道,联系人] [--no-im-push] [--disabled] --prompt P
 *        --im-push 可重复，把 @im-push-to(渠道,ct_xxx) 推送到标记注入 prompt（执行时注册 im_push_to 工具）
 *        --no-im-push 显式关闭推送（默认自动用 env 的默认推送目标，无需显式传 --im-push）
 *   set <id> <key> <value>        修改字段（key: name/enabled/time/agent/model/project/prompt/im-push）
 *   delete <id>                   删除任务（项目隔离：agent 场景只能删本项目任务）
 *   validate <id>                 校验任务文件
 *   test <id>                     校验 + 显示未来 5 次触发时间（不执行）
 *   run <id>                      立即触发执行（需 wa-pi kernel 在线）
 *
 * 示例用法：
 *   bun cron-task.ts list
 *   bun cron-task.ts show 每日巡检
 *   # 创建每天 09:30 执行、结果推送给 ct_123 的任务
 *   bun cron-task.ts add --name 每日巡检 --agent main \
 *     --schedule '{"type":"daily","time":"09:30"}' \
 *     --im-push ch_企微,ct_123 --prompt '检查服务器并汇报'
 *   # 改时间 / 生效
 *   bun cron-task.ts set 每日巡检 time 10:00
 *   bun cron-task.ts set 每日巡检 im-push ch_企微,ct_123
 *   bun cron-task.ts run 每日巡检
 *   bun cron-task.ts delete 每日巡检
 *
 * 任务统一存放在全局目录 ~/.pi/agent/scheduled-tasks/（即 WA_PI_DIR/scheduled-tasks/）下的
 * tasks/ 与 logs/，跨项目共享；任务归属项目记录在 frontmatter 的 projectId 字段。
 */
import {
	readFileSync,
	writeFileSync,
	readdirSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 全局统一存放：以脚本所在目录为根（kernel 分发到全局 scheduled-tasks 目录）
const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(BASE_DIR, "tasks");
// 默认项目：未指定 --project 时用 env 或默认工作区
const DEFAULT_PROJECT_ID =
	process.env.WA_PI_SCHEDULER_PROJECT_ID || "__system__";
// 项目作用域：agent 场景下由 kernel 注入当前会话项目 id，非空时 CLI 只操作该项目任务（隔离）
const PROJECT_SCOPE = process.env.WA_PI_SCHEDULER_PROJECT_ID || "";
// 默认推送目标：agent 会话注入的 WA_PI_IM_PUSH_TARGETS（ct_xxx 列表，逗号分隔）。
// CLI 由 agent spawn 时继承该 env；add 未显式传 --im-push 时用它作缺省，确保任务执行时
// prompt 带 @im-push-to 标记 → kernel 注册 im_push_to 工具 → 能推送出去（否则怎么都推不出去）。
const DEFAULT_PUSH_TARGETS = (process.env.WA_PI_IM_PUSH_TARGETS || "")
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);

function serializeTask(data: any, prompt: string): string {
	const lines = [
		`name: ${JSON.stringify(data.name)}`,
		`schedule: ${JSON.stringify(data.schedule)}`,
		`agentId: ${JSON.stringify(data.agentId)}`,
	];
	if (data.model != null) lines.push(`model: ${JSON.stringify(data.model)}`);
	lines.push(
		`projectId: ${JSON.stringify(data.projectId ?? DEFAULT_PROJECT_ID)}`,
	);
	lines.push(`enabled: ${JSON.stringify(data.enabled)}`);
	return `---\n${lines.join("\n")}\n---\n\n${prompt.trim()}\n`;
}

// ===== frontmatter（受限 YAML 子集：每行 key: <JSON 值>）——与 kernel 同规则 =====

const SCHEDULE_TYPES = [
	"minute",
	"hourly",
	"daily",
	"weekdays",
	"weekly",
	"monthly",
	"custom",
];

function parseTask(content: string, id: string, file: string): any {
	if (!content.startsWith("---\n"))
		throw new Error("缺少 frontmatter（文件须以 --- 开头）");
	const end = content.indexOf("\n---", 4);
	if (end < 0) throw new Error("frontmatter 未闭合（缺少结尾 ---）");
	const data: Record<string, unknown> = {};
	for (const rawLine of content.slice(4, end).split("\n")) {
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
	const prompt = content.slice(end + 4).trim();
	const schedule = data.schedule as any;
	if (typeof data.name !== "string" || !data.name.trim())
		throw new Error("name 不能为空");
	if (typeof data.agentId !== "string" || !data.agentId.trim())
		throw new Error("agentId 不能为空");
	// projectId：全局化后任务文件必带归属（读 frontmatter，缺省兜底默认项目）
	const projectId =
		typeof data.projectId === "string" && data.projectId.trim()
			? data.projectId
			: DEFAULT_PROJECT_ID;
	if (!prompt) throw new Error("prompt 不能为空（正文）");
	if (data.model != null && typeof data.model !== "string")
		throw new Error("model 必须是字符串（providerSlug/modelId）");
	if (!schedule || typeof schedule !== "object")
		throw new Error("schedule 不能为空");
	if (!SCHEDULE_TYPES.includes(schedule.type))
		throw new Error(`schedule.type 必须是 ${SCHEDULE_TYPES.join("/")} 之一`);
	const TIME_RE = /^(\d{2}):(\d{2})$/;
	const tm =
		typeof schedule.time === "string" ? TIME_RE.exec(schedule.time) : null;
	if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59)
		throw new Error("schedule.time 必须是 HH:MM 格式（如 09:30，00-23:00-59）");
	if (schedule.type === "custom" && !schedule.cronExpression)
		throw new Error("schedule.type 为 custom 时 cronExpression 不能为空");
	return { id, file, ...data, projectId, enabled: data.enabled ?? true, prompt };
}

function toCron(schedule: any): string {
	const [h, m] = (schedule.time ?? "00:00").split(":").map(Number);
	switch (schedule.type) {
		case "minute": {
			const n = schedule.intervalMinutes ?? 1;
			return `${n === 1 ? "*" : `*/${n}`} * * * *`;
		}
		case "hourly": {
			const n = schedule.intervalHours ?? 1;
			if (schedule.startTime) {
				const [sh, sm] = schedule.startTime.split(":").map(Number);
				return `${sm} ${sh}-23/${n} * * *`;
			}
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
		default:
			throw new Error(`未知 schedule.type: ${schedule.type}`);
	}
}

// ===== cron 求值（与 kernel shared/task-file.ts 同规则） =====

const FIELD_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
] as const;

function parseField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const stepMatch = /^(.+)\/(\d+)$/.exec(part);
		const base = stepMatch ? stepMatch[1] : part;
		const step = stepMatch ? Number(stepMatch[2]) : 1;
		// 步进必须为正整数，否则 */0 之类会让 nextRunTimes 死循环（与 shared 同规则）
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
			} else throw new Error(`cron 字段非法: ${part}`);
		}
		if (lo < min || hi > max || lo > hi)
			throw new Error(`cron 字段越界: ${part}`);
		for (let v = lo; v <= hi; v += step) values.add(v);
	}
	return values;
}

function cronMatches(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5)
		throw new Error(`cron 表达式必须是 5 个字段: ${expr}`);
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

function nextRunTimes(expr: string, count: number): Date[] {
	const from = new Date();
	cronMatches(expr, from); // 先验证合法性
	const result: Date[] = [];
	const cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const deadline = from.getTime() + 366 * 2 * 86400_000;
	while (result.length < count && cursor.getTime() < deadline) {
		if (cronMatches(expr, cursor)) result.push(new Date(cursor.getTime()));
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	return result;
}

// ===== 任务文件操作 =====

function sanitizeTaskId(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.replace(/^\.+/, "")
		.replace(/\.\.+/g, "-") // 先剥前导点再折叠中间点串（与 shared/task-file.ts 同规）
		.trim();
	return cleaned || "task";
}

function listTaskFiles(): { id: string; file: string }[] {
	if (!existsSync(TASKS_DIR)) return [];
	return readdirSync(TASKS_DIR)
		.filter((f) => f.endsWith(".md"))
		.map((f) => ({ id: f.slice(0, -3), file: join(TASKS_DIR, f) }));
}

function loadTask(id: string): any {
	// id 即文件名，必须防止路径穿越（set ../escape/out ... 之类）
	if (!id || id.includes("/") || id.includes("\\") || id.includes(".."))
		throw new Error(`任务 id 非法: ${id}`);
	const file = join(TASKS_DIR, `${id}.md`);
	if (!existsSync(file)) throw new Error(`任务不存在: ${id}`);
	return parseTask(readFileSync(file, "utf8"), id, file);
}

/** 写/执行操作的项目隔离：agent 场景（PROJECT_SCOPE 非空）只允许操作本项目任务，
 *  拒绝编辑/运行其他项目任务（读取 show/validate/test 不受限）。 */
function assertOwnProject(task: any, id: string): void {
	if (PROJECT_SCOPE && task.projectId !== PROJECT_SCOPE)
		throw new Error(
			`任务 ${id} 不属于当前项目（它归属于项目 ${task.projectId}，当前项目是 ${PROJECT_SCOPE}）。不可以操作/删除其他项目的任务——已阻止本次操作。`,
		);
}

/** 项目显示名：系统默认项目（__system__）显示为「默认工作区」，其余显示 projectId。 */
function projectLabelOf(pid: string | undefined): string {
	return !pid || pid === "__system__" ? "默认工作区" : pid;
}

/** 把未含的 @im-push-to(ch_xxx,ct_xxx) 标记注入 prompt（按联系人去重；已存在的 ct 不重复加）。
 *  执行时 kernel 会 parseImPushMentions 读 prompt 里的标记，注入 im_push_to 工具并推送。
 *  pushTarget 格式：`渠道,联系人`（如 `ch_企微,ct_xxx`；渠道 q 缺省用 ch_channel）。 */
function injectImPushMentions(prompt: string, pushTargets: string[]): string {
	if (!pushTargets.length) return prompt;
	const existingCts = new Set(prompt.match(/ct_[a-zA-Z0-9_-]+/g) ?? []);
	const extra: string[] = [];
	for (const t of pushTargets) {
		// 兼容两种输入：`渠道,ct_xxx`（显式 --im-push） 或裸 `ct_xxx`（默认推送目标 env）。
		const [maybeChannel, maybeCt] = t.split(",");
		let channel: string | undefined;
		let ct: string | undefined;
		if (maybeChannel && /^ct_[a-zA-Z0-9_-]+$/.test(maybeChannel)) {
			// 裸联系人（无渠道）→ 渠道兜底 ch_channel
			ct = maybeChannel;
		} else {
			channel = maybeChannel;
			ct = maybeCt;
		}
		if (!ct || !/^ct_[a-zA-Z0-9_-]+$/.test(ct))
			fail(`--im-push 格式应为一渠道,联系人（如 ch_xx,ct_xxx）: ${t}`);
		if (existingCts.has(ct)) continue;
		existingCts.add(ct);
		extra.push(`@im-push-to(${channel || "ch_channel"},${ct})`);
	}
	return extra.length ? `${extra.join(" ")}\n${prompt}` : prompt;
}

function atomicWrite(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

// ===== kernel 发现（run 命令需要） =====

function kernelBaseUrl(): string {
	const waDir =
		process.env.WA_PI_DIR || join(process.env.HOME || ".", ".pi", "agent");
	const infoFile = join(waDir, "kernel.json");
	if (!existsSync(infoFile))
		throw new Error("找不到 kernel 信息文件（wa-pi 未运行？）: " + infoFile);
	let info: any;
	try {
		info = JSON.parse(readFileSync(infoFile, "utf8"));
	} catch {
		throw new Error("kernel.json 损坏，无法解析: " + infoFile);
	}
	try {
		process.kill(info.pid, 0);
	} catch {
		throw new Error("wa-pi kernel 不在线（pid 已失效），请先启动 wa-pi");
	}
	return `http://127.0.0.1:${info.port}`;
}

// ===== 命令 =====

function fail(msg: string): never {
	console.error(`错误: ${msg}`);
	process.exit(1);
}

function fmtTime(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function main(): void {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "help":
		case undefined:
			console.log(
				readFileSync(fileURLToPath(import.meta.url), "utf8")
					.match(/\/\*\*([\s\S]*?)\*\//)?.[1]
					?.trim(),
			);
			return;
		case "list": {
			const files = listTaskFiles();
			if (files.length === 0) {
				console.log("（暂无任务）");
				return;
			}
			for (const { id, file } of files) {
				try {
					const t = parseTask(readFileSync(file, "utf8"), id, file);
					const cron = toCron(t.schedule);
					const next = nextRunTimes(cron, 1)[0];
					// 显示所属项目：系统默认项目（__system__）显示「默认工作区」
					const proj = projectLabelOf(t.projectId);
					console.log(
						`${t.enabled ? "●" : "○"} ${id}\t[${proj}]\t${t.name}\t${cron}${next ? `\t下次: ${fmtTime(next)}` : ""}`,
					);
				} catch (err) {
					console.log(
						`✗ ${id}\t配置错误: ${err instanceof Error ? err.message : err}`,
					);
				}
			}
			return;
		}
		case "show": {
			const t = loadTask(args[0] ?? fail("缺少任务 id"));
			console.log(readFileSync(t.file, "utf8"));
			return;
		}
		case "add": {
			const opts: Record<string, string> = {};
			const pushTargets: string[] = [];
			let noImPush = false;
			// 逐个 token 扫描：带值参数（--name N）取下一个为值；无值布尔参数（--no-im-push/--disabled）只置位。
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "--no-im-push") {
					noImPush = true;
					continue;
				}
				if (a === "--disabled") continue;
				if (!a.startsWith("--")) continue;
				const key = a.replace(/^--/, "");
				if (key === "im-push") pushTargets.push(args[++i]);
				else opts[key] = args[++i];
			}
			if (!noImPush && pushTargets.length === 0 && DEFAULT_PUSH_TARGETS.length > 0)
				pushTargets.push(...DEFAULT_PUSH_TARGETS);
			if (!opts.name) fail("缺少 --name");
			if (!opts.agent) fail("缺少 --agent");
			if (!opts.schedule)
				fail('缺少 --schedule（JSON，如 {"type":"daily","time":"09:30"}）');
			if (!opts.prompt) fail("缺少 --prompt");
			let schedule: any;
			try {
				schedule = JSON.parse(opts.schedule);
			} catch {
				fail("--schedule 不是合法 JSON");
			}
			// 推送目标：把 @im-push-to(渠道,ct_xxx) 标记注入 prompt，执行时 kernel 据此注册
			// im_push_to 工具并推送（prompt 里已含的 ct 去重，不重复加）
			const prompt = injectImPushMentions(opts.prompt, pushTargets);
			const data = {
				name: opts.name,
				schedule,
				agentId: opts.agent,
				model: opts.model ?? undefined,
				projectId: opts.project ?? DEFAULT_PROJECT_ID,
				enabled: !args.includes("--disabled"),
			};
			const content = serializeTask(data, prompt);
			parseTask(content, "check", "check"); // 写前校验
			const base = sanitizeTaskId(opts.name);
			let id = base;
			for (let i = 2; existsSync(join(TASKS_DIR, `${id}.md`)); i++)
				id = `${base}-${i}`;
			atomicWrite(join(TASKS_DIR, `${id}.md`), content);
			console.log(`已创建任务: ${id}（${id}.md）`);
			return;
		}
		case "set": {
			const [id, key, ...rest] = args;
			const value = rest.join(" ");
			if (!id || !key || !value)
				fail(
					"用法: set <id> <key> <value>（key: name/enabled/time/agent/model/prompt）",
				);
			const t = loadTask(id);
			assertOwnProject(t, id); // 编辑属写操作：项目隔离，禁止改其他项目任务
			if (key === "enabled") t.enabled = value === "true";
			else if (key === "time") t.schedule = { ...t.schedule, time: value };
			else if (key === "agent") t.agentId = value;
			else if (key === "name") t.name = value;
			else if (key === "project") t.projectId = value;
			else if (key === "model") t.model = value;
			else if (key === "prompt") t.prompt = value;
			else if (key === "im-push")
				t.prompt = injectImPushMentions(t.prompt, [value]);
			else fail(`不支持的字段: ${key}`);
			const content = serializeTask(t, t.prompt);
			parseTask(content, id, t.file); // 写前校验
			atomicWrite(t.file, content);
			console.log(`已更新任务: ${id}`);
			return;
		}
		case "validate": {
			loadTask(args[0] ?? fail("缺少任务 id"));
			console.log("校验通过");
			return;
		}
		case "test": {
			const t = loadTask(args[0] ?? fail("缺少任务 id"));
			const cron = toCron(t.schedule);
			console.log(`cron: ${cron}（本地时间）`);
			console.log("未来 5 次触发:");
			for (const d of nextRunTimes(cron, 5)) console.log(`  ${fmtTime(d)}`);
			return;
		}
		case "run": {
			const id = args[0] ?? fail("缺少任务 id");
			const base = kernelBaseUrl(); // 先确认 kernel 在线，再本地校验任务
			const t = loadTask(id);
			assertOwnProject(t, id); // 执行属操作：项目隔离，禁止运行其他项目任务
			const res = Bun.spawnSync([
				"curl",
				"-s",
				"-X",
				"POST",
				`${base}/api/scheduled-tasks/${encodeURIComponent(id)}/run`,
			]);
			if (res.exitCode !== 0) fail("触发请求失败（kernel 不可达？）");
			console.log(`已触发任务: ${id}（执行日志见 logs/${id}.log）`);
			return;
		}
		case "delete": {
			const id = args[0] ?? fail("缺少任务 id");
			// 路径穿越防护（id 即文件名）
			if (!id || id.includes("/") || id.includes("\\") || id.includes(".."))
				fail(`任务 id 非法: ${id}`);
			const file = join(TASKS_DIR, `${id}.md`);
			if (!existsSync(file)) fail(`任务不存在: ${id}`);
			// 项目隔离：能解析的正常任务校验归属；坏文件（无法解析归属）允许删（清理）；归属不符拒绝
			try {
				const t = loadTask(id);
				assertOwnProject(t, id);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (/不属于当前项目/.test(msg) || /id 非法/.test(msg)) fail(msg);
				// 其余（坏文件解析失败等 json.fail）→ 放行删除
			}
			rmSync(file, { force: true });
			console.log(`已删除任务: ${id}（${id}.md）`);
			return;
		}
		default:
			fail(`未知命令: ${cmd}（用 help 查看用法）`);
	}
}

try {
	main();
} catch (err) {
	fail(err instanceof Error ? err.message : String(err));
}
