import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

/**
 * 「过程输出」凸起标签（仅精简输出模式）：挂在最终回复卡片右上角，与卡片连体
 * （上/左/右边框，无下边框），双上箭头表示可向上展开本轮的正式输出；展开后箭头翻转。
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
			className="absolute -top-[17px] right-5 z-10 h-[17px] px-2 inline-flex items-center justify-center border border-b-0 border-hairline bg-surface text-tertiary hover:text-secondary select-none"
			style={{ borderRadius: "4px 4px 0 0" }}
		>
			<span className="flex flex-col items-center -my-0.5">
				<Icon name={chevron} size={8} />
				<Icon name={chevron} size={8} className="-mt-1" />
			</span>
		</button>
	);
}
