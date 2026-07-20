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
  writeFileSync(join(dir, "研发.md"), `---\ndisplayName: 研发\navatar: "⚙️"\navatarColor: "x"\ndescription: d\nmodel: m\nthinking: high\nsystemPromptMode: replace\ninheritProjectContext: true\ninheritSkills: false\ntools: read\nskills: []\nmcpServers: []\npartners:\n  askTo: []\n  askFrom: []\n---\nbody`);
  const store = new ConfigStore(dir);
  const agents = await store.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0].displayName).toBe("研发");
  rmSync(dir, { recursive: true, force: true });
});

test("getAgent 返回 null 当不存在", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  expect(await store.getAgent("研发")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 持久化并可读回", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
    description: "d", model: "m", thinking: "high", systemPromptMode: "replace",
    inheritProjectContext: true, inheritSkills: false, tools: ["read"],
    skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    triggerKeywords: [],
    systemPromptBody: "正文",
  });
  expect(errs).toEqual([]);
  const back = await store.getAgent("研发");
  expect(back?.displayName).toBe("研发");
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 拒绝非法配置不写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    displayName: "", model: "", thinking: "high" as never,
    systemPromptMode: "replace", avatar: "", avatarColor: "", description: "",
    inheritProjectContext: true, inheritSkills: false, tools: [], skills: [],
    mcpServers: [], partners: { askTo: [], askFrom: [] },
    triggerKeywords: [],
  } as never);
  expect(errs.length).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});

test("createAgent: 生成默认配置；重名自动加 -2 后缀；非法名抛错", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  const a = await cs.createAgent("代码审查");
  expect(a.displayName).toBe("代码审查");
  const b = await cs.createAgent("代码审查");
  expect(b.displayName).toBe("代码审查-2");
  const c = await cs.createAgent("代码审查");
  expect(c.displayName).toBe("代码审查-3");
  await expect(cs.createAgent("a/b")).rejects.toThrow("非法 displayName");
  rmSync(dir, { recursive: true, force: true });
});

test("deleteAgent: 删除文件；不存在抛错", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.createAgent("临时");
  await cs.deleteAgent("临时");
  expect(await cs.getAgent("临时")).toBeNull();
  await expect(cs.deleteAgent("临时")).rejects.toThrow("智能体不存在");
  rmSync(dir, { recursive: true, force: true });
});

test("renameAgent: 删旧写新；新名冲突返回错误", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.createAgent("旧名");
  await cs.createAgent("已存在");
  const old = (await cs.getAgent("旧名"))!;
  const errs1 = await cs.renameAgent("旧名", { ...old, displayName: "已存在" });
  expect(errs1.length).toBeGreaterThan(0);
  const errs2 = await cs.renameAgent("旧名", { ...old, displayName: "新名" });
  expect(errs2).toEqual([]);
  expect(await cs.getAgent("旧名")).toBeNull();
  expect((await cs.getAgent("新名"))!.displayName).toBe("新名");
  rmSync(dir, { recursive: true, force: true });
});

test("seedDefaults: 空目录写入 4 个默认 agent；非空目录不写", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.seedDefaults();
  const names = (await cs.listAgents()).map(a => a.displayName).sort();
  expect(names).toEqual(["技术实现", "质量验收", "需求设计", "项目管理"]);
  await cs.seedDefaults();  // 幂等
  expect((await cs.listAgents()).length).toBe(4);
  rmSync(dir, { recursive: true, force: true });
});
