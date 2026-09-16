// memory store 检索（服务端 FTS/BM25）单元测试：
// 关键词 / 作用域 / 层 / 归档筛选一并下推到 GET /api/memories/search，
// 前端只消费 { type:"memory:search", results, totalMatched }。
import { test, expect, beforeEach, mock } from "bun:test";
import { useMemoryStore } from "../src/store/memory";
import type { MemorySearchResult } from "@wa-pi/shared";

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
const queryOf = (url: string) => new URLSearchParams(url.split("?")[1] ?? "");

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [],
    totalMatched: 0,
  });
  useMemoryStore.setState({
    memories: [],
    archived: [],
    instructions: [],
    config: null,
    searchResults: null,
    searchTotalMatched: 0,
    searching: false,
    searchParams: null,
  });
});

test("search(): 组装 q/scope/kind/limit 查询串", async () => {
  useMemoryStore.getState().search({
    query: "记忆 检索&x",
    scope: "global",
    projectId: null,
    kind: "execution",
    archivedOnly: false,
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
});

test("search(): archivedOnly 为真时附 archivedOnly=true，kind 为 null 时不附", async () => {
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: true,
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
  });
  await flush();

  const qs = queryOf(lastUrl());
  expect(qs.get("scope")).toBe("project");
  expect(qs.get("projectId")).toBe("proj-9");
});

test("search(): scope=project 但 projectId 为空时不发请求，searchResults 置 []", async () => {
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "project",
    projectId: null,
    kind: null,
    archivedOnly: false,
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
  });
  await flush();

  expect(getMock).not.toHaveBeenCalled();
  const s = useMemoryStore.getState();
  expect(s.searchResults).toBeNull();
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searching).toBe(false);
  expect(s.searchParams).toBeNull();
});

test("search(): 成功响应写入 results/totalMatched 并结束 searching", async () => {
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
  getMock.mockResolvedValue({ type: "memory:search", results, totalMatched: 7 });

  const params = {
    query: "pnpm",
    scope: "global" as const,
    projectId: null,
    kind: null,
    archivedOnly: false,
  };
  useMemoryStore.getState().search(params);
  expect(useMemoryStore.getState().searching).toBe(true);
  expect(useMemoryStore.getState().searchParams).toEqual(params);
  await flush();

  const s = useMemoryStore.getState();
  expect(s.searchResults).toEqual(results);
  expect(s.searchTotalMatched).toBe(7);
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
    }),
  ).not.toThrow();
  await flush();

  const s = useMemoryStore.getState();
  expect(s.searching).toBe(false);
  expect(s.searchResults).toEqual([]);
  expect(s.searchTotalMatched).toBe(0);
});

test("clearSearch(): 复位四个检索字段", async () => {
  getMock.mockResolvedValue({
    type: "memory:search",
    results: [{ id: "hit-1" }],
    totalMatched: 1,
  });
  useMemoryStore.getState().search({
    query: "pnpm",
    scope: "global",
    projectId: null,
    kind: null,
    archivedOnly: false,
  });
  await flush();
  expect(useMemoryStore.getState().searchResults).not.toBeNull();

  useMemoryStore.getState().clearSearch();
  const s = useMemoryStore.getState();
  expect(s.searchResults).toBeNull();
  expect(s.searchTotalMatched).toBe(0);
  expect(s.searching).toBe(false);
  expect(s.searchParams).toBeNull();
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

test("setMemories(): 非检索态不触发检索", async () => {
  useMemoryStore.getState().setMemories({ memories: [], archived: [] } as any);
  await flush();
  expect(getMock).not.toHaveBeenCalled();
});
