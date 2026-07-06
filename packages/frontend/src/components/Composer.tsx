import { useState } from "react";

export function Composer({ agentName, agentAvatar, onSend }: { agentName: string; agentAvatar: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) { onSend(text); setText(""); } };
  return (
    <div className="border-t border-surface p-3 bg-mantle">
      <div className="bg-surface border border-surface2 rounded-lg p-[10px_14px] flex items-center gap-2">
        <span className="text-blue text-[13px]">{agentAvatar}</span>
        <input
          className="bg-transparent border-none text-text flex-1 text-[12px] outline-none"
          placeholder={`给${agentName}发消息...`}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button onClick={send} className="bg-blue text-base px-2.5 py-[3px] rounded text-[10px] font-semibold">↩</button>
      </div>
    </div>
  );
}
