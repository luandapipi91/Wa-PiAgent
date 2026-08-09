import { memo, useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { useSessionStore } from "../../store/session";
import { useLiveElapsed } from "./useLiveElapsed";
import { StreamingOutput } from "./StreamingOutput";

interface Props {
	sessionId: string;
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}

/** 委派卡片：流式中展开（任务可见），完成即折叠；子智能体回复用 ReactMarkdown 渲染。
 *  有实时进度（progress）时：始终显示一行摘要（状态/耗时/工具数）+ ▶/▼ 开关，
 *  展开后看实时 output 与工具时间线；完成态也保持折叠一致——展开才看结果详情。 */
export const DelegateCard = memo(function DelegateCard({
	sessionId,
	toolCall,
	result,
	isStreaming,
}: Props) {
	const args = toolCall.arguments as { agent?: string; task?: string };
	const { t } = useTranslation();
	// 子代理状态文案映射：SubagentProgressEvent.status → 展示
	const statusLabel = (status: string): string => {
		if (status === "running") return t("common.statusRunning");
		if (status === "done") return t("common.statusDone");
		return t("common.statusError");
	};
	const { open: autoOpen } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
	});

	// 子代理进度：Task 8 为二级 map（[toolCallId][agent]），delegate 单 agent 取内层首项。
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const progress = agentMap ? Object.values(agentMap)[0] : undefined;
	// 运行中计时：后端仅在事件时推送 elapsedMs，思考/长工具静默期本地推算，避免计时冻结
	const seconds = useLiveElapsed(
		progress?.elapsedMs,
		progress?.status === "running",
	);

	// 卡片展开态：null = 用户未手动操作（hasProgress 时默认展开、否则跟随 autoCollapse）；
	// 一旦用户点头部折叠/展开就固定，progress 事件陆续到达不重置（避免执行中卡片“自动重新打开”）。
	const [progressExpanded, setProgressExpanded] = useState(false);
	const [cardOpen, setCardOpen] = useState<boolean | null>(null);
	const hasProgress = !!progress;
	const open = cardOpen ?? (hasProgress ? true : autoOpen);
	// 头部点击统一记录用户选择（不再区分有无 progress，折叠状态单一来源）。
	// null 时基于当前显示的 open 取反：执行中默认展开→点击折叠；完成态默认折叠→点击展开。
	const handleToggle = () =>
		setCardOpen((v) => !(v ?? (hasProgress ? true : autoOpen)));

	const failed = !!result?.isError;
	const full =
		result?.content
			.map((c: ToolResultMessage["content"][number]) =>
				c?.type === "text" ? c.text : "",
			)
			.join("\n") ?? "";

	// 工具计数：按 status 分桶（总数/成功/失败/执行中），取代逐条工具列表
	const tools = progress?.tools ?? [];
	const toolCounts = {
		total: tools.length,
		done: tools.filter((t) => t.status === "done").length,
		error: tools.filter((t) => t.status === "error").length,
		running: tools.filter((t) => t.status === "running").length,
	};
	// 执行中：直接流式渲染 progress.output；完成态：渲染最终 result
	const replyText = !result && progress?.output ? progress.output : full;
	const showReply = result
		? !hasProgress || progressExpanded
		: !!progress?.output;
	return (
		<ProcessCard
			tone="warning"
			icon={<Icon name="reply" />}
			title={t("blocks.delegate.title", {
				agent: args.agent ?? t("blocks.delegate.defaultAgent"),
			})}
			meta={
				!result ? (
					<>
						<Spinner />
						<span>{t("blocks.delegate.executingMeta")}</span>
					</>
				) : failed ? (
					<>
						<Icon name="x" size={12} />
						<span>{t("blocks.delegate.failedMeta")}</span>
					</>
				) : (
					<>
						<Icon name="check" size={12} />
						<span>{t("blocks.delegate.doneMeta")}</span>
					</>
				)
			}
			open={open}
			onToggle={handleToggle}
			muted={!!result}
			testId={`delegate-${toolCall.id}`}
		>
			<div className="mb-1 flex items-start gap-1">
				<Icon
					name="clipboard"
					size={12}
					style={{ marginTop: 2, flexShrink: 0 }}
				/>
				<span>
					{t("blocks.delegate.taskLabel")}
					{args.task}
				</span>
			</div>
			{hasProgress && (
				<div
					className="mt-2 pt-2 border-t border-hairline"
					data-testid={`delegate-progress-${toolCall.id}`}
				>
					{/* 摘要行：始终可见。执行中为纯文本；完成态为开关（展开看最终回复） */}
					{result ? (
						<button
							type="button"
							aria-label={
								progressExpanded ? t("common.collapse") : t("common.expand")
							}
							onClick={() => setProgressExpanded((v) => !v)}
							className="w-full flex items-center gap-1.5 text-[calc(11px*var(--font-scale))] text-tertiary py-1"
							style={{ cursor: "pointer" }}
						>
							<span>
								{t("blocks.delegate.progressSummary", {
									status: statusLabel(progress!.status),
									seconds,
									total: toolCounts.total,
									done: toolCounts.done,
									error: toolCounts.error,
									running: toolCounts.running,
								})}
							</span>
							<span className="ml-auto">
								<Icon
									name={progressExpanded ? "chevron-down" : "chevron-right"}
									size={10}
								/>
							</span>
						</button>
					) : (
						<div className="text-[calc(11px*var(--font-scale))] text-tertiary py-1">
							{t("blocks.delegate.progressSummary", {
								status: statusLabel(progress!.status),
								seconds,
								total: toolCounts.total,
								done: toolCounts.done,
								error: toolCounts.error,
								running: toolCounts.running,
							})}
						</div>
					)}
				</div>
			)}
			{/* 回复：执行中流式显示 progress.output；完成态仅展开时显示最终 result */}
			{showReply && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}
				>
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
						<Icon name="share" size={11} />
						<span>{t("blocks.delegate.replyLabel")}</span>
					</div>
					{/* 执行中：纯文本预览（停顿 500ms 才切 markdown）；完成：完整 markdown */}
					<StreamingOutput
						text={replyText}
						sessionId={sessionId}
						streaming={!result}
					/>
				</div>
			)}
		</ProcessCard>
	);
});
