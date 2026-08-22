import { memo, useEffect, useRef, useState } from "react";
import {
	SYSTEM_PROJECT_ID,
	resolveSessionCwd,
	type AgentStatus,
	type ChannelConversationInfo,
} from "@wa-pi/shared";
import { useTranslation } from "../i18n/useTranslation";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { useBrowserStore } from "../store/browser";
import { useIsBlocked } from "../store/ask";
import { useExplorerStore } from "../store/explorer";
import { SidebarResizer } from "./SidebarResizer";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskDock } from "./ask/AskDock";
import { AgentSwitcher } from "./AgentSwitcher";
import ImSessionTitle from "./ImSessionTitle";
import { ExplorerPanel } from "./ExplorerPanel";
import { STATUS_COLORS } from "../theme/colors";
import { AnsiText } from "./ui/AnsiText";
import { api } from "../api-client";
import { fmtTok } from "../util/format";
import { Icon } from "./ui/Icon";
import { isHtmlPath } from "../preview-url";

interface Props {
	sessionId: string;
	/** 来源文案（IM 接入会话显示，拼到 header 状态行末尾，如「经『客服机器人』接入」） */
	sourceLabel?: string;
	/** IM 会话信息：存在则顶部标题改为可编辑通讯录名（ImSessionTitle），否则普通标题 */
	imConv?: ChannelConversationInfo;
}

// agent 全局状态的 i18n key（header 直接展示给用户，不暴露英文枚举值）
const AGENT_STATE_KEY: Record<AgentStatus, string> = {
	idle: "session.stateIdle",
	thinking: "session.stateThinking",
	blocked: "session.stateBlocked",
};

// memo 包裹：浏览器预览拖拽期 App 顶层随 splitRatio/floatRect 每帧重渲染，
// props 不变时跳过本组件（含 MessageList markdown）的 reconcile
export const SessionView = memo(function SessionView({ sessionId, sourceLabel, imConv }: Props) {
	const { t } = useTranslation();
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
				// thinking 的设置由 isActive=true 驱动（打开正在跑的会话补设）；
				// 清除由 SDK 事件（agent_end / failTurn / agent_settled）驱动。
				// isActive=false 不在此干预——避免冷启动竞态（getCommands 先触发 ensureStarted
				// 使 starting 有 sid 但 _promptLocks 未命中）误报 false 而清除乐观 thinking。
				// 重连/重启的权威复位由 onReconnect 的 setActiveStatus 负责。
				if (res.isActive) {
					useSessionStore
						.getState()
						.setActiveStatus(sessionId, true, res.thinkingSince);
				}
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
	// 扩展 setWidget 文本块：统一交给 ExtWidgetDock 渲染（收起悬浮队列 + 展开占位）
	const widgets = useSessionStore((s) => s.extWidgetBySession[sessionId]);
	const widgetEntries = widgets ? Object.entries(widgets) : [];
	const [stopping, setStopping] = useState(false);
	useEffect(() => {
		if (!isRunning) setStopping(false);
	}, [isRunning]);

	// 右侧文件树面板：开关状态 + 宽度来自 explorer store
	// 必须在 early return 之前调用，否则 session 在/不在两次渲染调用
	// 的 hooks 数量不一致，触发 "Rendered fewer hooks than expected"（#300）。
	const explorerOpen = useExplorerStore((s) => s.open);
	const explorerWidth = useExplorerStore((s) => s.width);

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

	// 文件树根目录：普通项目用 project.cwd，默认工作区会话用其专属临时目录 workdir/<createdAt>/
	const workspaceDir = resolveSessionCwd(session, { cwd: project?.cwd ?? "" });

	return (
		<div className="flex-1 flex h-full" data-testid="session-view">
			{/* 左侧主区：对话内容 */}
			<div className="relative flex-1 flex flex-col overflow-hidden min-w-0">
				{/* 顶部状态栏 */}
				<header className="flex items-center gap-3 px-5 py-3 border-b border-hairline bg-surface">
					<div className="flex-1">
						<div className="flex items-center gap-2">
							{imConv ? (
								<ImSessionTitle sessionTitle={session.title} imConv={imConv} />
							) : (
								<span className="text-[calc(14px*var(--font-scale))] font-bold text-primary">
									{session.title}
								</span>
							)}
							{/* IM 接入会话：智能体由机器人配置锁定，不暴露切换入口；普通会话保留 */}
							{!sourceLabel && <AgentSwitcher sessionId={sessionId} />}
						</div>
						<div className="text-[calc(11.5px*var(--font-scale))] text-tertiary mt-px">
							<span
								className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
								style={{ background: STATUS_COLORS[headerStatus] }}
								data-testid="session-status-dot"
							/>
							{/* 默认工作区会话：不暴露内部工作目录，显示友好文案；普通项目会话仍显示 cwd */}
							{session.projectId === SYSTEM_PROJECT_ID
								? t("session.defaultWorkspace")
								: (project?.cwd ?? "")}{" "}
							· {t(AGENT_STATE_KEY[headerStatus])}
							{sourceLabel && ` · ${sourceLabel}`}
						</div>
					</div>
					{/* Token 胶囊标签组 */}
					{lastUsage && (
						<div className="flex items-center gap-2" data-testid="token-capsules">
							<span className="token-capsule">
								{t("session.thisTurn", {
									input: fmtTok(lastUsage.input),
									output: fmtTok(lastUsage.output),
								})}
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
											<span className="token-occupied" data-testid="token-occupied">
												{t("session.occupied", {
													used: fmtTok(contextUsage.used),
												})}
											</span>
											<span className="token-progress" data-testid="token-progress">
												<span className="token-progress-fill" style={{ width: `${w}%` }} />
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
									{t("session.total", { total: fmtTok(tokenTotal.total) })}
									{tokenTotal.subagent ? (
										<span className="token-split" data-testid="token-split">
											{t("session.totalSplitMain", {
												main: fmtTok(
													tokenTotal.main ?? tokenTotal.total - tokenTotal.subagent,
												),
											})}{" "}
											·{" "}
											{t("session.totalSplitSub", {
												sub: fmtTok(tokenTotal.subagent),
											})}
										</span>
									) : null}
								</span>
							)}
							{(lastUsage.cacheRead > 0 || lastUsage.cacheWrite > 0) &&
								(() => {
									const rate =
										(lastUsage.cacheRead /
											(lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite)) *
										100;
									const danger = rate < 90;
									return (
										<span
											className={`token-capsule token-capsule--cache${danger ? " token-capsule--cache-danger" : ""}`}
										>
											{t("session.cache", { rate: Math.floor(rate * 10) / 10 })}
										</span>
									);
								})()}
						</div>
					)}
					{/* 文件树面板开关按钮 */}
					<button
						type="button"
						className="fv-btn fv-btn--icon"
						data-testid="btn-explorer"
						data-active={explorerOpen ? "true" : "false"}
						onClick={() => useExplorerStore.getState().toggle()}
						title={t("session.projectFiles")}
						style={
							explorerOpen
								? { color: "var(--accent)" }
								: { color: "var(--text-tertiary)" }
						}
					>
						{/* 图标基础尺寸 18px，跟随全局 --font-scale 缩放（与 SettingsButton/ProjectItem 同口径） */}
						<Icon
							name="folder"
							size="1em"
							className="text-[calc(18px*var(--font-scale))]"
						/>
					</button>
					{/* 浏览器预览入口（打开空预览窗口） */}
					<button
						type="button"
						className="fv-btn fv-btn--icon"
						data-testid="btn-browser-preview"
						onClick={() =>
							useBrowserStore.getState().openBrowser(undefined, sessionId)
						}
						title={t("session.browserPreview")}
						style={{ color: "var(--text-tertiary)" }}
					>
						<Icon
							name="globe"
							size="1em"
							className="text-[calc(18px*var(--font-scale))]"
						/>
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
										{t("session.stateThinking")} ·{" "}
										<ThinkingTimer thinkingSince={thinkingSince} />s
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
											{stopping ? t("session.stopping") : t("session.stop")}
										</button>
									)}
									{followUp.length > 0 && (
										<button
											onClick={handleClearFollowUp}
											disabled={historyLoading}
											className={`text-[calc(11.5px*var(--font-scale))] px-2 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-danger-soft text-danger cursor-pointer"}`}
											data-testid="btn-clear-queue"
										>
											{t("session.clear")}
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
										{t("session.steeringTitle")}
									</span>
								</div>
								{steering.map((msg, i) => (
									<div
										key={i}
										className="text-[calc(12px*var(--font-scale))] text-secondary mt-1 pl-2"
									>
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
										{t("session.queueCount", { count: followUp.length })}
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
													{t("session.steeringBtn")}
												</button>
												{!isRunning && (
													<button
														onClick={() => handleImmediate(msg)}
														disabled={historyLoading}
														className={`text-[calc(11.5px*var(--font-scale))] px-1.5 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-success-soft text-success cursor-pointer"}`}
														data-testid="btn-immediate"
													>
														{t("session.immediateBtn")}
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
							<div className="text-tertiary text-[calc(11.5px*var(--font-scale))] mt-1 inline-flex items-center gap-1">
								<Icon name="lightbulb" size={12} />
								<span>
									{isRunning
										? t("session.steerHintRunning")
										: t("session.steerHintIdle")}
								</span>
							</div>
						)}
					</div>
				)}

				<MessageList sessionId={sessionId} />
				<AskDock sessionId={sessionId} />
				{/* 扩展 setWidget：展开块在 Composer 前占位；chip 队列悬浮贴 Composer 上沿。
				    Composer 作为 children 传入，ExtWidgetDock 用 relative 层包住它，
				    chip 队列 absolute bottom-full 紧贴 Composer 上沿（不依赖固定高度） */}
				<ExtWidgetDock widgets={widgetEntries}>
					<Composer
						sessionId={sessionId}
						agentName={session.primaryAgent}
						isRunning={status === "thinking"}
						isNewSession={!messages || messages.length === 0}
						disabled={isBlocked || reloading}
					/>
				</ExtWidgetDock>
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
								<span className="truncate">
									<AnsiText text={text} />
								</span>
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
						getWidth={() => useExplorerStore.getState().width}
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
								{t("session.projectFiles")}
							</span>
							<button
								className="fv-btn"
								onClick={() => useExplorerStore.getState().toggle()}
								title={t("session.collapsePanel")}
							>
								›
							</button>
						</div>
						{/* 文件树占满面板，双击文件触发弹窗预览 */}
						<div className="flex-1 overflow-auto">
							<ExplorerPanel
								workspaceDir={workspaceDir}
								projectName={project?.name}
								onOpenFile={(path) =>
									isHtmlPath(path)
										? useBrowserStore.getState().openBrowser(path, sessionId)
										: useSessionStore.getState().openFilePreview(path, sessionId)
								}
							/>
						</div>
					</aside>
				</>
			)}
		</div>
	);
});

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

type WidgetEntry = [string, { lines: string[]; placement?: string }];

/**
 * 扩展 setWidget 文本块容器：
 * - 收起态：所有 widget（above/below 不分左右）排成单一队列，半透明悬浮贴 Composer 上沿，
 *   不占文档流高度 → 不挤压聊天区/输入框；above 用 ↑(紫)、below 用 ↓(灰) 图标区分。
 * - 展开态：点击窄条后在原位置（聊天区与 Composer 之间）插入展开块占位，显示完整内容。
 * - 溢出：窄条数量超出宽度时，左右出现箭头按钮，点击平滑滚动一个窄条宽度。
 */
function ExtWidgetDock({
	widgets,
	children,
}: {
	widgets: WidgetEntry[];
	children?: React.ReactNode;
}) {
	const { t } = useTranslation();
	// expandedKey：当前展开的 widget key（null = 全部收起）
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState({ left: false, right: false });

	// 计算左右箭头是否显示（溢出 + 未到头）
	const updateOverflow = () => {
		const el = trackRef.current;
		if (!el) return;
		const hasOverflow = el.scrollWidth > el.clientWidth + 1;
		setOverflow({
			left: hasOverflow && el.scrollLeft > 1,
			right: hasOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
		});
	};

	useEffect(() => {
		updateOverflow();
		const el = trackRef.current;
		if (!el) return;
		el.addEventListener("scroll", updateOverflow, { passive: true });
		const ro = new ResizeObserver(updateOverflow);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", updateOverflow);
			ro.disconnect();
		};
	}, [widgets.length]);

	// 点击箭头滚动一个窄条宽度
	const scrollByChip = (dir: "left" | "right") => {
		const el = trackRef.current;
		if (!el) return;
		const chip = el.querySelector('[data-collapsed="true"]');
		const step = chip ? (chip as HTMLElement).offsetWidth + 4 : 120;
		el.scrollBy({ left: dir === "left" ? -step : step, behavior: "smooth" });
	};

	const expanded = widgets.find(([key]) => key === expandedKey);

	return (
		<>
			{/* 展开区：展开的 widget 占位（聊天区与 Composer 之间），收起时为空不占位 */}
			{expanded && (
				<div
					className="mx-4 mb-2 flex-shrink-0 rounded-md border border-hairline/50 px-3 py-2"
					data-testid={`ext-widget-${expanded[0]}`}
					style={{
						borderLeft: `3px solid ${
							expanded[1].placement === "belowEditor"
								? "var(--hairline-strong)"
								: "var(--accent)"
						}`,
					}}
				>
					<div className="mb-1 flex items-center justify-between">
						<span className="flex items-center gap-1.5">
							<span className="font-mono text-[calc(12px*var(--font-scale))] font-semibold text-secondary">
								{expanded[0]}
							</span>
							<span
								className="text-[calc(10px*var(--font-scale))]"
								style={{
									color:
										expanded[1].placement === "belowEditor"
											? "var(--text-tertiary)"
											: "var(--accent)",
								}}
							>
								{expanded[1].placement === "belowEditor"
									? "belowEditor"
									: "aboveEditor"}
							</span>
						</span>
						<button
							type="button"
							onClick={() => setExpandedKey(null)}
							className="rounded px-1.5 py-0.5 text-[calc(11px*var(--font-scale))] text-tertiary transition-colors hover:bg-surface-hover"
							data-testid={`ext-widget-collapse-${expanded[0]}`}
						>
							{t("session.widgetCollapse")}
						</button>
					</div>
					<div className="whitespace-pre-wrap font-mono text-[calc(12px*var(--font-scale))] text-secondary">
						<AnsiText text={expanded[1].lines.join("\n")} />
					</div>
				</div>
			)}

			{/* Composer wrapper：relative 让 chip 队列用 absolute bottom-full 紧贴其上沿 */}
			<div className="relative flex flex-col">
				{children}
				{/* 收起队列：半透明悬浮贴 Composer 上沿，单一队列，溢出时箭头滚动 */}
				{widgets.filter(([key]) => key !== expandedKey).length > 0 && (
					<div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 flex items-end">
						{overflow.left && (
							<button
								type="button"
								onClick={() => scrollByChip("left")}
								className="pointer-events-auto flex h-6 w-[26px] flex-shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-secondary opacity-70 transition-opacity hover:opacity-100 hover:text-accent"
								aria-label={t("session.scrollLeft")}
							>
								<Icon
									name="chevron-right"
									size={13}
									style={{ transform: "rotate(180deg)" }}
								/>
							</button>
						)}
						<div
							ref={trackRef}
							className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto px-[5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						>
							{widgets
								.filter(([key]) => key !== expandedKey)
								.map(([key, w]) => {
									const isAbove = w.placement !== "belowEditor";
									return (
										<button
											key={key}
											type="button"
											data-collapsed="true"
											data-testid={`ext-widget-${key}`}
											onClick={() => setExpandedKey(key)}
											className="pointer-events-auto inline-flex max-w-[240px] flex-shrink-0 items-center gap-1.5 truncate rounded-md border border-hairline bg-surface px-2.5 py-[3px] font-mono text-[calc(11.5px*var(--font-scale))] text-secondary opacity-40 transition-opacity hover:opacity-85"
											title={t("session.clickExpand", { key })}
										>
											<span
												style={{
													color: isAbove ? "var(--accent)" : "var(--hairline-strong)",
												}}
											>
												<Icon name={isAbove ? "arrow-up" : "arrow-down"} size={11} />
											</span>
											<span className="truncate">
												{key} · <AnsiText text={w.lines[0]} />
												{w.lines.length > 1
													? ` · ${t("session.widgetLines", { count: w.lines.length })}`
													: ""}
											</span>
										</button>
									);
								})}
						</div>
						{overflow.right && (
							<button
								type="button"
								onClick={() => scrollByChip("right")}
								className="pointer-events-auto flex h-6 w-[26px] flex-shrink-0 items-center justify-center rounded-md border border-hairline bg-surface text-secondary opacity-70 transition-opacity hover:opacity-100 hover:text-accent"
								aria-label={t("session.scrollRight")}
							>
								<Icon name="chevron-right" size={13} />
							</button>
						)}
					</div>
				)}
			</div>
		</>
	);
}
