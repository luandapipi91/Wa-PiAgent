import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { IntercomMonitor } from "../src/intercom-monitor";
import { StateAggregator } from "../src/state-aggregator";
import { WSServer } from "../src/ws-server";
import type { WSClientEvent, WSServerEvent, ChatMessage } from "@hiagent/shared";

// 测试：点历史会话 → kernel 返回该会话的持久化消息
test("[第三层] session:messages 返回历史会话消息", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-sm-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");
  const sessDir = tmp("sess");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const sessionStore = new SessionStore(sessDir);

  // 预置：建项目 + 会话 + 两条历史消息
  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "历史会话" });
  const oldMsg1: ChatMessage = { id: "m1", sessionId: session.id, role: "user", text: "旧问题", timestamp: 1000 };
  const oldMsg2: ChatMessage = { id: "m2", sessionId: session.id, role: "assistant", text: "旧回复", timestamp: 2000 };
  await sessionStore.appendMessage(session.id, oldMsg1);
  await sessionStore.appendMessage(session.id, oldMsg2);

  const mockChild = {
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {} }, stderr: { on: () => {} },
    killed: false, kill: () => { mockChild.killed = true; },
  };
  const agentManager = new AgentManager({ projectStore, onEvent: () => {}, spawnFn: (() => mockChild) as any });
  const intercomMonitor = new IntercomMonitor({ onAsk: () => {}, onReply: () => {}, connectFn: async () => ({ on: () => {}, write: () => {}, destroy: () => {} }) as any });
  const stateAggregator = new StateAggregator({ sessionStore, agentManager, onServerEvent: () => {} });
  const server = new WSServer({ configStore, projectStore, sessionStore, agentManager, intercomMonitor, stateAggregator, port: 0 });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws 失败")); });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));

  // 请求历史消息
  ws.send(JSON.stringify({ type: "session:messages", sessionId: session.id } as WSClientEvent));

  // 等响应
  const resp = await new Promise<WSServerEvent>((resolve) => {
    const check = () => {
      const found = queue.find(e => e.type === "session:messages");
      if (found) resolve(found);
      else setTimeout(check, 20);
    };
    check();
  });

  // 断言：返回两条历史消息，顺序正确
  const msgResp = resp as Extract<WSServerEvent, { type: "session:messages" }>;
  expect(msgResp.sessionId).toBe(session.id);
  expect(msgResp.messages).toHaveLength(2);
  expect(msgResp.messages[0].text).toBe("旧问题");
  expect(msgResp.messages[1].text).toBe("旧回复");

  ws.close();
  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
  rmSync(sessDir, { recursive: true, force: true });
});
