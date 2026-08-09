import type {
	SessionMessage,
	ToolResultMessage,
	PromptEvent,
	AgentName,
	ThinkingLevel,
} from "@wa-pi/shared";
import { isModelAvailable } from "@wa-pi/shared";
import { useTranslation } from "../i18n/useTranslation";
import { useSessionStore } from "../store/session";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useSkillsStore } from "../store/skills";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { api } from "../api-client";
import { fmtTok } from "../util/format";
import { Icon } from "./ui/Icon";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToastStore } from "../store/toast";
import { copyToClipboard } from "../util/clipboard";
import { useAgentsStore } from "../store/agents";
import { DelegateCard } from "./blocks/DelegateCard";
import { ExportButton } from "./blocks/ExportButton";
import { FleetCard } from "./blocks/FleetCard";
import { createMarkdownComponents } from "./blocks/markdown-components";
import { StreamingMarkdown } from "./blocks/StreamingMarkdown";
import { ThinkingCard } from "./blocks/ThinkingCard";
import { TurnSummary } from "./blocks/TurnSummary";
import { ToolGroupCard } from "./blocks/ToolCallCard";
import { AnsiText } from "./ui/AnsiText";
import {
	textToHtml,
	ensureChipStyles,
	registerAgentMeta,
} from "../quick-invoke/tokens";

const EMPTY: SessionMessage[] = [];

// 自动滚动：距离底部多少像素内视为“已在底部”
const BOTTOM_THRESHOLD = 20;

interface Props {
	sessionId: string;
}

interface RenderedRow {
	main: SessionMessage;
	toolResults: Map<string, ToolResultMessage>;
	/** 合并行中专用的 streaming 起始 index（内容数组中从该 index 开始为新到达的流式块） */
	streamingStartIdx?: number;
}

export function MessageList({ sessionId }: Props) {
	const { t } = useTranslation();
	const messages = useSessionStore(
		(s) => s.messagesBySession[sessionId] ?? EMPTY,
	);
	const streaming = useSessionStore(
		(s) => s.streamingBySession[sessionId] ?? null,
	);
	// 本会话是否有正在运行的子代理（delegate/fleet）。返回布尔：running 期间稳定 true，
	// 不随 progress 内容更新（output/tools 每帧变）重渲染，只有开始/结束转换才触发重渲染。
	// 用于驱动「子代理回复期间自动滚动」——子代理流式内容走 progressByToolCall，不走
	// streamingBySession，主流 streaming effect 覆盖不到。
	const hasRunningSubagent = useSessionStore((s) => {
		const psc = s.progressSessionByToolCall;
		for (const tcId of Object.keys(s.progressByToolCall)) {
			if (psc[tcId] !== sessionId) continue;
			const byAgent = s.progressByToolCall[tcId];
			for (const p of Object.values(byAgent)) {
				if (p.status === "running") return true;
			}
		}
		return false;
	});
	// 本会话 agent 状态：agent_start → "thinking"，agent_end → "idle"。
	// 主 agent 调用普通工具（bash/read/edit 等非 delegate/fleet）时 streaming 已被
	// toolCall 的 message_end 清空，但主 turn 未结束（agent_end 未到）——工具执行中 /
	// toolResult 到达都发生在 thinking 期间。用它覆盖「工具调用阶段自动滚动」。
	const status = useSessionStore((s) => s.statusBySession[sessionId]);
	const historyLoading = useSessionStore(
		(s) => s.historyLoadingBySession[sessionId] ?? false,
	);
	// transient 网络错误（Connection error/timeout）时为 "degraded"：
	// 驱动「重新发送」按钮（transient 不进对话流，原 stopReason:error 条件永不命中）。
	const netDegraded = useSessionStore(
		(s) => s.netStatusBySession[sessionId] === "degraded",
	);
	// useMemo 保持历史行引用稳定：流式期间 streaming 每帧变化触发重渲染时，
	// 配合 MessageRow 的 React.memo，历史行整体跳过重渲染（含 Markdown 重解析）。
	const rows = useMemo(() => preprocess(messages), [messages]);
	const session = useProjectsStore((s) =>
		s.sessions.find((x) => x.id === sessionId),
	);
	const agents = useAgentsStore((s) => s.list);

	// 确保 chip 样式注入（幂等，只在首次注入；document 可能为 undefined 时跳过）
	ensureChipStyles();
	// 同步注册所有智能体头像信息供 chip 渲染查找（render 阶段执行，确保 textToHtml 调用时 meta 已就绪）。
	// registerAgentMeta 是幂等 Map.set，每次 render 重写无副作用。
	for (const a of agents) {
		registerAgentMeta(a.displayName, {
			avatar: a.avatar,
			avatarColor: a.avatarColor,
		});
	}

	// 历史加载中且尚无消息（且未在流式）：显示居中 loading，避免切换会话时对话区空白
	const showHistoryLoading =
		historyLoading && messages.length === 0 && !streaming;

	// 「重新发送」：两种触发场景（回合已结束 status!==thinking 且无流式）：
	//  1. 末条是失败的 assistant 回复（stopReason:error，如鉴权/配额 fatal 错误）
	//  2. transient 网络错误（netDegraded）——此类错误不进对话流，末条仍是 user 消息
	// 两种都定位到最后一条 user 消息，在其下方显示按钮；重发或发新消息后按钮自动消失。
	// 回合进行中（status==="thinking"：正常思考 / 工具执行 / pi 自动重试退避）不显示——
	// 重试期间 netDegraded 仍在 + streaming 无 + 末条是 user，曾误命中条件，但回合未结束。
	let resendUserIdx = -1;
	const lastMsg = rows[rows.length - 1]?.main.message as any;
	const turnEnded = !streaming && status !== "thinking";
	const isFatalErrorTurn =
		turnEnded &&
		lastMsg?.role === "assistant" &&
		lastMsg?.stopReason === "error";
	// transient 错误后 streaming 占位已被清掉，末条是 user 消息
	const isTransientErrorTurn =
		turnEnded && netDegraded && lastMsg?.role === "user";
	if (isFatalErrorTurn || isTransientErrorTurn) {
		for (let i = rows.length - 1; i >= 0; i--) {
			if ((rows[i].main.message as any).role === "user") {
				resendUserIdx = i;
				break;
			}
		}
	}
	const handleResend = useCallback(
		(text: string, index: number) => {
			// 过期模型（provider 已删、prefs 残留）直接放弃重发：不裁剪、不发送，
			// 否则消息被裁掉后后端才报模型解析失败，用户丢了原消息。
			const prefs = useComposerPrefsStore.getState().bySession[sessionId];
			if (
				!isModelAvailable(prefs?.model, useProvidersStore.getState().providers)
			)
				return;
			// 原地重试：先裁掉该用户消息及之后所有行（失败的 assistant/错误），
			// 再乐观重建用户消息 + loading（与首次发送一致，不等 SDK 回声），最后发 prompt。
			// SDK 的 message_start(user) 回声会替换乐观占位（同步 timestamp），避免叠加。
			useSessionStore.getState().truncate(sessionId, index);
			const payload = buildResendPrompt({
				session,
				sessionId,
				text,
				model: prefs?.model,
				thinking:
					prefs?.thinking ?? useComposerPrefsStore.getState().defaults.thinking,
			});
			if (payload && session) {
				useSessionStore
					.getState()
					.optimisticSend(sessionId, text, session.primaryAgent);
				// 重发清除 transient degraded 标记（kernel 侧 prompt 也会清除 netDegraded）
				useSessionStore.getState().clearNetStatus(sessionId);
				void api.post(
					`/api/agents/${encodeURIComponent(payload.projectId)}/${encodeURIComponent(payload.sessionId)}/prompt`,
					{
						agentName: payload.agentName,
						text: payload.text,
						model: payload.model,
						thinking: payload.thinking,
						attachments: payload.attachments,
					},
				);
			}
		},
		[session, sessionId],
	);

	const containerRef = useRef<HTMLDivElement>(null);
	// stickBottom：用户是否「停在底部」。用户向上翻阅即置 false——此时即便 AI 在回复，
	// 也不抢滚动（不阻碍用户阅读历史）；用户回到底部或点浮动按钮再置 true。
	const [stickBottom, setStickBottom] = useState(true);
	// 记录已为其执行过「进入即滚到底」的会话，避免同会话内重复滚动。
	const didInitScrollRef = useRef<string | null>(null);

	// 记录上一次滚动位置：用于在 handleScroll 中区分「用户向上滚动」与「程序化贴底」。
	// 程序化贴底（rAF 循环 scrollToBottom）会异步触发原生 scroll 事件，若一律按
	// isNearBottom 更新 stickBottom，会在内容增长竞态下误判——贴底 scrollTop 是上一帧值、
	// scrollHeight 已随新 token 增长，单帧增长 ≥ BOTTOM_THRESHOLD 时 isNearBottom 返回
	// false，stickBottom 被置 false 而杀死自动滚动循环（长文本流式输出中途停止滚动）。
	const lastScrollTopRef = useRef(Infinity);

	const isNearBottom = useCallback(() => {
		const el = containerRef.current;
		if (!el) return true;
		return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = containerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	const handleScroll = useCallback(() => {
		const el = containerRef.current;
		if (!el) return;
		const st = el.scrollTop;
		// 识别「用户向上滚动」（scrollTop 减小）与「程序化贴底」（rAF 循环设置
		// scrollTop=scrollHeight，scrollTop 增大/不变）。
		// 初始 Infinity：首次 scroll 事件无法用方向判断时，退化为按 isNearBottom 判定
		// （容器初始在顶部且内容超高 → 视为用户不在底部）。
		if (st < lastScrollTopRef.current) {
			// 用户向上滚动（滚轮上滚 / PageUp / 拖拽上移）：明显离开底部才停用自动滚动；
			// 轻微上翻（仍在 BOTTOM_THRESHOLD 内）保持贴底。
			if (!isNearBottom()) setStickBottom(false);
		} else if (isNearBottom()) {
			// 向下滚动 / 程序化贴底且确实在底部 → 确认贴底。
			setStickBottom(true);
		}
		// 向下滚动但不在底部：可能是程序化贴底竞态——rAF 循环设置 scrollTop=scrollHeight
		// 会异步触发原生 scroll 事件，派发时 scrollTop 是上一帧贴底位置、scrollHeight 已随
		// 新内容增长（单帧增长 ≥ BOTTOM_THRESHOLD 时 isNearBottom 误判 false）。此时保持
		// stickBottom 现状（不置 false），避免误杀自动滚动循环；也可能是用户下拖到中间，
		// 保持现状同样正确（不抢滚动）。
		lastScrollTopRef.current = st;
	}, [isNearBottom]);

	// 自动跟随滚动：AI 回复（主流 streaming）、子代理运行（delegate/fleet 流式内容增长）
	// 或主 agent turn 进行中（status==="thinking"——覆盖调用普通工具期间：toolCall 定稿后
	// streaming 已清空、工具执行中 / toolResult 到达时内容仍会增长）且用户停在底部时，
	// rAF 循环每帧贴底一次（合帧——同帧多次内容变化只滚一次，避免同帧读写
	// scrollHeight/scrollTop 造成 forced reflow）。循环不依赖内容更新信号：streaming 引用
	// 每帧变、子代理 output 增长或 toolResult 定稿都无需重启 effect，自然覆盖两种情况。
	// 结束后（active 由真变假）messages/卡片内容已定稿，兜底再滚一次，避免最后一段
	// 内容停在视口下方（尾部裁切）；平时（非回复）不自动滚动，不抢用户阅读位置。
	const scrollActiveRef = useRef(false);
	useEffect(() => {
		const active = !!(streaming || hasRunningSubagent || status === "thinking");
		if (active && stickBottom) {
			scrollActiveRef.current = true;
			let rafId = 0;
			const loop = () => {
				scrollToBottom();
				rafId = requestAnimationFrame(loop);
			};
			rafId = requestAnimationFrame(loop);
			return () => cancelAnimationFrame(rafId);
		}
		const wasActive = scrollActiveRef.current;
		scrollActiveRef.current = false;
		if (wasActive && stickBottom) {
			// 刚结束：内容已定稿，下一帧布局稳定后贴底一次
			const raf = requestAnimationFrame(scrollToBottom);
			return () => cancelAnimationFrame(raf);
		}
	}, [streaming, hasRunningSubagent, status, stickBottom, scrollToBottom]);

	// 切换会话：重置停留状态为新会话「在底部」。
	useEffect(() => {
		setStickBottom(true);
	}, [sessionId]);

	// 进入会话（含切换）：消息加载后一次性滚到底显示最新回复；同会话后续消息变化不再自动滚。
	// 这不属于「平时抢滚动」——仅在每个会话首次进入时触发一次。
	// 历史长会话含 ReactMarkdown/代码块/图片等异步布局内容，首帧 scrollHeight 往往偏小，
	// 故滚动后再用 rAF 校正一次（等下一帧布局撑开后重新贴底）。
	useEffect(() => {
		if (
			sessionId &&
			messages.length > 0 &&
			didInitScrollRef.current !== sessionId
		) {
			didInitScrollRef.current = sessionId;
			scrollToBottom();
			const raf = requestAnimationFrame(() => {
				scrollToBottom();
			});
			return () => cancelAnimationFrame(raf);
		}
	}, [sessionId, messages, scrollToBottom]);

	const handleScrollToBottom = useCallback(() => {
		scrollToBottom();
		setStickBottom(true);
	}, [scrollToBottom]);

	// 同回合多 block 合并：SDK 对一个 turn 的每个 block（thinking/text/toolCall）发独立
	// message_start/end，store 在每个 block 的 message_end 即定稿进 messages 并清空 streaming。
	// 于是「block N 已定稿 + block N+1 流式中」会同时渲染两条 assistant 行 → 两个机器人头像。
	// 这里把同 agent 的流式增量并入最后一条已定稿 assistant 行，让整个回合始终是一个头像/一行。
	const lastRow = rows[rows.length - 1];
	const mergeStreamingIntoLast =
		!!streaming &&
		!!lastRow &&
		(lastRow.main.message as any).role === "assistant" &&
		lastRow.main.agentName === streaming.agentName;

	let displayRows = rows;
	if (mergeStreamingIntoLast) {
		const lastMain = lastRow.main.message as any;
		const streamingMain = streaming!.message as any;
		const merged: RenderedRow = {
			main: {
				agentName: lastRow.main.agentName,
				message: {
					...lastMain,
					content: [
						...(lastMain.content ?? []),
						...(streamingMain.content ?? []),
					],
				},
			},
			toolResults: lastRow.toolResults,
			streamingStartIdx: (lastMain.content ?? []).length,
		};
		displayRows = [...rows.slice(0, -1), merged];
	}

	// 进行中的轮判定：status==="thinking"（agent_start 已到、agent_end 未到）且无独立 streaming
	// 占位时，渲染列表最后一行是已定稿 assistant 行 → 它属于进行中的轮。即使已定稿也不折叠——
	// 一轮 agent 调用中第一个块（thinking+工具）定稿后整轮还在跑（长工具执行/后续 text 流式），
	// 折叠会藏住实时过程；必须等 agent_end（status 回 idle）整轮结束才折叠。
	// 独立 streaming 占位存在时（StreamingRow），进行中内容在占位行里，最后一行是上一个已完成轮，
	// 不标记（历史轮全部可折叠）；合并进末行的流式块由 isStreaming=true 自身阻断折叠。
	const lastDisplayRow = displayRows[displayRows.length - 1];
	const isActiveTurnRow =
		status === "thinking" &&
		!streaming &&
		!!lastDisplayRow &&
		(lastDisplayRow.main.message as any).role === "assistant";

	return (
		<div className="relative flex-1 min-h-0 overflow-hidden">
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="absolute inset-0 overflow-auto p-4 flex flex-col gap-4"
				data-testid="message-list"
			>
				{displayRows.map((row, i) => {
					// 合并后的末行正处于流式中，不挂「重新发送」（流式中本就不显示）
					const isMergedStreamingRow =
						mergeStreamingIntoLast && i === displayRows.length - 1;
					const showResend = !isMergedStreamingRow && i === resendUserIdx;
					// 稳定 key：agentName + timestamp，而非数组 index。同 turn 合并（流式结束、
					// collapseSameTurnAssistants）会让行数变化、后续行 index 位移；用 index 会让
					// 合并后 key 复用的行保留/丢失展开态（如 CodeBlockCard）。timestamp 是消息
					// 创建时刻（毫秒），合并行沿用首条 timestamp，key 保持稳定。
					const rowKey = `${row.main.agentName ?? ""}:${(row.main.message as any).timestamp}`;
					return (
						<MessageRow
							key={rowKey}
							row={row}
							sessionId={sessionId}
							showResend={showResend}
							onResend={
								showResend ? (text: string) => handleResend(text, i) : undefined
							}
							isStreaming={isMergedStreamingRow}
							isActiveTurnRow={isActiveTurnRow && i === displayRows.length - 1}
						/>
					);
				})}
				{streaming && !mergeStreamingIntoLast && (
					<StreamingRow streaming={streaming} sessionId={sessionId} />
				)}
			</div>
			{showHistoryLoading && (
				<div
					className="absolute inset-0 flex items-center justify-center"
					data-testid={`history-loading-${sessionId}`}
				>
					<div className="inline-flex items-center gap-2 text-tertiary text-[calc(13px*var(--font-scale))]">
						<span
							className="inline-block w-4 h-4 rounded-full"
							style={{
								border: "2px solid var(--accent-soft)",
								borderTopColor: "var(--accent)",
								animation: "spin 0.8s linear infinite",
							}}
						/>
						{t("message.loadSession")}
					</div>
				</div>
			)}
			{/* 平时（非回复或用户翻阅历史）不在底部时，显示浮动「滚动到底部」按钮 */}
			{!stickBottom && (
				<button
					type="button"
					onClick={handleScrollToBottom}
					data-testid={`scroll-bottom-${sessionId}`}
					aria-label={t("message.scrollToBottom")}
					title={t("message.scrollToBottom")}
					className="absolute bottom-[37px] right-3 z-10 w-9 h-9 rounded-full bg-surface border border-hairline shadow-md flex items-center justify-center text-secondary hover:text-primary transition-colors"
				>
					↓
				</button>
			)}
		</div>
	);
}

function preprocess(messages: SessionMessage[]): RenderedRow[] {
	const rows: RenderedRow[] = [];
	let lastAssistantIdx = -1;
	for (const sm of messages) {
		const m = sm.message as any;
		if (m.role === "toolResult") {
			if (lastAssistantIdx >= 0)
				rows[lastAssistantIdx].toolResults.set(
					m.toolCallId,
					m as ToolResultMessage,
				);
		} else {
			rows.push({ main: sm, toolResults: new Map() });
			lastAssistantIdx = m.role === "assistant" ? rows.length - 1 : -1;
		}
	}
	return collapseSameTurnAssistants(rows);
}

/**
 * 同一 agent 回合内连续的 assistant 行合并成一行（一个头像）。
 * 一个 agent 回合可能被 SDK/历史拆成多条 assistant 消息（工具调用：text+toolCall → toolResult → text），
 * 只要中间没有用户消息（没有换回合），就属于同一回合，应聚合成一条：拼接 content、合并 toolResults。
 * 用户消息天然作为回合边界（role !== assistant 即隔断），不同 agent 也不合并。
 */
function collapseSameTurnAssistants(rows: RenderedRow[]): RenderedRow[] {
	const out: RenderedRow[] = [];
	for (const row of rows) {
		const prev = out[out.length - 1];
		const prevMsg = prev?.main.message as any;
		const curMsg = row.main.message as any;
		const sameTurn =
			!!prev &&
			prevMsg.role === "assistant" &&
			curMsg.role === "assistant" &&
			prev.main.agentName === row.main.agentName;
		if (sameTurn) {
			const mergedMsg: any = {
				...prevMsg,
				content: [...(prevMsg.content ?? []), ...(curMsg.content ?? [])],
			};
			// 整轮耗时挂在轮末 assistant 上（后端注入/agent_end 写回），
			// 合并行主消息取第一条 assistant，必须补拷，否则时长丢失（显示「本轮过程」）。
			if (curMsg.turnElapsedMs != null)
				mergedMsg.turnElapsedMs = curMsg.turnElapsedMs;
			prev.main = {
				agentName: prev.main.agentName,
				message: mergedMsg,
			};
			for (const [k, v] of row.toolResults) prev.toolResults.set(k, v);
		} else {
			out.push({ main: row.main, toolResults: new Map(row.toolResults) });
		}
	}
	return out;
}

function stripAttachmentRefs(content: string): string {
	return content.replace(/\n\nAttachments:\n\[[\s\S]*?\]$/g, "");
}

/**
 * 把技能引用统一改写为 $[name] chip token（渲染为带闪电 SVG 图标的技能 chip）。两种输入形态：
 *
 * 1. <skill name="...">完整内容</skill> XML 块：SDK 的 _expandSkillCommand 把
 *    /skill:name 展开成完整 SKILL.md 内容注入消息，前端只展示技能名。
 * 2. /skill:name 纯文本：输入框里技能是 $[name] chip，发送时 expandTokens 展开为
 *    /skill:name （给 SDK 识别）。当 SDK 未把它再展开成 <skill> XML 时，消息以
 *    纯文本命令形式存储——这条分支兜底把它也渲染为技能 chip，与输入框视觉一致。
 *    约束：只有 knownSkills（已启用技能列表里真实存在的技能名）才渲染，避免任意 /skill:xxx
 *    文本被误判为技能。
 *
 * 两种分支都会吃掉紧跟其后的换行/空格（SDK 注入的 \n\n 或 expandTokens 追加的空格
 * 在 textToHtml 中会变成 <br>/多空格，把技能名和后续文本拆开）。只保留一个空格分隔。
 *
 * @param knownSkills 已知技能名集合（来自 useSkillsStore.skills，即已启用技能）。仅用于过滤
 *   /skill:xxx 纯文本分支；<skill> XML 块分支不做过滤（SDK 已展开即视为有效）。
 */
function formatSkillBlocks(
	content: string,
	knownSkills?: ReadonlySet<string>,
): string {
	// 统一改写为 $[name] chip token：textToHtml 渲染为带闪电图标的技能 chip，
	// 且「重新发送」时 expandTokens 能还原为 /skill:name（技能语义不丢）
	return content
		.replace(
			/<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/g,
			(_m, name) => `$[${name}] `,
		)
		.replace(/\/skill:([^\s/]+)\s*/g, (_m, name) =>
			knownSkills?.has(name) ? `$[${name}] ` : _m,
		);
}

/**
 * 构造「重新发送」的 agent:prompt 负载。
 * 用当前选择的模型重发；缺会话/模型/文本时返回 null（调用方不发）。
 * 纯函数，便于单测（不触网）。
 */
export function buildResendPrompt(args: {
	session: { projectId: string; primaryAgent: AgentName } | undefined;
	sessionId: string;
	text: string;
	model: string | null | undefined;
	thinking: ThinkingLevel;
}): PromptEvent | null {
	if (!args.session || !args.model || !args.text.trim()) return null;
	return {
		type: "agent:prompt",
		projectId: args.session.projectId,
		sessionId: args.sessionId,
		agentName: args.session.primaryAgent,
		text: args.text,
		model: args.model,
		thinking: args.thinking,
	};
}

function formatTime(timestamp: number, yesterdayLabel: string): string {
	const now = new Date();
	const d = new Date(timestamp);

	const isSameDay = (a: Date, b: Date) =>
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate();

	const isYesterday = (a: Date, b: Date) => {
		const yesterday = new Date(b);
		yesterday.setDate(yesterday.getDate() - 1);
		return isSameDay(a, yesterday);
	};

	const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

	if (isSameDay(d, now)) return time;
	if (isYesterday(d, now)) return `${yesterdayLabel} ${time}`;
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${time}`;
}

/** 流式行：首字到达前（content 为空）渲染 loading 气泡；有内容后交给 MessageRow。 */
function StreamingRow({
	streaming,
	sessionId,
}: {
	streaming: SessionMessage;
	sessionId: string;
}) {
	const { t } = useTranslation();
	const m = streaming.message as any;
	const hasContent =
		Array.isArray(m.content) &&
		m.content.some(
			(b: any) =>
				(b?.type === "text" &&
					typeof b.text === "string" &&
					b.text.trim().length > 0) ||
				b?.type === "thinking" ||
				b?.type === "toolCall",
		);
	if (hasContent)
		return (
			<MessageRow
				row={{ main: streaming, toolResults: new Map() }}
				sessionId={sessionId}
				isStreaming
			/>
		);
	return (
		<div className="flex gap-2.5" data-testid={`loading-${sessionId}`}>
			<div className="max-w-[78%]">
				<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-0.5 font-semibold">
					{streaming.agentName ?? t("message.defaultAgent")} ·{" "}
					{formatTime(m.timestamp, t("common.yesterday"))}
				</div>
				<div
					className="inline-flex items-center gap-2 px-3.5 py-2.5 bg-surface border border-hairline"
					style={{ borderRadius: "4px 14px 14px 14px" }}
				>
					<span
						className="inline-block w-3 h-3 rounded-full"
						style={{
							border: "2px solid var(--accent-soft)",
							borderTopColor: "var(--accent)",
							animation: "spin 0.8s linear infinite",
						}}
					/>
					<span className="text-[calc(12.5px*var(--font-scale))] text-tertiary">
						{t("message.thinking")}
					</span>
				</div>
			</div>
		</div>
	);
}

// React.memo：流式期间只有 props 变化的行（合并的末行 / StreamingRow）重渲染，
// 历史行引用稳定（preprocess 已 useMemo），整行跳过——避免每帧全量重解析 Markdown/Prism。
export const MessageRow = memo(function MessageRow({
	row,
	sessionId,
	showResend,
	onResend,
	isStreaming,
	isActiveTurnRow,
}: {
	row: RenderedRow;
	sessionId: string;
	showResend?: boolean;
	onResend?: (text: string) => void;
	isStreaming?: boolean;
	isActiveTurnRow?: boolean;
}) {
	const m = row.main.message as any;
	// hook 须在顶层、任何 early return 之前
	const { t } = useTranslation();
	// 技能名集合：用于过滤 /skill:xxx 纯文本渲染——只有已启用技能列表里真实存在的技能名
	// 才渲染为 chip，避免任意 /skill:xxx 文本被误判。selector 返回稳定数组引用，再 useMemo 成 Set，
	// 避免 selector 每次返回新 Set 触发无限重渲染。
	const enabledSkills = useSkillsStore((s) => s.skills);
	const knownSkills = useMemo(
		() => new Set(enabledSkills.map((k) => k.name)),
		[enabledSkills],
	);

	// custom 消息（如 agent_switch 分隔行 / pi-subagents 完成通知）：
	// 兼容两种字段——前端构造用 type:"custom"，Pi SDK 内存消息用 role:"custom"。
	if (
		m.type === "custom" ||
		m.type === "custom_message" ||
		m.role === "custom"
	) {
		// subagent-notification 是 pi-subagents 在子智能体完成后发的提醒通知，
		// 内容是 task-notification XML，与 delegate toolResult 信息重复（DelegateCard 已展示），过滤。
		if (m.customType === "subagent-notification") return null;
		if (!m.content) return null;
		return (
			<div
				className="text-center text-[calc(11.5px*var(--font-scale))] text-tertiary"
				data-testid={`custom-${sessionId}-${m.timestamp}`}
			>
				—— <AnsiText text={m.content} /> ——
			</div>
		);
	}

	// 上下文压缩摘要消息（role=compactionSummary）：历史重拉时从 jsonl compaction 节点读出，
	// 与 live 的 compaction_end 状态消息同一文案（jsonl 不持久化 estimatedTokensAfter，
	// 两边只一致展示 tokensBefore）。摘要是长篇 markdown，不内联渲染。
	if (m.role === "compactionSummary") {
		const before =
			typeof m.tokensBefore === "number"
				? t("message.compactionBefore", { count: fmtTok(m.tokensBefore) })
				: "";
		return (
			<div
				className="text-center text-[calc(11.5px*var(--font-scale))] text-tertiary"
				data-testid={`compaction-summary-${sessionId}-${m.timestamp}`}
			>
				{t("message.compactionSummary", { before })}
			</div>
		);
	}

	const isUser = m.role === "user";

	if (isUser) {
		const displayText = formatSkillBlocks(
			stripAttachmentRefs(
				typeof m.content === "string"
					? m.content
					: (m.content?.[0]?.text ?? ""),
			),
			knownSkills,
		);
		// textToHtml 把 @[agent]/#[file]/$[skill] token 渲染为 chip。
		// hideTrigger=true：展示场景不显示 @ 触发符（仅显示智能体名 + 头像），与输入框 ComposerTextarea 区分。
		const displayHtml = textToHtml(displayText, { hideTrigger: true });
		return (
			<div
				className="flex flex-row-reverse gap-2.5 max-w-[78%] ml-auto"
				data-testid={`msg-${sessionId}-${m.timestamp}`}
			>
				<div className="flex flex-col items-end">
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-0.5 font-semibold">
						{t("message.me")} · {formatTime(m.timestamp, t("common.yesterday"))}
					</div>
					<div
						className="px-3.5 py-2.5 text-[calc(13.5px*var(--font-scale))] bg-surface text-primary border border-hairline"
						style={{ borderRadius: "14px 4px 14px 14px", lineHeight: 1.55 }}
					>
						<p dangerouslySetInnerHTML={{ __html: displayHtml }} />
					</div>
					{showResend && (
						<button
							type="button"
							data-testid={`resend-${sessionId}-${m.timestamp}`}
							onClick={() => onResend?.(displayText)}
							className="mt-1 self-end inline-flex items-center gap-1 whitespace-nowrap text-[calc(12px*var(--font-scale))] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5 transition-colors"
						>
							<Icon name="refresh" size={11} /> {t("message.resend")}
						</button>
					)}
				</div>
			</div>
		);
	}

	// 按 content 原始顺序切成渲染段：连续 thinking/text/toolCall 各自合并；
	// delegate 调用不进工具分组，原位内联渲染 DelegateCard（委派过程直接可见）
	const blocks: any[] = Array.isArray(m.content) ? m.content : [];
	const segments = segmentBlocks(blocks);
	const fullText = segments
		.flatMap((s) => (s.kind === "text" ? s.texts : []))
		.join("\n\n");
	let lastTextSegIdx = -1;
	segments.forEach((s, i) => {
		if (s.kind === "text") lastTextSegIdx = i;
	});

	// 错误消息（stopReason === "error"）：红色文字
	const isError = m.stopReason === "error";

	// 宽度稳定性：含过程卡片（thinking/toolCalls/delegate/fleet）的消息列固定 78% 宽。
	// 内容驱动的列（max-w-[78%]）会被卡片展开后的宽内容（JSON/thinking 正文）撑大，
	// 导致展开/收起卡片时整列跳宽；纯文本消息保持 shrink-wrap 气泡不变。
	const hasProcessCard = segments.some(
		(s) =>
			s.kind === "thinking" ||
			s.kind === "toolCalls" ||
			s.kind === "delegate" ||
			s.kind === "fleet",
	);

	// 轮级折叠：整轮已结束（非流式 + 非进行中轮）+ 含过程段 → 过程段折叠为摘要行，
	// 只保留最后一段 text 回复在外（中间 text 段也折叠进摘要行）。
	// 进行中的轮（status==="thinking" 的末行）即使已定稿也不折叠——长工具执行/后续
	// text 流式仍在跑，折叠会藏住实时过程；必须等 agent_end（整轮结束）才折叠。
	const canCollapse = hasProcessCard && !isStreaming && !isActiveTurnRow;
	// 过程段 + 中间 text 段（除最后一段 text 外全部折叠进摘要行）；最后一段 text 是最终回复，保留在外
	const processSegs = segments.filter((_, i) => i !== lastTextSegIdx);
	const finalTextSeg =
		lastTextSegIdx >= 0 ? segments[lastTextSegIdx] : undefined;
	// 步骤数只计过程段（thinking/toolCalls/delegate/fleet），中间 text 段不计
	const processSteps = segments.filter((s) => s.kind !== "text").length;

	// 单段渲染分发：thinking/toolCalls/delegate/fleet 为过程卡，text 为主回复气泡。
	// 折叠分支与非折叠分支共用，保证两种模式渲染完全一致；key 由调用方传入
	//（折叠分支过程段从 0 起、最终回复 text 段接续；非折叠分支用原 segments index，delegate/fleet
	// 仍以 seg.call.id 为 key）。CopyButton 归属用引用比较 seg === segments[lastTextSegIdx]
	//（即 finalTextSeg——折叠分支最终回复段 key 重排后 index 判断不再等价）。
	const renderSeg = (seg: Segment, key: number, segIsStreaming: boolean) => {
		// 思考过程 — ProcessCard：每段独立成卡（不合并），区分 finalized vs streaming
		if (seg.kind === "thinking") {
			return (
				<ThinkingCard
					key={key}
					thinking={seg.texts.join("\n")}
					isStreaming={segIsStreaming}
				/>
			);
		}
		// 工具调用 — ProcessCard：>1 个连续调用归成组卡，单工具直接单卡
		if (seg.kind === "toolCalls") {
			return (
				<ToolGroupCard
					key={key}
					toolCalls={seg.calls}
					results={row.toolResults}
					isStreaming={segIsStreaming}
				/>
			);
		}
		// 委派调用 — 内联卡片（不进工具分组，与普通内容穿插）
		if (seg.kind === "delegate") {
			return (
				<DelegateCard
					key={seg.call.id}
					sessionId={sessionId}
					toolCall={seg.call}
					result={row.toolResults.get(seg.call.id)}
					isStreaming={segIsStreaming}
				/>
			);
		}
		// 并行派发 — 内联卡片（FleetCard 展示多个子任务）
		if (seg.kind === "fleet") {
			return (
				<FleetCard
					key={seg.call.id}
					sessionId={sessionId}
					toolCall={seg.call}
					result={row.toolResults.get(seg.call.id)}
					isStreaming={segIsStreaming}
				/>
			);
		}
		// 主回复内容 — 文字 + markdown
		return (
			<div key={key} className="flex flex-col gap-1" data-testid="text-bubble">
				<div
					className={`text-[calc(13.5px*var(--font-scale))] px-3.5 py-2.5 bg-surface border border-hairline shadow-sm ${isError ? "text-danger" : "text-primary"}`}
					style={{ lineHeight: 1.55, borderRadius: "4px 14px 14px 14px" }}
				>
					{seg.texts.map((text, i) =>
						segIsStreaming ? (
							// 流式中的 text 段：llm-ui 分块渲染（闭合块 memo 化、未闭合尾巴不高亮不解析）
							<StreamingMarkdown
								key={seg.blockIdxs[i]}
								text={text}
								sessionId={sessionId}
							/>
						) : (
							// 分片 memo：流式期间已定稿 block（text 引用不变）跳过重渲染，
							// 只有流式中的 block 每帧重跑 Markdown——避免合并行里定稿段落
							// 随每帧重建全量重解析。key 用 block 原始 idx（稳定），不用数组 index。
							<MarkdownBlock
								key={seg.blockIdxs[i]}
								text={text}
								sessionId={sessionId}
							/>
						),
					)}
				</div>
				{seg === segments[lastTextSegIdx] && !isStreaming && (
					<div className="flex justify-end items-center">
						<ExportButton sessionId={sessionId} uptoTimestamp={m.timestamp} />
						<CopyButton
							text={fullText}
							testId={`copy-${sessionId}-${m.timestamp}`}
						/>
					</div>
				)}
			</div>
		);
	};

	return (
		<div
			className="flex gap-2.5"
			data-testid={`msg-${sessionId}-${m.timestamp}`}
		>
			<div className={`${hasProcessCard ? "w-[78%]" : "max-w-[78%]"} min-w-0`}>
				<div className="text-[calc(11px*var(--font-scale))] text-tertiary mb-0.5 font-semibold">
					{row.main.agentName ?? t("message.defaultAgent")} ·{" "}
					{formatTime(m.timestamp, t("common.yesterday"))}
				</div>

				{canCollapse ? (
					<>
						<TurnSummary steps={processSteps} elapsedMs={m.turnElapsedMs}>
							{processSegs.map((seg, si) => renderSeg(seg, si, false))}
						</TurnSummary>
						{finalTextSeg && renderSeg(finalTextSeg, processSegs.length, false)}
					</>
				) : (
					segments.map((seg, si) =>
						renderSeg(
							seg,
							si,
							!!isStreaming &&
								(row.streamingStartIdx == null ||
									seg.firstBlockIdx >= row.streamingStartIdx),
						),
					)
				)}
			</div>
		</div>
	);
});

// 单 text block 的 Markdown 渲染。memo：流式合并行中只有内容变化的 block（流式中的
// 末块）重渲染，已定稿 block（text 字符串引用不变）整块跳过——避免合并行里定稿段落
// 每帧全量重跑 ReactMarkdown/remarkGfm（超长回复的卡顿热点）。
const MarkdownBlock = memo(function MarkdownBlock({
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
		<div className="prose prose-sm max-w-none" data-testid="text-block">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

type Segment =
	| { kind: "thinking"; texts: string[]; firstBlockIdx: number }
	| {
			kind: "text";
			texts: string[];
			firstBlockIdx: number;
			blockIdxs: number[];
	  }
	| { kind: "toolCalls"; calls: any[]; firstBlockIdx: number }
	| { kind: "delegate"; call: any; firstBlockIdx: number }
	| { kind: "fleet"; call: any; firstBlockIdx: number };

/**
 * 把 assistant content 切成渲染段，保持 SDK 事件到达的时间线顺序。
 *
 * 规则：
 * - 连续同类型（thinking / text / 普通 toolCall）合并成一个段。
 * - 类型变化时立即结束当前段，按出现顺序开启新段。
 * - delegate/fleet toolCall 作为切割锚点：遇到时先 flush 当前段，再插入独立 delegate/fleet 段。
 *
 * 例：text₁ → toolCall → text₂ → delegate → text₃ → fleet → text₄
 *   → [text₁][toolCalls][delegate][text₂][fleet][text₃][text₄]
 */
function segmentBlocks(blocks: any[]): Segment[] {
	const segs: Segment[] = [];
	let cur: Segment | null = null;

	const push = () => {
		if (cur) {
			segs.push(cur);
			cur = null;
		}
	};

	for (let idx = 0; idx < blocks.length; idx++) {
		const b = blocks[idx];
		// 流式累积（message_update 按 contentIndex 赋值）会产出稀疏数组空洞，
		// 历史 JSONL 也可能带 null 元素；for 循环不跳过空洞，必须跳过 undefined
		if (!b) continue;
		if (b.type === "thinking") {
			// thinking 不合并：每段独立成卡，区分 finalized/streaming
			push();
			segs.push({ kind: "thinking", texts: [b.thinking], firstBlockIdx: idx });
		} else if (b.type === "text") {
			if (!b.text?.trim()) continue;
			if (!cur || cur.kind !== "text") {
				push();
				cur = { kind: "text", texts: [], firstBlockIdx: idx, blockIdxs: [] };
			}
			cur.texts.push(b.text);
			cur.blockIdxs.push(idx);
		} else if (b.type === "toolCall") {
			if (b.name === "delegate") {
				push();
				segs.push({ kind: "delegate", call: b, firstBlockIdx: idx });
			} else if (b.name === "fleet") {
				push();
				segs.push({ kind: "fleet", call: b, firstBlockIdx: idx });
			} else {
				if (!cur || cur.kind !== "toolCalls") {
					push();
					cur = { kind: "toolCalls", calls: [], firstBlockIdx: idx };
				}
				cur.calls.push(b);
			}
		}
	}
	push();
	return segs;
}

function CopyButton({ text, testId }: { text: string; testId?: string }) {
	const addToast = useToastStore((s) => s.add);
	const { t } = useTranslation();
	const handleCopy = async () => {
		try {
			await copyToClipboard(text);
			addToast(t("common.copiedToClipboard"), "success");
		} catch {
			addToast(t("common.copyFailed"), "error");
		}
	};
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={handleCopy}
			className="p-1 rounded-md text-tertiary opacity-60 hover:opacity-100 hover:text-primary hover:bg-surface-elevated transition-colors"
			title={t("common.copy")}
			aria-label={t("common.copyAnswer")}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
				<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
			</svg>
		</button>
	);
}
