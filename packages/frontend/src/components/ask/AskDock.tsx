import { useEffect, useState } from "react";
import { usePendingAsks } from "../../store/ask";
import { api } from "../../api-client";
import { AskFormCard } from "./AskFormCard";
import { AskQuickBar } from "./AskQuickBar";
import { useTranslation } from "../../i18n/useTranslation";

/** 失效判定的竞态宽限：assistant 消息（卡片渲染）先于 bridge 注册到达 kernel 时，
 *  首次核对会误 miss；宽限 500ms 后复查一次，仍 miss 才确认失效。 */
const STALE_GRACE_MS = 500;

/** composer 正上方的提问停靠区。默认展开为悬浮弹窗（首次无记录），可收起为单行便签（AskQuickBar）；
 *  展开/折叠状态全局持久化到 localStorage，重进会话恢复上次状态。
 *  宽度与下方 composer 输入框对齐（max-w-[860px] 居中）。 */

const STORAGE_KEY = "wa-pi:ask-dock-expanded";
function loadExpanded(): boolean {
	try { return localStorage.getItem(STORAGE_KEY) !== "0"; } // 无记录 → 默认展开
	catch { return true; }
}
function saveExpanded(v: boolean): void {
	try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); }
	catch { /* localStorage 不可用时静默降级 */ }
}

export function AskDock({ sessionId }: { sessionId: string }) {
	const asks = usePendingAsks(sessionId);
	const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
	const [expanded, setExpanded] = useState<boolean>(loadExpanded);
	const [quickSel, setQuickSel] = useState<Record<number, Set<string>>>({});
	const { t } = useTranslation();

	const setExpandedPersist = (v: boolean) => { saveExpanded(v); setExpanded(v); };

	useEffect(() => {
		if (asks.length === 0) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const fetchPending = () =>
			api
				.get(`/api/sessions/${encodeURIComponent(sessionId)}/asks`)
				.then((body: any) => new Set((body?.pending ?? []) as string[]));
		fetchPending()
			.then((pending) => {
				if (cancelled) return;
				const missing = asks
					.filter((a) => !pending.has(a.toolCallId))
					.map((a) => a.toolCallId);
				if (missing.length === 0) {
					setStaleIds(new Set());
					return;
				}
				retryTimer = setTimeout(() => {
					if (cancelled) return;
					fetchPending()
						.then((pending2) => {
							if (cancelled) return;
							setStaleIds(
								new Set(missing.filter((id) => !pending2.has(id))),
							);
						})
						.catch(() => {});
				}, STALE_GRACE_MS);
			})
			.catch(() => {
				if (!cancelled) setStaleIds(new Set());
			});
		return () => {
			cancelled = true;
			if (retryTimer !== undefined) clearTimeout(retryTimer);
		};
	}, [sessionId, asks]);

	if (asks.length === 0) return null;
	return (
		<div
			className="relative px-6 pt-3"
			data-testid={`ask-dock-${sessionId}`}
		>
			{expanded ? (
				<>
					<div
						className="absolute bottom-full left-0 right-0 z-20 pb-3"
						data-testid="ask-float-layer"
					>
						<div className="w-full max-w-[860px] mx-auto space-y-3">
							{asks.map((a) => (
								<div key={a.toolCallId} className="relative">
									<AskFormCard
										sessionId={sessionId}
										toolCallId={a.toolCallId}
										params={a.params}
										agentName={a.agentName}
										stale={staleIds.has(a.toolCallId)}
										initialSelected={a.toolCallId === asks[0].toolCallId ? quickSel : undefined}
									/>
								</div>
							))}
						</div>
						<button
							onClick={() => setExpandedPersist(false)}
							aria-label={t("ask.collapse")}
							className="mt-2 ml-auto block text-tertiary hover:text-primary text-[calc(11.5px*var(--font-scale))] px-2 py-0.5 bg-transparent border-0 cursor-pointer"
						>
							{t("ask.collapse")} ▾
						</button>
					</div>
				</>
			) : asks.length === 1 ? (
				<AskQuickBar
					sessionId={sessionId}
					ask={asks[0]}
					stale={staleIds.has(asks[0].toolCallId)}
					onExpand={() => setExpandedPersist(true)}
					onSelectedChange={setQuickSel}
				/>
			) : (
				<div
					className="flex items-center gap-2 h-[34px] px-3 rounded-md border border-hairline bg-surface shadow-sm"
					data-testid="ask-quick-bar-multi"
				>
					<span className="rounded-full bg-accent-soft text-accent text-[calc(11px*var(--font-scale))] px-1.5 leading-4 flex-shrink-0">
						{asks.length}
					</span>
					<span className="text-secondary text-[calc(12px*var(--font-scale))] whitespace-nowrap flex-shrink-0">
						{t("ask.stickyPrompt", { n: asks.length })}
					</span>
					<span className="flex-1" />
					<button
						onClick={() => setExpandedPersist(true)}
						aria-label={t("ask.expand")}
						className="text-secondary hover:text-primary text-[calc(12px*var(--font-scale))] px-1.5 py-0.5 bg-transparent border-0 cursor-pointer flex-shrink-0"
					>
						↑
					</button>
				</div>
			)}
		</div>
	);
}
