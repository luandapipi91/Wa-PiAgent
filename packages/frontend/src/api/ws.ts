import type { WSEvent } from "hiagent-shared";

export class KernelWSClient {
  private ws: WebSocket | null = null;
  private handlers: Array<(e: WSEvent) => void> = [];

  connect(url = "ws://localhost:9776"): void {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try { this.handlers.forEach(h => h(JSON.parse(ev.data) as WSEvent)); } catch {}
    };
    this.ws.onclose = () => setTimeout(() => this.connect(url), 3000);
  }
  get readyState(): number { return this.ws?.readyState ?? 0; }
  onEvent(cb: (e: WSEvent) => void): () => void {
    this.handlers.push(cb);
    return () => { this.handlers = this.handlers.filter(h => h !== cb); };
  }
  send(msg: any): void { this.ws?.send(JSON.stringify(msg)); }
}
