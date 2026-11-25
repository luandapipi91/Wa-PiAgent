import { useCallback, useEffect, useMemo, useState } from "react";
import { classifyAsk, useDismissedAskStore, usePendingAsks } from "../../store/ask";
import type { AskState } from "@wa-pi/shared";
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
	try {
		return localStorage.getItem(STORAGE_KEY) !== "0";
	} catch {
		// 无记录 → 默认展开
		return true;
	}
}
function saveExpanded(v: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
	} catch {
		/* localStorage 不可用时静默降级 */
	}
}

export function AskDock({ sessionId }: { sessionId: string }) {
	// pendingAsks 是消息派生的原始列表（prune 依据）；asks 是渲染用列表（已剔除用户已关闭的）
	const pendingAsks = usePendingAsks(sessionId);
	const dismissedIds = useDismissedAskStore(s => s.bySession[sessionId]);
	const pruneDismissed = useDismissedAskStore(s => s.prune);
	const dismissAsk = useDismissedAskStore(s => s.dismiss);
	const asks = useMemo(
		() =>
			!dismissedIds || dismissedIds.length === 0
				? pendingAsks
				: pendingAsks.filter(a => !dismissedIds.includes(a.toolCallId)),
		[pendingAsks, dismissedIds],
	);
	// toolResult 到达（ask 从 pending 消失）后回收本会话的关闭标记，避免无界增长。
	// 注意：prune 必须带 sessionId——过去用全局集合 + 当前会话的列表 prune，
	// 切到别的会话就会把刚关掉的卡片标记误删，切回来卡片复活。
	useEffect(() => {
		pruneDismissed(sessionId, pendingAsks.map(a => a.toolCallId));
	}, [sessionId, pendingAsks, pruneDismissed]);
	const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
	// 用户提交后主动复检：回答被受理后 registry 条目立刻消失，但 toolResult 可能被同一批
	// 并行工具扣住数分钟，不主动复检就会把「回执在途」显示成「提问已失效」。
	const [recheckTick, setRecheckTick] = useState(0);
	const requestRecheck = useCallback(() => setRecheckTick(t => t + 1), []);
	const [expanded, setExpanded] = useState<boolean>(loadExpanded);
	const [quickSel, setQuickSel] = useState<Record<number, Set<string>>>({});
	// ask 身份变化（当前 ask 被回答、新 ask 到达）时丢弃便签旧预选，
	// 避免把上一轮选项集合里选的 label 注入到选项不同的新 ask（非法 label 提交）。
	const currentToolCallId = asks[0]?.toolCallId;
	useEffect(() => {
		setQuickSel({});
	}, [currentToolCallId]);
	const { t } = useTranslation();

	const setExpandedPersist = (v: boolean) => {
		saveExpanded(v);
		setExpanded(v);
	};

	useEffect(() => {
		if (asks.length === 0) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const ids = asks.map(a => a.toolCallId);
		// 双检数据源：states（新协议）；旧内核只给 pending 时降级为「pending 列表推导」
		const fetchStates = () =>
			api
				.get(`/api/sessions/${encodeURIComponent(sessionId)}/asks`)
				.then((body: any) => {
					const map = new Map<string, AskState>();
					if (Array.isArray(body?.states)) {
						for (const e of body.states as Array<{ toolCallId?: unknown; state?: unknown }>) {
							if (typeof e?.toolCallId === "string") {
								map.set(e.toolCallId, e.state as AskState);
							}
						}
					} else {
						for (const id of (body?.pending ?? []) as string[]) map.set(id, "pending");
					}
					return map;
				});
		const apply = (map: Map<string, AskState>) => {
			const stale: string[] = [];
			for (const id of ids) {
				const verdict = classifyAsk(map.get(id));
				// 已答完/已取消：卡片直接收起（toolResult 可能还在路上，不能再让用户重答）
				if (verdict === "closed") dismissAsk(sessionId, id);
				else if (verdict === "stale") stale.push(id);
			}
			setStaleIds(new Set(stale));
		};
		fetchStates()
			.then(map => {
				if (cancelled) return;
				const missing = ids.filter(id => !map.has(id));
				if (missing.length === 0) {
					apply(map);
					return;
				}
				retryTimer = setTimeout(() => {
					if (cancelled) return;
					fetchStates()
						.then(map2 => {
							if (!cancelled) apply(map2);
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
	}, [sessionId, asks, recheckTick, dismissAsk]);

	if (asks.length === 0) return null;
	return (
		<div className="relative px-6 pt-3" data-testid={`ask-dock-${sessionId}`}>
			{expanded ? (
				<div
					className="absolute bottom-0 left-0 right-0 z-20 max-h-[calc(100vh-160px)] overflow-y-auto"
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
									initialSelected={
										a.toolCallId === asks[0].toolCallId ? quickSel : undefined
									}
									onCollapse={() => setExpandedPersist(false)}
									onDismiss={() => dismissAsk(sessionId, a.toolCallId)}
									onAccepted={requestRecheck}
								/>
							</div>
						))}
					</div>
				</div>
			) : asks.length === 1 ? (
				// key=toolCallId：折叠态 ask 直接切换（toolCallId 变化）时强制整体重挂载，
				// AskQuickBar 内部 quickSel 预选随身份变化自然归零，无需在子组件内加 effect。
				<AskQuickBar
					key={asks[0].toolCallId}
					sessionId={sessionId}
					ask={asks[0]}
					stale={staleIds.has(asks[0].toolCallId)}
					onExpand={() => setExpandedPersist(true)}
					onSelectedChange={setQuickSel}
					onDismiss={() => dismissAsk(sessionId, asks[0].toolCallId)}
					onAccepted={requestRecheck}
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
