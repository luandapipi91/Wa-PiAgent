import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// crash-logger：把未捕获异常/unhandledRejection 的堆栈追加写入日志文件，
// 供后续跟踪（历史 bug：kernel 崩溃 code=null 无任何线索）。
let dir: string;

beforeEach(async () => {
  dir = `${tmpdir()}/wa-pi-crash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("createCrashLogger: 写入日志含时间戳与堆栈，目录自动创建", async () => {
  const { createCrashLogger } = await import("../src/crash-logger");
  const logPath = join(dir, "nested", "kernel-crash.log");
  const log = createCrashLogger(logPath);
  const err = new Error("测试崩溃");
  log.unhandledRejection(err);
  await log.flush();
  const content = await readFile(logPath, "utf8");
  expect(content).toContain("unhandledRejection");
  expect(content).toContain("测试崩溃");
  expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/); // 含时间戳
  expect(content).toContain("at "); // 含堆栈
});

test("createCrashLogger: uncaughtException 与 unhandledRejection 分别记录类型", async () => {
  const { createCrashLogger } = await import("../src/crash-logger");
  const logPath = join(dir, "kernel-crash.log");
  const log = createCrashLogger(logPath);
  log.uncaughtException(new Error("boom1"));
  log.unhandledRejection(new Error("boom2"));
  await log.flush();
  const content = await readFile(logPath, "utf8");
  expect(content).toContain("uncaughtException");
  expect(content).toContain("boom1");
  expect(content).toContain("unhandledRejection");
  expect(content).toContain("boom2");
});

test("createCrashLogger: 非错误值也能安全记录（不抛）", async () => {
  const { createCrashLogger } = await import("../src/crash-logger");
  const logPath = join(dir, "kernel-crash.log");
  const log = createCrashLogger(logPath);
  expect(() => log.unhandledRejection("纯字符串原因")).not.toThrow();
  expect(() => log.unhandledRejection({ custom: "对象" })).not.toThrow();
  await log.flush();
  const content = await readFile(logPath, "utf8");
  expect(content).toContain("纯字符串原因");
});

test("createCrashLogger: flush 等齐多次并发写入", async () => {
  const { createCrashLogger } = await import("../src/crash-logger");
  const logPath = join(dir, "kernel-crash.log");
  const log = createCrashLogger(logPath);
  for (let i = 0; i < 10; i++) log.unhandledRejection(new Error(`e${i}`));
  await log.flush();
  const content = await readFile(logPath, "utf8");
  for (let i = 0; i < 10; i++) expect(content).toContain(`e${i}`);
});
