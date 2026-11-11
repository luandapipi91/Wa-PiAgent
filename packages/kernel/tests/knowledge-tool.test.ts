// knowledge_search 的 bridge 分发测试（任务 8）：
// - fake knowledgeCtx 注入（不经真实 db / 嵌入模型，同任务 7 的注入先例，不用 mock.module）
// - 三个简报断言：分发返回结构（含 file_path）/ 未绑定提示（含「未绑定」）/ 空参数错误
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDefaultBridgeContext } from "../src/bridge-registry";
import { KB_SEARCH_DESCRIPTION } from "@wa-pi/shared";
import type { MemoryToolContext } from "../src/memory/tools";
import type { KbSearchResult } from "@wa-pi/shared";
import { makeKnowledgeToolContext } from "../src/knowledge/tool";
import { knowledgeDbPath } from "../src/knowledge/paths";
import type { KnowledgeStore } from "../src/knowledge/store";
import { resetEmbedderForTest } from "../src/memory/embedder";

// 最小 memoryCtx：createMemoryTools 构造期只建闭包不触碰 dao，本测试只走 knowledge_search 分支
const fakeMemoryCtx = { dao: null, projectId: null } as unknown as MemoryToolContext;

const signal = new AbortController().signal;

const fakeRanking = {
  adjusted_score: 0.5,
  base_score: 0.5,
  coverage: 1,
  documentation_boost: 0,
  is_localization: false,
  is_test: false,
  localization_penalty: 1,
  path_boost: 0,
  source_boost: 0,
  test_intent: false,
  user_guide_intent: false,
};

const fakeKbResult: KbSearchResult = {
  found: true,
  results: [
    {
      kbId: "kb-1",
      kbName: "产品资料",
      content: "定价策略：订阅制，按席位收费。",
      filePath: "docs/pricing.md",
      fileType: "markdown",
      title: "定价",
      breadcrumb: "商业/定价",
      startLine: 12,
      endLine: 18,
      score: 0.0164,
      snippet: "定价策略：订阅制",
      ranking: fakeRanking,
      provenance: {
        chunk_id: "c-1",
        chunk_hash: "h-1",
        indexed_at: 1,
        stale: false,
        match_reason: "hybrid",
        source_chunk_ids: ["c-1"],
      },
    },
  ],
  skippedKbs: [],
  modeUsed: "hybrid",
  rerankUsed: false,
  totalCount: 1,
  hasMore: false,
  tuning: {
    requested_profile: "auto",
    selected_profile: "balanced",
    limit: 5,
    snippet_max_length: 240,
    min_hybrid_score: 0.18,
    candidate_limit: 50,
    retrieval_limit_per_kb: 50,
    retrieved_candidates: 1,
    filtered_candidates: 1,
    diversity_candidates: 1,
    candidate_pool_truncated: false,
    candidate_min: 50,
    candidate_multiplier: 12,
    adaptive_context_lines: 80,
    adaptive_max_context_chars: 6000,
    adaptive_neighbor_target: 5,
    deep_rerank_candidates: 30,
    deep_rerank_top_k_multiplier: 3,
  },
};

describe("knowledge_search bridge 分发", () => {  test("handleTool 分发 knowledge_search 并返回结构化结果", async () => {
    let called: { query: string; opts?: unknown } | null = null;
    const knowledgeCtx = {
      search: async (query: string, opts?: unknown) => {
        called = { query, opts };
        return fakeKbResult;
      },
    };
    const ctx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx,
    });
    const r = await ctx.handleTool("knowledge_search", "t1", { query: "定价" }, signal);
    // 输出为 snake_case 字段（对齐 KB_SEARCH_DESCRIPTION 的 file_path/kb_name 文案）
    expect(r.content[0].text).toContain("file_path");
    expect(r.content[0].text).toContain("docs/pricing.md");
    // 闭包透传：query 原样；limit 缺省不补数字（默认预算交给 search profile/env）
    expect(called!).toEqual({ query: "定价", opts: {} });
  });

  test("handleTool 透传 limit 并钳制到上限 50", async () => {
    let called: { query: string; opts?: unknown } | null = null;
    const knowledgeCtx = {
      search: async (query: string, opts?: unknown) => {
        called = { query, opts };
        return fakeKbResult;
      },
    };
    const ctx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx,
    });
    await ctx.handleTool(
      "knowledge_search",
      "t1",
      { query: "定价", limit: 99 },
      signal,
    );
    // 上限对齐 schema 的 KB_SEARCH_LIMIT_MAX（= searchKnowledge 的 MAX_SEARCH_RESULTS）
    expect(called!).toEqual({ query: "定价", opts: { limit: 50 } });
  });

  test("陈旧命中在输出里带 stale:true，新鲜命中不带该键（不给正常结果加噪声）", async () => {
    const result: KbSearchResult = {
      ...fakeKbResult,
      results: [
        {
          ...fakeKbResult.results[0],
          content: "新鲜块。",
          filePath: "docs/fresh.md",
          title: "新鲜",
          startLine: 1,
          endLine: 2,
        },
        {
          ...fakeKbResult.results[0],
          content: "源文件已改的旧块。",
          filePath: "docs/stale.md",
          title: "陈旧",
          startLine: 3,
          endLine: 4,
          stale: true,
          provenance: { ...fakeKbResult.results[0].provenance, stale: true },
        },
      ],
      totalCount: 2,
    };
    const ctx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx: { search: async () => result },
    });
    const r = await ctx.handleTool("knowledge_search", "t1", { query: "定价" }, signal);
    const parsed = JSON.parse(r.content[0].text as string) as { results: Array<Record<string, unknown>> };
    expect(parsed.results[0].stale).toBeUndefined();
    expect("stale" in parsed.results[0]).toBe(false);
    expect(parsed.results[1].stale).toBe(true);
    // 无 warnings 时也不加 warnings 键（不给正常结果加噪声）
    expect("warnings" in parsed).toBe(false);
  });

  test("warnings 透出：有命中进 JSON、空结果进文案尾部（模型能读到降级原因）", async () => {
    const warning = "「过期库」向量通道已禁用（embedding 指纹不匹配），仅返回词法结果";
    const hitCtx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx: { search: async () => ({ ...fakeKbResult, warnings: [warning] }) },
    });
    const hit = await hitCtx.handleTool("knowledge_search", "t1", { query: "定价" }, signal);
    expect((JSON.parse(hit.content[0].text as string) as { warnings?: string[] }).warnings).toEqual([warning]);

    const missCtx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx: {
        search: async () => ({
          ...fakeKbResult,
          found: false,
          results: [],
          totalCount: 0,
          hasMore: false,
          warnings: [warning],
        }),
      },
    });
    const miss = await missCtx.handleTool("knowledge_search", "t1", { query: "定价" }, signal);
    expect(miss.content[0].text).toContain("提示：");
    expect(miss.content[0].text).toContain(warning);
  });

  test("工具描述告知 stale 的含义（旧索引/源文件已改）", () => {
    expect(KB_SEARCH_DESCRIPTION).toContain("stale");
  });

  test("未绑定任何库时返回友好提示文本", async () => {
    const ctxNoBinding = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
    });
    const r = await ctxNoBinding.handleTool(
      "knowledge_search",
      "t1",
      { query: "x" },
      signal,
    );
    expect(r.content[0].text).toContain("未绑定");
  });

  test("查询为空参数返回错误内容", async () => {
    let searchCalls = 0;
    const knowledgeCtx = {
      search: async () => {
        searchCalls++;
        return fakeKbResult;
      },
    };
    const ctx = makeDefaultBridgeContext({
      sessionId: "s",
      cwd: "/x",
      memoryCtx: fakeMemoryCtx,
      knowledgeCtx,
    });
    const r = await ctx.handleTool("knowledge_search", "t1", { query: "" }, signal);
    expect((r.details as { error?: string }).error).toBeTruthy();
    // 空参数直接拒绝，不应触达检索闭包
    expect(searchCalls).toBe(0);
  });
});

describe("makeKnowledgeToolContext 连接复用", () => {
  test("注入共享 store 时检索走注入实例，不自建 knowledge.db", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kb-tool-ctx-"));
    // 模型不可用 → 语义通道跳过，测试不触碰真实嵌入（同 search 测试的 failNextLoad 先例）
    resetEmbedderForTest({ failNextLoad: true });
    try {
      let getKbCalls = 0;
      // 注入实例只需满足检索路径的登记库读接口：getKb 返回 null → 该库跳过，不触碰磁盘
      const sharedStore = {
        getKb: (id: string) => {
          getKbCalls++;
          return null;
        },
      } as unknown as KnowledgeStore;
      const ctx = makeKnowledgeToolContext({
        waPiDir: tmp,
        kbIds: ["kb_1"],
        store: sharedStore,
      });
      const res = await ctx.search("定价", { limit: 5 });
      // 注入的实例被真正使用（而非被忽略后自建）
      expect(getKbCalls).toBe(1);
      expect(res).toMatchObject({
        found: false,
        results: [],
        skippedKbs: [{ kbId: "kb_1", reason: "missing" }],
        modeUsed: "hybrid",
        rerankUsed: false,
        totalCount: 0,
        hasMore: false,
      });
      // 自建连接会当场创建 knowledge.db：文件不存在即证明未新开连接
      expect(existsSync(knowledgeDbPath(tmp))).toBe(false);
    } finally {
      resetEmbedderForTest();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
