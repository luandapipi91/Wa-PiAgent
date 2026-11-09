// knowledge-prompt 测试（任务 9）：
// buildKnowledgeBasesPrompt 的 XML 格式对齐规格 §6.6（仿 <available_skills> 清单式）；
// knowledge-bases 段为纯运行时注入段（不落盘，savePromptSegments 剔除 + ensure 补回）。
import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  buildKnowledgeBasesPrompt,
} from "../src/knowledge/prompt";
import {
  composePrompt,
  savePromptSegments,
  loadPromptSegments,
  DEFAULT_PROMPT_SEGMENTS,
  KNOWLEDGE_BASES_SEGMENT_ID,
  WA_PI_DEFAULT_BASE_PROMPT,
  type PromptSegment,
} from "../src/system-prompt";
import type { KbInfo } from "@wa-pi/shared";

function kb(partial: Partial<KbInfo>): KbInfo {
  return {
    id: "kb_x",
    name: "测试库",
    description: "测试描述",
    folderPath: "D:/x",
    status: "ready",
    fileCount: 0,
    chunkCount: 0,
    failedCount: 0,
    autoWatch: true,
    lastIndexedAt: null,
    ...partial,
  };
}

const ctx = {
  defaultBasePrompt: WA_PI_DEFAULT_BASE_PROMPT,
  builtinSkillsDir: "/tmp/skills",
};

test("buildKnowledgeBasesPrompt 输出对齐规格 XML 格式", () => {
  const xml = buildKnowledgeBasesPrompt([
    kb({ id: "kb_1", name: "产品知识库", description: "产品定价与规格" }),
  ]);
  expect(xml).toContain("<available_knowledge_bases>");
  expect(xml).toContain('<knowledge_base id="kb_1">');
  expect(xml).toContain("<name>产品知识库</name>");
  expect(xml).toContain("<description>产品定价与规格</description>");
  expect(xml).toContain("knowledge_search");
});

test("索引中库标注进度；error 库不出现", () => {
  const xml = buildKnowledgeBasesPrompt([
    kb({
      id: "kb_2",
      name: "需求库",
      status: "indexing",
      progress: { phase: "embedding", filesTotal: 100, filesDone: 42, chunksDone: 0 },
    }),
    kb({ id: "kb_3", name: "坏库", status: "error" }),
  ]);
  expect(xml).toContain("索引中");
  expect(xml).toContain("42");
  expect(xml).not.toContain("坏库");
});

test("空绑定返回空串（段不出现）", () => {
  expect(buildKnowledgeBasesPrompt([])).toBe("");
});

test("描述为空时不输出 description 元素（规格 §6.6：避免空标签噪音）", () => {
  const xml = buildKnowledgeBasesPrompt([kb({ description: "" })]);
  expect(xml).not.toContain("<description");
  expect(xml).toContain("<name>");
});

test("全部为 error 库时返回空串（清单为空则整段不注入）", () => {
  expect(buildKnowledgeBasesPrompt([kb({ status: "error" })])).toBe("");
});

test("composePrompt 含 knowledge-bases 段（ctx 传入清单时）", () => {
  const out = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...ctx,
    knowledgeBasesContext: "<available_knowledge_bases>…",
  });
  expect(out).toContain("<available_knowledge_bases>");
});

test("未配置 knowledgeBasesContext 时该段不出现", () => {
  const out = composePrompt(DEFAULT_PROMPT_SEGMENTS, { ...ctx });
  expect(out).not.toContain("available_knowledge_bases");
});

test("knowledge-bases 是默认段且排在末尾（memory-snapshot 之后）", () => {
  const ids = DEFAULT_PROMPT_SEGMENTS.map((s) => s.id);
  expect(ids[ids.length - 1]).toBe(KNOWLEDGE_BASES_SEGMENT_ID);
});

test("savePromptSegments 剔除 knowledge-bases 段（纯运行时段不落盘）", async () => {
  const file = join(
    import.meta.dir,
    ".tmp-prompts-kb-" + Math.random().toString(36).slice(2) + ".json",
  );
  try {
    const segments: PromptSegment[] = [
      { id: "base" },
      { id: "memory-snapshot" },
      { id: KNOWLEDGE_BASES_SEGMENT_ID, content: "用户手填残留" },
    ];
    await savePromptSegments(file, segments);
    const loaded = await loadPromptSegments(file);
    expect(loaded!.find((s) => s.id === KNOWLEDGE_BASES_SEGMENT_ID)).toBeUndefined();
    // 其它段保留
    expect(loaded!.find((s) => s.id === "base")).toBeDefined();
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(file, { force: true });
  }
});
