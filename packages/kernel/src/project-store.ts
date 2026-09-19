import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_FILE, WA_PI_DIR, SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import type { ProjectEntity, SessionEntity, AgentName } from "@wa-pi/shared";
import { KernelError } from "./kernel-error";

interface ProjectsFile {
	projects: ProjectEntity[];
	sessions: SessionEntity[];
}

function empty(): ProjectsFile {
	return { projects: [], sessions: [] };
}

export class ProjectStore {
	constructor(private filePath: string = PROJECTS_FILE) {}

	/**
	 * 写互斥队列：串行化所有「读-改-写」操作。
	 * projects.json 是全量覆盖写，两个写操作在彼此的 await 窗口交叠时，
	 * 后写者会用旧快照覆盖前者的修改（lost update），
	 * Windows 上还会因目标/tmp 被并发打开而报 rename EPERM
	 * （典型：发消息链路的 createSession/fillSessionTitleIfEmpty 与 message_end
	 * 的 fire-and-forget touchSession 并发；曾致 Windows 客户机 "Send failed: EPERM"）。
	 * 所有公开写方法都必须包进 this.serialized()，新增写方法也不例外。
	 */
	private writeQueue: Promise<unknown> = Promise.resolve();
	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writeQueue.then(fn, fn);
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async load(): Promise<ProjectsFile> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const data = JSON.parse(raw) as ProjectsFile;
			return { projects: data.projects ?? [], sessions: data.sessions ?? [] };
		} catch {
			return empty();
		}
	}

	/**
	 * 写路径严格读：文件存在但读取/解析失败时抛错，而非回退空库。
	 * load() 的 catch-empty 只适用于纯只读展示；若写路径拿到空快照后写回，
	 * 会把整个 store 清空（projects.json 反复「变空」事故的根因）。
	 * 文件不存在（ENOENT，首次启动）仍是合法空库。
	 */
	private async loadStrict(): Promise<ProjectsFile> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const data = JSON.parse(raw) as ProjectsFile;
			return { projects: data.projects ?? [], sessions: data.sessions ?? [] };
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return empty();
			throw new KernelError(
				"project.storeReadFailed",
				{},
				e instanceof Error ? e.message : String(e),
			);
		}
	}

	private async save(data: ProjectsFile): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		// 原子写：先落临时文件再 rename，避免并发读读到半截 JSON
		// （load 解析失败会回退空数据，若后续写回会把整个 store 清空）
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		const json = JSON.stringify(data, null, 2);
		await writeFile(tmp, json, "utf8");
		// Windows：目标文件正被杀软实时扫描/并发读者短暂持有时，
		// rename(MoveFileEx) 报 EPERM，错误沿发送链路冒泡成 "Send failed: EPERM"。
		// 退避重试等句柄释放（50ms 起，最多重试 4 次）；Linux/macOS 的 rename
		// 是原子调用、不受已打开句柄影响，不会走到重试分支。
		let lastErr: unknown;
		for (let attempt = 0; attempt <= 4; attempt++) {
			try {
				await rename(tmp, this.filePath);
				return;
			} catch (e: any) {
				lastErr = e;
				if (e?.code !== "EPERM") throw e;
				await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
			}
		}
		throw lastErr;
	}

	async createProject(input: {
		name: string;
		cwd: string;
	}): Promise<ProjectEntity> {
		// 所有「读-改-写」写方法统一入队（见 writeQueue 注释）——
		// 未入队的写点与 touchSession 等并发时会互相用旧快照覆盖，
		// Windows 上还会撞出 rename EPERM
		return this.serialized(async () => {
			const data = await this.loadStrict();
			// cwd 去重：同一目录不允许重复添加
			if (data.projects.some((p) => p.cwd === input.cwd)) {
				throw new KernelError("project.duplicateCwd");
			}
			const project: ProjectEntity = {
				id: randomUUID(),
				name: input.name,
				cwd: input.cwd,
				createdAt: Date.now(),
			};
			data.projects.push(project);
			await this.save(data);
			return project;
		});
	}

	/**
	 * 创建固定 id 的系统项目（幂等）。
	 *
	 * 用于默认工作区：固定 id=SYSTEM_PROJECT_ID，绕过 createProject 的 cwd 去重
	 * 和 randomUUID id 生成。同 id 已存在则返回现有记录，不重复插入。
	 */
	async createSystemProject(input: {
		id: string;
		name: string;
		cwd: string;
	}): Promise<ProjectEntity> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const existing = data.projects.find((p) => p.id === input.id);
			if (existing) return existing;
			const project: ProjectEntity = {
				id: input.id,
				name: input.name,
				cwd: input.cwd,
				createdAt: Date.now(),
			};
			data.projects.push(project);
			await this.save(data);
			return project;
		});
	}

	async updateProject(
		id: string,
		patch: Partial<Pick<ProjectEntity, "name" | "cwd">>,
	): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const p = data.projects.find((x) => x.id === id);
			if (!p) throw new KernelError("project.notFound", { id });
			if (patch.name !== undefined) p.name = patch.name;
			if (patch.cwd !== undefined) p.cwd = patch.cwd;
			await this.save(data);
		});
	}

	async deleteProject(id: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			data.projects = data.projects.filter((p) => p.id !== id);
			// 软删除该项目下的活跃会话（移入回收站，而非物理删除）
			for (const session of data.sessions) {
				if (session.projectId === id && !session.deletedAt) {
					session.deletedAt = Date.now();
					session.deletedReason = "manual";
				}
			}
			await this.save(data);
		});
	}

	async createSession(input: {
		projectId: string;
		primaryAgent: AgentName;
		title: string;
		id?: string;
		createdAt?: number; // 默认工作区用：让 mkdir 用的 ts 与 session.createdAt 严格一致
		placeholder?: boolean; // getCommands 预热兜底用：标记为占位记录，loadActive 过滤
		source?: "im" | "scheduler"; // 会话来源：scheduler 不进侧栏（loadActive 过滤）
	}): Promise<SessionEntity> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const id = input.id ?? randomUUID();
			// 去重：同 id session 已存在则返回已有记录（幂等），避免 getCommands 兜底分支
			// 用 agentName 作 title 重复创建，覆盖正常会话标题
			const existing = data.sessions.find((s) => s.id === id);
			if (existing) return existing;
			const now = input.createdAt ?? Date.now();
			const session: SessionEntity = {
				id,
				projectId: input.projectId,
				primaryAgent: input.primaryAgent,
				title: input.title,
				createdAt: now,
				lastActivity: now,
				piSessionFile: `${WA_PI_DIR}/sessions/${id}.jsonl`,
				...(input.placeholder ? { placeholder: true } : {}),
				...(input.source ? { source: input.source } : {}),
			};
			data.sessions.push(session);
			await this.save(data);
			return session;
		});
	}

	async renameSession(id: string, title: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === id);
			if (!s) throw new KernelError("session.notFound", { sessionId: id });
			s.title = title;
			await this.save(data);
		});
	}

	/**
	 * 仅当会话标题为空时填充——用于兜底创建（标题留空）的会话，
	 * 在用户首次发送消息时用消息内容自动命名。已有标题（用户手动命名或已填充）不动。
	 * @returns true 表示标题被填充（调用方可据此广播 projects:list 刷新侧栏）
	 */
	async fillSessionTitleIfEmpty(id: string, title: string): Promise<boolean> {
		if (!title || !title.trim()) return false;
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === id);
			if (!s) return false;
			if (s.title && s.title.trim()) return false; // 已有标题，不覆盖
			s.title = title.trim();
			delete s.placeholder; // 预热占位记录转正：有真实消息后进侧栏
			await this.save(data);
			return true;
		});
	}

	async setSessionAgent(id: string, agentName: AgentName): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === id);
			if (!s) throw new KernelError("session.notFound", { sessionId: id });
			s.primaryAgent = agentName;
			await this.save(data);
		});
	}

	/** 纠正会话归属项目（agent:prompt 一致性：占位会话被另一项目接管时以请求为准）。
	 *  仅用于无真实内容的占位会话；真实会话跨项目由上层拒绝，不调用本方法。 */
	async setSessionProjectId(id: string, projectId: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === id);
			if (!s) throw new KernelError("session.notFound", { sessionId: id });
			s.projectId = projectId;
			await this.save(data);
		});
	}

	async deleteSession(id: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const session = data.sessions.find((s) => s.id === id);
			if (session) {
				session.deletedAt = Date.now();
				session.deletedReason = "manual";
			}
			await this.save(data);
		});
	}

	/**
	 * 孤儿会话回滚专用：仅当会话仍是预热占位（placeholder=true）时才软删。
	 * 防止误伤「用户创建后还没来得及发消息」的正常会话——此类会话一旦被
	 * 恢复/接管/转正，placeholder 已清，不再属于可清理的占位垃圾。
	 * @returns true 表示执行了删除；false 表示会话不存在或非占位记录，不动
	 */
	async deleteSessionIfPlaceholder(id: string): Promise<boolean> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const session = data.sessions.find((s) => s.id === id);
			if (!session || !session.placeholder) return false;
			session.deletedAt = Date.now();
			session.deletedReason = "manual";
			await this.save(data);
			return true;
		});
	}

	/**
	 * 加载全部数据，但会话只返回未软删除的（deletedAt 为空）。
	 * 用于侧栏列表等只关心可见会话的场景。
	 */
	async loadActive(): Promise<ProjectsFile> {
		const data = await this.load();
		return {
			projects: data.projects,
			// 过滤软删除 + 预热占位记录（getCommands 兜底创建、尚无消息的会话）
			// + 定时任务执行会话（独立于侧栏，只在执行记录里查看；存量数据靠 sched- 前缀兑底）
			sessions: data.sessions.filter(
				(s) =>
					!s.deletedAt &&
					!s.placeholder &&
					s.source !== "scheduler" &&
					!s.id.startsWith("sched-"),
			),
		};
	}

	/**
	 * 从回收站恢复会话：清空 deletedAt/deletedReason。
	 * 若会话原属项目已不存在，则归入默认工作区（SYSTEM_PROJECT_ID）。
	 * 对未删除的会话调用为 no-op（仅清空本就为空的字段）。
	 */
	async restoreSession(id: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const session = data.sessions.find((s) => s.id === id);
			if (session) {
				// 如果原项目已被删除，恢复到默认工作区
				if (!data.projects.find((p) => p.id === session.projectId)) {
					session.projectId = SYSTEM_PROJECT_ID;
				}
				session.deletedAt = undefined;
				session.deletedReason = undefined;
				// 恢复视为重新活动：续期 lastActivity，避免下次启动扫描按旧活动时间再次自动归档
				session.lastActivity = Date.now();
			}
			await this.save(data);
		});
	}

	/**
	 * 彻底删除：从存储中物理移除指定会话记录。
	 * 不存在的 id 静默忽略。空数组直接返回。
	 */
	async permanentlyDeleteSessions(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		return this.serialized(async () => {
			const idSet = new Set(ids);
			const data = await this.loadStrict();
			data.sessions = data.sessions.filter((s) => !idSet.has(s.id));
			await this.save(data);
		});
	}

	/**
	 * 清空回收站：物理移除所有已软删除（deletedAt 非空）的会话。
	 * @returns 实际移除的会话数量
	 */
	async emptyTrash(): Promise<number> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const before = data.sessions.length;
			data.sessions = data.sessions.filter((s) => !s.deletedAt);
			const removed = before - data.sessions.length;
			await this.save(data);
			return removed;
		});
	}

	/**
	 * 分页查询回收站：返回所有已软删除的会话，支持按项目过滤与 offset/limit 分页。
	 * 结果按 deletedAt 倒序（最近删除的在前），total 为过滤后的总数（不受分页影响）。
	 */
	async loadTrash(opts?: {
		projectId?: string;
		offset?: number;
		limit?: number;
	}): Promise<{ sessions: SessionEntity[]; total: number }> {
		const data = await this.load();
		let deleted = data.sessions.filter((s) => s.deletedAt);
		if (opts?.projectId) {
			deleted = deleted.filter((s) => s.projectId === opts.projectId);
		}
		// 按 deletedAt 倒序（最近删除的在前）
		deleted.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
		const total = deleted.length;
		const offset = opts?.offset ?? 0;
		const limit = opts?.limit ?? 100;
		const sessions = deleted.slice(offset, offset + limit);
		return { sessions, total };
	}

	/**
	 * 自动归档：将超过阈值未活动且未删除的会话标记为软删除（deletedReason="auto"）。
	 * @param thresholdMs 不活动阈值（毫秒），如 7 天
	 * @returns 本次被归档的会话列表
	 */
	async archiveStaleSessions(thresholdMs: number): Promise<SessionEntity[]> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const cutoff = Date.now() - thresholdMs;
			const archived: SessionEntity[] = [];
			for (const session of data.sessions) {
				if (!session.deletedAt && session.lastActivity < cutoff) {
					session.deletedAt = Date.now();
					session.deletedReason = "auto";
					archived.push(session);
				}
			}
			if (archived.length > 0) await this.save(data);
			return archived;
		});
	}

	/**
	 * 自动清理：永久删除 deletedAt 早于 purgeBefore 的回收站会话。
	 * @param purgeBefore 时间点（毫秒），早于此点的已删除会话将被物理移除
	 * @returns 实际移除的会话数量
	 */
	async purgeOldTrashSessions(purgeBefore: number): Promise<number> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const before = data.sessions.length;
			data.sessions = data.sessions.filter(
				(s) => !s.deletedAt || s.deletedAt >= purgeBefore,
			);
			const removed = before - data.sessions.length;
			if (removed > 0) await this.save(data);
			return removed;
		});
	}

	// 改 session 归属项目（老数据迁移用：孤儿 session 归入默认项目）
	async reassignSession(sessionId: string, projectId: string): Promise<void> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === sessionId);
			if (s) {
				s.projectId = projectId;
				await this.save(data);
			}
		});
	}

	/**
	 * 刷新会话活动时间。
	 * @returns 会话是否存在；若会话处于自动归档状态则同时恢复它并返回 true（供调用方广播列表刷新）
	 */
	async touchSession(id: string): Promise<boolean> {
		return this.serialized(async () => {
			const data = await this.loadStrict();
			const s = data.sessions.find((x) => x.id === id);
			if (!s) return false;
			// 自动归档的会话一旦有新活动即自动恢复，回到活跃列表（手动删除的不复活）
			const revived = Boolean(s.deletedAt && s.deletedReason === "auto");
			if (revived) {
				s.deletedAt = undefined;
				s.deletedReason = undefined;
			}
			s.lastActivity = Date.now();
			await this.save(data);
			return revived;
		});
	}
}
