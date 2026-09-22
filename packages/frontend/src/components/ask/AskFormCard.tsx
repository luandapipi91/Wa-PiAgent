import { useEffect, useRef, useState } from "react";
import type { AgentName, AskParams, AskReply } from "@wa-pi/shared";
import { AGENT_DEFS } from "@wa-pi/shared";
import { api } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
import { Markdown } from "../blocks/Markdown";
import { MarkdownLink } from "../blocks/markdown-components";

/** 单次 answer/cancel-ask 请求超时；超时即视为本次尝试失败。 */
const SUBMIT_TIMEOUT_MS = 2_000;
/** 最多尝试次数（首次 + 2 次重试）。 */
const MAX_SUBMIT_ATTEMPTS = 3;

interface Props {
	sessionId: string;
	toolCallId: string;
	params: AskParams;
	agentName?: AgentName;
	/** double check 命中：后端 registry 已无此 ask（已取消/会话切换/重启残留）。显示失效并禁用提交。 */
	stale?: boolean;
	/** 便签快捷选择带入的预选（可选）。缺省行为与原来一致。 */
	initialSelected?: Record<number, Set<string>>;
	/** 收起弹窗回便签态（仅 UI 折叠，不触发 cancel-ask）。 */
	onCollapse?: () => void;
	/** 本地关闭卡片（仅失效场景：内核已无此 ask，取消是 no-op 也不会再有 toolResult）。 */
	onDismiss?: () => void;
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
	onCollapse,
	onDismiss,
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
	const [canceling, setCanceling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 提交收到 400 = 提问已失效（内核 registry 无此条目）→ 与 stale 同等对待：可本地关闭
	const [staleError, setStaleError] = useState(false);
	const { t } = useTranslation();

	const mountedRef = useRef(true);
	const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const resultResolveRef = useRef<((o: "timeout" | "unmounted") => void) | null>(
		null,
	);

	// 卸载清理：卡片被父层卸载（toolResult 到达＝真成功）后，必须清掉挂起的计时器并唤醒
	// 正在等待结果的提交循环，否则回调会在已卸载组件上 setState、await 永久悬挂。
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (resultTimerRef.current !== null) {
				clearTimeout(resultTimerRef.current);
				resultTimerRef.current = null;
			}
			resultResolveRef.current?.("unmounted");
			resultResolveRef.current = null;
		};
	}, []);

	// 等待「结果」：toolResult 到达会让父层卸载卡片＝真成功；否则超时＝本次尝试失败。
	const waitForResult = (ms: number) =>
		new Promise<"timeout" | "unmounted">((resolve) => {
			resultResolveRef.current = resolve;
			resultTimerRef.current = setTimeout(() => {
				resultTimerRef.current = null;
				resultResolveRef.current = null;
				resolve("timeout");
			}, ms);
		});

	// 本地关闭卡片；onDismiss 缺失时兜底恢复 UI（绝不允许 submitting 永久为 true）。
	const dismissLocally = () => {
		if (onDismiss) {
			onDismiss();
			return;
		}
		setSubmitting(false);
		setError(t("ask.errorSubmit"));
	};

	// 重试耗尽的收尾：尽力通知后端取消（400/超时/网络错误全吞掉），再本地关闭。
	const cancelAndDismiss = async () => {
		try {
			await api.post(
				`/api/sessions/${encodeURIComponent(sessionId)}/cancel-ask`,
				{ toolCallId },
				SUBMIT_TIMEOUT_MS,
			);
		} catch {
			// 兜底取消是 best-effort：失败无关紧要，交给本地关闭兜底
		}
		dismissLocally();
	};

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

	// 提交 = 最多 3 次尝试的状态机，覆盖两种卡死：① 请求本身挂住不返回；
	// ② 已返回 200 但 toolResult 永不到达（条目已被消费/连接断开残留）。
	// 重试期间 submitting 保持 true（按钮一直是「提交中…」）；组件卸载即收手。
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

		for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
			// 卸载后立即收手：父层已因 toolResult 卸载卡片＝真成功，不再发请求/不再 setState
			if (!mountedRef.current) return;

			let posted = false;
			try {
				await api.post(
					`/api/sessions/${encodeURIComponent(sessionId)}/answer`,
					{ toolCallId, reply },
					SUBMIT_TIMEOUT_MS,
				);
				posted = true;
			} catch (err) {
				// stale 判断用结构化的 HTTP 400 状态（后端 ask 失效返回 400），
				// 不依赖错误消息文案，避免 i18n 化后文案判断失效。
				const isStale = (err as { status?: number })?.status === 400;
				if (isStale) {
					if (attempt === 0) {
						// 首次即 400 = 真失效（内核 registry 无此条目）：沿用既有失效态，不重试
						setSubmitting(false);
						setStaleError(true);
						setError(t("ask.errorStale"));
						return;
					}
					// 重试时才 400 = 上一次尝试其实已提交成功、提问已被消费 → 本地关闭收尾
					dismissLocally();
					return;
				}
				// 超时/网络/5xx：本次尝试失败，落到下方按重试额度决定
			}

			if (posted) {
				// 请求期间被卸载（父层已收尾）→ 立即收手，不再启动等待结果的计时器
				if (!mountedRef.current) return;
				// 200 只代表请求送达，不代表用户看到结果：要等 toolResult 让父层卸载卡片。
				// 2s 仍挂载说明结果不会来了（条目已被消费/连接断开残留）→ 记为本次失败、进入重试。
				const outcome = await waitForResult(SUBMIT_TIMEOUT_MS);
				if (outcome === "unmounted" || !mountedRef.current) return;
			}

			// 本次尝试失败：还有额度就重试，耗尽则自动取消（cancel-ask + 本地关闭）
			if (attempt === MAX_SUBMIT_ATTEMPTS - 1) {
				await cancelAndDismiss();
				return;
			}
		}
	};

	// 取消 = 让这个提问不再阻塞用户。
	// 失效提问（内核 registry 已无此条目）取消请求必然是 no-op、也不会再产生 toolResult，
	// 卡片永远等不到卸载信号 → 直接本地关闭；正常提问走 cancel-ask，等 toolResult 到达卸载。
	const handleCancel = async () => {
		if (submitting || canceling) return;
		// 已确认失效（stale prop 或提交收到 400）：取消请求必然是 no-op、也不会再有 toolResult，
		// 直接本地关闭，否则卡片永久阻塞输入框
		if (stale || staleError) {
			onDismiss?.();
			return;
		}
		setCanceling(true);
		setError(null);
		try {
			await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/cancel-ask`, {
				toolCallId,
			});
			setCanceling(false);
		} catch (err) {
			setCanceling(false);
			// 后端 400 = 提问已失效（内核 registry 无此条目）→ 同样本地关闭，
			// 否则卡片再也等不到 toolResult，会永久阻塞输入框。
			if ((err as { status?: number })?.status === 400) {
				onDismiss?.();
				return;
			}
			setError(t("ask.errorCancel"));
		}
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
				<span className="text-[calc(11.5px*var(--font-scale))] font-semibold text-accent">
					{title}
				</span>
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
									<Markdown
										text={selPreview}
										sessionId={sessionId}
										interactive={false}
										components={{ a: MarkdownLink }}
										className=""
										testId={null}
									/>
								</div>
							)}
							{/* 「其他」也是一种选项，与普通选项互斥；选中后必须输入文字 */}
							<button
								onClick={() => chooseOther(qi)}
								className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${otherActive ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}
							>
								<span className="text-accent">{otherActive ? "◉" : "○"}</span>
								<span className="font-medium text-primary">
									{t("ask.otherOption")}
								</span>
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
								<span className="text-[calc(11px*var(--font-scale))] text-tertiary">
									{t("ask.notesLabel")}
								</span>
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
				{onCollapse && (
					<button
						onClick={onCollapse}
						className="text-[calc(12px*var(--font-scale))] px-3 py-1 rounded-pill bg-surface-elevated text-secondary border-0 cursor-pointer mr-auto"
					>
						{t("ask.collapse")}
					</button>
				)}
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
					disabled={submitting || canceling}
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
