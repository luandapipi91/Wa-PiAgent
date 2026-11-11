import { describe, test, expect } from "bun:test";
import {
  adaptiveRelationBoost,
  buildAdaptiveContext,
  parseAdaptiveMetadata,
  pushAdaptiveCandidate,
} from "../src/knowledge/search/adaptive";
import { buildQuerySnippet } from "../src/knowledge/search/snippet";
import { tokenizeForSearch } from "../src/knowledge/search/query";
import type { RankChunk } from "../src/knowledge/search/contracts";
import type { RankedCandidate } from "../src/knowledge/search/diversity";

const c = (id: string, start: number, end: number, content = `块${id}`): RankChunk => ({
  id,
  kbId: "kb1",
  filePath: "a.md",
  fileType: "markdown",
  content,
  contentHash: id,
  startLine: start,
  endLine: end,
  indexedAt: 1,
});

const cand = (
  chunk: RankChunk,
  score: number,
  sourceChunkIds: string[],
  content = chunk.content,
): RankedCandidate => ({
  chunk,
  kbName: "库",
  ranking: {} as never,
  score,
  content,
  snippet: content,
  startLine: chunk.startLine ?? 0,
  endLine: chunk.endLine ?? 0,
  sourceChunkIds,
});

describe("buildAdaptiveContext", () => {
  test("seed 必在、按行排序、字符预算内、行号取首尾", () => {
    const seed = c("s", 100, 110, "命中块");
    const chunks = [c("n1", 1, 10, "前文"), c("n2", 120, 130, "后文"), c("far", 400, 410, "远处")];
    const ctx = buildAdaptiveContext(seed, [seed, ...chunks], tokenizeForSearch("命中块"), {
      maxContextChars: 6000,
      neighborTarget: 5,
    });
    expect(ctx.content).toContain("命中块");
    expect(ctx.content).toContain("后文");
    // 拼接顺序按 startLine 升序（读起来是原文顺序）
    expect(ctx.content.indexOf("前文")).toBeLessThan(ctx.content.indexOf("命中块"));
    expect(ctx.startLine).toBe(1);
    expect(ctx.endLine).toBe(410);
    expect(ctx.sourceChunkIds).toContain("s");
    expect(ctx.content.length).toBeLessThanOrEqual(6000);
  });

  test("seed 不在入参 chunks 里时上游兜底不生效（ordered 只过滤 chunks）", () => {
    // 上游 `scored.push(seed)` 只补进打分数组，ordered 仍从入参 chunks 过滤——锁住这个上游行为
    const seed = c("s", 1, 10);
    const ctx = buildAdaptiveContext(seed, [c("n", 11, 20)], tokenizeForSearch("块s"), {
      maxContextChars: 6000,
      neighborTarget: 5,
    });
    expect(ctx.sourceChunkIds).toEqual(["n"]);
  });

  test("预算不足时截断，不超 maxContextChars", () => {
    const seed = c("s", 1, 10, "x".repeat(50));
    const ctx = buildAdaptiveContext(seed, [seed, c("n", 11, 20, "y".repeat(100))], tokenizeForSearch("x"), {
      maxContextChars: 60,
      neighborTarget: 5,
    });
    // seed 50 + 分隔符 2 + 邻居切片 8 = 60
    expect(ctx.content.length).toBe(60);
  });

  test("neighborTarget 限制选中块数（seed 之外按分数取）", () => {
    const seed = c("s", 100, 110);
    const near = c("near", 120, 130);
    const far = c("far", 900, 910);
    const ctx = buildAdaptiveContext(seed, [seed, near, far], tokenizeForSearch("块s"), {
      maxContextChars: 6000,
      neighborTarget: 2,
    });
    expect(ctx.sourceChunkIds).toContain("s");
    expect(ctx.sourceChunkIds).toContain("near");
    expect(ctx.sourceChunkIds).not.toContain("far");
  });
});

describe("parseAdaptiveMetadata 容错", () => {
  test("非 JSON / JSON 数组都退化为空结构", () => {
    expect(parseAdaptiveMetadata({ ...c("m", 1, 5), metadataJson: "not json" })).toEqual({ scope: [] });
    expect(parseAdaptiveMetadata({ ...c("m", 1, 5), metadataJson: "[1,2]" })).toEqual({ scope: [] });
  });
});

describe("buildAdaptiveContext 分隔符", () => {
  test("块内含 \\n\\n 时按原样保留，块间仍以空行分隔", () => {
    const seed = c("s", 1, 10, "第一段\n\n第二段");
    const ctx = buildAdaptiveContext(seed, [seed], tokenizeForSearch("第一段"), {
      maxContextChars: 6000,
      neighborTarget: 1,
    });
    expect(ctx.content).toBe("第一段\n\n第二段");
    expect(ctx.content).toContain("\n\n第二段");
  });
});

describe("adaptiveRelationBoost", () => {
  // 上游用法：两侧都是 parseAdaptiveMetadata 的产物
  const meta = (raw: Record<string, unknown>) =>
    parseAdaptiveMetadata({ ...c("m", 1, 5), metadataJson: JSON.stringify(raw) });

  test("同父作用域 / 同父符号 / 作用域前缀 / 无结构", () => {
    // 同一父作用域、不同符号 → 1.35；同符号 → 0.35
    expect(adaptiveRelationBoost(meta({ symbol: "f", scope: ["A", "B"] }), meta({ symbol: "g", scope: ["A", "B"] }))).toBe(1.35);
    expect(adaptiveRelationBoost(meta({ symbol: "f", scope: ["A", "B"] }), meta({ symbol: "f", scope: ["A", "B"] }))).toBe(0.35);
    // 父符号相同（作用域为空，sameScope 不成立）→ 1.2；JSON 键沿用上游 snake_case
    expect(adaptiveRelationBoost(meta({ symbol: "f", parent_symbol: "P" }), meta({ symbol: "g", parent_symbol: "P" }))).toBe(1.2);
    // 作用域互为前缀 → 0.9
    expect(adaptiveRelationBoost(meta({ symbol: "f", scope: ["A"] }), meta({ symbol: "g", scope: ["A", "B"] }))).toBe(0.9);
    // 任一侧无 adaptive 结构 → 0
    expect(adaptiveRelationBoost(meta({ symbol: "f", scope: ["A"] }), meta({}))).toBe(0);
  });
});

describe("pushAdaptiveCandidate", () => {
  test("sourceChunkIds 不重叠 → 各自保留", () => {
    const list: RankedCandidate[] = [];
    pushAdaptiveCandidate(list, cand(c("a", 1, 10), 0.5, ["a"]));
    pushAdaptiveCandidate(list, cand(c("b", 5, 15), 0.6, ["b"]));
    expect(list.length).toBe(2);
  });

  test("同库同文件且 sourceChunkIds 重叠的候选合并，保留分高的", () => {
    const list: RankedCandidate[] = [];
    pushAdaptiveCandidate(list, cand(c("a", 1, 10), 0.5, ["a"]));
    pushAdaptiveCandidate(list, cand(c("b", 5, 15), 0.6, ["a"]));
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("块b");
  });

  test("重叠时 sourceChunkIds 更长者胜出（即使分更低）", () => {
    const list: RankedCandidate[] = [];
    pushAdaptiveCandidate(list, cand(c("a", 1, 10), 0.9, ["a"]));
    pushAdaptiveCandidate(list, cand(c("b", 5, 15), 0.2, ["a", "c"]));
    expect(list.length).toBe(1);
    expect(list[0].sourceChunkIds).toEqual(["a", "c"]);
  });

  test("不同文件即使 sourceChunkIds 重叠也不合并", () => {
    const list: RankedCandidate[] = [];
    pushAdaptiveCandidate(list, cand(c("a", 1, 10), 0.5, ["a"]));
    pushAdaptiveCandidate(list, cand({ ...c("b", 1, 10), filePath: "b.md" }, 0.6, ["a"]));
    expect(list.length).toBe(2);
  });
});

describe("buildQuerySnippet", () => {
  test("按查询词截取片段并加省略号", () => {
    const long = "前言".repeat(200) + "定价政策说明" + "后记".repeat(200);
    const s = buildQuerySnippet(long, "定价政策", 120);
    // 命中点居中：60 字前文 + 命中 + 后文，两侧各 3 字符省略号
    expect(s.length).toBeLessThanOrEqual(130);
    expect(s).toContain("定价政策");
    expect(s.startsWith("...")).toBe(true);
    expect(s.endsWith("...")).toBe(true);
  });

  test("查询词未命中 → 直接截取开头、不加省略号", () => {
    const content = "a".repeat(300);
    expect(buildQuerySnippet(content, "zzz", 100)).toBe("a".repeat(100));
  });
});
