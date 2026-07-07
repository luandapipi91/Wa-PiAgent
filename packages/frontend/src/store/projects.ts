import { create } from "zustand";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { send } from "../ws-instance";
import { pickDirectoryOrPrompt, basename } from "../pick-directory";

interface ProjectsState {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  load: () => void;
  setAll: (projects: ProjectEntity[], sessions: SessionEntity[]) => void;
  createProject: (name: string, cwd: string) => void;
  createProjectFromDir: () => Promise<void>;
  addProject: (p: ProjectEntity) => void;
  addSession: (s: SessionEntity) => void;
  selectProject: (id: string) => void;
  selectSession: (id: string) => void;
  setCurrentSessionId: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  load: () => send({ type: "projects:list" }),
  setAll: (projects, sessions) => set({ projects, sessions }),
  createProject: (name, cwd) => send({ type: "project:create", name, cwd }),
  // 新建项目：弹目录选择器（Tauri）或 prompt 输入（非 Tauri），项目名取 basename
  createProjectFromDir: async () => {
    const cwd = await pickDirectoryOrPrompt();
    if (!cwd) return;
    const name = basename(cwd);
    send({ type: "project:create", name, cwd });
  },
  addProject: (p) => set(s => ({ projects: [...s.projects, p], currentProjectId: p.id })),
  addSession: (sess) => set(s => ({
    sessions: [...s.sessions, sess],
    currentSessionId: sess.id,
    currentProjectId: sess.projectId,
  })),
  selectProject: (id) => set({ currentProjectId: id }),
  selectSession: (id) => set({ currentSessionId: id }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
