import type { SessionMessage, ToolResultMessage, ToolCall } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const EMPTY: SessionMessage[] = [];

interface Props { sessionId: string; }

interface RenderedRow {
  main: SessionMessage;
  toolResults: Map<string, ToolResultMessage>;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const streaming = useSessionStore(s => s.streamingBySession[sessionId] ?? null);
  const rows = preprocess(messages);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {rows.map((row, i) => <MessageRow key={i} row={row} sessionId={sessionId} />)}
      {streaming && (
        <MessageRow row={{ main: streaming, toolResults: new Map() }} sessionId={sessionId} />
      )}
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

  if (isUser) {
    return (
      <div className="flex flex-row-reverse gap-2.5" data-testid={`msg-${sessionId}-${m.timestamp}`}>
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style={{ background: "linear-gradient(135deg,#6c7086,#9399b2)" }}>
          我
        </div>
        <div className="max-w-[70%] px-3 py-2 rounded-lg text-sm" style={{ background: "#313244", color: "#cdd6f4", borderRadius: "4px 12px 12px 12px" }}>
          <p>{typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "")}</p>
        </div>
      </div>
    );
  }

  // 分离 assistant 消息的三种 block 类型
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  const thinkingBlocks = blocks.filter((b: any) => b.type === "thinking");
  const textBlocks = blocks.filter((b: any) => b.type === "text");
  const toolCallBlocks = blocks.filter((b: any) => b.type === "toolCall");

  return (
    <div className="flex gap-2.5" data-testid={`msg-${sessionId}-${m.timestamp}`}>
      <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0" style={{ background: "linear-gradient(135deg,#89b4fa,#b4befe)" }}>
        🤖
      </div>
      <div className="max-w-[85%] min-w-0">
        <div className="text-xs text-overlay mb-0.5">{row.main.agentName ?? "agent"}</div>

        {/* 思考过程 — 折叠面板（上方） */}
        {thinkingBlocks.length > 0 && (
          <div className="space-y-1 mb-2">
            {thinkingBlocks.map((block: any, i: number) => (
              <ThinkingBlock key={i} thinking={block.thinking} />
            ))}
          </div>
        )}

        {/* 工具调用 — 折叠面板（中间） */}
        {toolCallBlocks.length > 0 && (
          <div className="space-y-1 mb-2">
            {toolCallBlocks.map((block: any, i: number) => (
              <ToolCallBlock key={i} toolCall={block} result={row.toolResults.get(block.id)} />
            ))}
          </div>
        )}

        {/* 主回复内容 — 文字 + markdown（最下方） */}
        <div className="text-sm" style={{ color: "#cdd6f4" }}>
          {textBlocks.map((block: any, i: number) => (
            <div key={i} className="prose prose-invert max-w-none prose-sm" data-testid="text-block">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="thinking-panel">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs flex items-center gap-1 select-none"
        style={{ color: "#6c7086", cursor: "pointer" }}
      >
        <span>💭 思考过程 已完成</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 text-xs italic" style={{ color: "#6c7086", borderColor: "#45475a" }}>
          {thinking}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall, result }: { toolCall: ToolCall; result?: ToolResultMessage }) {
  const [open, setOpen] = useState(false);
  const success = result && !result.isError;
  return (
    <div data-testid={`toolcall-${toolCall.id}`}>
      <button
        onClick={() => setOpen(!open)}
        className="text-xs flex items-center gap-1 select-none font-mono"
        style={{ color: success ? "#a6e3a1" : "#6c7086", cursor: "pointer" }}
      >
        {success ? <span style={{ color: "#a6e3a1" }}>✓</span> : <span>🔧</span>}
        <span style={{ color: "#cdd6f4" }}>{toolCall.name}</span>
        <span style={{ color: "#6c7086" }}>({formatArgs(toolCall.arguments)})</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        result ? (
          <div className="mt-1 pl-3 border-l-2 text-xs font-mono" style={{ color: "#a6adc8", borderColor: "#45475a", whiteSpace: "pre-wrap" }}>
            {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
          </div>
        ) : (
          <div className="mt-1 pl-3 border-l-2 text-xs italic" style={{ color: "#6c7086", borderColor: "#45475a" }}>
            等待执行...
          </div>
        )
      )}
    </div>
  );
}

/** 格式化工具调用参数 — 截断长值避免撑爆 UI */
function formatArgs(args: Record<string, any>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const parts = keys.map(k => {
    const v = args[k];
    if (typeof v === "string") {
      return v.length > 60 ? `${k}: "${v.slice(0, 50)}..."` : `${k}: "${v}"`;
    }
    // 对象/数组：序列化后截断
    const s = JSON.stringify(v);
    return s.length > 80 ? `${k}: ${s.slice(0, 77)}...` : `${k}: ${s}`;
  });
  return parts.join(", ");
}
