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
	touchSession: (id: string) => void;
	setCurrentSessionId: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
	projects: [],
	sessions: [],
	currentProjectId: null,
	currentSessionId: null,
	dirPickerOpen: false,
	load: () =>
		api
			.get("/api/projects")
			.then((data: any) => {
				if (data)
					set({ projects: data.projects ?? [], sessions: data.sessions ?? [] });
			})
			.catch(() => {}),
	setAll: (projects, sessions) =>
		set((s) => {
			// 防御性过滤：剥离软删除会话，确保当前列表只展示活跃会话。
			// 后端 trash:list 单独返回回收站会话，主列表不应混入 deletedAt 项。
			const active = sessions.filter((x) => !x.deletedAt);
			// 当前选中的会话若已从列表中删除，则清空 currentSessionId，触发视图切换到新建会话页。
			// 但仅当「新列表和旧 store 都没有」才清——kernel projects:list 快照可能滞后
			// （新会话乐观添加后 placeholder 尚未转正），旧 store 有该会话说明是暂时不可见，
			// 清了会让新会话首次发送闪回新建页（输入丢失）。真删除由删除 handler 显式清。
			const stillExists =
				s.currentSessionId &&
				(active.some((x) => x.id === s.currentSessionId) ||
			s.sessions.some((x) => x.id === s.currentSessionId));
			return {
				projects,
				sessions: active,
				currentSessionId: stillExists ? s.currentSessionId : null,
			};
		}),
	createProject: (name, cwd) => {
		void api.post("/api/projects", { name, cwd });
	},
	// 新建项目：Electron 下用系统目录选择对话框（原生），浏览器回退目录树选择器（DirTreePicker）
	createProjectFromDir: async () => {
		const show = window.waPiApp?.showOpenDirectoryDialog;
		if (!show) {
			set({ dirPickerOpen: true });
			return;
		}
		const dir = await show();
		if (dir) useProjectsStore.getState().createProjectFromPath(dir);
	},
	closeDirPicker: () => set({ dirPickerOpen: false }),
	// 目录树点选后：项目名取 basename，发 project:create（cwd 重复时 toast 提示）
	createProjectFromPath: (cwd: string) => {
		set({ dirPickerOpen: false });
		if (useProjectsStore.getState().projects.some((p) => p.cwd === cwd)) {
			useToastStore.getState().add(i18n.t("store.duplicateProjectCwd"));
			return;
		}
		const name = basename(cwd);
		void api.post("/api/projects", { name, cwd });
	},
	addProject: (p) =>
		set((s) => {
			// cwd 去重：同一目录的项目已存在则忽略（kernel 也会拒绝重复创建）
			if (s.projects.some((x) => x.cwd === p.cwd)) return s;
			return { projects: [...s.projects, p], currentProjectId: p.id };
		}),
	addSession: (sess) =>
		set((s) => {
			// 去重：同 id session 已存在则忽略（kernel 可能重复广播 session:created）
			if (s.sessions.some((x) => x.id === sess.id)) return s;
			// 只 append 到列表，不自动选中：IM 渠道被动创建的会话（session:created 广播）
			// 不应抢占当前视图打扰用户；调用方需要选中时显式调 selectSession（NewSessionPane 已如此）。
			return { sessions: [...s.sessions, sess] };
		}),
	selectProject: (id) => set({ currentProjectId: id }),
	selectSession: (id) =>
		set((s) => {
			// 仅切换当前选中会话，不更新 lastActivity：点击查看不再视为活跃，
			// 只有发送消息（agent:prompt）或收到回复（message_end）才刷新 lastActivity
			// （驱动会话列表排序、时间显示、topAgentsByRecency）。
			const target = s.sessions.find((x) => x.id === id);
			if (!target) return { currentSessionId: id };
			return {
				currentSessionId: id,
				currentProjectId: target.projectId,
			};
		}),
	setCurrentSessionId: (id) => set({ currentSessionId: id }),
	touchSession: (id) =>
		set((s) => ({
			// 发消息/收到回复视为活跃：刷新该会话 lastActivity（驱动会话列表排序、时间显示、
			// topAgentsByRecency）。只在发送 agent:prompt 与 message_end 时调用，点击查看不再调用。
			sessions: s.sessions.map((x) =>
				x.id === id ? { ...x, lastActivity: Date.now() } : x,
			),
		})),
}));
