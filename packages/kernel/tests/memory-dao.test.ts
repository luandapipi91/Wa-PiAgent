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
  dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [
    pinned,
    row.id,
  ]);

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

test("archivedOnly 只返回归档行；includeArchived:false 只返回未归档行", () => {
  const live = add({ content: "zebraarch 未归档" });
  const gone = add({ content: "zebraarch 已归档" });
  dao.archive(gone.id);

  const onlyArchived = dao.search("zebraarch", {
    archivedOnly: true,
    weights: { bm25: 1, time: 0, kind: 0 },
  });
  expect(onlyArchived.map((h) => h.id)).toEqual([gone.id]);

  expect(
    dao.search("zebraarch", { includeArchived: false }).map((h) => h.id),
  ).toEqual([live.id]);
});

test("archivedOnly 与 includeArchived 同时给出时 archivedOnly 优先", () => {
  const live = add({ content: "zebraarch 未归档" });
  const gone = add({ content: "zebraarch 已归档" });
  dao.archive(gone.id);

  const hits = dao.search("zebraarch", {
    archivedOnly: true,
    includeArchived: true,
    weights: { bm25: 1, time: 0, kind: 0 },
  });
  expect(hits.map((h) => h.id)).toEqual([gone.id]);
  expect(hits.map((h) => h.id)).not.toContain(live.id);
});

test("countMatches 与 archivedOnly 同口径：等于归档条数", () => {
  add({ content: "zebraarch 未归档一" });
  const goneA = add({ content: "zebraarch 已归档一" });
  const goneB = add({ content: "zebraarch 已归档二" });
  dao.archive(goneA.id);
  dao.archive(goneB.id);

  expect(dao.countMatches("zebraarch", { archivedOnly: true })).toBe(2);
  expect(dao.countMatches("zebraarch", { archivedOnly: true })).toBe(
    dao.search("zebraarch", { archivedOnly: true, limit: 100 }).length,
  );
  // 与「同时给 includeArchived」也保持同一口径（archivedOnly 优先）
  expect(
    dao.countMatches("zebraarch", {
      archivedOnly: true,
      includeArchived: true,
    }),
  ).toBe(2);
});

test("list 按 scope/projectId/kind 过滤", () => {
  add({ content: "a", scope: "global", projectId: null });
  add({ content: "b", scope: "project", projectId: "Wa-Pi" });
  add({ content: "c", scope: "project", projectId: "Other" });
  add({ content: "d", kind: "execution" });

  expect(dao.list({}).length).toBe(4);
  expect(
    dao
      .list({ projectId: "Wa-Pi" })
      .map((r) => r.content)
      .sort(),
  ).toEqual(["b", "d"]);
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

// ── 单字/短查询：FTS 零命中时的子串回退 ─────────────────────────────────
// bigram 索引只存相邻二元组（「示例」→ `示例`），单个汉字从不单独成 token，
// 所以查「示」FTS 必然零命中而库里确有含「示」的条目。
// 回退只在 FTS 零命中时启用，且与 FTS 路径共用同一份过滤条件。

test("单字检索：FTS 无 token 可比时回退子串匹配（查「示」能查到「示例」）", () => {
  const hit = add({ content: "用户备注：示例。称呼时用「示例」。" });
  add({ content: "无关内容：李四的偏好" });

  expect(dao.search("示", {}).map((h) => h.id)).toEqual([hit.id]);
  expect(dao.countMatches("示")).toBe(1);
});

test("单字检索与过滤条件同口径（scope / kind / 归档）", () => {
  const g = add({ content: "全局含张", scope: "global", projectId: null });
  const p = add({ content: "项目含张", scope: "project", projectId: "Wa-Pi" });
  const exec = add({ content: "执行含张", kind: "execution" });
  const gone = add({ content: "归档含张" });
  dao.archive(gone.id);

  expect(
    dao
      .search("张", {})
      .map((h) => h.id)
      .sort(),
  ).toEqual([exec.id, g.id, p.id].sort());
  expect(dao.search("张", { scope: "global" }).map((h) => h.id)).toEqual([
    g.id,
  ]);
  expect(dao.search("张", { kind: "execution" }).map((h) => h.id)).toEqual([
    exec.id,
  ]);
  expect(dao.search("张", { archivedOnly: true }).map((h) => h.id)).toEqual([
    gone.id,
  ]);
});

test("单字检索的 totalMatched 与 search 同口径（回退路径也一致）", () => {
  add({ content: "甲张" });
  add({ content: "乙张" });
  add({ content: "丙无" });
  expect(dao.countMatches("张")).toBe(2);
  expect(dao.countMatches("张")).toBe(dao.search("张", { limit: 100 }).length);
});

test("有 FTS 命中时不回退：查「示例」不会把只含「示」的条目也捞出来", () => {
  const hit = add({ content: "示例是用户" });
  add({ content: "样式是另一个词" });

  expect(dao.search("示例", {}).map((h) => h.id)).toEqual([hit.id]);
  expect(dao.countMatches("示例")).toBe(1);
});

test("子串回退里 LIKE 元字符是字面量：查「%」只命中真含百分号的条目", () => {
  const pct = add({ content: "缓存命中率 100% 的说明" });
  add({ content: "没有任何百分号的内容" });

  expect(dao.search("%", {}).map((h) => h.id)).toEqual([pct.id]);
  expect(dao.countMatches("%")).toBe(1);
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
  expect(hits.map((h) => h.kind)).toEqual([
    "profile",
    "knowledge",
    "execution",
  ]);
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

test("countMatches 返回未截断的真实命中总数（不受打分全集物化上限影响）", () => {
  for (let i = 0; i < 60; i++) add({ content: `发版记录第 ${i} 条` });
  // 打分全集物化（LIMIT 固定 FULL_SCAN_CAP=2000）：60 条命中 ≤2000 全物化，
  // limit 开到 100 能看到全部命中；上一轮「池随 want 扩大」的中间态语义已废弃
  expect(dao.search("发版", { limit: 100 })).toHaveLength(60);
  expect(dao.countMatches("发版")).toBe(60);
});

test("countMatches 与 search 过滤口径一致（scope/projectId/kind/includeArchived）", () => {
  add({ content: "共同词 alpha", scope: "global", projectId: null });
  add({ content: "共同词 alpha", scope: "project", projectId: "Other" });
  const archived = add({
    content: "共同词 alpha",
    scope: "global",
    projectId: null,
  });
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
  expect(
    dao.countMatches("共同词 alpha", { scope: "project", projectId: "Wa-Pi" }),
  ).toBe(1);
  agree({ kind: "execution" });
  expect(dao.countMatches("共同词 alpha", { kind: "execution" })).toBe(1);

  // 空查询 / 纯空白：无表达式即无命中
  expect(dao.countMatches("")).toBe(0);
  expect(dao.countMatches("   ")).toBe(0);
  expect(dao.countMatches("不存在的词 zebraabsent")).toBe(0);
});

// ── 快照索引块所需的聚合查询（避免为几十字索引把整个 scope 载入内存）──

test("list 支持 limit：只取最新的 N 行，counts 口径不变", () => {
  for (let i = 0; i < 5; i++) add({ content: `条目 ${i}` });
  expect(dao.list({ limit: 2 })).toHaveLength(2);
  expect(dao.list({})).toHaveLength(5);
  // 取数上界不得影响任何过滤条件
  expect(dao.counts({ limit: 2 })).toEqual({
    profile: 0,
    knowledge: 5,
    execution: 0,
  });
  // 非法 limit（0 / 负数 / undefined）视为不限
  expect(dao.list({ limit: 0 })).toHaveLength(5);
  expect(dao.list({ limit: -1 })).toHaveLength(5);
});

test("oldestUpdatedAt：返回最早时间，excludeProfile / before / 过滤条件均生效", () => {
  const profile = add({
    kind: "profile",
    content: "画像",
    scope: "global",
    projectId: null,
  });
  const old = add({ content: "旧知识", scope: "global", projectId: null });
  const mid = add({ content: "中间知识", scope: "global", projectId: null });
  const other = add({
    content: "别的项目",
    scope: "project",
    projectId: "Other",
  });
  const set = (id: string, t: number) =>
    dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [t, id]);
  set(profile.id, 500);
  set(old.id, 1000);
  set(mid.id, 2000);
  set(other.id, 100);

  expect(dao.oldestUpdatedAt()).toBe(100);
  expect(dao.oldestUpdatedAt({ excludeProfile: true })).toBe(100);
  expect(dao.oldestUpdatedAt({ scope: "global" })).toBe(500);
  expect(dao.oldestUpdatedAt({ scope: "global", excludeProfile: true })).toBe(
    1000,
  );
  // before：只看某时间点之前的行（快照用它先求「超窗口」集合的最早时间）
  expect(dao.oldestUpdatedAt({ excludeProfile: true, before: 2500 })).toBe(100);
  expect(dao.oldestUpdatedAt({ excludeProfile: true, before: 100 })).toBeNull();
  expect(
    dao.oldestUpdatedAt({ scope: "project", projectId: "没有这个项目" }),
  ).toBeNull();
  // 归档条目默认不在集合内，与 list/counts 同口径
  dao.archive(old.id);
  expect(dao.oldestUpdatedAt({ excludeProfile: true })).toBe(100);
  expect(
    dao.oldestUpdatedAt({ excludeProfile: true, includeArchived: true }),
  ).toBe(100);
  expect(dao.oldestUpdatedAt({ scope: "global", excludeProfile: true })).toBe(
    2000,
  );
  expect(
    dao.oldestUpdatedAt({
      scope: "global",
      excludeProfile: true,
      includeArchived: true,
    }),
  ).toBe(1000);
});

// =========================================================================
// 时间范围过滤（since/until）—— memory_search「按时间搜索」的 DAO 层
// =========================================================================

const DAY_MS = 86_400_000;

/** insert 总写 Date.now()，测时间过滤要能把条目时间搬回去 */
function retimeRow(id: string, updatedAt: number, createdAt?: number) {
  dao.db.run("UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?", [
    updatedAt,
    createdAt ?? updatedAt,
    id,
  ]);
}

test("since/until 是闭区间：正好落在端点的条目也命中", () => {
  const base = Date.now() - 10 * DAY_MS;
  const a = add({ content: "锚点数据 alpha" });
  const b = add({ content: "锚点数据 beta" });
  const c = add({ content: "锚点数据 gamma" });
  retimeRow(a.id, base);
  retimeRow(b.id, base + 2 * DAY_MS);
  retimeRow(c.id, base + 4 * DAY_MS);

  // [base+2d, base+2d] 收缩到单点 —— 只有端点上的 b
  expect(
    dao
      .search("锚点数据", { since: base + 2 * DAY_MS, until: base + 2 * DAY_MS })
      .map((h) => h.id),
  ).toEqual([b.id]);
  // search / list / counts / countMatches 共用同一份 buildFilter，口径必须一致
  expect(
    dao
      .search("锚点数据", { since: base, until: base + 2 * DAY_MS })
      .map((h) => h.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  expect(
    dao
      .list({ since: base, until: base + 2 * DAY_MS })
      .map((r) => r.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  expect(dao.counts({ since: base, until: base + 2 * DAY_MS }).knowledge).toBe(
    2,
  );
  expect(
    dao.countMatches("锚点数据", { since: base, until: base + 2 * DAY_MS }),
  ).toBe(2);
  // 不设边界的全量口径仍是 3
  expect(dao.countMatches("锚点数据", {})).toBe(3);
});

test("timeField 默认 updated_at；created_at 不受后续修改影响", () => {
  const now = Date.now();
  const row = add({ content: "创建时间锚点 delta" });
  // 30 天前创建，刚刚更新过
  retimeRow(row.id, now, now - 30 * DAY_MS);

  expect(dao.search("创建时间锚点", { since: now - DAY_MS })).toHaveLength(1);
  expect(
    dao.search("创建时间锚点", {
      since: now - DAY_MS,
      timeField: "created",
    }),
  ).toHaveLength(0);
  expect(
    dao.search("创建时间锚点", {
      until: now - DAY_MS,
      timeField: "created",
    }),
  ).toHaveLength(1);
});

test("时间范围与 kind / 归档过滤叠加时同时生效", () => {
  const base = Date.now() - 5 * DAY_MS;
  const keep = add({ content: "叠加锚点 keep" });
  const archived = add({ content: "叠加锚点 archived" });
  const other = add({ content: "叠加锚点 other", kind: "execution" });
  for (const r of [keep, archived, other]) retimeRow(r.id, base);
  dao.archive(archived.id);

  expect(
    dao
      .search("叠加锚点", { since: base - DAY_MS })
      .map((h) => h.id)
      .sort(),
  ).toEqual([keep.id, other.id].sort());
  expect(
    dao
      .search("叠加锚点", { since: base - DAY_MS, kind: "execution" })
      .map((h) => h.id),
  ).toEqual([other.id]);
  expect(
    dao.search("叠加锚点", { since: base - DAY_MS, includeArchived: true }),
  ).toHaveLength(3);
});

test("不传边界（undefined）时行为与改动前一致", () => {
  const row = add({ content: "无边界锚点" });
  expect(dao.search("无边界锚点", {})).toHaveLength(1);
  expect(
    dao.search("无边界锚点", { since: undefined, until: undefined }),
  ).toHaveLength(1);
  expect(dao.list({}).some((r) => r.id === row.id)).toBe(true);
});

// =========================================================================
// offset 分页 —— list 分页切片（列表分页的 DAO 层基础）
// =========================================================================

/** 造 5 条 updated_at = 1000..5000 的 global 条目，让 list 切片可预期 */
function seedFiveGlobalRows(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(add({ content: `offset 分页锚点 ${i}`, scope: "global", projectId: null }).id);
  }
  ids.forEach((id, i) => retimeRow(id, (i + 1) * 1000));
  return ids;
}

test("list 支持 offset 分页（按 updated_at DESC 稳定切片）", () => {
  seedFiveGlobalRows();
  const rows = dao.list({ scope: "global", includeArchived: false, limit: 2, offset: 2 });
  expect(rows).toHaveLength(2);
  // 第 3、4 新的两条
  expect(rows[0].updatedAt).toBe(3000);
  expect(rows[1].updatedAt).toBe(2000);
});

test("list 的 since/until 与 limit/offset 组合生效", () => {
  seedFiveGlobalRows();
  const rows = dao.list({ scope: "global", includeArchived: false, since: 2000, until: 4000, limit: 10, offset: 0 });
  expect(rows.map((r) => r.updatedAt)).toEqual([4000, 3000, 2000]);
  const page2 = dao.list({ scope: "global", includeArchived: false, since: 2000, until: 4000, limit: 2, offset: 2 });
  expect(page2.map((r) => r.updatedAt)).toEqual([2000]);
});

test("list 只传 offset 不传 limit 时忽略 offset，不抛异常返回全量", () => {
  seedFiveGlobalRows();
  // SQLite 的 OFFSET 是 LIMIT 子句的组成部分，无 LIMIT 的 OFFSET 是语法错误；
  // 此处应忽略 offset，返回与不带 offset 相同的全量结果
  const rows = dao.list({ scope: "global", includeArchived: false, offset: 2 });
  const baseline = dao.list({ scope: "global", includeArchived: false });
  expect(rows).toHaveLength(5);
  expect(rows.map((r) => r.updatedAt)).toEqual(baseline.map((r) => r.updatedAt));
});

// =========================================================================
// 检索打分全集归一化（方案 D）—— 修复第一页相关性塌方
// 机理（调研报告 .superpowers/sdd/bm25-probe/bm25-probe-report.md）：修复前取池按
// `updated_at DESC LIMIT max(50, want)`，强相关条目因 updated_at 旧被整体挡在池外，
// 第一页全是「只含一节查询词的新近长文」——实验实测第一页强相关 0/40。
// 打分全集物化（LIMIT 固定 FULL_SCAN_CAP）后 min/max 天然来自全部命中，
// 「相关度优先于新近度」的排序语义恢复。
// =========================================================================

test("打分全集归一化：强相关旧条目不被新近弱相关挤出一页（第一页塌方修复）", () => {
  const day = 86_400_000;
  const now = Date.now();
  const strongIds: string[] = [];
  const weakIds: string[] = [];
  // 40 条强相关：正文短、查询词多次出现（词频高），但 updated_at 推到 60~120 天前
  for (let i = 0; i < 40; i++) {
    strongIds.push(
      add({ content: `部署方案定稿结论${i}：部署方案评审通过，部署方案全文归档` }).id,
    );
  }
  // 80 条弱相关：长正文只在末尾含一次查询词（被稀释），updated_at 全部新近（0~39 天）
  for (let i = 0; i < 80; i++) {
    weakIds.push(
      add({
        content: `周会纪要${i}：${"例行议程跟进事项记录，含进度与风险。".repeat(8)}其中一节提到部署方案。`,
      }).id,
    );
  }
  const retime = (id: string, t: number) =>
    dao.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [t, id]);
  strongIds.forEach((id, i) => retime(id, now - (60 + (i % 61)) * day));
  weakIds.forEach((id, i) => retime(id, now - (i % 40) * day));

  const strongSet = new Set(strongIds);
  // 修复前：取池 = updated_at 最新 50 条 = 全弱相关 → 第一页强相关 0/40（塌方）
  // 修复后：min/max 全集归一化 → 前 40 名恰为全部强相关条目
  const page1 = dao.search("部署方案", { limit: 50, now });
  expect(page1).toHaveLength(50);
  expect(page1.filter((h) => strongSet.has(h.id))).toHaveLength(40);
  expect(page1.slice(0, 40).every((h) => strongSet.has(h.id))).toBe(true);
});
