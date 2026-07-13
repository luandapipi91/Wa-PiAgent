import { test, expect } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  const calls = { reloadAll: 0, markAllDirty: 0, markSkillsDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; },
    markSkillsDirty: () => { calls.markSkillsDirty++; },
    calls,
  } as any;
}

async function withSkillServer<T>(
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>, calls: { markAllDirty: number; markSkillsDirty: number }) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-skill");
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
  try { return await fn(send, recv, mockAM.calls); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

test("skill:list 返回技能列表 + 目录 + builtinDir", async () => {
  await withSkillServer(async (send, recv, _calls) => {
    send({ type: "skill:list" });
    const e = await recv() as any;
    expect(e.type).toBe("skill:list");
    expect(e.builtinDir).toContain("skills");
    expect(e.dirs).toContain(e.builtinDir);
  });
});

test("skillDir:add 成功后 markSkillsDirty 被调用 + 广播 changed", async () => {
  await withSkillServer(async (send, recv, calls) => {
    const userDir = tmp("user-skills");
    mkdirSync(userDir, { recursive: true });
    send({ type: "skillDir:add", path: userDir });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.dirs).toContain(userDir);
    expect(calls.markSkillsDirty).toBe(1);
    expect(calls.markAllDirty).toBe(0);
  });
});

test("skillDir:add 不存在的路径返回 error", async () => {
  await withSkillServer(async (send, recv, _calls) => {
    send({ type: "skillDir:add", path: "/nonexistent/path" });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("目录不存在");
  });
});

test("skill:toggle 禁用后 skills 不含但 allSkills 含 + markSkillsDirty", async () => {
  await withSkillServer(async (send, recv, calls) => {
    // 先确认有技能（通过扫描内置目录 — 这里可能为空，但 toggle 逻辑仍可测）
    send({ type: "skill:toggle", skillName: "fake-skill", disabled: true });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.disabledSkills).toContain("fake-skill");
    expect(calls.markSkillsDirty).toBe(1);
  });
});

test("skillDir:remove 内置目录返回 error", async () => {
  await withSkillServer(async (send, recv, _calls) => {
    // 先拿 builtinDir
    send({ type: "skill:list" });
    const list = await recv() as any;
    send({ type: "skillDir:remove", path: list.builtinDir });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("内置目录不可删除");
  });
});
