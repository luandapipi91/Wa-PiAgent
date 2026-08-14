import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalMemoryStore,
  getProjectMemoryStore,
  projectNameFromCwd,
  createMemoryTools,
  createAgentMemoryTools,
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

test("字符上限覆盖：user 1800 / memory 3200（amaster 默认 1375/2200）", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  // 1400 字符：超过 amaster 默认 user 上限（1375）但低于覆盖后的 1800，应写入成功
  await store.add("user", "u".repeat(1400));
  expect(await store.entries("user")).toContain("u".repeat(1400));

  // 2300 字符：超过 amaster 默认 memory 上限（2200）但低于覆盖后的 3200，应写入成功
  await store.add("memory", "m".repeat(2300));
  expect(await store.entries("memory")).toContain("m".repeat(2300));
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

test("snapshotAll 合并 memory + user 快照", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  await store.add("memory", "记忆条目");
  await store.add("user", "用户条目");

  const all = await store.snapshotAll();
  expect(all).toContain("记忆条目");
  expect(all).toContain("用户条目");
});

test("snapshotAll 无内容时返回空串", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  expect(await store.snapshotAll()).toBe("");
});

test("raw 暴露底层 MemoryStore 供 createMemoryTools 使用", async () => {
  const store = getGlobalMemoryStore(tmpDir);
  expect(store.raw).toBeTruthy();
  expect(typeof store.raw.add).toBe("function");

  // createMemoryTools 绑定 raw 后返回 4 个 tool
  const tools = createMemoryTools(store.raw);
  const names = tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(["memory_add", "memory_replace", "memory_remove", "memory_read"]));
});

test("createAgentMemoryTools：默认 scope（user→全局，memory→项目）", async () => {
  const globalStore = getGlobalMemoryStore(tmpDir);
  const projectStore = getProjectMemoryStore(tmpDir, join(tmpDir, "my-app"));
  const tools = createAgentMemoryTools(globalStore, projectStore);
  const addTool = tools.find((t: any) => t.name === "memory_add") as any;

  // target=user 默认 → 全局 USER.md
  await addTool.execute("call1", { target: "user", content: "用户名 co" }, undefined, undefined, undefined);
  expect(await globalStore.entries("user")).toContain("用户名 co");
  expect(await projectStore.entries("user")).not.toContain("用户名 co");

  // target=memory 默认 → 项目 MEMORY.md
  await addTool.execute("call2", { target: "memory", content: "项目用 pnpm" }, undefined, undefined, undefined);
  expect(await projectStore.entries("memory")).toContain("项目用 pnpm");
  expect(await globalStore.entries("memory")).not.toContain("项目用 pnpm");
});

test("createAgentMemoryTools：显式 scope 覆盖默认路由", async () => {
  const globalStore = getGlobalMemoryStore(tmpDir);
  const projectStore = getProjectMemoryStore(tmpDir, join(tmpDir, "my-app"));
  const tools = createAgentMemoryTools(globalStore, projectStore);
  const addTool = tools.find((t: any) => t.name === "memory_add") as any;

  // target=memory + scope=global → 全局 MEMORY.md（默认本是项目）
  await addTool.execute("c1", { target: "memory", scope: "global", content: "全局工作笔记" }, undefined, undefined, undefined);
  expect(await globalStore.entries("memory")).toContain("全局工作笔记");
  expect(await projectStore.entries("memory")).not.toContain("全局工作笔记");

  // target=user + scope=project → 项目 USER.md（默认本是全局）
  await addTool.execute("c2", { target: "user", scope: "project", content: "项目用户设定" }, undefined, undefined, undefined);
  expect(await projectStore.entries("user")).toContain("项目用户设定");
  expect(await globalStore.entries("user")).not.toContain("项目用户设定");
});

test("createAgentMemoryTools：memory_read 按 scope 读对应 store", async () => {
  const globalStore = getGlobalMemoryStore(tmpDir);
  const projectStore = getProjectMemoryStore(tmpDir, join(tmpDir, "my-app"));
  await globalStore.add("memory", "全局M");
  await projectStore.add("memory", "项目M");
  const tools = createAgentMemoryTools(globalStore, projectStore);
  const readTool = tools.find((t: any) => t.name === "memory_read") as any;

  const g = await readTool.execute("r1", { target: "memory", scope: "global" }, undefined, undefined, undefined);
  expect(JSON.stringify(g)).toContain("全局M");
  expect(JSON.stringify(g)).not.toContain("项目M");

  const p = await readTool.execute("r2", { target: "memory", scope: "project" }, undefined, undefined, undefined);
  expect(JSON.stringify(p)).toContain("项目M");
});

test("projectNameFromCwd 处理 Windows 反斜杠与尾部分隔符", () => {
  expect(projectNameFromCwd("H:\\repo\\my-app")).toBe("my-app");
  expect(projectNameFromCwd("/home/u/my-app/")).toBe("my-app");
  expect(projectNameFromCwd("solo")).toBe("solo");
});

test("projectNameFromCwd 净化盘根等非法字符，避免 mkdir 失败", () => {
  expect(projectNameFromCwd("H:")).toBe("H");
  expect(projectNameFromCwd("H:\\")).toBe("H");
  expect(projectNameFromCwd("D:\\proj<bad>|name")).toBe("projbadname");
  // 全部被净化掉时回退 default
  expect(projectNameFromCwd(":")).toBe("default");
});

test("盘根 cwd 的项目记忆目录可正常写入与读取", async () => {
  const store = getProjectMemoryStore(tmpDir, "H:");
  await store.add("memory", "盘根项目记忆");
  // 目录应为 projects-memory/H（不含冒号）
  expect(store.dir).toBe(join(tmpDir, "projects-memory", "H"));
  expect(await store.entries("memory")).toContain("盘根项目记忆");
});
