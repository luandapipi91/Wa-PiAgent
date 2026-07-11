import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalMemoryStore,
  getProjectMemoryStore,
  projectNameFromCwd,
} from "../src/amaster-memory";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "amaster-memory-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("global store 写入后 entries 能读回", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "全局偏好：用 pnpm");

  const entries = await store.entries("memory");
  expect(entries).toContain("全局偏好：用 pnpm");
});

test("global store 目录落在 memories/global", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "x");
  expect(existsSync(join(tmpDir, "memories", "global", "MEMORY.md"))).toBe(true);
  expect(store.dir).toBe(join(tmpDir, "memories", "global"));
});

test("project store 按 cwd basename 隔离目录且不串到全局", async () => {
  const projectCwd = join(tmpDir, "repos", "my-app");
  const store = getProjectMemoryStore(tmpDir, projectCwd);
  await store.add("memory", "项目用 Tailwind");

  expect(store.dir).toBe(join(tmpDir, "projects-memory", "my-app"));
  const entries = await store.entries("memory");
  expect(entries).toContain("项目用 Tailwind");

  const globalStore = getGlobalMemoryStore(tmpDir);
  const globalEntries = await globalStore.entries("memory");
  expect(globalEntries).not.toContain("项目用 Tailwind");
});

test("两个不同 basename 的项目互不干扰", async () => {
  const a = getProjectMemoryStore(tmpDir, join(tmpDir, "repos", "alpha"));
  const b = getProjectMemoryStore(tmpDir, join(tmpDir, "repos", "beta"));
  await a.add("memory", "alpha 记忆");
  await b.add("memory", "beta 记忆");

  expect(await a.entries("memory")).toContain("alpha 记忆");
  expect(await a.entries("memory")).not.toContain("beta 记忆");
  expect(await b.entries("memory")).toContain("beta 记忆");
});

test("snapshot 返回非空且包含内容（注入系统提示词用）", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "记住用 TypeScript");

  const snapshot = await store.snapshot("memory");
  expect(snapshot).toContain("记住用 TypeScript");
});

test("user target 写入 USER.md 而非 MEMORY.md", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("user", "用户喜欢深色主题");

  expect(existsSync(join(tmpDir, "memories", "global", "USER.md"))).toBe(true);
  expect(await store.entries("user")).toContain("用户喜欢深色主题");
});

test("replace 按 oldText 精确匹配并更新", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "旧内容");

  const ok = await store.replace("memory", "旧内容", "新内容");
  expect(ok).toBe(true);

  const entries = await store.entries("memory");
  expect(entries).toContain("新内容");
  expect(entries).not.toContain("旧内容");
});

test("replace 未命中时返回 false 而不抛错", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "存在的");

  const ok = await store.replace("memory", "不存在的", "x");
  expect(ok).toBe(false);
});

test("remove 按 oldText 删除", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "待删除");

  const ok = await store.remove("memory", "待删除");
  expect(ok).toBe(true);

  const entries = await store.entries("memory");
  expect(entries).not.toContain("待删除");
});

test("amaster 持久化为 § 分隔格式，可被外部按 § 解析", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "第一条");
  await store.add("memory", "第二条");

  const raw = readFileSync(join(tmpDir, "memories", "global", "MEMORY.md"), "utf8");
  expect(raw).toContain("§");
  expect(raw.split("§").length).toBeGreaterThanOrEqual(2);
});

test("projectNameFromCwd 处理 Windows 反斜杠与尾部分隔符", () => {
  expect(projectNameFromCwd("H:\\repo\\my-app")).toBe("my-app");
  expect(projectNameFromCwd("/home/u/my-app/")).toBe("my-app");
  expect(projectNameFromCwd("solo")).toBe("solo");
});
