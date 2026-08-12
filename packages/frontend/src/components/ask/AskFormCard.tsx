import { useState } from "react";
import type { AgentName, AskParams, AskReply } from "@wa-pi/shared";
import { AGENT_DEFS } from "@wa-pi/shared";
import { api } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
// 项目现有代码（TextBlock.tsx / MessageList.tsx）统一用默认导入；保持一致。
import ReactMarkdown from "react-markdown";
import { MarkdownLink } from "../blocks/markdown-components";

interface Props {
	sessionId: string;
	toolCallId: string;
	params: AskParams;
	agentName?: AgentName;
	/** double check 命中：后端 registry 已无此 ask（已取消/会话切换/重启残留）。显示失效并禁用提交。 */
	stale?: boolean;
	/** 便签快捷选择带入的预选（可选）。缺省行为与原来一致。 */
	initialSelected?: Record<number, Set<string>>;
}

interface QState {
	/** "option" = 选了某个普通选项；"other" = 选择了「其他」（需输入文字） */
	mode: "option" | "other";
	selected: Set<string>;
	custom: string;
	notes: string;
}

/** 单个 ask_user_question 调用的表单。挂载即 pending；提交/取消后由父层在 pendingAsks 消失时卸载。 */
export function AskFormCard({
	sessionId,
	toolCallId,
	params,
	agentName,
	stale = false,
	initialSelected,
}: Props) {
	const [state, setState] = useState<Record<number, QState>>(() => {
		const init: Record<number, QState> = {};
		params.questions.forEach((_, i) => {
			init[i] = {
				mode: "option",
				selected: new Set(initialSelected?.[i] ?? []),
				custom: "",
				notes: "",
			};
		});
		return init;
	});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { t } = useTranslation();

	const patch = (qi: number, fn: (s: QState) => void) =>
		setState((prev) => {
			const cur = prev[qi];
			const next: QState = {
				mode: cur.mode,
				selected: new Set(cur.selected),
				custom: cur.custom,
				notes: cur.notes,
			};
			fn(next);
			return { ...prev, [qi]: next };
		});

	// 选普通选项：切到 option 模式，清空「其他」输入。单选只保一个，多选可叠加。
	const toggleOption = (qi: number, label: string, multi: boolean) =>
		patch(qi, (s) => {
			s.mode = "option";
			s.custom = "";
			if (multi) {
				s.selected.has(label)
					? s.selected.delete(label)
					: s.selected.add(label);
			} else {
				s.selected.clear();
				s.selected.add(label);
			}
		});

	// 选「其他」：切到 other 模式，清空普通选项的选择（互斥）。
	const chooseOther = (qi: number) =>
		patch(qi, (s) => {
			s.mode = "other";
			s.selected.clear();
		});

	const allAnswered = params.questions.every((_, i) => {
		const s = state[i];
		// 「其他」必须输入非空文字；普通模式必须有选中项
		return s.mode === "other"
			? s.custom.trim().length > 0
			: s.selected.size > 0;
	});

	const handleSubmit = async () => {
		if (!allAnswered || submitting || stale) return;
		setSubmitting(true);
		setError(null);
		const reply: AskReply = {
			replies: params.questions.map((_, i) => {
				const s = state[i];
				const useCustom = s.mode === "other";
				return {
					questionIndex: i,
					selected: useCustom ? [] : [...s.selected],
					customText: useCustom ? s.custom.trim() : undefined,
					notes: s.notes.trim() || undefined,
				};
			}),
		};
		try {
			await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
				toolCallId,
				reply,
			});
			// 提交成功：卡片保持 pending 直到 toolResult 到达使 pendingAsks 移除它（由父层卸载）
		} catch (err) {
			// 失败必须恢复 UI，否则 submitting 永久为 true、按钮永远"提交中…"——卡死。
			// stale 判断用结构化的 HTTP 400 状态（后端 ask 失效返回 400），
			// 不依赖错误消息文案，避免 i18n 化后文案判断失效。
			const stale = (err as { status?: number })?.status === 400;
			setSubmitting(false);
			setError(stale ? t("ask.errorStale") : t("ask.errorSubmit"));
		}
	};

	const handleCancel = () => {
		if (submitting) return;
		void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/cancel-ask`, {
			toolCallId,
		});
	};

	const agentEm = agentName ? AGENT_DEFS[agentName]?.emoji : undefined;
	const title = t("ask.title", {
		emoji: agentEm ?? "📌",
		agent: agentName ?? t("ask.agentFallback"),
	});

	return (
		<div
			className="rounded-lg border border-hairline bg-surface shadow-md"
			data-testid={`ask-card-${toolCallId}`}
		>
			<div className="flex items-center justify-between px-4 py-2 border-b border-hairline">
				<span className="text-[calc(11.5px*var(--font-scale))] font-semibold text-accent">{title}</span>
				<button
					onClick={handleCancel}
					disabled={submitting}
					aria-label={t("ask.ariaAbort")}
					className="text-tertiary hover:text-primary text-[calc(14px*var(--font-scale))] leading-none px-1.5 py-0.5 bg-transparent border-0 cursor-pointer disabled:opacity-50"
					data-testid={`ask-collapse-${toolCallId}`}
				>
					✕
				</button>
			</div>
			<div className="px-4 py-3 space-y-3 max-h-[50vh] overflow-auto">
				{params.questions.map((q, qi) => {
					const s = state[qi];
					const multi = q.multiSelect === true;
					const selPreview = [...s.selected]
						.map((lbl) => q.options.find((o) => o.label === lbl)?.preview)
						.find(Boolean);
					const otherActive = s.mode === "other";
					return (
						<div key={qi} className="space-y-1.5">
							<div className="text-[calc(12.5px*var(--font-scale))] font-semibold text-primary">
								Q{params.questions.length > 1 ? qi + 1 : ""} · {q.question}
							</div>
							{q.options?.map((o) => {
								const checked = s.mode === "option" && s.selected.has(o.label);
								return (
									<button
										key={o.label}
										onClick={() => toggleOption(qi, o.label, multi)}
										className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${checked ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}
									>
										<span className="text-accent">
											{multi ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
										</span>
										<span>
											<span className="font-medium text-primary">
												{o.label}
											</span>{" "}
											<span className="text-tertiary">— {o.description}</span>
										</span>
									</button>
								);
							})}
							{selPreview && (
								<div
									className="ml-6 bg-[#0d1117] text-[#c9d1d9] rounded-sm px-2.5 py-1.5 text-[calc(11px*var(--font-scale))] font-mono overflow-auto"
									data-testid={`ask-preview-${toolCallId}-${qi}`}
								>
									<ReactMarkdown components={{ a: MarkdownLink }}>
										{selPreview}
									</ReactMarkdown>
								</div>
							)}
							{/* 「其他」也是一种选项，与普通选项互斥；选中后必须输入文字 */}
							<button
								onClick={() => chooseOther(qi)}
								className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${otherActive ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}
							>
								<span className="text-accent">{otherActive ? "◉" : "○"}</span>
								<span className="font-medium text-primary">{t("ask.otherOption")}</span>
							</button>
							{otherActive && (
								<textarea
									value={s.custom}
									onChange={(e) =>
										patch(qi, (st) => {
											st.custom = e.target.value;
										})
									}
									placeholder={t("ask.customAnswerPlaceholder")}
									rows={1}
									className="w-full bg-transparent border border-hairline rounded-sm text-primary outline-none text-[calc(12.5px*var(--font-scale))] p-2 resize-none"
								/>
							)}
							<div className="flex items-center gap-2">
								<span className="text-[calc(11px*var(--font-scale))] text-tertiary">{t("ask.notesLabel")}</span>
								<input
									value={s.notes}
									onChange={(e) =>
										patch(qi, (st) => {
											st.notes = e.target.value;
										})
									}
									className="flex-1 bg-transparent border border-hairline rounded-sm text-primary outline-none text-[calc(12px*var(--font-scale))] px-2 py-0.5"
								/>
							</div>
						</div>
					);
				})}
			</div>
			<div className="flex justify-end gap-2 px-4 py-2 border-t border-hairline">
				{stale && (
					<span
						className="text-[calc(11.5px*var(--font-scale))] text-danger mr-auto"
						role="alert"
						data-testid={`ask-stale-${toolCallId}`}
						>
						{t("ask.errorStale")}
					</span>
				)}
				{!stale && error && (
					<span
						className="text-[calc(11.5px*var(--font-scale))] text-danger mr-auto"
						role="alert"
						data-testid={`ask-error-${toolCallId}`}
					>
						{error}
					</span>
				)}
				<button
					onClick={handleCancel}
					disabled={submitting}
					className="text-[calc(12px*var(--font-scale))] px-3 py-1 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer disabled:opacity-50"
					>
					{t("common.cancel")}
				</button>
				<button
					onClick={handleSubmit}
					disabled={!allAnswered || submitting || stale}
					className="text-[calc(12px*var(--font-scale))] px-4 py-1 rounded-pill border-0 cursor-pointer disabled:cursor-not-allowed"
					style={{
						background:
							allAnswered && !submitting && !stale
								? "var(--accent)"
								: "var(--hairline-strong)",
						color: "var(--on-accent)",
					}}
				>
					{submitting ? t("ask.submitting") : t("ask.submit")}
				</button>
			</div>
		</div>
	);
}
