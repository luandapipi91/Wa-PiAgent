import { useEffect, useState } from "react";
import type { ProjectEntity } from "@wa-pi/shared";
import { ApiError } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
import { useGitStore } from "../../store/git";
import { useToastStore } from "../../store/toast";
import { BranchChip } from "./BranchChip";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { GitGraphModal } from "./GitGraphModal";

interface Props {
	project: ProjectEntity;
}

/**
 * 会话视图顶部 Git 工具栏：仅分支 chip 单入口，拉取/刷新等操作收进分支下拉菜单。
 * status 未加载或非 git 仓库（isRepo=false）时不渲染。
 */
export function GitToolbar({ project }: Props) {
	const { t } = useTranslation();
	const entry = useGitStore((s) => s.byProject[project.id]);
	const [createOpen, setCreateOpen] = useState(false);
	const [graphOpen, setGraphOpen] = useState(false);

	// 挂载即拉取 git 状态
	useEffect(() => {
		void useGitStore.getState().refresh(project.id);
	}, [project.id]);

	const status = entry?.status;
	if (!status || !status.isRepo) return null;

	const pulling = entry?.pulling ?? false;
	const currentBranch = entry?.branches?.current ?? status.branch;
	const branches = entry?.branches?.branches ?? [currentBranch];

	const toast = (msg: string, type: "error" | "success" = "success") =>
		useToastStore.getState().add(msg, type);

	const handlePull = async () => {
		try {
			const r = await useGitStore.getState().pull(project.id);
			if (r.alreadyUpToDate) {
				toast(t("git.pullUpToDate"));
			} else {
				toast(
					t("git.pullSummary", {
						from: r.from ?? "",
						to: r.to ?? "",
						files: r.filesChanged,
						insertions: r.insertions,
						deletions: r.deletions,
					}),
				);
			}
		} catch (e) {
			// 结构化 git 错误时展示 stderr 原文（如 "Your local changes ... would
			// be overwritten"），而非光秃秃的错误码；换行/连续空白压成单空格防
			// toast 断词错乱，超长截断
			const failure = e instanceof ApiError ? e.failure : undefined;
			const raw =
				failure?.code === "git.pullFailed" && failure.detail
					? failure.detail
					: e instanceof Error
						? e.message
						: String(e);
			const flat = raw.replace(/\s+/g, " ").trim();
			const errText = flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
			toast(t("git.pullFailed", { error: errText }), "error");
		}
	};

	const handleSwitch = async (branch: string) => {
		try {
			await useGitStore.getState().checkout(project.id, branch);
		} catch (e) {
			toast(
				t("git.checkoutFailed", {
					error: e instanceof Error ? e.message : String(e),
				}),
				"error",
			);
		}
	};

	const handleCreate = async (name: string) => {
		try {
			await useGitStore.getState().createBranch(project.id, name);
		} catch (e) {
			toast(
				t("git.createFailed", {
					error: e instanceof Error ? e.message : String(e),
				}),
				"error",
			);
			throw e; // 让对话框保持打开
		}
	};

	return (
		<div
			className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0"
			data-testid="git-toolbar"
		>
			{/* 分支 chip（唯一入口） */}
			<BranchChip
				current={currentBranch}
				branches={branches}
				onSwitch={(b) => void handleSwitch(b)}
				onCreateBranch={() => setCreateOpen(true)}
				onOpenGraph={() => setGraphOpen(true)}
				pulling={pulling}
				onPull={() => void handlePull()}
				onRefresh={() => void useGitStore.getState().refresh(project.id)}
			/>
			{/* 弹窗 */}
			{createOpen && (
				<CreateBranchDialog
					onClose={() => setCreateOpen(false)}
					onCreate={handleCreate}
				/>
			)}
			{graphOpen && (
				<GitGraphModal projectId={project.id} onClose={() => setGraphOpen(false)} />
			)}
		</div>
	);
}
