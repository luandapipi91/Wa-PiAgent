import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_FILE } from "@hiagent/shared";
import type { ProjectEntity, SessionEntity, AgentName } from "@hiagent/shared";

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
    const project: ProjectEntity = {
      id: randomUUID(), name: input.name, cwd: input.cwd, createdAt: Date.now(),
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
  }): Promise<SessionEntity> {
    const data = await this.load();
    const now = Date.now();
    const session: SessionEntity = {
      id: randomUUID(), projectId: input.projectId,
      primaryAgent: input.primaryAgent, title: input.title,
      createdAt: now, lastActivity: now,
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

  async deleteSession(id: string): Promise<void> {
    const data = await this.load();
    data.sessions = data.sessions.filter(s => s.id !== id);
    await this.save(data);
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
