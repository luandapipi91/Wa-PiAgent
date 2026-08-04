import { useEffect, useState } from "react";
import {
	SYSTEM_PROJECT_ID,
	resolveSessionCwd,
	type AgentStatus,
} from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { useIsBlocked } from "../store/ask";
import { useExplorerStore } from "../store/explorer";
import { SidebarResizer } from "./SidebarResizer";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskDock } from "./ask/AskDock";
import { AgentSwitcher } from "./AgentSwitcher";
import { ExplorerPanel } from "./ExplorerPanel";
import { STATUS_COLORS } from "../theme/colors";
import { api } from "../api-client";
import { fmtTok } from "../util/format";

interface Props {
	sessionId: string;
}

// agent 全局状态的中文文案（header 直接展示给用户，不暴露英文枚举值）
const AGENT_STATE_LABEL: Record<AgentStatus, string> = {
	idle: "空闲",
	thinking: "思考中",
	blocked: "等待回复",
};

export function SessionView({ sessionId }: Props) {
	const session = useProjectsStore((s) =>
		s.sessions.find((x) => x.id === sessionId),
	);
	const project = useProjectsStore((s) =>
		s.projects.find((p) => p.id === session?.projectId),
	);
	const queue = useSessionStore((s) => s.queueBySession[sessionId]);
	const status = useSessionStore((s) => s.statusBySession[sessionId] ?? "idle");
	const historyLoading = useSessionStore(
		(s) => s.historyLoadingBySession[sessionId] ?? false,
	);
	const isBlocked = useIsBlocked(sessionId);
	const reloading = useSessionStore((s) => s.reloading);
	const messages = useSessionStore((s) => s.messagesBySession[sessionId]);
	const isNewSession = !messages || messages.length === 0;

	// 思考起算时间（按会话独立，切会话不重置/不沿用）。每秒计时交给 <ThinkingTimer> 独立持有，
	// 避免每秒 setElapsed 重渲染整个 SessionView（含 MessageList 的 markdown）造成计时卡顿。
	const thinkingSince = useSessionStore(
		(s) => s.thinkingSinceBySession[sessionId] ?? null,
	);
	// Token 计数
	const tokenTotal = useSessionStore((s) => s.tokenTotals[sessionId]);
	const lastUsage = useSessionStore((s) => s.lastUsageBySession[sessionId]);
	// 当前上下文窗口占用（session:stats 官方口径，供进度条 + 「占用」数值；无本地估算）
	const contextUsage = useSessionStore(
		(s) => s.contextUsageBySession[sessionId],
	);

	useEffect(() => {
		// 进入该会话即视为「已读」，清掉会话列表的 new 角标
		useSessionStore.getState().markRead(sessionId);
		// 标记历史加载中：响应到达前置 true，MessageList 在无消息时显示 loading
		useSessionStore.getState().setHistoryLoading(sessionId, true);
		void (async () => {
			try {
				const [statsRes, messagesRes] = await Promise.all([
					api
						.get(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
						.catch(() => null),
					api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
				]);
				const res = messagesRes as {
					messages: any[];
					isActive: boolean;
					thinkingSince: number | null;
				};
				useSessionStore.getState().setMessages(sessionId, res.messages);
				useSessionStore
					.getState()
					.seedTokenTotal(sessionId, res.messages, (statsRes as any)?.stats);
				useSessionStore
					.getState()
					.setActiveStatus(sessionId, res.isActive, res.thinkingSince);
			} finally {
				useSessionStore.getState().setHistoryLoading(sessionId, false);
			}
		})();
	}, [sessionId]);

	// 下面的 hooks 必须在 early return 之前调用，否则 session 在/不在两次渲染
	// 调用的 hooks 数量不一致，触发 "Rendered fewer hooks than expected"。
	const isRunning = status === "thinking";
	// 扩展 setStatus 状态条目：聊天列底部状态栏（右对齐）
	const extStatuses = useSessionStore((s) => s.extStatusBySession[sessionId]);
	const extStatusEntries = extStatuses ? Object.entries(extStatuses) : [];
	// 扩展 setWidget 文本块：按 placement 分组到 Composer 上/下方
	const widgets = useSessionStore((s) => s.extWidgetBySession[sessionId]);
	const widgetEntries = widgets ? Object.entries(widgets) : [];
	const aboveWidgets = widgetEntries.filter(
		([, w]) => w.placement !== "belowEditor",
	);
	const belowWidgets = widgetEntries.filter(
		([, w]) => w.placement === "belowEditor",
	);
	const [stopping, setStopping] = useState(false);
	useEffect(() => {
		if (!isRunning) setStopping(false);
	}, [isRunning]);

	if (!session) return null;
	// header 状态（圆点颜色与文案共用）：等待回复 blocked > 运行中 thinking > 空闲 idle
	const headerStatus: AgentStatus = isBlocked ? "blocked" : status;
	const steering = queue?.steering ?? [];
	const followUp = queue?.followUp ?? [];
	const hasQueue = steering.length > 0 || followUp.length > 0;

	const handleStop = () => {
		console.log(`[SessionView] handleStop sessionId=${sessionId}`);
		setStopping(true);
		void api.post(
			`/api/agents/${encodeURIComponent(session.projectId)}/${encodeURIComponent(sessionId)}/abort`,
			{ agentName: session.primaryAgent },
		);
	};
	// 乐观更新：立即移动消息位置（去重防止与 kernel queue_update 叠加），后台发 API
	const handlePromote = (text: string) => {
		const idx = followUp.indexOf(text);
		const remaining =
			idx >= 0
				? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)]
				: [...followUp];
		useSessionStore.setState((s) => {
			const cur = s.queueBySession[sessionId]?.steering ?? [];
			return {
				queueBySession: {
					...s.queueBySession,
					[sessionId]: {
						steering: cur.includes(text) ? cur : [...cur, text],
						followUp: remaining,
					},
				},
			};
		});
		void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
			text,
		});
	};
	const handleImmediate = (text: string) => {
		const idx = followUp.indexOf(text);
		const remaining =
			idx >= 0
				? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)]
				: [...followUp];
		useSessionStore.setState((s) => {
			const cur = s.queueBySession[sessionId]?.steering ?? [];
			return {
				queueBySession: {
					...s.queueBySession,
					[sessionId]: {
						steering: cur.includes(text) ? cur : [...cur, text],
						followUp: remaining,
					},
				},
			};
		});
		void api.post(
			`/api/sessions/${encodeURIComponent(sessionId)}/steer/immediate`,
			{ text },
		);
	};
	const handleClearFollowUp = () => {
		useSessionStore.setState((s) => ({
			queueBySession: {
				...s.queueBySession,
				[sessionId]: {
					steering: s.queueBySession[sessionId]?.steering ?? [],
					followUp: [],
				},
			},
		}));
		void api.post(
			`/api/sessions/${encodeURIComponent(sessionId)}/clear-queue`,
			{},
		);
	};

	// 右侧文件树面板：开关状态 + 宽度来自 explorer store
	const explorerOpen = useExplorerStore((s) => s.open);
	const explorerWidth = useExplorerStore((s) => s.width);
	// 文件树根目录：普通项目用 project.cwd，默认工作区会话用其专属临时目录 workdir/<createdAt>/
	const workspaceDir = resolveSessionCwd(session, { cwd: project?.cwd ?? "" });

	return (
		<div className="flex-1 flex h-full" data-testid="session-view">
			{/* 左侧主区：对话内容 */}
			<div className="flex-1 flex flex-col overflow-hidden min-w-0">
				{/* 顶部状态栏 */}
				<header className="flex items-center gap-3 px-5 py-3 border-b border-hairline bg-surface">
					<div className="flex-1">
						<div className="flex items-center gap-2">
							<span className="text-[calc(14px*var(--font-scale))] font-bold text-primary">
								{session.title}
							</span>
							<AgentSwitcher sessionId={sessionId} />
						</div>
						<div className="text-[calc(11.5px*var(--font-scale))] text-tertiary mt-px">
							<span
								className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
								style={{ background: STATUS_COLORS[headerStatus] }}
								data-testid="session-status-dot"
							/>
							{/* 默认工作区会话：不暴露内部工作目录，显示友好文案；普通项目会话仍显示 cwd */}
							{session.projectId === SYSTEM_PROJECT_ID
								? "默认工作区 · 工作目录"
								: (project?.cwd ?? "")}{" "}
							· {AGENT_STATE_LABEL[headerStatus]}
						</div>
					</div>
					{/* Token 胶囊标签组 */}
					{lastUsage && (
						<div
							className="flex items-center gap-2"
							data-testid="token-capsules"
						>
							<span className="token-capsule">
								本轮: ↑{fmtTok(lastUsage.input)}/↓{fmtTok(lastUsage.output)}
							</span>
							{/* 占用 + 进度条胶囊（只认官方 contextUsage，无本地估算） */}
							{contextUsage?.used != null &&
								contextUsage.total > 0 &&
								(() => {
									const pct = Math.min(
										(contextUsage.used / contextUsage.total) * 100,
										100,
									);
									const w = Math.max(Math.round(pct), 2);
									return (
										<span className="token-capsule token-capsule--stack">
											<span
												className="token-occupied"
												data-testid="token-occupied"
											>
												占用 {fmtTok(contextUsage.used)}
											</span>
											<span className="token-progress" data-testid="token-progress">
												<span
													className="token-progress-fill"
													style={{ width: `${w}%` }}
												/>
											</span>
										</span>
									);
								})()}
							{/* 累计胶囊：独立一列；有子代理消耗时第二行拆分主/子 */}
							{tokenTotal && (
								<span
									className={`token-capsule token-capsule--total${tokenTotal.subagent ? " token-capsule--stack" : ""}`}
									data-testid="token-total"
								>
									累计 {fmtTok(tokenTotal.total)}
									{tokenTotal.subagent ? (
										<span className="token-split" data-testid="token-split">
											主{" "}
											{fmtTok(
												tokenTotal.main ??
													tokenTotal.total - tokenTotal.subagent,
											)}{" "}
											· 子 {fmtTok(tokenTotal.subagent)}
										</span>
									) : null}
								</span>
							)}
							{(lastUsage.cacheRead > 0 || lastUsage.cacheWrite > 0) &&
								(() => {
									const rate =
										(lastUsage.cacheRead /
											(lastUsage.input +
												lastUsage.cacheRead +
												lastUsage.cacheWrite)) *
										100;
									const danger = rate < 90;
									return (
										<span
											className={`token-capsule token-capsule--cache${danger ? " token-capsule--cache-danger" : ""}`}
										>
											缓存 {Math.round(rate * 10) / 10}%
										</span>
									);
								})()}
						</div>
					)}
					{/* 文件树面板开关按钮 */}
					<button
						type="button"
						className="fv-btn"
						data-testid="btn-explorer"
						data-active={explorerOpen ? "true" : "false"}
						onClick={() => useExplorerStore.getState().toggle()}
						title="项目文件"
						style={
							explorerOpen
								? { borderColor: "var(--accent)", color: "var(--accent)" }
								: { color: "var(--text-tertiary)" }
						}
					>
						<svg
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
						</svg>
					</button>
				</header>

				{/* 队列面板：agent 运行中或有队列时显示 */}
				{(isRunning || hasQueue) && (
					<div
						className="px-5 py-2.5 border-b border-hairline bg-surface-elevated"
						data-testid="queue-panel"
					>
						{/* 状态栏：spinner + 计时 + 停止 + 清空 */}
						{(isRunning || followUp.length > 0) && (
							<div className="flex items-center mb-1">
								{isRunning && (
									<span className="flex items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-secondary flex-1">
										<span
											className="inline-block w-3.5 h-3.5 rounded-full"
											style={{
												border: "2px solid var(--accent-soft)",
												borderTopColor: "var(--accent)",
												animation: "spin 0.8s linear infinite",
											}}
										/>
										思考中 · <ThinkingTimer thinkingSince={thinkingSince} />s
									</span>
								)}
								{!isRunning && <span className="flex-1" />}
								<div className="flex items-center gap-2">
									{isRunning && (
										<button
											onClick={handleStop}
											disabled={historyLoading || stopping}
											className={`px-2.5 py-0.5 rounded-pill text-[calc(11.5px*var(--font-scale))] font-semibold border-0 ${historyLoading || stopping ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-danger-soft text-danger cursor-pointer"}`}
											data-testid="btn-stop"
										>
											{stopping ? "停止中…" : "停止"}
										</button>
									)}
									{followUp.length > 0 && (
										<button
											onClick={handleClearFollowUp}
											disabled={historyLoading}
											className={`text-[calc(11.5px*var(--font-scale))] px-2 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-danger-soft text-danger cursor-pointer"}`}
											data-testid="btn-clear-queue"
										>
											清空
										</button>
									)}
								</div>
							</div>
						)}

						{/* 引导中消息 */}
						{steering.length > 0 && (
							<div
								className="mt-2 p-2.5 rounded-sm bg-warning-soft"
								style={{ borderLeft: "3px solid var(--warning)" }}
							>
								<div className="flex items-center justify-between">
									<span className="text-warning text-[calc(11.5px*var(--font-scale))] font-bold">
										引导中
									</span>
								</div>
								{steering.map((msg, i) => (
									<div key={i} className="text-[calc(12px*var(--font-scale))] text-secondary mt-1 pl-2">
										{msg}
									</div>
								))}
							</div>
						)}

						{/* 排队消息列表 */}
						{followUp.length > 0 && (
							<div>
								<div className="flex items-center justify-between mb-1">
									<span className="text-tertiary text-[calc(11.5px*var(--font-scale))]">
										排队 {followUp.length} 条
									</span>
								</div>
								<div className="rounded-sm bg-surface border border-hairline">
									{followUp.map((msg, i) => (
										<div
											key={i}
											className={`flex items-center justify-between px-2.5 py-1.5 ${i < followUp.length - 1 ? "border-b border-hairline" : ""}`}
										>
											<span className="text-secondary truncate flex-1 text-[calc(12.5px*var(--font-scale))]">
												{msg}
											</span>
											<div className="flex ml-2 gap-2">
												<button
													onClick={() => handlePromote(msg)}
													disabled={historyLoading}
													className={`text-[calc(11.5px*var(--font-scale))] px-1.5 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-accent-soft text-accent cursor-pointer"}`}
													data-testid="btn-promote"
												>
													引导
												</button>
												{!isRunning && (
													<button
														onClick={() => handleImmediate(msg)}
														disabled={historyLoading}
														className={`text-[calc(11.5px*var(--font-scale))] px-1.5 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-success-soft text-success cursor-pointer"}`}
														data-testid="btn-immediate"
													>
														立即
													</button>
												)}
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* 提示 */}
						{followUp.length > 0 && (
							<div className="text-tertiary text-[calc(11.5px*var(--font-scale))] mt-1">
								{isRunning
									? "💡 引导：下回合立即生效 │ 停止当前后可点击“立即”"
									: "💡 引导：下回合立即生效 │ 立即：立即执行该消息"}
							</div>
						)}
					</div>
				)}

				<MessageList sessionId={sessionId} />
				<AskDock sessionId={sessionId} />
				{/* 扩展 setWidget（aboveEditor）：Composer 上方文本块 */}
				{aboveWidgets.map(([key, w]) => (
					<ExtWidget
						key={key}
						widgetKey={key}
						lines={w.lines}
						accentColor="var(--accent)"
					/>
				))}
				<Composer
					sessionId={sessionId}
					agentName={session.primaryAgent}
					isRunning={status === "thinking"}
					isNewSession={!messages || messages.length === 0}
					disabled={isBlocked || reloading}
				/>
				{/* 扩展 setWidget（belowEditor）：Composer 下方文本块 */}
				{belowWidgets.map(([key, w]) => (
					<ExtWidget
						key={key}
						widgetKey={key}
						lines={w.lines}
						accentColor="var(--hairline-strong)"
						className="mx-4 mt-2 mb-2"
					/>
				))}
				{/* 扩展 setStatus：聊天列底部状态栏（右对齐，只占中间区域） */}
				{extStatusEntries.length > 0 && (
					<div
						className="flex items-center justify-end gap-4 px-4 border-t border-hairline bg-surface-elevated text-[calc(11.5px*var(--font-scale))] text-secondary"
						style={{ height: 26, flexShrink: 0 }}
						data-testid="ext-status-bar"
					>
						{extStatusEntries.map(([key, text]) => (
							<span key={key} className="flex items-center gap-1.5 min-w-0">
								<span
									className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
									style={{ background: "var(--accent)" }}
								/>
								<span className="truncate">{text}</span>
							</span>
						))}
					</div>
				)}
			</div>
			{/* 右侧文件树面板：开关由 explorer store 控制；双击文件弹窗预览 */}
			{explorerOpen && (
				<>
					<SidebarResizer
						side="right"
						onResize={(w) => useExplorerStore.getState().setWidth(w)}
						testId="explorer-resizer"
					/>
					<aside
						className="flex flex-col border-l border-hairline bg-surface"
						style={{ width: explorerWidth, flexShrink: 0 }}
						data-testid="explorer-aside"
					>
						<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline">
							<span className="text-[calc(12px*var(--font-scale))] font-semibold text-primary flex-1">
								项目文件
							</span>
							<button
								className="fv-btn"
								onClick={() => useExplorerStore.getState().toggle()}
								title="收起面板"
							>
								›
							</button>
						</div>
						{/* 文件树占满面板，双击文件触发弹窗预览 */}
						<div className="flex-1 overflow-auto">
							<ExplorerPanel
								workspaceDir={workspaceDir}
								onOpenFile={(path) =>
									useSessionStore.getState().openFilePreview(path, sessionId)
								}
							/>
						</div>
					</aside>
				</>
			)}
		</div>
	);
}

/**
 * 独立的思考计时器：把「每秒 setElapsed」的重渲染隔离在本组件内，
 * 不向上冒泡到 SessionView（进而避免连带重渲染 MessageList 的 markdown）造成计时卡顿。
 * elapsed 始终按真实时间 thinkingSince 推算，切会话/重渲染均准确。
 */
function ThinkingTimer({ thinkingSince }: { thinkingSince: number | null }) {
	const [elapsed, setElapsed] = useState(() =>
		thinkingSince == null ? 0 : Math.floor((Date.now() - thinkingSince) / 1000),
	);
	useEffect(() => {
		if (thinkingSince == null) {
			setElapsed(0);
			return;
		}
		const tick = () =>
			setElapsed(Math.floor((Date.now() - thinkingSince) / 1000));
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [thinkingSince]);
	return <>{elapsed}</>;
}

/**
 * 扩展 setWidget 文本块：可折叠，默认收起为一行摘要，背景透明不遮挡对话内容。
 * 收起时只占一行高度（箭头 + widget key + 首行预览），展开后显示完整等宽文本。
 */
function ExtWidget({
	widgetKey,
	lines,
	accentColor,
	className = "mx-4 mb-2",
}: {
	widgetKey: string;
	lines: string[];
	accentColor: string;
	className?: string;
}) {
	const [collapsed, setCollapsed] = useState(true);

	return (
		<div className={className} data-testid={`ext-widget-${widgetKey}`}>
			<button
				type="button"
				onClick={() => setCollapsed((v) => !v)}
				className="flex w-full items-center gap-1.5 text-left text-[calc(11.5px*var(--font-scale))] text-tertiary transition-colors hover:text-secondary"
			>
				<span
					className="inline-block text-[calc(9px*var(--font-scale))] transition-transform"
					style={{
						color: accentColor,
						transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
					}}
				>
					▶
				</span>
				<span className="font-mono">{widgetKey}</span>
				{collapsed && (
					<span className="min-w-0 flex-1 truncate text-secondary/60">
						{lines[0]}
						{lines.length > 1 ? ` · 共 ${lines.length} 行` : ""}
					</span>
				)}
			</button>
			{!collapsed && (
				<div
					className="mt-1 whitespace-pre-wrap rounded-md border border-hairline/50 px-3 py-2 font-mono text-[calc(12px*var(--font-scale))] text-secondary"
					style={{ borderLeft: `3px solid ${accentColor}` }}
				>
					{lines.join("\n")}
				</div>
			)}
		</div>
	);
}
