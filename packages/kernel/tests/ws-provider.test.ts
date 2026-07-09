import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import type { WSClientEvent, WSServerEvent, ModelProvider } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
}

async function withProviderServer<T>(
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-dir");
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(tmp("ws-skill-dir")),
    dataDir,
    agentManager: makeMockAgentManager(),
    port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test Provider",
    baseUrl: "https://api.test.com/v1", apiKey: "test-key",
    api: "openai-completions",
    models: [{ id: "model-1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

test("provider:list 空列表", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:list" });
    const e = await recv() as any;
    expect(e.type).toBe("provider:list");
    expect(e.providers).toEqual([]);
  });
});

test("provider:save 后 list 能读回 + 广播 changed", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:save", provider: sampleProvider() });
    const changed = await recv() as any;
    expect(changed.type).toBe("provider:changed");
    expect(changed.providers).toHaveLength(1);
    send({ type: "provider:list" });
    const list = await recv() as any;
    expect(list.providers[0].name).toBe("Test Provider");
  });
});

test("provider:delete 后列表为空", async () => {
  await withProviderServer(async (send, recv) => {
    send({ type: "provider:save", provider: sampleProvider() });
    await recv(); // provider:changed
    send({ type: "provider:delete", id: "p1" });
    const changed = await recv() as any;
    expect(changed.type).toBe("provider:changed");
    expect(changed.providers).toHaveLength(0);
  });
});
