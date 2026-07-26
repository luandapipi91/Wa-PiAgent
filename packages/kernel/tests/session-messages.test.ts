import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer } from "../src/ws-server";
import type { AgentMessage } from "@hiagent/shared";

// 测试：点历史会话 → kernel 通过 AgentSession.messages 拉 SDK session 的历史消息
// REST 版本（替代原 WS 版本）
test("[第三层] session:messages 走 AgentSession.messages", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-sm-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(join(projFile, "..", "providers.json"));
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "历史会话" });

  const piHistory: AgentMessage[] = [
    { role: "user", content: "历史问题", timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "历史回复" }], model: "m", stopReason: "stop", timestamp: 2 } as AgentMessage,
  ];
  const fakeSession = {
    messages: piHistory,
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) => fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
  const server = new WSServer({ configStore, projectStore, providerStore, skillManager, extensionManager: new ExtensionManager(join(projFile, "..")), memoryStore: null as any, mcpStore: null as any, agentManager, port: 0 });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  // HTTP GET 拉历史消息
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}/messages`);
  const msgResp = await res.json();

  expect(res.status).toBe(200);
  expect(msgResp.sessionId).toBe(session.id);
  expect(msgResp.messages).toHaveLength(2);
  expect((msgResp.messages[0].message as any).content).toBe("历史问题");
  expect(msgResp.messages[0].agentName).toBe("dev");
  expect((msgResp.messages[1].message as any).content[0].text).toBe("历史回复");

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
  const providerStore = new ProviderStore(join(projFile, "..", "providers.json"));
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const fakeSession = { messages: [{ role: "user", content: "x", timestamp: 1 }] };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) => fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
  const server = new WSServer({ configStore, projectStore, providerStore, skillManager, extensionManager: new ExtensionManager(join(projFile, "..")), memoryStore: null as any, mcpStore: null as any, agentManager, port: 0 });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  // HTTP GET 拉不存在会话的历史消息
  const res = await fetch(`${base}/api/sessions/nope/messages`);
  const msgResp = await res.json();

  expect(res.status).toBe(200);
  expect(msgResp.sessionId).toBe("nope");
  expect(msgResp.messages).toEqual([]);

  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
});
