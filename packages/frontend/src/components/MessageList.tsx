import type { ChatMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";

// 稳定的空数组引用：避免 session 不存在时 `?? []` 每次返回新引用，
// 触发 React 19 useSyncExternalStore 的「snapshot 不稳定」infinite loop。
const EMPTY: ChatMessage[] = [];

interface Props {
  sessionId: string;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className="flex gap-2" data-testid={`msg-${msg.id}`}>
      <div
        className="max-w-[70%] px-3 py-2"
        style={{
          background: isUser ? "#313244" : "#181825",
          borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
          color: "#cdd6f4",
        }}
      >
        <div className="text-xs text-overlay mb-0.5">{isUser ? "你" : "agent"}</div>
        <div className="text-sm whitespace-pre-wrap">{msg.text}</div>
      </div>
    </div>
  );
}
