import { useEffect, useState, useRef } from "react";
import { api, ApiError } from "../api-client";
import { Markdown } from "./blocks/Markdown";
import { Icon } from "./ui/Icon";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";
import type { AgentMessage } from "@wa-pi/shared";

interface Props {
	sessionId: string;
	onBack: () => void;
	onClose: () => void;
}

interface LoadedMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	agentName?: string;
}

export function TrashMessageViewer({ sessionId, onBack, onClose }: Props) {
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
						timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
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

	// 按用户消息分轮聚合：一轮（一次提问到最终回复的完整回合）内 assistant 消息
	// 可能有 multiple 条（工具调用循环，每条带简短过渡正文），只渲染轮内最后一个
	// 非空 text（最终回复）为一个气泡；thinking / 工具调用与结果一律不显示。
	// 轮内没有最终正文（只有 thinking 的截断收尾）则该轮不出助手气泡。
	function aggregateTurns(
		msgs: LoadedMessage[],
	): { role: "user" | "assistant"; text: string; agentName?: string }[] {
		const out: {
			role: "user" | "assistant";
			text: string;
			agentName?: string;
		}[] = [];
		let assistantText = "";
		let assistantName: string | undefined;
		const flush = () => {
			if (assistantText.trim()) {
				out.push({
					role: "assistant",
					text: assistantText,
					agentName: assistantName,
				});
			}
			assistantText = "";
			assistantName = undefined;
		};
		for (const msg of msgs) {
			if (msg.role === "user") {
				flush();
				const t = extractText(msg.content);
				if (t.trim()) out.push({ role: "user", text: t });
				continue;
			}
			if (msg.role !== "assistant") continue;
			const t = extractText(msg.content);
			if (t.trim()) {
				assistantText = t; // 轮内取最后一个非空 text（最终回复）
				assistantName = msg.agentName;
			}
		}
		flush();
		return out;
	}

	const turns = aggregateTurns(messages);

	if (error) {
		return (
			<div className="flex flex-col h-full">
				<div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
					<button onClick={onBack} className="text-brand text-sm">
						‹ {t("trash.viewerBack")}
					</button>
					<button
						onClick={onClose}
						className="ml-auto text-tertiary text-xs"
						data-testid="trash-viewer-close"
						aria-label={t("common.close")}
					>
						✕
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
				<button
					onClick={onClose}
					className="ml-auto text-tertiary text-xs"
					data-testid="trash-viewer-close"
					aria-label={t("common.close")}
				>
					✕
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
			<div
				ref={scrollRef}
				className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-3 min-h-0"
			>
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
						{turns.map((turn, i) => {
							const isUser = turn.role === "user";
							return (
								<div
									key={i}
									className={`flex min-w-0 ${isUser ? "justify-end" : "justify-start"}`}
								>
									<div
										className={`max-w-[80%] min-w-0 overflow-hidden break-words px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
											isUser
												? "bg-brand text-white rounded-br-sm"
												: "bg-surface-hover text-text rounded-bl-sm border border-hairline"
										}`}
									>
										{!isUser && turn.agentName && (
											<div className="text-[10px] text-tertiary mb-1 font-medium">
												{turn.agentName}
											</div>
										)}
										<Markdown
											text={turn.text}
											interactive={false}
											className="prose prose-sm max-w-none break-words [&_pre]:bg-black/5 [&_pre]:rounded [&_pre]:overflow-x-auto [&_code]:text-brand [&_code]:bg-brand/10 [&_code]:px-1 [&_code]:rounded"
											testId={null}
										/>
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
