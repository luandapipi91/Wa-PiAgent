// memory store 单元测试：服务端检索（FTS/BM25）+ 列表分页状态机。
// - 关键词 / 作用域 / 层 / 归档 / 日期窗一并下推到 GET /api/memories/search；
// - 列表分页 loadPage/loadMore 组装 /api/memories?limit=50&...，store 只维护
//   pageEntries/pageHasMore/pageCounts（替代旧全量 memories/archived 字段）。
import { test, expect, beforeEach, mock } from "bun:test";
import {
  useMemoryStore,
  dateFromToSinceMs,
  dateToToUntilMs,
  type MemoryPageParams,
} from "../src/store/memory";
import type { MemoryEntry, MemorySearchResult } from "@wa-pi/shared";

// store 的 search/load 会触发 api.get（真实 fetch），happy-dom 对相对 URL 抛错。
// 沿用仓库既有做法：mock 掉 api-client，断言聚焦于 URL 组装与 state 变更。
const getMock = mock();
mock.module("../src/api-client", () => ({
  api: {
    get: getMock,
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

/** 等一轮微任务 + 宏任务，让 promise 链里的 set 落地 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const lastUrl = () => String(getMock.mock.calls[getMock.mock.calls.length - 1][0]);
const allUrls = () => getMock.mock.calls.map((c) => String(c[0]));
const queryOf = (url: string) => new URLSearchParams(url.split("?")[1] ?? "");

const mkEntry = (id: string): MemoryEntry =>
  ({
    id,
    text: `内容-${id}`,
    scope: "global",
    kind: "knowledge",
    createdAt: "2026-09-01T00:00:00.000Z",
  }) as MemoryEntry;

const mkHit = (id: string): MemorySearchResult =>
  ({
    id,
    title: `标题-${id}`,
    snippet: `命中-${id}`,
    kind: "knowledge",
    scope: "global",
    updatedAt: "2026-09-01T00:00:00.000Z",
    score: 1,
    archived: false,
  }) as MemorySearchResult;

/** 分页参数基准（global / active / 无筛选），各测试按需覆盖 */
const baseParams: MemoryPageParams = {
  scope: "global",
  projectId: null,
  tab: "active",
  kind: null,
  dateFrom: null,
  dateTo: null,
};

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [],
    totalMatched: 0,
  });
  useMemoryStore.setState({
    instructions: [],
    config: null,
    searchResults: null,
    searchTotalMatched: 0,
    searching: false,
    searchParams: null,
    searchHasMore: false,
    searchLoadingMore: false,
    pageEntries: [],
    pageHasMore: false,
    pageCounts: { active: 0, archived: 0 },
    pageLoading: false,
    loadingMore: false,
    dateFrom: null,
    dateTo: null,
    lastPageParams: null,
  });
});

// ---------- 检索（search / searchMore）----------

test("search(): 组装 q/scope/kind/limit 查询串", async () => {
  useMemoryStore.getState().search({
    query: "记忆 检索&x",
    scope: "global",
    projectId: null,
    kind: "execution",
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();

  const url = lastUrl();
  expect(url.startsWith("/api/memories/search?")).toBe(true);
  const qs = queryOf(url);
  expect(qs.get("q")).toBe("记忆 检索&x");
  expect(qs.get("scope")).toBe("global");
  expect(qs.get("kind")).toBe("execution");
  expect(qs.get("limit")).toBe("50");
  expect(qs.has("projectId")).toBe(false);
  expect(qs.has("archivedOnly")).toBe(false);
  expect(qs.has("since")).toBe(false);
  expect(qs.has("until")).toBe(false);
});

test("search(): archivedOnly 为真时附 archivedOnly=true，kind 为 null 时不附", async () => {
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: true,
    dateFrom: null,
    dateTo: null,
  });
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("archivedOnly")).toBe("true");
  expect(qs.has("kind")).toBe(false);
});

test("search(): scope=project 且带 projectId 时附 projectId", async () => {
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "project",
    projectId: "proj-9",
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("scope")).toBe("project");
  expect(qs.get("projectId")).toBe("proj-9");
});

test("search(): dateFrom/dateTo 转本地时区 since/until 毫秒下推", async () => {
  useMemoryStore.getState().search({
    query: "hi",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: "2026-09-01",
    dateTo: "2026-09-15",
  });
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("since")).toBe(String(dateFromToSinceMs("2026-09-01")));
  expect(qs.get("until")).toBe(String(dateToToUntilMs("2026-09-15")));
});

test("search(): scope=project 但 projectId 为空时不发请求，searchResults 置 []", async () => {
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "project",
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();

  expect(getMock).not.toHaveBeenCalled();
  const s = useMemoryStore.getState();
  expect(s.searchResults).toEqual([]);
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searching).toBe(false);
});

test("search(): 空查询（或纯空白）不发请求并复位为未检索态", async () => {
  useMemoryStore.setState({ searchResults: [{ id: "old" } as any], searchTotalMatched: 3 });
  useMemoryStore.getState().search({
    query: "   ",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();

  expect(getMock).not.toHaveBeenCalled();
  const s = useMemoryStore.getState();
  expect(s.searchResults).toBeNull();
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searching).toBe(false);
  expect(s.searchParams).toBeNull();
});

test("search(): 成功响应写入 results/totalMatched/searchHasMore 并结束 searching", async () => {
  const results: MemorySearchResult[] = [
    {
      id: "hit-1",
      title: "标题",
      snippet: "命中片段",
      kind: "knowledge",
      scope: "global",
      updatedAt: "2026-08-01T00:00:00.000Z",
      score: 1.2,
      archived: false,
    },
  ];
  getMock.mockResolvedValue({ type: "memory:search", results, totalMatched: 7, hasMore: true });

  const params = {
    query: "pnpm",
    scope: "global" as const,
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  };
  useMemoryStore.getState().search(params);
  expect(useMemoryStore.getState().searching).toBe(true);
  expect(useMemoryStore.getState().searchParams).toEqual(params);
  await flush();

  const s = useMemoryStore.getState();
  expect(s.searchResults).toEqual(results);
  expect(s.searchTotalMatched).toBe(7);
  expect(s.searchHasMore).toBe(true);
  expect(s.searching).toBe(false);
});

test("search(): 请求失败不抛异常，searching 结束且 results 置 []", async () => {
  getMock.mockRejectedValue(new Error("boom"));
  expect(() =>
    useMemoryStore.getState().search({
      query: "pnpm",
      scope: "global",
      projectId: null,
      kind: null,
      archivedOnly: false,
      dateFrom: null,
      dateTo: null,
    }),
  ).not.toThrow();
  await flush();

  const s = useMemoryStore.getState();
  expect(s.searching).toBe(false);
  expect(s.searchResults).toEqual([]);
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searchHasMore).toBe(false);
});

test("search(): 发起时复位 searchLoadingMore，防止在途翻页卡死新检索的滚动加载", () => {
  // 模拟旧检索的 searchMore 在途（置 true）+ 旧 searchParams 非空
  useMemoryStore.setState({
    searchParams: {
      query: "旧词",
      scope: "global",
      projectId: null,
      kind: null,
      archivedOnly: false,
      dateFrom: null,
      dateTo: null,
    },
    searchResults: [mkHit("hit-1")],
    searchLoadingMore: true,
  });
  // 同步阶段断言：发起新检索的 set 里已复位（与 loadPage 对 loadingMore 的复位对称）
  useMemoryStore.getState().search({
    query: "新词",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  expect(useMemoryStore.getState().searchLoadingMore).toBe(false);
});

test("searchMore(): offset=已检索条数，去重追加并更新 searchHasMore", async () => {
  useMemoryStore.setState({
    searchParams: {
      query: "hi",
      scope: "global",
      projectId: null,
      kind: null,
      archivedOnly: false,
      dateFrom: null,
      dateTo: null,
    },
    searchResults: [mkHit("hit-1"), mkHit("hit-2")],
    searchHasMore: true,
  });
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [mkHit("hit-2"), mkHit("hit-3")], // 带 id 重叠，验证去重
    totalMatched: 5,
    hasMore: false,
  });
  useMemoryStore.getState().searchMore();
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("offset")).toBe("2");
  const s = useMemoryStore.getState();
  expect(s.searchResults?.map((r) => r.id)).toEqual(["hit-1", "hit-2", "hit-3"]);
  expect(s.searchHasMore).toBe(false);
  expect(s.searchLoadingMore).toBe(false);

  // searchHasMore=false 后再调不发请求
  useMemoryStore.getState().searchMore();
  await flush();
  expect(getMock).toHaveBeenCalledTimes(1);
});

test("clearSearch(): 复位检索字段与分页标记", async () => {
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [{ id: "hit-1" }],
    totalMatched: 1,
    hasMore: true,
  });
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();
  expect(useMemoryStore.getState().searchResults).not.toBeNull();
  expect(useMemoryStore.getState().searchHasMore).toBe(true);

  useMemoryStore.getState().clearSearch();

  const s = useMemoryStore.getState();
  expect(s.searchResults).toBeNull();
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searching).toBe(false);
  expect(s.searchParams).toBeNull();
  expect(s.searchHasMore).toBe(false);
  expect(s.searchLoadingMore).toBe(false);
});

// ---------- 列表分页（loadPage / loadMore / setDateRange / setMemories）----------

test("dateFromToSinceMs/dateToToUntilMs：本地时区毫秒边界（所见即所筛）", () => {
  expect(dateFromToSinceMs("2026-09-01")).toBe(new Date("2026-09-01T00:00:00").getTime());
  expect(dateToToUntilMs("2026-09-15")).toBe(new Date("2026-09-15T23:59:59.999").getTime());
});

test("loadPage(): 组装分页 URL（limit=50/scope/tab/since）并写入 pageEntries/pageHasMore/pageCounts", async () => {
  const entries = [mkEntry("e1"), mkEntry("e2")];
  getMock.mockResolvedValue({
    type: "memory:list:page",
    entries,
    hasMore: true,
    counts: { active: 9, archived: 1 },
  });
  useMemoryStore.getState().loadPage({ ...baseParams, dateFrom: "2026-09-01" });
  await flush();

  const url = allUrls().find((u) => u.startsWith("/api/memories?"))!;
  const qs = queryOf(url);
  expect(qs.get("limit")).toBe("50");
  expect(qs.get("scope")).toBe("global");
  expect(qs.get("tab")).toBe("active");
  expect(qs.get("since")).toBe(String(dateFromToSinceMs("2026-09-01")));
  expect(qs.has("until")).toBe(false); // dateTo 为 null 不下推
  expect(qs.has("offset")).toBe(false); // 第一页不带 offset
  expect(qs.has("projectId")).toBe(false); // global 不带 projectId

  const s = useMemoryStore.getState();
  expect(s.pageEntries).toEqual(entries);
  expect(s.pageHasMore).toBe(true);
  expect(s.pageCounts).toEqual({ active: 9, archived: 1 });
  expect(s.pageLoading).toBe(false);
});

test("loadPage(): project 作用域带 projectId，kind/until 只在有值时出现", async () => {
  getMock.mockResolvedValue({
    type: "memory:list:page",
    entries: [],
    hasMore: false,
    counts: { active: 0, archived: 0 },
  });
  useMemoryStore.getState().loadPage({
    scope: "project",
    projectId: "proj-9",
    tab: "archived",
    kind: "execution",
    dateFrom: null,
    dateTo: "2026-09-15",
  });
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("projectId")).toBe("proj-9");
  expect(qs.get("tab")).toBe("archived");
  expect(qs.get("kind")).toBe("execution");
  expect(qs.get("until")).toBe(String(dateToToUntilMs("2026-09-15")));
  expect(qs.has("since")).toBe(false);
});

test("loadMore(): offset=已加载条数，追加条目并更新 pageHasMore", async () => {
  useMemoryStore.setState({
    lastPageParams: { ...baseParams },
    pageEntries: [mkEntry("e1"), mkEntry("e2")],
    pageHasMore: true,
  });
  getMock.mockResolvedValue({
    type: "memory:list:page",
    entries: [mkEntry("e3")],
    hasMore: false,
    counts: { active: 9, archived: 1 },
  });
  useMemoryStore.getState().loadMore();
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("offset")).toBe("2");
  expect(qs.get("limit")).toBe("50");

  const s = useMemoryStore.getState();
  expect(s.pageEntries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  expect(s.pageHasMore).toBe(false);
  expect(s.loadingMore).toBe(false);
});

test("loadMore(): 与已有条目 id 重叠时去重合并", async () => {
  useMemoryStore.setState({
    lastPageParams: { ...baseParams },
    pageEntries: [mkEntry("e1"), mkEntry("e2")],
    pageHasMore: true,
  });
  getMock.mockResolvedValue({
    type: "memory:list:page",
    entries: [mkEntry("e2"), mkEntry("e3")], // e2 重叠（广播重拉与 loadMore 竞态）
    hasMore: false,
    counts: { active: 0, archived: 0 },
  });
  useMemoryStore.getState().loadMore();
  await flush();

  expect(useMemoryStore.getState().pageEntries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
});

test("loadMore(): loadingMore 进行中 / pageHasMore=false / 缺 lastPageParams 时不发请求", async () => {
  useMemoryStore.setState({
    lastPageParams: { ...baseParams },
    pageEntries: [mkEntry("e1")],
    pageHasMore: true,
  });
  getMock.mockReturnValue(new Promise(() => {})); // 挂起，模拟慢响应
  useMemoryStore.getState().loadMore();
  useMemoryStore.getState().loadMore(); // 第二次应被 loadingMore 门挡住
  await flush();
  expect(getMock).toHaveBeenCalledTimes(1);

  // pageHasMore=false：没有更多页
  useMemoryStore.setState({ loadingMore: false, pageHasMore: false });
  useMemoryStore.getState().loadMore();
  await flush();
  expect(getMock).toHaveBeenCalledTimes(1);

  // 缺 lastPageParams（第一页都没拉过）
  useMemoryStore.setState({ lastPageParams: null, pageHasMore: true });
  useMemoryStore.getState().loadMore();
  await flush();
  expect(getMock).toHaveBeenCalledTimes(1);
});

test("setMemories(): 广播降级为变更信号，按 lastPageParams 重拉第一页（limit 恒 50、不带 offset）", async () => {
  // 模拟已加载两页（60 条）
  useMemoryStore.setState({
    lastPageParams: { ...baseParams, dateFrom: "2026-09-01" },
    pageEntries: Array.from({ length: 60 }, (_, i) => mkEntry(`e${i}`)),
    pageHasMore: true,
  });
  getMock.mockResolvedValue({
    type: "memory:list:page",
    entries: [mkEntry("fresh-1"), mkEntry("fresh-2")],
    hasMore: true,
    counts: { active: 60, archived: 2 },
  });
  useMemoryStore.getState().setMemories({
    type: "memory:changed",
    memories: [],
    archived: [],
  } as any);
  await flush();

  // 重拉第一页：筛选参数保留，limit 恒 50，不带 offset
  const url = allUrls().find((u) => u.startsWith("/api/memories?"))!;
  const qs = queryOf(url);
  expect(qs.get("limit")).toBe("50");
  expect(qs.has("offset")).toBe(false);
  expect(qs.get("scope")).toBe("global");
  expect(qs.get("tab")).toBe("active");
  expect(qs.get("since")).toBe(String(dateFromToSinceMs("2026-09-01")));

  // 重拉结果覆盖 pageEntries（写操作后该条 updated_at 变化，重置到第一页符合「最近修改排最前」）
  const s = useMemoryStore.getState();
  expect(s.pageEntries.map((e) => e.id)).toEqual(["fresh-1", "fresh-2"]);
  expect(s.pageLoading).toBe(false);
});

test("setMemories(): 无 lastPageParams 且非检索态时不发请求", async () => {
  useMemoryStore.getState().setMemories({ memories: [], archived: [] } as any);
  await flush();
  expect(getMock).not.toHaveBeenCalled();
});

test("setMemories(): 检索态下用相同参数重跑检索（结果不陈旧）", async () => {
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [{ id: "hit-1" }],
    totalMatched: 1,
  });
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "global",
    projectId: null,
    kind: "knowledge",
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  });
  await flush();
  const firstUrl = lastUrl();
  expect(getMock).toHaveBeenCalledTimes(1);

  // 归档 / 恢复 / 彻底删除后后端回推列表 → 检索结果需同步刷新
  useMemoryStore.getState().setMemories({ memories: [], archived: [] } as any);
  await flush();

  expect(getMock).toHaveBeenCalledTimes(2);
  expect(lastUrl()).toBe(firstUrl);
});

test("setDateRange(): 写入与清空 dateFrom/dateTo", () => {
  useMemoryStore.getState().setDateRange("2026-09-01", "2026-09-15");
  expect(useMemoryStore.getState().dateFrom).toBe("2026-09-01");
  expect(useMemoryStore.getState().dateTo).toBe("2026-09-15");

  useMemoryStore.getState().setDateRange(null, null);
  expect(useMemoryStore.getState().dateFrom).toBeNull();
  expect(useMemoryStore.getState().dateTo).toBeNull();
});

// ---------- 竞态防护（任务 6 审查传导：请求序号防乱序/过期响应覆盖） ----------

test("loadPage(): 慢的旧响应不覆盖新响应（序号防乱序）", async () => {
  // 第一次 loadPage 挂起 → 第二次 loadPage（新参数）先回 → 旧响应后到必须被丢弃
  let resolveFirst: (v: unknown) => void = () => {};
  getMock.mockImplementationOnce(
    () => new Promise((res) => { resolveFirst = res; }),
  );
  getMock.mockImplementationOnce(async () => ({
    type: "memory:list:page",
    entries: [mkEntry("new-1")],
    hasMore: false,
    counts: { active: 1, archived: 0 },
  }));
  useMemoryStore.getState().loadPage({ ...baseParams });
  useMemoryStore.getState().loadPage({ ...baseParams, kind: "execution" });
  await flush();

  // 新响应已落地
  expect(useMemoryStore.getState().pageEntries.map((e) => e.id)).toEqual(["new-1"]);

  // 旧响应迟到：序号已过期，不得覆盖
  resolveFirst({
    type: "memory:list:page",
    entries: [mkEntry("stale-1"), mkEntry("stale-2")],
    hasMore: true,
    counts: { active: 99, archived: 9 },
  });
  await flush();

  const s = useMemoryStore.getState();
  expect(s.pageEntries.map((e) => e.id)).toEqual(["new-1"]);
  expect(s.pageCounts).toEqual({ active: 1, archived: 0 });
});

test("loadMore(): 迟到的翻页响应不覆盖新一轮 loadPage 结果", async () => {
  useMemoryStore.setState({
    lastPageParams: { ...baseParams },
    pageEntries: [mkEntry("e1")],
    pageHasMore: true,
  });
  let resolveMore: (v: unknown) => void = () => {};
  getMock.mockImplementationOnce(
    () => new Promise((res) => { resolveMore = res; }),
  );
  useMemoryStore.getState().loadMore();
  expect(useMemoryStore.getState().loadingMore).toBe(true);

  // 筛选变化 → loadPage 新一轮（立即返回，序号递增使在途翻页作废）
  getMock.mockImplementationOnce(async () => ({
    type: "memory:list:page",
    entries: [mkEntry("fresh")],
    hasMore: true,
    counts: { active: 1, archived: 0 },
  }));
  useMemoryStore.getState().loadPage({ ...baseParams, kind: "profile" });
  await flush();
  expect(useMemoryStore.getState().pageEntries.map((e) => e.id)).toEqual(["fresh"]);

  // 旧翻页响应迟到：不得用发起时的旧快照合并/追加
  resolveMore({
    type: "memory:list:page",
    entries: [mkEntry("stale")],
    hasMore: false,
    counts: { active: 2, archived: 0 },
  });
  await flush();

  const s = useMemoryStore.getState();
  expect(s.pageEntries.map((e) => e.id)).toEqual(["fresh"]);
  expect(s.pageHasMore).toBe(true);
  expect(s.loadingMore).toBe(false);
});

test("loadMore(): 第一页在途（pageLoading）时不发请求", async () => {
  useMemoryStore.setState({ lastPageParams: { ...baseParams }, pageHasMore: true });
  getMock.mockImplementation(() => new Promise(() => {})); // 全部挂起
  useMemoryStore.getState().loadPage({ ...baseParams });
  useMemoryStore.getState().loadMore(); // pageLoading=true → 守卫挡住
  await flush();
  expect(getMock).toHaveBeenCalledTimes(1);
});

test("search(): 慢的旧检索响应不覆盖新检索（序号防乱序）", async () => {
  const base = {
    scope: "global" as const,
    projectId: null,
    kind: null,
    archivedOnly: false,
    dateFrom: null,
    dateTo: null,
  };
  let resolveFirst: (v: unknown) => void = () => {};
  getMock.mockImplementationOnce(
    () => new Promise((res) => { resolveFirst = res; }),
  );
  getMock.mockImplementationOnce(async () => ({
    type: "memory:search",
    results: [mkHit("new-hit")],
    totalMatched: 1,
    hasMore: false,
  }));
  useMemoryStore.getState().search({ ...base, query: "第一轮" });
  useMemoryStore.getState().search({ ...base, query: "第二轮" });
  await flush();

  expect(useMemoryStore.getState().searchResults?.map((r) => r.id)).toEqual(["new-hit"]);

  resolveFirst({
    type: "memory:search",
    results: [mkHit("stale-hit")],
    totalMatched: 99,
    hasMore: true,
  });
  await flush();

  const s = useMemoryStore.getState();
  expect(s.searchResults?.map((r) => r.id)).toEqual(["new-hit"]);
  expect(s.searchTotalMatched).toBe(1);
});
