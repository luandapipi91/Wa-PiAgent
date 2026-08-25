import { memo, useState } from "react";
import type {
	ToolCall,
	ToolResultMessage,
	SubagentProgressEvent,
	ToolStats,
} from "@wa-pi/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { createMarkdownComponents } from "./markdown-components";
import { useSessionStore } from "../../store/session";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useLiveElapsed } from "./useLiveElapsed";
import { StreamingOutput } from "./StreamingOutput";

interface Props {
	sessionId: string;
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}

/** 工具计数：按 status 分桶（总数/成功/失败/执行中） */
function countTools(tools: SubagentProgressEvent["tools"] | undefined) {
	const list = tools ?? [];
	return {
		total: list.length,
		done: list.filter((t) => t.status === "done").length,
		error: list.filter((t) => t.status === "error").length,
		running: list.filter((t) => t.status === "running").length,
	};
}

/** 从 fleet 聚合结果中按 【agent】 分隔符切分各 agent 的回复文本。
 *  聚合格式（kernel delegate-tool）：【agent1】（失败）\n内容\n\n【agent2】\n内容。
 *  返回与 agentNames 顺序一一对应的回复数组（同名 agent 按出现顺序对应同名任务）；
 *  段落数与任务数不匹配（正文误含【】、老数据无标记）时返回 null，调用方降级为聚合显示。
 *  修复背景：旧实现用 Map<agent, text> 同名覆盖，同名 agent 任务时前一个任务的回复被
 *  后一个覆盖（串台/丢内容）。 */
function extractAgentReplies(
	full: string,
	agentNames: string[],
): string[] | null {
	const re = /【([^】]+)】/g;
	let match: RegExpExecArray | null;
	const segments: Array<{ agent: string; text: string }> = [];
	let lastIndex = 0;
	let currentAgent: string | null = null;
	while ((match = re.exec(full)) !== null) {
		if (currentAgent !== null) {
			segments.push({
				agent: currentAgent,
				text: full.slice(lastIndex, match.index),
			});
		}
		currentAgent = match[1];
		lastIndex = re.lastIndex;
	}
	if (currentAgent !== null) {
		segments.push({ agent: currentAgent, text: full.slice(lastIndex) });
	}
	// 段落数必须与任务数一致：正文误含【】/老数据格式异常时切分不可靠，返回 null 降级
	if (segments.length !== agentNames.length) return null;
	// 校验每段 agent 名都来自任务清单，且同名出现次数不超过任务清单中同名次数
	const nameCount = new Map<string, number>();
	for (const n of agentNames) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
	const segCount = new Map<string, number>();
	for (const s of segments) {
		const c = (segCount.get(s.agent) ?? 0) + 1;
		if (c > (nameCount.get(s.agent) ?? 0)) return null;
		segCount.set(s.agent, c);
	}
	// 按任务清单顺序分配：同名 agent 第 k 次出现 → 清单中第 k 个同名任务
	const out: Array<string | undefined> = new Array(agentNames.length);
	let segIdx = 0;
	for (let i = 0; i < agentNames.length; i++) {
		while (segIdx < segments.length && segments[segIdx].agent !== agentNames[i]) {
			segIdx++;
		}
		if (segIdx >= segments.length) return null;
		out[i] = segments[segIdx].text.trim();
		segIdx++;
	}
	return out as string[];
}

/** 单个任务的统计行：`任务 N：调用了 X 个工具 成功 Y 失败 Z 执行中 W`，可独立展开看该任务回复。
 *  抽成独立组件以承载 useLiveElapsed（Hooks 不能在循环里调用）。
 *  统计来源：实时 progress.tools 优先，完成态降级读 result.details 持久化统计（刷新后仍可用）。 */
function FleetTaskItem({
	index,
	agent,
	progress,
	stats,
	isCompleted,
	replyText,
	sessionId,
}: {
	index: number;
	agent: string;
	progress?: SubagentProgressEvent;
	/** 持久化统计（result.details.fleet[agent]）；progress 缺失时兜底 */
	stats?: ToolStats;
	/** 是否完成态（result 已返回）；决定是否显示「已完成」前缀 */
	isCompleted: boolean;
	replyText?: string;
	sessionId: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const { t } = useTranslation();
	// 子代理状态文案映射：SubagentProgressEvent.status → 展示
	const statusLabel = (status: string): string => {
		if (status === "running") return t("common.statusRunning");
		if (status === "done") return t("common.statusDone");
		return t("common.statusError");
	};
	const seconds = useLiveElapsed(
		progress?.elapsedMs,
		progress?.status === "running",
	);
	const liveStats = progress ? countTools(progress.tools) : undefined;
	const toolStats = liveStats ?? stats;
	const hasProgress = !!progress;
	const showReply = replyText != null && replyText !== "";
	const label = toolStats
		? isCompleted
			? t("blocks.fleet.taskLabelCompletedWithStats", {
					total: toolStats.total,
					done: toolStats.done,
					error: toolStats.error,
					running: toolStats.running,
				})
			: t("blocks.fleet.taskLabelRunningWithStats", {
					total: toolStats.total,
					done: toolStats.done,
					error: toolStats.error,
					running: toolStats.running,
				})
		: showReply
			? t("blocks.fleet.taskLabelCompletedNoStats")
			: t("blocks.fleet.taskLabelRunning");
	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-label={expanded ? t("common.collapse") : t("common.expand")}
				onClick={() => setExpanded((v) => !v)}
				className="w-full flex items-center gap-1.5 text-[calc(11px*var(--font-scale))] text-secondary py-1 text-left"
				style={{ cursor: "pointer" }}
			>
				<span>
					{t("blocks.fleet.taskPrefix", { index })}
					{label}
				</span>
				<span className="ml-auto flex-shrink-0">
					<Icon name={expanded ? "chevron-down" : "chevron-right"} size={10} />
				</span>
			</button>
			{expanded && (showReply || hasProgress || !!toolStats) && (
				<div className="mt-1 mb-1 pl-2 border-l border-hairline">
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
						<Icon name="share" size={11} />
						<span>{t("blocks.fleet.replyLabel")}</span>
					</div>
					<StreamingOutput
						text={replyText ?? ""}
						sessionId={sessionId}
						streaming={!isCompleted}
					/>
					{/* 状态行（agent · 状态 · 秒数）：渲染在回复之后，作为该子任务的尾部状态 */}
					{hasProgress && (
						<div className="text-[calc(11px*var(--font-scale))] text-tertiary mt-1">
							<span className="font-semibold">{agent}</span> ·{" "}
							{statusLabel(progress!.status)} · {seconds}s
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** 并行派发卡片：展示 fleet（多智能体并行）的委派信息。
 *  结构：任务清单（任务 N：委派【agent】task）+ 每任务统计行（可独立展开看该任务回复）。
 *  有实时进度时：外层默认展开（保任务清单/统计行可见），头部点击折叠/展开整张卡片；
 *  子任务行各自独立展开/折叠，互不影响。
 *  与 delegate 的差异：fleet 一个 toolCallId 下多个 agent，直接消费整个内层 map。 */
export const FleetCard = memo(function FleetCard({
	sessionId,
	toolCall,
	result,
	isStreaming,
}: Props) {
	const args = toolCall.arguments as {
		tasks?: Array<{ agent: string; task: string }>;
	};
	const tasks = args.tasks ?? [];
	const { t } = useTranslation();
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open: autoOpen } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
		defaultCollapsed: collapseProcessByDefault,
	});

	// 子代理进度：fleet 直接消费整个内层 map（多个 agent 共享同一 toolCallId）
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const agents = agentMap ? Object.values(agentMap) : [];
	const hasProgress = agents.length > 0;

	// 卡片展开态：null = 用户未手动操作（hasProgress 时默认展开、否则跟随 autoCollapse）；
	// 一旦用户点头部折叠/展开就固定，progress 事件陆续到达不重置（避免执行中卡片“自动重新打开”）。
	const [cardOpen, setCardOpen] = useState<boolean | null>(null);
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
	const full =
		result?.content
			.map((c: ToolResultMessage["content"][number]) =>
				c?.type === "text" ? c.text : "",
			)
			.join("\n") ?? "";
	// 从 result.details 读持久化的 fleet 工具统计（kernel 注入；刷新/历史会话仍可用）
	const fleetDetails = (
		result as unknown as
			| { details?: { fleet?: Record<string, ToolStats> } }
			| undefined
	)?.details;
	const persistedStats = fleetDetails?.fleet;
	// 按 agent 顺序切分各任务回复；null 表示无法可靠拆分（正文误含【】/老数据）→ 降级聚合显示
	const agentNames = tasks.map((t) => t.agent);
	const repliesByAgent = extractAgentReplies(full, agentNames);
	const canSplit = repliesByAgent !== null;
	const formattedFull = full.replace(/【(.+?)】/g, "\n---\n**$1**  \n");
	const mdComponents = createMarkdownComponents(sessionId);

	// 任务条目：优先按 tasks（编号与任务清单一致），tasks 为空时按 progress agents 兜底
	const rows = (
		tasks.length > 0
			? tasks.map((t, i) => ({
					index: i + 1,
					agent: t.agent,
					progress: agentMap?.[String(i)],
				}))
			: agents.map((p, i) => ({
					index: i + 1,
					agent: p.agent,
					progress: p,
				}))
	).map((r) => ({
		...r,
		// 统计优先按任务序号取（同名 agent 不再互相覆盖）；
		// 老数据 details.fleet 按名字 key 时降级按 agent 名取
		stats: persistedStats?.[String(r.index - 1)] ?? persistedStats?.[r.agent],
		replyText: !result
			? r.progress?.output
			: canSplit
				? repliesByAgent![r.index - 1]
				: undefined,
	}));
	const visibleRows = rows.filter(
		(r) => r.progress || r.stats || (r.replyText != null && r.replyText !== ""),
	);

	return (
		<ProcessCard
			tone="warning"
			icon={<Icon name="reply" />}
			title={t("blocks.fleet.title", { count: tasks.length })}
			meta={
				!result ? (
					<>
						<Spinner />
						<span>{t("blocks.fleet.metaRunning")}</span>
					</>
				) : failed ? (
					<>
						<Icon name="x" size={12} />
						<span>{t("blocks.fleet.metaFailed")}</span>
					</>
				) : (
					<>
						<Icon name="check" size={12} />
						<span>{t("common.statusDone")}</span>
					</>
				)
			}
			open={open}
			onToggle={handleToggle}
			muted={!!result}
			testId={`fleet-${toolCall.id}`}
		>
			{/* 任务清单：任务 N：【agent】task */}
			{tasks.length > 0 && (
				<div className="mb-1 space-y-1">
					{tasks.map((tk, i) => (
						<div key={i} className="flex items-start gap-1.5">
							<span className="text-tertiary flex-shrink-0 mt-0.5">
								{t("blocks.fleet.delegatePrefix", { index: i + 1 })}
							</span>
							<span>
								<span className="font-semibold">【{tk.agent}】</span>
								{tk.task}
							</span>
						</div>
					))}
				</div>
			)}
			{/* 降级：无法按 agent 拆分时聚合显示回复（老数据兼容） */}
			{!canSplit && full !== "" && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}
				>
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
						<Icon name="share" size={11} />
						<span>{t("blocks.fleet.replyLabel")}</span>
					</div>
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
						{formattedFull}
					</ReactMarkdown>
				</div>
			)}
			{/* 每任务统计行（可独立展开看回复）：渲染在卡片底部，作为汇总尾行 */}
			{visibleRows.length > 0 && (
				<div
					className="mt-2 pt-2 border-t border-hairline"
					data-testid={`fleet-progress-${toolCall.id}`}
				>
					{visibleRows.map((r) => (
						<FleetTaskItem
							key={`${r.index}-${r.agent}`}
							index={r.index}
							agent={r.agent}
							progress={r.progress}
							stats={r.stats}
							isCompleted={!!result}
							replyText={r.replyText}
							sessionId={sessionId}
						/>
					))}
				</div>
			)}
		</ProcessCard>
	);
});
