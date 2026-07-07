import type { SessionMessage, ToolResultMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { ThinkingPanel } from "./blocks/ThinkingPanel";
import { TextBlock } from "./blocks/TextBlock";
import { ToolCallPanel } from "./blocks/ToolCallPanel";
import { DelegateCard } from "./blocks/DelegateCard";
import { DelegateReceived } from "./blocks/DelegateReceived";

const EMPTY: SessionMessage[] = [];

interface Props { sessionId: string; }

interface RenderedRow {
  main: SessionMessage;
  toolResults: Map<string, ToolResultMessage>;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const rows = preprocess(messages);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {rows.map((row, i) => <MessageRow key={i} row={row} sessionId={sessionId} />)}
    </div>
  );
}

function preprocess(messages: SessionMessage[]): RenderedRow[] {
  const rows: RenderedRow[] = [];
  let lastAssistantIdx = -1;
  for (const sm of messages) {
    const m = sm.message as any;
    if (m.role === "toolResult") {
      if (lastAssistantIdx >= 0) rows[lastAssistantIdx].toolResults.set(m.toolCallId, m as ToolResultMessage);
    } else {
      rows.push({ main: sm, toolResults: new Map() });
      lastAssistantIdx = m.role === "assistant" ? rows.length - 1 : -1;
    }
  }
  return rows;
}

function MessageRow({ row, sessionId }: { row: RenderedRow; sessionId: string }) {
  const m = row.main.message as any;
  const isUser = m.role === "user";
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`} data-testid={`msg-${sessionId}-${m.timestamp}`}>
      <Avatar isUser={isUser} />
      <div className="max-w-[70%]">
        {!isUser && <div className="text-xs text-overlay mb-0.5">{row.main.agentName ?? "agent"}</div>}
        <div className="px-3 py-2 rounded-lg" style={{ background: isUser ? "#313244" : "#181825", color: "#cdd6f4", borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px" }}>
          {renderContent(m, row.toolResults)}
        </div>
      </div>
    </div>
  );
}

function renderContent(m: any, toolResults: Map<string, ToolResultMessage>) {
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "");
    return <TextBlock text={text} />;
  }
  if (m.role === "assistant") {
    return (m.content as any[]).map((block, i) => {
      switch (block.type) {
        case "thinking": return <ThinkingPanel key={i} thinking={block.thinking} />;
        case "text": return <TextBlock key={i} text={block.text} />;
        case "toolCall":
          if (block.name === "intercom") return <DelegateCard key={i} toolCall={block} result={toolResults.get(block.id)} />;
          return <ToolCallPanel key={i} toolCall={block} result={toolResults.get(block.id)} />;
        default: return null;
      }
    });
  }
  if (m.type === "custom_message" && m.customType === "intercom_message") {
    return <DelegateReceived details={m.details} />;
  }
  return null;
}

function Avatar({ isUser }: { isUser: boolean }) {
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style={{ background: isUser ? "linear-gradient(135deg,#6c7086,#9399b2)" : "linear-gradient(135deg,#89b4fa,#b4befe)" }}>
      {isUser ? "我" : "🤖"}
    </div>
  );
}
