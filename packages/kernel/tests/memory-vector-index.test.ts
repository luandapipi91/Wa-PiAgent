import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { loadVectorExtension, initVectorColumn } from "../src/memory/vector-ext";
import { indexPendingMemories } from "../src/memory/vector-index";
import { embedQuery } from "../src/memory/embedder";

// ---------------------------------------------------------------------------
// 模型可用性门（本文件所有用例的统一前置）
//
// 5 个用例里只有「回填」一例真调模型，它依赖 bge-small-zh-v1.5（首次运行需下载约 23MB）。
// 其余 4 例（listUnindexed / 指纹 / 更新失效 / 归档）只走 SQLite + 纯字符串拼接的
// `embedFingerprint()`，本身并不需要模型、离线也能跑。本文件仍对 5 例统一门控，
// 按任务裁定保持「联网时全跑、离线时全跳」的单一门控（避免同一文件里一半跑一半跳的
// 口径漂移）。代价是离线环境会连带跳过那 4 例的可离线断言，已知并接受。
//
// 离线 / 无外网时模型加载必然失败，`embedQuery` 返回 null —— 这是「环境不具备条件」，
// 不是被测代码的错。故在文件顶部探测一次（会触发模型加载，注意：模块顶层 await
// 不受 bun 单测超时约束）：
//   - 模型可用   → 5 个用例照常执行，断言强度与覆盖面不削弱；
//   - 模型不可用 → 全部用例 skip（不是 fail）并打印原因，使离线环境下的全量测试
//     保持自足，且不会把「网络问题」伪装成「断言不符」。
// 约定与 memory-embedder.test.ts 一致：后续依赖模型 / 外网的测试文件复用同一模式。
// ---------------------------------------------------------------------------
const modelUnavailable = (await embedQuery("可用性探测")) === null;

if (modelUnavailable) {
  console.warn(
    "[memory-vector-index.test] 跳过本文件全部用例：embedding 模型不可用。\n" +
      "  原因：模型加载失败（离线 / 无法访问 hf-mirror.com / 未随包内置模型）。\n" +
      "  这不是断言失败，也不是被测代码的缺陷 —— 请在有网络的机器上重跑，\n" +
      "  或设置 WA_PI_MODEL_DIR 指向本地模型目录、WA_PI_HF_ENDPOINT 指向可用镜像。",
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

test.skipIf(modelUnavailable)("listUnindexed 返回没有 embedding 的条目", () => {
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

test.skipIf(modelUnavailable)("指纹不匹配的条目会被重新索引", () => {
  add("内容");
  db.run("UPDATE memories SET embed_meta = 'stale-model:q8:512', embedding = X'00'");
  expect(dao.listUnindexed(10)).toHaveLength(1);
});

test.skipIf(modelUnavailable)("更新内容后该条目重新变为待索引", () => {
  const a = add("旧内容");
  db.run(
    "UPDATE memories SET embedding = X'00', embed_meta = ? WHERE id = ?",
    [dao.embedFingerprint(), a.id],
  );
  expect(dao.listUnindexed(10)).toHaveLength(0);
  dao.updateContent(a.id, "新内容");
  expect(dao.listUnindexed(10)).toHaveLength(1);
});

test.skipIf(modelUnavailable)("归档条目不参与索引", () => {
  const a = add("待归档");
  dao.archive(a.id);
  expect(dao.listUnindexed(10)).toHaveLength(0);
});
