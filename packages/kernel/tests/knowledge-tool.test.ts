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
import type { KbSearchResult } from "../src/knowledge/search";
import { makeKnowledgeToolContext } from "../src/knowledge/tool";
import { knowledgeDbPath } from "../src/knowledge/paths";
import type { KnowledgeStore } from "../src/knowledge/store";
import { resetEmbedderForTest } from "../src/memory/embedder";

// 最小 memoryCtx：createMemoryTools 构造期只建闭包不触碰 dao，本测试只走 knowledge_search 分支
const fakeMemoryCtx = { dao: null, projectId: null } as unknown as MemoryToolContext;

const signal = new AbortController().signal;

const fakeKbResult: KbSearchResult = {
  found: true,
  results: [
    {
      kbId: "kb-1",
      kbName: "产品资料",
      content: "定价策略：订阅制，按席位收费。",
      filePath: "docs/pricing.md",
      title: "定价",
      breadcrumb: "商业/定价",
      startLine: 12,
      endLine: 18,
      score: 0.0164,
    },
  ],
  skippedKbs: [],
};

describe("knowledge_search bridge 分发", () => {  test("handleTool 分发 knowledge_search 并返回结构化结果", async () => {
    let called: { query: string; limit: number } | null = null;
    const knowledgeCtx = {
      search: async (query: string, limit: number) => {
        called = { query, limit };
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
    // 闭包透传：query 原样、limit 缺省 5
    expect(called!).toEqual({ query: "定价", limit: 5 });
  });

  test("handleTool 透传 limit 并钳制到上限 20", async () => {
    let called: { query: string; limit: number } | null = null;
    const knowledgeCtx = {
      search: async (query: string, limit: number) => {
        called = { query, limit };
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
    expect(called!).toEqual({ query: "定价", limit: 20 });
  });

  test("陈旧命中在输出里带 stale:true，新鲜命中不带该键（不给正常结果加噪声）", async () => {
    const result: KbSearchResult = {
      found: true,
      results: [
        {
          kbId: "kb-1",
          kbName: "产品资料",
          content: "新鲜块。",
          filePath: "docs/fresh.md",
          title: "新鲜",
          breadcrumb: null,
          startLine: 1,
          endLine: 2,
          score: 0.02,
        },
        {
          kbId: "kb-1",
          kbName: "产品资料",
          content: "源文件已改的旧块。",
          filePath: "docs/stale.md",
          title: "陈旧",
          breadcrumb: null,
          startLine: 3,
          endLine: 4,
          score: 0.01,
          stale: true,
        },
      ],
      skippedKbs: [],
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
      const res = await ctx.search("定价", 5);
      // 注入的实例被真正使用（而非被忽略后自建）
      expect(getKbCalls).toBe(1);
      expect(res).toEqual({
        found: false,
        results: [],
        skippedKbs: [{ kbId: "kb_1", reason: "missing" }],
      });
      // 自建连接会当场创建 knowledge.db：文件不存在即证明未新开连接
      expect(existsSync(knowledgeDbPath(tmp))).toBe(false);
    } finally {
      resetEmbedderForTest();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
