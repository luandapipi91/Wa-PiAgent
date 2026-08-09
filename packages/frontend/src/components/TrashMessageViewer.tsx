import { useEffect, useState } from "react";
import { api, ApiError } from "../api-client";
import { useTrashStore } from "../store/trash";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { useTranslation } from "../i18n/useTranslation";
import type { SessionMessage } from "@wa-pi/shared";

interface Props {
	sessionId: string;
	onBack: () => void;
}

export function TrashMessageViewer({ sessionId, onBack }: Props) {
	const { t } = useTranslation();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [msgCount, setMsgCount] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);

		// 回收站专用端点：直接读 jsonl，不经过 AgentManager
		void api
			.get(`/api/trash/sessions/${encodeURIComponent(sessionId)}/messages`)
			.then((res) => {
				if (cancelled) return;
				const data = res as { messages?: SessionMessage[] };
				const messages = data?.messages ?? [];
				setMsgCount(messages.length);
				// 与正常 SessionView 加载一致：先标 loading，再写入消息，再清 loading
				useSessionStore.getState().setHistoryLoading(sessionId, true);
				useSessionStore.getState().setMessages(sessionId, messages);
				useSessionStore.getState().setHistoryLoading(sessionId, false);
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				console.error("[TrashMessageViewer] 加载消息失败:", err);
				if (err instanceof ApiError) {
					setError(`${err.message} (HTTP ${err.status})`);
				} else {
					setError(err instanceof Error ? err.message : String(err));
				}
				setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const handleRestore = async () => {
		await useTrashStore.getState().restore([sessionId]);
		onBack();
	};

	// 错误状态
	if (error) {
		return (
			<div className="flex flex-col h-full">
				<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
					<button onClick={onBack} className="text-brand text-sm" data-testid="trash-viewer-back">
						‹ {t("trash.viewerBack")}
					</button>
				</div>
				<div className="flex-1 flex flex-col items-center justify-center text-tertiary gap-2">
					<span className="text-3xl">⚠️</span>
					<span>{t("trash.messagesNotFound")}</span>
					<span className="text-[10px] text-tertiary/60">{error}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
				<button onClick={onBack} className="text-brand text-sm" data-testid="trash-viewer-back">
					‹ {t("trash.viewerBack")}
				</button>
			</div>

			{/* Notice */}
			<div className="mx-5 my-2 px-3 py-2 rounded bg-warning-soft border border-warning text-xs text-warning flex items-center gap-2">
				<span>⚠️</span>
				<span>
					{t("trash.viewerNotice")}
					<button
						onClick={() => void handleRestore()}
						className="text-brand underline ml-1"
						data-testid="trash-viewer-restore"
					>
						{t("trash.viewerRestoreLink")}
					</button>
					<span className="ml-1">{t("trash.viewerRestoreHint")}</span>
				</span>
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-y-auto px-5">
				{loading ? (
					<div className="flex items-center justify-center h-full text-tertiary">
						...
					</div>
				) : msgCount === 0 ? (
					<div className="flex items-center justify-center h-full text-tertiary text-sm">
						📭
					</div>
				) : (
					<MessageList sessionId={sessionId} />
				)}
			</div>

			{/* Footer */}
			<div className="px-5 py-2 border-t border-hairline text-center text-xs text-tertiary">
				📖 {t("trash.viewerReadonly")}
			</div>
		</div>
	);
}
