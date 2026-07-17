import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";

type Handler = (e: WSServerEvent) => void;
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;

function getWsUrl(): string {
  if (import.meta.env.DEV) {
    return `ws://127.0.0.1:${WS_PORT}`;
  }
  if (typeof window !== "undefined" && window.location) {
    return `ws://${window.location.host}`;
  }
  return `ws://127.0.0.1:${WS_PORT}`;
}

export function getWs(): WebSocket {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    ws = new WebSocket(getWsUrl());
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as WSServerEvent;
        handlers.forEach(h => h(e));
      } catch (err) {
        // 不再静默吞错：记录解析/handler 异常，便于排查（畸形帧或 handler 抛错）
        console.warn("[ws] message parse/handle failed:", err);
      }
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
