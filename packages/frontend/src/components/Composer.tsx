import { useState, useRef, useEffect } from "react";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { isModelAvailable } from "@wa-pi/shared";
import { api } from "../api-client";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useCommandsStore } from "../store/commands";
import { useSessionStore } from "../store/session";
import { expandTokens } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	sessionId: string;
	agentName: AgentName;
	isRunning?: boolean;
	isNewSession?: boolean;
	disabled?: boolean;
}

export function Composer({
	sessionId,
	agentName,
	isRunning,
	isNewSession,
	disabled,
}: Props) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	// === 草稿持久化 ===
	const draftRestoredRef = useRef(false); // 当前 session 是否已尝试恢复草稿（按 sessionId 重置）
	const textRef = useRef(""); // 始终同步最新 text，供 cleanup flush
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevSessionIdRef = useRef(sessionId);
	const sendingRef = useRef(false);
	const { sessions, currentProjectId } = useProjectsStore();
	const session = sessions.find((s) => s.id === sessionId);
	const projectId = session?.projectId ?? currentProjectId ?? "";

	const prefs = useComposerPrefsStore((s) => s.bySession[sessionId]);
	const setSessionPrefs = useComposerPrefsStore((s) => s.setSessionPrefs);
	const loadSession = useComposerPrefsStore((s) => s.loadSession);
	// 会话 prefs 冷加载完成前禁止 auto-select：间隙内 model=null 会触发 ModelSelector
	// 自动选第一个模型并写进 prefs/defaults（"切几个会话后模型被重置为第一个"的根因）
	const prefsLoaded = useComposerPrefsStore(
		(s) => !!s.loadedBySession[sessionId],
	);

	const draftText = prefs?.text;

	// pi 扩展 setEditorText：替换输入框内容并写入草稿（ts 去重，同一次注入只应用一次）
	const injection = useSessionStore((s) => s.editorTextInjection[sessionId]);
	const appliedInjectionTsRef = useRef(0);
	useEffect(() => {
		if (injection && injection.ts !== appliedInjectionTsRef.current) {
			appliedInjectionTsRef.current = injection.ts;
			setText(injection.text);
			setSessionPrefs(sessionId, { text: injection.text });
			// 应用后立即清除 store 里的注入记录：appliedInjectionTsRef 随卸载重置，
			// 不清除则 Composer 重挂载（切「新会话」视图再切回）会重放旧注入、覆盖用户草稿
			useSessionStore.setState((s) => {
				const next = { ...s.editorTextInjection };
				delete next[sessionId];
				return { editorTextInjection: next };
			});
		}
	}, [injection, sessionId, setSessionPrefs]);

	// 渲染期：sessionId 变化 → 立即清空输入框（消除旧会话文本残留一帧）+ 重置恢复标记
	if (prevSessionIdRef.current !== sessionId) {
		prevSessionIdRef.current = sessionId;
		draftRestoredRef.current = false;
		setText("");
	}
	// textRef 始终同步最新 text
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
			setSessionPrefs(sessionId, { text: next });
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
				setSessionPrefs(mySessionId, { text: textRef.current });
			}
		};
	}, [sessionId, setSessionPrefs]);

	useEffect(() => {
		void loadSession(sessionId);
	}, [sessionId, loadSession]);

	const model = prefs?.model ?? null;
	// thinking 未显式设置时回退到全局 defaults（而非硬编码 disabled）
	const defaults = useComposerPrefsStore((s) => s.defaults);
	const thinking = prefs?.thinking ?? defaults.thinking;
	const attachments = prefs?.attachments ?? [];
	const providers = useProvidersStore((s) => s.providers);

	const doSend = (targetAgent: AgentName, expandedText: string) => {
		sendingRef.current = true;
		// 已注册扩展命令（如 /uidemo、内置插件的 /goal）：pi 拦截直接执行 handler、不产生
		// user 回声，跳过乐观插入——否则聊天窗会多出一条并不存在的用户消息
		// （与 kernel 侧 session:echo_user 抑制规则一致）。
		// 注意用未过滤的 allCommands：开关关闭的命令不出现在 / 菜单，但 pi 只要注册了
		// 就仍会拦截执行，回显抑制必须与 kernel 口径一致。
		const trimmed = expandedText.trim();
		const isExtCmd =
			trimmed.startsWith("/") &&
			useCommandsStore
				.getState()
				.allCommands.some(
					(c) =>
						c.source === "extension" &&
						c.name === trimmed.slice(1).split(/\s/, 1)[0],
				);
		// 空闲时：乐观 UI 立即显示用户消息 + AI loading，不等 SDK 回声。
		// 运行中：消息发给 kernel 入队（followUp），立即显示在顶部队列面板。
		if (!isRunning) {
			if (!isExtCmd) {
				useSessionStore
					.getState()
					.optimisticSend(sessionId, expandedText, targetAgent);
			}
		} else {
			// 乐观追加到排队列表，同时标记 optimisticEcho 防止 kernel 的 session:echo_user
			// 把 followUp 消息重复注入到会话列表（echo_user 会对每条 prompt 回传）
			useSessionStore.setState((s) => {
				const cur = s.queueBySession[sessionId];
				return {
					queueBySession: {
						...s.queueBySession,
						[sessionId]: {
							steering: cur?.steering ?? [],
							followUp: cur ? [...cur.followUp, expandedText] : [expandedText],
						},
					},
					optimisticEchoBySession: {
						...s.optimisticEchoBySession,
						[sessionId]: true,
					},
				};
			});
		}
		api
			.post(
				`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/prompt`,
				{
					agentName: targetAgent,
					text: expandedText,
					model: model!,
					thinking,
					attachments: attachments.length > 0 ? attachments : undefined,
				},
			)
			.catch((err) => {
				console.error("[composer] 发送失败:", err);
				useSessionStore.getState().failTurn(sessionId);
			});
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		setText("");
		setSessionPrefs(sessionId, { text: "" });
		setSessionPrefs(sessionId, { attachments: [] });
		setTimeout(() => {
			sendingRef.current = false;
		}, 500);
	};

	const handleSend = () => {
		if (disabled) return;
		// @[xxx] 不剥离，原样保留给主智能体识别（由 WA_PI_DEFAULT_SYSTEM_PROMPT 中的规则触发 delegate）
		const expandedText = expandTokens(text);
		if (
			!expandedText.trim() ||
			!isModelAvailable(model, providers) ||
			sendingRef.current ||
			!projectId
		)
			return;
		doSend(agentName, expandedText);
	};

	const handleSendSteer = () => {
		if (disabled) return;
		const expandedText = expandTokens(text);
		if (
			!expandedText.trim() ||
			!isModelAvailable(model, providers) ||
			sendingRef.current ||
			!projectId
		)
			return;
		if (!isRunning) {
			// 空闲：等同普通发送（走 doSend 完整清理逻辑）
			doSend(agentName, expandedText);
			return;
		}
		// 运行中：乐观加入 steering 队列 + 调 /steer（复刻 SessionView.handlePromote 模式，
		// 不设 optimisticEcho——/steer 不触发 session:echo_user，与 handlePromote 一致）
		useSessionStore.setState((s) => {
			const cur = s.queueBySession[sessionId];
			return {
				queueBySession: {
					...s.queueBySession,
					[sessionId]: {
						steering: cur?.steering?.includes(expandedText)
							? cur.steering
							: [...(cur?.steering ?? []), expandedText],
						followUp: cur?.followUp ?? [],
					},
				},
			};
		});
		api
			.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
				text: expandedText,
			})
			.catch((err) => console.error("[composer] 引导发送失败:", err));
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		setText("");
		setSessionPrefs(sessionId, { text: "" });
	};

	return (
		<div className="px-6 py-3 pb-5" data-testid="composer">
			<ComposerInput
				text={text}
				setText={handleTextChange}
				model={model}
				setModel={(m) => setSessionPrefs(sessionId, { model: m })}
				thinking={thinking}
				setThinking={(t) => setSessionPrefs(sessionId, { thinking: t })}
				attachments={attachments}
				setAttachments={(updater) => {
					const current =
						useComposerPrefsStore.getState().bySession[sessionId]
							?.attachments ?? [];
					const next =
						typeof updater === "function"
							? (updater as (prev: AttachmentDraft[]) => AttachmentDraft[])(
									current,
								)
							: updater;
					setSessionPrefs(sessionId, { attachments: next });
				}}
				projectId={projectId}
				sessionId={sessionId}
				onSend={handleSend}
				onSendSteer={handleSendSteer}
				sendDisabled={!projectId}
				disabled={disabled}
				placeholder={
					disabled
						? t("composerExtra.placeholderBlocked")
						: isRunning
							? t("composerExtra.placeholderQueued")
							: t("newSession.placeholder", { agent: agentName })
				}
				isRunning={isRunning}
				isNewSession={isNewSession}
				currentAgentName={agentName}
				modelAutoSelectEnabled={prefsLoaded}
			/>
		</div>
	);
}
