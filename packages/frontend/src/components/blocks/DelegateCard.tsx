import { memo, useState } from "react";
import type {
	SubagentDetails,
	SubagentProgressEvent,
	ToolCall,
	ToolResultMessage,
	ToolStats,
} from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { Markdown } from "./Markdown";
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

/** kernel 落在 tool result 上的 details。历史上有三种形状，故字段全部可选、按运行时实际形状取：
 *  - 新 delegate（工具合并后）：`subagents[]` + 布尔 `interrupted`；
 *  - 旧 delegate（单任务）：只有布尔 `interrupted`；
 *  - 旧 fleet（已删工具）：`fleet`（按任务序号的工具统计）+ 按序号的 Record `interrupted`。 */
interface ResultDetails {
	subagents?: SubagentDetails["subagents"];
	interrupted?: boolean | Record<string, boolean>;
	fleet?: Record<string, ToolStats>;
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
 *  聚合格式（旧 fleet 工具）：【agent1】（失败）\n内容\n\n【agent2】\n内容；
 *  「用户停止」场景桥接层会在聚合文本外拼「已停止。」前缀，剥离后同格式。
 *  只有「行首（文本开头或换行后）且名称命中任务清单」的 【】 标记才算分段边界——
 *  agent 正文自带的 【】 小标题（如 "## 【代理A·质数计算】任务结果"）不在行首/不在清单内，
 *  仅作为正文内容保留、不参与切分（否则整卡降级为聚合显示、任务行只剩空的「回复：」）。
 *  返回与 agentNames 顺序一一对应的回复数组（同名 agent 按出现顺序对应同名任务）；
 *  段落数与任务数不匹配（正文误含同类标记、老数据无标记）时返回 null，调用方降级为聚合显示。
 *  修复背景：旧实现用 Map<agent, text> 同名覆盖，同名 agent 任务时前一个任务的回复被
 *  后一个覆盖（串台/丢内容）。 */
function extractAgentReplies(
	full: string,
	agentNames: string[],
): string[] | null {
	// 任务清单为空：无从对号入座（异常参数/老数据），直接降级
	if (agentNames.length === 0) return null;
	// 「用户停止」场景：桥接层在聚合文本外拼「已停止。」前缀，先剥离让首个标记回到行首
	const body = full.startsWith("已停止。")
		? full.slice("已停止。".length)
		: full;
	const re = /【([^】]+)】/g;
	const nameSet = new Set(agentNames);
	let match: RegExpExecArray | null;
	const segments: Array<{ agent: string; text: string }> = [];
	let lastIndex = 0;
	let currentAgent: string | null = null;
	while ((match = re.exec(body)) !== null) {
		// 只认「行首 + 名称在任务清单内」的标记为分段边界；其余【】只当正文
		const atLineStart =
			match.index === 0 || body[match.index - 1] === "\n";
		if (!atLineStart || !nameSet.has(match[1])) continue;
		if (currentAgent !== null) {
			segments.push({
				agent: currentAgent,
				text: body.slice(lastIndex, match.index),
			});
		}
		currentAgent = match[1];
		lastIndex = re.lastIndex;
	}
	if (currentAgent !== null) {
		segments.push({ agent: currentAgent, text: body.slice(lastIndex) });
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

/** 单个任务的统计行：`任务 N：调用了 X 个工具 成功 Y 失败 Z 执行中 W`。
 *  抽成独立组件以承载 useLiveElapsed（Hooks 不能在循环里调用）。
 *  统计来源：新数据优先 details.subagents[].toolStats（持久化、权威），旧 fleet 实时 progress 优先、
 *  完成态降级读 details.fleet；interrupted 同理按「新数据按行字段，旧数据按序号 Record + 兜底」取值。
 *  交互（2026-10-02 改）：**整行点击即打开转录弹窗**（新数据、有可查实例时）——卡片上不再就地
 *  展开回复，执行中 / 被中断 / 已完成三种情形行为一致；旧数据（没落盘、弹窗看不到）退回原地展开看回复。 */
function DelegateTaskRow({
	index,
	agent,
	progress,
	stats,
	isCompleted,
	interrupted,
	detailStatus,
	replyText,
	sessionId,
	transcriptAgentId,
	onViewTranscript,
}: {
	index: number;
	agent: string;
	progress?: SubagentProgressEvent;
	/** 持久化统计（新数据 details.subagents[].toolStats / 旧 fleet details.fleet[序号]） */
	stats?: ToolStats;
	/** 是否完成态（result 已返回）；决定「已完成」前缀，并让 running 行停表（兜底冻结） */
	isCompleted: boolean;
	/** 该子任务是否中断（新数据为持久化字段；旧数据仅缺失该字段时才按父终态后仍 running 兜底） */
	interrupted?: boolean;
	/** 新数据的持久化终态：progress 帧缺失（刷新后）时状态文案的来源 */
	detailStatus?: SubagentDetails["subagents"][number]["status"];
	replyText?: string;
	sessionId: string;
	/** 非空 = 该行有可查看的转录实例：整行可点，点击打开转录弹窗 */
	transcriptAgentId?: string;
	onViewTranscript?: (agentId: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { t } = useTranslation();
	// 子代理状态文案映射：SubagentProgressEvent.status → 展示
	const statusLabel = (status: string): string => {
		if (status === "running") return t("common.statusRunning");
		if (status === "done") return t("common.statusDone");
		return t("common.statusError");
	};
	// 持久化终态（completed/failed/interrupted）→ 展示
	const detailStatusLabel = (status: string): string => {
		if (status === "completed") return t("common.statusDone");
		if (status === "interrupted") return t("common.statusInterrupted");
		return t("common.statusError");
	};
	// 计时：父调用已终态（isCompleted）后强制停表——即使该行 progress 仍停在 running
	// （用户停止时 agent 级终态事件随断流丢失），useLiveElapsed 冻结在最后一次推送值。
	const seconds = useLiveElapsed(
		progress?.elapsedMs,
		progress?.status === "running" && !isCompleted,
		progress?.startedAtMs,
	);
	// 状态行文案：中断（持久化标记 / 旧数据兜底）显示「已中断」；其余按结果定性
	// ——父调用已终态时 running 只是终态帧未送达，按「完成」折算，不显示「运行中」。
	const statusText = interrupted
		? t("common.statusInterrupted")
		: progress
			? statusLabel(
					isCompleted && progress.status === "running" ? "done" : progress.status,
				)
			: detailStatus
				? detailStatusLabel(detailStatus)
				: "";
	const liveStats = progress ? countTools(progress.tools) : undefined;
	// 新数据（detailStatus 存在）：details 的持久化统计权威（progress 帧刷新后即无、且可能滞后）；
	// 旧 fleet：沿用「实时优先、完成态降级读持久化」口径。
	const toolStats = detailStatus ? (stats ?? liveStats) : (liveStats ?? stats);
	const hasProgress = !!progress;
	const showReply = replyText != null && replyText !== "";
	// 有可查实例 → 整行点击打开转录弹窗（卡片不再就地展开回复）；旧数据没落盘 → 退回原地展开看回复。
	const openable = !!transcriptAgentId && !!onViewTranscript;
	// 行内可看的实质内容：逐任务回复 或 实时进度（状态行）。
	// 降级聚合（无法拆分）时任务行可能两者都没有（回复已在卡片上方聚合显示）——
	// 此时不承诺「点击查看回复」（标签去后缀、隐藏展开箭头），展开也不渲染空「回复：」块。
	const expandable = !openable && (showReply || hasProgress);
	const statsParams = toolStats
		? {
				total: toolStats.total,
				done: toolStats.done,
				error: toolStats.error,
				running: toolStats.running,
			}
		: null;
	// 旧数据（无持久化终态）沿用的四种标签口径，与合并前 FleetCard 逐字一致
	const legacyLabel = (): string => {
		if (statsParams) {
			if (!isCompleted) return t("blocks.fleet.taskLabelRunningWithStats", statsParams);
			return showReply
				? t("blocks.fleet.taskLabelCompletedWithStats", statsParams)
				: t("blocks.fleet.taskLabelCompletedWithStatsNoReply", statsParams);
		}
		if (showReply) return t("blocks.fleet.taskLabelCompletedNoStats");
		return isCompleted
			? t("blocks.fleet.taskLabelRunning")
			: t("blocks.fleet.taskLabelQueued");
	};
	// 新数据的标签：完成沿用旧口径的「已完成 调用了 …」（与历史 fleet 行同文案）；失败/中断
	// 行首补状态词（这类行不能号称「已完成」）——状态词已在文案里，故不再重复挂中断徽标。
	const label = detailStatus
		? detailStatus === "completed"
			? statsParams
				? t("blocks.fleet.taskLabelCompletedWithStatsNoReply", statsParams)
				: t("common.statusDone")
			: `${detailStatusLabel(detailStatus)}${
					statsParams ? ` ${t("blocks.delegate.taskStats", statsParams)}` : ""
				}`
		: legacyLabel();
	return (
		<div className="min-w-0">
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					aria-label={
						openable
							? `${t("blocks.delegate.transcriptTitle")} ${agent}`
							: expandable
								? expanded
									? t("common.collapse")
									: t("common.expand")
								: undefined
					}
					onClick={
						openable
							? () => onViewTranscript?.(transcriptAgentId!)
							: expandable
								? () => setExpanded((v) => !v)
								: undefined
					}
					className="flex-1 min-w-0 flex items-center gap-1.5 text-[calc(11px*var(--font-scale))] text-secondary py-1 text-left"
					style={{ cursor: openable || expandable ? "pointer" : "default" }}
				>
					<span>
						{t("blocks.fleet.taskPrefix", { index })}
						{label}
					</span>
					{/* 中断徽标：紧跟任务行文案，琥珀警示色，与成功/失败区分。
					    新数据的行首状态词已是「已中断」，不重复挂徽标 */}
					{interrupted && !detailStatus && <InterruptedBadge />}
					{/* 行尾箭头：可查看转录（点整行开弹窗）用 chevron-right 提示可点；
					    旧数据的就地展开沿用展开/折叠双向箭头 */}
					{(openable || expandable) && (
						<span className="ml-auto flex-shrink-0">
							<Icon
								name={expandable && expanded ? "chevron-down" : "chevron-right"}
								size={10}
							/>
						</span>
					)}
				</button>
			</div>
			{expanded && expandable && (
				<div className="mt-1 mb-1 pl-2 border-l border-hairline">
					{/* 回复区仅在确有回复文本时渲染：降级态不再出现空的「回复：」块 */}
					{showReply && (
						<>
							<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
								<Icon name="share" size={11} />
								<span>{t("blocks.fleet.replyLabel")}</span>
							</div>
							<StreamingOutput
								text={replyText ?? ""}
								sessionId={sessionId}
								streaming={!isCompleted}
							/>
						</>
					)}
					{/* 状态行（agent · 状态 · 秒数）：渲染在回复之后，作为该子任务的尾部状态 */}
					{hasProgress && (
						<div className="text-[calc(11px*var(--font-scale))] text-tertiary mt-1">
							<span className="font-semibold">{agent}</span> ·{" "}
							{statusText} · {seconds}s
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** 统一委托卡片。三种数据形状共用一张卡（FleetCard 已并入，历史 fleet 记录也走这里）：
 *  - 新数据（`details.subagents`）：每任务一行的持久化状态/统计，**整行点击打开转录弹窗**；
 *  - 旧 delegate（只有布尔 `interrupted`）：单任务渲染 + 回复折叠（无查看按钮，那时没落盘）；
 *  - 旧 fleet（`details.fleet`）：按序号配对 tasks 的行 + 从聚合文本按 【agent】 切分回复（无查看按钮）。
 *  有实时进度（progress）时：始终显示一行/多行摘要（状态/耗时/工具数），展开看实时 output 与结果。 */
export const DelegateCard = memo(function DelegateCard({
	sessionId,
	toolCall,
	result,
	isStreaming,
}: Props) {
	const args = toolCall.arguments as {
		agent?: string;
		task?: string;
		tasks?: Array<{ agent: string; task: string }>;
	};
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const { t } = useTranslation();
	// 打开转录弹窗：只把目标实例写进 store（弹窗常驻 App 根，卡片卸载/折叠不会连带关闭）
	const openTranscript = useSessionStore((s) => s.openTranscript);
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open: autoOpen } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
		defaultCollapsed: collapseProcessByDefault,
	});

	// 子代理进度：按 toolCallId → agent/taskIndex 二级 map。
	// 单任务形状取内层首项（Task 8 起内层键是 taskIndex 字符串）；多任务形状消费整个内层 map。
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const agents = agentMap ? Object.values(agentMap) : [];
	const hasProgress = agents.length > 0;
	const progress = agents[0];
	// 单任务摘要行的计时：后端仅在事件时推送 elapsedMs，思考/长工具静默期本地推算，避免计时冻结；
	// 父调用已终态（result 已返回）后强制停表——即使 progress 仍停在 running（用户停止时
	// agent 级终态事件随断流丢失），useLiveElapsed 冻结在最后一次推送值。
	const seconds = useLiveElapsed(
		progress?.elapsedMs,
		progress?.status === "running" && !result,
		progress?.startedAtMs,
	);
	// 子代理状态文案映射：SubagentProgressEvent.status → 展示
	const statusLabel = (status: string): string => {
		if (status === "running") return t("common.statusRunning");
		if (status === "done") return t("common.statusDone");
		return t("common.statusError");
	};

	// 卡片展开态：null = 用户未手动操作（hasProgress 时默认展开、否则跟随 autoCollapse）；
	// 一旦用户点头部折叠/展开就固定，progress 事件陆续到达不重置（避免执行中卡片“自动重新打开”）。
	const [progressExpanded, setProgressExpanded] = useState(false);
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
	// SAFETY: ToolResultMessage 类型面未声明 details，按运行时实际形状读取；三种历史形状字段全部可选，
	// 取不到时自然退化为 undefined（渲染行为与合并前一致）。
	const details = (
		result as unknown as { details?: ResultDetails } | undefined
	)?.details;
	const subagents = details?.subagents;
	const legacyFleet = details?.fleet;
	const subagentCount = subagents?.length ?? 0;
	// 多任务形状：新 delegate（details.subagents / tasks 入参）、旧 fleet（details.fleet / name=fleet）；
	// 注意「tasks 非空但还没 result」的流式阶段也要走多任务行渲染（否则刚派发的任务行全不可见）。
	const isMulti =
		subagentCount > 0 ||
		legacyFleet != null ||
		toolCall.name === "fleet" ||
		tasks.length > 0;
	// testId 前缀沿用工具名：旧 fleet 记录的既有断言/E2E 选择器（fleet-<id>）不变
	const testIdPrefix = toolCall.name === "fleet" ? "fleet" : "delegate";

	// ── 多任务行 ──
	// 旧 fleet 的持久化统计（按序号，老数据按 agent 名）；新数据按 taskIndex 取 details.subagents[].toolStats
	const persistedStats = legacyFleet;
	// SAFETY: 旧 fleet 的 details.interrupted 是按序号的 Record；新形状（及旧 delegate）是布尔
	const interruptedMap =
		details?.interrupted && typeof details.interrupted === "object"
			? details.interrupted
			: undefined;
	// 按 agent 顺序切分各任务回复（仅旧 fleet 需要）；null 表示无法可靠拆分（正文误含【】/老数据）→ 降级聚合
	const agentNames = tasks.map((tk) => tk.agent);
	const repliesByAgent = extractAgentReplies(full, agentNames);
	const canSplit = repliesByAgent !== null;
	const formattedFull = full.replace(/【(.+?)】/g, "\n---\n**$1**  \n");
	// 新数据的转录路径：直接取 details.subagents[].jsonlPath（前端唯一数据来源，**不解析返回文本**）——
	// 那是给模型看的 XML，格式一改正则就静默失效（门控失效的后果恰好是给一个必然 404 的入口）；
	// 且跨块正则会在某块缺标签时错配，行 A 的按钮打开 B 的转录。空串 = 本次没落盘。
	const subagentsByIndex = new Map<number, SubagentDetails["subagents"][number]>();
	for (const s of subagents ?? []) subagentsByIndex.set(s.taskIndex, s);

	// 任务条目：优先按 tasks（编号与任务清单一致），tasks 为空时按 progress agents 兜底
	const rows = !isMulti
		? []
		: (tasks.length > 0
				? tasks.map((tk, i) => ({
						index: i + 1,
						agent: tk.agent,
						progress: agentMap?.[String(i)],
					}))
				: agents.map((p, i) => ({
						index: i + 1,
						agent: p.agent,
						progress: p,
					}))
			).map((r) => {
				const sa = subagentsByIndex.get(r.index - 1);
				// 统计：新数据取持久化 stats（权威）；旧数据按任务序号取（同名 agent 不再互相覆盖），
				// 老数据 details.fleet 按名字 key 时降级按 agent 名取
				const stats =
					sa?.toolStats ??
					persistedStats?.[String(r.index - 1)] ??
					persistedStats?.[r.agent];
				// 中断标记：新数据用持久化字段（权威）；旧数据 interrupted 精确标记优先，仅当后端
				// 完全没给该任务的标记（旧会话数据）时才沿用「停在 running」兜底——终态帧丢失不得
				// 推翻后端明确给出的结论（2026-09-23 事故：已完成的行被误标「已中断」）。
				const interrupted = sa
					? sa.interrupted === true
					: interruptedMap?.[String(r.index - 1)] === true ||
						(interruptedMap?.[String(r.index - 1)] === undefined &&
							!!result &&
							r.progress?.status === "running");
				// 可查看的实例 id（整行点击打开弹窗）：
				//  - 新数据（details 已到）：agentId 与转录路径**都**非空才给入口——越权行 agentId 为空、
				//    转录目录/meta 准备失败的行 jsonlPath 为空，这两种点了必然 404；
				//  - 执行中（details 还没到）：用进度事件里的 agentId 兜底，转录拉到多少显示多少；
				//  - 旧数据：两者都没有 → undefined，退回原地展开看回复。
				const transcriptAgentId = sa
					? sa.agentId !== "" && sa.jsonlPath !== ""
						? sa.agentId
						: undefined
					: r.progress?.agentId || undefined;
				return {
					...r,
					stats,
					interrupted,
					detailStatus: sa?.status,
					// 新数据的正文在转录弹窗里看（卡片不重复渲染 XML 聚合文本）；旧 fleet 完成态按行切分
					replyText: !result
						? r.progress?.output
						: sa
							? undefined
							: canSplit
								? repliesByAgent![r.index - 1]
								: undefined,
					transcriptAgentId,
				};
			});
	// 运行期：任务行全部渲染（含尚无进度帧的任务——显示「排队中」）。否则刚派发、
	// 还没产生首个业务事件（因而没有进度帧）的任务行会整行消失，并行派发时看起来
	// 「显示不全」，要等调用完成后由 details 统计补齐。
	// 完成态：只渲染有统计/回复/持久化终态的行（老数据无 details 时不撑出空行）。
	const visibleRows = rows.filter(
		(r) =>
			!result ||
			r.progress ||
			r.stats ||
			r.detailStatus ||
			(r.replyText != null && r.replyText !== ""),
	);
	// 卡片级中断：多任务形状任一子任务非正常终态即在头部徽标提示（详情看子任务行）；
	// 单任务形状以 kernel 落盘的 details.interrupted 为权威（result 已到即终态，不得用
	// 「进度仍停在 running」推翻后端结论——终态帧丢失会把已完成的委派误标「已中断」，
	// 2026-09-23 事故）；仅当后端完全没给该字段（2026-09-19 之前的旧会话数据）时才沿用停表兜底。
	const singleInterruptedFlag =
		typeof details?.interrupted === "boolean" ? details.interrupted : undefined;
	const singleInterrupted =
		singleInterruptedFlag === true ||
		(singleInterruptedFlag === undefined &&
			!!result &&
			progress?.status === "running");
	const cardInterrupted = isMulti ? rows.some((r) => r.interrupted) : singleInterrupted;

	// 摘要行状态文案（单任务形状）：中断（details 精确标记 / 旧数据兜底）显示「已中断」；
	// 其余按结果定性——result 已到即终态，进度停在 running 只是终态帧未送达，
	// 按成功/失败折算，避免已结束的卡片继续显示「运行中」。
	const settledStatus =
		result && progress?.status === "running"
			? failed
				? "error"
				: "done"
			: (progress?.status ?? "running"); // 仅无 progress 时触达，不参与渲染
	const summaryStatus = progress
		? singleInterrupted
			? t("common.statusInterrupted")
			: statusLabel(settledStatus)
		: "";

	// 工具计数（单任务形状摘要行）：按 status 分桶，取代逐条工具列表
	const toolCounts = countTools(progress?.tools);
	// 执行中：直接流式渲染 progress.output；完成态：渲染最终 result
	const replyText = !result && progress?.output ? progress.output : full;
	const showReply = result
		? !hasProgress || progressExpanded
		: !!progress?.output;

	// 标题：多任务（新 delegate 多任务 / 旧 fleet）显示「并行派发 N 个任务」，
	// 单任务显示「委派给 {agent}」——新数据的 agent 名来自 details.subagents / tasks 入参。
	const fleetTitle =
		toolCall.name === "fleet" || legacyFleet != null || subagentCount > 1;
	const titleCount = subagentCount > 0 ? subagentCount : tasks.length;
	const titleAgent =
		subagents?.[0]?.agent ??
		tasks[0]?.agent ??
		args.agent ??
		t("blocks.delegate.defaultAgent");

	return (
		// data-testid="delegate-card"：统一卡片的稳定选择器（E2E 用），与按 toolCallId 的
		// delegate-<id> / fleet-<id> 并存
		<div data-testid="delegate-card">
			<ProcessCard
				tone="warning"
				icon={<Icon name="reply" />}
				title={
					fleetTitle
						? t("blocks.fleet.title", { count: titleCount })
						: t("blocks.delegate.title", { agent: titleAgent })
				}
				meta={
					!result ? (
						<>
							<Spinner />
							<span>{t("blocks.delegate.executingMeta")}</span>
						</>
					) : cardInterrupted ? (
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
				testId={`${testIdPrefix}-${toolCall.id}`}
			>
				{isMulti ? (
					<>
						{/* 任务清单：任务 N：委派【agent】task */}
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
						{/* 降级：旧 fleet 无法按 agent 拆分时聚合显示回复（老数据兼容）。
						    新数据不聚合——逐任务正文在转录弹窗里看，卡片不重复渲染 XML 文本。 */}
						{subagentCount === 0 && !canSplit && full !== "" && (
							<div
								data-testid="text-block"
								className={`mt-2 pt-2 border-t border-hairline ${
									failed ? "text-danger" : cardInterrupted ? "text-warning" : ""
								}`}
							>
								<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-1 flex items-center gap-1">
									<Icon name="share" size={11} />
									<span>{t("blocks.fleet.replyLabel")}</span>
								</div>
								<Markdown
									text={formattedFull}
									sessionId={sessionId}
									className=""
									testId={null}
								/>
							</div>
						)}
						{/* 每任务统计行（新数据含「查看全部内容」入口）：渲染在卡片底部，作为汇总尾行 */}
						{visibleRows.length > 0 && (
							<div
								className="mt-2 pt-2 border-t border-hairline"
								data-testid={`${testIdPrefix}-progress-${toolCall.id}`}
							>
								{visibleRows.map((r) => (
									<DelegateTaskRow
										key={`${r.index}-${r.agent}`}
										index={r.index}
										agent={r.agent}
										progress={r.progress}
										stats={r.stats}
										isCompleted={!!result}
										interrupted={r.interrupted}
										detailStatus={r.detailStatus}
										replyText={r.replyText}
										sessionId={sessionId}
										transcriptAgentId={r.transcriptAgentId}
										onViewTranscript={(agentId) =>
											openTranscript({ sessionId, agentId })
										}
									/>
								))}
							</div>
						)}
					</>
				) : (
					<>
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
						{/* 回复：执行中流式显示 progress.output；完成态仅展开时显示最终 result */}
						{showReply && (
							<div
								data-testid="text-block"
								className={`mt-2 pt-2 border-t border-hairline ${
									failed
										? "text-danger"
										: cardInterrupted
											? "text-warning"
											: ""
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
										aria-label={
											progressExpanded
												? t("common.collapse")
												: t("common.expand")
										}
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
												name={
													progressExpanded ? "chevron-down" : "chevron-right"
												}
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
					</>
				)}
			</ProcessCard>
		</div>
	);
});
