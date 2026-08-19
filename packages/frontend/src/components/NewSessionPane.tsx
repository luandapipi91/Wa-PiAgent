import { useState, useRef, useEffect } from "react";
import {
	isModelAvailable,
	randomSessionId,
	SYSTEM_PROJECT_ID,
} from "@wa-pi/shared";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore, topAgentsByRecency } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useSessionStore } from "../store/session";
import { useNewSessionExplorerStore } from "../store/new-session-explorer";
import { useUiPrefsStore } from "../store/ui-prefs";
import { api } from "../api-client";
import { expandTokens } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";
import { AgentDropdown } from "./ui/AgentDropdown";
import { ExplorerPanel } from "./ExplorerPanel";
import { SidebarResizer } from "./SidebarResizer";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	/** 侧栏/宫格「新建会话」带过来的预选智能体；为空则取最近使用的智能体 */
	pendingAgent?: string | null;
	/** pendingAgent 已被取用为初始值后回调一次（App 侧清除，避免下次进新建页又预选旧值） */
	onConsumePendingAgent?: () => void;
}

/** 计算新建会话的默认智能体：pendingAgent → defaultAgent（向导设置）→ 最近使用者 → 列表第一项 */
export function pickDefaultAgent(
	agents: ReturnType<typeof useAgentsStore.getState>["list"],
	sessions: ReturnType<typeof useProjectsStore.getState>["sessions"],
	pendingAgent?: string | null,
	defaultAgent?: string | null,
): AgentName | null {
	if (pendingAgent) return pendingAgent as AgentName;
	if (defaultAgent && agents.some((a) => a.displayName === defaultAgent)) {
		return defaultAgent as AgentName;
	}
	if (sessions.length > 0) {
		const r = topAgentsByRecency(agents, sessions, 1)[0]?.displayName;
		if (r) return r;
	}
	return agents[0]?.displayName ?? null;
}

export function NewSessionPane({
	pendingAgent = null,
	onConsumePendingAgent,
}: Props) {
	const { t } = useTranslation();
	const { projects, currentProjectId, sessions } = useProjectsStore();
	const agents = useAgentsStore((s) => s.list);
	const defaultAgent = useUiPrefsStore((s) => s.defaultAgent);
	const explorerOpen = useNewSessionExplorerStore((s) => s.open);
	const explorerWidth = useNewSessionExplorerStore((s) => s.width);
	// 默认选中最近使用的智能体（pendingAgent 优先）；空列表时为 null（发送前置条件拦截）
	const [agentName, setAgentName] = useState<AgentName | null>(
		pickDefaultAgent(agents, sessions, pendingAgent, defaultAgent),
	);
	const [text, setText] = useState("");
	const initialProject =
		currentProjectId ??
		projects.find((p) => p.id === SYSTEM_PROJECT_ID)?.id ??
		projects[0]?.id ??
		null;
	const [projectId, setProjectId] = useState<string | null>(initialProject);
	// 文件浏览侧栏根目录：跟随当前选中项目的 cwd（未选项目为空 → 入口禁用 + 空态兜底）。
	// 默认工作区（__system__）的 cwd 是 workdir 父目录——存放每个会话的独立内部目录，
	// 可能积累数千个子目录；既非用户可用的「项目文件」，一次性列出还会卡死 UI。
	// 因此对默认工作区返回空，让侧栏走空态（空态文案按 projectId 有无区分）。
	const workspaceDir =
		projectId === SYSTEM_PROJECT_ID
			? ""
			: (projects.find((p) => p.id === projectId)?.cwd ?? "");
	// currentProjectId 变化时同步（点项目旁 + 号时可能已在新建页，不会重新挂载）
	useEffect(() => {
		if (currentProjectId) setProjectId(currentProjectId);
	}, [currentProjectId]);
	// pendingAgent 变化时同步（已停在新建页再点侧栏/宫格智能体，组件不会重新挂载）
	useEffect(() => {
		if (pendingAgent) setAgentName(pendingAgent as AgentName);
	}, [pendingAgent]);
	// 首载 agent:list 回包晚于挂载：list 空转非空且 agentName 仍为 null 时回填（沿用 pendingAgent 优先级 + recency）；已选中则不干预
	useEffect(() => {
		if (!agentName && agents.length > 0)
			setAgentName(
				pickDefaultAgent(agents, sessions, pendingAgent, defaultAgent),
			);
	}, [agents, agentName, pendingAgent, sessions, defaultAgent]);
	// 向导重设默认智能体后同步已挂载面板的选择（defaultAgent 只有向导会写，覆盖当前选择语义正确）
	useEffect(() => {
		if (defaultAgent && agents.some((a) => a.displayName === defaultAgent)) {
			setAgentName(defaultAgent as AgentName);
		}
	}, [defaultAgent]);
	// 挂载消费一次：初始值取用后通知 App 清除 pendingAgent（空依赖，仅首次挂载）
	useEffect(() => {
		if (pendingAgent) onConsumePendingAgent?.();
	}, []);
	// 新建会话的 sessionId 按当前项目持久化，切换再回来仍能对应同一组 composer 附件/录音
	const newSessionKey = projectId ?? "__global__";
	const newSessionIds = useComposerPrefsStore((s) => s.newSessionIds);
	const setNewSessionId = useComposerPrefsStore((s) => s.setNewSessionId);
	const [sessionId, setSessionId] = useState(
		() => newSessionIds[newSessionKey] ?? randomSessionId(),
	);
	const sendingRef = useRef(false);
	// === 草稿持久化 ===
	const draftRestoredRef = useRef(false); // 当前草稿 session 是否已尝试恢复（按 sessionId 重置）
	const textRef = useRef(""); // 始终同步最新 text，供 cleanup flush
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevSessionIdRef = useRef(sessionId);

	useEffect(() => {
		const stored = newSessionIds[newSessionKey];
		if (stored && stored !== sessionId) {
			setSessionId(stored);
		} else if (!stored) {
			const fresh = randomSessionId();
			setSessionId(fresh);
			setNewSessionId(newSessionKey, fresh);
		}
	}, [newSessionKey, newSessionIds[newSessionKey], setNewSessionId, sessionId]);

	const defaults = useComposerPrefsStore((s) => s.defaults);
	const setDefaults = useComposerPrefsStore((s) => s.setDefaults);
	const loadDefaults = useComposerPrefsStore((s) => s.loadDefaults);
	const loadSession = useComposerPrefsStore((s) => s.loadSession);

	useEffect(() => {
		void loadDefaults();
	}, [loadDefaults]);
	// 草稿会话也走 loadSession：①setSessionPrefs 的会话级 hydration 守卫要求先 load 才直写 IDB；
	// ②顺带让 IDB 里持久化的草稿附件在 reload 后恢复（此前写入后无人读取，reload 即丢）
	useEffect(() => {
		void loadSession(sessionId);
	}, [sessionId, loadSession]);

	const [model, setModel] = useState<string | null>(defaults.model);
	const [thinking, setThinking] = useState<ThinkingLevel>(defaults.thinking);
	const providers = useProvidersStore((s) => s.providers);
	const prefs = useComposerPrefsStore((s) => s.bySession[sessionId]);
	const attachments = prefs?.attachments ?? [];
	const setAttachments = (
		next: AttachmentDraft[] | ((prev: AttachmentDraft[]) => AttachmentDraft[]),
	) => {
		const resolved = typeof next === "function" ? next(attachments) : next;
		useComposerPrefsStore
			.getState()
			.setSessionPrefs(sessionId, { attachments: resolved });
	};

	const prefsLoaded = useComposerPrefsStore(
		(s) => !!s.loadedBySession[sessionId],
	);
	const draftText = prefs?.text;

	// 渲染期：草稿 sessionId 变化（切换项目）→ 清空 + 重置恢复标记
	if (prevSessionIdRef.current !== sessionId) {
		prevSessionIdRef.current = sessionId;
		draftRestoredRef.current = false;
		setText("");
	}
	useEffect(() => {
		textRef.current = text;
	}, [text]);

	// 草稿恢复：prefs 加载完成且有草稿时恢复一次（draftRestoredRef 防止恢复后又被覆盖）。
	// 仅当用户尚未输入（textRef 为空）才恢复——冷加载间隙用户输入的内容不能被存储旧草稿覆盖
	useEffect(() => {
		if (!draftRestoredRef.current && prefsLoaded) {
			draftRestoredRef.current = true;
			if (draftText && textRef.current === "") setText(draftText);
		}
	}, [prefsLoaded, draftText, sessionId]);

	// 防抖写回：输入变化 300ms 后持久化（含清空 → 写空串 = 放弃草稿）
	const handleTextChange = (next: string) => {
		setText(next);
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null;
			useComposerPrefsStore
				.getState()
				.setSessionPrefs(sessionId, { text: next });
		}, 300);
	};

	// 切走/卸载前 flush：仅当存在未触发的防抖（用户输入过且尚未持久化）时才写回；
	// 未编辑过不写——否则冷加载间隙切走会用空串覆盖 loadSession 尚未恢复的旧草稿
	useEffect(() => {
		const mySessionId = sessionId;
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
				useComposerPrefsStore
					.getState()
					.setSessionPrefs(mySessionId, { text: textRef.current });
			}
		};
	}, [sessionId]);

	useEffect(() => {
		setModel(defaults.model);
		setThinking(defaults.thinking);
	}, [defaults.model, defaults.thinking]);

	const handleSend = () => {
		// model 必须是当前 providers 中真实存在的模型（prefs 可能残留已删除 provider 的过期 model）
		if (
			!projectId ||
			!text.trim() ||
			!isModelAvailable(model, providers) ||
			!agentName ||
			sendingRef.current
		)
			return;
		sendingRef.current = true;
		// newSessionIds 可能残留一个已发送过的会话 id（session:created 未及时清除 / app 重启后从 IndexedDB 读出），
		// 复用会导致 addSession 去重 no-op、selectSession 跳回那个旧会话（「跳到上一个会话」bug）。
		// 这里检测到 sessionId 已被占用时，生成全新 id 并回填 newSessionIds，确保每次发送都是新会话。
		const existed = useProjectsStore
			.getState()
			.sessions.some((s) => s.id === sessionId);
		const finalId = existed ? randomSessionId() : sessionId;
		if (existed && projectId) setNewSessionId(projectId, finalId);
		// primaryAgent = 顶部 dropdown 选中的 agentName（不变）
		// @[xxx] 原样发给主智能体，由 systemPrompt 规则触发 delegate
		const expandedText = expandTokens(text);
		// 乐观 UI：立即创建会话触发导航，消除白屏等待。
		// 用户消息由 kernel session:echo_user 回传后 App.tsx 调 optimisticSend 秒显示。
		// kernel _promptLocks 串行锁防并发竞态。
		useProjectsStore.getState().addSession({
			id: finalId,
			projectId,
			primaryAgent: agentName,
			title: expandedText.slice(0, 20),
			createdAt: Date.now(),
			lastActivity: Date.now(),
			piSessionFile: "",
		});
		// 确保导航到目标会话（addSession 遇去重时会 no-op，currentSessionId 需显式设置）
		useProjectsStore.getState().selectSession(finalId);
		// 标记 pending：发送 prompt 时刻戳，MessageList 在收到服务器回调前显示「会话新建中」加载页；
		// 时间戳+窗口方案：回调到达后消息出现、条件自然失效，无需显式清除；无回调时窗口到期自动隐藏。
		useSessionStore.getState().setPendingPromptAt(finalId, Date.now());
		// 发送即消费草稿 id：placeholder 会话首发消息时 kernel 走 isNew=false 分支，不广播
		// session:created——若只依赖 App.tsx 里那一个 clearNewSessionId 清除点，草稿 id 会
		// 永久残留（localStorage/IDB 持久化），下次进新建页复用同一 id，消息全落进同一会话。
		// 这里主动清除；挂载同步 effect 会按需重新生成全新草稿 id。
		useComposerPrefsStore.getState().clearNewSessionId(newSessionKey);
		void api
			.post(
				`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(finalId)}/prompt`,
				{
					agentName,
					text: expandedText,
					model,
					thinking,
					attachments: attachments.length > 0 ? attachments : undefined,
				},
			)
			.catch((err: unknown) => {
				// 请求失败/超时：记录错误，MessageList 显示「发送失败」。
				// 服务器后续若仍有事件到达（echoUser/handleSDKEvent）会自动清错误，
				// 避免 HTTP 超时但 pi 实际继续处理时的误报。
				const msg = err instanceof Error ? err.message : String(err);
				useSessionStore
					.getState()
					.setPromptError(finalId, msg || "request failed");
			});
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		setText("");
		useComposerPrefsStore.getState().setSessionPrefs(sessionId, { text: "" });
		setAttachments([]);
		setDefaults({ model, thinking });
		// existed 分支下 finalId 与草稿 sessionId 分叉（草稿 id 残留已发送会话）：
		// 选模型时写入的是草稿 id，详情页 Composer 读 bySession[finalId] 会拿到空值、
		// 回退 defaults 显示上一次使用的旧模型。这里把用户选的模型显式落到 finalId 的会话级 prefs。
		useComposerPrefsStore.getState().setSessionPrefs(finalId, { model });
		setTimeout(() => {
			sendingRef.current = false;
		}, 500);
	};

	return (
		<div className="flex-1 flex min-w-0" data-testid="new-session-pane">
			{/* 主列：居中内容 + 右上角文件树开关 */}
			<div className="relative flex-1 flex flex-col items-center justify-center p-10 min-w-0">
				{/* 默认工作区（__system__）的 cwd 是 workdir 父目录（内部会话目录，非项目文件），
				    无文件可浏览 → 隐藏入口按钮（而非禁用），避免误导点击展开空态。 */}
				{projectId !== SYSTEM_PROJECT_ID && (
					<button
						type="button"
						className="fv-btn fv-btn--icon absolute top-4 right-4 disabled:opacity-40 disabled:cursor-not-allowed"
						data-testid="btn-new-session-explorer"
						data-active={explorerOpen ? "true" : "false"}
						aria-expanded={explorerOpen}
						aria-label={t("session.projectFiles")}
						onClick={() => useNewSessionExplorerStore.getState().toggle()}
						disabled={!projectId}
						title={
							projectId
								? t("session.projectFiles")
								: t("newSession.noProjectOption")
						}
						style={
							explorerOpen
								? { color: "var(--accent)" }
								: { color: "var(--text-tertiary)" }
						}
					>
						<Icon
							name="folder"
							size="1em"
							className="text-[calc(18px*var(--font-scale))]"
						/>
					</button>
				)}

				<h2 className="text-[calc(26px*var(--font-scale))] font-extrabold tracking-tight text-primary mb-2">
					{t("newSession.title")}
				</h2>
				<p className="text-sm text-secondary mb-7">
					{t("newSession.subtitle")}
				</p>
				<div className="w-full max-w-2xl mb-4 flex gap-2 items-center">
					<select
						value={projectId ?? ""}
						onChange={(e) => setProjectId(e.target.value || null)}
						className="flex-1 min-w-0 bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[calc(12.5px*var(--font-scale))]"
						data-testid="project-select"
					>
						{projects.length === 0 && (
							<option value="">{t("newSession.noProjectOption")}</option>
						)}
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.id === SYSTEM_PROJECT_ID
									? `🏠 ${t("projectList.systemProjectName")}`
									: `${p.name} ${p.cwd}`}
							</option>
						))}
					</select>
					<AgentDropdown
						agents={agents}
						value={agentName}
						onPick={(name) => setAgentName(name)}
					/>
				</div>
				<ComposerInput
					text={text}
					setText={handleTextChange}
					model={model}
					setModel={(m) => {
						setModel(m);
						useComposerPrefsStore
							.getState()
							.setSessionPrefs(sessionId, { model: m });
					}}
					thinking={thinking}
					setThinking={(t) => {
						setThinking(t);
						setDefaults({ thinking: t });
					}}
					attachments={attachments}
					setAttachments={setAttachments}
					projectId={projectId ?? undefined}
					sessionId={sessionId}
					onSend={handleSend}
					sendDisabled={!projectId || !agentName}
					placeholder={t("newSession.placeholder", {
						agent: agentName ?? t("newSession.defaultAgent"),
					})}
					currentAgentName={agentName ?? undefined}
					isRunning={false}
					isNewSession={true}
				/>
			</div>

			{/* 右侧文件树侧栏：开关由 new-session-explorer store 控制；双击文件弹窗预览 */}
			{explorerOpen && (
				<>
					<SidebarResizer
						side="right"
						onResize={(w) => useNewSessionExplorerStore.getState().setWidth(w)}
						testId="new-session-explorer-resizer"
					/>
					<aside
						className="flex flex-col border-l border-hairline bg-surface"
						style={{ width: explorerWidth, flexShrink: 0 }}
						data-testid="new-session-explorer-aside"
					>
						<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline">
							<span className="text-[calc(12px*var(--font-scale))] font-semibold text-primary flex-1">
								{t("session.projectFiles")}
							</span>
							<button
								className="fv-btn"
								onClick={() => useNewSessionExplorerStore.getState().toggle()}
								title={t("session.collapsePanel")}
								aria-label={t("session.collapsePanel")}
							>
								›
							</button>
						</div>
						<div className="flex-1 overflow-auto">
							{workspaceDir ? (
								<ExplorerPanel
									workspaceDir={workspaceDir}
									projectName={
										projects.find((p) => p.id === projectId)?.name
									}
									onOpenFile={(path) =>
										useSessionStore.getState().openFilePreview(path, sessionId)
									}
								/>
							) : (
								<div className="ep-empty">
									{projectId
										? t("explorer.emptyNoWorkspace")
										: t("newSession.noProjectOption")}
								</div>
							)}
						</div>
					</aside>
				</>
			)}
		</div>
	);
}
