import { useState, useEffect } from "react";
import type { AskItem } from "../store/intercom";
import { wsClient } from "../ws-instance";

export function AskCard({ ask }: { ask: AskItem }) {
  const [answering, setAnswering] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [elapsed, setElapsed] = useState(Math.floor((Date.now() - ask.startedAt) / 1000));

  useEffect(() => {
    if (ask.resolved) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - ask.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [ask.resolved, ask.startedAt]);

  const submitReply = () => {
    if (!replyText.trim()) return;
    wsClient.send({ type: "intercom:inject-reply", messageId: ask.messageId, agentName: ask.to, toAskFrom: ask.from, text: replyText });
    setAnswering(false); setReplyText("");
  };

  return (
    <div className="flex gap-2.5 items-start my-1">
      <div className="w-7" />
      <div className="flex-1 max-w-[80%] rounded-lg p-[10px_14px]"
           style={{ background: "rgba(250,179,135,0.1)", border: "1px solid rgba(250,179,135,0.3)" }}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-peach text-[10px] font-semibold">↗ 委派给{ask.to}</span>
          {!ask.resolved
            ? <span className="text-peach text-[9px] px-[7px] py-px rounded-lg" style={{ background: "rgba(250,179,135,0.2)" }}>ask · 阻塞中 {elapsed}s</span>
            : <span className="text-green text-[9px]">✓ 已回复</span>}
        </div>
        <div className="text-text text-[12px] leading-relaxed">"{ask.text}"</div>
        {!ask.resolved && !answering && (
          <div className="flex gap-1.5 mt-2">
            <button onClick={() => setAnswering(true)} className="bg-surface px-2 py-0.5 rounded text-[9px] text-green cursor-pointer">🙋 我来回答</button>
            <button disabled className="bg-surface px-2 py-0.5 rounded text-[9px] text-subtext cursor-pointer opacity-50" title="MVP 暂未实现">⚡ 催一下</button>
            <button disabled className="px-2 py-0.5 rounded text-[9px] text-overlay cursor-pointer opacity-50" title="MVP 暂未实现">查看队列</button>
          </div>
        )}
        {answering && (
          <div className="mt-2 flex gap-2">
            <input autoFocus className="flex-1 bg-surface border border-surface2 rounded px-2 py-1 text-[12px] text-text outline-none"
              placeholder="输入你的回答..." value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitReply(); }} />
            <button onClick={submitReply} className="bg-blue text-base px-3 py-1 rounded text-[11px]">发送</button>
          </div>
        )}
      </div>
    </div>
  );
}
