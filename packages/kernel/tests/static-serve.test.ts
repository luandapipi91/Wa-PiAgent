import { test, expect } from "bun:test";
import { getMimeType, resolveStaticPath } from "../src/ws-server";

test("resolveStaticPath: 干净路径返回 index.html", () => {
  expect(resolveStaticPath("/", "/web")).toBe("/web/index.html");
  expect(resolveStaticPath("/foo/bar", "/web")).toBe("/web/index.html");
});

test("resolveStaticPath: 已知资产返回拼好的路径", () => {
  expect(resolveStaticPath("/assets/x.js", "/web")).toBe("/web/assets/x.js");
});

test("resolveStaticPath: 拒绝路径穿越", () => {
  expect(resolveStaticPath("/../../etc/passwd", "/web")).toBe("/web/index.html");
});

test("getMimeType: 常见类型", () => {
  expect(getMimeType("a.html")).toBe("text/html");
  expect(getMimeType("a.js")).toBe("text/javascript");
  expect(getMimeType("a.css")).toBe("text/css");
  expect(getMimeType("a.svg")).toBe("image/svg+xml");
  expect(getMimeType("a.webm")).toBe("audio/webm");
  expect(getMimeType("a.weba")).toBe("audio/webm");
});
