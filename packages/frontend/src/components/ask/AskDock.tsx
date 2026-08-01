import { useEffect, useState } from "react";
import { usePendingAsks } from "../../store/ask";
import { api } from "../../api-client";
import { AskFormCard } from "./AskFormCard";

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
		api
			.get(`/api/sessions/${encodeURIComponent(sessionId)}/asks`)
			.then((body: any) => {
				if (cancelled) return;
				const pending = new Set((body?.pending ?? []) as string[]);
				setStaleIds(
					new Set(
						asks
							.filter((a) => !pending.has(a.toolCallId))
							.map((a) => a.toolCallId),
					),
				);
			})
			.catch(() => {
				// 核对失败（网络等）：保守视为全部有效，提交时由后端 400 兜底
				if (!cancelled) setStaleIds(new Set());
			});
		return () => {
			cancelled = true;
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
