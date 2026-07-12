import { useState } from "react";
import type { AskParams, AskReply } from "@hiagent/shared";
import { send } from "../../ws-instance";
// 项目现有代码（TextBlock.tsx / MessageList.tsx）统一用默认导入；保持一致。
import ReactMarkdown from "react-markdown";

interface Props {
  sessionId: string;
  toolCallId: string;
  params: AskParams;
}

/** 单个 ask_user_question 调用的表单。挂载即 pending；提交/取消后由父层在 pendingAsks 消失时卸载。 */
export function AskFormCard({ sessionId, toolCallId, params }: Props) {
  // 每问的选择状态：questionIndex → { selected: Set<label>, custom: string, otherOpen: bool, notes: string }
  const [state, setState] = useState<Record<number, { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }>>(() => {
    const init: Record<number, { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }> = {};
    params.questions.forEach((_, i) => { init[i] = { selected: new Set(), custom: "", otherOpen: false, notes: "" }; });
    return init;
  });
  const [submitting, setSubmitting] = useState(false);

  const patch = (qi: number, fn: (s: { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }) => void) =>
    setState(prev => {
      const cur = prev[qi];
      const next = { selected: new Set(cur.selected), custom: cur.custom, otherOpen: cur.otherOpen, notes: cur.notes };
      fn(next);
      return { ...prev, [qi]: next };
    });

  const toggle = (qi: number, label: string, multi: boolean) => patch(qi, s => {
    if (multi) { s.selected.has(label) ? s.selected.delete(label) : s.selected.add(label); }
    else { s.selected.clear(); s.selected.add(label); s.otherOpen = false; s.custom = ""; }
  });

  const allAnswered = params.questions.every((q, i) => {
    const s = state[i];
    return (s.custom.trim().length > 0) || s.selected.size > 0;
  });

  const handleSubmit = () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    const reply: AskReply = { replies: params.questions.map((_, i) => {
      const s = state[i];
      const useCustom = s.custom.trim().length > 0;
      return { questionIndex: i, selected: useCustom ? [] : [...s.selected], customText: useCustom ? s.custom.trim() : undefined, notes: s.notes.trim() || undefined };
    }) };
    send({ type: "agent:answer", sessionId, toolCallId, reply });
    // 卡片保持 pending 直到 toolResult 到达使 pendingAsks 移除它（由父层卸载）
  };

  const handleCancel = () => {
    if (submitting) return;
    send({ type: "agent:cancel-ask", sessionId, toolCallId });
  };

  return (
    <div className="rounded-2xl border-2 border-accent bg-surface shadow-md" data-testid={`ask-card-${toolCallId}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-hairline">
        <span className="text-[11.5px] font-semibold text-accent">📌 agent 提问 · 请回复以继续</span>
        <button onClick={handleCancel} disabled={submitting} className="text-[11.5px] px-2 py-0.5 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer disabled:opacity-50" data-testid={`ask-collapse-${toolCallId}`}>取消</button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[50vh] overflow-auto">
        {params.questions.map((q, qi) => {
          const s = state[qi];
          const multi = q.multiSelect === true;
          const selPreview = [...s.selected].map(lbl => q.options.find(o => o.label === lbl)?.preview).find(Boolean);
          return (
            <div key={qi} className="space-y-1.5">
              <div className="text-[12.5px] font-semibold text-primary">Q{params.questions.length > 1 ? qi + 1 : ""} · {q.question}</div>
              {q.options.map(o => {
                const checked = s.selected.has(o.label);
                return (
                  <button key={o.label} onClick={() => toggle(qi, o.label, multi)}
                    className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${checked ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}>
                    <span className="text-accent">{multi ? (checked ? "☑" : "☐") : (checked ? "◉" : "○")}</span>
                    <span><span className="font-medium text-primary">{o.label}</span> <span className="text-tertiary">— {o.description}</span></span>
                  </button>
                );
              })}
              {selPreview && (
                <div className="ml-6 bg-[#0d1117] text-[#c9d1d9] rounded-sm px-2.5 py-1.5 text-[11px] font-mono overflow-auto" data-testid={`ask-preview-${toolCallId}-${qi}`}>
                  <ReactMarkdown>{selPreview}</ReactMarkdown>
                </div>
              )}
              <button onClick={() => patch(qi, st => { st.otherOpen = !st.otherOpen; })}
                className="text-[11px] text-secondary hover:text-primary underline">其他…</button>
              {s.otherOpen && (
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
          className="text-[12px] px-4 py-1 rounded-pill text-on-brand border-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: allAnswered && !submitting ? "var(--brand)" : "var(--hairline-strong)" }}>
          {submitting ? "提交中…" : "提交"}
        </button>
      </div>
    </div>
  );
}
