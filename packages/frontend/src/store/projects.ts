import { create } from "zustand";
import i18n from "../i18n";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";
import { api } from "../api-client";
import { basename } from "../pick-directory";
import { useToastStore } from "./toast";
import { useSkillsStore } from "./skills";

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

// 整表替换 sessions 时防「快照滞后挤掉乐观会话」的合并保护。
function mergeSessions(
	s: Pick<ProjectsState, "currentSessionId" | "sessions">,
	sessions: SessionEntity[],
): SessionEntity[] {
	// 防御性过滤：剥离软删除会话，确保当前列表只展示活跃会话。
	// 后端 trash:list 单独返回回收站会话，主列表不应混入 deletedAt 项。
	// placeholder（「新开会话」预热时写入的空标题占位记录）同样不进侧栏：
	// 后端 loadActive 已过滤，这里再兜一层——历史遗留的未过滤来源
	// （如孤儿回滚广播）曾把占位当正常会话推送，渲染成一堆空白行。
	const active = sessions.filter((x) => !x.deletedAt && !x.placeholder);
	// 仅当 currentSessionId 指向但快照缺失，才把该会话合并回列表（防 SessionView 空白）。
	const currentMissing =
		s.currentSessionId &&
		!active.some((x) => x.id === s.currentSessionId) &&
		s.sessions.some((x) => x.id === s.currentSessionId);
	return currentMissing
		? [...active, ...s.sessions.filter((x) => x.id === s.currentSessionId)]
		: active;
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
					set((s) => ({
						projects: data.projects ?? [],
						sessions: mergeSessions(s, data.sessions ?? []),
					}));
			})
			.catch(() => {}),
	setAll: (projects, sessions) =>
		set((s) => {
			const merged = mergeSessions(s, sessions);
			return {
				projects,
				sessions: merged,
				currentSessionId:
					s.currentSessionId &&
					(merged.some((x) => x.id === s.currentSessionId) ||
						s.sessions.some((x) => x.id === s.currentSessionId))
						? s.currentSessionId
						: null,
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
			// 同 id 已存在：不重复 append，但要用内核记录覆盖本地乐观记录里的 createdAt。
			// 默认工作区会话的 cwd 由 createdAt 推导（workdir/<createdAt>），而前端乐观建会话用本地
			// Date.now()、内核在收到 prompt 后自己再取一次 Date.now() 并据此建目录 —— 两者恒差几毫秒。
			// 若这里单纯丢弃内核记录，前端会一直请求不存在的 workdir/<前端时间戳>，文件树恒空白
			// （且 5s 轮询不会自愈，只能等刷新页面 / 任意 projects:list 广播整表覆盖）。
			// 其余字段仍以本地为准，避免覆盖用户本地状态（lastActivity 由 touchSession 维护）。
			if (s.sessions.some((x) => x.id === sess.id)) {
				return {
					sessions: s.sessions.map((x) =>
						x.id === sess.id ? { ...x, createdAt: sess.createdAt } : x,
					),
				};
			}
			// 只 append 到列表，不自动选中：IM 渠道被动创建的会话（session:created 广播）
			// 不应抢占当前视图打扰用户；调用方需要选中时显式调 selectSession（NewSessionPane 已如此）。
			return { sessions: [...s.sessions, sess] };
		}),
	selectProject: (id) => {
		set({ currentProjectId: id });
		// 项目切换 → 技能页选中项目跟随（技能数据已全量在本地，不发请求）
		useSkillsStore.getState().setSelectedProject(id);
	},
	selectSession: (id) => {
		// 仅切换当前选中会话，不更新 lastActivity：点击查看不再视为活跃，
		// 只有发送消息（agent:prompt）或收到回复（message_end）才刷新 lastActivity
		// （驱动会话列表排序、时间显示、topAgentsByRecency）。
		const target = useProjectsStore.getState().sessions.find((x) => x.id === id);
		set(
			target
				? { currentSessionId: id, currentProjectId: target.projectId }
				: { currentSessionId: id },
		);
		// 会话切换 → 技能页选中项目跟随其所属项目（本地重算，无网络请求）
		if (target) useSkillsStore.getState().setSelectedProject(target.projectId);
	},
	setCurrentSessionId: (id) => set({ currentSessionId: id }),
	touchSession: (id) =>
		set((s) => {
			// 发消息/收到回复视为活跃：刷新该会话 lastActivity（驱动会话列表排序、时间显示、
			// topAgentsByRecency）。只在发送 agent:prompt 与 message_end 时调用，点击查看不再调用。
			// 目标不在列表（子代理/外部会话）时返回原 state：不再无条件 map 制造假引用变化
			// （trace 实测曾是侧边栏全量连坐重渲染的入口：SessionRow+ProjectItem 占主线程近半）。
			const target = s.sessions.find((x) => x.id === id);
			if (!target) return s;
			return {
				sessions: s.sessions.map((x) =>
					x.id === id ? { ...x, lastActivity: Date.now() } : x,
				),
			};
		}),
}));
