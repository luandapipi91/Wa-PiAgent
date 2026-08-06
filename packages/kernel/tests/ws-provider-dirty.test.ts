// 测试：provider:save / provider:delete 后激活会话被标脏（markAllDirty），
// 确保运行中的 pi session 在下次使用时重建进程、重新加载最新 provider-extension。
// 回归保护：provider:list / provider:test 不应误触发重建。
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer } from "../src/ws-server";
import type { ModelProvider } from "@wa-pi/shared";

/** 构造一个最小可用 provider（含斜杠的 model id，复现 NVIDIA NIM 命名） */
function sampleProvider(): ModelProvider {
  return {
    id: "p1",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "nvapi-test",
    api: "openai-completions",
    models: [{ id: "z-ai/glm-5.2", contextWindow: 128000, maxTokens: 4096 }],
  };
}

async function setup() {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-pd-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");
  const providersFile = join(projFile, "..", "providers.json");
  // provider:save/delete 会重生 provider-extension.ts，必须注入临时输出目录，
  // 否则覆盖真实 ~/.wa-pi/.generated/provider-extension.ts（曾致线上 Model not found）
  const generatedDir = tmp("generated");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(providersFile);
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  // markAllDirty 的 spy：记录调用次数
  let dirtyCalls = 0;
  const agentManager = {
    markAllDirty: () => { dirtyCalls++; },
    markSkillsDirty: () => {},
    ensureStarted: async () => ({}),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: () => false,
    getThinkingSince: () => null,
  } as any;

  const server = new WSServer({
    configStore, projectStore, providerStore, skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any, mcpStore: null as any,
    agentManager, channelManager: null, port: 0, generatedDir,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  return {
    base, providerStore, dirtyCalls: () => dirtyCalls,
    cleanup: async () => {
      await server.stop();
      rmSync(cfgDir, { recursive: true, force: true });
      rmSync(projFile, { force: true });
      rmSync(providersFile, { force: true });
      rmSync(generatedDir, { recursive: true, force: true });
    },
  };
}

test("provider:save 后标记激活会话为脏（markAllDirty 被调用）", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: sampleProvider() }),
    });
    expect(res.status).toBe(200);
    expect(ctx.dirtyCalls()).toBe(1);
  } finally {
    await ctx.cleanup();
  }
});

test("provider:delete 后标记激活会话为脏（markAllDirty 被调用）", async () => {
  const ctx = await setup();
  try {
    // 先存一个 provider，再删除
    await ctx.providerStore.save(sampleProvider());
    const res = await fetch(`${ctx.base}/api/providers/p1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(ctx.dirtyCalls()).toBe(1);
  } finally {
    await ctx.cleanup();
  }
});

test("provider:list 不触发重建（markAllDirty 不应被调用）", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/providers`);
    expect(res.status).toBe(200);
    expect(ctx.dirtyCalls()).toBe(0);
  } finally {
    await ctx.cleanup();
  }
});
