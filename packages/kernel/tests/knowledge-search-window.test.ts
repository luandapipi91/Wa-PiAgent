import { test, expect } from "bun:test";
import { expandWindow, WINDOW_MAX_CHARS } from "../src/knowledge/search/window";

test("同文件邻块按 ±1 展开并合并，总字符不超预算", () => {
  const rows = [
    { id: "1", filePath: "a.md", startLine: 1, endLine: 10, content: "第一段", score: 0.9 },
    // 输入约定：命中块 score > 0；纯上下文邻块 score = 0
    { id: "2", filePath: "a.md", startLine: 11, endLine: 20, content: "第二段", score: 0 },
    { id: "3", filePath: "a.md", startLine: 21, endLine: 30, content: "第三段", score: 0 },
  ];
  const out = expandWindow(rows, 1);
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("1");
  expect(out[0].content).toContain("第一段");
  expect(out[0].content).toContain("第二段");
  expect(out[0].content.length).toBeLessThanOrEqual(WINDOW_MAX_CHARS);
});

test("预算不足时不扩窗，返回原命中", () => {
  const rows = [
    { id: "1", filePath: "a.md", startLine: 1, endLine: 2, content: "x".repeat(WINDOW_MAX_CHARS), score: 0.9 },
    { id: "2", filePath: "a.md", startLine: 3, endLine: 4, content: "第二段", score: 0 },
  ];
  const out = expandWindow(rows, 1);
  expect(out).toHaveLength(1);
  expect(out[0].content).toBe("x".repeat(WINDOW_MAX_CHARS));
});

test("预算不足回退时行号跟着退回命中块（lines 与 content 一致）", () => {
  const rows = [
    { id: "1", filePath: "a.md", startLine: 1, endLine: 10, content: "上下文", score: 0 },
    { id: "2", filePath: "a.md", startLine: 11, endLine: 20, content: "x".repeat(WINDOW_MAX_CHARS), score: 1 },
  ];
  const out = expandWindow(rows, 1);
  expect(out).toHaveLength(1);
  expect(out[0].startLine).toBe(11);
  expect(out[0].endLine).toBe(20);
});
