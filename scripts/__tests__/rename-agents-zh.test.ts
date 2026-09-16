import { test, expect } from "bun:test";
import { sanitizeName, applyRenameToContent } from "../rename-agents-zh";

test("sanitizeName 替换非法字符并截断", () => {
  expect(sanitizeName("代码审查/专家: v2", "fb")).toBe("代码审查-专家- v2");
  expect(sanitizeName(" 前后空格  ", "fb")).toBe("前后空格");
});

test("sanitizeName 保留中文与专有名词", () => {
  expect(sanitizeName("Gemini", "fb")).toBe("Gemini");
  expect(sanitizeName("人生教练", "fb")).toBe("人生教练");
});

test("sanitizeName 空名与 Windows 保留名兜底", () => {
  expect(sanitizeName(".", "Agent-3")).toBe("Agent-3");
  expect(sanitizeName("CON", "Agent-9")).toBe("Agent-9");
});

test("sanitizeName 超长中文名截断", () => {
  const long = "超".repeat(300);
  expect([...sanitizeName(long, "fb")].length).toBe(120);
});

test("applyRenameToContent 替换 displayName 并插入 Original 注释", () => {
  const content = [
    "---",
    "displayName: Linux Terminal",
    "avatar: \"🤖\"",
    "---",
    "",
    "body text",
  ].join("\n");
  const out = applyRenameToContent(content, "Linux 终端", "Linux Terminal");
  expect(out).toContain("displayName: Linux 终端");
  expect(out).toContain("# Original: Linux Terminal");
  expect(out).toContain("body text");
  // displayName 行只替换一次，Original 注释在 frontmatter 顶部
  expect(out.match(/displayName:/g)).toHaveLength(1);
});

test("applyRenameToContent 幂等：已含 Original 注释的输入不重复插入", () => {
  const content = [
    "---",
    "# Original: Linux Terminal",
    "displayName: Linux 终端",
    "---",
  ].join("\n");
  const out = applyRenameToContent(content, "Linux 终端2", "Linux Terminal");
  expect(out.match(/# Original:/g)).toHaveLength(1);
  expect(out).toContain("displayName: Linux 终端2");
});
