import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { loadVectorExtension, initVectorColumn } from "../src/memory/vector-ext";
import { indexPendingMemories } from "../src/memory/vector-index";
import { embedQuery } from "../src/memory/embedder";

// ---------------------------------------------------------------------------
// 模型可用性门（只挂在真正调用模型的用例上）
//
// 5 个用例里只有「回填后…」一例真调模型（bge-small-zh-v1.5，首次运行需下载约 23MB），
// 故**只有它**挂 `skipIf(modelUnavailable)`。其余 4 例
//（listUnindexed / 指纹 / 更新失效 / 归档）只走内存 SQLite + 纯字符串拼接的
// `embedFingerprint()`，本身不依赖模型、离线可跑 —— 若给它们也加门，离线 / 无网 CI 下
// 这三条新 DAO 行为（listUnindexed / setEmbedding / updateContent 失效）就零断言。
// 因此门只挂在依赖模型的用例上。
//
// 离线 / 无外网时模型加载必然失败，`embedQuery` 返回 null —— 这是「环境不具备条件」，
// 不是被测代码的错。故在文件顶部探测一次（会触发模型加载，注意：模块顶层 await
// 不受 bun 单测超时约束），仅供那一例判定是否 skip：
//   - 模型可用   → 该例照常执行；
//   - 模型不可用 → 该例 skip（不是 fail）并打印原因，不把「网络问题」伪装成「断言不符」。
// 约定与 memory-embedder.test.ts 一致。
// ---------------------------------------------------------------------------
const modelUnavailable = (await embedQuery("可用性探测")) === null;

if (modelUnavailable) {
  console.warn(
    "[memory-vector-index.test] 跳过依赖模型的用例：embedding 模型不可用。\n" +
      "  原因：模型加载失败（离线 / 无法访问 hf-mirror.com / 未随包内置模型）。\n" +
      "  不依赖模型的用例仍照常执行 —— 只有「回填」一例会 skip。\n" +
      "  请在有网络的机器上重跑，或设置 WA_PI_MODEL_DIR 指向本地模型目录、\n" +
      "  WA_PI_HF_ENDPOINT 指向可用镜像。",
  );
}

let db: Database;
let dao: MemoryDao;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  loadVectorExtension(db);
  initVectorColumn(db);
  dao = new MemoryDao(db);
});

function add(content: string) {
  return dao.insert({ kind: "knowledge", target: "memory", scope: "project", projectId: "Wa-Pi", content, source: "agent" });
}

test("listUnindexed 返回没有 embedding 的条目", () => {
  add("第一条");
  add("第二条");
  expect(dao.listUnindexed(10)).toHaveLength(2);
});

test.skipIf(modelUnavailable)("回填后 listUnindexed 为空且 embedding 已落库", async () => {
  const a = add("发版流程需要先跑单元测试");
  add("上线前必须执行单元测试");
  const res = await indexPendingMemories(dao, { batchSize: 8 });
  expect(res.indexed).toBe(2);
  expect(dao.listUnindexed(10)).toHaveLength(0);
  const row = dao.getById(a.id)!;
  expect(row.embedding).toBeInstanceOf(Uint8Array);
  expect(row.embedding!.byteLength).toBe(512 * 4);
  expect(row.embedMeta).toBe(dao.embedFingerprint());
});

test("指纹不匹配的条目会被重新索引", () => {
  add("内容");
  db.run("UPDATE memories SET embed_meta = 'stale-model:q8:512', embedding = X'00'");
  expect(dao.listUnindexed(10)).toHaveLength(1);
});

test("更新内容后该条目重新变为待索引", () => {
  const a = add("旧内容");
  db.run(
    "UPDATE memories SET embedding = X'00', embed_meta = ? WHERE id = ?",
    [dao.embedFingerprint(), a.id],
  );
  expect(dao.listUnindexed(10)).toHaveLength(0);
  dao.updateContent(a.id, "新内容");
  expect(dao.listUnindexed(10)).toHaveLength(1);
});

test("归档条目不参与索引", () => {
  const a = add("待归档");
  dao.archive(a.id);
  expect(dao.listUnindexed(10)).toHaveLength(0);
});

// 词法热路径（search / searchBySubstring）显式投影、不物化 2KB 向量。
// 这条断言是「词法检索不带 embedding」的持久契约：若有人把 SELECT 改回 m.*，
// 打分全集（FULL_SCAN_CAP = 2000）会重新每次多读 / 多分配约 4MB BLOB，本例会立刻变红。
test("词法检索不物化向量：hit 的 embedding 为 null", () => {
  const a = add("发布流程需要先跑单元测试");
  // 造一个「已索引」条目（2KB 向量已落库）
  db.run("UPDATE memories SET embedding = ?, embed_meta = ? WHERE id = ?", [
    new Uint8Array(512 * 4),
    dao.embedFingerprint(),
    a.id,
  ]);

  // FTS 路径（多字查询命中 bigram）
  const hits = dao.search("单元测试");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.embedding ?? null).toBeNull();

  // 子串回退路径（单字查询 FTS 零命中）
  const fallback = dao.search("测");
  expect(fallback.length).toBeGreaterThan(0);
  expect(fallback[0]!.embedding ?? null).toBeNull();
});
