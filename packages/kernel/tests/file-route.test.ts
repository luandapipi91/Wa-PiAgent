import { test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { resolveUploadFile } from "../src/ws-server";

const projects = [{ cwd: "/home/me/proj" }];

test("uploads 下的文件返回绝对路径", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/home/me/proj/.hiagent/uploads/a.webm"));
  // 期望路径按当前平台解析（POSIX 原样 / Windows 带盘符），与 resolveUploadFile 的 resolve 语义一致
  expect(resolveUploadFile(u, projects)).toBe(resolve("/home/me/proj/.hiagent/uploads/a.webm"));
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

test("文件名含 .. 但最终落在 uploads 内应放行", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/home/me/proj/.hiagent/uploads/clip..take2.webm"));
  expect(resolveUploadFile(u, projects)).toBe(resolve("/home/me/proj/.hiagent/uploads/clip..take2.webm"));
});
