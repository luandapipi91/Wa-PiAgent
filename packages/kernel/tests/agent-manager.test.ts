import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { AgentManager } from "../src/agent-manager";
import type { AgentConfig } from "hiagent-shared";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-am-")); });
afterEach(async () => { await rm(dir, { recursive: true }); });

const makeConfig = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
});

test("listAvailableAgents 返回配置", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  await store.saveAgent(makeConfig("pm"));
  const mgr = new AgentManager(store, "/tmp");
  expect((await mgr.listAvailableAgents()).map(a => a.name).sort()).toEqual(["dev", "pm"]);
});

test("ensureStarted 启动并缓存同一实例", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store, "/tmp");
  const c1 = await mgr.ensureStarted("dev");
  const c2 = await mgr.ensureStarted("dev");
  expect(c2).toBe(c1);
  mgr.stopAll();
});

test("get 未启动返回 undefined", () => {
  expect(new AgentManager(new ConfigStore(dir), "/tmp").get("ghost")).toBeUndefined();
});
