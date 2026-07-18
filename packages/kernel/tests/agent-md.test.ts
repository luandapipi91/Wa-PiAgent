import { test, expect } from "bun:test";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig, makeDefaultAgentConfig } from "../src/agent-md";
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
  (bad as unknown as { name: string }).name = "a/b";
  const errs = validateAgentConfig(bad as AgentConfig);
  expect(errs.length).toBeGreaterThan(0);
});

test("validateAgentConfig 合法配置返回空", () => {
  const c = parseAgentMd(DEV_MD);
  expect(validateAgentConfig(c)).toEqual([]);
});

const base: AgentConfig = {
  name: "代码审查", displayName: "代码审查", avatar: "🔍", avatarColor: "#06b6d4-#3b82f6",
  description: "评审改动", model: "glm-4.6", thinking: "high",
  systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: ["dev"], askFrom: [] },
  triggerKeywords: ["review", "评审"],
  systemPromptBody: "你是代码审查智能体。",
};

test("validateAgentConfig: 任意非空合法名通过；非法文件名字符拒绝", () => {
  expect(validateAgentConfig(base)).toEqual([]);
  expect(validateAgentConfig({ ...base, name: "" })).toContain("name 不能为空");
  expect(validateAgentConfig({ ...base, name: "a/b" })[0]).toContain("非法 name");
  expect(validateAgentConfig({ ...base, name: "a:b" })[0]).toContain("非法 name");
});

test("triggerKeywords 序列化/解析往返", () => {
  const md = stringifyAgentMd(base);
  expect(md).toContain("triggerKeywords: [review, 评审]");
  const parsed = parseAgentMd(md);
  expect(parsed.triggerKeywords).toEqual(["review", "评审"]);
  expect(parsed.partners.askTo).toEqual(["dev"]);
});

test("thinking: low 读取时归一为 medium", () => {
  const md = stringifyAgentMd(base).replace("thinking: high", "thinking: low");
  expect(parseAgentMd(md).thinking).toBe("medium");
});

test("makeDefaultAgentConfig 支持任意名（无内置定义时用名称本身）", () => {
  const c = makeDefaultAgentConfig("文档写手");
  expect(c.name).toBe("文档写手");
  expect(c.displayName).toBe("文档写手");
  expect(c.avatar).toBe("🤖");
  expect(c.triggerKeywords).toEqual([]);
});
