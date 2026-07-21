import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  loadSubagentOverrides,
  saveSubagentOverride,
  getSubagentOverride,
  ensureSubagentOverrides,
} from "../src/subagent-store";

function tempFile() {
  return join(import.meta.dir, ".tmp-subagent-overrides-" + Math.random().toString(36).slice(2) + ".json");
}

let file: string;
beforeEach(() => { file = tempFile(); });
afterEach(() => { rmSync(file, { force: true }); });

test("ensureSubagentOverrides 首次调用写入空数组", async () => {
  await ensureSubagentOverrides(file);
  expect(existsSync(file)).toBe(true);
  const data = JSON.parse(readFileSync(file, "utf8"));
  expect(data).toEqual({ overrides: [] });
});

test("ensureSubagentOverrides 二次调用幂等（不覆盖）", async () => {
  writeFileSync(file, JSON.stringify({ overrides: [{ type: "Plan", model: "openai/gpt-4o" }] }));
  await ensureSubagentOverrides(file);
  const data = JSON.parse(readFileSync(file, "utf8"));
  expect(data.overrides).toHaveLength(1);
});

test("ensureSubagentOverrides 失败不抛错（不阻塞启动）", async () => {
  // 路径指向不存在的目录深处
  const badPath = join(import.meta.dir, ".non-existent-" + Date.now(), "sub", "f.json");
  await expect(ensureSubagentOverrides(badPath))
    .resolves.toBeUndefined();
});

test("saveSubagentOverride 新增覆盖", async () => {
  const all = await saveSubagentOverride(file, { type: "Plan", model: "openai/gpt-4o", thinking: "high" });
  expect(all).toHaveLength(1);
  expect(all[0].type).toBe("Plan");
});

test("saveSubagentOverride 同 type 覆盖已存在记录（不重复）", async () => {
  await saveSubagentOverride(file, { type: "Plan", model: "openai/gpt-4o" });
  const all = await saveSubagentOverride(file, { type: "Plan", model: "glm-4.6", thinking: "max" });
  expect(all).toHaveLength(1);
  expect(all[0].model).toBe("glm-4.6");
  expect(all[0].thinking).toBe("max");
});

test("getSubagentOverride 返回单个记录", async () => {
  await saveSubagentOverride(file, { type: "Explore", model: "openai/gpt-4o" });
  await saveSubagentOverride(file, { type: "Plan", model: "glm-4.6" });
  const o = await getSubagentOverride(file, "Explore");
  expect(o).toBeDefined();
  expect(o!.type).toBe("Explore");
  expect(o!.model).toBe("openai/gpt-4o");
});

test("getSubagentOverride 未找到返回 undefined", async () => {
  const o = await getSubagentOverride(file, "Plan");
  expect(o).toBeUndefined();
});

test("saveSubagentOverride 空文件也正常（读取失败初始化为空）", async () => {
  writeFileSync(file, "");
  const all = await saveSubagentOverride(file, { type: "Plan", model: "glm-4.6" });
  expect(all).toHaveLength(1);
});

test("loadSubagentOverrides 加载已有数据", async () => {
  writeFileSync(file, JSON.stringify({ overrides: [{ type: "Plan", model: "glm-4.6" }] }));
  const all = await loadSubagentOverrides(file);
  expect(all).toHaveLength(1);
  expect(all[0].type).toBe("Plan");
});

test("loadSubagentOverrides 文件不存在返回空数组", async () => {
  const all = await loadSubagentOverrides(file);
  expect(all).toEqual([]);
});
