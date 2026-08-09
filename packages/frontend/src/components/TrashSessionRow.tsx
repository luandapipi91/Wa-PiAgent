import { memo } from "react";
import type { SessionEntity, ProjectEntity } from "@wa-pi/shared";
import { agentDefOf, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	session: SessionEntity;
	project: ProjectEntity | undefined;
	selected: boolean;
	onToggleSelect: (id: string) => void;
	onView: (id: string) => void;
}

function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const day = 24 * 60 * 60 * 1000;
	if (diff < day) return `${Math.floor(diff / (60 * 60 * 1000))}h`;
	if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
	return `${Math.floor(diff / (7 * day))}w`;
}

export const TrashSessionRow = memo(function TrashSessionRow({
	session,
	project,
	selected,
	onToggleSelect,
	onView,
}: Props) {
	const { t } = useTranslation();
	const isIM = session.id.startsWith("im-");
	const def = agentDefOf(session.primaryAgent);
	const emoji = def?.emoji ?? "🤖";
	const projectName = project?.name ?? SYSTEM_PROJECT_NAME;
	const reason =
		session.deletedReason === "auto"
			? t("trash.reasonAuto")
			: t("trash.reasonManual");

	return (
		<div
			className={`flex items-center gap-3 px-3 py-2.5 rounded cursor-pointer transition-colors border ${
				selected
					? "bg-brand-soft border-brand"
					: "border-transparent hover:bg-surface-hover"
			}`}
			data-testid={`trash-row-${session.id}`}
			onClick={() => onToggleSelect(session.id)}
		>
			<input
				type="checkbox"
				checked={selected}
				onChange={() => onToggleSelect(session.id)}
				onClick={(e) => e.stopPropagation()}
				className="accent-brand shrink-0"
				data-testid={`trash-checkbox-${session.id}`}
			/>
			<span className="text-base shrink-0">{emoji}</span>
			<span className="text-sm font-medium truncate w-40 shrink-0">
				{isIM && "📱 "}
				{session.primaryAgent}
			</span>
			{isIM && (
				<span
					className="text-[10px] px-2 py-0.5 rounded-full bg-warning-soft text-warning border border-warning shrink-0"
					data-testid="trash-row-im-tag"
				>
					{t("trash.imTag")}
				</span>
			)}
			<span
				className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
				style={{
					backgroundColor: "rgba(75, 162, 111, 0.1)",
					color: "var(--brand)",
					border: "1px solid rgba(75, 162, 111, 0.25)",
				}}
			>
				{projectName}
			</span>
			<span className="flex-1 text-xs text-tertiary flex items-center gap-1 min-w-0">
				<span
					className={`text-[10px] px-1.5 py-0.5 rounded ${
						session.deletedReason === "auto"
							? "bg-warning-soft text-warning"
							: "bg-danger-soft text-danger"
					}`}
				>
					{reason}
				</span>
				{session.deletedAt && <span>· {relativeTime(session.deletedAt)}</span>}
			</span>
			<button
				onClick={(e) => {
					e.stopPropagation();
					onView(session.id);
				}}
				className="w-7 h-7 rounded border border-hairline bg-surface hover:border-brand text-xs shrink-0"
				title={t("trash.view")}
				data-testid={`trash-view-${session.id}`}
			>
				👁
			</button>
		</div>
	);
});
