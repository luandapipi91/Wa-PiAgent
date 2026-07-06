import { test, expect } from "bun:test";
import { parseAgentMd, serializeAgentMd } from "../src/agent-md";

const SAMPLE = `---
name: dev
displayName: 研发
avatar: "⚙️"
description: 后端研发
model: deepseek/deepseek-v4-flash
thinking: high
tools: read, bash, edit, write
skills: debug-methodically
partners:
  askTo: [product, test]
  askFrom: [product, pm]
---
你是一名资深后端工程师`;

test("parseAgentMd 解析 frontmatter + body", () => {
  const c = parseAgentMd(SAMPLE);
  expect(c.name).toBe("dev");
  expect(c.displayName).toBe("研发");
  expect(c.avatar).toBe("⚙️");
  expect(c.tools).toEqual(["read", "bash", "edit", "write"]);
  expect(c.skills).toEqual(["debug-methodically"]);
  expect(c.partners.askTo).toEqual(["product", "test"]);
  expect(c.partners.askFrom).toEqual(["product", "pm"]);
  expect(c.systemPrompt).toBe("你是一名资深后端工程师");
});

test("serializeAgentMd 往返一致", () => {
  const c = parseAgentMd(SAMPLE);
  expect(parseAgentMd(serializeAgentMd(c))).toEqual(c);
});
