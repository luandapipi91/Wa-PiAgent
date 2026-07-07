import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { StateAggregator } from "../src/state-aggregator";
import { WSServer } from "../src/ws-server";
import type { WSClientEvent, WSServerEvent, AgentMessage } from "@hiagent/shared";

// 测试：点历史会话 → kernel 通过 PiRpcClient.getMessages() 拉 Pi session 的历史消息
// （不再读拍扁的 sessions 文件 —— 设计文档核心目标）
test("[第三层] session:messages 走 PiRpcClient.getMessages", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-sm-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);

  // 预置：建项目 + 会话（不再预置消息，历史来自 Pi session）
  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "历史会话" });

  // mock PiRpcClient：getMessages 返回 Pi session 的历史消息
  const piHistory: AgentMessage[] = [
    { role: "user", content: "历史问题", timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "历史回复" }], model: "m", stopReason: "stop", timestamp: 2 } as AgentMessage,
  ];
  const fakeClient = {
    getMessages: async () => piHistory,
    prompt: async () => {},
    abort: async () => {},
    dispose: async () => {},
  };
  // mock agentManager：ensureStarted 返回 fakeClient（不真正 spawn pi）
  const agentManager = {
    ensureStarted: async () => fakeClient,
    abort: async () => {},
    disposeAll: async () => {},
  } as any;
  const stateAggregator = new StateAggregator({ agentManager, onServerEvent: () => {} });
  const server = new WSServer({ configStore, projectStore, agentManager, stateAggregator, port: 0 });
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

  // 断言：返回 Pi session 的历史消息（SessionMessage 包装）
  const msgResp = resp as Extract<WSServerEvent, { type: "session:messages" }>;
  expect(msgResp.sessionId).toBe(session.id);
  expect(msgResp.messages).toHaveLength(2);
  // 第一条 user：content 是字符串
  expect((msgResp.messages[0].message as any).content).toBe("历史问题");
  // 包装层：agentName 来自 session.primaryAgent
  expect(msgResp.messages[0].agentName).toBe("dev");
  // 第二条 assistant
  expect((msgResp.messages[1].message as any).content[0].text).toBe("历史回复");

  ws.close();
  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
});

test("[第三层] session:messages 会话不存在返回空数组", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-sm2-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);

  const fakeClient = { getMessages: async () => [{ role: "user", content: "x", timestamp: 1 }] };
  const agentManager = {
    ensureStarted: async () => fakeClient,
    abort: async () => {},
    disposeAll: async () => {},
  } as any;
  const stateAggregator = new StateAggregator({ agentManager, onServerEvent: () => {} });
  const server = new WSServer({ configStore, projectStore, agentManager, stateAggregator, port: 0 });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws 失败")); });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));

  // 请求一个不存在的会话
  ws.send(JSON.stringify({ type: "session:messages", sessionId: "nope" } as WSClientEvent));

  const resp = await new Promise<WSServerEvent>((resolve) => {
    const check = () => {
      const found = queue.find(e => e.type === "session:messages");
      if (found) resolve(found);
      else setTimeout(check, 20);
    };
    check();
  });

  const msgResp = resp as Extract<WSServerEvent, { type: "session:messages" }>;
  expect(msgResp.sessionId).toBe("nope");
  expect(msgResp.messages).toEqual([]);

  ws.close();
  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
});
