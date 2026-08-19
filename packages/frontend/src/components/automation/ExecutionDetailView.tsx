import { useCallback, useEffect, useState } from "react";
import { useSchedulerStore } from "../../store/scheduler";
import { useSessionStore } from "../../store/session";
import { api } from "../../api-client";
import { MessageList } from "../MessageList";

/**
 * 执行记录详情页：回放该次定时任务执行的完整 agent 过程。
 * 有 sessionId：拉会话消息写入 sessionStore，复用聊天 MessageList 渲染
 * （指令/思考/工具调用/子代理/回复，与聊天同款）；无 sessionId：空态说明。
 */
export function ExecutionDetailView() {
	const selectedRecordId = useSchedulerStore((s) => s.selectedRecordId);
	const records = useSchedulerStore((s) => s.records);
	const closeRecordDetail = useSchedulerStore((s) => s.closeRecordDetail);
	const record = records.find((r) => r.id === selectedRecordId);

	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadMessages = useCallback(async (sessionId: string) => {
		setLoading(true);
		setError(null);
		try {
			const res = (await api.get(
				`/api/sessions/${encodeURIComponent(sessionId)}/messages`,
			)) as any;
			useSessionStore.getState().setMessages(sessionId, res?.messages ?? []);
		} catch {
			setError("加载失败");
		} finally {
			setLoading(false);
		}
	}, []);

	// 切换记录时重置错误态；有 sessionId 则拉取（无 sessionId 不发请求）
	useEffect(() => {
		setError(null);
	}, [selectedRecordId]);

	useEffect(() => {
		if (!record?.sessionId) return;
		void loadMessages(record.sessionId);
	}, [record?.sessionId, loadMessages]);

	if (!record) {
		return (
			<div
				data-testid="execution-detail-view"
				className="flex items-center justify-center h-full text-sm"
				style={{ color: "var(--text-tertiary)" }}
			>
				记录不存在
			</div>
		);
	}

	const statusIcon =
		record.status === "success" ? "✓" : record.status === "failed" ? "✕" : "⟳";
	const statusColor =
		record.status === "success"
			? "#4ade80"
			: record.status === "failed"
				? "#f87171"
				: "#60a5fa";

	return (
		<div data-testid="execution-detail-view" className="flex flex-col h-full">
			{/* header：返回 + 元信息 */}
			<div className="flex items-center gap-3 p-3 border-b border-hairline flex-shrink-0">
				<button
					data-testid="execution-detail-back"
					onClick={closeRecordDetail}
					className="text-[11px] px-2 py-1 rounded cursor-pointer border"
					style={{
						background: "var(--surface-hover)",
						borderColor: "var(--hairline)",
						color: "var(--text-secondary)",
					}}
				>
					← 返回
				</button>
				<div className="flex-1 min-w-0">
					<div
						className="text-xs font-medium truncate"
						style={{ color: "var(--text-primary)" }}
					>
						<span style={{ color: statusColor }}>{statusIcon}</span> {record.taskName}{" "}
						· 执行详情
					</div>
					<div
						className="text-[10px] flex gap-2"
						style={{ color: "var(--text-tertiary)" }}
					>
						{record.agentId && <span>🤖 {record.agentId}</span>}
						{record.model && <span>🧠 {record.model}</span>}
						<span>{new Date(record.startedAt).toLocaleString("zh-CN")}</span>
						{record.durationMs && (
							<span>耗时 {(record.durationMs / 1000).toFixed(0)}s</span>
						)}
					</div>
				</div>
			</div>

			{/* 失败错误摘要 */}
			{record.error && (
				<div
					className="px-3 py-2 text-[11px] flex-shrink-0"
					style={{ color: "#f87171", background: "rgba(239,68,68,0.06)" }}
				>
					{record.error}
				</div>
			)}

			{/* 消息区：flex-col 容器（MessageList 根 div 依赖 flex-1 撑满高度，非 flex 父容器会致 Virtuoso 高度塌陷为 0） */}
			<div className="flex-1 min-h-0 flex flex-col">
				{record.sessionId ? (
					error ? (
						<div
							className="flex flex-col items-center justify-center h-full gap-2"
							style={{ color: "var(--text-tertiary)" }}
						>
							<span className="text-sm">加载失败</span>
							<button
								data-testid="execution-detail-retry"
								onClick={() => void loadMessages(record.sessionId!)}
								className="text-[11px] px-3 py-1 rounded cursor-pointer border"
								style={{
									background: "var(--surface-hover)",
									borderColor: "var(--hairline)",
									color: "var(--text-secondary)",
								}}
							>
								重试
							</button>
						</div>
					) : loading ? (
						<div
							className="flex items-center justify-center h-full text-sm"
							style={{ color: "var(--text-tertiary)" }}
						>
							加载中…
						</div>
					) : (
						<MessageList sessionId={record.sessionId} readOnly />
					)
				) : (
					<div
						className="flex items-center justify-center h-full text-sm"
						style={{ color: "var(--text-tertiary)" }}
					>
						该记录无执行过程（旧版记录或会话创建前失败）
					</div>
				)}
			</div>
		</div>
	);
}
