import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { loadVectorExtension, initVectorColumn, refreshQuantizedIndex } from "../src/memory/vector-ext";
import { indexPendingMemories } from "../src/memory/vector-index";
import { fuseRrf, searchHybrid } from "../src/memory/hybrid-search";
import { embedQuery, resetEmbedderForTest } from "../src/memory/embedder";

// ---------------------------------------------------------------------------
// 模型可用性门（只挂在「断言依赖语义通道真的返回结果」的用例上）
//
// 5 个用例里只有「语义通道能召回无共同关键词的条目」一例的断言依赖语义通道真的产出
// 候选（该查询与库中任何条目都无共同 bigram，词法通道必然为空），故**只有它**挂
// `skipIf(modelUnavailable)`。其余 4 例：
//   - 用例 1 是纯函数（fuseRrf，不碰模型、不碰库）；
//   - 用例 3 断言「词法精确命中仍在结果里」，语义通道可用与否都成立；
//   - 用例 4 断言「语义通道不可用时静默降级」，本身就是降级路径；
//   - 用例 5 断言 scope 收窄契约（不返回其它项目条目），两种模式下都成立。
// 给它们加门会让这几条离线可跑的断言（尤其降级契约）在离线 / 无网 CI 上归零 —— 这正是
// 任务 5 审查裁定要避免的「离线覆盖损失」。因此门只挂在真正依赖模型的那一例上。
//
// 离线 / 无外网时模型加载必然失败，`embedQuery` 返回 null —— 这是「环境不具备条件」，
// 不是被测代码的错。故在文件顶部探测一次（会触发模型加载，注意：模块顶层 await
// 不受 bun 单测超时约束），仅供那一例判定是否 skip：
//   - 模型可用   → 该例照常执行；
//   - 模型不可用 → 该例 skip（不是 fail）并打印原因，不把「网络问题」伪装成「断言不符」。
// 约定与 memory-embedder.test.ts / memory-vector-index.test.ts 一致。
// ---------------------------------------------------------------------------
const modelUnavailable = (await embedQuery("可用性探测")) === null;

if (modelUnavailable) {
  console.warn(
    "[memory-hybrid-search.test] 跳过依赖模型的用例：embedding 模型不可用。\n" +
      "  原因：模型加载失败（离线 / 无法访问 hf-mirror.com / 未随包内置模型）。\n" +
      "  不依赖模型的 4 例（RRF 纯函数 / 词法命中 / 降级契约 / scope 收窄）仍照常执行。\n" +
      "  请在有网络的机器上重跑，或设置 WA_PI_MODEL_DIR 指向本地模型目录、\n" +
      "  WA_PI_HF_ENDPOINT 指向可用镜像。",
  );
}

let db: Database;
let dao: MemoryDao;

beforeEach(async () => {
  db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  loadVectorExtension(db);
  initVectorColumn(db);
  dao = new MemoryDao(db);
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "发版流程需要先跑单元测试和四层测试",
    source: "agent",
  });
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "Go 工具链安装在 D 盘，下载源用南京大学镜像",
    source: "agent",
  });
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "今天中午吃什么",
    source: "agent",
  });
  await indexPendingMemories(dao);
  // 回填只写 embedding 列；量化索引必须显式刷新，否则语义通道查不到任何向量
  refreshQuantizedIndex(db);
});

test("fuseRrf 按名次融合并对只出现在单路的条目降权", () => {
  const fused = fuseRrf<string>([["a", "b"], ["b", "c"]], (x) => x);
  const byId = Object.fromEntries(fused.map((f) => [f.item, f.score]));
  expect(byId["b"]).toBeGreaterThan(byId["a"]);
  expect(byId["b"]).toBeGreaterThan(byId["c"]);
});

test.skipIf(modelUnavailable)("语义通道能召回无共同关键词的条目", async () => {
  const hits = await searchHybrid(dao, "上线前要做什么质量检查", { projectScope: "Wa-Pi", limit: 3 });
  expect(hits[0].content).toContain("发版流程需要先跑单元测试");
});

test("词法精确查询仍能命中（不被语义通道淹没）", async () => {
  const hits = await searchHybrid(dao, "南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
  expect(hits.map((h) => h.content).join("\n")).toContain("南京大学镜像");
});

test("语义通道不可用时静默降级为纯词法结果", async () => {
  const fresh = new Database(":memory:");
  fresh.run(SCHEMA_SQL);
  const freshDao = new MemoryDao(fresh);
  freshDao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "南京大学镜像",
    source: "agent",
  });
  const hits = await searchHybrid(freshDao, "南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
  expect(hits).toHaveLength(1);
  fresh.close();
});

test("scope 收窄生效：不返回其它项目的条目", async () => {
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "other-repo",
    content: "发版流程需要先跑单元测试和四层测试",
    source: "agent",
  });
  await indexPendingMemories(dao);
  refreshQuantizedIndex(db);
  const hits = await searchHybrid(dao, "上线前要做什么质量检查", { projectScope: "Wa-Pi", limit: 5 });
  expect(hits.every((h) => h.projectId === "Wa-Pi" || h.scope === "global")).toBe(true);
});

// 降级契约（硬要求）：查询侧不是「模型不可用」而是「中途抛错」时也必须退回纯词法。
// 这条只能靠真实模型走到 matchesScope 那一步（isVectorReady + embedQuery 非 null），故带门。
test.skipIf(modelUnavailable)("语义通道中途抛错时静默降级为纯词法结果", async () => {
  const expected = dao.search("南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
  // 只替换这一个实例的方法：模拟语义通道内部抛错（编码异常 / 过滤期 DB 错误），
  // 不需要 mock.module（无跨文件泄漏风险）。
  const broken = new MemoryDao(db);
  broken.matchesScope = () => {
    throw new Error("semantic boom");
  };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  let hits: Awaited<ReturnType<typeof searchHybrid>>;
  try {
    hits = await searchHybrid(broken, "南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
  } finally {
    console.error = realError;
  }
  // 不抛错（memory_search 不因语义故障失败）、结果与纯词法完全一致、通道标记为 lexical
  expect(hits.map((h) => h.id)).toEqual(expected.map((h) => h.id));
  expect(hits.every((h) => h.channels.join() === "lexical")).toBe(true);
  expect(logged.some((l) => l.includes("[memory-semantic]"))).toBe(true);
});

// 降级契约的第二条分支：模型不可用 → embedQuery 返回 null —— 不是 skip，而是必须退回纯词法。
// 用 embedder 自带的 resetEmbedderForTest 把单例置为失败态，因此本用例必须**置于文件末尾**，
// 并在结束时把单例复位（否则同进程混跑、不带 --isolate 时，后续文件的模型探测会误判为不可用，
// 使它们的模型门用例静默 skip —— 静默掉断言比失败更阴）。
test("embedQuery 返回 null 时静默降级为纯词法结果", async () => {
  resetEmbedderForTest({ failNextLoad: true });
  try {
    expect(await embedQuery("任意文本")).toBeNull();
    const expected = dao.search("南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
    const hits = await searchHybrid(dao, "南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
    expect(hits.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    expect(hits.every((h) => h.channels.join() === "lexical")).toBe(true);
  } finally {
    resetEmbedderForTest();
  }
});
