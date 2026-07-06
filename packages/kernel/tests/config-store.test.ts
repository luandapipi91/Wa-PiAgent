import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";

function tempAgentsDir() {
  const dir = join(import.meta.dir, ".tmp-agents-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listAgents 读全部 .md", async () => {
  const dir = tempAgentsDir();
  writeFileSync(join(dir, "dev.md"), `---\nname: dev\ndisplayName: 研发\navatar: "⚙️"\navatarColor: "x"\ndescription: d\nmodel: m\nthinking: high\nsystemPromptMode: replace\ninheritProjectContext: true\ninheritSkills: false\ntools: read\nskills: []\nmcpServers: []\npartners:\n  askTo: []\n  askFrom: []\n---\nbody`);
  const store = new ConfigStore(dir);
  const agents = await store.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0].name).toBe("dev");
  rmSync(dir, { recursive: true, force: true });
});

test("getAgent 返回 null 当不存在", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  expect(await store.getAgent("dev")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 持久化并可读回", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
    description: "d", model: "m", thinking: "high", systemPromptMode: "replace",
    inheritProjectContext: true, inheritSkills: false, tools: ["read"],
    skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    systemPromptBody: "正文",
  });
  expect(errs).toEqual([]);
  const back = await store.getAgent("dev");
  expect(back?.displayName).toBe("研发");
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 拒绝非法配置不写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    ...(await store.getAgent("dev") || {} as never),
    name: "hacker", displayName: "", model: "", thinking: "high" as never,
    systemPromptMode: "replace", avatar: "", avatarColor: "", description: "",
    inheritProjectContext: true, inheritSkills: false, tools: [], skills: [],
    mcpServers: [], partners: { askTo: [], askFrom: [] },
  } as never);
  expect(errs.length).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});
