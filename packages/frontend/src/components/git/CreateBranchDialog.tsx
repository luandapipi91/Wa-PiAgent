import { useState } from "react";
import { isValidBranchName } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";

interface Props {
	onClose: () => void;
	/** 创建并切换；抛错视为失败（不关闭对话框，由调用方 toast 提示） */
	onCreate: (name: string) => Promise<void>;
}

/**
 * 创建并检出新分支对话框。
 * 前端用 isValidBranchName（简化版 check-ref-format）预判，非法即禁用提交；
 * 后端仍以 git 实际结果为准。
 */
export function CreateBranchDialog({ onClose, onCreate }: Props) {
	const { t } = useTranslation();
	const [name, setName] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const valid = isValidBranchName(name);
	// 只有用户输入过内容但非法时才提示，避免一打开就红字
	const showInvalid = name.length > 0 && !valid;

	const submit = async () => {
		if (!valid || submitting) return;
		setSubmitting(true);
		try {
			await onCreate(name);
			onClose();
		} catch {
			// 失败不关闭，保留输入供用户修改
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal onClose={onClose} width={440} data-testid="create-branch-dialog">
			<div className="p-4 border-b border-hairline flex items-center justify-between">
				<div className="text-primary font-bold text-sm">
					{t("git.createTitle")}
				</div>
				<button
					onClick={onClose}
					className="text-tertiary text-xs"
					aria-label={t("common.close")}
				>
					✕
				</button>
			</div>
			<div className="p-4 flex flex-col gap-2">
				<div className="text-sm text-secondary leading-relaxed">
					{t("git.createDesc")}
				</div>
				<input
					data-testid="branch-name-input"
					value={name}
					autoFocus
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit();
					}}
					placeholder={t("git.branchNamePlaceholder")}
					className="w-full bg-surface border border-hairline rounded-sm px-2.5 py-1.5 outline-none text-[calc(12px*var(--font-scale))] text-primary"
				/>
				{showInvalid ? (
					<div className="text-[calc(11px*var(--font-scale))] text-danger">
						{t("git.invalidBranchName")}
					</div>
				) : (
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary">
						{t("git.createHint")}
					</div>
				)}
			</div>
			<div className="flex justify-end gap-2 p-3 border-t border-hairline">
				<button
					onClick={onClose}
					className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
				>
					{t("common.cancel")}
				</button>
				<button
					data-testid="btn-create-branch-confirm"
					onClick={() => void submit()}
					disabled={!valid || submitting}
					className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					style={{ background: "var(--brand)", color: "var(--on-brand)" }}
				>
					{t("git.createConfirm")}
				</button>
			</div>
		</Modal>
	);
}
