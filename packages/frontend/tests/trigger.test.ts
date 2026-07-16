import { test, expect } from "bun:test";
import { detectTrigger, filterItems } from "../src/quick-invoke/trigger";

test("detectTrigger 检测 @ 触发符", () => {
  const result = detectTrigger("hello @App");
  expect(result).toEqual({ type: "file", query: "App" });
});

test("detectTrigger 检测 $ 触发符", () => {
  const result = detectTrigger("用 $brain");
  expect(result).toEqual({ type: "skill", query: "brain" });
});

test("detectTrigger 空查询返回空 query", () => {
  const result = detectTrigger("text @");
  expect(result).toEqual({ type: "file", query: "" });
});

test("detectTrigger 行首 @ 触发", () => {
  const result = detectTrigger("@file");
  expect(result).toEqual({ type: "file", query: "file" });
});

test("detectTrigger 无触发符返回 null", () => {
  expect(detectTrigger("普通文本")).toBeNull();
});

test("detectTrigger 文本中间的 @ 不触发（前面需空格或行首）", () => {
  expect(detectTrigger("email@test")).toBeNull();
});

test("detectTrigger chip token 后不触发", () => {
  // @[file.ts] 是已存在的 chip token，不应触发新面板
  expect(detectTrigger("@[file.ts] @other")).toEqual({ type: "file", query: "other" });
});

test("filterItems 按名称模糊匹配", () => {
  const items = [
    { name: "App.tsx", description: "" },
    { name: "index.ts", description: "" },
    { name: "application.js", description: "" },
  ];
  const result = filterItems(items, "app");
  expect(result.map(r => r.name)).toEqual(["App.tsx", "application.js"]);
});

test("filterItems 空查询返回全部", () => {
  const items = [{ name: "A", description: "" }, { name: "B", description: "" }];
  expect(filterItems(items, "")).toHaveLength(2);
});

test("filterItems 大小写不敏感", () => {
  const items = [{ name: "BrainStorm", description: "" }];
  expect(filterItems(items, "brain")).toHaveLength(1);
});
