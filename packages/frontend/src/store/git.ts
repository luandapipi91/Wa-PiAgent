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
		// 拉取 status + branches；失败只记录 error，不抛出（工具栏按 error 弱化展示）
		refresh: async (projectId) => {
			patch(projectId, { loading: true, error: null });
			try {
				const [status, branches] = await Promise.all([
					api.get(`/api/projects/${projectId}/git/status`) as Promise<GitStatusResult>,
					api.get(`/api/projects/${projectId}/git/branches`) as Promise<GitBranchesResult>,
				]);
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
		// 拉取最新：pulling 期间置位供按钮禁用；结束后刷新缓存并返回结果供轻提示
		pull: async (projectId) => {
			patch(projectId, { pulling: true });
			try {
				const result = (await api.post(
					`/api/projects/${projectId}/git/pull`,
				)) as GitPullResult;
				await get().refresh(projectId);
				return result;
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
