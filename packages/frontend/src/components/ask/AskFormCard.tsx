import { useState } from "react";
import type { AgentName, AskParams, AskReply } from "@wa-pi/shared";
import { AGENT_DEFS } from "@wa-pi/shared";
import { api } from "../../api-client";
// 项目现有代码（TextBlock.tsx / MessageList.tsx）统一用默认导入；保持一致。
import ReactMarkdown from "react-markdown";
import { MarkdownLink } from "../blocks/markdown-components";

interface Props {
  sessionId: string;
  toolCallId: string;
  params: AskParams;
  agentName?: AgentName;
}

interface QState {
  /** "option" = 选了某个普通选项；"other" = 选择了「其他」（需输入文字） */
  mode: "option" | "other";
  selected: Set<string>;
  custom: string;
  notes: string;
}

/** 单个 ask_user_question 调用的表单。挂载即 pending；提交/取消后由父层在 pendingAsks 消失时卸载。 */
export function AskFormCard({ sessionId, toolCallId, params, agentName }: Props) {
  const [state, setState] = useState<Record<number, QState>>(() => {
    const init: Record<number, QState> = {};
    params.questions.forEach((_, i) => { init[i] = { mode: "option", selected: new Set(), custom: "", notes: "" }; });
    return init;
  });
  const [submitting, setSubmitting] = useState(false);

  const patch = (qi: number, fn: (s: QState) => void) =>
    setState(prev => {
      const cur = prev[qi];
      const next: QState = { mode: cur.mode, selected: new Set(cur.selected), custom: cur.custom, notes: cur.notes };
      fn(next);
      return { ...prev, [qi]: next };
    });

  // 选普通选项：切到 option 模式，清空「其他」输入。单选只保一个，多选可叠加。
  const toggleOption = (qi: number, label: string, multi: boolean) => patch(qi, s => {
    s.mode = "option";
    s.custom = "";
    if (multi) { s.selected.has(label) ? s.selected.delete(label) : s.selected.add(label); }
    else { s.selected.clear(); s.selected.add(label); }
  });

  // 选「其他」：切到 other 模式，清空普通选项的选择（互斥）。
  const chooseOther = (qi: number) => patch(qi, s => { s.mode = "other"; s.selected.clear(); });

  const allAnswered = params.questions.every((_, i) => {
    const s = state[i];
    // 「其他」必须输入非空文字；普通模式必须有选中项
    return s.mode === "other" ? s.custom.trim().length > 0 : s.selected.size > 0;
  });

  const handleSubmit = () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    const reply: AskReply = { replies: params.questions.map((_, i) => {
      const s = state[i];
      const useCustom = s.mode === "other";
      return { questionIndex: i, selected: useCustom ? [] : [...s.selected], customText: useCustom ? s.custom.trim() : undefined, notes: s.notes.trim() || undefined };
    }) };
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, { toolCallId, reply });
    // 卡片保持 pending 直到 toolResult 到达使 pendingAsks 移除它（由父层卸载）
  };

  const handleCancel = () => {
    if (submitting) return;
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/cancel-ask`, { toolCallId });
  };

  const agentEm = agentName ? AGENT_DEFS[agentName]?.emoji : undefined;
  const title = `${agentEm ?? "📌"} ${agentName ?? "agent"} 提问 · 请回复以继续`;

  return (
    <div className="rounded-lg border border-hairline bg-surface shadow-md" data-testid={`ask-card-${toolCallId}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-hairline">
        <span className="text-[11.5px] font-semibold text-accent">{title}</span>
        <button onClick={handleCancel} disabled={submitting} aria-label="终止提问" className="text-tertiary hover:text-primary text-[14px] leading-none px-1.5 py-0.5 bg-transparent border-0 cursor-pointer disabled:opacity-50" data-testid={`ask-collapse-${toolCallId}`}>✕</button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[50vh] overflow-auto">
        {params.questions.map((q, qi) => {
          const s = state[qi];
          const multi = q.multiSelect === true;
          const selPreview = [...s.selected].map(lbl => q.options.find(o => o.label === lbl)?.preview).find(Boolean);
          const otherActive = s.mode === "other";
          return (
            <div key={qi} className="space-y-1.5">
              <div className="text-[12.5px] font-semibold text-primary">Q{params.questions.length > 1 ? qi + 1 : ""} · {q.question}</div>
              {q.options?.map(o => {
                const checked = s.mode === "option" && s.selected.has(o.label);
                return (
                  <button key={o.label} onClick={() => toggleOption(qi, o.label, multi)}
                    className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${checked ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}>
                    <span className="text-accent">{multi ? (checked ? "☑" : "☐") : (checked ? "◉" : "○")}</span>
                    <span><span className="font-medium text-primary">{o.label}</span> <span className="text-tertiary">— {o.description}</span></span>
                  </button>
                );
              })}
              {selPreview && (
                <div className="ml-6 bg-[#0d1117] text-[#c9d1d9] rounded-sm px-2.5 py-1.5 text-[11px] font-mono overflow-auto" data-testid={`ask-preview-${toolCallId}-${qi}`}>
                  <ReactMarkdown components={{ a: MarkdownLink }}>{selPreview}</ReactMarkdown>
                </div>
              )}
              {/* 「其他」也是一种选项，与普通选项互斥；选中后必须输入文字 */}
              <button onClick={() => chooseOther(qi)}
                className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${otherActive ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}>
                <span className="text-accent">{otherActive ? "◉" : "○"}</span>
                <span className="font-medium text-primary">其他…</span>
              </button>
              {otherActive && (
                <textarea value={s.custom} onChange={e => patch(qi, st => { st.custom = e.target.value; })}
                  placeholder="输入自定义答案…" rows={1}
                  className="w-full bg-transparent border border-hairline rounded-sm text-primary outline-none text-[12.5px] p-2 resize-none" />
              )}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-tertiary">备注(可选)</span>
                <input value={s.notes} onChange={e => patch(qi, st => { st.notes = e.target.value; })}
                  className="flex-1 bg-transparent border border-hairline rounded-sm text-primary outline-none text-[12px] px-2 py-0.5" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 px-4 py-2 border-t border-hairline">
        <button onClick={handleCancel} disabled={submitting} className="text-[12px] px-3 py-1 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer disabled:opacity-50">取消</button>
        <button onClick={handleSubmit} disabled={!allAnswered || submitting}
          className="text-[12px] px-4 py-1 rounded-pill border-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: allAnswered && !submitting ? "var(--accent)" : "var(--hairline-strong)", color: "var(--on-accent)" }}>
          {submitting ? "提交中…" : "提交"}
        </button>
      </div>
    </div>
  );
}
