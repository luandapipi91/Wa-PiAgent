// 会话列表重建工具（P0 事故善后）
//
// 背景：2026-09-20 一次「在仓库根裸跑 kernel 测试」绕过了包级 preload 的 WA_PI_DIR 隔离，
// 测试直接读写生产 ~/.pi/agent，把 projects.json 全量覆盖成空库——项目列表与会话列表
// 双双回初始化态（project-store.ts 注释里自证的「反复变空」事故链）。隔离已由根 bunfig
// 的 preload 修复，本脚本负责善后：把丢掉的列表从 sessions/*.jsonl 反推回来。
//
// 为什么能反推：kernel 的会话正文落盘在 <WA_PI_DIR>/sessions/s-<uuid>.jsonl，文件名即会话
// id，首行带 cwd 与创建时间，session_info 行带智能体名，首条真人消息可用于恢复标题。
// 项目则按 cwd 归一——workdir 下的会话属于默认工作区，其余每个 cwd 一个项目。
//
// 用法：
//   bun run scripts/rebuild-projects.ts                    # 预演，只打印摘要，不写盘
//   bun run scripts/rebuild-projects.ts --apply            # 落盘（先备份原文件）
//   bun run scripts/rebuild-projects.ts --dir <WA_PI_DIR>  # 指定数据目录（默认 $WA_PI_DIR 或 ~/.pi/agent）
//   bun run scripts/rebuild-projects.ts --project-id <cwd>=<原项目id>   # 复用事故前的项目 id（可重复）
//
// 取舍（恢复不是无损的，脚本会在摘要里如实说明）：
//   - 标题按首条消息重推，个别条目不如应用原先存的干净
//   - 历史上手动删过的会话，只要 jsonl 还在就会被恢复出来，需再删一次
//   - 项目名取目录名；有 knownProjects 则沿用其 id/name
import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";

/** 标题长度：与 kernel fillSessionTitleIfEmpty 的 `text.slice(0, 20)` 对齐 */
const TITLE_MAX = 20;
/** 标题只在文件前若干行里找，避免大文件全量解析 */
const TITLE_SCAN_LINES = 400;

export interface ScannedSession {
	id: string;
	cwd: string;
	createdAt: number;
	lastActivity: number;
	title: string;
	primaryAgent: string;
	piSessionFile: string;
}

export interface ProjectEntity {
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
}

export interface SessionEntity {
	id: string;
	projectId: string;
	primaryAgent: string;
	title: string;
	createdAt: number;
	lastActivity: number;
	piSessionFile: string;
	/** 仅重建过程内部用于归组/调试，落盘前剥离（kernel 的 SessionEntity 无此字段） */
	cwd?: string;
}

export interface ProjectsData {
	projects: ProjectEntity[];
	sessions: SessionEntity[];
}

export interface KnownProject {
	cwd: string;
	id: string;
	name?: string;
}

const DEFAULT_AGENT = "高级项目经理";

/** 从 content（string | 块数组）取纯文本 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: string; text: string } => {
				const v = c as { type?: unknown; text?: unknown };
				return v?.type === "text" && typeof v.text === "string";
			})
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/**
 * 由 cwd 派生稳定的项目 id（uuid v5 形态）。
 * 幂等：同一 cwd 反复重建得到同一 id，不会每次跑出一个新项目。
 */
export function projectIdFromCwd(cwd: string): string {
	const b = createHash("sha1").update(`wa-pi-project:${cwd}`).digest().subarray(0, 16);
	b[6] = (b[6] & 0x0f) | 0x50; // version 5
	b[8] = (b[8] & 0x3f) | 0x80; // variant
	const hex = b.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 扫描 sessions 目录，反推每条会话记录。
 * 只认 s-*.jsonl（kernel 会话）；裸 uuid 是 pi 内部子会话，不属于会话列表。
 */
export function scanSessions(sessionsDir: string): ScannedSession[] {
	let files: string[];
	try {
		files = readdirSync(sessionsDir);
	} catch {
		return [];
	}
	const out: ScannedSession[] = [];
	for (const f of files) {
		if (!/^s-.*\.jsonl$/.test(f)) continue;
		const path = join(sessionsDir, f);
		let lines: string[];
		try {
			lines = readFileSync(path, "utf8").split("\n");
		} catch {
			continue;
		}
		let head: { cwd?: string; timestamp?: string };
		try {
			head = JSON.parse(lines[0] ?? "{}");
		} catch {
			continue; // 半截/损坏文件跳过
		}
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}

		let title = "";
		let primaryAgent = "";
		for (let i = 1; i < Math.min(lines.length, TITLE_SCAN_LINES); i++) {
			const line = lines[i];
			if (!line) continue;
			let row: {
				type?: string;
				name?: string;
				message?: { role?: string; content?: unknown };
			};
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (row.type === "session_info" && !primaryAgent) {
				const n = row.name ?? "";
				primaryAgent = n.includes("-s-") ? n.slice(0, n.indexOf("-s-")) : n;
			}
			if (row.type === "message" && row.message?.role === "user" && !title) {
				const t = textOf(row.message.content).trim();
				// 跳过 <skill …> / <system-reminder> 之类注入块，取首条真人输入
				if (!t || t.startsWith("<")) continue;
				title = t.slice(0, TITLE_MAX);
			}
		}

		out.push({
			id: basename(f, ".jsonl"),
			cwd: head.cwd ?? "",
			createdAt: Date.parse(head.timestamp ?? "") || Math.round(mtimeMs),
			lastActivity: Math.round(mtimeMs),
			title,
			primaryAgent: primaryAgent || DEFAULT_AGENT,
			piSessionFile: path,
		});
	}
	return out;
}

/**
 * 重建 projects + sessions。
 * 项目集合 = workdir（默认工作区）+ 每个出现过的 cwd 一个项目；knownProjects 的 id/name 优先。
 */
export function rebuildProjectsData(opts: {
	sessionsDir: string;
	workdir: string;
	knownProjects?: KnownProject[];
}): ProjectsData {
	const { sessionsDir, workdir, knownProjects = [] } = opts;
	const scans = scanSessions(sessionsDir);

	const system: ProjectEntity = {
		id: SYSTEM_PROJECT_ID,
		name: SYSTEM_PROJECT_NAME,
		cwd: workdir,
		createdAt: 0,
	};
	const byCwd = new Map<string, ProjectEntity>([[workdir, system]]);

	const resolve = (cwd: string): ProjectEntity => {
		const known = knownProjects.find((k) => k.cwd === cwd);
		if (known) {
			const p: ProjectEntity = {
				id: known.id,
				name: known.name ?? basename(cwd),
				cwd,
				createdAt: 0,
			};
			byCwd.set(cwd, p);
			return p;
		}
		const hit = byCwd.get(cwd);
		if (hit) return hit;
		const p: ProjectEntity = {
			id: projectIdFromCwd(cwd),
			name: basename(cwd) || cwd,
			cwd,
			createdAt: 0,
		};
		byCwd.set(cwd, p);
		return p;
	};

	const sessions: SessionEntity[] = scans
		.map((s) => {
			const inWorkdir = s.cwd === workdir || s.cwd.startsWith(workdir.replace(/\/+$/, "") + "/");
			const project = inWorkdir ? system : resolve(s.cwd);
			return {
				id: s.id,
				cwd: s.cwd,
				projectId: project.id,
				primaryAgent: s.primaryAgent,
				title: s.title,
				createdAt: s.createdAt,
				lastActivity: s.lastActivity,
				piSessionFile: s.piSessionFile,
			};
		})
		.sort((a, b) => a.createdAt - b.createdAt);

	// 项目创建时间取该项目最早会话，便于列表稳定排序
	for (const p of byCwd.values()) {
		const mine = sessions.filter((s) => s.projectId === p.id).map((s) => s.createdAt);
		p.createdAt = mine.length ? Math.min(...mine) : Date.now();
	}
	const projects = [...byCwd.values()];

	return { projects, sessions };
}

/**
 * 与现有 projects.json 合并：
 *   - projects：现有非空则以其为准（避免把用户改过的项目名/顺序冲掉）
 *   - sessions：以重建结果为主，现有同 id 记录字段优先（kernel 实写的 title/lastActivity 更准）；
 *     现有中不在重建结果里的（sessions 目录已无对应文件）也保留
 */
export function mergeProjectsData(rebuilt: ProjectsData, current: ProjectsData): ProjectsData {
	const curMap = new Map(current.sessions.map((s) => [s.id, s]));
	const merged = rebuilt.sessions.map((s) => {
		const c = curMap.get(s.id);
		if (!c) return s;
		return {
			...s,
			...c,
			lastActivity: Math.round(c.lastActivity ?? s.lastActivity),
			cwd: s.cwd ?? c.cwd,
		};
	});
	for (const s of current.sessions) {
		if (!merged.some((m) => m.id === s.id)) merged.push(s);
	}
	return {
		projects: current.projects?.length ? current.projects : rebuilt.projects,
		sessions: merged,
	};
}

/** 落盘前剥离仅用于重建过程的字段 */
function toPersisted(data: ProjectsData): ProjectsData {
	return {
		projects: data.projects,
		sessions: data.sessions.map(({ cwd: _cwd, ...rest }) => rest),
	};
}

export function summarize(data: ProjectsData, sessionsDir: string): string {
	const lines: string[] = [];
	lines.push(`扫描目录：${sessionsDir}`);
	lines.push(`项目 ${data.projects.length} 个 / 会话 ${data.sessions.length} 条`);
	for (const p of data.projects) {
		const n = data.sessions.filter((s) => s.projectId === p.id).length;
		lines.push(`  ${p.name}（${n} 条）${p.cwd}`);
	}
	const noTitle = data.sessions.filter((s) => !s.title).length;
	if (noTitle) lines.push(`  注意：${noTitle} 条会话推不出标题（可能首条消息是注入块或已损坏）`);
	return lines.join("\n");
}

export interface CliOptions {
	waPiDir: string;
	apply: boolean;
	knownProjects: KnownProject[];
}

export function parseArgs(argv: string[]): CliOptions {
	const home = process.env.WA_PI_DIR || join(homedir(), ".pi", "agent");
	const opts: CliOptions = { waPiDir: home, apply: false, knownProjects: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--apply") opts.apply = true;
		else if (a === "--dir") opts.waPiDir = argv[++i] ?? opts.waPiDir;
		else if (a === "--project-id") {
			// 形如 /path/to/proj=6e2a77df-…（可选再跟 =项目名）
			const raw = argv[++i] ?? "";
			const eq = raw.indexOf("=");
			if (eq > 0) {
				const cwd = raw.slice(0, eq);
				const rest = raw.slice(eq + 1);
				const eq2 = rest.indexOf("=");
				opts.knownProjects.push(
					eq2 > 0
						? { cwd, id: rest.slice(0, eq2), name: rest.slice(eq2 + 1) }
						: { cwd, id: rest },
				);
			}
		}
	}
	return opts;
}

export function runRebuild(opts: CliOptions): { data: ProjectsData; backupPath?: string } {
	const sessionsDir = join(opts.waPiDir, "sessions");
	const workdir = join(opts.waPiDir, "workdir");
	const projectsFile = join(opts.waPiDir, "projects.json");

	let current: ProjectsData = { projects: [], sessions: [] };
	if (existsSync(projectsFile)) {
		try {
			const raw = JSON.parse(readFileSync(projectsFile, "utf8"));
			current = { projects: raw.projects ?? [], sessions: raw.sessions ?? [] };
		} catch {
			// 文件存在但读不动：不静默当成空库去覆盖（这正是事故成因），交由调用方决策
			throw new Error(`${projectsFile} 无法解析，已中止以免覆盖——请人工检查后再跑`);
		}
	}

	// 沿用现有项目 id：否则重建按 cwd 派生新 id，会话会挂到「projects 里不存在的项目」上。
	// 显式 --project-id 放前面（rebuildProjectsData 取首个匹配，故显式参数优先）。
	const knownFromCurrent: KnownProject[] = (current.projects ?? []).map((p) => ({
		cwd: p.cwd,
		id: p.id,
		name: p.name,
	}));
	const rebuilt = rebuildProjectsData({
		sessionsDir,
		workdir,
		knownProjects: [...opts.knownProjects, ...knownFromCurrent],
	});

	const data = mergeProjectsData(rebuilt, current);
	if (!opts.apply) return { data };

	const backupPath = `${projectsFile}.before-rebuild.bak`;
	if (existsSync(projectsFile)) copyFileSync(projectsFile, backupPath);
	const tmp = `${projectsFile}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(toPersisted(data), null, 2), "utf8");
	renameSync(tmp, projectsFile);
	return { data, backupPath };
}

if (import.meta.main) {
	const opts = parseArgs(process.argv.slice(2));
	const sessionsDir = join(opts.waPiDir, "sessions");
	try {
		const { data, backupPath } = runRebuild(opts);
		console.log(summarize(data, sessionsDir));
		if (opts.apply) {
			console.log(`\n已写入 ${join(opts.waPiDir, "projects.json")}`);
			if (backupPath) console.log(`原文件备份：${backupPath}`);
		} else {
			console.log("\n（预演，未写盘。确认无误后加 --apply 落盘）");
		}
	} catch (e) {
		console.error(`重建失败：${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
