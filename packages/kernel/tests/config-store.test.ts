import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { makeDefaultAgentConfig } from "../src/agent-md";
import { errorCodeOf } from "./helpers/kernel-error-code";

function tempAgentsDir() {
  const dir = join(
    import.meta.dir,
    ".tmp-agents-" + Math.random().toString(36).slice(2),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listAgents 读全部 .md", async () => {
  const dir = tempAgentsDir();
  writeFileSync(
    join(dir, "研发.md"),
    `---\ndisplayName: 研发\navatar: "⚙️"\navatarColor: "x"\ndescription: d\nmodel: m\nthinking: high\ntools: read\nskills: []\nmcpServers: []\npartners:\n  askTo: []\n---\nbody`,
  );
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
    displayName: "研发",
    avatar: "⚙️",
    avatarColor: "a-b",
    description: "d",
    model: "m",
    thinking: "high",
    tools: ["read"],
    skills: [],
    mcpServers: [],
    partners: { askTo: [] },
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
    displayName: "",
    model: "",
    thinking: "high" as never,
    avatar: "",
    avatarColor: "",
    description: "",
    tools: [],
    skills: [],
    mcpServers: [],
    partners: { askTo: [] },
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
  await expect(cs.createAgent("a/b")).rejects.toThrow();
  expect(await errorCodeOf(cs.createAgent("a/b"))).toBe(
    "agent.invalidDisplayName",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("deleteAgent: 删除文件；不存在抛错", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.createAgent("临时");
  await cs.deleteAgent("临时");
  expect(await cs.getAgent("临时")).toBeNull();
  await expect(cs.deleteAgent("临时")).rejects.toThrow();
  expect(await errorCodeOf(cs.deleteAgent("临时"))).toBe("agent.notFound");
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

test("seedDefaults: 空目录写入全部 9 个内置专家角色", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.seedDefaults();
  const names = (await cs.listAgents()).map((a) => a.displayName).sort();
  expect(names).toEqual(
    [
      "UX设计师",
      "产品经理",
      "前端开发者",
      "会议纪要专家",
      "数据分析师",
      "测试结果分析师",
      "代码审查员",
      "高级项目经理",
      "后端架构师",
    ].sort(),
  );
  // 9 个角色有完整种子内容：description 非空、delegationHints 三项齐全、默认全量互联
  for (const name of [
    "前端开发者",
    "后端架构师",
    "产品经理",
    "测试结果分析师",
    "数据分析师",
    "代码审查员",
    "UX设计师",
    "高级项目经理",
    "会议纪要专家",
  ]) {
    const agent = (await cs.getAgent(name))!;
    expect(agent.description).toBeTruthy();
    expect(agent.systemPromptBody).toBeTruthy();
    expect(agent.delegationHints?.whenToDelegate).toBeTruthy();
    expect(agent.delegationHints?.whenNotTo).toBeTruthy();
    expect(agent.delegationHints?.benefit).toBeTruthy();
    // 种子角色默认全量互联，每个角色应包含除自身外的全部 8 个合作伙伴
    expect(agent.partners.askTo.length).toBe(8);
    expect(agent.partners.askTo).not.toContain(name);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("seedDefaults: 重复执行不覆盖用户已修改的同名角色", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  await cs.seedDefaults();
  // 用户修改了某个角色
  const modified = (await cs.getAgent("前端开发者"))!;
  await cs.saveAgent({ ...modified, description: "用户自定义描述" });
  // 用户删掉了某个角色 → 下次 seed 会补回
  await cs.deleteAgent("UX设计师");
  await cs.seedDefaults();
  expect((await cs.getAgent("前端开发者"))!.description).toBe("用户自定义描述");
  expect(await cs.getAgent("UX设计师")).not.toBeNull();
  expect((await cs.listAgents()).length).toBe(9);
  rmSync(dir, { recursive: true, force: true });
});

test("seedDefaults: 存量环境只补缺失角色，不新建已移除的旧角色、不改动已有角色", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  // 模拟存量用户：有旧版角色（已从内建名单移除）+ 自定义角色 + 被改过的内建角色
  await cs.saveAgent(makeDefaultAgentConfig("技术实现"));
  await cs.saveAgent(makeDefaultAgentConfig("我的助手"));
  const customized = makeDefaultAgentConfig("前端开发者");
  await cs.saveAgent({ ...customized, description: "老用户的自定义实现" });

  await cs.seedDefaults();

  const names = (await cs.listAgents()).map((a) => a.displayName);
  // 9 个内建 + 旧角色 + 自定义角色 = 11
  expect(names).toHaveLength(11);
  for (const name of [
    "前端开发者",
    "后端架构师",
    "产品经理",
    "测试结果分析师",
    "数据分析师",
    "代码审查员",
    "UX设计师",
    "高级项目经理",
    "会议纪要专家",
  ]) {
    expect(names).toContain(name);
  }
  for (const removed of ["需求设计", "项目管理", "质量验收"]) {
    expect(names).not.toContain(removed);
  }
  // 已有角色内容未被改动
  expect((await cs.getAgent("前端开发者"))!.description).toBe(
    "老用户的自定义实现",
  );
  expect((await cs.getAgent("技术实现"))!.description).toBe("");
  rmSync(dir, { recursive: true, force: true });
});

test("seedDefaults: WA_PI_SKIP_AGENT_SEED=1 时整体跳过（E2E 最小环境用）", async () => {
  const dir = tempAgentsDir();
  const cs = new ConfigStore(dir);
  process.env.WA_PI_SKIP_AGENT_SEED = "1";
  try {
    await cs.seedDefaults();
    expect(await cs.listAgents()).toHaveLength(0);
  } finally {
    delete process.env.WA_PI_SKIP_AGENT_SEED;
  }
  // 环境变量移除后恢复正常 seed
  await cs.seedDefaults();
  expect(await cs.listAgents()).toHaveLength(9);
  rmSync(dir, { recursive: true, force: true });
});

test("listAgents 过滤 displayName 为空的条目（如内置 agent 用 name 字段）", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  // 写入一个合法 agent + 一个模拟内置 agent（用 name 而非 displayName 的 pi-open-agents 格式）
  await store.saveAgent(makeDefaultAgentConfig("测试"));
  writeFileSync(
    join(dir, "Explore.md"),
    `---
name: Explore
description: 探索
mode: subagent
systemPrompt: replace
thinking: medium
tools: read, bash
---
READ-ONLY explorer body`,
  );
  const list = await store.listAgents();
  const names = list.map((a) => a.displayName);
  expect(names).toContain("测试");
  expect(names).not.toContain(undefined);
  expect(list.length).toBe(1); // Explore 被过滤
  rmSync(dir, { recursive: true, force: true });
});

test("migrateNameToDisplayName 跳过无 displayName 的内置 agent（不生成 undefined.md）", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  // 模拟内置 subagent（有 name 字段但无 displayName 字段）
  writeFileSync(
    join(dir, "Explore.md"),
    `---
name: Explore
description: 只读探索
mode: subagent
systemPrompt: replace
thinking: medium
tools: read, bash
---
READ-ONLY explorer body`,
  );
  // 同时有一个合法旧格式 agent（有 name + displayName）
  writeFileSync(
    join(dir, "old.md"),
    `---
name: old
displayName: 旧智能体
avatar: "🤖"
avatarColor: "a-b"
description: test
model: m
thinking: medium
tools: [read]
skills: []
mcpServers: []
partners:
  askTo: []
---
`,
  );

  const mapping = await store.migrateNameToDisplayName();

  // 内置 agent 被跳过（无 displayName），不产生 undefined.md
  expect(mapping.size).toBe(1);
  expect(mapping.get("old")).toBe("旧智能体");

  // undefined.md 不应存在
  const filesAfter = (await store.listAgents()).map((a) => a.displayName);
  expect(filesAfter).not.toContain("undefined");
  expect(filesAfter).not.toContain(undefined as any);
  // 旧格式 agent 被迁移
  expect(filesAfter).toContain("旧智能体");

  rmSync(dir, { recursive: true, force: true });
});
