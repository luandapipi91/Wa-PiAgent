import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

/**
 * 「过程输出」凸起标签（仅精简输出模式）：挂在整块回复区域的右上角（收起/展开都在
 * 同一位置——展开时过程输出卡片与正文拼成一块，标签仍是这一整块的上沿）。
 * 与下方卡片连体（上/左/右边框、无下边框），双箭头表示可展开/收起本轮正式输出。
 * 条数不占视觉，放在 aria-label / title 里。
 */
export function OutputsTab({
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
	const label = t("message.outputs.title", { count });
	const chevron = open ? "chevron-down" : "chevron-up";
	return (
		<button
			type="button"
			ref={anchorRef}
			data-testid="outputs-tab"
			aria-expanded={open}
			aria-label={label}
			title={label}
			onClick={onToggle}
			className="absolute -top-[17px] right-3 z-10 h-[17px] px-2 inline-flex items-center justify-center border border-b-0 border-hairline bg-surface text-tertiary hover:text-secondary select-none"
			style={{ borderRadius: "4px 4px 0 0" }}
		>
			<span className="flex flex-col items-center -my-0.5">
				<Icon name={chevron} size={8} />
				<Icon name={chevron} size={8} className="-mt-1" />
			</span>
		</button>
	);
}
