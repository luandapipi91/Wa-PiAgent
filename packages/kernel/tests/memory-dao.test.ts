import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao, deriveTitle, makeSnippet } from "../src/memory/dao";

let dao: MemoryDao;
beforeEach(() => {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  dao = new MemoryDao(db);
});

function add(over: Partial<Parameters<MemoryDao["insert"]>[0]> = {}) {
  return dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "项目用 bun",
    source: "agent",
    ...over,
  });
}

test("insert 返回带 id/时间戳的完整行，title 自动取首行", () => {
  const row = add({ content: "第一行标题\n第二行正文" });
  expect(row.id).toMatch(/[0-9a-f-]{36}/);
  expect(row.title).toBe("第一行标题");
  expect(row.createdAt).toBeGreaterThan(0);
  expect(row.updatedAt).toBe(row.createdAt);
  expect(row.archived).toBe(0);
});

test("insert 后 FTS 立即可检索（同步一致性）", () => {
  add({ content: "Gitee 推送必须禁用 osxkeychain" });
  const hits = dao.search("osxkeychain", {});
  expect(hits).toHaveLength(1);
});

test("updateContent 同步刷新 FTS：旧词失效、新词可检索", () => {
  const row = add({ content: "旧的 tailwind 约定" });
  expect(dao.updateContent(row.id, "新的 sqlite 约定")).toBe(true);
  expect(dao.search("tailwind", {})).toHaveLength(0);
  expect(dao.search("sqlite", {})).toHaveLength(1);
});

test("updateContent 更新 updatedAt 但不动 createdAt", () => {
  const row = add();
  const before = dao.getById(row.id)!;
  dao.updateContent(row.id, "改过的内容");
  const after = dao.getById(row.id)!;
  expect(after.createdAt).toBe(before.createdAt);
  expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
});

test("remove 同时清掉 FTS 索引", () => {
  const row = add({ content: "待删除 zzz" });
  expect(dao.remove(row.id)).toBe(true);
  expect(dao.getById(row.id)).toBeNull();
  expect(dao.search("zzz", {})).toHaveLength(0);
});

test("archive/restore 切换 archived 标记，purge 硬删", () => {
  const row = add();
  expect(dao.archive(row.id)).toBe(true);
  expect(dao.getById(row.id)!.archived).toBe(1);
  expect(dao.list({ includeArchived: false })).toHaveLength(0);
  expect(dao.list({ includeArchived: true })).toHaveLength(1);

  expect(dao.restore(row.id)).toBe(true);
  expect(dao.getById(row.id)!.archived).toBe(0);

  expect(dao.purge(row.id)).toBe(true);
  expect(dao.getById(row.id)).toBeNull();
});

test("restore 只翻 archived、不刷新 updatedAt（恢复 ≠ 内容更新）", () => {
  const row = add({ content: "两年前的旧约定" });
  // updatedAt 取一个明显不等于当前时间的值，
  // 否则「没刷新」与「刷新了但恰好同毫秒」无法区分。
  const pinned = Date.now() - 60_000;
  dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [pinned, row.id]);

  expect(dao.archive(row.id)).toBe(true);
  const before = dao.getById(row.id)!;
  expect(before.updatedAt).toBe(pinned); // archive 本就不动 updatedAt

  expect(dao.restore(row.id)).toBe(true);
  const after = dao.getById(row.id)!;
  expect(after.archived).toBe(0);
  expect(after.updatedAt).toBe(before.updatedAt); // 严格相等，不是 toBeGreaterThanOrEqual
  expect(after.updatedAt).toBe(pinned);
});

test("归档条目默认不出现在检索结果里", () => {
  const row = add({ content: "归档词 alpha" });
  dao.archive(row.id);
  expect(dao.search("alpha", {})).toHaveLength(0);
  expect(dao.search("alpha", { includeArchived: true })).toHaveLength(1);
});

test("list 按 scope/projectId/kind 过滤", () => {
  add({ content: "a", scope: "global", projectId: null });
  add({ content: "b", scope: "project", projectId: "Wa-Pi" });
  add({ content: "c", scope: "project", projectId: "Other" });
  add({ content: "d", kind: "execution" });

  expect(dao.list({}).length).toBe(4);
  expect(dao.list({ projectId: "Wa-Pi" }).map((r) => r.content).sort()).toEqual(["b", "d"]);
  expect(dao.list({ kind: "execution" }).map((r) => r.content)).toEqual(["d"]);
  expect(dao.list({ scope: "global" }).map((r) => r.content)).toEqual(["a"]);
});

test("counts 返回三种 kind 的计数", () => {
  add({ kind: "profile", target: "user", scope: "global", projectId: null });
  add({ kind: "knowledge" });
  add({ kind: "execution" });
  add({ kind: "execution" });
  expect(dao.counts({})).toEqual({ profile: 1, knowledge: 1, execution: 2 });
});

// ── 补充：简报 9 例未覆盖的评分与纯函数路径 ──────────────────────────────
// 权重置零隔离单一因子，避免用「大致排序」这类软断言。

test("search bm25 归一化方向正确：越相关得分越高", () => {
  const short = add({ content: "sqlite" });
  add({ content: `sqlite ${"noise ".repeat(30)}` });
  const hits = dao.search("sqlite", { weights: { bm25: 1, time: 0, kind: 0 } });
  expect(hits).toHaveLength(2);
  expect(hits[0].id).toBe(short.id);
  expect(hits.map((h) => h.score)).toEqual([1, 0]);
});

test("候选仅一条时 bm25 归一为 1（span=0 不除零）", () => {
  add({ content: "唯一命中 zzz" });
  const hits = dao.search("zzz", { weights: { bm25: 1, time: 0, kind: 0 } });
  expect(hits).toHaveLength(1);
  expect(hits[0].score).toBe(1);
});

test("kind 加权：同相关度下 profile > knowledge > execution", () => {
  add({ kind: "execution", content: "zzz" });
  add({ kind: "profile", target: "user", content: "zzz" });
  add({ kind: "knowledge", content: "zzz" });
  const hits = dao.search("zzz", { weights: { bm25: 0, time: 0, kind: 1 } });
  expect(hits.map((h) => h.kind)).toEqual(["profile", "knowledge", "execution"]);
});

test("时间衰减：同相关度下新条目排在旧条目之前", () => {
  const fresh = add({ content: "zzz" });
  const stale = add({ content: "zzz" });
  // updated_at 是唯一时间基准：直接把旧条目推回 60 天前（两个半衰期）
  dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [
    Date.now() - 60 * 86_400_000,
    stale.id,
  ]);
  const hits = dao.search("zzz", { weights: { bm25: 0, time: 1, kind: 0 } });
  expect(hits[0].id).toBe(fresh.id);
  expect(hits[1].score / hits[0].score).toBeLessThan(0.2);
});

test("deriveTitle：跳过空行、截断 60 字", () => {
  expect(deriveTitle("\n  \n第一行\n第二行")).toBe("第一行");
  expect(deriveTitle("整段没有换行")).toBe("整段没有换行");
  expect(deriveTitle("x".repeat(80)).length).toBe(60);
});

test("makeSnippet：围绕命中 token 截取原始文本，无命中取开头", () => {
  const content = `${"甲".repeat(100)}关键词 sqlite${"乙".repeat(100)}`;
  const s = makeSnippet(content, "sqlite");
  expect(s).toContain("sqlite");
  expect(s.length).toBe(80);
  expect(s).not.toBe(content.slice(0, 80));
  expect(makeSnippet("短文本", "不存在词")).toBe("短文本");
});

test("findBySubstring 与中文检索：写入索引与查询分词一致", () => {
  const row = add({ content: "发版流程：先跑全量测试" });
  expect(dao.findBySubstring("发版流程").map((r) => r.id)).toEqual([row.id]);
  expect(dao.findBySubstring("   ")).toEqual([]);
  expect(dao.search("发版").map((h) => h.id)).toEqual([row.id]);
  const tagged = add({ content: "无关正文", tags: "zebraindex" });
  expect(dao.search("zebraindex").map((h) => h.id)).toEqual([tagged.id]);
});

test("projectId 为 null/undefined/空串时不加过滤条件", () => {
  add({ content: "g", scope: "global", projectId: null });
  add({ content: "p", scope: "project", projectId: "Wa-Pi" });
  expect(dao.list({ projectId: null }).length).toBe(2);
  expect(dao.list({ projectId: undefined }).length).toBe(2);
  expect(dao.list({ projectId: "" }).length).toBe(2);
  expect(dao.list({ projectId: "Wa-Pi" }).length).toBe(1);
});

test("对不存在的 id 操作返回 false；空查询返回空数组", () => {
  expect(dao.updateContent("missing", "x")).toBe(false);
  expect(dao.remove("missing")).toBe(false);
  expect(dao.archive("missing")).toBe(false);
  expect(dao.restore("missing")).toBe(false);
  add({ content: "随便什么" });
  expect(dao.search("", {})).toEqual([]);
  expect(dao.search("   ", {})).toEqual([]);
});

// ── 补充：检索链路（DAO → 真实 FTS 表）的行为边界 ────────────────────────
// buildMatchExpr 的纯函数行为已在 memory-fts-query.test.ts 覆盖，
// 这里只验证表达式绑进 `MATCH ?` 后的整条链路。

test("特殊字符查询经 DAO 打到真实 FTS 表也不抛错", () => {
  add({ content: '含括号 (x)、星号 *、引号 "y" 与非空内容' });
  for (const q of ["(", ")", "*", 'a"b', '"', "* ( )", "AND", "NOT"]) {
    expect(() => dao.search(q, {})).not.toThrow();
  }
});

test("命中条数超 limit 时按综合分截断", () => {
  for (let i = 0; i < 15; i++) add({ content: `发版记录第 ${i} 条` });
  expect(dao.search("发版", { limit: 50 }).length).toBe(15); // 候选齐全，默认 limit 10 会截断
  const hits = dao.search("发版", { limit: 5 });
  expect(hits).toHaveLength(5);
  // 截断发生在排序之后：留下的必须是综合分最高的那几条
  const scores = hits.map((h) => h.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
});

test("search 命中后刷新 use_count 与 last_used_at", () => {
  const row = add({ content: "热度信号 zebrause" });
  expect(dao.getById(row.id)!.useCount).toBe(0);
  expect(dao.getById(row.id)!.lastUsedAt).toBeNull();

  expect(dao.search("zebrause", {}).map((h) => h.id)).toEqual([row.id]);

  const after = dao.getById(row.id)!;
  expect(after.useCount).toBe(1);
  expect(after.lastUsedAt).not.toBeNull();
});

// ── 补充：countMatches（memory_search 的 totalMatched 真实口径）───────────

test("countMatches 返回未截断的真实命中总数（不受 CANDIDATE_LIMIT 影响）", () => {
  for (let i = 0; i < 60; i++) add({ content: `发版记录第 ${i} 条` });
  // 候选硬截断在 50，所以即便 limit 开到 100 也只能拿到 50 条
  expect(dao.search("发版", { limit: 100 })).toHaveLength(50);
  expect(dao.countMatches("发版")).toBe(60);
});

test("countMatches 与 search 过滤口径一致（scope/projectId/kind/includeArchived）", () => {
  add({ content: "共同词 alpha", scope: "global", projectId: null });
  add({ content: "共同词 alpha", scope: "project", projectId: "Other" });
  const archived = add({ content: "共同词 alpha", scope: "global", projectId: null });
  dao.archive(archived.id);
  add({ content: "共同词 alpha", kind: "execution" });

  // 用一个等值断言的辅助：count 与「把 limit 开大后的 search 条数」必须相等
  const agree = (opts: Parameters<MemoryDao["countMatches"]>[1] = {}) => {
    expect(dao.countMatches("共同词 alpha", opts)).toBe(
      dao.search("共同词 alpha", { ...opts, limit: 100 }).length,
    );
  };
  expect(dao.countMatches("共同词 alpha")).toBe(3); // 4 条里 1 条已归档
  agree();
  agree({ includeArchived: true });
  expect(dao.countMatches("共同词 alpha", { includeArchived: true })).toBe(4);
  agree({ scope: "global" });
  expect(dao.countMatches("共同词 alpha", { scope: "global" })).toBe(1);
  agree({ scope: "project", projectId: "Wa-Pi" });
  expect(dao.countMatches("共同词 alpha", { scope: "project", projectId: "Wa-Pi" })).toBe(1);
  agree({ kind: "execution" });
  expect(dao.countMatches("共同词 alpha", { kind: "execution" })).toBe(1);

  // 空查询 / 纯空白：无表达式即无命中
  expect(dao.countMatches("")).toBe(0);
  expect(dao.countMatches("   ")).toBe(0);
  expect(dao.countMatches("不存在的词 zebraabsent")).toBe(0);
});

// 取消引用防误报（保留 dao 供后续任务扩展）
export {};
