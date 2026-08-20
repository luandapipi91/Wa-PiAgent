import { test, expect } from "bun:test";
import { buildPreviewUrl, isHtmlPath } from "./preview-url";

test("isHtmlPath 命中 .html / .htm", () => {
  expect(isHtmlPath("/a/b/index.html")).toBe(true);
  expect(isHtmlPath("/a/b/page.htm")).toBe(true);
  expect(isHtmlPath("/a/b/style.css")).toBe(false);
  expect(isHtmlPath("/a/b/readme.md")).toBe(false);
});

test("buildPreviewUrl 编码目录、保留文件名", () => {
  expect(buildPreviewUrl("/a/b/dist/index.html")).toBe(
    `/preview/${encodeURIComponent("/a/b/dist")}/index.html`,
  );
});

test("buildPreviewUrl 处理中文与空格", () => {
  const url = buildPreviewUrl("/我的 项目/dist/index.html");
  expect(url.startsWith("/preview/")).toBe(true);
  expect(url.endsWith("/index.html")).toBe(true);
  expect(url.includes(encodeURIComponent("/我的 项目/dist"))).toBe(true);
});

test("buildPreviewUrl 处理 Windows 反斜杠", () => {
  expect(buildPreviewUrl("C:\\proj\\dist\\index.html")).toBe(
    `/preview/${encodeURIComponent("C:\\proj\\dist")}/index.html`,
  );
});
