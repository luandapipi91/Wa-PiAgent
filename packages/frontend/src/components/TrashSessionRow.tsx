import { memo } from "react";
import type { SessionEntity, ProjectEntity } from "@wa-pi/shared";
import { agentDefOf, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";
import { Icon } from "./ui/Icon";
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
	const emoji = def?.emoji;
	const projectName = project?.name ?? SYSTEM_PROJECT_NAME;
	const reason =
		session.deletedReason === "auto"
			? t("trash.reasonAuto")
			: t("trash.reasonManual");

	// 选中态下标签样式（半透明白底 + 白字）
	const tagStyle = selected
		? {
				backgroundColor: "rgba(255,255,255,0.2)",
				color: "#fff",
				border: "1px solid rgba(255,255,255,0.35)",
			}
		: { backgroundColor: undefined, color: undefined, border: undefined };

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
			<span className="text-base shrink-0">
				{emoji ?? <Icon name="robot" size="1em" />}
			</span>
			<span
				className={`text-sm font-medium truncate w-40 shrink-0 ${selected ? "text-white" : ""}`}
			>
				{isIM && (
					<>
						<Icon
							name="smartphone"
							size="1em"
							className="inline-block align-[-0.125em]"
						/>{" "}
					</>
				)}
				{session.primaryAgent}
			</span>
			{isIM && (
				<span
					className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${
						selected ? "" : "bg-warning-soft text-warning border-warning"
					}`}
					style={selected ? tagStyle : undefined}
					data-testid="trash-row-im-tag"
				>
					{t("trash.imTag")}
				</span>
			)}
			<span
				className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
				style={
					selected
						? tagStyle
						: {
								backgroundColor: "var(--accent-soft)",
								color: "var(--accent)",
								border: "1px solid var(--hairline)",
							}
				}
			>
				{projectName}
			</span>
			<span
				className={`flex-1 text-xs flex items-center gap-1 min-w-0 ${selected ? "text-white/80" : "text-tertiary"}`}
			>
				<span
					className={`text-[10px] px-1.5 py-0.5 rounded ${
						selected
							? ""
							: session.deletedReason === "auto"
								? "bg-warning-soft text-warning"
								: "bg-danger-soft text-danger"
					}`}
					style={selected ? tagStyle : undefined}
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
				className={`w-7 h-7 rounded border text-xs shrink-0 inline-flex items-center justify-center ${
					selected
						? "border-white/40 bg-white/15 text-white hover:bg-white/25"
						: "border-hairline bg-surface hover:border-brand"
				}`}
				title={t("trash.view")}
				data-testid={`trash-view-${session.id}`}
			>
				<Icon name="eye" size={14} />
			</button>
		</div>
	);
});
