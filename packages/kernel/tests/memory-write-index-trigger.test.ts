// 写入后的增量语义回填（覆盖整个分支的最终审查 I1）。
//
// 缺口：`insert()` 不写向量、`updateContent()` 把向量置 NULL，而全仓 `indexPendingMemories`
// 的调用点原先**只有** src/index.ts 的启动回填；desktop 的 kernel 是长驻 sidecar
//（一次启动、异常才重启）→ 用户在会话里刚记下的记忆，同一进程内 `memory_search` 的语义通道
// 搜不到（只剩词面命中），而这正是规格 §1 要解决的核心场景；被改写过的条目还会从语义候选里消失。
//
// 修法（控制者裁决）：memory_add / memory_replace 成功后 debounce 触发一次
// `indexPendingMemories` —— 不阻塞写入（fire-and-forget），失败只记 `[memory-semantic]` 日志。
// 本文件钉住这条接线：把 tools.ts 里的 schedule 调用去掉，用例 3 / 4 立刻变红。
//
// 模型可用性门：三态（见 tests/helpers/model-gate.ts）。用例 1 / 2 / 5 / 6 不调模型，
// 离线照常执行；只有「语义通道真的命中」的两例挂门。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { createMemoryTools, type MemoryToolContext } from "../src/memory/tools";
import { loadVectorExtension, initVectorColumn } from "../src/memory/vector-ext";
import {
  flushScheduledIndexForTest,
  indexRunsForTest,
  resetIndexSchedulerForTest,
  setIndexDebounceMsForTest,
} from "../src/memory/vector-index";
import {
  probeModelAvailability,
  registerModelGateFailure,
} from "./helpers/model-gate";

const gate = await probeModelAvailability();
registerModelGateFailure(gate, "memory-write-index-trigger.test");
const modelUnavailable = gate.status !== "available";
if (modelUnavailable) {
  console.warn(`[memory-write-index-trigger.test] ${gate.detail}`);
}

/** 与 memory-semantic-e2e.test.ts 同源的四条干扰语料（该文件已实测过判别余量） */
const DISTRACTORS = [
  "发版流程需要先跑单元测试和四层测试",
  "打包发布时更新说明只保留当次版本内容",
  "bun 升级要走 npmmirror 镜像手动替换可执行文件",
  "记忆检索采用关键词加分与时间衰减的加权排序",
];

let db: Database;
let dao: MemoryDao;
let ctx: MemoryToolContext;
let tools: ReturnType<typeof createMemoryTools>;

function makeTools(overrides: Partial<MemoryToolContext> = {}) {
  ctx = { dao, projectId: "Wa-Pi", ...overrides };
  tools = createMemoryTools(ctx);
}

/** 调用工具并解析回传 JSON（execute 返回 { content: [{ text }] } 包装） */
async function call(name: string, params: unknown) {
  const tool = tools.find((t) => t.name === name)!;
  const res: any = await tool.execute("1", params);
  return JSON.parse(res.content[0].text);
}

/** 写入前先造干扰语料，让「命中」有判别力（小语料下召回恒真） */
function seedDistractors() {
  for (const content of DISTRACTORS) {
    dao.insert({
      kind: "knowledge",
      target: "memory",
      scope: "project",
      projectId: "Wa-Pi",
      content,
      source: "agent",
    });
  }
}

beforeEach(() => {
  resetIndexSchedulerForTest();
  db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  loadVectorExtension(db);
  initVectorColumn(db);
  dao = new MemoryDao(db);
  makeTools();
});

afterEach(() => {
  // 模块级的 debounce 定时器是进程级状态：不清会跨用例泄漏（下一个用例的库里被写入向量）
  resetIndexSchedulerForTest();
  db.close();
});

test("memory_add 成功返回时还没有向量，且此时尚未触发回填（写入不被索引阻塞）", async () => {
  setIndexDebounceMsForTest(60_000); // 让 debounce 在断言期绝无可能到期
  const res = await call("memory_add", {
    target: "memory",
    content: "中国大陆下载慢怎么办：Go 工具链安装在 D 盘并使用国内下载源",
  });
  expect(res.success).toBe(true);
  // 写入已落库（工具如实返回），但向量的补齐被推迟到 debounce 之后
  expect(dao.getById(res.id)).not.toBeNull();
  expect(dao.listUnindexed(10).map((r) => r.id)).toContain(res.id);
  expect(indexRunsForTest()).toBe(0);
});

test("连续写入被 debounce 合并成一次回填（不叠加重复工作）", async () => {
  setIndexDebounceMsForTest(25);
  await call("memory_add", { target: "memory", content: "合并用例甲" });
  await call("memory_add", { target: "memory", content: "合并用例乙" });
  await call("memory_add", { target: "memory", content: "合并用例丙" });
  await new Promise((r) => setTimeout(r, 150)); // 远超 3 个 debounce 周期
  // 每次都单独起一个定时器 → 本断言变成 3（红）；合并成一个 → 1
  expect(indexRunsForTest()).toBe(1);
});

test.skipIf(modelUnavailable)(
  "memory_add 之后 debounce 回填补齐向量：语义通道能命中刚写入的记忆",
  async () => {
    seedDistractors();
    const query = "中国大陆下载慢怎么办";
    const res = await call("memory_add", {
      target: "memory",
      content: "Go 工具链安装在 D 盘并使用国内下载源",
    });
    // 前置不变量：该查询词法零命中（词法能命中就证明不了语义通道）
    expect(dao.search(query, { projectScope: "Wa-Pi", limit: 50 })).toHaveLength(0);

    await flushScheduledIndexForTest();

    // 回填补齐：向量落库、待索引清空
    expect(dao.listUnindexed(10)).toHaveLength(0);
    expect(dao.getById(res.id)!.embedding).not.toBeNull();

    // 语义通道（memory_search 默认走混合检索）命中刚写入的这条
    const found = await call("memory_search", { query, limit: 3 });
    expect(found.results[0].snippet).toContain("Go 工具链安装在 D 盘");
    expect(found.totalMatched).toBeGreaterThanOrEqual(1);
  },
);

test.skipIf(modelUnavailable)(
  "memory_replace 改写后被重新入索引：语义通道命中新内容",
  async () => {
    seedDistractors();
    // 先写入一条与「发版流程」同主题的条目并回填，作为改写对象
    const added = await call("memory_add", {
      target: "memory",
      content: "发版流程需要先跑单元测试",
    });
    await flushScheduledIndexForTest();
    expect(dao.getById(added.id)!.embedding).not.toBeNull();

    await call("memory_replace", {
      id: added.id,
      newContent: "Go 工具链安装在 D 盘并使用国内下载源",
    });
    // updateContent 把向量置 NULL（向量已失效）→ 必须由 debounce 回填重算，
    // 否则该条目会永久退出语义候选（本条断言即「去掉 replace 后的 schedule」的回归检测）
    expect(dao.getById(added.id)!.embedding ?? null).toBeNull();
    expect(dao.listUnindexed(10).map((r) => r.id)).toContain(added.id);

    await flushScheduledIndexForTest();
    expect(dao.getById(added.id)!.embedding).not.toBeNull();
    expect(dao.listUnindexed(10)).toHaveLength(0);

    const query = "中国大陆下载慢怎么办";
    expect(dao.search(query, { projectScope: "Wa-Pi", limit: 50 })).toHaveLength(0);
    const found = await call("memory_search", { query, limit: 3 });
    expect(found.results[0].snippet).toContain("Go 工具链安装在 D 盘");
  },
);

test("回填失败只记 [memory-semantic] 日志，不外抛（fire-and-forget 的失败面）", async () => {
  // 模拟 DB 层故障：runIndex 内部对推理异常已兜底，但 DB 层异常会外溢为 rejected promise，
  // 调度器必须自己 catch 住（否则后台会出现未捕获的 promise rejection）。
  dao.listUnindexed = () => {
    throw new Error("模拟 DB 层故障");
  };
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await call("memory_add", { target: "memory", content: "失败用例" });
    await flushScheduledIndexForTest();
  } finally {
    console.error = orig;
  }
  expect(logged.join("\n")).toContain("[memory-semantic]");
  expect(logged.join("\n")).toContain("模拟 DB 层故障");
});

test("semanticEnabled=false 时不调度回填（开关关闭不做无谓工作）", async () => {
  makeTools({ semanticEnabled: false });
  setIndexDebounceMsForTest(25);
  await call("memory_add", { target: "memory", content: "开关关闭用例" });
  await new Promise((r) => setTimeout(r, 60));
  expect(indexRunsForTest()).toBe(0);
});
