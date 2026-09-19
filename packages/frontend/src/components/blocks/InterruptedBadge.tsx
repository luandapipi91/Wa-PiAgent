import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

/** 「已中断」徽标：delegate/fleet 子代理非正常终态（中止/超时/异常）的第三种终态视觉，
 *  与成功（check）、失败（x）并列。琥珀警示色（warning token），hover 提示部分结果已保留。 */
export function InterruptedBadge() {
	const { t } = useTranslation();
	return (
		<span
			data-testid="interrupted-badge"
			title={t("common.interruptedHint")}
			className="inline-flex items-center gap-0.5 rounded px-1 flex-shrink-0 bg-warning-soft text-warning border border-warning/30 font-semibold text-[calc(10px*var(--font-scale))]"
		>
			<Icon name="stop" size={9} />
			<span>{t("common.statusInterrupted")}</span>
		</span>
	);
}
