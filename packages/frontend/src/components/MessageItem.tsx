import type { ChatMessage } from "hiagent-shared";

export function MessageItem({ msg, agentAvatar, agentName, agentKey }: { msg: ChatMessage; agentAvatar: string; agentName: string; agentKey: string }) {
  const isUser = msg.role === "user";
  return (
    <div className="flex gap-2.5 items-start">
      <div className={"w-7 h-7 rounded-full flex items-center justify-center text-[12px] flex-shrink-0 " + (isUser ? "bg-surface2 text-text" : "")}
           style={!isUser ? { background: `linear-gradient(135deg, #fab387, #f38ba8)`, width: 28, height: 28 } : {}}>
        {isUser ? "你" : agentAvatar}
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-[10px_14px] text-[12px] leading-relaxed text-text"
             style={{ background: isUser ? "#313244" : "#181825",
                      borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px" }}>
          <p className="whitespace-pre-wrap">{msg.text}</p>
        </div>
        <div className="text-[9px] text-overlay mt-[3px]">{isUser ? "你" : agentName} · {new Date(msg.timestamp).toLocaleTimeString().slice(0,5)}</div>
      </div>
    </div>
  );
}
