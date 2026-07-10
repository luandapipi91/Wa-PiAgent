import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { AgentManager } from "../src/agent-manager";
import { WSServer } from "../src/ws-server";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

// 第三层集成测试：真实 WS server（Bun.serve）+ mock createAgentSessionFn
// 覆盖「建项目 → 发首条消息 → kernel 自动建会话 → 广播 session:created」全链路
test("[第三层] 建项目→发消息→自动建会话", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-e2e-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(join(projFile, "..", "providers.json"));
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  // mock createAgentSessionFn：返回伪 session（不真正调 SDK）
  // 测试不验证 SDK 回复，只验证 session:created 广播链路
  const fakeSession = {
    messages: [],
    setSessionName: () => {},
    subscribe: () => () => {},  // 返回 unsubscribe
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = new AgentManager({
    projectStore,
    configStore,  // 真实 configStore（读 agent.md 默认配置）
    onEvent: () => {},
    createAgentSessionFn: (async () => ({ session: fakeSession as any })) as any,
  });

  const server = new WSServer({
    configStore, projectStore, providerStore, skillManager,
    agentManager,
    port: 0,  // 随机端口，避免与运行中的 kernel 冲突
  });
  await server.start();

  // 真实 WebSocket 客户端连 server
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws 连接失败"));
  });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };

  // 1. 建项目 → 广播 project:created
  send({ type: "project:create", name: "测试项目", cwd: "/tmp" });
  const created = await recv() as Extract<WSServerEvent, { type: "project:created" }>;
  expect(created.type).toBe("project:created");
  expect(created.project.name).toBe("测试项目");
  const projectId = created.project.id;

  // 2. 发首条消息 → kernel 自动建会话（sessionId 不存在）→ 广播 session:created
  send({ type: "agent:prompt", projectId, sessionId: "req-nonexistent", agentName: "dev", text: "你好世界" });
  const sessionCreated = await recv() as Extract<WSServerEvent, { type: "session:created" }>;
  expect(sessionCreated.type).toBe("session:created");
  expect(sessionCreated.session.projectId).toBe(projectId);
  expect(sessionCreated.session.primaryAgent).toBe("dev");
  // title 取首条消息前 20 字
  expect(sessionCreated.session.title).toBe("你好世界");

  // 清理
  ws.close();
  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
});
