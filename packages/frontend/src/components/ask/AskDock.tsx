import { useEffect, useState } from "react";
import { usePendingAsks } from "../../store/ask";
import { api } from "../../api-client";
import { AskFormCard } from "./AskFormCard";

/** 失效判定的竞态宽限：assistant 消息（卡片渲染）先于 bridge 注册到达 kernel 时，
 *  首次核对会误 miss；宽限 500ms 后复查一次，仍 miss 才确认失效。 */
const STALE_GRACE_MS = 500;

/** composer 正上方的提问停靠区。pending 提问纵向堆叠；回答后自动消失（pendingAsks 移除）。
 *  宽度与下方 composer 输入框对齐（max-w-[860px] 居中）。
 *
 *  double check：本地消息派生的 ask 卡片可能与后端 AskRegistry 真实状态脱节
 *  （ask 已取消/会话切换/内核重启残留，但 toolResult 未达前端）。渲染时向后端
 *  /asks 核对，后端已无的标 stale，避免用户对失效 ask 提交后永久卡住。 */
export function AskDock({ sessionId }: { sessionId: string }) {
	const asks = usePendingAsks(sessionId);
	const [staleIds, setStaleIds] = useState<Set<string>>(new Set());

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
				// 竞态宽限：复查一次再判失效。宽限期内用户若对真失效 ask 提交，
				// 由后端 400 兜底（AskFormCard 提交时标 stale）。
				retryTimer = setTimeout(() => {
					if (cancelled) return;
					fetchPending()
						.then((pending2) => {
							if (cancelled) return;
							setStaleIds(
								new Set(missing.filter((id) => !pending2.has(id))),
							);
						})
						.catch(() => {
							// 复查失败（网络等）：保守不标失效
						});
				}, STALE_GRACE_MS);
			})
			.catch(() => {
				// 核对失败（网络等）：保守视为全部有效，提交时由后端 400 兜底
				if (!cancelled) setStaleIds(new Set());
			});
		return () => {
			cancelled = true;
			if (retryTimer !== undefined) clearTimeout(retryTimer);
		};
	}, [sessionId, asks]);

	if (asks.length === 0) return null;
	return (
		<div className="px-6 pt-3" data-testid={`ask-dock-${sessionId}`}>
			<div className="w-full max-w-[860px] mx-auto space-y-3">
				{asks.map((a) => (
					<AskFormCard
						key={a.toolCallId}
						sessionId={sessionId}
						toolCallId={a.toolCallId}
						params={a.params}
						agentName={a.agentName}
						stale={staleIds.has(a.toolCallId)}
					/>
				))}
			</div>
		</div>
	);
}
