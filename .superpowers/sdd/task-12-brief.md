### Task 12: WS Server（端口 9776，全协议路由）

**Files:**
- Modify: `packages/kernel/src/index.ts`（编排入口）
- Create: `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: 所有 kernel 组件
- Produces:
  - `class WSServer { constructor(opts: { configStore: ConfigStore; projectStore: ProjectStore; sessionStore: SessionStore; agentManager: AgentManager; intercomMonitor: IntercomMonitor; stateAggregator: StateAggregator; port?: number; }); start(): Promise<void>; stop(): Promise<void>; }`
  - 处理全部 `WSClientEvent`，路由到对应 store/manager，回 `WSServerEvent`

- [ ] **Step 1: 写失败测试（真实 WS server + mock Pi）**

`packages/kernel/tests/ws-server.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { IntercomMonitor } from "../src/intercom-monitor";
import { StateAggregator } from "../src/state-aggregator";
import { WS_PORT } from "@hiagent/shared";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

async function withServer<T>(fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const sessionStore = new SessionStore(tmp("ws-sess"));
  const agentManager = new AgentManager({ projectStore, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const intercomMonitor = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {}, connectFn: async () => ({}) as any,
  });
  const stateAggregator = new StateAggregator({
    sessionStore, agentManager, onServerEvent: () => {},
  });
  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator,
    port: 0,  // 随机端口，避免冲突
  });
  await server.start();
  const port = server.actualPort;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv); }
  finally { ws.close(); await server.stop(); }
}

test("projects:list 返回空", async () => {
  await withServer(async (send, recv) => {
    send({ type: "projects:list" });
    const e = await recv() as any;
    expect(e.type).toBe("projects:list");
    expect(e.projects).toEqual([]);
  });
});

test("project:create + projects:list", async () => {
  await withServer(async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    expect(created.type).toBe("project:created");
    expect(created.project.name).toBe("P");
    send({ type: "projects:list" });
    const list = await recv() as any;
    expect(list.projects).toHaveLength(1);
  });
});

test("session:create 隐含于 agent:prompt（首条消息建会话）", async () => {
  await withServer(async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    send({ type: "agent:prompt", projectId, sessionId: "s-fake", agentName: "dev", text: "你好" });
    // 期望收到 session:created（会话被建立）
    const ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    expect(ev.session.projectId).toBe(projectId);
  });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 ws-server.ts**

`packages/kernel/src/ws-server.ts`:
```typescript
import type {
  WSClientEvent, WSServerEvent, AgentName,
} from "@hiagent/shared";
import { WS_PORT, makeAgentStateKey } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { StateAggregator } from "./state-aggregator";

export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
  agentManager: AgentManager;
  intercomMonitor: IntercomMonitor;
  stateAggregator: StateAggregator;
  port?: number;
}

export class WSServer {
  actualPort = 0;
  private server: any;
  private clients = new Set<any>();  // 跟踪连接的客户端用于广播

  constructor(private opts: WSServerOpts) {}

  // 广播给所有客户端（StateAggregator 的 onServerEvent 调用）
  private broadcast(e: WSServerEvent): void {
    const payload = JSON.stringify(e);
    for (const ws of this.clients) {
      try { ws.send(payload); } catch {}
    }
  }

  // 暴露给 index.ts：把 StateAggregator 的输出接到 broadcast
  bindAggregatorBroadcast(): void {
    (this.opts.stateAggregator as any).opts.onServerEvent = (e: WSServerEvent) => this.broadcast(e);
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.opts.port ?? WS_PORT,
      fetch: (req, server) => {
        if (server.upgrade(req)) return;
        return new Response("WS only", { status: 426 });
      },
      websocket: {
        open: (ws) => { this.clients.add(ws); },
        message: async (ws, msg) => {
          const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
          let event: WSClientEvent;
          try { event = JSON.parse(text); } catch { return; }
          // 多数响应通过 broadcast 推全量；少数（projects:list、agent:config）定向回请求者
          const reply = (e: WSServerEvent) => ws.send(JSON.stringify(e));
          await this.handle(event, reply);
        },
        close: (ws) => { this.clients.delete(ws); },
      },
    });
    this.actualPort = this.server.port;
    this.bindAggregatorBroadcast();
  }

  async stop(): Promise<void> {
    this.server?.stop();
    await this.opts.agentManager.disposeAll();
    this.opts.intercomMonitor.dispose();
  }

  private async handle(event: WSClientEvent, reply: (e: WSServerEvent) => void): Promise<void> {
    switch (event.type) {
      case "projects:list": {
        const { projects, sessions } = await this.opts.projectStore.load();
        reply({ type: "projects:list", projects, sessions });  // 定向回请求者
        break;
      }
      case "project:create": {
        const project = await this.opts.projectStore.createProject({ name: event.name, cwd: event.cwd });
        this.broadcast({ type: "project:created", project });  // 广播：所有客户端同步
        break;
      }
      case "project:update": {
        await this.opts.projectStore.updateProject(event.projectId, { name: event.name, cwd: event.cwd });
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "project:delete": {
        await this.opts.projectStore.deleteProject(event.projectId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:rename": {
        await this.opts.projectStore.renameSession(event.sessionId, event.title);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:delete": {
        await this.opts.projectStore.deleteSession(event.sessionId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "agent:prompt": {
        // session 元数据由 kernel 用 randomUUID 创建（前端传的 sessionId 仅作请求追踪，
        // 实际 session.id 由 ProjectStore 生成并经 session:created 广播回前端）
        const { sessions } = await this.opts.projectStore.load();
        const existing = sessions.find(s => s.id === event.sessionId);
        const session = existing ?? await this.opts.projectStore.createSession({
          projectId: event.projectId, primaryAgent: event.agentName,
          title: event.text.slice(0, 20),
        });
        this.broadcast({ type: "session:created", session });
        await this.opts.projectStore.touchSession(session.id);
        const client = await this.opts.agentManager.ensureStarted(event.projectId, event.agentName);
        await client.prompt(event.text);
        break;
      }
      case "agent:abort": {
        await this.opts.agentManager.abort(event.projectId, event.agentName);
        break;
      }
      case "intercom:inject-reply": {
        await this.opts.intercomMonitor.injectReply(event.askMessageId, event.text);
        break;
      }
      case "agent:config:get": {
        const config = await this.opts.configStore.getAgent(event.agentName);
        if (config) reply({ type: "agent:config", agentName: event.agentName, config });  // 定向
        break;
      }
      case "agent:config:save": {
        const errs = await this.opts.configStore.saveAgent(event.config);
        if (errs.length) reply({ type: "error", message: errs.join("; ") });
        break;
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/ws-server.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 写 kernel 入口 index.ts**

`packages/kernel/src/index.ts`:
```typescript
import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { WS_PORT } from "@hiagent/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const sessionStore = new SessionStore();

  // 先建一个占位 broadcast，待 WSServer 实例化后绑定真实实现
  let broadcast: (e: import("@hiagent/shared").WSServerEvent) => void = () => {};

  // StateAggregator：Pi 事件 → WS 事件，输出到 broadcast
  const agentManager = new AgentManager({
    projectStore,
    onEvent: () => {},  // 下面立即用真实闭包重建
  });
  const stateAggregator = new StateAggregator({
    sessionStore,
    agentManager,
    onServerEvent: (e) => broadcast(e),
  });
  // 用真实闭包重写 AgentManager.onEvent（避免 as any 改 opts）
  (agentManager as { opts: { onEvent: (k: never, e: never) => void } }).opts.onEvent =
    (key, e) => stateAggregator.routePiEvent(key as never, e as never);

  const intercomMonitor = new IntercomMonitor({
    onAsk: (a) => stateAggregator.routeAsk(a),
    onReply: (id, sid) => stateAggregator.routeReply(id, sid),
  });
  await intercomMonitor.connect();

  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator,
    port: WS_PORT,
  });
  await server.start();
  // 绑定真实广播（WSServer.broadcast 通过 clients 集群分发）
  broadcast = (e) => (server as unknown as { broadcast: (e2: import("@hiagent/shared").WSServerEvent) => void }).broadcast(e);
  server.bindAggregatorBroadcast();

  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

> 注：`bindAggregatorBroadcast` 会把 `stateAggregator.opts.onServerEvent` 重指向 `WSServer.broadcast`，覆盖上面的 `broadcast(e)` 闭包——两者等效（都调 server.broadcast）。保留闭包仅为启动初期（server.start 前）的安全兜底。

- [ ] **Step 6: 提交**

```bash
git add packages/kernel
git commit -m "feat(kernel): WS Server（端口 9776，全协议路由）+ 入口编排"
```

> 验证（四层）：第一/三层合并——3 passed（真实 WS server + mock Pi）。第三层 `[需 pi 环境]`：Task 33 集成。

---
## Phase 3 — 前端基础

