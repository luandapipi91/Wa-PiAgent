import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { loadVectorExtension, initVectorColumn, refreshQuantizedIndex } from "../src/memory/vector-ext";
import { indexPendingMemories } from "../src/memory/vector-index";
import { fuseRrf, normalizeScores, RRF_K, searchHybrid } from "../src/memory/hybrid-search";
import { embedQuery, embedQueryCallsForTest, resetEmbedderForTest } from "../src/memory/embedder";
import {
  probeModelAvailability,
  registerModelGateFailure,
} from "./helpers/model-gate";

// ---------------------------------------------------------------------------
// 模型可用性门（只挂在「断言依赖语义通道真的返回结果」的用例上）
//
// 本文件里只有「断言依赖语义通道真的产出候选」的用例才挂 `skipIf(modelUnavailable)`。
// 其余用例：
//   - 用例 1 是纯函数（fuseRrf，不碰模型、不碰库）；
//   - 用例 3 断言「词法精确命中仍在结果里」，语义通道可用与否都成立；
//   - 用例 4 断言「语义通道不可用时静默降级」，本身就是降级路径；
//   - 用例 5 断言 scope 收窄契约（不返回其它项目条目），两种模式下都成立。
// 「语义通道中途抛错」与「语义侧回读抛错」两例必须先有查询向量才能走到被替换的那一步，
// 离线无法构造，故同样挂门。
// 给它们加门会让这几条离线可跑的断言（尤其降级契约）在离线 / 无网 CI 上归零 —— 这正是
// 任务 5 审查裁定要避免的「离线覆盖损失」。因此门只挂在真正依赖模型的用例上。
//
// 离线 / 无外网时模型加载必然失败，`embedQuery` 返回 null —— 这是「环境不具备条件」，
// 不是被测代码的错。故在文件顶部探测一次（会触发模型加载，注意：模块顶层 await
// 不受 bun 单测超时约束），三态判定（见 tests/helpers/model-gate.ts）：
//   - available → 带门的该例照常执行；
//   - noSource  → 带门的该例 skip（不是 fail）并打印原因，不把「网络问题」伪装成「断言不符」；
//   - broken    → 声明了模型来源却仍加载失败 → **判红**（真实故障，不是环境不具备）。
// 约定与 memory-embedder.test.ts / memory-vector-index.test.ts 一致。
// ---------------------------------------------------------------------------
const gate = await probeModelAvailability();
registerModelGateFailure(gate, "memory-hybrid-search.test");
const modelUnavailable = gate.status !== "available";

if (modelUnavailable) {
  console.warn(
    `[memory-hybrid-search.test] ${gate.detail}\n` +
      "  不依赖模型的用例（RRF 纯函数 / 词法命中 / 扩展降级 / scope 收窄 / 扩展未就绪探针 / embedQuery 返回 null）仍照常执行。",
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

// 任务 7 裁定：RRF 融合分数量级（单通道上限 1/(K+1)≈0.0164、双通道 2/(K+1)≈0.0328）
// 必须归一到词法通道的「0–1 加权和」量纲，否则 memory_search 的 score 字段在接线前后
// 是两套完全不同的数字（任何读 score 的展示 / 阈值 / 评测逻辑都会失真）。
// 本用例是离线可跑的纯函数契约；「归一化真的被 searchHybrid 调用」由下一条
// 「语义通道能召回…」用例里的 score 断言守住（把 searchHybrid 里的调用删掉，它变红）。
test("normalizeScores 把融合分数归一到 (0, 1]：首位为 1、其余按比例（空集 / 零分不产生 NaN）", () => {
  const normalized = normalizeScores([
    { score: 2 / (RRF_K + 1) },
    { score: 1 / (RRF_K + 1) },
  ]);
  expect(normalized[0].score).toBe(1);
  expect(normalized[1].score).toBeCloseTo(0.5, 10);
  expect(normalized.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
  // 边界：空集原样返回；首位为 0（理论不可达）不得除成 NaN
  expect(normalizeScores([])).toEqual([]);
  expect(normalizeScores([{ score: 0 }])).toEqual([{ score: 0 }]);
});

test.skipIf(modelUnavailable)("语义通道能召回无共同关键词的条目", async () => {
  const hits = await searchHybrid(dao, "上线前要做什么质量检查", { projectScope: "Wa-Pi", limit: 3 });
  expect(hits[0].content).toContain("发版流程需要先跑单元测试");
  // score 量纲与词法通道对齐：首位（最相关）归一为 1，不再是 RRF 的 ≈0.0164。
  // 回归方式：把 searchHybrid 末尾的 normalizeScores 去掉（直接返回 f.score），此处变红。
  expect(hits[0].score).toBe(1);
  expect(hits.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
  // 该查询词法零命中 → 命中的全是「语义独有」。它们与词法命中同属 HybridSearchHit：
  // embedding 必须统一为 null（getByIds 显式投影、不物化向量）。
  // 回归方式：getByIds 改回 `SELECT *`，此处立刻变红。
  expect(hits[0].embedding ?? null).toBeNull();
  expect(hits.every((h) => (h.embedding ?? null) === null)).toBe(true);
});

test("词法精确查询仍能命中（不被语义通道淹没）", async () => {
  // 语料条数必须 > limit：否则无论融合怎么排，返回集都必然含全部语料，断言恒真
  //（这正是本用例此前的盲区——3 条语料 + limit 3 等于什么也没验证）。
  // 此处 beforeEach 的 3 条 + 新增 5 条会被语义通道召回的条目 = 8 条，limit 收紧到 3，
  // 让这 3 个名额变成真正被争夺的资源。
  for (let i = 0; i < 5; i++) {
    dao.insert({
      kind: "knowledge",
      target: "memory",
      scope: "project",
      projectId: "Wa-Pi",
      content: `无关条目 ${i}：依赖源换成国内高校站点以提速`,
      source: "agent",
    });
  }
  await indexPendingMemories(dao);
  refreshQuantizedIndex(db);

  // 精确命中这条刻意「刚写入、回填还没跟上」→ 没有 embedding，而语义扫描
  // （WHERE embedding IS NOT NULL）扫不到它，所以它只能由词法通道贡献。
  // 这样断言才可被证伪：把词法通道从融合里丢掉、或只保留语义候选，它必然从结果里消失。
  // 反之，若让它也进语义库，实测它同时是语义 top-1（正文字面含查询词）——
  // 丢掉词法通道也不会掉出结果，断言对最该防的回归反而免疫（假守护）。
  const exact = dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "本周杂记：修了三个 bug，顺手整理了灰度发布回滚预案，然后开会补文档",
    source: "agent",
  });

  const hits = await searchHybrid(dao, "灰度发布回滚预案", { projectScope: "Wa-Pi", limit: 3 });
  expect(hits.length).toBeLessThanOrEqual(3);
  const hit = hits.find((h) => h.id === exact.id);
  expect(hit).toBeDefined();
  expect(hit!.channels).toContain("lexical");
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

// 重要 2 护栏：扫描之后的语义侧 DB 读（回读 / 融合阶段）必须在同一个兜底之下。
// getByIds 抛错即模拟「库被占用 / 损坏，或 SCAN_K 调大到撞上 SQLite 的
// `too many SQL variables`」——守住「绝不让 memory_search 失败」。
// 回归方式：把 getByIds 移出 try（回到「catch 只包 embedQuery + quantizedScan」的旧结构），
// 本用例会直接 reject，红。
test.skipIf(modelUnavailable)("语义侧回读（getByIds）抛错时静默降级为纯词法结果", async () => {
  const expected = dao.search("南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
  const broken = new MemoryDao(db);
  broken.getByIds = () => {
    throw new Error("too many SQL variables");
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
  expect(hits.map((h) => h.id)).toEqual(expected.map((h) => h.id));
  expect(hits.every((h) => h.channels.join() === "lexical")).toBe(true);
  expect(logged.some((l) => l.includes("[memory-semantic]"))).toBe(true);
});

// 次要 4 护栏：扩展未就绪时必须**根本不进入语义分支**，而不是「进了但被 quantizedScan
// 内部的同样检查挡成空」。后者即使把最外层的 `if (isVectorReady(...))` 整个删掉也照样
// 全绿（因为 quantizedScan 自带同样判断，两处行为对返回值不可区分）——是盲区。
// 探针：embedQuery 的调用计数。删掉外层判断后 embedQuery 必被调用，计数 +1 → 红。
// 用 failNextLoad 让被删后的错误路径不去碰真实模型，护栏本身对离线 / 在线都成立。
test("扩展未就绪时不进入语义分支：embedQuery 未被调用", async () => {
  const fresh = new Database(":memory:");
  fresh.run(SCHEMA_SQL);
  // 刻意不 loadVectorExtension / initVectorColumn → isVectorReady(fresh) === false
  const freshDao = new MemoryDao(fresh);
  freshDao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "南京大学镜像",
    source: "agent",
  });
  resetEmbedderForTest({ failNextLoad: true });
  try {
    const before = embedQueryCallsForTest();
    const hits = await searchHybrid(freshDao, "南京大学镜像", { projectScope: "Wa-Pi", limit: 3 });
    expect(embedQueryCallsForTest()).toBe(before);
    expect(hits.map((h) => h.content).join("\n")).toContain("南京大学镜像");
    expect(hits.every((h) => h.channels.join() === "lexical")).toBe(true);
  } finally {
    resetEmbedderForTest();
  }
  fresh.close();
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
