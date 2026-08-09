import { useEffect, useState } from "react";
import { api } from "../api-client";
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
	const [notFound, setNotFound] = useState(false);

	useEffect(() => {
		setLoading(true);
		setNotFound(false);
		// 复用现有的 /api/sessions/:id/messages 端点
		// 软删除不删 jsonl 文件，直接读取历史
		void api
			.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
			.then((res) => {
				const data = res as { messages: SessionMessage[] };
				useSessionStore.getState().setMessages(sessionId, data.messages ?? []);
				setLoading(false);
			})
			.catch(() => {
				setNotFound(true);
				setLoading(false);
			});
	}, [sessionId]);

	const handleRestore = async () => {
		await useTrashStore.getState().restore([sessionId]);
		onBack();
	};

	if (notFound) {
		return (
			<div className="flex flex-col h-full">
				<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
					<button
						onClick={onBack}
						className="text-brand text-sm"
						data-testid="trash-viewer-back"
					>
						‹ {t("trash.viewerBack")}
					</button>
				</div>
				<div className="flex-1 flex items-center justify-center text-tertiary">
					{t("trash.messagesNotFound")}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
				<button
					onClick={onBack}
					className="text-brand text-sm"
					data-testid="trash-viewer-back"
				>
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
