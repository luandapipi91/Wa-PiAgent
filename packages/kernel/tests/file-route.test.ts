import { test, expect } from "bun:test";
import { resolveUploadFile } from "../src/ws-server";

const projects = [{ cwd: "/home/me/proj" }];

test("uploads 下的文件返回绝对路径", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/home/me/proj/.hiagent/uploads/a.webm"));
  expect(resolveUploadFile(u, projects)).toBe("/home/me/proj/.hiagent/uploads/a.webm");
});

test("路径穿越（..）到 uploads 外被拒", () => {
  const malicious = "/home/me/proj/.hiagent/uploads/../../etc/passwd";
  const u = new URL("http://x/file?path=" + encodeURIComponent(malicious));
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("不在任意项目 uploads 下被拒", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/etc/passwd"));
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("缺少 path 参数返回 null", () => {
  const u = new URL("http://x/file");
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("多个项目：命中其中任一 uploads 即放行", () => {
  const multi = [{ cwd: "/a" }, { cwd: "/b" }];
  const u = new URL("http://x/file?path=" + encodeURIComponent("/b/.hiagent/uploads/x.webm"));
  expect(resolveUploadFile(u, multi)).toBe("/b/.hiagent/uploads/x.webm");
});
