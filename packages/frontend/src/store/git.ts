// git store — 按 projectId 缓存仓库状态（status/branches），对接 kernel git REST 域。
// SSE git:changed（带 projectId）触发对应项目 refresh，挂接方式同 share-progress store。
import { create } from "zustand";
import type {
	GitBranchesResult,
	GitCommitInfo,
	GitLogResult,
	GitPullResult,
	GitStatusResult,
} from "@wa-pi/shared";
import { api } from "../api-client";
import { onEventType } from "../events";

/** 单个项目的 git 缓存条目 */
export interface GitProjectEntry {
	status: GitStatusResult | null;
	branches: GitBranchesResult | null;
	loading: boolean;
	pulling: boolean;
	error: string | null;
}

interface GitState {
	byProject: Record<string, GitProjectEntry>;
	refresh: (projectId: string) => Promise<void>;
	checkout: (projectId: string, branch: string) => Promise<void>;
	createBranch: (projectId: string, name: string) => Promise<void>;
	pull: (projectId: string) => Promise<GitPullResult>;
	loadLog: (projectId: string, limit: number) => Promise<GitCommitInfo[]>;
}

const EMPTY_ENTRY: GitProjectEntry = {
	status: null,
	branches: null,
	loading: false,
	pulling: false,
	error: null,
};

export const useGitStore = create<GitState>((set, get) => {
	/** 更新单个项目条目（不存在则以空条目起步） */
	const patch = (projectId: string, partial: Partial<GitProjectEntry>) =>
		set((s) => ({
			byProject: {
				...s.byProject,
				[projectId]: { ...(s.byProject[projectId] ?? EMPTY_ENTRY), ...partial },
			},
		}));

	return {
		byProject: {},
		// 两段式：先取 status，非 git 仓库（isRepo:false）直接落空结果返回，
		// 不再请求 branches——否则 branches 400 会把成功的 status 一并拖进 catch
		// 丢弃，且每次挂载都反复报 400；是仓库才继续拉分支列表
		refresh: async (projectId) => {
			patch(projectId, { loading: true, error: null });
			try {
				const status = (await api.get(
					`/api/projects/${projectId}/git/status`,
				)) as GitStatusResult;
				if (!status.isRepo) {
					patch(projectId, {
						status,
						branches: { current: "", branches: [] },
						loading: false,
					});
					return;
				}
				const branches = (await api.get(
					`/api/projects/${projectId}/git/branches`,
				)) as GitBranchesResult;
				patch(projectId, { status, branches, loading: false });
			} catch (e) {
				patch(projectId, {
					loading: false,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		},
		// 切换分支：成功后整量刷新（分支列表/状态都变了），失败向上抛由 UI 提示
		checkout: async (projectId, branch) => {
			await api.post(`/api/projects/${projectId}/git/checkout`, { branch });
			await get().refresh(projectId);
		},
		// 创建并检出新分支：kernel 端 create+checkout 一体，成功后整量刷新
		createBranch: async (projectId, name) => {
			await api.post(`/api/projects/${projectId}/git/branch`, { name });
			await get().refresh(projectId);
		},
		// 拉取最新：pulling 期间置位供按钮禁用；结束后刷新缓存并返回结果供轻提示。
		// 失败也刷新：gitStatus 缓存可能已过期（如 tracking 配置被外部 git 操作改动，
		// git-watcher 不监听 .git/config），不刷新会让界面挂着过期的 ahead/behind 计数
		pull: async (projectId) => {
			patch(projectId, { pulling: true });
			try {
				const result = (await api.post(
					`/api/projects/${projectId}/git/pull`,
				)) as GitPullResult;
				await get().refresh(projectId);
				return result;
			} catch (e) {
				await get()
					.refresh(projectId)
					.catch(() => {});
				throw e;
			} finally {
				patch(projectId, { pulling: false });
			}
		},
		// 拉取提交历史（Git 图谱用）；不缓存，由调用方（模态）持有分页状态
		loadLog: async (projectId, limit) => {
			const data = (await api.get(
				`/api/projects/${projectId}/git/log?limit=${limit}`,
			)) as GitLogResult;
			return data.commits ?? [];
		},
	};
});

// 模块加载即订阅（onEventType 内部幂等建立 SSE 连接）
onEventType("git:changed", (e) => {
	const projectId = (e as { projectId?: string }).projectId;
	if (projectId) void useGitStore.getState().refresh(projectId);
});
