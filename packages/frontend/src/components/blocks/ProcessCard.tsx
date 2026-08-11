import type { ReactNode } from "react";
import { Icon } from "../ui/Icon";

export type ProcessTone = "accent" | "success" | "warning" | "danger";

const TONE_STYLE: Record<ProcessTone, { iconBg: string; iconColor: string }> = {
	accent: { iconBg: "var(--accent-soft)", iconColor: "var(--accent)" },
	success: { iconBg: "var(--success-soft)", iconColor: "var(--success)" },
	warning: { iconBg: "var(--warning-soft)", iconColor: "var(--warning)" },
	danger: { iconBg: "var(--danger-soft)", iconColor: "var(--danger)" },
};

/** 12px 加载转圈，用于卡片 meta 区 */
export function Spinner() {
	return (
		<span
			className="inline-block w-3 h-3 rounded-full flex-shrink-0"
			style={{
				border: "2px solid var(--accent-soft)",
				borderTopColor: "var(--accent)",
				animation: "spin 0.8s linear infinite",
			}}
		/>
	);
}

/**
 * cocode 式过程卡片基座：图标方块（tone 着色）+ 标题 + 右侧 meta（状态/耗时）+ chevron。
 * 展开时 body 以顶部细线与头部隔开；muted（回合结束/历史）时整体弱化。
 */
export function ProcessCard(props: {
	tone: ProcessTone;
	icon: ReactNode;
	title: ReactNode;
	meta?: ReactNode;
	open: boolean;
	onToggle: () => void;
	muted?: boolean;
	testId?: string;
	children?: ReactNode;
}) {
	const { tone, icon, title, meta, open, onToggle, muted, testId, children } =
		props;
	const t = TONE_STYLE[tone];
	return (
		<div
			data-testid={testId}
			data-muted={muted || undefined}
			className={`rounded-lg border border-hairline bg-surface transition-opacity ${muted ? "opacity-55" : ""}`}
		>
			<button
				type="button"
				onClick={onToggle}
				data-testid={testId ? `${testId}-header` : undefined}
				className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left select-none"
				style={{ cursor: "pointer" }}
			>
				<span
					className="w-5 h-5 rounded flex items-center justify-center text-[calc(11px*var(--font-scale))] flex-shrink-0"
					style={{ background: t.iconBg, color: t.iconColor }}
				>
					{icon}
				</span>
				<span className="text-[calc(12px*var(--font-scale))] text-primary min-w-0 truncate">
					{title}
				</span>
				<span className="ml-auto inline-flex items-center gap-1.5 text-[calc(11px*var(--font-scale))] text-tertiary flex-shrink-0">
					{meta}
				</span>
				<span
					className="text-tertiary inline-flex"
					style={{ fontSize: "calc(10px * var(--font-scale))" }}
				>
					<Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
				</span>
			</button>
			{open && children != null && (
				<div
					className="px-3 py-2 border-t border-hairline text-[calc(12px*var(--font-scale))] text-secondary min-w-0 [overflow-wrap:anywhere]"
					data-testid={testId ? `${testId}-body` : undefined}
				>
					{children}
				</div>
			)}
		</div>
	);
}
