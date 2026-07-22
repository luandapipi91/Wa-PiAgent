import { test, expect, beforeEach } from "bun:test";
import { getSubagentInfo, _resetPiDefaultsCache } from "../src/subagent-info";
import { SUBAGENT_TYPES } from "@hiagent/shared";

// 每次测试前重置缓存，确保测试隔离
beforeEach(() => { _resetPiDefaultsCache(); });

test("getSubagentInfo 返回 3 个内置 subagent", async () => {
  const infos = await getSubagentInfo([]);
  expect(infos).toHaveLength(3);
  const names = infos.map(i => i.name);
  expect(names).toContain("general-purpose");
  expect(names).toContain("Explore");
  expect(names).toContain("Plan");
});

test("getSubagentInfo 含 SUBAGENT_TYPES 的元信息（displayName/emoji/gradient）", async () => {
  const infos = await getSubagentInfo([]);
  for (const t of SUBAGENT_TYPES) {
    const info = infos.find(i => i.name === t.name);
    expect(info).toBeDefined();
    expect(info!.displayName).toBe(t.displayName);
    expect(info!.emoji).toBe(t.emoji);
    expect(info!.gradient).toEqual(t.gradient);
    expect(info!.readOnly).toBe(t.readOnly);
  }
});

test("getSubagentInfo systemPrompt 从 BUILTIN_AGENT_CONTENT 读取真实提示词", async () => {
  const infos = await getSubagentInfo([]);
  // Explore 与 Plan 的 systemPrompt 从 builtin-agents.ts 的 BUILTIN_AGENT_CONTENT 提取
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.systemPrompt.length).toBeGreaterThan(100);
  expect(explore!.systemPrompt).toContain("READ-ONLY MODE");
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.systemPrompt.length).toBeGreaterThan(100);
  expect(plan!.systemPrompt).toContain("software architect");
  // general-purpose 的 systemPrompt 较短
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.systemPrompt).toContain("General-purpose agent");
});

test("getSubagentInfo builtinToolNames 从 SUBAGENT_TYPES readOnly 标志计算", async () => {
  const infos = await getSubagentInfo([]);
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
  // general-purpose 未设置 builtinToolNames（继承全部）→ 空数组
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.builtinToolNames).toEqual([]);
});

test("getSubagentInfo 合并用户 override", async () => {
  const infos = await getSubagentInfo([
    { type: "Explore", model: "openai/gpt-4o", thinking: "high" },
    { type: "Plan", thinking: "max" },
  ]);
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.override).toEqual({ type: "Explore", model: "openai/gpt-4o", thinking: "high" });
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.override?.thinking).toBe("max");
  // 未设置 override 的 general-purpose
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.override).toBeUndefined();
});
