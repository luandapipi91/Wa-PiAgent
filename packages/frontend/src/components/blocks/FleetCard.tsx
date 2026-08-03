import { memo, useMemo, useState } from "react";
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
import { createMarkdownComponents } from "./markdown-components";
import { useSessionStore } from "../../store/session";
import { useLiveElapsed } from "./useLiveElapsed";

interface Props {
	sessionId: string;
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}

// 子代理状态文案映射：SubagentProgressEvent.status → 中文展示
function statusLabel(status: string): string {
	if (status === "running") return "运行中";
	if (status === "done") return "完成";
	return "出错";
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
 *  只收录 agentNames 里的 agent，避免回复正文里的【】误切。 */
function extractAgentReplies(
	full: string,
	agentNames: string[],
): Map<string, string> {
	const map = new Map<string, string>();
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
	for (const s of segments) {
		if (agentNames.includes(s.agent)) map.set(s.agent, s.text.trim());
	}
	return map;
}

/** 回复 markdown memo 化：react-markdown v10 无内置 memo，每次渲染全量重解析整段文本。
 *  子任务详情展开期间 useLiveElapsed 每秒 tick + 流式 output 高频更新都会触发重渲染，
 *  不 memo 则回复文本（可能很长）被反复解析，阻塞主线程导致闪烁。
 *  与 FileViewer.MarkdownPreview 同模式：只接收 text/sessionId 两个稳定 prop，
 *  components 在内部 useMemo 稳定引用，文本不变时 React 直接跳过重渲染。 */
const MemoReplyMarkdown = memo(function MemoReplyMarkdown({
	text,
	sessionId,
}: {
	text: string;
	sessionId: string;
}) {
	const mdComponents = useMemo(
		() => createMarkdownComponents(sessionId),
		[sessionId],
	);
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
			{text}
		</ReactMarkdown>
	);
});

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
			? `已完成 调用了 ${toolStats.total} 个工具 成功 ${toolStats.done} 失败 ${toolStats.error} 执行中 ${toolStats.running} · 点击查看回复`
			: `调用了 ${toolStats.total} 个工具 成功 ${toolStats.done} 失败 ${toolStats.error} 执行中 ${toolStats.running}`
		: showReply
			? "已完成 · 点击查看回复"
			: "运行中";
	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-label={expanded ? "折叠" : "展开"}
				onClick={() => setExpanded((v) => !v)}
				className="w-full flex items-center gap-1.5 text-[11px] text-secondary py-1 text-left"
				style={{ cursor: "pointer" }}
			>
				<span>
					任务 {index}：{label}
				</span>
				<span className="ml-auto flex-shrink-0">{expanded ? "▼" : "▶"}</span>
			</button>
			{expanded && (showReply || hasProgress || !!toolStats) && (
				<div className="mt-1 mb-1 pl-2 border-l border-hairline">
					{hasProgress && (
						<div className="text-[11px] text-tertiary mb-1">
							<span className="font-semibold">{agent}</span> ·{" "}
							{statusLabel(progress!.status)} · {seconds}s
						</div>
					)}
					<div className="text-[11px] text-tertiary mb-1">📤 回复：</div>
					<MemoReplyMarkdown text={replyText ?? ""} sessionId={sessionId} />
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
export function FleetCard({ sessionId, toolCall, result, isStreaming }: Props) {
	const args = toolCall.arguments as {
		tasks?: Array<{ agent: string; task: string }>;
	};
	const tasks = args.tasks ?? [];
	const { open: autoOpen } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
	});

	// 子代理进度：fleet 直接消费整个内层 map（多个 agent 共享同一 toolCallId）
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const agents = agentMap ? Object.values(agentMap) : [];
	const hasProgress = agents.length > 0;

	// 卡片展开态：null = 用户未手动操作（hasProgress 时默认展开、否则跟随 autoCollapse）；
	// 一旦用户点头部折叠/展开就固定，progress 事件陆续到达不重置（避免执行中卡片“自动重新打开”）。
	const [cardOpen, setCardOpen] = useState<boolean | null>(null);
	const open = cardOpen ?? (hasProgress ? true : autoOpen);
	// 头部点击统一记录用户选择（不再区分有无 progress，折叠状态单一来源）。
	// null 时基于当前显示的 open 取反：执行中默认展开→点击折叠；完成态默认折叠→点击展开。
	const handleToggle = () =>
		setCardOpen((v) => !(v ?? (hasProgress ? true : autoOpen)));

	const failed = !!result?.isError;
	const full =
		result?.content
			.map((c: ToolResultMessage["content"][number]) =>
				c.type === "text" ? c.text : "",
			)
			.join("\n") ?? "";
	// 从 result.details 读持久化的 fleet 工具统计（kernel 注入；刷新/历史会话仍可用）
	const fleetDetails = (
		result as unknown as
			| { details?: { fleet?: Record<string, ToolStats> } }
			| undefined
	)?.details;
	const persistedStats = fleetDetails?.fleet;
	// 按 agent 拆分聚合结果；无法拆分（老数据/无【】标记）时降级为聚合显示
	const agentNames = tasks.map((t) => t.agent);
	const repliesByAgent = extractAgentReplies(full, agentNames);
	const canSplit = repliesByAgent.size > 0;
	const formattedFull = full.replace(/【(.+?)】/g, "\n---\n**$1**  \n");
	const mdComponents = createMarkdownComponents(sessionId);

	// 任务条目：优先按 tasks（编号与任务清单一致），tasks 为空时按 progress agents 兜底
	const rows = (
		tasks.length > 0
			? tasks.map((t, i) => ({
					index: i + 1,
					agent: t.agent,
					progress: agentMap?.[t.agent],
				}))
			: agents.map((p, i) => ({
					index: i + 1,
					agent: p.agent,
					progress: p,
				}))
	).map((r) => ({
		...r,
		stats: persistedStats?.[r.agent],
		replyText: !result
			? r.progress?.output
			: canSplit
				? repliesByAgent.get(r.agent)
				: undefined,
	}));
	const visibleRows = rows.filter(
		(r) => r.progress || r.stats || (r.replyText != null && r.replyText !== ""),
	);

	return (
		<ProcessCard
			tone="warning"
			icon="↪"
			title={`并行派发 ${tasks.length} 个任务`}
			meta={
				!result ? (
					<>
						<Spinner />
						<span>执行中</span>
					</>
				) : failed ? (
					"✗ 失败"
				) : (
					"✓ 完成"
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
					{tasks.map((t, i) => (
						<div key={i} className="flex items-start gap-1.5">
							<span className="text-tertiary flex-shrink-0 mt-0.5">
								任务 {i + 1}：委派
							</span>
							<span>
								<span className="font-semibold">【{t.agent}】</span>
								{t.task}
							</span>
						</div>
					))}
				</div>
			)}
			{/* 每任务统计行（可独立展开看回复） */}
			{visibleRows.length > 0 && (
				<div
					className="mt-2 pt-2 border-t border-hairline"
					data-testid={`fleet-progress-${toolCall.id}`}
				>
					{visibleRows.map((r) => (
						<FleetTaskItem
							key={r.agent}
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
			{/* 降级：无法按 agent 拆分时聚合显示回复（老数据兼容） */}
			{!canSplit && full !== "" && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}
				>
					<div className="text-[11px] text-tertiary mb-1">📤 回复：</div>
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
						{formattedFull}
					</ReactMarkdown>
				</div>
			)}
		</ProcessCard>
	);
}
