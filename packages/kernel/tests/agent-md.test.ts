import { test, expect } from "bun:test";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "../src/agent-md";
import type { AgentConfig } from "@hiagent/shared";

const DEV_MD = `---
name: dev
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 后端研发
model: anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
tools: read, bash, edit
skills: architecture-review
mcpServers: []
partners:
  askTo: [product, test]
  askFrom: [product, pm, test]
---
你是一名资深后端工程师。`;

test("parseAgentMd 解析 frontmatter + 正文", () => {
  const c = parseAgentMd(DEV_MD);
  expect(c.name).toBe("dev");
  expect(c.displayName).toBe("研发");
  expect(c.tools).toEqual(["read", "bash", "edit"]);
  expect(c.skills).toEqual(["architecture-review"]);
  expect(c.partners.askTo).toEqual(["product", "test"]);
  expect(c.systemPromptBody).toBe("你是一名资深后端工程师。");
});

test("parseAgentMd 处理空 mcpServers", () => {
  const c = parseAgentMd(DEV_MD);
  expect(c.mcpServers).toEqual([]);
});

test("stringifyAgentMd 往返一致", () => {
  const c = parseAgentMd(DEV_MD);
  const md2 = stringifyAgentMd(c);
  const c2 = parseAgentMd(md2);
  expect(c2).toEqual(c);
});

test("validateAgentConfig 拒绝非法 name", () => {
  const bad = parseAgentMd(DEV_MD);
  (bad as unknown as { name: string }).name = "hacker";
  const errs = validateAgentConfig(bad as AgentConfig);
  expect(errs.length).toBeGreaterThan(0);
});

test("validateAgentConfig 合法配置返回空", () => {
  const c = parseAgentMd(DEV_MD);
  expect(validateAgentConfig(c)).toEqual([]);
});
