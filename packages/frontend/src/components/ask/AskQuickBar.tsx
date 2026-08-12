import { useState } from "react";
import { api } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
import { buildQuickReply } from "../../store/ask";
import type { PendingAsk } from "../../store/ask";

interface Props {
	sessionId: string;
	ask: PendingAsk;
	stale: boolean;
	onExpand: () => void;
	/** 选中变化回调（父层收集，展开时传给 AskFormCard.initialSelected） */
	onSelectedChange?: (sel: Record<number, Set<string>>) => void;
}

/** 单行便签（折叠态）：内嵌快捷选项 + 提交 icon。
 *  全部问题选齐后手动点提交（不自动提交，避免误触）。
 *  只处理单个 ask；多 ask 场景由 AskDock 决定降级为纯提示。 */
export function AskQuickBar({ sessionId, ask, stale, onExpand, onSelectedChange }: Props) {
	const { t } = useTranslation();
	const [quickSel, setQuickSel] = useState<Record<number, Set<string>>>({});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const params = ask.params;
	const totalQuestions = params.questions.length;

	const toggle = (qi: number, label: string, multi: boolean) => {
		const cur = new Set(quickSel[qi] ?? []);
		if (multi) {
			cur.has(label) ? cur.delete(label) : cur.add(label);
		} else {
			cur.clear();
			cur.add(label);
		}
		const next = { ...quickSel, [qi]: cur };
		setQuickSel(next);
		onSelectedChange?.(next);
	};

	const allAnswered =
		!stale &&
		params.questions.every((_, i) => (quickSel[i]?.size ?? 0) > 0);

	const handleSubmit = async () => {
		if (!allAnswered || submitting) return;
		const reply = buildQuickReply(params, quickSel);
		if (!reply) return;
		setSubmitting(true);
		setError(null);
		try {
			await api.post(
				`/api/sessions/${encodeURIComponent(sessionId)}/answer`,
				{ toolCallId: ask.toolCallId, reply },
			);
			// 提交成功：便签保持 pending 直到 toolResult 到达使 pendingAsks 移除它
		} catch (err) {
			const staleErr = (err as { status?: number })?.status === 400;
			setSubmitting(false);
			setError(staleErr ? t("ask.errorStale") : t("ask.errorSubmit"));
		}
	};

	return (
		<div
			className="flex items-center gap-2 h-[42px] px-3 rounded-md border border-hairline bg-surface shadow-sm"
			data-testid="ask-quick-bar"
		>
			<span className="rounded-full bg-accent-soft text-accent text-[calc(11px*var(--font-scale))] px-1.5 leading-4 flex-shrink-0">
				{totalQuestions}
			</span>
			<span className="text-secondary text-[calc(12px*var(--font-scale))] whitespace-nowrap flex-shrink-0">
				{t("ask.stickyPrompt", { n: totalQuestions })}
			</span>
			{(stale || error) && (
				<span
					className="text-danger text-[calc(11px*var(--font-scale))] whitespace-nowrap flex-shrink-0"
					role="alert"
					data-testid="ask-quick-error"
				>
					{stale ? t("ask.errorStale") : error}
				</span>
			)}
			<div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-thin">
				{params.questions.map((q, qi) => (
					<span key={qi} className="flex items-center gap-1 flex-shrink-0">
						<span className="text-tertiary text-[calc(11px*var(--font-scale))] mx-0.5">
							Q{totalQuestions > 1 ? qi + 1 : ""}
						</span>
						{q.options.map((o) => {
							const checked = (quickSel[qi]?.has(o.label) ?? false);
							return (
								<button
									key={o.label}
									onClick={() => {
										if (stale || submitting) return;
										toggle(qi, o.label, q.multiSelect === true);
									}}
									className={`rounded-full border px-2.5 py-0.5 text-[calc(11.5px*var(--font-scale))] transition-colors flex-shrink-0 ${
										checked
											? "bg-accent-soft border-accent text-accent"
											: "bg-surface border-hairline text-secondary hover:border-accent"
									} ${stale || submitting ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
								>
									{o.label}
								</button>
							);
						})}
					</span>
				))}
			</div>
			<button
				onClick={handleSubmit}
				disabled={!allAnswered || submitting}
				aria-label={t("ask.submit")}
				className="w-[22px] h-[22px] rounded-full border-0 flex items-center justify-center flex-shrink-0 cursor-pointer disabled:cursor-not-allowed"
				style={{
					background: allAnswered && !submitting
						? "var(--accent)"
						: "var(--hairline-strong)",
					color: "var(--on-accent)",
				}}
				data-testid="ask-quick-submit"
			>
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
					<path
						d="M3 8.5L6.5 12L13 4.5"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			<button
				onClick={onExpand}
				aria-label={t("ask.expand")}
				className="text-secondary hover:text-primary text-[calc(12px*var(--font-scale))] px-1.5 py-0.5 bg-transparent border-0 cursor-pointer flex-shrink-0"
			>
				↑
			</button>
		</div>
	);
}
