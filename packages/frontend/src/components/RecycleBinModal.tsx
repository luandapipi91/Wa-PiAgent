import { useEffect, useState } from "react";
import { Modal } from "./ui/Modal";
import { Icon } from "./ui/Icon";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { TrashSessionRow } from "./TrashSessionRow";
import { TrashMessageViewer } from "./TrashMessageViewer";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onClose: () => void;
}

export function RecycleBinModal({ onClose }: Props) {
	const { t } = useTranslation();
	const store = useTrashStore();
	const [confirmEmpty, setConfirmEmpty] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		void store.loadTrash();
	}, []);

	// 消息查看器模式
	if (store.viewerSessionId) {
		return (
			<Modal
				onClose={() => store.closeViewer()}
				width="80vw"
				height="80vh"
				closeOnOverlayClick={true}
			>
				<TrashMessageViewer
					sessionId={store.viewerSessionId}
					onBack={() => store.closeViewer()}
				/>
			</Modal>
		);
	}

	const selectedCount = store.selectedIds.size;
	const totalPages = Math.max(1, Math.ceil(store.total / store.pageSize));

	return (
		<Modal
			onClose={onClose}
			width="80vw"
			height="80vh"
			data-testid="recycle-bin-modal"
		>
			<div className="flex flex-col h-full">
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
					<div className="flex items-center gap-2">
						<Icon name="trash" size={18} className="text-primary" />
						<span className="text-base font-semibold text-primary">
							{t("trash.title")}
						</span>
						{store.total > 0 && (
							<span className="text-xs text-tertiary">
								{t("trash.total", { count: store.total })}
							</span>
						)}
					</div>
					<button
						onClick={onClose}
						className="w-8 h-8 rounded bg-surface-hover text-tertiary hover:text-primary inline-flex items-center justify-center"
						data-testid="trash-close"
					>
						<Icon name="x" size={12} />
					</button>
				</div>

				{/* Toolbar: project tabs */}
				<div className="flex items-center justify-between px-5 py-2 border-b border-hairline gap-3">
					<div className="flex gap-1 flex-wrap">
						<button
							onClick={() => store.setProjectFilter(null)}
							className={`text-xs px-3 py-1 rounded-full border ${
								store.activeProjectId === null
									? "bg-brand text-white border-brand"
									: "bg-surface border-hairline text-tertiary"
							}`}
							data-testid="trash-filter-all"
						>
							{t("trash.filterAll")}
						</button>
						{store.projects.map((p) => (
							<button
								key={p.id}
								onClick={() => store.setProjectFilter(p.id)}
								className={`text-xs px-3 py-1 rounded-full border ${
									store.activeProjectId === p.id
										? "bg-brand text-white border-brand"
										: "bg-surface border-hairline text-tertiary"
								}`}
							>
								{p.name}
							</button>
						))}
					</div>
				</div>

				{/* List */}
				<div className="flex-1 overflow-y-auto px-5 py-2">
					{store.loading ? (
						<div className="flex items-center justify-center h-full text-tertiary">
							...
						</div>
					) : store.sessions.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-tertiary gap-2">
							<Icon name="inbox" size={48} />
							<span>{t("trash.empty")}</span>
						</div>
					) : (
						<>
							<div className="flex items-center gap-2 py-2 text-xs text-tertiary border-b border-hairline mb-1">
								<button
									onClick={() => store.selectAllOnPage()}
									className="hover:text-brand"
								>
									{t("trash.selectAll")}
								</button>
								{selectedCount > 0 && (
									<span>
										(
										{t("trash.selected", {
											selected: selectedCount,
											total: store.total,
										})}
										)
									</span>
								)}
							</div>
							{store.sessions.map((s) => (
								<TrashSessionRow
									key={s.id}
									session={s}
									project={store.projects.find((p) => p.id === s.projectId)}
									selected={store.selectedIds.has(s.id)}
									onToggleSelect={store.toggleSelect}
									onView={store.openViewer}
								/>
							))}
						</>
					)}
				</div>

				{/* Pagination */}
				{store.total > store.pageSize && (
					<div className="flex items-center justify-between px-5 py-2 border-t border-hairline text-xs text-tertiary">
						<span>
							{t("trash.total", { count: store.total })} ·{" "}
							{store.currentPage + 1}/{totalPages}
						</span>
						<div className="flex gap-2">
							<button
								onClick={() => store.setPage(store.currentPage - 1)}
								disabled={store.currentPage === 0}
								className="px-3 py-1 rounded border border-hairline bg-surface disabled:opacity-40"
								data-testid="trash-prev-page"
							>
								‹ {t("trash.prevPage")}
							</button>
							<button
								onClick={() => store.setPage(store.currentPage + 1)}
								disabled={store.currentPage >= totalPages - 1}
								className="px-3 py-1 rounded border border-hairline bg-surface disabled:opacity-40"
								data-testid="trash-next-page"
							>
								{t("trash.nextPage")} ›
							</button>
						</div>
					</div>
				)}

				{/* Footer actions */}
				<div className="flex items-center gap-3 px-5 py-3 border-t border-hairline bg-surface">
					<button
						onClick={() =>
							selectedCount > 0 && void store.restore([...store.selectedIds])
						}
						disabled={selectedCount === 0}
						className="px-4 py-2 rounded text-sm disabled:opacity-40"
						style={{ background: "var(--brand)", color: "var(--on-brand)" }}
						data-testid="trash-restore-btn"
					>
						<Icon
							name="reply"
							size={14}
							className="inline-block align-[-0.125em]"
						/>{" "}
						{selectedCount > 0
							? t("trash.restoreCount", { count: selectedCount })
							: t("trash.restore")}
					</button>
					<button
						onClick={() => selectedCount > 0 && setConfirmDelete(true)}
						disabled={selectedCount === 0}
						className="px-4 py-2 rounded border border-danger text-danger text-sm disabled:opacity-40"
						data-testid="trash-delete-btn"
					>
						<Icon
							name="trash"
							size={14}
							className="inline-block align-[-0.125em]"
						/>{" "}
						{t("trash.delete")}
					</button>
					<button
						onClick={() => store.total > 0 && setConfirmEmpty(true)}
						disabled={store.total === 0}
						className="ml-auto px-4 py-2 rounded border border-hairline text-tertiary hover:border-danger hover:text-danger text-sm disabled:opacity-40"
						data-testid="trash-empty-btn"
					>
						<Icon
							name="bolt"
							size={14}
							className="inline-block align-[-0.125em]"
						/>{" "}
						{t("trash.emptyAll")}
					</button>
				</div>
			</div>

			{confirmEmpty && (
				<ConfirmDialog
					title={t("trash.confirmEmptyTitle")}
					message={t("trash.confirmEmptyMsg", { count: store.total })}
					confirmText={t("trash.emptyAll")}
					danger
					onConfirm={async () => {
						await store.emptyTrash();
						setConfirmEmpty(false);
					}}
					onCancel={() => setConfirmEmpty(false)}
				/>
			)}
			{confirmDelete && (
				<ConfirmDialog
					title={t("trash.confirmDeleteTitle")}
					message={t("trash.confirmDeleteMsg", { count: selectedCount })}
					confirmText={t("trash.delete")}
					danger
					onConfirm={async () => {
						await store.permanentlyDelete([...store.selectedIds]);
						setConfirmDelete(false);
					}}
					onCancel={() => setConfirmDelete(false)}
				/>
			)}
		</Modal>
	);
}
