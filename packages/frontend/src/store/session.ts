import { create } from "zustand";
import type { SessionMessage, AgentStatus, AgentName, SDKEventEnvelope } from "@hiagent/shared";
import { useProjectsStore } from "./projects";

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
  // 会话级消息队列：steering 引导队列 + followUp 排队队列
  queueBySession: Record<string, { steering: readonly string[]; followUp: readonly string[] }>;
  // 原有方法保留：append 用于 error 兜底、setMessages 用于 session:messages 历史
  append: (sessionId: string, msg: SessionMessage) => void;
  setMessages: (sessionId: string, messages: SessionMessage[]) => void;
  /** 原地重试用：保留 messages[0, fromIndex)，丢弃 [fromIndex, end)。
   *  重发失败回合前调用——裁掉失败的用户消息及其后所有行，
   *  由随后 SDK 的 message_start(user) 回声重建用户行，避免重发叠加。 */
  truncate: (sessionId: string, fromIndex: number) => void;
  /** 乐观发送：立即追加用户消息 + 占位空 assistant streaming + status=thinking，
   *  让 UI 在 SDK 回声到达前就显示用户消息与 AI loading。置 optimisticEcho 标记，
   *  供 message_start(user) 回声识别并替换占位（同步 timestamp，避免切回会话重复）。 */
  optimisticSend: (sessionId: string, text: string, agentName: AgentName) => void;
  clear: () => void;
  /** 标记会话有未读新回复（后台收到 agent_end 时）。 */
  markUnread: (sessionId: string) => void;
  /** 清除会话未读标记（进入/查看该会话时）。 */
  markRead: (sessionId: string) => void;
  // 新增：处理 sdk:event 信封事件（流式两态管理核心入口）
  handleSDKEvent: (sessionId: string, envelope: SDKEventEnvelope) => void;
}

// 流式标识：同 agent 同时刻同 role 视为同一条流式增量
function msgKey(m: SessionMessage): string {
  const inner = m.message as any;
  return `${inner.role ?? "custom"}-${inner.timestamp}`;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  streamingBySession: {},
  statusBySession: {},
  thinkingSinceBySession: {},
  optimisticEchoBySession: {},
  unreadBySession: {},
  queueBySession: {},

  append: (sessionId, msg) => set(s => {
    const list = s.messagesBySession[sessionId] ?? [];
    const key = msgKey(msg);
    const idx = list.findIndex(m => msgKey(m) === key);
    const newList = idx >= 0 ? list.map((m, i) => i === idx ? msg : m) : [...list, msg];
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: newList } };
  }),

  setMessages: (sessionId, messages) => set(s => {
    const existing = s.messagesBySession[sessionId] ?? [];
    const existingKeys = new Set(existing.map(msgKey));
    const newFromHistory = messages.filter(m => !existingKeys.has(msgKey(m)));
    const all = [...existing, ...newFromHistory].sort((a: any, b: any) => a.message.timestamp - b.message.timestamp);
    // 合并相邻同 agent 的 assistant 消息（SDK 按 block 拆分发送，渲染时需聚合成一条）
    const compacted: SessionMessage[] = [];
    for (const msg of all) {
      const last = compacted[compacted.length - 1];
      const m = msg.message as any;
      if (last && last.agentName === msg.agentName && (last.message as any).role === "assistant" && m.role === "assistant") {
        (last.message as any).content = [...(last.message as any).content, ...(m.content ?? [])];
      } else {
        compacted.push(msg);
      }
    }
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: compacted } };
  }),

  clear: () => set({ messagesBySession: {}, streamingBySession: {}, statusBySession: {}, thinkingSinceBySession: {}, optimisticEchoBySession: {}, unreadBySession: {} }),

  markUnread: (sessionId) => set(s => ({ unreadBySession: { ...s.unreadBySession, [sessionId]: true } })),
  markRead: (sessionId) => set(s => {
    if (!s.unreadBySession[sessionId]) return {};  // 已读则不触发重渲染
    const next = { ...s.unreadBySession };
    delete next[sessionId];
    return { unreadBySession: next };
  }),

  optimisticSend: (sessionId, text, agentName) => set(s => {
    const ts = Date.now();
    const list = s.messagesBySession[sessionId] ?? [];
    return {
      // 立即追加用户消息（agentName 留空：用户消息不属于具体 agent）
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...list, { message: { role: "user", content: text, timestamp: ts }, agentName: undefined }],
      },
      // 占位空 assistant streaming：让 MessageList 渲染 loading 气泡；首字到达后由 message_update 填充
      streamingBySession: {
        ...s.streamingBySession,
        [sessionId]: { message: { role: "assistant", content: [], model: "pending", stopReason: "pending", timestamp: ts }, agentName },
      },
      // 顶部 spinner 立即转（不等 SDK agent_start）
      statusBySession: { ...s.statusBySession, [sessionId]: "thinking" },
      // 计时从这里开始（用户发送即起算）
      thinkingSinceBySession: { ...s.thinkingSinceBySession, [sessionId]: ts },
      optimisticEchoBySession: { ...s.optimisticEchoBySession, [sessionId]: true },
    };
  }),

  truncate: (sessionId, fromIndex) => set(s => {
    const list = s.messagesBySession[sessionId] ?? [];
    if (fromIndex >= list.length) return {};
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: list.slice(0, fromIndex) } };
  }),

  // 处理 sdk:event 信封事件：按 SDKEvent.type 分发到对应状态
  handleSDKEvent: (sessionId, envelope) => {
    const { event, agentName } = envelope;
    switch (event.type) {
      // 用户消息：直接定稿进 messages
      case "message_start": {
        const msg = event.message as any;
        if (msg.role === "user") {
          set(s => {
            const list = s.messagesBySession[sessionId] ?? [];
            const last = list[list.length - 1];
            // 乐观发送已占位（且末尾确为占位用户消息）：用 SDK 权威版本替换，
            // 同步 timestamp 避免切回会话时 setMessages 合并出重复行；并清标记。
            const pending = !!s.optimisticEchoBySession[sessionId] && last && (last.message as any).role === "user";
            const newList = pending
              ? [...list.slice(0, -1), { message: msg, agentName }]
              : [...list, { message: msg, agentName }];
            return pending
              ? {
                  messagesBySession: { ...s.messagesBySession, [sessionId]: newList },
                  optimisticEchoBySession: { ...s.optimisticEchoBySession, [sessionId]: false },
                }
              : { messagesBySession: { ...s.messagesBySession, [sessionId]: newList } };
          });
        } else if (msg.role === "assistant") {
          // assistant 首帧：设为 streaming，等后续 update/end
          set(s => ({
            streamingBySession: { ...s.streamingBySession, [sessionId]: { message: msg, agentName } },
          }));
        }
        break;
      }
      // 流式增量：用 assistantMessageEvent.partial 覆盖 streamingMessage
      case "message_update": {
        const partial = (event as any).assistantMessageEvent?.partial;
        if (partial) {
          set(s => ({
            streamingBySession: { ...s.streamingBySession, [sessionId]: { message: partial, agentName } },
          }));
        }
        break;
      }
      // 流式结束：assistant — 合并到同 turn 的最后一条 assistant 消息
      case "message_end": {
        const msg = event.message as any;
        if (msg.role !== "assistant") break;
        // 失败但无实质内容（空 content / 仅空 text block）：跳过合并，避免渲染「裸头像」行。
        // 该错误的可见表示由 kernel 广播的 {type:"error"} → App.tsx 注入的红色 ⚠️ 横幅承担。
        const hasMeaningfulContent = Array.isArray(msg.content) && msg.content.some((b: any) =>
          (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) ||
          b.type === "thinking" || b.type === "toolCall");
        if (msg.stopReason === "error" && !hasMeaningfulContent) {
          set(s => ({ streamingBySession: { ...s.streamingBySession, [sessionId]: null } }));
          break;
        }
        set(s => {
          const list = [...(s.messagesBySession[sessionId] ?? [])];
          const last = list[list.length - 1];
          // SDK 对同 turn 的每个 block（thinking/text/toolCall）发独立 message_start/end；
          // 检查最后一条是否也是同一 agent 的 assistant，是则合并 content 数组
          if (last && last.agentName === agentName && (last.message as any).role === "assistant") {
            const merged = { ...(last.message as any), content: [...(last.message as any).content, ...(msg.content ?? [])] };
            list[list.length - 1] = { ...last, message: merged };
          } else {
            list.push({ message: msg, agentName });
          }
          return {
            streamingBySession: { ...s.streamingBySession, [sessionId]: null },
            messagesBySession: { ...s.messagesBySession, [sessionId]: list },
          };
        });
        break;
      }
      // agent 开始处理：标记 thinking；记录起算时间（若 optimisticSend 已记则保留，避免覆盖更早的发送时刻）
      case "agent_start":
        set(s => ({
          statusBySession: { ...s.statusBySession, [sessionId]: "thinking" },
          thinkingSinceBySession: { ...s.thinkingSinceBySession, [sessionId]: s.thinkingSinceBySession[sessionId] ?? Date.now() },
        }));
        break;
      // agent 结束：回 idle，清起算时间；若该会话非当前会话（用户在别处），标记未读新回复
      case "agent_end": {
        const away = sessionId !== useProjectsStore.getState().currentSessionId;
        set(s => ({
          statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
          thinkingSinceBySession: { ...s.thinkingSinceBySession, [sessionId]: null },
          unreadBySession: away ? { ...s.unreadBySession, [sessionId]: true } : s.unreadBySession,
        }));
        break;
      }
      // 队列更新：steering / followUp 消息列表
      case "queue_update":
        set(s => ({
          queueBySession: { ...s.queueBySession, [sessionId]: { steering: event.steering, followUp: event.followUp } },
        }));
        break;
      // turn_start/turn_end/tool_execution_* 暂不在 store 处理：渲染层不消费
      default:
        break;
    }
  },
}));
