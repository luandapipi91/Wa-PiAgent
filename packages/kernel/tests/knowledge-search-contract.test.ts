// knowledge_search 工具契约测试（任务 9：参数面对齐 pi-knowledge 0.13.0）：
// - 参数面：mode 12 取值 / profile 8 取值 / limit 1-50 / offset 0-799 / 过滤与诊断参数
// - 透传：bridge handleTool 解析出检索入参 → knowledgeCtx.search 原样收到
// - 生效：makeKnowledgeToolContext 把入参送进 searchKnowledge（mode/profile/limit 可观测）
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SEARCH_PARAMS_SCHEMA, type KbSearchResult } from "@wa-pi/shared";
import { makeDefaultBridgeContext } from "../src/bridge-registry";
import type { MemoryToolContext } from "../src/memory/tools";
import { makeKnowledgeToolContext } from "../src/knowledge/tool";
import type { KnowledgeStore } from "../src/knowledge/store";

/** TypeBox 生成的 JSON Schema 属性形状（只取本测试关心的字段，避免 any 扩散） */
type PropSchema = {
  anyOf?: Array<{ const?: string }>;
  minimum?: number;
  maximum?: number;
  type?: string;
};

const props = KB_SEARCH_PARAMS_SCHEMA.properties as Record<string, PropSchema>;

const enumValues = (prop: PropSchema): string[] =>
  (prop.anyOf ?? []).flatMap((s) => (s.const === undefined ? [] : [s.const]));

const MODES = [
  "auto",
  "fast",
  "semantic",
  "hybrid",
  "semantic_hybrid",
  "deep",
  "adaptive",
  "code",
  "config",
  "docs",
  "errors",
  "decision",
];

const PROFILES = [
  "auto",
  "balanced",
  "low_token",
  "precision",
  "recall",
  "long_context",
  "code",
  "docs",
];

describe("knowledge_search 参数面", () => {
  test("mode 覆盖上游 12 个取值", () => {
    expect(enumValues(props.mode).sort()).toEqual([...MODES].sort());
  });

  test("profile 覆盖上游 8 个取值", () => {
    expect(enumValues(props.profile).sort()).toEqual([...PROFILES].sort());
  });

  test("分页：limit 1-50、offset 0-799", () => {
    expect(props.limit.minimum).toBe(1);
    expect(props.limit.maximum).toBe(50);
    expect(props.offset.minimum).toBe(0);
    expect(props.offset.maximum).toBe(799);
  });

  test("过滤与诊断参数齐备：kb_id/file_type/path_pattern/diversity/diagnostics", () => {
    expect(props.kb_id.type).toBe("string");
    expect(props.file_type.type).toBe("string");
    expect(props.path_pattern.type).toBe("string");
    expect(enumValues(props.diversity)).toEqual(["off", "balanced", "strong"]);
    expect(props.diagnostics.type).toBe("boolean");
  });
});

// 最小 memoryCtx：createMemoryTools 构造期只建闭包不触碰 dao，本组测试只走 knowledge_search 分支
const fakeMemoryCtx = { dao: null, projectId: null } as unknown as MemoryToolContext;
const signal = new AbortController().signal;
// 检索闭包桩：本组测试只看入参，回包字段无关
const emptyResult = {
  found: false,
  results: [],
  skippedKbs: [],
  modeUsed: "hybrid",
  rerankUsed: false,
  totalCount: 0,
  hasMore: false,
} as unknown as KbSearchResult;

/** 注入 fake knowledgeCtx，记录每次检索拿到的入参 */
function captureBridgeCtx() {
  const calls: Array<{
    query: string;
    opts?: Record<string, unknown>;
  }> = [];
  const ctx = makeDefaultBridgeContext({
    sessionId: "s",
    cwd: "/x",
    memoryCtx: fakeMemoryCtx,
    knowledgeCtx: {
      search: async (query, opts) => {
        calls.push({ query, opts: opts as Record<string, unknown> | undefined });
        return emptyResult;
      },
    },
  });
  return { ctx, calls };
}

describe("bridge 参数透传", () => {
  test("mode/profile/分页/过滤/诊断参数原样到达检索", async () => {
    const { ctx, calls } = captureBridgeCtx();
    await ctx.handleTool(
      "knowledge_search",
      "t1",
      {
        query: "定价",
        // errors/precision 是桥以前折叠掉的那类取值：必须原样透传
        mode: "errors",
        profile: "precision",
        limit: 30,
        offset: 100,
        kb_id: "kb-2",
        file_type: "markdown",
        path_pattern: "src/engine.ts",
        diversity: "strong",
        diagnostics: true,
      },
      signal,
    );
    expect(calls[0]).toEqual({
      query: "定价",
      opts: {
        mode: "errors",
        profile: "precision",
        limit: 30,
        offset: 100,
        kbId: "kb-2",
        fileType: "markdown",
        pathPattern: "src/engine.ts",
        diversity: "strong",
        diagnostics: true,
      },
    });
  });

  test("不替调用方补 limit：缺省交给 profile/env 的默认值", async () => {
    const { ctx, calls } = captureBridgeCtx();
    await ctx.handleTool("knowledge_search", "t1", { query: "定价" }, signal);
    expect(calls[0]).toEqual({ query: "定价", opts: {} });
  });

  test("未知 mode/profile 被忽略，回落到默认策略", async () => {
    const { ctx, calls } = captureBridgeCtx();
    await ctx.handleTool(
      "knowledge_search",
      "t1",
      { query: "定价", mode: "nope", profile: "nope" },
      signal,
    );
    expect(calls[0]).toEqual({ query: "定价", opts: {} });
  });
});

describe("makeKnowledgeToolContext 透传到 searchKnowledge", () => {
  test("mode/profile/limit 在检索结果里生效（fake store，不碰磁盘与嵌入）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kb-contract-"));
    try {
      // 注入实例只需满足检索路径的登记库读接口：getKb 返回 null → 该库跳过，不触碰磁盘
      const sharedStore = {
        getKb: () => null,
      } as unknown as KnowledgeStore;
      const ctx = makeKnowledgeToolContext({
        waPiDir: tmp,
        kbIds: ["kb_1"],
        store: sharedStore,
      });
      const res = await ctx.search("定价", {
        mode: "errors",
        profile: "precision",
        limit: 30,
      });
      // modeUsed 回显入参 mode（code/errors 等别名不归一），未透传时会是 hybrid
      expect(res.modeUsed).toBe("errors");
      expect(res.tuning.requested_profile).toBe("precision");
      expect(res.tuning.selected_profile).toBe("precision");
      expect(res.tuning.limit).toBe(30);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
