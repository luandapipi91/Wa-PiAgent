import { test, expect } from "bun:test";
import {
  FILE_TOKEN_RE, SKILL_TOKEN_RE,
  expandTokens, textToSegments, segmentsToText, textToHtml, escapeHtml,
} from "../src/quick-invoke/tokens";

test("expandTokens 展开文件 token", () => {
  expect(expandTokens("看这个 @[packages/App.tsx] 文件")).toBe("看这个 @packages/App.tsx 文件");
});

test("expandTokens 展开技能 token", () => {
  expect(expandTokens("用 $[brainstorming] 技能")).toBe("用 $brainstorming 技能");
});

test("expandTokens 同时展开文件和技能 token", () => {
  expect(expandTokens("@[a.tsx] 和 $[my-skill]")).toBe("@a.tsx 和 $my-skill");
});

test("expandTokens 无 token 时原样返回", () => {
  expect(expandTokens("普通文本")).toBe("普通文本");
});

test("textToSegments 拆分文本和 chip", () => {
  const segs = textToSegments("hello @[file.ts] world");
  expect(segs).toEqual([
    { type: "text", value: "hello " },
    { type: "file", value: "file.ts" },
    { type: "text", value: " world" },
  ]);
});

test("textToSegments 识别技能 chip", () => {
  const segs = textToSegments("$[my-skill]");
  expect(segs).toEqual([{ type: "skill", value: "my-skill" }]);
});

test("segmentsToText 与 textToSegments 可逆", () => {
  const original = "看 @[a.ts] 和 $[skill]";
  const segs = textToSegments(original);
  expect(segmentsToText(segs)).toBe(original);
});

test("escapeHtml 转义 HTML 特殊字符", () => {
  expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("textToHtml 渲染文件 chip 为 span", () => {
  const html = textToHtml("@[App.tsx]");
  expect(html).toContain("data-token=\"@[App.tsx]\"");
  expect(html).toContain("@App.tsx");
  expect(html).toContain("chip-file");
});

test("textToHtml 渲染技能 chip 为 span", () => {
  const html = textToHtml("$[brainstorm]");
  expect(html).toContain("data-token=\"$[brainstorm]\"");
  expect(html).toContain("$brainstorm");
  expect(html).toContain("chip-skill");
});

test("textToHtml 转义普通文本中的 HTML", () => {
  const html = textToHtml("<b>bold</b>");
  expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
});
