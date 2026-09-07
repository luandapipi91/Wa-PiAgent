import { useEffect, useRef, useState } from "react";
import type { ProjectEntity } from "@wa-pi/shared";
import { ApiError } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
import { useGitStore } from "../../store/git";
import { useToastStore } from "../../store/toast";
import { Icon } from "../ui/Icon";
import { BranchChip } from "./BranchChip";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { GitGraphModal } from "./GitGraphModal";

interface Props {
	project: ProjectEntity;
}

/**
 * 会话视图顶部 Git 工具栏：拉取最新代码 + 项目 chip + 分支 chip + ··· 菜单。
 * status 未加载或非 git 仓库（isRepo=false）时不渲染。
 */
export function GitToolbar({ project }: Props) {
	const { t } = useTranslation();
	const entry = useGitStore((s) => s.byProject[project.id]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [graphOpen, setGraphOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	// 挂载即拉取 git 状态
	useEffect(() => {
		void useGitStore.getState().refresh(project.id);
	}, [project.id]);

	// ··· 菜单外部点击关闭
	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (ev: MouseEvent) => {
			if (!menuRef.current?.contains(ev.target as Node)) setMenuOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [menuOpen]);

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
			{/* 拉取最新代码 */}
			<button
				type="button"
				data-testid="btn-git-pull"
				disabled={pulling}
				onClick={() => void handlePull()}
				className="min-w-0 flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[calc(12px*var(--font-scale))] cursor-pointer transition-colors bg-surface-elevated text-secondary border-hairline hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<Icon name="refresh" size={12} className="flex-none" />
				<span className="truncate">
					{pulling ? t("git.pulling") : t("git.pullLatest")}
				</span>
			</button>
			{/* 项目 chip */}
			<span
				data-testid="git-project-chip"
				className="min-w-0 flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[calc(12px*var(--font-scale))] bg-surface-elevated text-secondary border-hairline"
			>
				<Icon name="folder" size={12} className="flex-none" />
				<span className="max-w-[140px] truncate">{project.name}</span>
			</span>
			{/* 分支 chip */}
			<BranchChip
				current={currentBranch}
				branches={branches}
				onSwitch={(b) => void handleSwitch(b)}
				onCreateBranch={() => setCreateOpen(true)}
				onOpenGraph={() => setGraphOpen(true)}
			/>
			{/* ··· 菜单 */}
			<div className="relative flex-none" ref={menuRef}>
				<button
					type="button"
					data-testid="git-more-menu-btn"
					onClick={() => setMenuOpen((o) => !o)}
					className="flex items-center rounded-pill border px-2 py-1 text-[calc(12px*var(--font-scale))] cursor-pointer transition-colors bg-surface-elevated text-secondary border-hairline hover:text-primary"
				>
					···
				</button>
				{menuOpen && (
					<div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] bg-surface-elevated border border-hairline rounded-md shadow-lg p-1">
						<div
							data-testid="git-menu-graph"
							onClick={() => {
								setMenuOpen(false);
								setGraphOpen(true);
							}}
							className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary hover:bg-surface-hover text-[calc(12px*var(--font-scale))]"
						>
							<Icon name="gitGraph" size={12} />
							{t("git.graph")}
						</div>
						<div
							data-testid="git-menu-refresh"
							onClick={() => {
								setMenuOpen(false);
								void useGitStore.getState().refresh(project.id);
							}}
							className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary hover:bg-surface-hover text-[calc(12px*var(--font-scale))]"
						>
							<Icon name="refresh" size={12} />
							{t("git.refresh")}
						</div>
					</div>
				)}
			</div>
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
