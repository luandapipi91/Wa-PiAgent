import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import type { AgentConfig } from "hiagent-shared";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-cfg-")); });
afterEach(async () => { await rm(dir, { recursive: true }); });

const makeConfig = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: ["read"], skills: [], partners: { askTo: [], askFrom: [] },
});

test("saveAgent 写文件 + listAgents 读回", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const agents = await store.listAgents();
  expect(agents.length).toBe(1);
  expect(agents[0].name).toBe("dev");
  expect(agents[0].tools).toEqual(["read"]);
});

test("getAgent 返回 null 当文件不存在", async () => {
  const store = new ConfigStore(dir);
  expect(await store.getAgent("nope")).toBeNull();
});
