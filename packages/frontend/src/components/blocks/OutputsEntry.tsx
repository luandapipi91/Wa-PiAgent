import { useTranslation } from "../../i18n/useTranslation";

/**
 * 「过程输出」入口行（仅精简输出模式）：与 TurnSummary 同款的左右细线 + 中间灰字，
 * 点开只展开本轮的正式输出文本，不展开思考过程与工具调用。
 */
export function OutputsEntry({
	count,
	open,
	onToggle,
	anchorRef,
}: {
	count: number;
	open: boolean;
	onToggle: () => void;
	/** 锚点 ref：由调用方用 togglePreservingViewport 包裹 onToggle，展开/折叠时保持视口位置 */
	anchorRef?: React.RefObject<HTMLButtonElement | null>;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			ref={anchorRef}
			data-testid="outputs-entry"
			aria-expanded={open}
			onClick={onToggle}
			className="w-full flex items-center gap-2 text-[calc(11px*var(--font-scale))] text-tertiary select-none"
		>
			<span className="flex-1 border-t border-hairline" />
			<span className="whitespace-nowrap inline-flex items-center gap-1.5">
				<span className="text-secondary">
					{t("message.outputs.title", { count })}
				</span>
				<span className="inline-flex items-center gap-0.5 text-[calc(10px*var(--font-scale))] px-1.5 py-px border border-hairline rounded-sm bg-surface-elevated text-secondary">
					{t(open ? "message.outputs.collapse" : "message.outputs.expand")}
				</span>
			</span>
			<span className="flex-1 border-t border-hairline" />
		</button>
	);
}
