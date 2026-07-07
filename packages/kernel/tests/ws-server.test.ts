import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { AgentManager } from "../src/agent-manager";
import { StateAggregator } from "../src/state-aggregator";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

async function withServer<T>(fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const agentManager = new AgentManager({ projectStore, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const stateAggregator = new StateAggregator({
    agentManager, onServerEvent: () => {},
  });
  const server = new WSServer({
    configStore, projectStore,
    agentManager, stateAggregator,
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
