// MemoryStore（UI 记忆服务）测试：读写全部走 SQLite DAO
//
// 与旧实现的差异（本文件断言的即为新契约）：
// - entry id 是 DAO 的 uuid，不再是 "<relPath>:<rawIndex>"
// - 归档不再是 sidecar JSON，而是 DB 的 archived 标记
// - sourceFile / rawIndex 已废弃，恒为 undefined
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory-store";
import { MemoryDao } from "../src/memory/dao";
import { closeAllMemoryDbs, openMemoryDb } from "../src/memory/db";
import { KernelError } from "../src/kernel-error";
import type { ProjectStore } from "../src/project-store";
import type { ArchivedMemory } from "@wa-pi/shared";

let tmpDir: string;

// 每个用例独立临时目录 + 关掉模块级连接缓存：DB 连接被缓存，若复用同一路径
// 而目录被删，后续写入会落进已 unlink 的旧文件（读到的还是老数据）。
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-"));
});

afterEach(() => {
  closeAllMemoryDbs();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** mock ProjectStore：p1 → cwd，用于 projectId（UI id）到项目名的解析 */
function mockProjectStore(cwd: string): ProjectStore {
  return {
    async load() {
      return {
        projects: [{ id: "p1", name: "test", cwd, createdAt: "" }],
        sessions: [],
      };
    },
  } as unknown as ProjectStore;
}

function makeStore(cwd = "/fake"): MemoryStore {
  return new MemoryStore({
    waPiDir: tmpDir,
    projectStore: mockProjectStore(cwd),
  });
}

/** 直接经 DAO 种数据（覆盖 store.add 写不到的 target/kind 组合） */
function seed(rows: Array<Partial<Parameters<MemoryDao["insert"]>[0]>>): void {
  const dao = new MemoryDao(openMemoryDb(tmpDir));
  for (const r of rows) {
    dao.insert({
      kind: "knowledge",
      target: "memory",
      scope: "global",
      content: "seed",
      source: "test",
      ...r,
    });
  }
}

/** 断言 promise 以指定 KernelError code 失败 */
async function expectKernelCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(KernelError);
  expect((err as KernelError).code).toBe(code);
}

const UUID_RE = /^[0-9a-f-]{36}$/;
const isIso = (s: unknown) =>
  typeof s === "string" && !Number.isNaN(Date.parse(s)) && s.includes("T");

// ===== list =====

test("list 返回全局条目：uuid id、kind、ISO 时间戳，sourceFile/rawIndex 已废弃", async () => {
  const store = makeStore();
  await store.add("global", "项目用 pnpm");

  const { memories, archived } = await store.list();
  expect(archived).toEqual([]);
  expect(memories).toHaveLength(1);

  const entry = memories[0];
  expect(entry.text).toBe("项目用 pnpm");
  expect(entry.id).toMatch(UUID_RE);
  expect(entry.scope).toBe("global");
  expect(entry.kind).toBe("knowledge");
  expect(isIso(entry.createdAt)).toBe(true);
  expect(isIso(entry.updatedAt)).toBe(true);
  expect(entry.projectId).toBeUndefined();
  expect(entry.sourceFile).toBeUndefined();
  expect(entry.rawIndex).toBeUndefined();
});

test("list USER 类条目 kind=profile", async () => {
  seed([
    {
      target: "user",
      kind: "profile",
      scope: "global",
      content: "偏好简洁回答",
    },
    { target: "user", kind: "profile", scope: "global", content: "用中文" },
  ]);

  const { memories } = await makeStore().list();
  const users = memories.filter((m) => m.kind === "profile");
  expect(users).toHaveLength(2);
  expect(users.every((u) => u.kind === "profile" && u.scope === "global")).toBe(
    true,
  );
  expect(users.map((u) => u.text).sort()).toEqual(["偏好简洁回答", "用中文"]);
});

test("list 合并全局与当前项目；不传 projectId 只返回全局", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "全局记忆");
  await store.add("project", "项目记忆", "p1");

  const withProject = await store.list("p1");
  expect(withProject.memories.map((m) => m.text).sort()).toEqual([
    "全局记忆",
    "项目记忆",
  ]);
  const projectEntry = withProject.memories.find((m) => m.scope === "project")!;
  // projectId 列存的是项目名（cwd basename），不是 UI 的 project id
  expect(projectEntry.projectId).toBe("my-app");

  const globalOnly = await store.list();
  expect(globalOnly.memories.every((m) => m.scope === "global")).toBe(true);
  expect(
    globalOnly.memories.find((m) => m.text === "项目记忆"),
  ).toBeUndefined();
});

test("list 空库返回空数组", async () => {
  const { memories, archived } = await makeStore().list();
  expect(memories).toEqual([]);
  expect(archived).toEqual([]);
});

test("list 未知 projectId 时只返回全局，不抛错", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "全局A");
  await store.add("project", "项目A", "p1");

  const { memories } = await store.list("nonexistent-id");
  expect(memories.map((m) => m.text)).toEqual(["全局A"]);
});

test("list 盘根等非法 cwd 的项目名仍可解析（净化后不抛错）", async () => {
  const store = makeStore("H:");
  await store.add("global", "全局A");
  await store.add("project", "项目A", "p1");

  const { memories } = await store.list("p1");
  expect(memories.map((m) => m.text).sort()).toEqual(["全局A", "项目A"].sort());
});

// ===== add =====

test("add 全局记忆后 list 能读到", async () => {
  const store = makeStore();
  await store.add("global", "新全局记忆");
  const { memories } = await store.list();
  expect(
    memories.find((m) => m.text === "新全局记忆" && m.scope === "global"),
  ).toBeTruthy();
});

test("add 项目记忆落到项目作用域，全局读不到", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("project", "新项目记忆", "p1");

  const { memories } = await store.list("p1");
  expect(
    memories.find((m) => m.text === "新项目记忆" && m.scope === "project"),
  ).toBeTruthy();

  const { memories: globalOnly } = await store.list();
  expect(globalOnly.find((m) => m.text === "新项目记忆")).toBeUndefined();
});

test("add 项目记忆缺少 projectId 抛错", async () => {
  const store = makeStore("/repos/my-app");
  await expect(store.add("project", "无项目")).rejects.toThrow();
});

test("add 项目记忆 projectId 不存在 → project.notFound", async () => {
  const store = makeStore("/repos/my-app");
  await expectKernelCode(
    () => store.add("project", "无项目", "nope"),
    "project.notFound",
  );
});

// ===== update / archive / restore / purge =====

test("update 按 id 改文本，其他条目不受影响", async () => {
  const store = makeStore();
  await store.add("global", "旧内容1");
  await store.add("global", "旧内容2");
  const { memories } = await store.list();
  const target = memories.find((m) => m.text === "旧内容2")!;

  await store.update(target.id, "新内容2");

  const texts = (await store.list()).memories.map((m) => m.text);
  expect(texts).toContain("新内容2");
  expect(texts).toContain("旧内容1");
  expect(texts).not.toContain("旧内容2");
});

test("update 不存在的 id → memory.entryStale", async () => {
  await expectKernelCode(
    () => makeStore().update("00000000-0000-0000-0000-000000000000", "x"),
    "memory.entryStale",
  );
});

test("archive 软删除：转入 archived 且带 ISO archivedAt", async () => {
  const store = makeStore();
  await store.add("global", "条目A");
  await store.add("global", "条目B");
  const target = (await store.list()).memories.find((m) => m.text === "条目A")!;

  await store.archive(target.id);

  const { memories, archived } = await store.list();
  expect(memories.map((m) => m.text)).toEqual(["条目B"]);
  expect(archived).toHaveLength(1);
  expect(archived[0].id).toBe(target.id);
  expect(archived[0].text).toBe("条目A");
  expect(isIso(archived[0].archivedAt)).toBe(true);
});

test("archive 已归档 / 不存在的 id → memory.entryStale", async () => {
  const store = makeStore();
  await store.add("global", "条目A");
  const id = (await store.list()).memories[0].id;
  await store.archive(id);

  await expectKernelCode(() => store.archive(id), "memory.entryStale");
  await expectKernelCode(
    () => store.archive("00000000-0000-0000-0000-000000000000"),
    "memory.entryStale",
  );
});

test("archive 归档的项目条目在该项目 list 的 archived 段可见（不漏到其它项目/无项目上下文）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("project", "项目条目", "p1");
  const id = (await store.list("p1")).memories[0]!.id;
  await store.archive(id);

  const { archived } = await store.list("p1");
  expect(archived.map((m) => m.text)).toEqual(["项目条目"]);
  expect(archived[0]!.scope).toBe("project");
  // 回归：无项目上下文（全局作用域）与未知项目都看不到别家的归档
  expect((await store.list()).archived).toHaveLength(0);
  expect((await store.list("nonexistent-id")).archived).toHaveLength(0);
});

test("list 归档段按项目过滤：全局归档 + 当前项目归档，不含其它项目（回归：归档 tab 切项目失效）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "全局归档");
  const gid = (await store.list()).memories[0]!.id;
  await store.archive(gid);
  // 其它项目的归档：mock ProjectStore 只解析 p1→my-app，别家项目只能 seed 落库
  const dao = new MemoryDao(openMemoryDb(tmpDir));
  const mine = dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "my-app",
    content: "本项目归档",
    source: "test",
  });
  dao.archive(mine.id);
  const other = dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "other-app",
    content: "别项目归档",
    source: "test",
  });
  dao.archive(other.id);

  // 项目作用域：全局归档 + 本项目归档，绝不含别家项目
  const withProject = await store.list("p1");
  expect(withProject.archived.map((a) => a.text).sort()).toEqual([
    "全局归档",
    "本项目归档",
  ]);
  // 无项目上下文：只有全局归档
  const globalOnly = await store.list();
  expect(globalOnly.archived.map((a) => a.text)).toEqual(["全局归档"]);
});

test("restore 让归档条目回到列表", async () => {
  const store = makeStore();
  await store.add("global", "条目A");
  const id = (await store.list()).memories[0].id;
  await store.archive(id);

  await store.restore(id);

  const { memories, archived } = await store.list();
  expect(memories.map((m) => m.text)).toEqual(["条目A"]);
  expect(archived).toEqual([]);
});

test("restore 非归档 / 不存在的 id → memory.archiveNotFound", async () => {
  const store = makeStore();
  await store.add("global", "条目A");
  const id = (await store.list()).memories[0].id;

  await expectKernelCode(() => store.restore(id), "memory.archiveNotFound");
  await expectKernelCode(
    () => store.restore("00000000-0000-0000-0000-000000000000"),
    "memory.archiveNotFound",
  );
});

test("purge 从库中彻底删除，不回到列表", async () => {
  const store = makeStore();
  await store.add("global", "条目A");
  const id = (await store.list()).memories[0].id;
  await store.archive(id);

  await store.purge(id);

  const { memories, archived } = await store.list();
  expect(memories).toEqual([]);
  expect(archived).toEqual([]);
  expect(new MemoryDao(openMemoryDb(tmpDir)).getById(id)).toBeNull();
});

test("purge 不存在的 id → memory.archiveNotFound", async () => {
  await expectKernelCode(
    () => makeStore().purge("00000000-0000-0000-0000-000000000000"),
    "memory.archiveNotFound",
  );
});

// ===== listPage =====

test("listPage：active tab 按 updated_at DESC 分页且 hasMore 正确", async () => {
  const store = makeStore();
  // 预置：写入 5 条全局记忆
  for (let i = 0; i < 5; i++) await store.add("global", `分页记忆 ${i}`);

  const page1 = await store.listPage({ scope: "global", tab: "active", limit: 2 });
  expect(page1.entries).toHaveLength(2);
  expect(page1.hasMore).toBe(true);
  expect(page1.counts.active).toBe(5);
  expect(page1.counts.archived).toBe(0);

  const page2 = await store.listPage({ scope: "global", tab: "active", limit: 2, offset: 2 });
  expect(page2.entries).toHaveLength(2);
  // 与 page1 条目不重叠
  const ids = new Set([...page1.entries, ...page2.entries].map((e) => e.id));
  expect(ids.size).toBe(4);
  // 第 5 条还在后面：拉满 want 条 → 保守视为还有下一页
  expect(page2.hasMore).toBe(true);

  // 最后一页：拉不满 want 条 → hasMore=false，且不与前两页重叠
  const page3 = await store.listPage({ scope: "global", tab: "active", limit: 2, offset: 4 });
  expect(page3.entries).toHaveLength(1);
  expect(page3.hasMore).toBe(false);
  ids.add(page3.entries[0].id);
  expect(ids.size).toBe(5);
});

test("listPage：kind 与时间窗只影响条目不影响徽标 counts", async () => {
  const store = makeStore();
  const dao = new MemoryDao(openMemoryDb(tmpDir));
  await store.add("global", "知识条目");
  seed([
    { kind: "execution", scope: "global", content: "执行条目 A" },
    { kind: "execution", scope: "global", content: "执行条目 B" },
  ]);
  // 一条 execution 推到 2 小时前（时间窗外）：kind/时间窗必须把它滤掉
  const stale = dao.list({ scope: "global", includeArchived: false, kind: "execution" })[0];
  dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [
    Date.now() - 7_200_000,
    stale.id,
  ]);

  const r = await store.listPage({
    scope: "global",
    tab: "active",
    kind: "execution",
    since: Date.now() - 60_000,
    limit: 10,
  });
  expect(r.entries.every((e) => e.kind === "execution")).toBe(true);
  expect(r.entries).toHaveLength(1); // 只剩窗内的那条 execution
  // counts 不带 kind/时间窗：等于该 scope 全量
  expect(r.counts.active).toBe(3);
  expect(r.counts.archived).toBe(0);
});

test("listPage：archived tab 返回带 archivedAt 的归档条目", async () => {
  const store = makeStore();
  for (let i = 0; i < 3; i++) await store.add("global", `归档测试 ${i}`);
  const { memories } = await store.list();
  await store.archive(memories[0].id);

  const r = await store.listPage({ scope: "global", tab: "archived", limit: 10 });
  expect(r.entries).toHaveLength(1);
  expect((r.entries[0] as ArchivedMemory).archivedAt).toBeTruthy();
  expect(r.counts.archived).toBe(1);
  expect(r.counts.active).toBe(2);
});

test("listPage：scope=project 解析为项目名后按项目过滤（全局/其它项目不混入）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "全局记忆");
  await store.add("project", "项目记忆", "p1");

  const r = await store.listPage({ scope: "project", projectId: "p1", tab: "active", limit: 10 });
  expect(r.entries).toHaveLength(1);
  expect(r.entries[0].text).toBe("项目记忆");
  // projectId 列存的是项目名（cwd basename），不是 UI 的 project id
  expect(r.entries[0].projectId).toBe("my-app");
  expect(r.counts.active).toBe(1);
  expect(r.counts.archived).toBe(0);
});

test("listPage：scope=project 且 projectId 不可解析时返回空（对齐旧 list 宽松行为）", async () => {
  const store = makeStore();
  const r = await store.listPage({
    scope: "project",
    projectId: "no-such-id",
    tab: "active",
    limit: 10,
  });
  expect(r.entries).toEqual([]);
  expect(r.counts).toEqual({ active: 0, archived: 0 });
});

// ===== search =====

test("search 命中并映射为 MemorySearchResult", async () => {
  const store = makeStore();
  await store.add("global", "Gitee 推送必须禁用 osxkeychain 凭据助手");

  const { results, totalMatched } = await store.search({
    query: "osxkeychain",
  });
  expect(results).toHaveLength(1);
  expect(totalMatched).toBe(1);
  const r = results[0];
  expect(r.id).toMatch(UUID_RE);
  expect(r.title).toContain("Gitee");
  expect(r.snippet).toContain("osxkeychain");
  expect(r.kind).toBe("knowledge");
  expect(r.scope).toBe("global");
  expect(r.projectId).toBeUndefined();
  expect(isIso(r.updatedAt)).toBe(true);
  expect(typeof r.score).toBe("number");
  expect(r.archived).toBe(false);
});

test("search 支持 scope / kind 过滤", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "sqlite 全局索引");
  await store.add("project", "sqlite 项目索引", "p1");
  seed([{ kind: "execution", scope: "global", content: "sqlite 执行记录" }]);

  const globalOnly = await store.search({ query: "sqlite", scope: "global" });
  expect(globalOnly.results.map((r) => r.scope)).toEqual(["global", "global"]);

  const projectOnly = await store.search({
    query: "sqlite",
    scope: "project",
    projectId: "p1",
  });
  expect(projectOnly.results).toHaveLength(1);
  expect(projectOnly.results[0].projectId).toBe("my-app");

  const execution = await store.search({ query: "sqlite", kind: "execution" });
  expect(execution.results).toHaveLength(1);
  expect(execution.results[0].kind).toBe("execution");
});

test("search includeArchived 控制归档可见性", async () => {
  const store = makeStore();
  await store.add("global", "归档的 tailwind 约定");
  const id = (await store.list()).memories[0].id;
  await store.archive(id);

  const plain = await store.search({ query: "tailwind" });
  expect(plain.results).toEqual([]);
  expect(plain.totalMatched).toBe(0);

  const withArchived = await store.search({
    query: "tailwind",
    includeArchived: true,
  });
  expect(withArchived.results).toHaveLength(1);
  expect(withArchived.results[0].archived).toBe(true);
});

test("search limit 截断结果", async () => {
  const store = makeStore();
  for (let i = 0; i < 5; i++) await store.add("global", `sqlite 约定 ${i}`);

  expect(
    (await store.search({ query: "sqlite", limit: 2 })).results,
  ).toHaveLength(2);
});

test("search 空查询返回空结果", async () => {
  const store = makeStore();
  await store.add("global", "任意内容");
  expect(await store.search({ query: "" })).toEqual({
    results: [],
    totalMatched: 0,
    hasMore: false,
  });
  expect(await store.search({ query: "   " })).toEqual({
    results: [],
    totalMatched: 0,
    hasMore: false,
  });
});

// ── 审查发现 1（Important）：HTTP/WS 这一路必须带出 totalMatched ──

test("search 的 totalMatched 是未截断的真实命中总数，与 results.length 不同", async () => {
  const store = makeStore();
  for (const s of ["一", "二", "三"]) {
    await store.add("global", `pagination sample ${s}`);
  }

  const paged = await store.search({ query: "pagination", limit: 1 });
  expect(paged.results).toHaveLength(1);
  expect(paged.totalMatched).toBe(3); // 真实命中 3 条，不是这一页的 1 条

  const all = await store.search({ query: "pagination" });
  expect(all.results).toHaveLength(3);
  expect(all.totalMatched).toBe(3);
});

test("search 的 totalMatched 与 results 走同一套过滤条件（scope/kind/includeArchived）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "口径一致 zebra 全局");
  await store.add("project", "口径一致 zebra 项目", "p1");
  seed([
    { kind: "execution", scope: "global", content: "口径一致 zebra 执行" },
  ]);

  const all = await store.search({ query: "zebra" });
  expect(all.results).toHaveLength(3);
  expect(all.totalMatched).toBe(3);

  const globalOnly = await store.search({ query: "zebra", scope: "global" });
  expect(globalOnly.results).toHaveLength(2);
  expect(globalOnly.totalMatched).toBe(2);

  const projectOnly = await store.search({
    query: "zebra",
    scope: "project",
    projectId: "p1",
  });
  expect(projectOnly.results).toHaveLength(1);
  expect(projectOnly.totalMatched).toBe(1);

  const executionOnly = await store.search({
    query: "zebra",
    kind: "execution",
  });
  expect(executionOnly.results).toHaveLength(1);
  expect(executionOnly.totalMatched).toBe(1);
});

// ── 审查发现 2（Important）：默认 scope 语义 = 跨域检索（spec §5）──

test("search 未传 scope 是跨域检索：全局与项目条目都能命中", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "跨域检索 zebra 全局");
  await store.add("project", "跨域检索 zebra 项目", "p1");

  const noScope = await store.search({ query: "zebra" });
  expect(noScope.results.map((r) => r.scope).sort()).toEqual([
    "global",
    "project",
  ]);
  expect(noScope.totalMatched).toBe(2);
});

test("search 未传 scope 时给了可解析的 projectId 也不限定项目（不再默认限定当前项目）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "跨域检索 zebra 全局");
  await store.add("project", "跨域检索 zebra 项目", "p1");

  const results = await store.search({ query: "zebra", projectId: "p1" });
  expect(results.results.map((r) => r.scope).sort()).toEqual([
    "global",
    "project",
  ]);
  expect(results.totalMatched).toBe(2);
});

test("search 显式 projectId 解析不到 → project.notFound（不得静默忽略过滤条件）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "跨域检索 zebra 全局");
  await store.add("project", "跨域检索 zebra 项目", "p1");

  // 未传 scope
  await expectKernelCode(
    () => store.search({ query: "zebra", projectId: "nope" }),
    "project.notFound",
  );
  // 显式 scope=project
  await expectKernelCode(
    () => store.search({ query: "zebra", scope: "project", projectId: "nope" }),
    "project.notFound",
  );
  // scope=project 但根本没给 projectId
  await expectKernelCode(
    () => store.search({ query: "zebra", scope: "project" }),
    "project.notFound",
  );
});

test("search 显式 scope=project 仍限定到该项目（维持原语义）", async () => {
  const store = makeStore("/repos/my-app");
  await store.add("global", "限定语义 zebra 全局");
  await store.add("project", "限定语义 zebra 本项目", "p1");
  seed([
    {
      scope: "project",
      projectId: "other-app",
      content: "限定语义 zebra 别项目",
    },
  ]);

  const results = await store.search({
    query: "zebra",
    scope: "project",
    projectId: "p1",
  });
  expect(results.results.map((r) => r.projectId)).toEqual(["my-app"]);
  expect(results.totalMatched).toBe(1);
});

test("search：since/until 过滤 + offset 翻页 + hasMore 口径", async () => {
  const store = makeStore();
  const dao = new MemoryDao(openMemoryDb(tmpDir));
  // 预置 3 条同词命中（内容一致让排序可预期），其中 1 条 updated_at 推到窗外
  for (let i = 0; i < 3; i++) await store.add("global", "时间窗检索 目标条目");
  const stale = dao.list({ scope: "global", includeArchived: false })[0];
  dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [
    Date.now() - 365 * 86_400_000,
    stale.id,
  ]);

  // 窗内恰 2 条、limit=2：拉满 want 条 → 保守口径 hasMore=true（可能还有下一页）
  const r1 = await store.search({
    query: "时间窗检索",
    limit: 2,
    since: Date.now() - 86_400_000,
    until: Date.now() + 86_400_000,
  });
  expect(r1.results).toHaveLength(2);
  expect(r1.results.every((h) => h.id !== stale.id)).toBe(true);
  expect(r1.hasMore).toBe(true);

  // offset=2 翻页：全库 3 条命中 < want=4 → 未拉满 → hasMore=false，剩余 1 条不重叠
  const r2 = await store.search({ query: "时间窗检索", limit: 2, offset: 2 });
  expect(r2.results).toHaveLength(1);
  expect(r2.results[0].id).not.toBe(r1.results[0].id);
  expect(r2.results[0].id).toBe(stale.id);
  expect(r2.hasMore).toBe(false);
});

test("search：时间窗外全部排除时 totalMatched 为 0", async () => {
  const store = makeStore();
  await store.add("global", "年代久远检索样本");
  const r = await store.search({
    query: "年代久远检索",
    until: Date.now() - 86_400_000 * 365,
  });
  expect(r.totalMatched).toBe(0);
  expect(r.results).toEqual([]);
});

// ===== listInstructions：AGENTS.md / CLAUDE.md =====
// pi 框架 resource-loader.js loadProjectContextFiles 的规则：
// 1. 候选文件名：AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD（取第一个命中）
// 2. 扫描范围：agentDir + cwd + 所有祖先目录（向上走到根）
// 3. 去重：同一文件路径不重复

test("listInstructions 扫描全局 + 项目级 AGENTS.md", async () => {
  writeFileSync(join(tmpDir, "AGENTS.md"), "全局指令内容", "utf8");
  const projectCwd = join(tmpDir, "fake-project");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(projectCwd, "AGENTS.md"), "项目指令内容", "utf8");

  const instructions = await makeStore(projectCwd).listInstructions("p1");

  // 只看 tmpDir 范围内的文件（祖先遍历可能发现真实文件系统上游的 AGENTS.md）
  const ours = instructions.filter((i) => i.path.startsWith(tmpDir));
  const globalInst = ours.find((i) => i.scope === "global");
  const projectInst = ours.find((i) => i.scope === "project");
  expect(globalInst).toBeTruthy();
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(globalInst!.content).toBe("全局指令内容");
  expect(projectInst).toBeTruthy();
  expect(projectInst!.content).toBe("项目指令内容");
});

test("listInstructions CLAUDE.md 作为备选指令文件", async () => {
  writeFileSync(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");
  const projectCwd = join(tmpDir, "fake-project");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(projectCwd, "CLAUDE.md"), "项目 CLAUDE", "utf8");

  const instructions = await makeStore(projectCwd).listInstructions("p1");
  const ours = instructions.filter(
    (i) => i.path.startsWith(tmpDir) && i.name === "CLAUDE.md",
  );
  expect(ours.length).toBeGreaterThanOrEqual(2);
});

test("listInstructions AGENTS.md 优先于 CLAUDE.md", async () => {
  writeFileSync(join(tmpDir, "AGENTS.md"), "全局 AGENTS", "utf8");
  writeFileSync(join(tmpDir, "CLAUDE.md"), "全局 CLAUDE", "utf8");

  const instructions = await makeStore().listInstructions("p1");
  const globalInst = instructions.find(
    (i) => i.scope === "global" && i.path.startsWith(tmpDir),
  );
  expect(globalInst!.name).toBe("AGENTS.md");
  expect(globalInst!.content).toBe("全局 AGENTS");
  expect(
    instructions.find(
      (i) => i.path.startsWith(tmpDir) && i.name === "CLAUDE.md",
    ),
  ).toBeUndefined();
});

test("listInstructions 文件不存在时返回空数组", async () => {
  expect(await makeStore().listInstructions("p1")).toEqual([]);
});

test("listInstructions projectId 不存在时只返回全局", async () => {
  writeFileSync(join(tmpDir, "AGENTS.md"), "全局指令", "utf8");
  const instructions = await makeStore().listInstructions("nonexistent-id");
  expect(
    instructions.filter((i) => i.scope === "global").length,
  ).toBeGreaterThanOrEqual(1);
  expect(instructions.filter((i) => i.scope === "project")).toHaveLength(0);
});

test("listInstructions agentDir 与祖先目录重叠时去重", async () => {
  // agentDir == cwd → global 与 project 指向同一文件，去重后只出现一次
  writeFileSync(join(tmpDir, "AGENTS.md"), "既是全局也是项目 cwd", "utf8");

  const instructions = await makeStore(tmpDir).listInstructions("p1");
  const ours = instructions.filter((i) => i.path.startsWith(tmpDir));
  expect(ours).toHaveLength(1);
  expect(ours[0].scope).toBe("global");
  expect(ours[0].content).toBe("既是全局也是项目 cwd");
});

// ── listInstructions 一致性：对齐 pi 框架 resource-loader.js 的 context file 加载行为 ──
// 这三例在任务 11 重写测试文件时被删（listInstructions 本身逐字未改），按用例名语义补回。

test("listInstructions 候选列表包含大写变体（pi 兼容行为）", async () => {
  // 只放 AGENTS.MD：候选列表必须包含大写变体，否则该文件永远扫不到
  writeFileSync(join(tmpDir, "AGENTS.MD"), "大写变体内容", "utf8");

  const instructions = await makeStore("/fake").listInstructions("p1");

  // macOS 大小写不敏感 → 首候选 AGENTS.md 即命中同一文件（name 为磁盘上的实际名）
  // Linux 大小写敏感 → 第二个候选 AGENTS.MD 命中。两者都是正确的，断言实际名在候选表内。
  const ours = instructions.filter((i) => i.path.startsWith(tmpDir));
  expect(ours).toHaveLength(1);
  expect(["AGENTS.md", "AGENTS.MD"]).toContain(ours[0].name);
  expect(ours[0].content).toBe("大写变体内容");
  expect(ours[0].scope).toBe("global");
});

test("listInstructions 遍历祖先目录发现指令文件", async () => {
  // 项目 cwd 在深层目录，指令文件放在它的祖先目录 tmpDir/a（既不是 agentDir 也不是 cwd）
  const projectCwd = join(tmpDir, "a", "b", "c");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(tmpDir, "a", "AGENTS.md"), "祖先 a 指令", "utf8");

  const instructions = await makeStore(projectCwd).listInstructions("p1");

  // 只有向上遍历（dirname(currentDir)）才能发现它
  const ancestorInst = instructions.find(
    (i) => i.path === join(tmpDir, "a", "AGENTS.md"),
  );
  expect(ancestorInst).toBeTruthy();
  expect(ancestorInst!.content).toBe("祖先 a 指令");
  expect(ancestorInst!.scope).toBe("project");
  // 去掉 while 循环（只看 cwd）时本断言会红：cwd 下没有指令文件
  expect(
    instructions.filter(
      (i) => i.scope === "project" && i.path.startsWith(tmpDir),
    ).length,
  ).toBe(1);
});

test("listInstructions 全局和祖先目录可同时返回多个指令文件", async () => {
  // 全局：waPiDir = tmpDir；祖先：tmpDir/outer（cwd = tmpDir/outer/proj 的父目录）
  writeFileSync(join(tmpDir, "AGENTS.md"), "全局指令", "utf8");
  const projectCwd = join(tmpDir, "outer", "proj");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(tmpDir, "outer", "AGENTS.md"), "祖先 outer 指令", "utf8");

  const instructions = await makeStore(projectCwd).listInstructions("p1");
  const ours = instructions.filter((i) => i.path.startsWith(tmpDir));

  // 全局一段 + 祖先遍历命中一段，两个目录同时命中时都要返回（顺序：全局在前，祖先在内）
  expect(ours.map((i) => i.path)).toEqual([
    join(tmpDir, "AGENTS.md"),
    join(tmpDir, "outer", "AGENTS.md"),
  ]);
  expect(ours[0].scope).toBe("global");
  expect(ours[1].scope).toBe("project");
  expect(ours[1].content).toBe("祖先 outer 指令");
});

// ===== getConfig / setConfig =====

const HERMES_CONFIG_FILE = "hermes-memory-config.json";

test("getConfig 文件不存在时返回默认值", async () => {
  const config = await makeStore().getConfig();
  expect(config.reviewEnabled).toBe(true);
  expect(config.memoryPolicyStyle).toBe("full");
});

test("getConfig 读取已有配置文件", async () => {
  writeFileSync(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({ reviewEnabled: false, memoryPolicyStyle: "compact" }),
    "utf8",
  );
  const config = await makeStore().getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("compact");
});

test("getConfig 配置文件缺失字段时用默认值补齐", async () => {
  writeFileSync(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({ reviewEnabled: false }),
    "utf8",
  );
  const config = await makeStore().getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("full");
});

test("setConfig 写入后 getConfig 读回新值", async () => {
  const store = makeStore();
  await store.setConfig({ reviewEnabled: false, memoryPolicyStyle: "none" });
  const config = await store.getConfig();
  expect(config.reviewEnabled).toBe(false);
  expect(config.memoryPolicyStyle).toBe("none");
});

test("setConfig 保留已有配置项不覆盖", async () => {
  writeFileSync(
    join(tmpDir, HERMES_CONFIG_FILE),
    JSON.stringify({
      reviewEnabled: true,
      memoryPolicyStyle: "full",
      nudgeInterval: 5,
      autoConsolidate: true,
    }),
    "utf8",
  );

  await makeStore().setConfig({ reviewEnabled: false });

  const raw = JSON.parse(
    readFileSync(join(tmpDir, HERMES_CONFIG_FILE), "utf8"),
  );
  expect(raw.reviewEnabled).toBe(false);
  expect(raw.nudgeInterval).toBe(5);
  expect(raw.autoConsolidate).toBe(true);
});
