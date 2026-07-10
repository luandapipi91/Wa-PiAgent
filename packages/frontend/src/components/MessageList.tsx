import type { SessionMessage, ToolResultMessage, ToolCall } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const EMPTY: SessionMessage[] = [];

// 自动滚动：用户手动滚动离开后，空闲超过此时间恢复自动滚动（ms）
const SCROLL_IDLE_TIMEOUT = 3000;
// 距离底部多少像素内视为“已在底部”
const BOTTOM_THRESHOLD = 20;

interface Props { sessionId: string; }

interface RenderedRow {
  main: SessionMessage;
  toolResults: Map<string, ToolResultMessage>;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const streaming = useSessionStore(s => s.streamingBySession[sessionId] ?? null);
  const rows = preprocess(messages);

  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (isNearBottom()) {
      setUserScrolled(false);
    } else {
      setUserScrolled(true);
      idleTimerRef.current = setTimeout(() => {
        setUserScrolled(false);
      }, SCROLL_IDLE_TIMEOUT);
    }
  }, [isNearBottom]);

  // 消息或流式内容变化时，若用户未主动滚动离开底部，则自动滚到底
  useEffect(() => {
    if (!userScrolled) {
      scrollToBottom();
    }
  }, [messages, streaming, userScrolled, scrollToBottom]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-auto p-4 flex flex-col gap-4" data-testid="message-list">
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

function stripAttachmentRefs(content: string): string {
  return content.replace(/\n\nAttachments:\n\[[\s\S]*?\]$/g, "");
}

function formatTime(timestamp: number): string {
  const now = new Date();
  const d = new Date(timestamp);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const isYesterday = (a: Date, b: Date) => {
    const yesterday = new Date(b);
    yesterday.setDate(yesterday.getDate() - 1);
    return isSameDay(a, yesterday);
  };

  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  if (isSameDay(d, now)) return time;
  if (isYesterday(d, now)) return `昨天 ${time}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${time}`;
}

function MessageRow({ row, sessionId }: { row: RenderedRow; sessionId: string }) {
  const m = row.main.message as any;
  const isUser = m.role === "user";

  if (isUser) {
    const displayText = stripAttachmentRefs(
      typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "")
    );
    return (
      <div className="flex flex-row-reverse gap-2.5 max-w-[78%] ml-auto" data-testid={`msg-${sessionId}-${m.timestamp}`}>
        <div className="w-[30px] h-[30px] rounded-sm flex items-center justify-center text-[11.5px] flex-shrink-0 text-secondary">
          我
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[11px] text-tertiary mb-0.5 font-semibold">我 · {formatTime(m.timestamp)}</div>
          <div className="px-3.5 py-2.5 text-[13.5px] bg-surface text-primary border border-hairline" style={{ borderRadius: "14px 4px 14px 14px", lineHeight: 1.55 }}>
            <p>{displayText}</p>
          </div>
        </div>
      </div>
    );
  }

  // 分离 assistant 消息的三种 block 类型（过滤掉空 text block）
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  const thinkingBlocks = blocks.filter((b: any) => b.type === "thinking");
  const textBlocks = blocks.filter((b: any) => b.type === "text" && b.text?.trim());
  const toolCallBlocks = blocks.filter((b: any) => b.type === "toolCall");

  // 错误消息（stopReason === "error"）：红色文字
  const isError = m.stopReason === "error";

  return (
    <div className="flex gap-2.5" data-testid={`msg-${sessionId}-${m.timestamp}`}>
      <div className="w-[30px] h-[30px] rounded-sm flex items-center justify-center text-sm flex-shrink-0">
        🤖
      </div>
      <div className="max-w-[78%] min-w-0">
        <div className="text-[11px] text-tertiary mb-0.5 font-semibold">{row.main.agentName ?? "agent"} · {formatTime(m.timestamp)}</div>

        {/* 思考过程 — 折叠面板（上方） */}
        {thinkingBlocks.length > 0 && (
          <div className="space-y-1 mb-1.5">
            {thinkingBlocks.map((block: any, i: number) => (
              <ThinkingBlock key={i} thinking={block.thinking} />
            ))}
          </div>
        )}

        {/* 工具调用 — 折叠面板（中间） */}
        {toolCallBlocks.length > 0 && (
          <div className="space-y-1 mb-1.5">
            {toolCallBlocks.map((block: any, i: number) => (
              <ToolCallBlock key={i} toolCall={block} result={row.toolResults.get(block.id)} />
            ))}
          </div>
        )}

        {/* 主回复内容 — 文字 + markdown（最下方） */}
        {textBlocks.length > 0 && (
          <div className={`text-[13.5px] px-3.5 py-2.5 bg-surface border border-hairline shadow-sm ${isError ? "text-danger" : "text-primary"}`} style={{ lineHeight: 3.1, borderRadius: "4px 14px 14px 14px" }}>
            {textBlocks.map((block: any, i: number) => (
              <div key={i} className="prose prose-sm max-w-none" data-testid="text-block">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
              </div>
            ))}
          </div>
        )}
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
        className="inline-flex items-center gap-1.5 select-none text-[11.5px] text-tertiary px-2 py-0.5 rounded-pill bg-surface-elevated border border-hairline transition-colors hover:text-secondary"
        style={{ cursor: "pointer" }}
      >
        <span>💭 思考过程 已完成</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-hairline text-[11.5px] italic text-tertiary">
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
        className={`inline-flex items-center gap-1 select-none text-[11.5px] font-mono px-2 py-0.5 rounded-pill border transition-colors ${success ? "bg-success-soft text-success border-success-soft" : "bg-surface-elevated text-tertiary border-hairline hover:text-secondary"}`}
        style={{ cursor: "pointer" }}
      >
        {success ? <span>✓</span> : <span>🔧</span>}
        <span className={success ? "text-success" : "text-primary"}>{toolCall.name}</span>
        <span className="text-tertiary">({formatArgs(toolCall.arguments)})</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-hairline text-[11.5px] font-mono">
          {/* 原始参数内容 */}
          <div className="text-secondary whitespace-pre-wrap">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </div>
          {/* 执行结果（如有） */}
          {result && (
            <div className={`mt-1 pt-1 border-t border-hairline ${success ? "text-success" : "text-danger"}`}>
              {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
            </div>
          )}
        </div>
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
