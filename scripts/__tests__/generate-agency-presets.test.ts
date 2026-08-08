import { test, expect } from "bun:test";
import { parseAgencyMd } from "../generate-agency-presets";

const SAMPLE = `---
name: 前端开发者
description: 精通现代 Web 技术的前端开发专家
emoji: 💻
color: "#06B6D4"
---

# 前端开发者 Agent 人格

你是 **前端开发者**。
`;

test("parseAgencyMd 解析合法 frontmatter", () => {
  const r = parseAgencyMd(SAMPLE);
  expect(r).not.toBeNull();
  expect(r!.name).toBe("前端开发者");
  expect(r!.description).toBe("精通现代 Web 技术的前端开发专家");
  expect(r!.emoji).toBe("💻");
  expect(r!.color).toBe("#06B6D4"); // 引号被剥掉
  expect(r!.body).toContain("# 前端开发者 Agent 人格");
});

test("parseAgencyMd 缺 name 返回 null", () => {
  expect(parseAgencyMd(`---\ndescription: 没有名字\n---\n正文`)).toBeNull();
});

test("parseAgencyMd 无 frontmatter 返回 null", () => {
  expect(parseAgencyMd(`# 普通文档\n正文`)).toBeNull();
});

test("parseAgencyMd 缺 description 返回 null", () => {
  expect(parseAgencyMd(`---\nname: 某人\n---\n正文`)).toBeNull();
});
