// builtin-agents.test.ts — 内置 agent .md 内容 + seed 种子写入测试
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedBuiltinAgents, BUILTIN_AGENT_CONTENT } from "../src/builtin-agents";

test("BUILTIN_AGENT_CONTENT 含三个内置类型", () => {
  expect(BUILTIN_AGENT_CONTENT["general-purpose"]).toBeDefined();
  expect(BUILTIN_AGENT_CONTENT["Explore"]).toBeDefined();
  expect(BUILTIN_AGENT_CONTENT["Plan"]).toBeDefined();
});

test("Explore .md 含只读提示词 + read-only 工具集", () => {
  const md = BUILTIN_AGENT_CONTENT["Explore"];
  expect(md).toContain("READ-ONLY MODE");
  expect(md).toContain("tools: read, bash, grep, find, ls");
});

test("Plan .md 含架构师提示词 + read-only 工具集", () => {
  const md = BUILTIN_AGENT_CONTENT["Plan"];
  expect(md).toContain("software architect");
  expect(md).toContain("tools: read, bash, grep, find, ls");
});

test("general-purpose .md 无 tools 白名单（继承全部）", () => {
  const md = BUILTIN_AGENT_CONTENT["general-purpose"];
  // general-purpose 不设 tools 字段 = 全量工具
  expect(md).not.toMatch(/^tools:/m);
});

test("seedBuiltinAgents 写入三个 .md 文件", () => {
  const tmpDir = `/tmp/hiagent-test-agents-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  seedBuiltinAgents(tmpDir);
  const files = readdirSync(tmpDir).filter(f => f.endsWith(".md")).sort();
  expect(files).toContain("Explore.md");
  expect(files).toContain("Plan.md");
  expect(files).toContain("general-purpose.md");
  expect(files.length).toBe(3);
  rmSync(tmpDir, { recursive: true });
});

test("seedBuiltinAgents 已存在的文件不覆盖", () => {
  const tmpDir = `/tmp/hiagent-test-agents-keep-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  const customContent = "---\nname: Explore\ndescription: 我的自定义探索\n---\n自定义提示词";
  writeFileSync(join(tmpDir, "Explore.md"), customContent);
  seedBuiltinAgents(tmpDir);
  const after = readFileSync(join(tmpDir, "Explore.md"), "utf-8");
  expect(after).toBe(customContent);
  rmSync(tmpDir, { recursive: true });
});
