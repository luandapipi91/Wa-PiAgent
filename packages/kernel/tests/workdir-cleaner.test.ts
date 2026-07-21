import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { cleanupExpiredWorkdirs } from "../src/workdir-cleaner";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS,
} from "@hiagent/shared";

// 用临时根目录替代真实 ~/.hiagent/workdir，避免污染开发机
const TMP_ROOT = join(import.meta.dir, ".tmp-workdir-cleaner-" + Math.random().toString(36).slice(2));

// mock SYSTEM_PROJECT_CWD：通过 monkey-patch 让 cleaner 用 TMP_ROOT
// 注意：cleaner 内部 import 的是常量值，monkey-patch 模块导出不可靠。
// 改用：cleaner 接受可选 root 参数（默认 SYSTEM_PROJECT_CWD），测试注入 TMP_ROOT。
// 实施时按此签名实现。

const DAY_MS = 24 * 60 * 60 * 1000;
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * DAY_MS);
const ONE_DAY_AGO = new Date(Date.now() - 1 * DAY_MS);

async function setMtime(dir: string, when: Date) {
  await utimes(dir, when, when);
}

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
});
afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

test("扫到 8 天前的孤立数字目录 → 删除", async () => {
  const oldDir = join(TMP_ROOT, "1721000000000");
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, "foo.txt"), "hi");
  await setMtime(oldDir, EIGHT_DAYS_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(1);
  expect(existsSync(oldDir)).toBe(false);
});

test("扫到 1 天前的目录 → 不删（未超 TTL）", async () => {
  const recentDir = join(TMP_ROOT, "1721000000001");
  await mkdir(recentDir, { recursive: true });
  await setMtime(recentDir, ONE_DAY_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(recentDir)).toBe(true);
});

test("8 天前但被现存 session 引用的目录 → 不删", async () => {
  const referenced = join(TMP_ROOT, "1721000000002");
  await mkdir(referenced, { recursive: true });
  await setMtime(referenced, EIGHT_DAYS_AGO);

  const f = join(TMP_ROOT, "projects.json");
  const store = new ProjectStore(f);
  // 系统项目 + 一个引用该目录的 session
  await store.createSystemProject({
    id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: TMP_ROOT,
  });
  await store.createSession({
    projectId: SYSTEM_PROJECT_ID, primaryAgent: "dev", title: "引用目录的会话",
    createdAt: 1721000000002,  // ← 与目录名一致
  });

  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(referenced)).toBe(true);
});

test("非数字命名的目录 → 不动", async () => {
  const weirdDir = join(TMP_ROOT, "not-a-timestamp");
  await mkdir(weirdDir, { recursive: true });
  await setMtime(weirdDir, EIGHT_DAYS_AGO);

  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, TMP_ROOT);
  expect(cleaned).toBe(0);
  expect(existsSync(weirdDir)).toBe(true);
});

test("根目录不存在 → 返回 0 不抛错", async () => {
  const store = new ProjectStore(join(TMP_ROOT, "projects.json"));
  const cleaned = await cleanupExpiredWorkdirs(store, join(TMP_ROOT, "does-not-exist"));
  expect(cleaned).toBe(0);
});
