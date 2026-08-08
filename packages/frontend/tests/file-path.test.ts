import { test, expect } from "bun:test";
import { parseFilePath } from "../src/components/blocks/file-path";

test("识别相对/绝对/家目录路径", () => {
  expect(parseFilePath("packages/frontend/src/App.tsx")).toEqual({ path: "packages/frontend/src/App.tsx", line: undefined, col: undefined });
  expect(parseFilePath("/Users/example/x.md")?.path).toBe("/Users/example/x.md");
  expect(parseFilePath("~/docs/a.md")?.path).toBe("~/docs/a.md");
  expect(parseFilePath("./src/b.ts")?.path).toBe("./src/b.ts");
});

test("识别 :行 与 :行:列 后缀", () => {
  expect(parseFilePath("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, col: undefined });
  expect(parseFilePath("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12, col: 3 });
});

test("拒绝非路径", () => {
  expect(parseFilePath("README.md")).toBeNull(); // 无 /，保守不识别
  expect(parseFilePath("hello world")).toBeNull();
  expect(parseFilePath("https://a.com/b.html")).toBeNull();
  expect(parseFilePath("a/b")).toBeNull(); // 末段无扩展名
});
