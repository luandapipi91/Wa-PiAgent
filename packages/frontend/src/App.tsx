import { useEffect, useState } from "react";
import type { AgentName } from "@wa-pi/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { AgentGalleryModal } from "./components/AgentGalleryModal";
import { AgentMissingModal } from "./components/AgentMissingModal";
import { DirTreePicker } from "./components/DirTreePicker";
import { SettingsModal } from "./components/SettingsModal";
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
import { useToastStore } from "./store/toast";
import { useComposerPrefsStore } from "./store/composer-prefs";
import { useSubagentsStore } from "./store/subagents";
import { onMessage, connectEvents, onReconnect, onConnectionChange, getConnectionState, type ConnectionState } from "./events";
import { api } from "./api-client";
import { ToastContainer } from "./components/ui/Toast";
import { RecordingCapsule } from "./components/ui/RecordingCapsule";
import { CommandPalette } from "./components/CommandPalette";

export type View = "empty" | "new-session" | "session";

export function App() {
  // 只订阅渲染所需的最小状态；actions 在回调里用 getState() 取，避免 stale closure
  const projects = useProjectsStore(s => s.projects);
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const [view, setView] = useState<View>("empty");
  const [configAgent, setConfigAgent] = useState<AgentName | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 侧栏/宫格「新建会话」预选的智能体，传给 NewSessionPane
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  // 主智能体已删除的会话 id：kernel 回 agent_missing 时打开重选弹窗
  const [agentMissingSessionId, setAgentMissingSessionId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(() => getConnectionState());

  useEffect(() => onConnectionChange(setConnState), []);

  useEffect(() => {
    connectEvents();
    useProjectsStore.getState().load();  // getState() 取最新 action
    useProvidersStore.getState().load();
    useSkillsStore.getState().load();
    useExtensionsStore.getState().load();
    useAgentsStore.getState().loadAll();
    useSubagentsStore.getState().load();
    const offReconnect = onReconnect(() => {
      // SSE 断线重连后刷新快照对齐状态
      useProjectsStore.getState().load();
      const sid = useProjectsStore.getState().currentSessionId;
      if (sid) useSessionStore.getState().setHistoryLoading(sid, true);
      if (sid) void fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`).then(r => r.json()).then((body: any) => {
        useSessionStore.getState().setMessages(sid, body.messages);
        useSessionStore.getState().setActiveStatus(sid, body.isActive, body.thinkingSince);
        useSessionStore.getState().setHistoryLoading(sid, false);
      });
    });
    const off = onMessage(e => {
      const ps = useProjectsStore.getState();  // 每次事件取最新，避免 stale
      switch (e.type) {
        case "projects:list": ps.setAll(e.projects, e.sessions); break;
        case "project:created": ps.addProject(e.project); break;
        case "session:created": ps.addSession(e.session); useComposerPrefsStore.getState().clearNewSessionId(e.session.projectId); useCommandsStore.getState().load(e.session.id); break;
        // kernel 每次 prompt 都回传用户消息；前端若已通过 Composer.doSend 乐观置入则跳过
        case "session:echo_user": {
          const s = useSessionStore.getState();
          if (!s.optimisticEchoBySession[e.sessionId]) {
            s.optimisticSend(e.sessionId, e.text, e.agentName);
          }
          break;
        }
        // sdk:event：所有 SDK 流式事件统一走 store.handleSDKEvent 分发
        // （message_start/update/end、agent_start/end 等由 store 管理两态）
        case "sdk:event": useSessionStore.getState().handleSDKEvent(e.sessionId, e); break;
        case "error": {
          // kernel/pi 错误：注入出错的会话作为系统错误消息（红色显示）。
          // 优先用事件携带的 sessionId 精确路由；缺省回落 currentSessionId。
          const sid = e.sessionId ?? useProjectsStore.getState().currentSessionId;
          // 会话主智能体已删除：打开重选弹窗（错误消息照常注入，提示用户重发）
          if (e.message === "agent_missing" && e.sessionId) setAgentMissingSessionId(e.sessionId);
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
        case "provider:list": useProvidersStore.getState().setProviders(e.providers); break;
        case "provider:changed": useProvidersStore.getState().setProviders(e.providers); break;
        // kernel 在 agent:create/delete/config:save 后都会重新 broadcast agent:list，统一在此收口
        case "agent:list": useAgentsStore.getState().setList(e.agents); break;
        case "skill:list": useSkillsStore.getState().setAll(e); break;
        case "skill:changed": useSkillsStore.getState().setAll(e); break;
        case "extension:list": useExtensionsStore.getState().setAll(e); break;
        case "extension:changed": useExtensionsStore.getState().setAll(e); break;
        case "extension:error": useExtensionsStore.getState().setError(e); break;
        case "extension:progress": useExtensionsStore.getState().applyProgress(e); break;
        case "extension:install:done": useExtensionsStore.getState().completeInstall(e); break;
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
      }
    });
    return () => { off(); offReconnect(); };
  }, []);  // 空依赖：onMessage 用 getState，不需重订阅

  // 派生 view
  useEffect(() => {
    if (projects.length === 0) setView("empty");
    else if (currentSessionId) setView("session");
    else setView("new-session");
  }, [projects.length, currentSessionId]);

  // 点智能体 → 带着预选切到新建会话视图（与 NewSessionButton 的视图切换一致）
  const chatWith = (name: string) => { setPendingAgent(name); setView("new-session"); };

  // ⌘K / Ctrl+K 弹出命令调色板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 监听来自 CommandPalette 和 SlashMenu 的自定义事件
  useEffect(() => {
    const handlers: Record<string, () => void> = {
      "wa-pi:open-gallery": () => setGalleryOpen(true),
      "wa-pi:open-settings": () => useSettingsStore.getState().open(),
      "wa-pi:open-settings-skills": () => { useSettingsStore.getState().open(); useSettingsStore.getState().setSection("skills"); },
      "wa-pi:reload-config": async () => {
        const sid = useProjectsStore.getState().currentSessionId;
        if (!sid) { useToastStore.getState().add("没有打开的会话", "error"); return; }
        const status = useSessionStore.getState().statusBySession[sid];
        if (status === "thinking") { useToastStore.getState().add("请在 AI 回复完成后再重载", "error"); return; }
        const msgs = useSessionStore.getState().messagesBySession[sid] ?? [];
        if (msgs.length === 0) { useToastStore.getState().add("请先发送消息启动会话", "error"); return; }
        const ts = Date.now();
        useSessionStore.getState().setReloading(true);
        // 先显示过渡消息（用固定 timestamp 确保完成后替换而非追加）
        useSessionStore.getState().append(sid, {
          message: { type: "custom", customType: "reload_config", content: "正在重载配置…", timestamp: ts } as any,
        });
        try {
          await api.post(`/api/sessions/${encodeURIComponent(sid)}/reload`);
          // reload 完成后替换过渡消息（同 timestamp → append 去重覆盖）
          useSessionStore.getState().append(sid, {
            message: { type: "custom", customType: "reload_config", content: "配置已重载", timestamp: ts } as any,
          });
          useProvidersStore.getState().load();
          useSkillsStore.getState().load();
          useExtensionsStore.getState().load();
          useAgentsStore.getState().loadAll();
          useSubagentsStore.getState().load();
          useToastStore.getState().add("配置已重载", "success");
        } catch (err: any) {
          useToastStore.getState().add(`重载失败: ${err?.message ?? err}`, "error");
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
      if (!sid) { useToastStore.getState().add("没有打开的会话", "error"); return; }
      const { sessions, currentProjectId } = useProjectsStore.getState();
      const session = sessions.find(s => s.id === sid);
      const pid = session?.projectId ?? currentProjectId ?? "";
      if (!pid) { useToastStore.getState().add("找不到当前项目", "error"); return; }
      const prefs = useComposerPrefsStore.getState().bySession[sid] ?? { model: useComposerPrefsStore.getState().defaults.model, thinking: useComposerPrefsStore.getState().defaults.thinking };
      if (!prefs.model) { useToastStore.getState().add("请先选择模型", "error"); return; }
      // 乐观显示用户消息（与 Composer.doSend 一致），再发 prompt
      useSessionStore.getState().optimisticSend(sid, cmdText, session?.primaryAgent ?? "dev");
      api.post(`/api/agents/${encodeURIComponent(pid)}/${encodeURIComponent(sid)}/prompt`, {
        agentName: session?.primaryAgent ?? "dev",
        text: cmdText,
        model: prefs.model,
        thinking: prefs.thinking,
      }).catch(err => {
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
        onChatWith={chatWith}
        onEdit={(name) => setConfigAgent(name)}
        onMore={() => setGalleryOpen(true)}
        onSelectSession={(id) => { useProjectsStore.getState().selectSession(id); setView("session"); }}
        onNewSessionInProject={(pid) => { useProjectsStore.getState().selectProject(pid); useProjectsStore.getState().setCurrentSessionId(null); setView("new-session"); }}
        onSelectProject={(pid) => { useProjectsStore.getState().selectProject(pid); useProjectsStore.getState().setCurrentSessionId(null); setView("new-session"); }}
        onNewProject={() => { void useProjectsStore.getState().createProjectFromDir(); }}
        currentView={view}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {connState === "reconnecting" && (
          <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs bg-warning-soft text-warning border-b border-warning/20">
            <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: "2px solid var(--warning)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
            连接已断开，正在重连…
          </div>
        )}
        {view === "empty" && <EmptyState onNewProject={() => { void useProjectsStore.getState().createProjectFromDir(); }} />}
        {view === "new-session" && <NewSessionPane pendingAgent={pendingAgent} onConsumePendingAgent={() => setPendingAgent(null)} />}
        {view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} />}
      </main>
      {galleryOpen && (
        <AgentGalleryModal
          onClose={() => setGalleryOpen(false)}
          onChatWith={(name) => { setGalleryOpen(false); chatWith(name); }}
          onEdit={(name) => { setGalleryOpen(false); setConfigAgent(name); }}
          onCreated={(name) => { setGalleryOpen(false); setConfigAgent(name); }}
        />
      )}
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
      {agentMissingSessionId && (
        <AgentMissingModal sessionId={agentMissingSessionId} onClose={() => setAgentMissingSessionId(null)} />
      )}
      {useProjectsStore(s => s.dirPickerOpen) && (
        <DirTreePicker
          onPick={(cwd) => useProjectsStore.getState().createProjectFromPath(cwd)}
          onCancel={() => useProjectsStore.getState().closeDirPicker()}
        />
      )}
      {useSettingsStore(s => s.showSettings) && <SettingsModal onClose={() => useSettingsStore.getState().close()} />}
      {paletteOpen && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
      <ToastContainer />
      <RecordingCapsule />
    </div>
  );
}
