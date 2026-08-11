import { create } from "zustand";
import i18n from "../i18n";
import { api } from "../api-client";
import { matchKernelCommand } from "@wa-pi/shared";
import type {
	SessionMessage,
	AgentStatus,
	AgentName,
	SDKEventEnvelope,
	SubagentProgressEvent,
} from "@wa-pi/shared";
import { useProjectsStore } from "./projects";
import { useDiagnosticsStore, extensionNameFromPath } from "./diagnostics";
import { useToastStore } from "./toast";
import { useExtDialogStore } from "./ext-dialog";
import { StreamingBatcher } from "./streaming-batcher";
import { fmtTok } from "../util/format";
import { playNeedsAction, playTaskDone } from "../util/sound";

interface SessionState {
	// 已定稿消息：渲染主列表来源
	messagesBySession: Record<string, SessionMessage[]>;
	// 流式中的 assistant 消息：未到 message_end 前的临时占位
	streamingBySession: Record<string, SessionMessage | null>;
	// 会话级 agent 状态：thinking=处理中，idle=空闲，blocked=等待用户
	statusBySession: Record<string, AgentStatus>;
	// 会话级「开始思考」时间戳（ms）：status 转为 thinking 时记录，agent_end 清空。
	// 供 SessionView 的计时器按会话独立计算已思考时长（切会话不重置/不沿用）。
	thinkingSinceBySession: Record<string, number | null>;
	// 未读标记：非当前会话收到「回复完成」（agent_end）时置 true，进入该会话清掉。
	// 供会话列表 SessionRow 显示 new 角标。
	unreadBySession: Record<string, boolean>;
	// 乐观发送标记：true 表示该 session 有一条待 SDK message_start(user) 回声确认的占位用户消息
	optimisticEchoBySession: Record<string, boolean>;
	// 历史加载标记：切换会话后已发 session:messages 但未收到响应（首次进入、无消息时用于显示 loading）
	historyLoadingBySession: Record<string, boolean>;
	// 新建会话发送 prompt 的时刻戳（Date.now()）：MessageList 据此判断是否显示「会话新建中」加载页。
	// 方案：时间戳 + 窗口自然过期——不依赖任何回调清除逻辑（回调到达后消息出现、条件自然失效）。
	pendingPromptAtBySession: Record<string, number>;
	// 新建会话发送 prompt 的失败错误消息（空串=无错误）：HTTP 失败/超时写入，
	// 收到服务器事件清除。MessageList 据此显示「发送失败」而非无限转圈/白屏。
	promptErrorBySession: Record<string, string>;
	// 会话级消息队列：steering 引导队列（来自 pi queue_update）+ followUp 排队队列
	queueBySession: Record<
		string,
		{ steering: readonly string[]; followUp: readonly string[] }
	>;
	// 会话级 token 累计：按 sessionId 存储全量累计（含缓存读取/写入）。
	// 语义=整个会话累计消耗的 token（含压缩前历史），与 pi get_session_stats.tokens 同口径；
	// total = input + output + cacheRead + cacheWrite。
	tokenTotals: Record<
		string,
		{
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
			/** 主/子代理拆分合计（session:stats 提供；subagent>0 时胶囊展示拆分） */
			main?: number;
			subagent?: number;
		}
	>;
	// 会话级最近一次调用的 usage（供 SessionView 渲染「本轮」胶囊）
	lastUsageBySession: Record<
		string,
		{ input: number; output: number; cacheRead: number; cacheWrite: number }
	>;
	// 会话级当前上下文窗口占用（pi get_session_stats.contextUsage，pi>=0.80 提供；
	// 供 SessionView 渲染 token 进度条——用「当前占用」而非「累计」算占比）。
	contextUsageBySession: Record<
		string,
		{ used: number; total: number; ratio: number } | null
	>;
	// 会话级 Provider 连接状态：transient 网络错误（Connection error/timeout）时置 "degraded"，
	// 顶部状态条提示「模型连接异常」；下次成功回复（message_end 正常）或重连后清除。
	// 与 events.ts 的 ConnectionState（SSE 推送通道）区分——那是 kernel→前端通道。
	netStatusBySession: Record<string, "degraded" | null>;
	// 会话级 pi 自动重试状态：auto_retry_start 时置 {attempt, maxAttempts}，
	// 顶部黄色状态条提示「正在自动重试 (n/m)」（优先于红色 degraded 条）；
	// auto_retry_end（成功/耗尽/中止）或 agent_end{willRetry:false} 时清除。
	retryBySession: Record<
		string,
		{ attempt: number; maxAttempts: number } | null
	>;
	// 扩展 ctx.ui.setStatus 状态条目：sessionId → statusKey → 文案，驱动底部状态栏。
	extStatusBySession: Record<string, Record<string, string>>;
	// 扩展 ctx.ui.setWidget 文本块：sessionId → widgetKey → 内容与位置，驱动 Composer 上/下 widget。
	extWidgetBySession: Record<
		string,
		Record<
			string,
			{ lines: string[]; placement: "aboveEditor" | "belowEditor" }
		>
	>;
	// 扩展 ctx.ui.setTitle：会话级标题，聊天窗顶部状态条展示（不写 document.title）。
	extTitleBySession: Record<string, string | null>;
	// 扩展 ctx.ui.setEditorText 注入：sessionId → 待应用的文本（ts 去重，同一次注入只应用一次），
	// 由 Composer 消费：替换输入框内容并写入草稿。
	editorTextInjection: Record<string, { text: string; ts: number }>;
	// 子代理进度：按 toolCallId 再按 agent 分组的 map。
	// 结构：progressByToolCall[toolCallId][agent] = SubagentProgressEvent。
	// 这样 delegate（单 agent）与 fleet（多 agent 共享同一 toolCallId）都能用同一结构：
	//   delegate 取 Object.values(progressByToolCall[tcId])[0]；fleet 取整个内层 map。
	progressByToolCall: Record<string, Record<string, SubagentProgressEvent>>;
	// toolCallId → 所属 sessionId：供 MessageList 按会话过滤「本会话是否有 running 子代理」
	// （progressByToolCall 本身不区分 session，多会话并存时避免串扰滚动/状态）。
	progressSessionByToolCall: Record<string, string>;
	// 原有方法保留：append 用于 error 兜底、setMessages 用于 session:messages 历史
	append: (sessionId: string, msg: SessionMessage) => void;
	setMessages: (sessionId: string, messages: SessionMessage[]) => void;
	/** 标记某会话历史是否正在加载（SessionView 发请求置 true、收响应置 false）。 */
	setHistoryLoading: (sessionId: string, loading: boolean) => void;
	setPendingPromptAt: (sessionId: string, at: number) => void;
	setPromptError: (sessionId: string, msg: string) => void;
	/** 根据后端 isActive 设置会话 thinking/idle 状态；isActive 缺省（undefined）时不干预 */
	setActiveStatus: (
		sessionId: string,
		isActive: boolean | undefined,
		thinkingSince?: number | null,
	) => void;
	/** 原地重试用：保留 messages[0, fromIndex)，丢弃 [fromIndex, end)。
	 *  重发失败回合前调用——裁掉失败的用户消息及其后所有行，
	 *  由随后 SDK 的 message_start(user) 回声重建用户行，避免重发叠加。 */
	truncate: (sessionId: string, fromIndex: number) => void;
	/** 乐观发送：立即追加用户消息 + 占位空 assistant streaming + status=thinking，
	 *  让 UI 在 SDK 回声到达前就显示用户消息与 AI loading。置 optimisticEcho 标记，
	 *  供 message_start(user) 回声识别并替换占位（同步 timestamp，避免切回会话重复）。 */
	optimisticSend: (
		sessionId: string,
		text: string,
		agentName: AgentName,
	) => void;
	/** kernel session:echo_user 回声的幂等入口：Composer 已乐观置入则跳过；
	 *  标志被 message_start/agent_end/failTurn 提前清除后到达（notify 穿插延长冷启动
	 *  窗口、事件密集致时序非确定），则再查「同内容 user 已存在」避免重复追加。 */
	echoUser: (sessionId: string, text: string, agentName: AgentName) => void;
	clear: () => void;
	/** 标记会话有未读新回复（后台收到 agent_end 时）。 */
	markUnread: (sessionId: string) => void;
	/** 清除会话未读标记（进入/查看该会话时）。 */
	markRead: (sessionId: string) => void;
	/** 回合启动失败复位：kernel 广播 error（如 No API key）时 agent 从未启动、不会有
	 *  agent_end，需手动把 status 归 idle、清 streaming 占位与思考计时，否则 UI 永远卡 thinking。 */
	failTurn: (sessionId: string) => void;
	/** 设置会话的 Provider 连接状态（transient 网络错误 → degraded，驱动状态条）。 */
	setNetStatus: (sessionId: string, status: "degraded" | null) => void;
	/** 清除会话的 Provider 连接异常标记（重连成功 / 正常回复后）。 */
	clearNetStatus: (sessionId: string) => void;
	// 新增：处理 sdk:event 信封事件（流式两态管理核心入口）
	handleSDKEvent: (sessionId: string, envelope: SDKEventEnvelope) => void;
	/** 压缩结束（compaction_end）后重拉历史，重算 token 累计 */
	refreshTokenTotals: (sessionId: string) => Promise<void>;
	/** 存储子代理进度事件：按 toolCallId → agent 二级索引写入（支持 fleet 多 agent 共享同一 toolCallId）。 */
	handleSubagentProgress: (
		sessionId: string,
		toolCallId: string,
		progress: SubagentProgressEvent,
	) => void;
	/** 清除某 toolCallId 下全部子代理进度（工具调用结束后释放）。 */
	clearSubagentProgress: (toolCallId: string) => void;
	// 全局文件预览窗（单例）：由 FilePill 胶囊 / Explorer 双击文件触发，渲染在 App 根的
	// FilePreviewModal（常驻挂载点）。状态放 store 而非组件本地——宿主组件（消息行/
	// 委派卡/轮级折叠段）随流式结束、折叠、卸载而销毁时，预览窗不会被连带关闭；
	// 只有用户手动关闭（✕ / ESC / 遮罩点击）才消失。
	filePreview: { path: string; sessionId: string } | null;
	openFilePreview: (path: string, sessionId: string) => void;
	closeFilePreview: () => void;
	/** 重载中（/reload 命令执行期间禁用发送） */
	reloading: boolean;
	setReloading: (v: boolean) => void;
	/**
	 * 轻量刷新会话 token 统计（累计 + 当前上下文占用）：只拉 GET /stats，不动消息列表。
	 * 回合中 message_end 触发，保证「累计/占用/进度条」每轮更新；数值全部来自
	 * session:stats 官方口径（pi get_session_stats；进程不在时 kernel 降级扫 jsonl），
	 * 前端不做任何本地累加/估算。
	 */
	refreshSessionStats: (sessionId: string) => Promise<void>;
	/**
	 * 从历史消息/服务端 stats 初始化 token 显示状态。
	 * lastUsage（「本轮」胶囊）取可见消息中最后一条真实 usage；
	 * tokenTotals / contextUsage 只认 stats（官方口径），无 stats 不写入。
	 */
	seedTokenTotal: (
		sessionId: string,
		messages: SessionMessage[],
		stats?: SessionStatsPayload | null,
	) => void;
}

/** kernel session:stats 响应（pi get_session_stats 或本地降级后的统一结构）。 */
export interface SessionStatsPayload {
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
		/** 主/子代理拆分（仅需 total；旧 kernel 可能缺省） */
		main?: { total?: number };
		subagent?: { total?: number };
	};
	contextUsage?: {
		used: number;
		total: number;
		ratio: number;
	} | null;
}

// 流式标识：同 agent 同时刻同 role 视为同一条流式增量
function msgKey(m: SessionMessage): string {
	const inner = m.message as any;
	return `${inner.role ?? "custom"}-${inner.timestamp}`;
}

/**
 * 从 session:stats 响应构造 tokenTotals / contextUsageBySession 的 state patch。
 * 官方口径唯一入口：seedTokenTotal 与 refreshSessionStats 共用，前端不做本地累加。
 * contextUsage 缺省（本地降级路径无此字段）时置 null，清掉可能过期的旧值。
 */
function statsPatch(
	s: Pick<SessionState, "tokenTotals" | "contextUsageBySession">,
	sessionId: string,
	stats: SessionStatsPayload,
) {
	const patch: any = {};
	const t = stats.tokens;
	if (t) {
		const input = t.input ?? 0;
		const output = t.output ?? 0;
		const cacheRead = t.cacheRead ?? 0;
		const cacheWrite = t.cacheWrite ?? 0;
		patch.tokenTotals = {
			...s.tokenTotals,
			[sessionId]: {
				input,
				output,
				cacheRead,
				cacheWrite,
				total: t.total ?? input + output + cacheRead + cacheWrite,
				main: t.main?.total,
				subagent: t.subagent?.total,
			},
		};
	}
	patch.contextUsageBySession = {
		...s.contextUsageBySession,
		[sessionId]: stats.contextUsage ?? null,
	};
	return patch;
}

export const useSessionStore = create<SessionState>((set) => {
	// streaming 渲染 rAF 合帧（阶段一·卡顿修复项 2）：一帧内多次 message_update
	// 只提交一次（取最新），避免每 token 一次全量重渲染；终态事件 drop 防旧 partial 复活。
	// 箭头包裹：裸引用 requestAnimationFrame 会被 StreamingBatcher 以成员访问方式
	// 调用（this=batcher 实例），触发原生 rAF 的 "Illegal invocation"，导致真实浏览器
	// 流式预览失效。箭头内裸调用 rAF，this 绑定回 globalThis/window。
	const raf: (fn: () => void) => unknown =
		typeof requestAnimationFrame !== "undefined"
			? (fn) => requestAnimationFrame(fn)
			: (fn) => setTimeout(fn, 16);
	const caf: (h: unknown) => void =
		typeof cancelAnimationFrame !== "undefined"
			? (h) => cancelAnimationFrame(h as number)
			: (h) => clearTimeout(h as any);
	const streamingBatcher = new StreamingBatcher<SessionMessage>(
		(sessionId, value) =>
			set((s) => ({
				streamingBySession: { ...s.streamingBySession, [sessionId]: value },
			})),
		raf,
		caf,
	);
	return {
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		thinkingSinceBySession: {},
		optimisticEchoBySession: {},
		historyLoadingBySession: {},
		pendingPromptAtBySession: {},
		promptErrorBySession: {},
		unreadBySession: {},
		queueBySession: {},
		reloading: false,
		tokenTotals: {},
		lastUsageBySession: {},
		contextUsageBySession: {},
		netStatusBySession: {},
		retryBySession: {},
		extStatusBySession: {},
		extWidgetBySession: {},
		extTitleBySession: {},
		editorTextInjection: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		filePreview: null,

		seedTokenTotal: (sessionId, messages, stats) => {
			// lastUsage（供「本轮」胶囊）取可见消息中最后一条真实 usage
			let lastUsage: any = null;
			for (const sm of messages) {
				const m = sm.message as any;
				if (m.role === "assistant" && m.usage) lastUsage = m.usage;
			}
			set((s) => {
				const patch: any = stats ? statsPatch(s, sessionId, stats) : {};
				if (lastUsage) {
					patch.lastUsageBySession = {
						...s.lastUsageBySession,
						[sessionId]: lastUsage,
					};
				}
				return patch;
			});
		},

		refreshSessionStats: async (sessionId) => {
			try {
				const res = await api
					.get(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
					.catch(() => null);
				const stats = (res as any)?.stats as
					| SessionStatsPayload
					| null
					| undefined;
				if (!stats) return;
				set((s) => statsPatch(s, sessionId, stats));
			} catch {
				// 刷新失败不影响主流程，静默忽略
			}
		},

		append: (sessionId, msg) =>
			set((s) => {
				const list = s.messagesBySession[sessionId] ?? [];
				const key = msgKey(msg);
				const idx = list.findIndex((m) => msgKey(m) === key);
				const newList =
					idx >= 0 ? list.map((m, i) => (i === idx ? msg : m)) : [...list, msg];
				return {
					messagesBySession: { ...s.messagesBySession, [sessionId]: newList },
				};
			}),

		setMessages: (sessionId, messages) =>
			set((s) => {
				const existing = s.messagesBySession[sessionId] ?? [];
				const existingKeys = new Set(existing.map(msgKey));
				const newFromHistory = messages.filter(
					(m) => !existingKeys.has(msgKey(m)),
				);
				const all = [...existing, ...newFromHistory].sort(
					(a: any, b: any) => a.message.timestamp - b.message.timestamp,
				);
				const compacted: SessionMessage[] = [];
				for (const msg of all) {
					const last = compacted[compacted.length - 1];
					const m = msg.message as any;
					if (
						last &&
						last.agentName === msg.agentName &&
						(last.message as any).role === "assistant" &&
						m.role === "assistant"
					) {
						(last.message as any).content = [
							...(last.message as any).content,
							...(m.content ?? []),
						];
						if (m.stopReason) {
							(last.message as any).stopReason = m.stopReason;
						}
						if (m.turnElapsedMs != null) {
							(last.message as any).turnElapsedMs = m.turnElapsedMs;
						}
					} else {
						compacted.push(msg);
					}
				}
				return {
					messagesBySession: { ...s.messagesBySession, [sessionId]: compacted },
				};
			}),

		refreshTokenTotals: async (sessionId) => {
			try {
				const [statsRes, messagesRes] = await Promise.all([
					api
						.get(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
						.catch(() => null),
					api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
				]);
				const res = messagesRes as { messages: any[] };
				if (!res?.messages) return;
				// 整表覆盖：agent_end 时刻无 streaming，服务端历史为准；
				// GET 在途时若乐观消息已写入，SDK 回显会补回，短暂覆盖可接受。
				// 保留本地 compaction_status 中的「进行中/取消/失败」消息：它们不在服务端历史里，
				// 整表覆盖会把它冲掉。成功的压缩（「已压缩…」）不保留——服务端历史会渲染
				// compactionSummary 节点（同一文案），保留本地这条会出现重复提示。
				const prev =
					useSessionStore.getState().messagesBySession[sessionId] ?? [];
				const localStatus = prev.filter((m: any) => {
					const mm = m.message as any;
					if (mm?.customType !== "compaction_status") return false;
					// 保留进行中/取消/失败的压缩状态消息；移除成功的（服务端历史会渲染 compactionSummary）。
					return !mm?.compactionDone;
				});
				useSessionStore.setState((s) => ({
					messagesBySession: {
						...s.messagesBySession,
						[sessionId]: [...res.messages, ...localStatus],
					},
				}));
				const stats = (statsRes as any)?.stats as
					| SessionStatsPayload
					| null
					| undefined;
				useSessionStore
					.getState()
					.seedTokenTotal(sessionId, res.messages, stats);
			} catch {
				// 刷新失败不影响主流程，静默忽略
			}
		},

		/** 根据 isActive 设置会话状态（历史加载/重连时调用） */
		setActiveStatus: (
			sessionId: string,
			isActive: boolean | undefined,
			thinkingSince?: number | null,
		) =>
			set((s) => {
				if (isActive) {
					return {
						statusBySession: {
							...s.statusBySession,
							[sessionId]: "thinking" as const,
						},
						thinkingSinceBySession: {
							...s.thinkingSinceBySession,
							[sessionId]: thinkingSince ?? Date.now(),
						},
					};
				}
				// 仅显式 false 才对齐复位；undefined 说明响应缺省/不可信，保持现状不干预
				if (isActive !== false) return {};
				// isActive=false：以 kernel 为权威对齐——SSE 断线窗口漏掉终态事件
				// （agent_end / auto_retry_end / error 不重放）或 kernel 重启后，本地残留的
				// thinking / loading 占位 / 重试条必须复位，否则永远停在"对话中"。
				const needReset =
					s.statusBySession[sessionId] === "thinking" ||
					s.thinkingSinceBySession[sessionId] != null ||
					s.streamingBySession[sessionId] != null ||
					s.retryBySession[sessionId] != null;
				if (!needReset) return {};
				// 丢弃 batcher 挂起帧，防止 flush 把旧 partial 提交回 streamingBySession 复活
				streamingBatcher.drop(sessionId);
				const retryBySession = { ...s.retryBySession };
				delete retryBySession[sessionId];
				return {
					statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
					thinkingSinceBySession: {
						...s.thinkingSinceBySession,
						[sessionId]: null,
					},
					streamingBySession: {
						...s.streamingBySession,
						[sessionId]: null,
					},
					retryBySession,
				};
			}),

		setPendingPromptAt: (sessionId, at) =>
			set((s) => {
				if (s.pendingPromptAtBySession?.[sessionId] === at) return {};
				return {
					pendingPromptAtBySession: {
						...s.pendingPromptAtBySession,
						[sessionId]: at,
					},
				};
			}),
		setPromptError: (sessionId, msg) =>
			set((s) => {
				const prev = s.promptErrorBySession?.[sessionId] ?? "";
				if (prev === msg) return {};
				return {
					promptErrorBySession: {
						...s.promptErrorBySession,
						[sessionId]: msg,
					},
				};
			}),
		setHistoryLoading: (sessionId, loading) =>
			set((s) => {
				// 状态相同则不触发重渲染
				if (Boolean(s.historyLoadingBySession[sessionId]) === loading)
					return {};
				return {
					historyLoadingBySession: {
						...s.historyLoadingBySession,
						[sessionId]: loading,
					},
				};
			}),

		setReloading: (v) => set({ reloading: v }),
		clear: () =>
			set({
				messagesBySession: {},
				streamingBySession: {},
				statusBySession: {},
				thinkingSinceBySession: {},
				optimisticEchoBySession: {},
				historyLoadingBySession: {},
				pendingPromptAtBySession: {},
				promptErrorBySession: {},
				unreadBySession: {},
				netStatusBySession: {},
				retryBySession: {},
				extStatusBySession: {},
				extWidgetBySession: {},
				extTitleBySession: {},
				filePreview: null,
			}),

		markUnread: (sessionId) =>
			set((s) => ({
				unreadBySession: { ...s.unreadBySession, [sessionId]: true },
			})),
		markRead: (sessionId) =>
			set((s) => {
				if (!s.unreadBySession[sessionId]) return {}; // 已读则不触发重渲染
				const next = { ...s.unreadBySession };
				delete next[sessionId];
				return { unreadBySession: next };
			}),

		failTurn: (sessionId) => {
			// 复位前丢弃挂起的 streaming 帧，防止旧 partial 复活
			streamingBatcher.drop(sessionId);
			set((s) => ({
				statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
				streamingBySession: { ...s.streamingBySession, [sessionId]: null },
				thinkingSinceBySession: {
					...s.thinkingSinceBySession,
					[sessionId]: null,
				},
				optimisticEchoBySession: {
					...s.optimisticEchoBySession,
					[sessionId]: false,
				},
			}));
		},

		setNetStatus: (sessionId, status) =>
			set((s) => {
				// 状态相同不触发重渲染
				if (s.netStatusBySession[sessionId] === status) return {};
				const next = { ...s.netStatusBySession };
				if (status === null) delete next[sessionId];
				else next[sessionId] = status;
				return { netStatusBySession: next };
			}),

		clearNetStatus: (sessionId) =>
			set((s) => {
				if (!s.netStatusBySession[sessionId]) return {};
				const next = { ...s.netStatusBySession };
				delete next[sessionId];
				return { netStatusBySession: next };
			}),

		optimisticSend: (sessionId, text, agentName) =>
			set((s) => {
				const ts = Date.now();
				const list = s.messagesBySession[sessionId] ?? [];
				// kernel 拦截的内置命令（/compact）转 RPC 执行、不产生 user 回声，
				// 不作为用户消息插入聊天列表（清单与匹配规则统一在 shared matchKernelCommand）
				const isKernelHandled = matchKernelCommand(text) !== null;
				return {
					// 立即追加用户消息（agentName 留空：用户消息不属于具体 agent）
					messagesBySession: isKernelHandled
						? s.messagesBySession
						: {
								...s.messagesBySession,
								[sessionId]: [
									...list,
									{
										// optimistic 标记：SDK user 回声按标记查找替换（不依赖
										// "列表末尾是 user"），替换时被 SDK 权威版本覆盖、标记随之消失
										message: {
											role: "user",
											content: text,
											timestamp: ts,
											optimistic: true,
										},
										agentName: undefined,
									},
								],
							},
					// 占位空 assistant streaming：让 MessageList 渲染 loading 气泡；首字到达后由 message_update 填充
					streamingBySession: {
						...s.streamingBySession,
						[sessionId]: {
							message: {
								role: "assistant",
								content: [],
								model: "pending",
								stopReason: "pending",
								timestamp: ts,
							},
							agentName,
						},
					},
					// 顶部 spinner 立即转（不等 SDK agent_start）
					statusBySession: { ...s.statusBySession, [sessionId]: "thinking" },
					// 计时从这里开始（用户发送即起算）
					thinkingSinceBySession: {
						...s.thinkingSinceBySession,
						[sessionId]: ts,
					},
					optimisticEchoBySession: {
						...s.optimisticEchoBySession,
						[sessionId]: true,
					},
				};
			}),

		echoUser: (sessionId, text, agentName) => {
			const s = useSessionStore.getState();
			// 收到 echo_user 即服务器已响应：清「会话新建中」pending（加载页退出主路径）。
			// 时间戳窗口保留为兜底（事件丢失/延迟超 20s 时仍能隐藏）。
			if (s.pendingPromptAtBySession?.[sessionId]) {
				useSessionStore.getState().setPendingPromptAt(sessionId, 0);
			}
			if (s.promptErrorBySession?.[sessionId]) {
				useSessionStore.getState().setPromptError(sessionId, "");
			}
			// 1. Composer 已乐观置入 → 标记仍在，跳过
			if (s.optimisticEchoBySession[sessionId]) return;
			// 2. 标记已被 message_start/agent_end/failTurn 提前清除，但同内容 user 消息
			//    已存在（SDK 回声替换占位后、或本轮已回声过）→ 不重复追加。
			//    覆盖 notify 穿插延长冷启动窗口、echo_user 延迟到达的时序。
			const list = s.messagesBySession[sessionId] ?? [];
			const exists = list.some((sm) => {
				const m = sm.message as any;
				return m.role === "user" && m.content === text;
			});
			if (exists) return;
			// 3. 既无标记也无同内容消息（NewSessionPane 等未乐观置入）→ 正常追加
			useSessionStore.getState().optimisticSend(sessionId, text, agentName);
		},

		truncate: (sessionId, fromIndex) =>
			set((s) => {
				const list = s.messagesBySession[sessionId] ?? [];
				if (fromIndex >= list.length) return {};
				return {
					messagesBySession: {
						...s.messagesBySession,
						[sessionId]: list.slice(0, fromIndex),
					},
				};
			}),

		// 存储子代理进度：按 toolCallId → agent 二级 map 写入。
		// fleet 场景同一 toolCallId 下多个 agent 共存，故合并既有内层 map 而非覆盖。
		// 同时记录 toolCallId 所属 session，供 MessageList 按会话过滤 running 子代理。
		handleSubagentProgress: (sessionId, toolCallId, progress) => {
			set((s) => {
				const prev = s.progressByToolCall[toolCallId] ?? {};
				return {
					progressByToolCall: {
						...s.progressByToolCall,
						[toolCallId]: {
							...prev,
							[String(progress.taskIndex ?? progress.agent)]: progress,
						},
					},
					progressSessionByToolCall: {
						...s.progressSessionByToolCall,
						[toolCallId]: sessionId,
					},
				};
			});
		},

		// 清除某 toolCallId 下全部进度（工具调用结束、卡片卸载时释放）
		clearSubagentProgress: (toolCallId) => {
			set((s) => {
				const next = { ...s.progressByToolCall };
				delete next[toolCallId];
				const sessions = { ...s.progressSessionByToolCall };
				delete sessions[toolCallId];
				return {
					progressByToolCall: next,
					progressSessionByToolCall: sessions,
				};
			});
		},

		// 打开文件预览：path 为绝对路径（FilePill 传 resolveAbsolutePath 结果）或相对项目
		// cwd 的路径（Explorer 双击传 node.entry.path）；sessionId 供 FileViewer 内 readFile
		// 解析 cwd。幂等：同一文件重复打开不产生状态变更。
		openFilePreview: (path, sessionId) => {
			set((s) => {
				if (
					s.filePreview?.path === path &&
					s.filePreview.sessionId === sessionId
				)
					return {};
				return { filePreview: { path, sessionId } };
			});
		},
		closeFilePreview: () => {
			set((s) => (s.filePreview ? { filePreview: null } : {}));
		},

		// 处理 sdk:event 信封事件：按 SDKEvent.type 分发到对应状态
		handleSDKEvent: (sessionId, envelope) => {
			const { event, agentName } = envelope;
			// 收到该 session 任意服务器事件（含扩展命令 50ms 后合成的空 agent_end）→
			// 服务器已响应：清「会话新建中」pending，加载页退出。
			// 扩展命令被 pi 拦截执行：无 echo_user / agent_start / message_start，
			// 唯一信号就是合成 agent_end——若不清 pending，加载页会硬撑 20s 才消失（白屏）。
			if (useSessionStore.getState().pendingPromptAtBySession?.[sessionId]) {
				useSessionStore.getState().setPendingPromptAt(sessionId, 0);
			}
			if (useSessionStore.getState().promptErrorBySession?.[sessionId]) {
				useSessionStore.getState().setPromptError(sessionId, "");
			}
			switch (event.type) {
				// 用户消息：直接定稿进 messages
				case "message_start": {
					const msg = event.message as any;
					if (msg.role === "user") {
						set((s) => {
							const list = s.messagesBySession[sessionId] ?? [];
							// 乐观发送的占位消息带 optimistic:true 标记：倒序找到并原位替换为
							// SDK 权威版本，同步 timestamp 避免切回会话时 setMessages 合并出重复行。
							// 不依赖"列表末尾是 user"与 optimisticEcho 标记——占位与回声之间插入
							// 其他消息（extension_notify 等）、兜底 agent_end / failTurn 提前清标记
							// 都不会再导致回声被追加成重复行。
							let pendingIdx = -1;
							for (let i = list.length - 1; i >= 0; i--) {
								const m = list[i].message as any;
								if (m.role === "user" && m.optimistic) {
									pendingIdx = i;
									break;
								}
							}
							const pending = pendingIdx >= 0;
							const newList = pending
								? [
										...list.slice(0, pendingIdx),
										{ message: msg, agentName },
										...list.slice(pendingIdx + 1),
									]
								: [...list, { message: msg, agentName }];
							return pending
								? {
										messagesBySession: {
											...s.messagesBySession,
											[sessionId]: newList,
										},
										optimisticEchoBySession: {
											...s.optimisticEchoBySession,
											[sessionId]: false,
										},
									}
								: {
										messagesBySession: {
											...s.messagesBySession,
											[sessionId]: newList,
										},
									};
						});
					} else if (msg.role === "assistant") {
						// assistant 首帧：设为 streaming，等后续 update/end
						set((s) => ({
							streamingBySession: {
								...s.streamingBySession,
								[sessionId]: { message: msg, agentName },
							},
						}));
					}
					break;
				}
				// 流式增量：0.84 起 RPC 只发 assistantMessageEvent delta（无 partial 快照），
				// 需自行把 delta 累积到 streaming message 的对应 content block。
				// toolcall_delta 不做流式累积（参数 JSON 片段），message_end 用权威消息定稿覆盖。
				// rAF 合帧（流式卡顿修复）：不再每事件 set()，delta 累积进 batcher 挂起帧，
				// 一帧内多个 delta 合并为一次 zustand 提交（取最新）。
				// 累积基准必须含 batcher 挂起值（peek），否则同帧内后到的 delta 覆盖先到的。
				case "message_update": {
					const ae = (event as any).assistantMessageEvent;
					if (!ae) break;
					const delta = ae.delta;
					if (typeof delta !== "string") break;
					const cur =
						streamingBatcher.peek(sessionId) ??
						useSessionStore.getState().streamingBySession[sessionId];
					if (!cur) break;
					const msg = cur.message as any;
					const content = Array.isArray(msg.content)
						? msg.content.map((b: any) => ({ ...b }))
						: [];
					const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : 0;
					const block = content[idx];
					if (ae.type === "text_delta") {
						if (block?.type === "text") {
							content[idx] = { ...block, text: (block.text ?? "") + delta };
						} else if (!block) {
							content[idx] = { type: "text", text: delta };
						}
					} else if (ae.type === "thinking_delta") {
						if (block?.type === "thinking") {
							content[idx] = {
								...block,
								thinking: (block.thinking ?? "") + delta,
							};
						} else if (!block) {
							content[idx] = { type: "thinking", thinking: delta };
						}
					}
					streamingBatcher.update(sessionId, {
						message: { ...msg, content },
						agentName: cur.agentName,
					});
					break;
				}
				// 流式结束：assistant — 合并到同 turn 的最后一条 assistant 消息
				// toolResult — 单独成消息，渲染层 preprocess 会按 toolCallId 挂到前一个 assistant
				case "message_end": {
					// 终态到达：丢弃挂起的 streaming 帧，防止旧 partial 在定稿后复活
					streamingBatcher.drop(sessionId);
					const msg = event.message as any;
					if (msg.role === "toolResult") {
						set((s) => {
							const list = [
								...(s.messagesBySession[sessionId] ?? []),
								{ message: msg, agentName },
							];
							return {
								messagesBySession: {
									...s.messagesBySession,
									[sessionId]: list,
								},
							};
						});
						break;
					}
					if (msg.role !== "assistant") break;
					// 需要操作提示音：assistant 消息含新的 ask_user_question 工具调用时播放。
					// 历史消息经 api 加载直接 set、不经过 message_end，不会误触发。
					// IM 渠道会话（sessionId 以 im- 开头）不播放提示音。
					if (
						!sessionId.startsWith("im-") &&
						Array.isArray(msg.content) &&
						msg.content.some(
							(b: any) =>
								b?.type === "toolCall" && b.name === "ask_user_question",
						)
					) {
						playNeedsAction();
					}
					// 记录最近一次调用的 usage（供 SessionView 渲染「本轮」胶囊）
					if (msg.usage) {
						set((s) => ({
							lastUsageBySession: {
								...s.lastUsageBySession,
								[sessionId]: msg.usage,
							},
						}));
						// 累计/占用不走本地累加：拉官方 session:stats 刷新（含子代理消耗、
						// 当前上下文占用），跳过全 0 usage（error 消息无实际消耗）
						if (
							msg.usage.input > 0 ||
							msg.usage.output > 0 ||
							msg.usage.cacheRead > 0 ||
							msg.usage.cacheWrite > 0
						) {
							void useSessionStore.getState().refreshSessionStats(sessionId);
						}
					}
					// 失败但无实质内容（空 content / 仅空 text block）：跳过合并，避免渲染「裸头像」行。
					// 该错误的可见表示由 kernel 广播的 {type:"error"} → App.tsx 注入的红色 ⚠️ 横幅承担。
					const hasMeaningfulContent =
						Array.isArray(msg.content) &&
						msg.content.some(
							(b: any) =>
								(b?.type === "text" &&
									typeof b.text === "string" &&
									b.text.trim().length > 0) ||
								b?.type === "thinking" ||
								b?.type === "toolCall",
						);
					if (msg.stopReason === "error" && !hasMeaningfulContent) {
						set((s) => ({
							streamingBySession: {
								...s.streamingBySession,
								[sessionId]: null,
							},
						}));
						break;
					}
					set((s) => {
						const list = [...(s.messagesBySession[sessionId] ?? [])];
						const last = list[list.length - 1];
						// SDK 对同 turn 的每个 block（thinking/text/toolCall）发独立 message_start/end；
						// 检查最后一条是否也是同一 agent 的 assistant，是则合并 content 数组
						if (
							last &&
							last.agentName === agentName &&
							(last.message as any).role === "assistant"
						) {
							const merged = {
								...(last.message as any),
								content: [
									...(last.message as any).content,
									...(msg.content ?? []),
								],
							};
							list[list.length - 1] = { ...last, message: merged };
						} else {
							list.push({ message: msg, agentName });
						}
						// 正常回复到达 → 网络已恢复，清除 transient 错误的 degraded 标记
						let netStatusBySession = s.netStatusBySession;
						if (msg.stopReason !== "error" && s.netStatusBySession[sessionId]) {
							netStatusBySession = { ...s.netStatusBySession };
							delete netStatusBySession[sessionId];
						}
						return {
							streamingBySession: {
								...s.streamingBySession,
								[sessionId]: null,
							},
							messagesBySession: { ...s.messagesBySession, [sessionId]: list },
							netStatusBySession,
						};
					});
					break;
				}
				// agent 开始处理：标记 thinking；记录起算时间（若 optimisticSend 已记则保留，避免覆盖更早的发送时刻）
				case "agent_start":
					set((s) => {
						// agent turn 开始 = 请求已成功送达 provider = 网络已恢复，
						// 立即清除 transient degraded 标记（不等 message_end，避免整轮回复期间状态条残留）。
						let netStatusBySession = s.netStatusBySession;
						if (s.netStatusBySession[sessionId]) {
							netStatusBySession = { ...s.netStatusBySession };
							delete netStatusBySession[sessionId];
						}
						return {
							statusBySession: {
								...s.statusBySession,
								[sessionId]: "thinking",
							},
							thinkingSinceBySession: {
								...s.thinkingSinceBySession,
								[sessionId]: s.thinkingSinceBySession[sessionId] ?? Date.now(),
							},
							netStatusBySession,
						};
					});
					break;
				// agent 结束：回 idle，清起算时间；若该会话非当前会话（用户在别处），标记未读新回复
				case "agent_end": {
					// pi 自动重试（transient 错误退避中）：agent_end{willRetry:true} 只是单次
					// 尝试失败的中间态，随后 auto_retry_start → 退避 → 新 agent_start 继续本轮。
					// 保持 thinking（不结算 idle/未读/耗时），等真正终态：成功轮的
					// agent_end{willRetry:false}，或重试耗尽/中止的 auto_retry_end{success:false}。
					if (event.willRetry === true) break;
					// 任务完成提示音：仅终态播放（自动重试中间态上面已 break）；
					// IM 渠道会话（sessionId 以 im- 开头）不播放提示音。
					if (!sessionId.startsWith("im-")) playTaskDone();
					const away =
						sessionId !== useProjectsStore.getState().currentSessionId;
					// 终态到达：丢弃挂起的 streaming 帧，防止旧 partial 复活
					streamingBatcher.drop(sessionId);
					const elapsedMs = (envelope.event as any).elapsedMs as
						| number
						| undefined;
					set((s) => {
						// 扩展命令（如 /mcp-auth）无 agent turn：optimisticSend 的 loading 占位
						// （stopReason==="pending"）需要在此清掉，否则气泡一直转圈。
						// 正常流程 streaming 已被 message_end 定稿清空，此处为 no-op；
						// 只清 pending 占位，绝不动真实 partial。
						const streaming = s.streamingBySession[sessionId];
						const isPlaceholder =
							(streaming?.message as any)?.stopReason === "pending";
						// 防御性清重试进度：终态 agent_end 到达即本轮结束（正常已由
						// auto_retry_end 清除，此处兜底异常时序防黄条卡住）。
						const retryBySession = { ...s.retryBySession };
						delete retryBySession[sessionId];
						const result: any = {
							statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
							thinkingSinceBySession: {
								...s.thinkingSinceBySession,
								[sessionId]: null,
							},
							retryBySession,
							unreadBySession: away
								? { ...s.unreadBySession, [sessionId]: true }
								: s.unreadBySession,
							streamingBySession: isPlaceholder
								? { ...s.streamingBySession, [sessionId]: null }
								: s.streamingBySession,
							optimisticEchoBySession: {
								...s.optimisticEchoBySession,
								[sessionId]: false,
							},
						};
						// 整轮耗时写回该轮最后一条 assistant 消息（渲染层唯一数据源：消息.turnElapsedMs）
						if (elapsedMs != null) {
							const list = s.messagesBySession[sessionId] ?? [];
							const fromEnd = [...list]
								.reverse()
								.findIndex((m) => (m.message as any).role === "assistant");
							if (fromEnd >= 0) {
								const i = list.length - 1 - fromEnd;
								const msg = list[i];
								const updated = {
									...msg,
									message: {
										...(msg.message as any),
										turnElapsedMs: elapsedMs,
									},
								};
								result.messagesBySession = {
									...s.messagesBySession,
									[sessionId]: [
										...list.slice(0, i),
										updated,
										...list.slice(i + 1),
									],
								};
							}
						}
						return result;
					});
					break;
				}
				// pi 自动重试开始（退避等待中）：记录重试进度驱动顶部黄色状态条；
				// 防御性确保 thinking——正常已被 agent_end{willRetry:true} 分支保持，
				// 此处兜底任何时序缝隙。
				case "auto_retry_start":
					set((s) => ({
						statusBySession: {
							...s.statusBySession,
							[sessionId]: "thinking",
						},
						thinkingSinceBySession: {
							...s.thinkingSinceBySession,
							[sessionId]: s.thinkingSinceBySession[sessionId] ?? Date.now(),
						},
						retryBySession: {
							...s.retryBySession,
							[sessionId]: {
								attempt: event.attempt,
								maxAttempts: event.maxAttempts,
							},
						},
					}));
					break;
				// pi 自动重试终结：清除重试进度（黄条消失；若 netDegraded 仍在则回到红条）。
				// success=true 时本轮继续（新 agent_start 已到达），终态仍由
				// agent_end{willRetry:false} 复位；success=false（重试耗尽 / 退避期被
				// abort）时 abort 路径不会再有 agent_end，必须在此复位 idle 防思考态卡死。
				case "auto_retry_end":
					set((s) => {
						const retryBySession = { ...s.retryBySession };
						delete retryBySession[sessionId];
						if (event.success !== false) return { retryBySession };
						return {
							retryBySession,
							statusBySession: {
								...s.statusBySession,
								[sessionId]: "idle",
							},
							thinkingSinceBySession: {
								...s.thinkingSinceBySession,
								[sessionId]: null,
							},
						};
					});
					break;
				// 压缩/分支摘要的 LLM 重试（transient 失败后退避等待）：与 auto_retry
				// 同构，复用 retryBySession 驱动同一黄色重试状态条。压缩本身的
				// 「正在压缩上下文…」消息由 compaction_start/end 负责，互不冲突。
				case "summarization_retry_scheduled":
					set((s) => ({
						retryBySession: {
							...s.retryBySession,
							[sessionId]: {
								attempt: event.attempt,
								maxAttempts: event.maxAttempts,
							},
						},
					}));
					break;
				// 摘要重试的新尝试开始（退避结束、请求在途）：重试状态保持到
				// summarization_retry_finished（与 auto_retry 行为一致），此处不动。
				case "summarization_retry_attempt_start":
					break;
				// 摘要重试循环终结（成功或最终失败）：清除重试状态条。
				// 最终失败由随后 compaction_end{errorMessage} 的文案呈现。
				case "summarization_retry_finished":
					set((s) => {
						if (!s.retryBySession[sessionId]) return {};
						const retryBySession = { ...s.retryBySession };
						delete retryBySession[sessionId];
						return { retryBySession };
					});
					break;
				// 队列更新：steering / followUp 消息列表
				case "queue_update":
					set((s) => ({
						queueBySession: {
							...s.queueBySession,
							[sessionId]: {
								steering: event.steering,
								followUp: event.followUp,
							},
						},
					}));
					break;
				// 上下文压缩开始：插入居中状态消息（复用 custom 渲染）。手动 /compact 与自动压缩
				//（threshold/overflow）都会触发；compaction_end 到达时替换为结果。
				case "compaction_start": {
					const timestamp = Date.now();
					set((s) => {
						const list = s.messagesBySession[sessionId] ?? [];
						// 去重：已有一条 compaction_status 则不重复插入（连续压缩可能连发）
						const last = list[list.length - 1]?.message as any;
						if (last?.customType === "compaction_status") return s;
						return {
							messagesBySession: {
								...s.messagesBySession,
								[sessionId]: [
									...list,
									{
										message: {
											type: "custom",
											customType: "compaction_status",
											content: i18n.t("message.compactionProgress"),
											timestamp,
										},
										agentName,
										sessionId,
									} as any,
								],
							},
						};
					});
					break;
				}
				// 上下文压缩结束：替换状态消息为结果（释放 token / 取消 / 失败），并刷新 token 累计。
				// 这是压缩完成的权威信号（不依赖 agent_end 的文本检测），自动压缩也在此刷新。
				case "compaction_end": {
					const e = event as any;
					const result = e.result;
					let content: string;
					// 是否成功压缩（用于重拉历史时移除：成功消息由服务端 compactionSummary 重新渲染，
					// 取消/失败的消息服务端没有，需保留在本地）。
					let compactionDone = false;
					if (e.aborted) content = i18n.t("message.compactionAborted");
					else if (e.errorMessage)
						content = i18n.t("message.compactionFailed", {
							error: e.errorMessage,
						});
					else if (result && typeof result.tokensBefore === "number") {
						// 与历史重载的 compactionSummary 渲染保持同一文案（jsonl 不持久化
						// estimatedTokensAfter，两边只能一致地展示 tokensBefore）
						content = i18n.t("message.compactionDone", {
							count: fmtTok(result.tokensBefore),
						});
						compactionDone = true;
					} else {
						content = i18n.t("message.compactionDoneNoToken");
						compactionDone = true;
					}
					const timestamp = Date.now();
					set((s) => {
						const list = s.messagesBySession[sessionId] ?? [];
						const msg = {
							message: {
								type: "custom",
								customType: "compaction_status",
								content,
								// 结构化标志：仅成功压缩设置（服务端历史会渲染 compactionSummary，
								// 重拉时移除避免重复）；取消/失败不设（服务端没有，需保留本地）。
								compactionDone,
								timestamp,
							},
							agentName,
							sessionId,
						} as any;
						// 替换最后一条 compaction_status（找不到则直接追加）
						const idx = [...list]
							.reverse()
							.findIndex(
								(m: any) =>
									(m.message as any)?.customType === "compaction_status",
							);
						if (idx === -1) {
							return {
								messagesBySession: {
									...s.messagesBySession,
									[sessionId]: [...list, msg],
								},
							};
						}
						const i = list.length - 1 - idx;
						const next = [...list];
						next[i] = msg;
						return {
							messagesBySession: {
								...s.messagesBySession,
								[sessionId]: next,
							},
						};
					});
					// 压缩完成（手动/自动）：重拉历史刷新 token 累计
					void useSessionStore.getState().refreshTokenTotals(sessionId);
					break;
				}
				// pi 扩展 dialog 请求（select/confirm/input/editor）：入队，ExtensionDialog 弹窗应答
				case "extension_dialog": {
					useExtDialogStore.getState().enqueue({
						requestId: (event as any).requestId,
						sessionId,
						method: (event as any).method,
						title: (event as any).title,
						message: (event as any).message,
						options: (event as any).options,
						placeholder: (event as any).placeholder,
						prefill: (event as any).prefill,
					});
					break;
				}
				// pi 扩展 setEditorText：替换 Composer 输入框内容（官方 fire-and-forget 语义）
				case "extension_editor_text": {
					const text = (event as any).text;
					if (typeof text === "string") {
						set((s) => ({
							editorTextInjection: {
								...s.editorTextInjection,
								[sessionId]: { text, ts: Date.now() },
							},
						}));
					}
					break;
				}
				// pi 扩展 ctx.ui.notify 反馈（如 /lens-toggle 执行结果）：kernel 包装在 sdk:event 内转发，
				// 这里插入聊天窗口中间的系统提示（复用 custom 消息渲染：居中 —— content ——），
				// 文字颜色由 AnsiText 解析 ANSI 码呈现。30s 后自动消退（同内容不去重）。
				case "extension_notify": {
					const msg = (event as any).message;
					if (typeof msg === "string") {
						const timestamp = Date.now();
						set((s) => {
							const list = s.messagesBySession[sessionId] ?? [];
							return {
								messagesBySession: {
									...s.messagesBySession,
									[sessionId]: [
										...list,
										{
											message: {
												type: "custom",
												customType: "extension_notify",
												content: msg,
												timestamp,
											},
											agentName,
											sessionId,
										} as any,
									],
								},
							};
						});
						// 系统提示 30s 后自动从聊天列表消失：按 timestamp 精确匹配移除。
						// 多条同内容 notify 不去重，各自定时器移除自己；目标已被其他操作
						// 移除时 filter 无变化 → return s 不做无意义 set（幂等）。
						setTimeout(() => {
							set((s) => {
								const list = s.messagesBySession[sessionId] ?? [];
								const next = list.filter(
									(m) =>
										!(
											(m.message as any)?.customType === "extension_notify" &&
											(m.message as any)?.timestamp === timestamp
										),
								);
								// 消息已被其他操作移除/会话切换：找不到目标则不做无意义 set
								if (next.length === list.length) return s;
								return {
									messagesBySession: {
										...s.messagesBySession,
										[sessionId]: next,
									},
								};
							});
						}, 30_000);
					}
					break;
				}
				// pi 会话级运行完全终结（重试/压缩重试/排队续跑全部结束）。
				// 思考态兜底复位：正常已被 agent_end{willRetry:false} 复位，此处覆盖
				// agent_end 缺失/乱序的异常路径，防思考态卡死。已空闲则不动，避免无效渲染。
				case "agent_settled":
					set((s) => {
						if (
							s.statusBySession[sessionId] !== "thinking" &&
							s.thinkingSinceBySession[sessionId] == null
						) {
							return {};
						}
						return {
							statusBySession: {
								...s.statusBySession,
								[sessionId]: "idle",
							},
							thinkingSinceBySession: {
								...s.thinkingSinceBySession,
								[sessionId]: null,
							},
						};
					});
					break;
				// turn_start/turn_end：turn 粒度事件（一次 assistant 响应 + 工具调用）。
				// 暂无 UI 消费（roadmap Later：turn 粒度遥测），显式忽略；
				// 消息流已由 message_start/update/end 驱动，turn_end 的 message/toolResults
				// 与之重复，不重复合并。
				case "turn_start":
				case "turn_end":
					break;
				// pi 扩展抛错：toast 即时提醒 + 写入诊断列表（系统设置 > 诊断 持久可查）。
				case "extension_error": {
					const extension = extensionNameFromPath(event.extensionPath);
					useDiagnosticsStore.getState().add({
						extension,
						event: event.event,
						error: event.error,
					});
					useToastStore.getState().add(
						i18n.t("message.extensionError", {
							ext: extension,
							event: event.event,
							error: event.error,
						}),
						"error",
					);
					break;
				}
				// 扩展 setStatus：维护会话级状态条目（statusText 空 = 清除），驱动底部状态栏。
				case "extension_status":
					set((s) => {
						const cur = { ...(s.extStatusBySession[sessionId] ?? {}) };
						if (event.statusText && event.statusText.trim()) {
							cur[event.statusKey] = event.statusText;
						} else {
							delete cur[event.statusKey];
						}
						return {
							extStatusBySession: {
								...s.extStatusBySession,
								[sessionId]: cur,
							},
						};
					});
					break;
				// 扩展 setWidget：维护会话级文本块（widgetLines 空 = 清除），
				// SessionView 在 Composer 上/下方渲染。
				case "extension_widget":
					set((s) => {
						const cur = { ...(s.extWidgetBySession[sessionId] ?? {}) };
						if (event.widgetLines && event.widgetLines.length > 0) {
							cur[event.widgetKey] = {
								lines: event.widgetLines,
								placement: event.widgetPlacement ?? "aboveEditor",
							};
						} else {
							delete cur[event.widgetKey];
						}
						return {
							extWidgetBySession: {
								...s.extWidgetBySession,
								[sessionId]: cur,
							},
						};
					});
					break;
				// 扩展 setTitle：会话级标题，聊天窗顶部状态条展示（不写 document.title）。
				case "extension_title":
					set((s) => ({
						extTitleBySession: {
							...s.extTitleBySession,
							[sessionId]: event.title,
						},
					}));
					break;
				// kernel 合成（插件/技能变更 dirty reload 重建进程后）：
				// 旧进程发射的扩展 UI（status/widget/title）全部失效，清空残留
				// （进程 resume 不重放扩展的 session_start 钩子，UI 是否重发由扩展自身决定）
				case "extension_ui_reset":
					set((s) => ({
						extStatusBySession: {
							...s.extStatusBySession,
							[sessionId]: {},
						},
						extWidgetBySession: {
							...s.extWidgetBySession,
							[sessionId]: {},
						},
						extTitleBySession: {
							...s.extTitleBySession,
							[sessionId]: null,
						},
					}));
					break;
				// tool_execution_* 等其他透传事件：渲染层不消费
				default:
					break;
			}
		},
	};
});
