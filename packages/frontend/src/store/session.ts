import { create } from "zustand";
import type {
	SessionMessage,
	AgentStatus,
	AgentName,
	SDKEventEnvelope,
	SubagentProgressEvent,
} from "@wa-pi/shared";
import { useProjectsStore } from "./projects";
import { StreamingBatcher } from "./streaming-batcher";

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
	// 会话级消息队列：steering 引导队列（来自 pi queue_update）+ followUp 排队队列
	queueBySession: Record<
		string,
		{ steering: readonly string[]; followUp: readonly string[] }
	>;
	// 会话级 token 累计：按 sessionId 存储 input/output 累计
	tokenTotals: Record<string, { input: number; output: number }>;
	// 会话级最近一次调用的 usage（供 SessionView 渲染胶囊）
	lastUsageBySession: Record<
		string,
		{ input: number; output: number; cacheRead: number; cacheWrite: number }
	>;
	// 会话级 Provider 连接状态：transient 网络错误（Connection error/timeout）时置 "degraded"，
	// 顶部状态条提示「模型连接异常」；下次成功回复（message_end 正常）或重连后清除。
	// 与 events.ts 的 ConnectionState（SSE 推送通道）区分——那是 kernel→前端通道。
	netStatusBySession: Record<string, "degraded" | null>;
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
	/** 根据后端 isActive 设置会话 thinking/idle 状态 */
	setActiveStatus: (
		sessionId: string,
		isActive: boolean,
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
	/** 累加会话 token 计数（input/output 增量） */
	addTokens: (sessionId: string, input: number, output: number) => void;
	/** 从历史消息 seed 累计 token 计数 */
	seedTokenTotal: (sessionId: string, messages: SessionMessage[]) => void;
}

// 流式标识：同 agent 同时刻同 role 视为同一条流式增量
function msgKey(m: SessionMessage): string {
	const inner = m.message as any;
	return `${inner.role ?? "custom"}-${inner.timestamp}`;
}

export const useSessionStore = create<SessionState>((set) => {
	// streaming 渲染 rAF 合帧（阶段一·卡顿修复项 2）：一帧内多次 message_update
	// 只提交一次（取最新），避免每 token 一次全量重渲染；终态事件 drop 防旧 partial 复活。
	const raf: (fn: () => void) => unknown =
		typeof requestAnimationFrame !== "undefined"
			? requestAnimationFrame
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
		unreadBySession: {},
		queueBySession: {},
		reloading: false,
		tokenTotals: {},
		lastUsageBySession: {},
		netStatusBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		filePreview: null,

		addTokens: (sessionId, input, output) =>
			set((s) => {
				const cur = s.tokenTotals[sessionId] ?? { input: 0, output: 0 };
				if (input === 0 && output === 0) return {};
				return {
					tokenTotals: {
						...s.tokenTotals,
						[sessionId]: {
							input: cur.input + input,
							output: cur.output + output,
						},
					},
				};
			}),

		seedTokenTotal: (sessionId, messages) => {
			let input = 0;
			let output = 0;
			let lastUsage: any = null;
			for (const sm of messages) {
				const m = sm.message as any;
				if (m.role === "assistant" && m.usage) {
					input += m.usage.input;
					output += m.usage.output;
					lastUsage = m.usage;
				}
			}
			if (input > 0 || output > 0 || lastUsage) {
				set((s) => {
					const patch: any = {};
					if (input > 0 || output > 0) {
						patch.tokenTotals = {
							...s.tokenTotals,
							[sessionId]: { input, output },
						};
					}
					if (lastUsage) {
						patch.lastUsageBySession = {
							...s.lastUsageBySession,
							[sessionId]: lastUsage,
						};
					}
					return patch;
				});
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

		/** 根据 isActive 设置会话状态（历史加载/重连时调用） */
		setActiveStatus: (
			sessionId: string,
			isActive: boolean,
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
				return {};
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
				unreadBySession: {},
				netStatusBySession: {},
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
				return {
					// 立即追加用户消息（agentName 留空：用户消息不属于具体 agent）
					messagesBySession: {
						...s.messagesBySession,
						[sessionId]: [
							...list,
							{
								message: { role: "user", content: text, timestamp: ts },
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
						[toolCallId]: { ...prev, [progress.agent]: progress },
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
			switch (event.type) {
				// 用户消息：直接定稿进 messages
				case "message_start": {
					const msg = event.message as any;
					if (msg.role === "user") {
						set((s) => {
							const list = s.messagesBySession[sessionId] ?? [];
							const last = list[list.length - 1];
							// 乐观发送已占位（且末尾确为占位用户消息）：用 SDK 权威版本替换，
							// 同步 timestamp 避免切回会话时 setMessages 合并出重复行；并清标记。
							const pending =
								!!s.optimisticEchoBySession[sessionId] &&
								last &&
								(last.message as any).role === "user";
							const newList = pending
								? [...list.slice(0, -1), { message: msg, agentName }]
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
				// 流式增量：用 assistantMessageEvent.partial 覆盖 streamingMessage（rAF 合帧提交）
				case "message_update": {
					const partial = (event as any).assistantMessageEvent?.partial;
					const streamingMsg = partial ?? (event as any).message;
					if (streamingMsg) {
						// 直接 set 流式内容，不经过 rAF 合帧。
						// rAF 在部分浏览器环境下可能延迟过长（尤其是后台标签页），
						// 导致流式输出感觉"一次全出来"。
						set((s) => ({
							streamingBySession: {
								...s.streamingBySession,
								[sessionId]: { message: streamingMsg, agentName },
							},
						}));
					}
					break;
				}
				// 流式结束：assistant — 合并到同 turn 的最后一条 assistant 消息
				// toolResult — 单独成消息，渲染层 preprocess 会按 toolCallId 挂到前一个 assistant
				case "message_end": {
					// 终态到达：丢弃挂起的 streaming 帧，防止旧 partial 在定稿后复活
					streamingBatcher.drop(sessionId);
					const msg = event.message as any;
					if (msg.role === "toolResult") {
						// 子 agent usage：delegate 工具返回的 childUsage 累加到会话 token
						const childUsage = (msg as any).details?.childUsage?.tokens;
						if (childUsage && (childUsage.input > 0 || childUsage.output > 0)) {
							set((s) => {
								const cur = s.tokenTotals[sessionId] ?? { input: 0, output: 0 };
								return {
									tokenTotals: {
										...s.tokenTotals,
										[sessionId]: {
											input: cur.input + childUsage.input,
											output: cur.output + childUsage.output,
										},
									},
								};
							});
						}
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
					// 记录最近一次调用的 usage（供 SessionView 渲染胶囊）
					if (msg.usage) {
						set((s) => ({
							lastUsageBySession: {
								...s.lastUsageBySession,
								[sessionId]: msg.usage,
							},
						}));
						// 累加 token 计数（跳过全 0 usage，如 error 消息）
						if (msg.usage.input > 0 || msg.usage.output > 0) {
							set((s) => {
								const cur = s.tokenTotals[sessionId] ?? { input: 0, output: 0 };
								return {
									tokenTotals: {
										...s.tokenTotals,
										[sessionId]: {
											input: cur.input + msg.usage.input,
											output: cur.output + msg.usage.output,
										},
									},
								};
							});
						}
					}
					// 失败但无实质内容（空 content / 仅空 text block）：跳过合并，避免渲染「裸头像」行。
					// 该错误的可见表示由 kernel 广播的 {type:"error"} → App.tsx 注入的红色 ⚠️ 横幅承担。
					const hasMeaningfulContent =
						Array.isArray(msg.content) &&
						msg.content.some(
							(b: any) =>
								(b.type === "text" &&
									typeof b.text === "string" &&
									b.text.trim().length > 0) ||
								b.type === "thinking" ||
								b.type === "toolCall",
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
						const result: any = {
							statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
							thinkingSinceBySession: {
								...s.thinkingSinceBySession,
								[sessionId]: null,
							},
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
				// pi 扩展 ctx.ui.notify 反馈（如 /lens-toggle 执行结果）：kernel 包装在 sdk:event 内转发，
				// 这里插入聊天窗口中间的系统提示（复用 custom 消息渲染：居中 —— content ——），
				// 否则命令执行成功但用户看不到任何反馈（表现为“发送无响应”）。
				case "extension_notify": {
					const msg = (event as any).message;
					if (typeof msg === "string") {
						set((s) => {
							const list = s.messagesBySession[sessionId] ?? [];
							// 去重：与最后一条 extension_notify 内容相同则不重复插入
							//（pi 启动时可能连发多条同内容 notify）
							const last = list[list.length - 1]?.message as any;
							if (
								last?.type === "custom" &&
								last?.customType === "extension_notify" &&
								last?.content === msg
							) {
								return s;
							}
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
												timestamp: Date.now(),
											},
											agentName,
											sessionId,
										} as any,
									],
								},
							};
						});
					}
					break;
				}
				// turn_start/turn_end/tool_execution_* 暂不在 store 处理：渲染层不消费
				default:
					break;
			}
		},
	};
});
