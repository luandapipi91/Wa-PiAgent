import { create } from "zustand";
import i18n from "../i18n";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";
import { api } from "../api-client";
import { basename } from "../pick-directory";
import { useToastStore } from "./toast";

interface ProjectsState {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  dirPickerOpen: boolean;
  load: () => Promise<void>;
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
  load: () => api.get("/api/projects").then((data: any) => { if (data) set({ projects: data.projects ?? [], sessions: data.sessions ?? [] }); }).catch(() => {}),
  setAll: (projects, sessions) => set(s => {
    // 防御性过滤：剥离软删除会话，确保当前列表只展示活跃会话。
    // 后端 trash:list 单独返回回收站会话，主列表不应混入 deletedAt 项。
    const active = sessions.filter(x => !x.deletedAt);
    // 当前选中的会话若已从列表中删除，则清空 currentSessionId，触发视图切换到新建会话页
    const stillExists = s.currentSessionId && active.some(x => x.id === s.currentSessionId);
    return { projects, sessions: active, currentSessionId: stillExists ? s.currentSessionId : null };
  }),
  createProject: (name, cwd) => { void api.post("/api/projects", { name, cwd }); },
  // 新建项目：打开目录树选择器（DirTreePicker），用户点选目录后走 createProjectFromPath
  createProjectFromDir: () => { set({ dirPickerOpen: true }); },
  closeDirPicker: () => set({ dirPickerOpen: false }),
  // 目录树点选后：项目名取 basename，发 project:create（cwd 重复时 toast 提示）
  createProjectFromPath: (cwd: string) => {
    set({ dirPickerOpen: false });
    if (useProjectsStore.getState().projects.some(p => p.cwd === cwd)) {
      useToastStore.getState().add(i18n.t("store.duplicateProjectCwd"));
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
    // 只 append 到列表，不自动选中：IM 渠道被动创建的会话（session:created 广播）
    // 不应抢占当前视图打扰用户；调用方需要选中时显式调 selectSession（NewSessionPane 已如此）。
    return { sessions: [...s.sessions, sess] };
  }),
  selectProject: (id) => set({ currentProjectId: id }),
  selectSession: (id) => set(s => {
    // 激活会话视为活跃：乐观更新该会话 lastActivity，驱动会话列表时间显示与排序
    // （ProjectItem 按 lastActivity 倒序、SessionRow 显示相对时间、topAgentsByRecency）。
    // 后端 ws-server 在 session:messages 时已 touchSession 同步磁盘，此处保证前端立即一致。
    const target = s.sessions.find(x => x.id === id);
    if (!target) return { currentSessionId: id };
    return {
      currentSessionId: id,
      sessions: s.sessions.map(x => x.id === id ? { ...x, lastActivity: Date.now() } : x),
    };
  }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
