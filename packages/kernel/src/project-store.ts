import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_FILE, WA_PI_DIR, SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import type { ProjectEntity, SessionEntity, AgentName } from "@wa-pi/shared";

interface ProjectsFile {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
}

function empty(): ProjectsFile {
  return { projects: [], sessions: [] };
}

export class ProjectStore {
  constructor(private filePath: string = PROJECTS_FILE) {}

  async load(): Promise<ProjectsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as ProjectsFile;
      return { projects: data.projects ?? [], sessions: data.sessions ?? [] };
    } catch {
      return empty();
    }
  }

  private async save(data: ProjectsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async createProject(input: { name: string; cwd: string }): Promise<ProjectEntity> {
    const data = await this.load();
    // cwd 去重：同一目录不允许重复添加
    if (data.projects.some(p => p.cwd === input.cwd)) {
      throw new Error("相同目录的项目已存在");
    }
    const project: ProjectEntity = {
      id: randomUUID(), name: input.name, cwd: input.cwd, createdAt: Date.now(),
    };
    data.projects.push(project);
    await this.save(data);
    return project;
  }

  /**
   * 创建固定 id 的系统项目（幂等）。
   *
   * 用于默认工作区：固定 id=SYSTEM_PROJECT_ID，绕过 createProject 的 cwd 去重
   * 和 randomUUID id 生成。同 id 已存在则返回现有记录，不重复插入。
   */
  async createSystemProject(input: {
    id: string; name: string; cwd: string;
  }): Promise<ProjectEntity> {
    const data = await this.load();
    const existing = data.projects.find(p => p.id === input.id);
    if (existing) return existing;
    const project: ProjectEntity = {
      id: input.id, name: input.name, cwd: input.cwd,
      createdAt: Date.now(),
    };
    data.projects.push(project);
    await this.save(data);
    return project;
  }

  async updateProject(id: string, patch: Partial<Pick<ProjectEntity, "name" | "cwd">>): Promise<void> {
    const data = await this.load();
    const p = data.projects.find(x => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.cwd !== undefined) p.cwd = patch.cwd;
    await this.save(data);
  }

  async deleteProject(id: string): Promise<void> {
    const data = await this.load();
    data.projects = data.projects.filter(p => p.id !== id);
    data.sessions = data.sessions.filter(s => s.projectId !== id);
    await this.save(data);
  }

  async createSession(input: {
    projectId: string; primaryAgent: AgentName; title: string;
    id?: string;
    createdAt?: number;   // 默认工作区用：让 mkdir 用的 ts 与 session.createdAt 严格一致
  }): Promise<SessionEntity> {
    const data = await this.load();
    const id = input.id ?? randomUUID();
    // 去重：同 id session 已存在则返回已有记录（幂等），避免 getCommands 兜底分支
    // 用 agentName 作 title 重复创建，覆盖正常会话标题
    const existing = data.sessions.find(s => s.id === id);
    if (existing) return existing;
    const now = input.createdAt ?? Date.now();
    const session: SessionEntity = {
      id, projectId: input.projectId,
      primaryAgent: input.primaryAgent, title: input.title,
      createdAt: now, lastActivity: now,
      piSessionFile: `${WA_PI_DIR}/sessions/${id}.jsonl`,
    };
    data.sessions.push(session);
    await this.save(data);
    return session;
  }

  async renameSession(id: string, title: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) throw new Error(`会话不存在: ${id}`);
    s.title = title;
    await this.save(data);
  }

  /**
   * 仅当会话标题为空时填充——用于兜底创建（标题留空）的会话，
   * 在用户首次发送消息时用消息内容自动命名。已有标题（用户手动命名或已填充）不动。
   * @returns true 表示标题被填充（调用方可据此广播 projects:list 刷新侧栏）
   */
  async fillSessionTitleIfEmpty(id: string, title: string): Promise<boolean> {
    if (!title || !title.trim()) return false;
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) return false;
    if (s.title && s.title.trim()) return false; // 已有标题，不覆盖
    s.title = title.trim();
    await this.save(data);
    return true;
  }

  async setSessionAgent(id: string, agentName: AgentName): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) throw new Error(`会话不存在: ${id}`);
    s.primaryAgent = agentName;
    await this.save(data);
  }

  async deleteSession(id: string): Promise<void> {
    const data = await this.load();
    const session = data.sessions.find(s => s.id === id);
    if (session) {
      session.deletedAt = Date.now();
      session.deletedReason = "manual";
    }
    await this.save(data);
  }

  /**
   * 加载全部数据，但会话只返回未软删除的（deletedAt 为空）。
   * 用于侧栏列表等只关心可见会话的场景。
   */
  async loadActive(): Promise<ProjectsFile> {
    const data = await this.load();
    return {
      projects: data.projects,
      sessions: data.sessions.filter(s => !s.deletedAt),
    };
  }

  /**
   * 从回收站恢复会话：清空 deletedAt/deletedReason。
   * 若会话原属项目已不存在，则归入默认工作区（SYSTEM_PROJECT_ID）。
   * 对未删除的会话调用为 no-op（仅清空本就为空的字段）。
   */
  async restoreSession(id: string): Promise<void> {
    const data = await this.load();
    const session = data.sessions.find(s => s.id === id);
    if (session) {
      // 如果原项目已被删除，恢复到默认工作区
      if (!data.projects.find(p => p.id === session.projectId)) {
        session.projectId = SYSTEM_PROJECT_ID;
      }
      session.deletedAt = undefined;
      session.deletedReason = undefined;
    }
    await this.save(data);
  }

  /**
   * 彻底删除：从存储中物理移除指定会话记录。
   * 不存在的 id 静默忽略。空数组直接返回。
   */
  async permanentlyDeleteSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const data = await this.load();
    data.sessions = data.sessions.filter(s => !idSet.has(s.id));
    await this.save(data);
  }

  /**
   * 清空回收站：物理移除所有已软删除（deletedAt 非空）的会话。
   * @returns 实际移除的会话数量
   */
  async emptyTrash(): Promise<number> {
    const data = await this.load();
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(s => !s.deletedAt);
    const removed = before - data.sessions.length;
    await this.save(data);
    return removed;
  }

  // 改 session 归属项目（老数据迁移用：孤儿 session 归入默认项目）
  async reassignSession(sessionId: string, projectId: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === sessionId);
    if (s) { s.projectId = projectId; await this.save(data); }
  }

  async touchSession(id: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (s) { s.lastActivity = Date.now(); await this.save(data); }
  }
}
