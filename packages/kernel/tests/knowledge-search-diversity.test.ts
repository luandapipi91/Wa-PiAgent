import { test, expect } from "bun:test";
import { diversify, interleaveByFile } from "../src/knowledge/search/diversity";

test("同一文件最多保留 2 条，其余让位给其他文件", () => {
  const items = [
    { chunkId: "a1", score: 0.9, filePath: "a.md", content: "甲一" },
    { chunkId: "a2", score: 0.8, filePath: "a.md", content: "甲二" },
    { chunkId: "a3", score: 0.7, filePath: "a.md", content: "甲三" },
    { chunkId: "b1", score: 0.6, filePath: "b.md", content: "乙一" },
  ];
  const out = interleaveByFile(items, 2);
  expect(out.filter((i) => i.filePath === "a.md").length).toBe(2);
  expect(out.some((i) => i.filePath === "b.md")).toBe(true);
});

test("MMR 去重：内容高度相似的两块只留一块，给不同文件让位", () => {
  const items = [
    { chunkId: "x1", score: 0.9, filePath: "x.md", content: "定价政策：按年订阅九折。" },
    { chunkId: "x2", score: 0.88, filePath: "x.md", content: "定价政策：按年订阅九折。" }, // 近似重复
    { chunkId: "y1", score: 0.6, filePath: "y.md", content: "退款流程需要提交工单。" },
  ];
  const out = diversify(items, { limit: 3, maxPerFile: 2, lambda: 0.7 });
  expect(out.map((i) => i.chunkId)).toEqual(["x1", "y1"]);
});
