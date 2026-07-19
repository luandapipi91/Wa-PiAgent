import { test, expect } from "bun:test";
import { detectTrigger, filterItems } from "../src/quick-invoke/trigger";

test("detectTrigger 检测 @ 触发智能体", () => {
  const result = detectTrigger("hello @审");
  expect(result).toEqual({ type: "agent", query: "审" });
});

test("detectTrigger 检测 # 触发文件", () => {
  const result = detectTrigger("打开 #src/comp");
  expect(result).toEqual({ type: "file", query: "src/comp" });
});

test("detectTrigger 检测 $ 触发符", () => {
  const result = detectTrigger("用 $brain");
  expect(result).toEqual({ type: "skill", query: "brain" });
});

test("detectTrigger 空查询返回空 query", () => {
  expect(detectTrigger("text @")).toEqual({ type: "agent", query: "" });
  expect(detectTrigger("text #")).toEqual({ type: "file", query: "" });
});

test("detectTrigger 行首触发", () => {
  expect(detectTrigger("@agent")).toEqual({ type: "agent", query: "agent" });
  expect(detectTrigger("#file")).toEqual({ type: "file", query: "file" });
});

test("detectTrigger 无触发符返回 null", () => {
  expect(detectTrigger("普通文本")).toBeNull();
});

test("detectTrigger 文本中间的 @ 不触发（前面需空格或行首）", () => {
  expect(detectTrigger("email@test")).toBeNull();
});

test("detectTrigger chip token 不触发", () => {
  expect(detectTrigger("@[代码审查] 你好")).toBeNull();
  expect(detectTrigger("#[file.ts] 你好")).toBeNull();
});

test("detectTrigger chip token 后新触发符正常触发", () => {
  // @[...] / #[...] 是已存在的 chip token，不应干扰新触发检测
  expect(detectTrigger("@[代码审查] @other")).toEqual({ type: "agent", query: "other" });
  expect(detectTrigger("#[file.ts] #other")).toEqual({ type: "file", query: "other" });
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
