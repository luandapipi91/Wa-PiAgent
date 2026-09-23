import { memo, useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { useSessionStore } from "../../store/session";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useLiveElapsed } from "./useLiveElapsed";
import { StreamingOutput } from "./StreamingOutput";
import { InterruptedBadge } from "./InterruptedBadge";

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
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open: autoOpen } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
		defaultCollapsed: collapseProcessByDefault,
	});

	// 子代理进度：Task 8 为二级 map（[toolCallId][agent]），delegate 单 agent 取内层首项。
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const progress = agentMap ? Object.values(agentMap)[0] : undefined;
	// 运行中计时：后端仅在事件时推送 elapsedMs，思考/长工具静默期本地推算，避免计时冻结；
	// 父调用已终态（result 已返回）后强制停表——即使 progress 仍停在 running（用户停止时
	// agent 级终态事件随断流丢失），useLiveElapsed 冻结在最后一次推送值。
	const seconds = useLiveElapsed(
		progress?.elapsedMs,
		progress?.status === "running" && !result,
		progress?.startedAtMs,
	);

	// 卡片展开态：null = 用户未手动操作（hasProgress 时默认展开、否则跟随 autoCollapse）；
	// 一旦用户点头部折叠/展开就固定，progress 事件陆续到达不重置（避免执行中卡片“自动重新打开”）。
	const [progressExpanded, setProgressExpanded] = useState(false);
	const [cardOpen, setCardOpen] = useState<boolean | null>(null);
	const hasProgress = !!progress;
	// 开启「回复过程默认折叠」后，即使有实时进度也默认折叠（用户可手动展开）；
	// 关闭时保持原行为：有进度默认展开、否则跟随 autoCollapse。
	const open =
		cardOpen ??
		(collapseProcessByDefault ? autoOpen : hasProgress ? true : autoOpen);
	// 头部点击统一记录用户选择（不再区分有无 progress，折叠状态单一来源）。
	// null 时基于当前显示的 open 取反：执行中默认展开→点击折叠；完成态默认折叠→点击展开。
	const handleToggle = () =>
		setCardOpen(
			(v) =>
				!(
					v ?? (collapseProcessByDefault ? autoOpen : hasProgress ? true : autoOpen)
				),
		);

	const failed = !!result?.isError;
	// 中断标记（kernel 注入 details.interrupted）：中止/超时/异常等非正常终态，部分结果已保留。
	// SAFETY: ToolResultMessage 类型面未声明 details，与 FleetCard 同款按运行时实际形状读取；
	// 旧数据无该字段时 interrupted 恒为 false，渲染行为与现状完全一致。
	const details = (
		result as unknown as { details?: { interrupted?: boolean } } | undefined
	)?.details;
	// 终态判定以 kernel 落盘的 details.interrupted 为权威：result 已到即终态，不得用
	// 「进度仍停在 running」推翻后端明确给出的结论（终态帧丢失会把已完成的委派误标为
	// 「已中断」——2026-09-23 事故）。仅当后端完全没给该字段（2026-09-19 之前的旧会话数据）
	// 时才沿用停表兜底；settled 进度不受影响。
	const interrupted =
		details?.interrupted === true ||
		(details?.interrupted === undefined &&
			!!result &&
			progress?.status === "running");
	// 摘要行状态文案：中断（details 精确标记 / 旧数据兜底）显示「已中断」；
	// 其余按结果定性——result 已到即终态，进度停在 running 只是终态帧未送达，
	// 按成功/失败折算，避免已结束的卡片继续显示「运行中」。
	const settledStatus =
		result && progress?.status === "running"
			? failed
				? "error"
				: "done"
			: (progress?.status ?? "running"); // 仅无 progress 时触达，不参与渲染
	const summaryStatus = progress
		? interrupted
			? t("common.statusInterrupted")
			: statusLabel(settledStatus)
		: "";
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
				) : interrupted ? (
					// 中断优先于失败展示（失败+中断时正文仍保留 danger 样式）
					<InterruptedBadge />
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
				<Icon name="clipboard" size={12} style={{ marginTop: 2, flexShrink: 0 }} />
				<span>
					{t("blocks.delegate.taskLabel")}
					{args.task}
				</span>
			</div>
			{/* 回复：执行中流式显示 progress.output；完成态仅展开时显示最终 result */}
			{showReply && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${
						failed ? "text-danger" : interrupted ? "text-warning" : ""
					}`}
				>
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
						<Icon name="share" size={11} />
						<span>{t("blocks.delegate.replyLabel")}</span>
					</div>
					{/* 执行中：markdown 节流解析；完成：零延迟完整渲染（统一组件内部处理） */}
					<StreamingOutput
						text={replyText}
						sessionId={sessionId}
						streaming={!result}
					/>
				</div>
			)}
			{/* 状态摘要行（含「子智能体 · 运行中 · Ns · 共 N 个工具 · 成功/失败/执行中」）
			    渲染在卡片底部：位于任务/回复之后，视觉上作为整张卡片的汇总尾行 */}
			{hasProgress && (
				<div
					className="mt-2 pt-2 border-t border-hairline"
					data-testid={`delegate-progress-${toolCall.id}`}
				>
					{/* 摘要行：始终可见。执行中为纯文本；完成态为开关（展开看最终回复） */}
					{result ? (
						<button
							type="button"
							aria-label={progressExpanded ? t("common.collapse") : t("common.expand")}
							onClick={() => setProgressExpanded((v) => !v)}
							className="w-full flex items-center gap-1.5 text-[calc(11px*var(--font-scale))] text-tertiary py-1"
							style={{ cursor: "pointer" }}
						>
							<span>
								{t("blocks.delegate.progressSummary", {
									status: summaryStatus,
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
								status: summaryStatus,
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
		</ProcessCard>
	);
});
