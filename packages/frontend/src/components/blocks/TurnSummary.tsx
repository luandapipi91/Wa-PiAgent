import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";

/** 时长格式化：<60s → "45 秒"；>=60s → "2 分 15 秒"。
 *  secLabel/minLabel 可选，用于本地化单位（默认中文，保持导出函数的测试兼容）。 */
export function formatElapsed(
	ms: number,
	labels?: {
		seconds?: (sec: number) => string;
		minutesSeconds?: (min: number, sec: number) => string;
	},
): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) {
		return labels?.seconds ? labels.seconds(totalSec) : `${totalSec} 秒`;
	}
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return labels?.minutesSeconds
		? labels.minutesSeconds(min, sec)
		: `${min} 分 ${sec} 秒`;
}

/**
 * 轮级折叠摘要行：一轮完成后，中间过程（思考/工具调用/delegate/fleet）折叠为一行。
 * 折叠态显示「本轮时长 X · N 个步骤」（无时长显示「本轮过程 · N 个步骤」），
 * 点击展开显示 children（各过程卡片，可再逐个展开）。仅用于已定稿行。
 */
export function TurnSummary({
	steps,
	elapsedMs,
	children,
}: {
	steps: number;
	elapsedMs?: number;
	children: React.ReactNode;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center gap-2 text-[calc(11px*var(--font-scale))] text-tertiary select-none"
				data-testid="turn-summary"
			>
				<span className="flex-1 border-t border-hairline" />
				<span className="whitespace-nowrap">
					{elapsedMs != null
						? t("blocks.turnSummary.withDuration", {
								elapsed: formatElapsed(elapsedMs, {
									seconds: (s) => t("blocks.turnSummary.seconds", { sec: s }),
									minutesSeconds: (m, s) =>
										t("blocks.turnSummary.minutesSeconds", { min: m, sec: s }),
								}),
								steps,
							})
						: t("blocks.turnSummary.processOnly", { steps })}
				</span>
				<span className="flex-1 border-t border-hairline" />
			</button>
			{open && <div className="flex flex-col gap-1.5">{children}</div>}
		</div>
	);
}
