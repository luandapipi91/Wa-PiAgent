import { create } from "zustand";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { api } from "../api-client";
import { basename } from "../pick-directory";
import { useToastStore } from "./toast";

interface ProjectsState {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  dirPickerOpen: boolean;
  load: () => void;
  setAll: (projects: ProjectEntity[], sessions: SessionEntity[]) => void;
  createProject: (name: string, cwd: string) => void;
  createProjectFromDir: () => void;
  closeDirPicker: () => void;
  createProjectFromPath: (cwd: string) => void;
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
  dirPickerOpen: false,
  load: () => { api.get("/api/projects").then((data: any) => { if (data) set({ projects: data.projects ?? [], sessions: data.sessions ?? [] }); }).catch(() => {}); },
  setAll: (projects, sessions) => set(s => {
    // 当前选中的会话若已从列表中删除，则清空 currentSessionId，触发视图切换到新建会话页
    const stillExists = s.currentSessionId && sessions.some(x => x.id === s.currentSessionId);
    return { projects, sessions, currentSessionId: stillExists ? s.currentSessionId : null };
  }),
  createProject: (name, cwd) => { void api.post("/api/projects", { name, cwd }); },
  // 新建项目：打开目录树选择器（DirTreePicker），用户点选目录后走 createProjectFromPath
  createProjectFromDir: () => { set({ dirPickerOpen: true }); },
  closeDirPicker: () => set({ dirPickerOpen: false }),
  // 目录树点选后：项目名取 basename，发 project:create（cwd 重复时 toast 提示）
  createProjectFromPath: (cwd: string) => {
    set({ dirPickerOpen: false });
    if (useProjectsStore.getState().projects.some(p => p.cwd === cwd)) {
      useToastStore.getState().add("相同目录的项目已存在");
      return;
    }
    const name = basename(cwd);
    void api.post("/api/projects", { name, cwd });
  },
  addProject: (p) => set(s => {
    // cwd 去重：同一目录的项目已存在则忽略（kernel 也会拒绝重复创建）
    if (s.projects.some(x => x.cwd === p.cwd)) return s;
    return { projects: [...s.projects, p], currentProjectId: p.id };
  }),
  addSession: (sess) => set(s => {
    // 去重：同 id session 已存在则忽略（kernel 可能重复广播 session:created）
    if (s.sessions.some(x => x.id === sess.id)) return s;
    return {
      sessions: [...s.sessions, sess],
      currentSessionId: sess.id,
      currentProjectId: sess.projectId,
    };
  }),
  selectProject: (id) => set({ currentProjectId: id }),
  selectSession: (id) => set({ currentSessionId: id }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
