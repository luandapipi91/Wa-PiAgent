import { test, expect } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ExtensionManager } from "../src/extension-manager";
import { SkillManager } from "../src/skill-manager";
import { ProviderStore } from "../src/provider-store";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent, PackageInfo } from "@hiagent/shared";

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

/**
 * 离线 mock 的 NpmPackageService：test-pkg 视为已安装（9.9.9），
 * 其他包视为未安装。避免触发真实 bun add 子进程。
 */
function makeMockPkgService() {
  const known = new Set<string>(["test-pkg"]);
  return {
    install: async (_name: string, _version?: string) => {
      known.add(_name);
      return { version: "9.9.9" };
    },
    uninstall: async (name: string) => { known.delete(name); },
    upgrade: async (_name: string) => ({ version: "9.9.9" }),
    getInstalledVersion: (name: string): string | undefined =>
      known.has(name) ? "9.9.9" : undefined,
    getLatestVersion: async (_name: string): Promise<string | undefined> => "9.9.10",
    getDescription: (_name: string): string | undefined => "Mock description",
  } as any;
}

interface ExtServerOpts {
  /** 初始 settings.json 内容（在 server 启动前写入 dataDir） */
  initialSettings?: Record<string, unknown>;
}

async function withExtServer<T>(
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    mockAM: { calls: { markAllDirty: number } },
  ) => Promise<T>,
  opts: ExtServerOpts = {},
): Promise<T> {
  const dataDir = tmp("ws-ext");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  if (opts.initialSettings) {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(opts.initialSettings));
  }
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    // 注入 mock pkgService，避免真实子进程
    extensionManager: new ExtensionManager(dataDir, makeMockPkgService()),
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

// 从收到的 packages 中按名查找条目（断言辅助）
function findPkg(packages: PackageInfo[] | undefined, name: string): PackageInfo | undefined {
  return packages?.find(p => p.name === name);
}

test("extension:list 首次启动返回空 packages（无自动播种）", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:list" });
    const e = await recv() as any;
    expect(e.type).toBe("extension:list");
    expect(e.packages).toEqual([]);
  });
});

test("extension:install 成功 → 广播 extension:changed (含新包) + markAllDirty", async () => {
  await withExtServer(async (send, recv, mockAM) => {
    send({ type: "extension:install", name: "test-pkg" });
    // handler 顺序：先 broadcast(extension:changed) 再 reply(extension:changed)
    const broadcastEvt = await recv() as any;
    expect(broadcastEvt.type).toBe("extension:changed");
    const installed = findPkg(broadcastEvt.packages, "test-pkg");
    expect(installed).toBeDefined();
    expect(installed!.version).toBe("9.9.9");
    expect(installed!.enabled).toBe(true);
    // markAllDirty 至少调用一次
    expect(mockAM.calls.markAllDirty).toBeGreaterThanOrEqual(1);
  });
});

test("extension:toggle 禁用已安装包 → 广播 changed（仍可见 enabled:false）+ 持久化 + markAllDirty", async () => {
  // 预置 settings.json：已存在 npm:test-pkg@9.9.9
  await withExtServer(async (send, recv, mockAM) => {
    send({ type: "extension:toggle", name: "test-pkg", enabled: false });
    const changed = await recv() as any;
    expect(changed.type).toBe("extension:changed");
    // disable 后条目仍在 list 里，但 enabled:false（从 disabledPackages 来源）
    const disabled = findPkg(changed.packages, "test-pkg");
    expect(disabled).toBeDefined();
    expect(disabled!.enabled).toBe(false);
    expect(mockAM.calls.markAllDirty).toBeGreaterThanOrEqual(1);

    // 再次 list 确认持久化（仍可见 enabled:false）
    send({ type: "extension:list" });
    const list = await recv() as any;
    expect(list.type).toBe("extension:list");
    const stillThere = findPkg(list.packages, "test-pkg");
    expect(stillThere).toBeDefined();
    expect(stillThere!.enabled).toBe(false);
  }, { initialSettings: { npmCommand: ["bun"], packages: ["npm:test-pkg@9.9.9"] } });
});

test("extension:toggle 启用未知包 → error 回复（含「请先安装」）", async () => {
  await withExtServer(async (send, recv) => {
    send({ type: "extension:toggle", name: "nope", enabled: true });
    const e = await recv() as any;
    expect(e.type).toBe("error");
    expect(e.message).toContain("未找到已安装的包");
    expect(e.message).toContain("请先安装");
  });
});
