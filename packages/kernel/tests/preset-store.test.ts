import { test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import {
  listPresets,
  getPreset,
  buildAgentConfigFromPreset,
  createAgentFromPreset,
} from "../src/preset-store";
import { makeDefaultAgentConfig } from "../src/agent-md";

function tempAgentsDir() {
  const dir = join(import.meta.dir, ".tmp-presets-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listPresets 返回 268 条元数据且不含 body", () => {
  const list = listPresets();
  expect(list.length).toBeGreaterThanOrEqual(260);
  expect("body" in list[0]).toBe(false);
  expect(list[0].department.length).toBeGreaterThan(0);
});

test("getPreset 命中与未命中", () => {
  const first = listPresets()[0];
  expect(getPreset(first.id)?.name).toBe(first.name);
  expect(getPreset("not-exist-id")).toBeUndefined();
});

test("buildAgentConfigFromPreset 注入名字与预设字段", () => {
  const preset = getPreset(listPresets()[0].id)!;
  const config = buildAgentConfigFromPreset(preset, "林晓岚");
  expect(config.displayName).toBe("林晓岚");
  expect(config.description).toBe(preset.description);
  if (preset.emoji) expect(config.avatar).toBe(preset.emoji);
  if (preset.color) expect(config.avatarColor).toBe(`${preset.color}-${preset.color}`);
  expect(config.systemPromptBody!.startsWith("你的名字是「林晓岚」。")).toBe(true);
  expect(config.systemPromptBody!).toContain(preset.body.slice(0, 20));
});

test("buildAgentConfigFromPreset 非法 CSS 颜色时保留默认渐变", () => {
  // 预设库中部分 color（如 "indigo"）不是合法 CSS 颜色，拼进渐变会让整条声明失效，
  // 此时应回落到 makeDefaultAgentConfig 的默认渐变
  const preset = {
    id: "fake-indigo",
    name: "假预设",
    department: "测试部",
    description: "用于测试颜色守卫",
    emoji: "🧪",
    color: "indigo",
    body: "正文内容",
  };
  const config = buildAgentConfigFromPreset(preset, "林晓岚");
  expect(config.avatarColor).toBe(makeDefaultAgentConfig("任意名").avatarColor);
  expect(config.avatarColor).not.toBe("indigo-indigo");
});

test("createAgentFromPreset 成功创建并写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const presetId = listPresets()[0].id;
  const r = await createAgentFromPreset(store, presetId, "林晓岚");
  expect(r.ok).toBe(true);
  const onDisk = await store.getAgent("林晓岚" as any);
  expect(onDisk).not.toBeNull();
  expect(onDisk!.systemPromptBody).toContain("你的名字是「林晓岚」。");
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 未知 id 返回 404", async () => {
  const dir = tempAgentsDir();
  const r = await createAgentFromPreset(new ConfigStore(dir), "not-exist-id", "林晓岚");
  expect(r).toEqual({ ok: false, status: 404, error: "预设不存在: not-exist-id" });
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 重名返回 409", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  await store.createAgent("林晓岚");
  const r = await createAgentFromPreset(store, listPresets()[0].id, "林晓岚");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(409);
  rmSync(dir, { recursive: true, force: true });
});

test("createAgentFromPreset 非法名字返回 400", async () => {
  const dir = tempAgentsDir();
  const r = await createAgentFromPreset(new ConfigStore(dir), listPresets()[0].id, "a/b");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(400);
  rmSync(dir, { recursive: true, force: true });
});
