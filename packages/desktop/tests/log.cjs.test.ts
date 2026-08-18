// 日志容量上限测试：超过 maxBytes 后 FIFO 丢弃最旧的行，文件永不超限。
import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore 无类型的 cjs 模块
import { createLogger } from "../src/util/log.cjs";

async function withTempLog(fn: (logPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "wapi-log-test-"));
  try {
    await fn(join(dir, "desktop.log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("写入追加带时间戳与级别，flush 后落盘", async () => {
  await withTempLog(async (logPath) => {
    const log = createLogger(logPath);
    log.info("hello");
    log.error("boom", new Error("x"));
    await log.flush();
    const content = await readFile(logPath, "utf8");
    expect(content).toContain("] INFO hello\n");
    expect(content).toContain("] ERROR boom Error: x");
  });
});

test("超过 maxBytes 后 FIFO：文件不超限，最旧的行被丢弃，最新行保留且无半截行", async () => {
  await withTempLog(async (logPath) => {
    // max=200B, keep=100B；每行约 40B（[ts] INFO line-N...）
    const log = createLogger(logPath, 200, 100);
    for (let i = 0; i < 20; i++) log.info(`line-${String(i).padStart(2, "0")}`);
    await log.flush();
    const content = await readFile(logPath, "utf8");
    expect(content.length).toBeLessThanOrEqual(200);
    expect(content).toContain("line-19"); // 最新必在
    expect(content).not.toContain("line-00"); // 最旧已被 FIFO 丢弃
    // 首行必须是完整行（按换行对齐裁剪，不留半截行）
    expect(content.startsWith("[")).toBe(true);
    // 每一行都是完整的 [ts] LEVEL msg 格式
    for (const line of content.trim().split("\n")) {
      expect(line).toMatch(/^\[.+\] INFO line-\d+$/);
    }
  });
});

test("已有日志文件启动后继续追加：把存量大小计入上限", async () => {
  await withTempLog(async (logPath) => {
    const log1 = createLogger(logPath, 200, 100);
    for (let i = 0; i < 10; i++) log1.info(`old-${String(i).padStart(2, "0")}xx`);
    await log1.flush();
    // 新 logger（模拟重启）：首次写入会 stat 存量并计入上限
    const log2 = createLogger(logPath, 200, 100);
    log2.info("new-line");
    await log2.flush();
    const content = await readFile(logPath, "utf8");
    expect(content.length).toBeLessThanOrEqual(200);
    expect(content).toContain("new-line");
  });
});
