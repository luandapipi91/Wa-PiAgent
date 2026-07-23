import type { SessionMessage, ToolResultMessage, ToolCall, PromptEvent, AgentName, ThinkingLevel } from "@hiagent/shared";
import { isModelAvailable } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { send } from "../ws-instance";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToastStore } from "../store/toast";
import { useAgentsStore } from "../store/agents";
import { DelegateCard } from "./blocks/DelegateCard";
import { textToHtml, ensureChipStyles, registerAgentMeta } from "../quick-invoke/tokens";

const EMPTY: SessionMessage[] = [];

// 自动滚动：距离底部多少像素内视为“已在底部”
const BOTTOM_THRESHOLD = 20;

interface Props { sessionId: string; }

interface RenderedRow {
  main: SessionMessage;
  toolResults: Map<string, ToolResultMessage>;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  const streaming = useSessionStore(s => s.streamingBySession[sessionId] ?? null);
  const historyLoading = useSessionStore(s => s.historyLoadingBySession[sessionId] ?? false);
  const rows = preprocess(messages);
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const agents = useAgentsStore(s => s.list);

  // 确保 chip 样式注入（幂等，只在首次注入；document 可能为 undefined 时跳过）
  ensureChipStyles();
  // 同步注册所有智能体头像信息供 chip 渲染查找（render 阶段执行，确保 textToHtml 调用时 meta 已就绪）。
  // registerAgentMeta 是幂等 Map.set，每次 render 重写无副作用。
  for (const a of agents) {
    registerAgentMeta(a.displayName, { avatar: a.avatar, avatarColor: a.avatarColor });
  }

  // 历史加载中且尚无消息（且未在流式）：显示居中 loading，避免切换会话时对话区空白
  const showHistoryLoading = historyLoading && messages.length === 0 && !streaming;

  // 「重新发送」：仅当最后一条是失败的 assistant 回合（且当前无新回合在流式）时，
  // 在它前一条用户消息下方显示按钮；重发或发新消息后按钮自动消失。
  let resendUserIdx = -1;
  const lastMsg = rows[rows.length - 1]?.main.message as any;
  if (!streaming && lastMsg?.role === "assistant" && lastMsg?.stopReason === "error") {
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((rows[i].main.message as any).role === "user") { resendUserIdx = i; break; }
    }
  }
  const handleResend = useCallback((text: string, index: number) => {
    // 过期模型（provider 已删、prefs 残留）直接放弃重发：不裁剪、不发送，
    // 否则消息被裁掉后后端才报模型解析失败，用户丢了原消息。
    const prefs = useComposerPrefsStore.getState().bySession[sessionId];
    if (!isModelAvailable(prefs?.model, useProvidersStore.getState().providers)) return;
    // 原地重试：先裁掉该用户消息及之后所有行（失败的 assistant/错误），
    // 再乐观重建用户消息 + loading（与首次发送一致，不等 SDK 回声），最后发 prompt。
    // SDK 的 message_start(user) 回声会替换乐观占位（同步 timestamp），避免叠加。
    useSessionStore.getState().truncate(sessionId, index);
    const payload = buildResendPrompt({
      session, sessionId, text,
      model: prefs?.model,
      thinking: prefs?.thinking ?? "disabled",
    });
    if (payload && session) {
      useSessionStore.getState().optimisticSend(sessionId, text, session.primaryAgent);
      send(payload);
    }
  }, [session, sessionId]);

  const containerRef = useRef<HTMLDivElement>(null);
  // stickBottom：用户是否「停在底部」。用户向上翻阅即置 false——此时即便 AI 在回复，
  // 也不抢滚动（不阻碍用户阅读历史）；用户回到底部或点浮动按钮再置 true。
  const [stickBottom, setStickBottom] = useState(true);
  // 记录已为其执行过「进入即滚到底」的会话，避免同会话内重复滚动。
  const didInitScrollRef = useRef<string | null>(null);

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
    setStickBottom(isNearBottom());
  }, [isNearBottom]);

  // 仅在 AI 回复（streaming）且用户停在底部时跟随滚动到底部。
  // 平时（非回复）不自动滚动——避免抢走用户正在阅读历史时的位置。
  useEffect(() => {
    if (streaming && stickBottom) scrollToBottom();
  }, [streaming, stickBottom, scrollToBottom]);

  // 切换会话：重置停留状态为新会话「在底部」。
  useEffect(() => {
    setStickBottom(true);
  }, [sessionId]);

  // 进入会话（含切换）：消息加载后一次性滚到底显示最新回复；同会话后续消息变化不再自动滚。
  // 这不属于「平时抢滚动」——仅在每个会话首次进入时触发一次。
  useEffect(() => {
    if (sessionId && messages.length > 0 && didInitScrollRef.current !== sessionId) {
      didInitScrollRef.current = sessionId;
      scrollToBottom();
    }
  }, [sessionId, messages, scrollToBottom]);

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
    setStickBottom(true);
  }, [scrollToBottom]);

  // 同回合多 block 合并：SDK 对一个 turn 的每个 block（thinking/text/toolCall）发独立
  // message_start/end，store 在每个 block 的 message_end 即定稿进 messages 并清空 streaming。
  // 于是「block N 已定稿 + block N+1 流式中」会同时渲染两条 assistant 行 → 两个机器人头像。
  // 这里把同 agent 的流式增量并入最后一条已定稿 assistant 行，让整个回合始终是一个头像/一行。
  const lastRow = rows[rows.length - 1];
  const mergeStreamingIntoLast = !!streaming
    && !!lastRow
    && (lastRow.main.message as any).role === "assistant"
    && lastRow.main.agentName === streaming.agentName;

  let displayRows = rows;
  if (mergeStreamingIntoLast) {
    const lastMain = lastRow.main.message as any;
    const streamingMain = streaming!.message as any;
    const merged: RenderedRow = {
      main: {
        agentName: lastRow.main.agentName,
        message: {
          ...lastMain,
          content: [...(lastMain.content ?? []), ...(streamingMain.content ?? [])],
        },
      },
      toolResults: lastRow.toolResults,
    };
    displayRows = [...rows.slice(0, -1), merged];
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div ref={containerRef} onScroll={handleScroll} className="absolute inset-0 overflow-auto p-4 flex flex-col gap-4" data-testid="message-list">
        {displayRows.map((row, i) => {
          // 合并后的末行正处于流式中，不挂「重新发送」（流式中本就不显示）
          const isMergedStreamingRow = mergeStreamingIntoLast && i === displayRows.length - 1;
          const showResend = !isMergedStreamingRow && i === resendUserIdx;
          return (
            <MessageRow key={i} row={row} sessionId={sessionId} showResend={showResend} onResend={showResend ? (text: string) => handleResend(text, i) : undefined} isStreaming={isMergedStreamingRow} />
          );
        })}
        {streaming && !mergeStreamingIntoLast && (
          <StreamingRow streaming={streaming} sessionId={sessionId} />
        )}
      </div>
      {showHistoryLoading && (
        <div className="absolute inset-0 flex items-center justify-center" data-testid={`history-loading-${sessionId}`}>
          <div className="inline-flex items-center gap-2 text-tertiary text-[13px]">
            <span className="inline-block w-4 h-4 rounded-full" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
            加载会话…
          </div>
        </div>
      )}
      {/* 平时（非回复或用户翻阅历史）不在底部时，显示浮动「滚动到底部」按钮 */}
      {!stickBottom && (
        <button
          type="button"
          onClick={handleScrollToBottom}
          data-testid={`scroll-bottom-${sessionId}`}
          aria-label="滚动到底部"
          title="滚动到底部"
          className="absolute bottom-3 right-4 z-10 w-9 h-9 rounded-full bg-surface border border-hairline shadow-md flex items-center justify-center text-secondary hover:text-primary transition-colors"
        >
          ↓
        </button>
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
  return collapseSameTurnAssistants(rows);
}

/**
 * 同一 agent 回合内连续的 assistant 行合并成一行（一个头像）。
 * 一个 agent 回合可能被 SDK/历史拆成多条 assistant 消息（工具调用：text+toolCall → toolResult → text），
 * 只要中间没有用户消息（没有换回合），就属于同一回合，应聚合成一条：拼接 content、合并 toolResults。
 * 用户消息天然作为回合边界（role !== assistant 即隔断），不同 agent 也不合并。
 */
function collapseSameTurnAssistants(rows: RenderedRow[]): RenderedRow[] {
  const out: RenderedRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const prevMsg = prev?.main.message as any;
    const curMsg = row.main.message as any;
    const sameTurn = !!prev
      && prevMsg.role === "assistant"
      && curMsg.role === "assistant"
      && prev.main.agentName === row.main.agentName;
    if (sameTurn) {
      prev.main = {
        agentName: prev.main.agentName,
        message: { ...prevMsg, content: [...(prevMsg.content ?? []), ...(curMsg.content ?? [])] },
      };
      for (const [k, v] of row.toolResults) prev.toolResults.set(k, v);
    } else {
      out.push({ main: row.main, toolResults: new Map(row.toolResults) });
    }
  }
  return out;
}

function stripAttachmentRefs(content: string): string {
  return content.replace(/\n\nAttachments:\n\[[\s\S]*?\]$/g, "");
}

/**
 * 把 SDK 展开后的 <skill name="...">完整内容</skill> XML 块替换为简洁的技能名显示。
 * SDK 的 _expandSkillCommand 会把 /skill:name 展开为完整 SKILL.md 内容注入消息，
 * 前端用户气泡只需展示技能名，不展示技能正文。
 */
function formatSkillBlocks(content: string): string {
  return content.replace(
    /<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g,
    (_m, name) => `⚡ ${name}`,
  );
}

/**
 * 构造「重新发送」的 agent:prompt 负载。
 * 用当前选择的模型重发；缺会话/模型/文本时返回 null（调用方不发）。
 * 纯函数，便于单测（不触网）。
 */
export function buildResendPrompt(args: {
  session: { projectId: string; primaryAgent: AgentName } | undefined;
  sessionId: string;
  text: string;
  model: string | null | undefined;
  thinking: ThinkingLevel;
}): PromptEvent | null {
  if (!args.session || !args.model || !args.text.trim()) return null;
  return {
    type: "agent:prompt",
    projectId: args.session.projectId,
    sessionId: args.sessionId,
    agentName: args.session.primaryAgent,
    text: args.text,
    model: args.model,
    thinking: args.thinking,
  };
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

/** 流式行：首字到达前（content 为空）渲染 loading 气泡；有内容后交给 MessageRow。 */
function StreamingRow({ streaming, sessionId }: { streaming: SessionMessage; sessionId: string }) {
  const m = streaming.message as any;
  const hasContent = Array.isArray(m.content) && m.content.some((b: any) =>
    (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) ||
    b.type === "thinking" || b.type === "toolCall");
  if (hasContent) return <MessageRow row={{ main: streaming, toolResults: new Map() }} sessionId={sessionId} isStreaming />;
  return (
    <div className="flex gap-2.5" data-testid={`loading-${sessionId}`}>
      <div className="w-[30px] h-[30px] rounded-sm flex items-center justify-center text-sm flex-shrink-0">🤖</div>
      <div className="max-w-[78%]">
        <div className="text-[11px] text-tertiary mb-0.5 font-semibold">{streaming.agentName ?? "agent"} · {formatTime(m.timestamp)}</div>
        <div className="inline-flex items-center gap-2 px-3.5 py-2.5 bg-surface border border-hairline" style={{ borderRadius: "4px 14px 14px 14px" }}>
          <span className="inline-block w-3 h-3 rounded-full" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
          <span className="text-[12.5px] text-tertiary">正在思考…</span>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ row, sessionId, showResend, onResend, isStreaming }: { row: RenderedRow; sessionId: string; showResend?: boolean; onResend?: (text: string) => void; isStreaming?: boolean }) {
  const m = row.main.message as any;

  // custom 消息（如 agent_switch 分隔行 / pi-subagents 完成通知）：
  // 兼容两种字段——前端构造用 type:"custom"，Pi SDK 内存消息用 role:"custom"。
  if (m.type === "custom" || m.type === "custom_message" || m.role === "custom") {
    // subagent-notification 是 pi-subagents 在子智能体完成后发的提醒通知，
    // 内容是 task-notification XML，与 delegate toolResult 信息重复（DelegateCard 已展示），过滤。
    if (m.customType === "subagent-notification") return null;
    if (!m.content) return null;
    return (
      <div className="text-center text-[11.5px] text-tertiary" data-testid={`custom-${sessionId}-${m.timestamp}`}>
        {`—— ${m.content} ——`}
      </div>
    );
  }

  const isUser = m.role === "user";

  if (isUser) {
    const displayText = formatSkillBlocks(stripAttachmentRefs(
      typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "")
    ));
    // textToHtml 把 @[agent]/#[file]/$[skill] token 渲染为 chip。
    // hideTrigger=true：展示场景不显示 @ 触发符（仅显示智能体名 + 头像），与输入框 ComposerTextarea 区分。
    const displayHtml = textToHtml(displayText, { hideTrigger: true });
    return (
      <div className="flex flex-row-reverse gap-2.5 max-w-[78%] ml-auto" data-testid={`msg-${sessionId}-${m.timestamp}`}>
        <div className="w-[30px] h-[30px] rounded-sm flex items-center justify-center text-[11.5px] flex-shrink-0 text-secondary">
          我
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[11px] text-tertiary mb-0.5 font-semibold">我 · {formatTime(m.timestamp)}</div>
          <div className="px-3.5 py-2.5 text-[13.5px] bg-surface text-primary border border-hairline" style={{ borderRadius: "14px 4px 14px 14px", lineHeight: 1.55 }}>
            <p dangerouslySetInnerHTML={{ __html: displayHtml }} />
          </div>
          {showResend && (
            <button
              type="button"
              data-testid={`resend-${sessionId}-${m.timestamp}`}
              onClick={() => onResend?.(displayText)}
              className="mt-1 self-end text-[12px] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5 transition-colors"
            >
              ↻ 重新发送
            </button>
          )}
        </div>
      </div>
    );
  }

  // 按 content 原始顺序切成渲染段：连续 thinking/text/toolCall 各自合并；
  // delegate 调用不进工具分组，原位内联渲染 DelegateCard（委派过程直接可见）
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  const segments = segmentBlocks(blocks);
  const fullText = segments.flatMap(s => s.kind === "text" ? s.texts : []).join("\n\n");
  let lastTextSegIdx = -1;
  segments.forEach((s, i) => { if (s.kind === "text") lastTextSegIdx = i; });

  // 错误消息（stopReason === "error"）：红色文字
  const isError = m.stopReason === "error";

  return (
    <div className="flex gap-2.5" data-testid={`msg-${sessionId}-${m.timestamp}`}>
      <div className="w-[30px] h-[30px] rounded-sm flex items-center justify-center text-sm flex-shrink-0">
        🤖
      </div>
      <div className="max-w-[78%] min-w-0">
        <div className="text-[11px] text-tertiary mb-0.5 font-semibold">{row.main.agentName ?? "agent"} · {formatTime(m.timestamp)}</div>

        {segments.map((seg, si) => {
          // 思考过程 — 折叠面板。多个相邻 thinking block 合并为一个
          if (seg.kind === "thinking") {
            return (
              <div key={si} className="space-y-1 mb-1.5">
                <ThinkingBlock thinking={seg.texts.join("\n")} isStreaming={isStreaming} />
              </div>
            );
          }
          // 工具调用 — 折叠面板。相邻的合并为一个分组，点击展开后各工具可再独立展开
          if (seg.kind === "toolCalls") {
            return (
              <div key={si} className="mb-1.5">
                <ToolCallGroup toolCalls={seg.calls} results={row.toolResults} isStreaming={isStreaming} />
              </div>
            );
          }
          // 委派调用 — 内联卡片（不进折叠分组，与普通内容穿插）
          if (seg.kind === "delegate") {
            return <DelegateCard key={seg.call.id} toolCall={seg.call} result={row.toolResults.get(seg.call.id)} />;
          }
          // 主回复内容 — 文字 + markdown
          return (
            <div key={si} className="flex flex-col gap-1" data-testid="text-bubble">
              <div className={`text-[13.5px] px-3.5 py-2.5 bg-surface border border-hairline shadow-sm ${isError ? "text-danger" : "text-primary"}`} style={{ lineHeight: 3.1, borderRadius: "4px 14px 14px 14px" }}>
                {seg.texts.map((text, i) => (
                  <div key={i} className="prose prose-sm max-w-none" data-testid="text-block">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                ))}
              </div>
              {si === lastTextSegIdx && (
                <div className="flex justify-end">
                  <CopyButton text={fullText} testId={`copy-${sessionId}-${m.timestamp}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Segment =
  | { kind: "thinking"; texts: string[] }
  | { kind: "text"; texts: string[] }
  | { kind: "toolCalls"; calls: any[] }
  | { kind: "delegate"; call: any };

/**
 * 把 assistant content 切成渲染段。
 *
 * 规则：以 delegate toolCall 为切割锚点——每遇到一个 delegate 就结束当前片段，
 * delegate 自身成独立段（每个委派一个气泡），并在该处切断 text 流；
 * 其余 thinking/text/普通 toolCall 在每个片段内按 type 聚类合并成一个段
 * （text 跨普通工具调用合并成一个气泡，恢复 df8e6d6 之前的行为）。
 *
 * 例：text₁ → toolCall → text₂ → delegate → text₃ → toolCall → text₄
 *   → [text:text₁+text₂][toolCalls][delegate][text:text₃+text₄][toolCalls]
 * （片段内同类合并后按出现顺序排列，同类型在同一片段内只会产出一个段）
 */
function segmentBlocks(blocks: any[]): Segment[] {
  const segs: Segment[] = [];
  // 当前片段内的累积器：同类 block 聚到一起；遇 delegate 则 flush 后插入 delegate 段
  const flushText = () => { if (buf.text.length) segs.push({ kind: "text", texts: buf.text.splice(0) }); };
  const flushThinking = () => { if (buf.thinking.length) segs.push({ kind: "thinking", texts: buf.thinking.splice(0) }); };
  const flushToolCalls = () => { if (buf.toolCalls.length) segs.push({ kind: "toolCalls", calls: buf.toolCalls.splice(0) }); };
  const flushAll = () => { flushThinking(); flushToolCalls(); flushText(); };
  const buf = { thinking: [] as string[], text: [] as string[], toolCalls: [] as any[] };

  for (const b of blocks) {
    if (b.type === "thinking") {
      buf.thinking.push(b.thinking);
    } else if (b.type === "text") {
      if (!b.text?.trim()) continue;
      buf.text.push(b.text);
    } else if (b.type === "toolCall") {
      if (b.name === "delegate") {
        // delegate 是切割锚点：先 flush 当前片段，再插入独立的 delegate 段
        flushAll();
        segs.push({ kind: "delegate", call: b });
      } else {
        buf.toolCalls.push(b);
      }
    }
  }
  flushAll();
  return segs;
}

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = isStreaming ? "努力思考中…" : "💭 思考过程 已完成";
  return (
    <div data-testid="thinking-panel">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 select-none text-[11.5px] text-tertiary px-2 py-0.5 rounded-pill bg-surface-elevated border border-hairline transition-colors hover:text-secondary"
        style={{ cursor: "pointer" }}
      >
        {isStreaming && (
          <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
        )}
        <span>{label}</span>
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

function CopyButton({ text, testId }: { text: string; testId?: string }) {
  const addToast = useToastStore(s => s.add);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      addToast("已复制到剪贴板", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={handleCopy}
      className="p-1 rounded-md text-tertiary opacity-60 hover:opacity-100 hover:text-primary hover:bg-surface-elevated transition-colors"
      title="复制"
      aria-label="复制回答"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}

/** 工具调用分组：合并所有工具调用为一个折叠面板，展开后再逐项展开单个工具详情 */
function ToolCallGroup({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const total = toolCalls.length;
  const done = toolCalls.filter((tc: any) => results.has(tc.id)).length;
  const successCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && !r.isError; }).length;
  const failedCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && r.isError; }).length;

  const parts = [`🔧 工具调用记录 (${total})`];
  if (done > 0) {
    const statusParts: string[] = [];
    if (successCount > 0) statusParts.push(`✓${successCount}`);
    if (failedCount > 0) statusParts.push(`✗${failedCount}`);
    if (done < total) statusParts.push(`⏳${total - done}`);
    parts.push(`· ${statusParts.join(" ")}`);
  } else if (isStreaming && total > 0) {
    parts.push("· 执行中…");
  }

  return (
    <div data-testid="toolcall-group">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 select-none text-[11.5px] text-tertiary px-2 py-0.5 rounded-pill bg-surface-elevated border border-hairline transition-colors hover:text-secondary"
        style={{ cursor: "pointer" }}
      >
        {isStreaming && done < total && (
          <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
        )}
        <span>{parts.join(" ")}</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-hairline space-y-1">
          {toolCalls.map((tc: any, i: number) => (
            <ToolCallBlock key={i} toolCall={tc} result={results.get(tc.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall, result }: { toolCall: ToolCall; result?: ToolResultMessage }) {
  const [open, setOpen] = useState(false);
  // 三态：成功（result 且非 error）→ ✓ 绿；失败（result.isError）→ ✗ 红；未返回 → 🔧 中性
  const failed = !!result && !!result.isError;
  const success = !!result && !result.isError;
  const pillClass = success
    ? "bg-success-soft text-success border-success-soft"
    : failed
      ? "bg-danger-soft text-danger border-danger-soft"
      : "bg-surface-elevated text-tertiary border-hairline hover:text-secondary";
  const icon = success ? "✓" : failed ? "✗" : "🔧";
  const nameClass = success ? "text-success" : failed ? "text-danger" : "text-primary";
  return (
    <div data-testid={`toolcall-${toolCall.id}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 select-none text-[11.5px] font-mono px-2 py-0.5 rounded-pill border transition-colors ${pillClass}`}
        style={{ cursor: "pointer" }}
      >
        <span>{icon}</span>
        <span className={nameClass}>{toolCall.name === "ask_user_question" ? "问答" : toolCall.name}</span>
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
