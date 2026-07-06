import { useState } from "react";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { wsClient } from "../ws-instance";
import { AGENT_THEME } from "../theme/agents";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { Canvas } from "./Canvas";

export function SessionView() {
  const currentAgent = useSession(s => s.currentAgent)!;
  const agent = useAgents(s => s.list.find(a => a.name === currentAgent));
  const addMessage = useSession(s => s.addMessage);
  const [showCanvas, setShowCanvas] = useState(false);

  const sendPrompt = (text: string) => {
    addMessage(currentAgent, { id: `u${Date.now()}`, role: "user", text, timestamp: Date.now() });
    wsClient.send({ type: "agent:prompt", agentName: currentAgent, message: text });
  };

  if (showCanvas) return <Canvas />;

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="bg-mantle px-4 py-2.5 border-b border-surface flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center text-[14px]"
                 style={{ width: 28, height: 28, borderRadius: "50%", background: `linear-gradient(135deg, ${(AGENT_THEME[currentAgent]?.gradient ?? ["#6c7086","#585b70"])[0]}, ${(AGENT_THEME[currentAgent]?.gradient ?? ["#6c7086","#585b70"])[1]})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {agent?.avatar}
            </div>
            <div>
              <div className="font-semibold text-[12px] text-text">{agent?.displayName} 会话</div>
              <div className="text-[9px] text-overlay">{agent?.model} · {agent?.thinking}</div>
            </div>
          </div>
          <button onClick={() => setShowCanvas(!showCanvas)} className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer">
            {showCanvas ? "对话" : "编排画布"}
          </button>
        </div>
        <MessageList agentName={currentAgent} />
        <Composer agentName={agent?.displayName ?? currentAgent} agentAvatar={agent?.avatar ?? "🤖"} onSend={sendPrompt} />
      </div>
    </div>
  );
}
