import { test, expect, beforeEach, afterEach } from "bun:test";
import { getSubagentInfo, _resetPiDefaultsCache } from "../src/subagent-info";
import { saveSubagentOverride, loadSubagentOverrides } from "../src/subagent-store";
import { SUBAGENT_TYPES } from "@hiagent/shared";
import { rmSync } from "node:fs";
import { join } from "node:path";
// 每次测试前重置缓存，确保测试隔离
let tempFile: string;
beforeEach(() => {
  _resetPiDefaultsCache();
  tempFile = join(import.meta.dir, ".tmp-subagent-info-" + Math.random().toString(36).slice(2) + ".json");
});
afterEach(() => {
  try { rmSync(tempFile, { force: true }); } catch {}
});
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

test("getSubagentInfo delegationHints 从 .md frontmatter 提取", async () => {
  const infos = await getSubagentInfo([]);
  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.delegationHints).toBeDefined();
  expect(explore!.delegationHints!.whenToDelegate).toContain("跨多文件探索");
  expect(explore!.delegationHints!.whenNotTo).toContain("needle query");
  expect(explore!.delegationHints!.benefit).toContain("主上下文");
  // 三个内置类型都应有 hints
  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.delegationHints?.whenToDelegate).toBeTruthy();
  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.delegationHints?.whenToDelegate).toBeTruthy();
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

// 集成测试：saveSubagentOverride 写入 → loadSubagentOverrides 读取 → getSubagentInfo 应用
test("saveSubagentOverride → loadSubagentOverrides → getSubagentInfo 完整链路", async () => {
  // 保存 override
  await saveSubagentOverride(tempFile, { type: "Plan", model: "anthropic/claude-sonnet", thinking: "max" });
  await saveSubagentOverride(tempFile, { type: "Explore", thinking: "disabled" });

  // 加载
  const overrides = await loadSubagentOverrides(tempFile);
  expect(overrides).toHaveLength(2);

  // 组装 SubagentInfo
  const infos = await getSubagentInfo(overrides);

  const plan = infos.find(i => i.name === "Plan");
  expect(plan!.override?.model).toBe("anthropic/claude-sonnet");
  expect(plan!.override?.thinking).toBe("max");

  const explore = infos.find(i => i.name === "Explore");
  expect(explore!.override?.thinking).toBe("disabled");

  const gp = infos.find(i => i.name === "general-purpose");
  expect(gp!.override).toBeUndefined();
});
