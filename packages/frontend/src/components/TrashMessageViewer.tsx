import { useEffect, useState, useRef } from "react";
import { api, ApiError } from "../api-client";
import { Icon } from "./ui/Icon";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMessage } from "@wa-pi/shared";

interface Props {
	sessionId: string;
	onBack: () => void;
}

interface LoadedMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	agentName?: string;
}

export function TrashMessageViewer({ sessionId, onBack }: Props) {
	const { t } = useTranslation();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [messages, setMessages] = useState<LoadedMessage[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		setMessages([]);

		void api
			.get(`/api/trash/sessions/${encodeURIComponent(sessionId)}/messages`)
			.then((res) => {
				if (cancelled) return;
				const data = res as {
					messages?: { message: AgentMessage; agentName?: string }[];
				};
				const msgs = (data?.messages ?? []).map((m) => {
					const msg = m.message as any;
					return {
						role: msg.role ?? "unknown",
						content: msg.content ?? "",
						timestamp:
							typeof msg.timestamp === "number" ? msg.timestamp : undefined,
						agentName: m.agentName,
					};
				});
				setMessages(msgs);
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				console.error("[TrashMessageViewer] 加载失败:", err);
				setError(
					err instanceof ApiError
						? `${err.message} (HTTP ${err.status})`
						: String(err),
				);
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

	// 提取消息文本内容
	function extractText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((block: any) => {
					if (typeof block === "string") return block;
					if (block?.type === "text") return block.text ?? "";
					if (block?.type === "thinking") return "";
					if (block?.type === "toolCall") return "";
					if (block?.type === "toolResult") return "";
					return "";
				})
				.filter(Boolean)
				.join("\n\n");
		}
		return "";
	}

	if (error) {
		return (
			<div className="flex flex-col h-full">
				<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
					<button onClick={onBack} className="text-brand text-sm">
						‹ {t("trash.viewerBack")}
					</button>
				</div>
				<div className="flex-1 flex flex-col items-center justify-center text-tertiary gap-2">
					<Icon name="warning" size={30} />
					<span>{t("trash.messagesNotFound")}</span>
					<span className="text-[10px] opacity-60">{error}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline shrink-0">
				<button
					onClick={onBack}
					className="text-brand text-sm"
					data-testid="trash-viewer-back"
				>
					‹ {t("trash.viewerBack")}
				</button>
			</div>

			{/* Notice */}
			<div className="mx-5 my-2 px-3 py-2 rounded bg-warning-soft border border-warning text-xs text-warning flex items-center gap-2 shrink-0">
				<Icon name="warning" size={12} className="shrink-0" />
				<span>
					{t("trash.viewerNotice")}
					<button
						onClick={() => void handleRestore()}
						className="text-brand underline ml-1"
					>
						{t("trash.viewerRestoreLink")}
					</button>
					<span className="ml-1">{t("trash.viewerRestoreHint")}</span>
				</span>
			</div>

			{/* Messages — 自主渲染，不依赖 MessageList */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
				{loading ? (
					<div className="flex items-center justify-center h-full text-tertiary">
						...
					</div>
				) : messages.length === 0 ? (
					<div className="flex items-center justify-center h-full text-tertiary text-sm">
						<Icon name="inbox" size={32} />
					</div>
				) : (
					<div className="flex flex-col gap-4 max-w-3xl mx-auto">
						{messages.map((msg, i) => {
							if (msg.role === "compactionSummary") return null;
							const isUser = msg.role === "user";
							const text = extractText(msg.content);
							if (!text.trim()) return null;
							return (
								<div
									key={i}
									className={`flex ${isUser ? "justify-end" : "justify-start"}`}
								>
									<div
										className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
											isUser
												? "bg-brand text-white rounded-br-sm"
												: "bg-surface-hover text-text rounded-bl-sm border border-hairline"
										}`}
									>
										{!isUser && msg.agentName && (
											<div className="text-[10px] text-tertiary mb-1 font-medium">
												{msg.agentName}
											</div>
										)}
										<div className="prose prose-sm max-w-none [&_pre]:bg-black/5 [&_pre]:rounded [&_code]:text-brand [&_code]:bg-brand/10 [&_code]:px-1 [&_code]:rounded">
											<ReactMarkdown remarkPlugins={[remarkGfm]}>
												{text}
											</ReactMarkdown>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="px-5 py-2 border-t border-hairline text-center text-xs text-tertiary shrink-0">
				<Icon name="book" size={12} className="inline-block align-[-0.125em]" />{" "}
				{t("trash.viewerReadonly")}
			</div>
		</div>
	);
}
