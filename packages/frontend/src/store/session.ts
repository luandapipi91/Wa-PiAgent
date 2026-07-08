import { create } from "zustand";
import type { SessionMessage, AgentStatus, SDKEventEnvelope } from "@hiagent/shared";

interface SessionState {
  // 已定稿消息：渲染主列表来源
  messagesBySession: Record<string, SessionMessage[]>;
  // 流式中的 assistant 消息：未到 message_end 前的临时占位
  streamingBySession: Record<string, SessionMessage | null>;
  // 会话级 agent 状态：thinking=处理中，idle=空闲，blocked=等待用户
  statusBySession: Record<string, AgentStatus>;
  // 原有方法保留：append 用于 error 兜底、setMessages 用于 session:messages 历史
  append: (sessionId: string, msg: SessionMessage) => void;
  setMessages: (sessionId: string, messages: SessionMessage[]) => void;
  clear: () => void;
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
    const merged = [...existing, ...newFromHistory];
    // 按时间戳排序：首条消息场景下 assistant 流式消息可能先于 session:messages 到达，
    // 导致 setMessages 追进来的 user 消息被排到 assistant 之后
    merged.sort((a, b) => (a.message as any).timestamp - (b.message as any).timestamp);
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: merged } };
  }),

  clear: () => set({ messagesBySession: {}, streamingBySession: {}, statusBySession: {} }),

  // 处理 sdk:event 信封事件：按 SDKEvent.type 分发到对应状态
  handleSDKEvent: (sessionId, envelope) => {
    const { event, agentName } = envelope;
    switch (event.type) {
      // 用户消息：直接定稿进 messages
      case "message_start": {
        const msg = event.message as any;
        if (msg.role === "user") {
          set(s => ({
            messagesBySession: {
              ...s.messagesBySession,
              [sessionId]: [...(s.messagesBySession[sessionId] ?? []), { message: msg, agentName }],
            },
          }));
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
      // 流式结束：assistant 的 streaming 移到 messages 并清空占位
      // user 的 message_end 忽略——user 消息在 message_start 时已加入 messages
      case "message_end": {
        const msg = event.message as any;
        if (msg.role !== "assistant") break;
        set(s => ({
          streamingBySession: { ...s.streamingBySession, [sessionId]: null },
          messagesBySession: {
            ...s.messagesBySession,
            [sessionId]: [...(s.messagesBySession[sessionId] ?? []), { message: msg, agentName }],
          },
        }));
        break;
      }
      // agent 开始处理：标记 thinking
      case "agent_start":
        set(s => ({ statusBySession: { ...s.statusBySession, [sessionId]: "thinking" } }));
        break;
      // agent 结束：回 idle
      case "agent_end":
        set(s => ({ statusBySession: { ...s.statusBySession, [sessionId]: "idle" } }));
        break;
      // turn_start/turn_end/tool_execution_* 暂不在 store 处理：渲染层不消费
      default:
        break;
    }
  },
}));
