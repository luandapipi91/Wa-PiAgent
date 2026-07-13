import { test, expect } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ExtensionManager } from "../src/extension-manager";
import { SkillManager } from "../src/skill-manager";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  const calls = { markAllDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {}, abort: async () => {},
    disposeSession: async () => {}, disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; }, calls,
  } as any;
}

async function withExtServer<T>(
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    mockAM: { calls: { markAllDirty: number } },
  ) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-ext");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    agentManager: mockAM,
    dataDir,
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
  try { return await fn(send, recv, mockAM); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

test("extension:list 返回插件（首启播种默认启用）", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:list" });
    const e = await recv() as any;
    expect(e.type).toBe("extension:list");
    expect(e.plugins[0].id).toBe("pi-lens");
    expect(e.plugins[0].enabled).toBe(true);
  });
});

test("extension:toggle 禁用 → markAllDirty + 广播 changed + 持久化", async () => {
  await withExtServer(async (send, recv, mockAM) => {
    send({ type: "extension:toggle", name: "pi-lens", enabled: false });
    const changed = await recv() as any;
    expect(changed.type).toBe("extension:changed");
    expect(changed.plugins[0].enabled).toBe(false);
    expect(mockAM.calls.markAllDirty).toBe(1);

    // 再次 list 确认持久化
    send({ type: "extension:list" });
    const list = await recv() as any;
    expect(list.plugins[0].enabled).toBe(false);
  });
});

test("extension:toggle 未知 id 返回 error", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:toggle", name: "nope", enabled: true });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("未知插件");
  });
});

test("extension:list 收敛同包历史路径（bun install 残留修复）", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  // 独立场景：直接构造残留 settings 再起 server
  const dataDir = tmp("ws-ext-cleanup");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    extensions: [
      "/fake/.bun/pi-lens@old-hash/node_modules/pi-lens/dist/index.js",
      "/fake/.bun/pi-lens@new-hash/node_modules/pi-lens/dist/index.js",
    ],
  }));
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg2")),
    projectStore: new ProjectStore(tmp("ws-proj2.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    agentManager: mockAM,
    dataDir,
    port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: any[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  ws.send(JSON.stringify({ type: "extension:list" }));
  while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
  const listEvent = queue.shift();
  ws.close();
  await server.stop();
  // 读收敛后的 settings.json
  const settings = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
  rmSync(dataDir, { recursive: true, force: true });

  expect(listEvent.type).toBe("extension:list");
  expect(listEvent.plugins[0].enabled).toBe(true);
  // settings.json 应已收敛为唯一路径（两条历史 → 一条当前）
  expect(settings.extensions).toEqual([
    "/fake/.bun/pi-lens@new-hash/node_modules/pi-lens/dist/index.js",
  ]);
});
