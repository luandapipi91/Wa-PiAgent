import { useEffect, useState } from "react";
import type { AgentName } from "@wa-pi/shared";
import i18n from "i18next";
import { useTranslation } from "./i18n/useTranslation";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { useSidebarStore } from "./store/sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { AgentGalleryModal } from "./components/AgentGalleryModal";
import { AgentMissingModal } from "./components/AgentMissingModal";
import { DirTreePicker } from "./components/DirTreePicker";
import { SettingsModal } from "./components/SettingsModal";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { useOnboardingStore } from "./store/onboarding";
import { useSettingsStore } from "./store/settings";
import { useProvidersStore } from "./store/providers";
import { useProjectsStore } from "./store/projects";
import { useSessionStore } from "./store/session";
import { useAgentsStore } from "./store/agents";
import { useSkillsStore } from "./store/skills";
import { useExtensionsStore } from "./store/extensions";
import { useCommandsStore } from "./store/commands";
import { useMcpStore } from "./store/mcp";
import { useMemoryStore } from "./store/memory";
import { useChannelsStore } from "./store/channels";
import { useContactsStore } from "./store/contacts";
import { useToastStore } from "./store/toast";
import { useComposerPrefsStore } from "./store/composer-prefs";
import { useSubagentsStore } from "./store/subagents";
import { initUpdater } from "./store/updater";
import {
	onMessage,
	connectEvents,
	onReconnect,
	onConnectionChange,
	getConnectionState,
	type ConnectionState,
} from "./events";
import { api } from "./api-client";
import { ToastContainer } from "./components/ui/Toast";
import { RecordingCapsule } from "./components/ui/RecordingCapsule";
import { CommandPalette } from "./components/CommandPalette";
import { FilePreviewModal } from "./components/blocks/FilePreviewModal";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { AnsiText } from "./components/ui/AnsiText";
import { useTrashStore } from "./store/trash";
import { useSchedulerStore } from "./store/scheduler";
import { AutomationMain } from "./components/automation/AutomationMain";

export type View = "empty" | "new-session" | "session";

export function App() {
	// 只订阅渲染所需的最小状态；actions 在回调里用 getState() 取，避免 stale closure
	const { t } = useTranslation();
	const projects = useProjectsStore((s) => s.projects);
	const currentSessionId = useProjectsStore((s) => s.currentSessionId);
	// 订阅 IM 会话列表，用于判定当前 session 是否来自 IM 接入（决定 SessionView 是否传 sourceLabel）
	const conversations = useChannelsStore((s) => s.conversations);
	const [view, setView] = useState<View>("empty");
	// 侧边栏分段标签：tasks | im | automation。提升到 App 级以驱动主内容区路由。
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>("tasks");
	const [configAgent, setConfigAgent] = useState<AgentName | null>(null);
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	// 侧栏/宫格「新建会话」预选的智能体，传给 NewSessionPane
	const [pendingAgent, setPendingAgent] = useState<string | null>(null);
	// 主智能体已删除的会话 id：kernel 回 agent_missing 时打开重选弹窗
	const [agentMissingSessionId, setAgentMissingSessionId] = useState<
		string | null
	>(null);
	const [connState, setConnState] = useState<ConnectionState>(() =>
		getConnectionState(),
	);
	// Provider 连接状态：transient 网络错误（Connection error/timeout）时为 degraded，
	// 驱动「模型连接异常」状态条；与 SSE 通道的 connState 区分。
	const netDegraded = useSessionStore((s) =>
		currentSessionId ? !!s.netStatusBySession[currentSessionId] : false,
	);
	// degraded 的具体原因（kernel classifySdkError 清洗后的 message），状态条优先展示。
	const netMessage = useSessionStore((s) =>
		currentSessionId ? (s.netMessageBySession[currentSessionId] ?? null) : null,
	);
	// pi 自动重试进度：重试期间黄色状态条「正在自动重试 (n/m)」优先于红色 degraded 条。
	const retryInfo = useSessionStore((s) =>
		currentSessionId ? (s.retryBySession[currentSessionId] ?? null) : null,
	);
	// 扩展 setTitle：会话级标题，聊天窗顶部状态条展示（不写 document.title）。
	const extTitle = useSessionStore((s) =>
		currentSessionId ? (s.extTitleBySession[currentSessionId] ?? null) : null,
	);
	// 首次启动引导：providers 首次加载完成且为空时自动弹出初始化向导
	const providers = useProvidersStore((s) => s.providers);
	const providersLoaded = useProvidersStore((s) => s.loaded);

	useEffect(() => onConnectionChange(setConnState), []);

	useEffect(() => {
		connectEvents();
		useProjectsStore.getState().load(); // getState() 取最新 action
		useProvidersStore.getState().load();
		useSkillsStore.getState().load();
		useExtensionsStore.getState().load();
		useAgentsStore.getState().loadAll();
		useSubagentsStore.getState().load();
		useContactsStore.getState().loadContacts();
		// 应用更新 IPC 桥接：desktop 下订阅 updater 事件并拉取版本信息；浏览器 dev 下无 waPiUpdater 直接返回
		initUpdater();
		const offReconnect = onReconnect(() => {
			// SSE 断线重连后刷新快照对齐状态。
			// kernel 可能经历崩溃重启（见 kernel-sidecar auto-respawn），重连后需把
			// mount 时加载的全部 store 重新拉一遍，确保 agents/providers/skills 等与
			// 重启后的 kernel 状态一致，避免前端显示陈旧数据。
			useProjectsStore.getState().load();
			useProvidersStore.getState().load();
			useSkillsStore.getState().load();
			useExtensionsStore.getState().load();
			useAgentsStore.getState().loadAll();
			useSubagentsStore.getState().load();
			// 定时任务：重连后刷新任务列表 + 执行记录
			void useSchedulerStore.getState().loadTasks();
			void useSchedulerStore.getState().loadRecords();
			useContactsStore.getState().loadContacts();
			const sid = useProjectsStore.getState().currentSessionId;
			if (sid) useSessionStore.getState().setHistoryLoading(sid, true);
			if (sid)
				void fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`)
					.then((r) => r.json())
					.then((body: any) => {
						useSessionStore.getState().setMessages(sid, body.messages);
						useSessionStore
							.getState()
							.setActiveStatus(sid, body.isActive, body.thinkingSince);
						useSessionStore.getState().setHistoryLoading(sid, false);
					});
		});
		const off = onMessage((e) => {
			const ps = useProjectsStore.getState(); // 每次事件取最新，避免 stale
			switch (e.type) {
				case "projects:list":
					ps.setAll(e.projects, e.sessions);
					void useTrashStore.getState().refreshBadge();
					break;
				case "project:created":
					ps.addProject(e.project);
					break;
				case "session:created":
					ps.addSession(e.session);
					useComposerPrefsStore.getState().clearNewSessionId(e.session.projectId);
					useCommandsStore.getState().load(e.session.id);
					break;
				// 插件命令开关切换成功后：刷新当前会话的 / 菜单命令列表（开启/关闭立即生效）
				case "extension:commands:changed": {
					const sid = useProjectsStore.getState().currentSessionId;
					if (sid) useCommandsStore.getState().load(sid);
					break;
				}
				// kernel 每次 prompt 都回传用户消息；前端若已通过 Composer.doSend 乐观置入则跳过。
				// echoUser 在「标志仍在」之外再查「同内容 user 已存在」：标志会被 message_start /
				// agent_end / failTurn 提前清除，notify 穿插延长冷启动窗口致 echo_user 延迟到达时，
				// 单靠标志会重复追加第二条 user。收敛查重到 store.echoUser，与乐观发送口径一致。
				case "session:echo_user": {
					useSessionStore.getState().echoUser(e.sessionId, e.text, e.agentName);
					break;
				}
				// sdk:event：所有 SDK 流式事件统一走 store.handleSDKEvent 分发
				// （message_start/update/end、agent_start/end 等由 store 管理两态）
				case "sdk:event":
					useSessionStore.getState().handleSDKEvent(e.sessionId, e);
					break;
				// 会话进程冷启动预热完成：官方 stats 可用，重拉补齐 contextUsage（占比/进度条）
				case "session:activated":
					void useSessionStore.getState().refreshSessionStats(e.sessionId);
					break;
				// subagent:progress：子代理（delegate/fleet）执行进度，按 toolCallId→agent 写入 store，
				// 供 DelegateCard/FleetCard 实时渲染。结构与 bridge 流式帧对齐。
				case "subagent:progress":
					useSessionStore
						.getState()
						.handleSubagentProgress(e.sessionId, e.toolCallId, e.progress);
					break;
				case "error": {
					// kernel/pi 错误：注入出错的会话作为系统错误消息（红色显示）。
					// 优先用事件携带的 sessionId 精确路由；缺省回落 currentSessionId。
					const sid = e.sessionId ?? useProjectsStore.getState().currentSessionId;
					// 会话主智能体已删除：打开重选弹窗（错误消息照常注入，提示用户重发）
					if (e.message === "agent_missing" && e.sessionId)
						setAgentMissingSessionId(e.sessionId);
					if (sid) {
						// agent 启动失败（如 No API key）：agent 从未启动、不会有 agent_end，
						// 必须手动复位 thinking 状态，否则会话永远卡在「思考中」且停止按钮无效
						useSessionStore.getState().failTurn(sid);
						// 构造 SessionMessage（新 append 签名：sessionId + SessionMessage）
						// error 不属于具体 agent，agentName 用任意合法默认；stopReason 标 "error" 供渲染层识别
						// 文本不加 ⚠️ 前缀：视觉上的错误区分由 MessageList 的 stopReason=error 红色渲染承担
						useSessionStore.getState().append(sid, {
							message: {
								role: "assistant",
								content: [{ type: "text", text: e.message }],
								model: "system",
								stopReason: "error",
								timestamp: Date.now(),
							},
							agentName: e.agentName ?? "dev",
							sessionId: sid,
						});
					} else {
						useToastStore.getState().add(e.message);
					}
					break;
				}
				case "net:status": {
					// transient 网络错误（Connection error / timeout 等）：不进对话流，
					// 改设 degraded 状态驱动顶部状态条提示「模型连接异常」。
					// 不调用 failTurn：transient 后 pi 会发 agent_end 自然复位 thinking，
					// 让 pi 内部重试期间（busy=true）新消息继续排队（现有机制）。
					const sid = e.sessionId ?? useProjectsStore.getState().currentSessionId;
					if (sid) {
						useSessionStore.getState().setNetStatus(sid, "degraded", e.message);
					} else {
						useToastStore.getState().add(e.message);
					}
					break;
				}
				case "provider:list":
					useProvidersStore.getState().setProviders(e.providers);
					break;
				case "provider:changed":
					useProvidersStore.getState().setProviders(e.providers);
					break;
				// kernel 在 agent:create/delete/config:save 后都会重新 broadcast agent:list，统一在此收口
				case "agent:list":
					useAgentsStore.getState().setList(e.agents);
					break;
				case "skill:list":
					useSkillsStore.getState().setAll(e);
					break;
				case "skill:changed":
					useSkillsStore.getState().setAll(e);
					break;
				case "extension:list":
					useExtensionsStore.getState().setAll(e);
					break;
				case "extension:changed": {
					useExtensionsStore.getState().setAll(e);
					// 安装/卸载/升级后：刷新当前会话 / 菜单。
					// kernel getCommands 脏感知：idle 的脏会话会先重建 pi 进程再返回新清单，
					// 因此插件命令在当前会话立即生效；busy 会话保持 deferred（下次交互生效）。
					const sid = useProjectsStore.getState().currentSessionId;
					if (sid) useCommandsStore.getState().load(sid);
					break;
				}
				case "extension:error":
					useExtensionsStore.getState().setError(e);
					break;
				case "extension:progress":
					useExtensionsStore.getState().applyProgress(e);
					break;
				case "extension:install:done":
					useExtensionsStore.getState().completeInstall(e);
					break;
				case "extension:repair:progress":
					useExtensionsStore.getState().applyRepairProgress(e);
					break;
				case "extension:repair:done":
					useExtensionsStore.getState().completeRepair();
					useToastStore
						.getState()
						.add(i18n.t("settings.extension.repairDone"), "success");
					break;
				case "memory:list":
				case "memory:changed":
					useMemoryStore.getState().setMemories(e as any);
					break;
				case "instruction:list":
					useMemoryStore.getState().setInstructions(e as any);
					break;
				case "memory:config":
					useMemoryStore.getState().setConfig(e as any);
					break;
				case "mcp:list":
				case "mcp:changed":
					useMcpStore.getState().setServers(e as any);
					break;
				case "mcp:testResult":
					useMcpStore.getState().setTestResult(e as any);
					break;
				case "mcp:tools":
					useMcpStore.getState().setToolsResult(e as any);
					break;
				case "channels:changed":
					void useChannelsStore.getState().loadBots();
					break;
				case "channel-conversations:changed":
					void useChannelsStore.getState().loadConversations();
					break;
				// 定时任务变更/执行记录追加：重新拉取任务列表 + 执行记录（running 态需即时展示）
				case "scheduled-tasks:changed":
					void useSchedulerStore.getState().loadTasks();
					void useSchedulerStore.getState().loadRecords();
					break;
				case "scheduled-task:completed":
					void useSchedulerStore.getState().loadTasks();
					void useSchedulerStore.getState().loadRecords();
					break;
				// 调度注册失败（cron 非法等）：toast 提示 + 刷新任务列表
				case "scheduled-task:error":
					useToastStore
						.getState()
						.add(`定时任务调度失败：${e.error ?? "未知错误"}`, "error");
					void useSchedulerStore.getState().loadTasks();
					break;
				case "contacts:changed":
					void useContactsStore.getState().loadContacts();
					break;
			}
		});
		return () => {
			off();
			offReconnect();
		};
	}, []); // 空依赖：onMessage 用 getState，不需重订阅

	// 派生 view
	useEffect(() => {
		if (projects.length === 0) setView("empty");
		else if (currentSessionId) setView("session");
		else setView("new-session");
	}, [projects.length, currentSessionId]);

	// 首次启动引导：无任何模型供应商时自动弹出初始化向导。
	// 等首次 load() 成功返回（loaded=true）再判定，避免 mount 即闪弹、
	// 也避免 load 前的 SSE provider:list 空事件误触发。
	useEffect(() => {
		if (providersLoaded && providers.length === 0) {
			useOnboardingStore.getState().openWizard();
		}
	}, [providersLoaded, providers]);

	// 点智能体 → 带着预选切到新建会话视图（与 NewSessionButton 的视图切换一致）
	const chatWith = (name: string) => {
		setPendingAgent(name);
		setView("new-session");
	};

	// ⌘K / Ctrl+K 弹出命令调色板
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// 监听来自 CommandPalette 和 SlashMenu 的自定义事件
	useEffect(() => {
		const handlers: Record<string, () => void> = {
			// 打开智能体宫格：不关闭已打开的编辑弹窗（允许两者叠加：编辑框盖在列表上）
			"wa-pi:open-gallery": () => setGalleryOpen(true),
			"wa-pi:open-settings": () => useSettingsStore.getState().open(),
			"wa-pi:open-settings-skills": () => {
				useSettingsStore.getState().open();
				useSettingsStore.getState().setSection("skills");
			},
			"wa-pi:reload-config": async () => {
				const sid = useProjectsStore.getState().currentSessionId;
				if (!sid) {
					useToastStore.getState().add(t("app.noOpenSession"), "error");
					return;
				}
				const status = useSessionStore.getState().statusBySession[sid];
				if (status === "thinking") {
					useToastStore.getState().add(t("app.reloadWhileThinking"), "error");
					return;
				}
				const msgs = useSessionStore.getState().messagesBySession[sid] ?? [];
				if (msgs.length === 0) {
					useToastStore.getState().add(t("app.reloadNoMessage"), "error");
					return;
				}
				const ts = Date.now();
				useSessionStore.getState().setReloading(true);
				// 先显示过渡消息（用固定 timestamp 确保完成后替换而非追加）
				useSessionStore.getState().append(sid, {
					message: {
						type: "custom",
						customType: "reload_config",
						content: t("app.reloadingConfig"),
						timestamp: ts,
					} as any,
				});
				try {
					await api.post(`/api/sessions/${encodeURIComponent(sid)}/reload`);
					// reload 完成后替换过渡消息（同 timestamp → append 去重覆盖）
					useSessionStore.getState().append(sid, {
						message: {
							type: "custom",
							customType: "reload_config",
							content: t("app.configReloaded"),
							timestamp: ts,
						} as any,
					});
					useProvidersStore.getState().load();
					useSkillsStore.getState().load();
					useExtensionsStore.getState().load();
					useAgentsStore.getState().loadAll();
					useSubagentsStore.getState().load();
					useToastStore.getState().add(t("app.configReloaded"), "success");
				} catch (err: any) {
					useToastStore
						.getState()
						.add(
							t("app.reloadFailed", { error: err?.message ?? String(err) }),
							"error",
						);
				} finally {
					useSessionStore.getState().setReloading(false);
				}
			},
		};
		for (const [event, handler] of Object.entries(handlers)) {
			window.addEventListener(event, handler);
		}
		// pi 命令（/compact /goal 等）：把 /命令名 作为普通 prompt 发给当前会话的 pi 进程
		const onPiCommand = async (e: Event) => {
			const cmdText = (e as CustomEvent).detail?.text as string | undefined;
			if (!cmdText) return;
			const sid = useProjectsStore.getState().currentSessionId;
			if (!sid) {
				useToastStore.getState().add(t("app.noOpenSession"), "error");
				return;
			}
			const { sessions, currentProjectId } = useProjectsStore.getState();
			const session = sessions.find((s) => s.id === sid);
			const pid = session?.projectId ?? currentProjectId ?? "";
			if (!pid) {
				useToastStore.getState().add(t("app.projectNotFound"), "error");
				return;
			}
			const prefs = useComposerPrefsStore.getState().bySession[sid] ?? {
				model: useComposerPrefsStore.getState().defaults.model,
				thinking: useComposerPrefsStore.getState().defaults.thinking,
			};
			if (!prefs.model) {
				useToastStore.getState().add(t("app.chooseModelFirst"), "error");
				return;
			}
			// 乐观显示用户消息（与 Composer.doSend 一致），再发 prompt
			useSessionStore
				.getState()
				.optimisticSend(sid, cmdText, session?.primaryAgent ?? "dev");
			api
				.post(
					`/api/agents/${encodeURIComponent(pid)}/${encodeURIComponent(sid)}/prompt`,
					{
						agentName: session?.primaryAgent ?? "dev",
						text: cmdText,
						model: prefs.model,
						thinking: prefs.thinking,
					},
				)
				.catch((err) => {
					console.error("[pi-command] 发送失败:", err);
					useSessionStore.getState().failTurn(sid);
				});
		};
		window.addEventListener("wa-pi:pi-command", onPiCommand as EventListener);
		return () => {
			for (const [event, handler] of Object.entries(handlers)) {
				window.removeEventListener(event, handler);
			}
			window.removeEventListener("wa-pi:pi-command", onPiCommand as EventListener);
		};
	}, []);

	return (
		<div className="flex h-screen bg-canvas">
			<Sidebar
				onNewSession={() => setView("new-session")}
				onMore={() => setGalleryOpen(true)}
				onSelectSession={(id) => {
					const st = useProjectsStore.getState();
					if (st.sessions.some((x) => x.id === id)) {
						st.selectSession(id);
					} else {
						// 兜底：会话不在本地列表（如 kernel 侧建的 IM 接入会话尚未同步）时先重拉再选中，
						// 否则 SessionView 找不到 session 渲染空白
						void st.load().then(() => useProjectsStore.getState().selectSession(id));
					}
					setView("session");
				}}
				onNewSessionInProject={(pid) => {
					useProjectsStore.getState().selectProject(pid);
					useProjectsStore.getState().setCurrentSessionId(null);
					setView("new-session");
				}}
				onSelectProject={(pid) => {
					useProjectsStore.getState().selectProject(pid);
					useProjectsStore.getState().setCurrentSessionId(null);
					setView("new-session");
				}}
				onNewProject={() => {
					void useProjectsStore.getState().createProjectFromDir();
				}}
				currentView={view}
				tab={sidebarTab}
				onTabChange={setSidebarTab}
			/>
			<SidebarResizer
				side="left"
				onResize={(w) => useSidebarStore.getState().setWidth(w)}
				testId="sidebar-resizer"
			/>
			<main className="flex-1 flex flex-col overflow-hidden">
				{connState === "reconnecting" && (
					<div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs bg-warning-soft text-warning border-b border-warning/20">
						<span
							className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
							style={{
								border: "2px solid var(--warning)",
								borderTopColor: "transparent",
								animation: "spin 0.8s linear infinite",
							}}
						/>
						{t("app.reconnecting")}
					</div>
				)}
				{retryInfo && (
					<div
						className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs bg-warning-soft text-warning border-b border-warning/20"
						data-testid="retry-status-bar"
					>
						<span
							className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
							style={{
								border: "2px solid var(--warning)",
								borderTopColor: "transparent",
								animation: "spin 0.8s linear infinite",
							}}
						/>
						{t("app.retrying", {
							attempt: retryInfo.attempt,
							max: retryInfo.maxAttempts,
						})}
					</div>
				)}
				{netDegraded && !retryInfo && (
					<div
						className="flex items-center justify-center px-4 py-1.5 text-xs bg-danger-soft text-danger border-b border-danger/20"
						data-testid="net-status-bar"
					>
						{netMessage ?? t("app.netDegraded")}
					</div>
				)}
				{extTitle && (
					<div
						className="flex items-center justify-center gap-2 px-4 py-1.5 text-[calc(12px*var(--font-scale))] bg-surface-elevated text-secondary border-b border-hairline"
						data-testid="ext-title-bar"
					>
						<AnsiText text={extTitle} />
					</div>
				)}
				{sidebarTab === "automation" ? (
					<AutomationMain />
				) : view === "empty" ? (
					<EmptyState
						onNewProject={() => {
							void useProjectsStore.getState().createProjectFromDir();
						}}
					/>
				) : null}
				{/* automation 页签独占主内容区：互斥渲染 new-session/session（view state 不动，切回 tasks 恢复原视图） */}
				{view === "new-session" && sidebarTab !== "automation" && (
					<NewSessionPane
						pendingAgent={pendingAgent}
						onConsumePendingAgent={() => setPendingAgent(null)}
					/>
				)}
				{view === "session" &&
					sidebarTab !== "automation" &&
					currentSessionId &&
					(() => {
						// IM 接入会话：来源文案拼到 header 状态行末尾；普通本地会话为 undefined。
						// 群聊会话按「群+用户」隔离，文案追加群与发送者，便于在会话详情区分。
						const imConv = conversations.find(
							(c) => c.sessionId === currentSessionId,
						);
						const label = imConv
							? imConv.chatType === "group"
								? t("app.imSourceGroup", {
										channel: imConv.channelName,
										chatId: imConv.chatId.slice(0, 8),
										from: imConv.fromUserId,
									})
								: t("app.imSourceSingle", { channel: imConv.channelName })
							: undefined;
						return (
							<SessionView
								sessionId={currentSessionId}
								sourceLabel={label}
								imConv={imConv}
							/>
						);
					})()}
			</main>
			{galleryOpen && (
				<AgentGalleryModal
					onClose={() => setGalleryOpen(false)}
					onChatWith={(name) => {
						setGalleryOpen(false);
						chatWith(name);
					}}
					onEdit={(name) => {
						// 编辑弹窗叠加显示，列表保持打开（用户可在列表与编辑间对照）
						setConfigAgent(name);
					}}
					onCreated={(name) => {
						// 新建后打开编辑弹窗，列表保持打开
						setConfigAgent(name);
					}}
				/>
			)}
			{configAgent && (
				<AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />
			)}
			{agentMissingSessionId && (
				<AgentMissingModal
					sessionId={agentMissingSessionId}
					onClose={() => setAgentMissingSessionId(null)}
				/>
			)}
			{useProjectsStore((s) => s.dirPickerOpen) && (
				<DirTreePicker
					onPick={(cwd) => useProjectsStore.getState().createProjectFromPath(cwd)}
					onCancel={() => useProjectsStore.getState().closeDirPicker()}
				/>
			)}
			{useSettingsStore((s) => s.showSettings) && (
				<SettingsModal onClose={() => useSettingsStore.getState().close()} />
			)}
			{useOnboardingStore((s) => s.wizardOpen) && (
				<OnboardingWizard
					onClose={() => useOnboardingStore.getState().closeWizard()}
				/>
			)}
			{paletteOpen && (
				<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
			)}
			<FilePreviewModal />
			<ExtensionDialog />
			<ToastContainer />
			<RecordingCapsule />
		</div>
	);
}
