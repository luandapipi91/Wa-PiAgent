import { useEffect, useState } from "react";
import { wsClient } from "./ws-instance";

export function App() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    wsClient.connect();
    const t = setInterval(() => setConnected(wsClient.readyState === WebSocket.OPEN), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="h-screen flex items-center justify-center text-overlay">
      {connected ? "内核已连接 ✓（Task 10 实现）" : "正在连接内核..."}
    </div>
  );
}
