import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";

type Handler = (e: WSServerEvent) => void;
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;

export function getWs(): WebSocket {
  if (!ws) {
    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as WSServerEvent;
        handlers.forEach(h => h(e));
      } catch {}
    };
  }
  return ws;
}

export function send(e: WSClientEvent): void {
  const s = getWs();
  if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(e));
  else s.addEventListener("open", () => s.send(JSON.stringify(e)), { once: true });
}

export function onMessage(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
