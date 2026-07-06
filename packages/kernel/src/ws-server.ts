import type { StateAggregator } from "./state-aggregator";
import type { WSEvent } from "hiagent-shared";

export class WSServer {
  private server: any = null;
  private sockets = new Set<any>();
  private clientHandler: ((msg: any) => void) | null = null;

  constructor(private port: number, private aggregator: StateAggregator) {}

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      websocket: {
        open: (ws) => { this.sockets.add(ws); },
        message: (ws, msg) => {
          if (typeof msg === "string") { try { this.clientHandler?.(JSON.parse(msg)); } catch {} }
        },
        close: (ws) => { this.sockets.delete(ws); },
      },
      fetch: (req, server) => { if (server.upgrade(req)) return; return new Response("HiAgent kernel WS", { status: 200 }); },
    });
    this.aggregator.on("ws:event", (event: WSEvent) => {
      const data = JSON.stringify(event);
      for (const ws of this.sockets) ws.send(data);
    });
  }

  onClientMessage(cb: (msg: any) => void): void { this.clientHandler = cb; }
  stop(): void { this.server?.stop(); this.server = null; }
}
