import { useEffect, useState } from "react";
import { wsClient } from "./ws-instance";
import { useSession } from "./store/session";
import { useAgents } from "./store/agents";
import { useIntercom } from "./store/intercom";
import { LaunchScreen } from "./components/LaunchScreen";
import { SessionView } from "./components/SessionView";

export function App() {
  const [connected, setConnected] = useState(false);
  const currentAgent = useSession(s => s.currentAgent);
  const addMessage = useSession(s => s.addMessage);
  const updateState = useAgents(s => s.updateState);
  const addAsk = useIntercom(s => s.addAsk);
  const resolveAsk = useIntercom(s => s.resolveAsk);
  const setList = useAgents(s => s.setList);

  useEffect(() => {
    wsClient.connect();
    const t = setInterval(() => setConnected(wsClient.readyState === WebSocket.OPEN), 1000);

    const unsub = wsClient.onEvent(e => {
      switch (e.type) {
        case "agents:list": setList(e.agents); break;
        case "agent:message": addMessage(e.agentName, e.message); break;
        case "agent:state": updateState(e.agentName, e.state); break;
        case "intercom:ask": addAsk({ messageId: e.messageId, from: e.from, to: e.to, text: e.text, startedAt: e.startedAt, resolved: false }); break;
        case "intercom:reply": resolveAsk(e.toAskMessageId); break;
      }
    });

    return () => { clearInterval(t); unsub(); };
  }, [setList, addMessage, updateState, addAsk, resolveAsk]);

  if (!connected) return <div className="h-screen flex items-center justify-center text-overlay">正在连接内核...</div>;
  if (!currentAgent) return <LaunchScreen />;
  return <SessionView />;
}
