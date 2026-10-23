import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  devBunCacheDir,
  cachedBunPath,
  isUsableBunFile,
  bunVersionOf,
} from "../bun-dev-runtime";

const ORIG = { env: { ...process.env }, platform: process.platform };

afterEach(() => {
  process.env = { ...ORIG.env };
});

test("devBunCacheDir: WA_PI_BUN_CACHE_DIR 覆盖时优先", () => {
  process.env.WA_PI_BUN_CACHE_DIR = "D:\\custom\\bun";
  expect(devBunCacheDir()).toBe("D:\\custom\\bun");
});

test("devBunCacheDir: Windows 下用 %LOCALAPPDATA%\\wa-pi\\bun", () => {
  delete process.env.WA_PI_BUN_CACHE_DIR;
  process.env.LOCALAPPDATA = "C:\\Users\\co\\AppData\\Local";
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  expect(devBunCacheDir()).toBe("C:\\Users\\co\\AppData\\Local\\wa-pi\\bun");
  Object.defineProperty(process, "platform", {
    value: ORIG.platform,
    configurable: true,
  });
});

test("devBunCacheDir: POSIX 下用 ~/.cache/wa-pi/bun", () => {
  delete process.env.WA_PI_BUN_CACHE_DIR;
  delete process.env.LOCALAPPDATA;
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  // 注入固定 HOME 保证可测；期望值用 join 构造以兼容 Windows 分隔符差异
  process.env.HOME = "/home/test";
  expect(devBunCacheDir()).toBe(join("/home/test", ".cache", "wa-pi", "bun"));
  Object.defineProperty(process, "platform", {
    value: ORIG.platform,
    configurable: true,
  });
});

test("cachedBunPath: 与缓存目录 + 平台资产 bin 一致", () => {
  process.env.WA_PI_BUN_CACHE_DIR = "C:\\cache";
  const p = cachedBunPath();
  expect(p).toContain("C:\\cache");
  // win32 下 bin 应为 bun.exe
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  expect(cachedBunPath()).toContain("bun.exe");
  Object.defineProperty(process, "platform", {
    value: ORIG.platform,
    configurable: true,
  });
});

test("isUsableBunFile: 不存在 → false", () => {
  expect(isUsableBunFile(join(tmpdir(), "no-such-bun-xyz"))).toBe(false);
});

test("isUsableBunFile: 小于 1MB 视为损坏 → false", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-dev-test-"));
  const f = join(dir, "bun.exe");
  writeFileSync(f, "tiny");
  try {
    expect(isUsableBunFile(f)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isUsableBunFile: 大于 1MB → true", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-dev-test-"));
  const f = join(dir, "bun.exe");
  writeFileSync(f, Buffer.alloc(1_100_000));
  try {
    expect(isUsableBunFile(f)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bunVersionOf: 当前进程 bun 返回版本", async () => {
  const v = await bunVersionOf(process.execPath);
  expect(v).not.toBeNull();
  expect(v).toMatch(/^\d+\.\d+\.\d+/);
});

test("bunVersionOf: 不存在的路径返回 null", async () => {
  expect(await bunVersionOf(join(tmpdir(), "no-such-bun-xyz"))).toBeNull();
});
