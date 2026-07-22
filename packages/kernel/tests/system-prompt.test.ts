import { test, expect } from "bun:test";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composePrompt,
  loadPromptSegments,
  savePromptSegments,
  ensurePromptsConfig,
  DEFAULT_PROMPT_SEGMENTS,
  HIAGENT_DEFAULT_BASE_PROMPT,
  DEFAULT_DELEGATE_SYNTAX_PROMPT,
  DEFAULT_SUBAGENT_CLARIFY_PROMPT,
  ENV_CONSTRAINTS_SUFFIX,
  PROMPTS_SCHEMA_VERSION,
  STATIC_SEGMENT_IDS,
  type PromptSegment,
} from "../src/system-prompt";

const defaultCtx = {
  defaultBasePrompt: HIAGENT_DEFAULT_BASE_PROMPT,
  delegatePrompt: "## Delegation Network\n\nAgents available: a, b",
  builtinSkillsDir: "/tmp/skills",
  memorySnapshot: "## Memory Snapshot\n\nuser prefers typescript",
};

function tempFile() {
  return join(import.meta.dir, ".tmp-prompts-" + Math.random().toString(36).slice(2) + ".json");
}

// ===== composePrompt：核心组装逻辑 =====

test("composePrompt 默认 6 段按顺序拼接（含所有动态段）", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, defaultCtx);
  // 6 段都应出现
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(result).toContain(DEFAULT_DELEGATE_SYNTAX_PROMPT);
  expect(result).toContain(DEFAULT_SUBAGENT_CLARIFY_PROMPT);
  expect(result).toContain("## Delegation Network");
  expect(result).toContain("Built-in directory: /tmp/skills");
  expect(result).toContain(ENV_CONSTRAINTS_SUFFIX);
  expect(result).toContain("## Memory Snapshot");

  // 顺序：base 在最前，memory 在最后
  const basePos = result.indexOf(HIAGENT_DEFAULT_BASE_PROMPT);
  const delegateSyntaxPos = result.indexOf(DEFAULT_DELEGATE_SYNTAX_PROMPT);
  const subagentPos = result.indexOf(DEFAULT_SUBAGENT_CLARIFY_PROMPT);
  const delegateNetworkPos = result.indexOf("## Delegation Network");
  const envPos = result.indexOf("Built-in directory:");
  const memPos = result.indexOf("## Memory Snapshot");
  expect(basePos).toBeLessThan(delegateSyntaxPos);
  expect(delegateSyntaxPos).toBeLessThan(subagentPos);
  expect(subagentPos).toBeLessThan(delegateNetworkPos);
  expect(delegateNetworkPos).toBeLessThan(envPos);
  expect(envPos).toBeLessThan(memPos);
});

test("composePrompt delegatePrompt 空串 → delegate-network 段不出现", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...defaultCtx,
    delegatePrompt: "",
  });
  expect(result).not.toContain("## Delegation Network");
  // 其它段仍在
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(result).toContain("Built-in directory:");
});

test("composePrompt memorySnapshot 空 → memory-snapshot 段不出现", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...defaultCtx,
    memorySnapshot: "",
  });
  expect(result).not.toContain("## Memory Snapshot");
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt env-constraints 始终拼接 builtinSkillsDir + 固定后缀", () => {
  const result = composePrompt(
    [{ id: "env-constraints" }],
    { ...defaultCtx, builtinSkillsDir: "/custom/skills" },
  );
  expect(result).toContain("Built-in directory: /custom/skills");
  expect(result).toContain(ENV_CONSTRAINTS_SUFFIX);
});

test("composePrompt base 段写了 content → 覆盖 defaultBasePrompt", () => {
  const customBase = "Custom base prompt";
  const result = composePrompt(
    [{ id: "base", content: customBase }],
    defaultCtx,
  );
  expect(result).toBe(customBase);
  expect(result).not.toContain(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt base 段没写 content → 用 defaultBasePrompt", () => {
  const result = composePrompt(
    [{ id: "base" }],
    defaultCtx,
  );
  expect(result).toBe(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt 静态段（delegate-syntax）写了 content → 用用户内容", () => {
  const custom = "## My Custom Syntax";
  const result = composePrompt(
    [{ id: "delegate-syntax", content: custom }],
    defaultCtx,
  );
  expect(result).toBe(custom);
});

test("composePrompt 静态段（delegate-syntax）没写 content → 返回空串（不出现）", () => {
  // 静态段未写 content 时无运行时兜底（不同于动态段），返回空串被过滤
  const result = composePrompt(
    [{ id: "delegate-syntax" }],
    defaultCtx,
  );
  expect(result).toBe("");
});

test("DEFAULT_SUBAGENT_CLARIFY_PROMPT 含内置类型说明（general-purpose / Explore / Plan / fleet）", () => {
  // 重构后此段新增"内置类型用法"说明，确保关键信息齐备
  expect(DEFAULT_SUBAGENT_CLARIFY_PROMPT).toContain("general-purpose");
  expect(DEFAULT_SUBAGENT_CLARIFY_PROMPT).toContain("Explore");
  expect(DEFAULT_SUBAGENT_CLARIFY_PROMPT).toContain("Plan");
  expect(DEFAULT_SUBAGENT_CLARIFY_PROMPT).toContain("fleet");
  expect(DEFAULT_SUBAGENT_CLARIFY_PROMPT).toContain("read-only");
});

test("composePrompt 动态段写 content（env-constraints）→ 用户覆盖", () => {
  const customEnv = "Custom env constraints";
  const result = composePrompt(
    [{ id: "env-constraints", content: customEnv }],
    defaultCtx,
  );
  expect(result).toBe(customEnv);
  expect(result).not.toContain("Built-in directory:");
});

test("composePrompt 数组顺序 = 输出顺序（可任意调整）", () => {
  // 把 memory 放到最前
  const reordered = [
    { id: "memory-snapshot" },
    { id: "base" },
  ];
  const result = composePrompt(reordered, defaultCtx);
  const memPos = result.indexOf("## Memory Snapshot");
  const basePos = result.indexOf(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(memPos).toBeLessThan(basePos);
});

test("composePrompt 段不在数组里 = 不启用", () => {
  const result = composePrompt(
    [{ id: "base" }],
    defaultCtx,
  );
  // 只 base，其它段都不应出现
  expect(result).toBe(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt 未知 id 且无 content → 被过滤", () => {
  const result = composePrompt(
    [
      { id: "base" },
      { id: "custom-unknown" },   // 无 content
      { id: "another-unknown", content: "Has content" },  // 有 content
    ],
    defaultCtx,
  );
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(result).toContain("Has content");
  // custom-unknown 因无 content 且非已知动态段 → 被过滤
});

// ===== 文件 I/O =====

test("savePromptSegments + loadPromptSegments 往返", async () => {
  const f = tempFile();
  const segs = [
    { id: "base" },
    { id: "delegate-syntax", content: "custom content" },
  ];
  await savePromptSegments(f, segs);
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(segs);
  rmSync(f, { force: true });
});

test("loadPromptSegments 文件不存在 → 返回 null", async () => {
  const loaded = await loadPromptSegments(join(import.meta.dir, ".non-existent-" + Date.now() + ".json"));
  expect(loaded).toBeNull();
});

test("loadPromptSegments 格式错误（无 segments 字段）→ 返回 null", async () => {
  const f = tempFile();
  writeFileSync(f, JSON.stringify({ wrongField: [] }));
  const loaded = await loadPromptSegments(f);
  expect(loaded).toBeNull();
  rmSync(f, { force: true });
});

test("loadPromptSegments JSON 解析失败 → 返回 null", async () => {
  const f = tempFile();
  writeFileSync(f, "{ invalid json");
  const loaded = await loadPromptSegments(f);
  expect(loaded).toBeNull();
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 首次调用写入默认配置", async () => {
  const f = tempFile();
  await ensurePromptsConfig(f);
  expect(existsSync(f)).toBe(true);
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(DEFAULT_PROMPT_SEGMENTS);
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 二次调用幂等（已存在不动）", async () => {
  const f = tempFile();
  const custom: PromptSegment[] = [{ id: "base", content: "custom" }];
  await savePromptSegments(f, custom);
  await ensurePromptsConfig(f);  // 不应覆盖
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(custom);
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 失败不抛错（不阻塞启动）", async () => {
  // 路径指向一个只读目录的深处，触发 writeFile 失败
  const f = join(import.meta.dir, ".non-existent-dir-" + Date.now(), "prompts.json");
  await expect(ensurePromptsConfig(f)).resolves.toBeUndefined();
});

// ===== schemaVersion 迁移 =====

test("ensurePromptsConfig 迁移旧格式文件（无 schemaVersion）→ 只刷新静态段，保留动态段", async () => {
  const f = tempFile();
  // 模拟磁盘旧文件：无 schemaVersion 字段，subagent-clarify 是过时旧文案，base 有用户自定义
  const legacySegments: PromptSegment[] = [
    { id: "base", content: "MY CUSTOM BASE" },                              // 动态段，应保留
    { id: "delegate-syntax", content: "OLD SYNTAX TEXT" },                  // 静态段，应刷新
    { id: "subagent-clarify", content: "OLD CLARIFY TEXT" },                // 静态段，应刷新
    { id: "delegate-network" },                                             // 动态段，保留原样
  ];
  writeFileSync(f, JSON.stringify({ segments: legacySegments }, null, 2));

  await ensurePromptsConfig(f);

  const loaded = await loadPromptSegments(f);
  expect(loaded).not.toBeNull();
  const byId = new Map((loaded as PromptSegment[]).map(s => [s.id, s]));

  // 静态段被刷新为代码最新值
  expect(byId.get("delegate-syntax")!.content).toBe(DEFAULT_DELEGATE_SYNTAX_PROMPT);
  expect(byId.get("subagent-clarify")!.content).toBe(DEFAULT_SUBAGENT_CLARIFY_PROMPT);
  // 动态段保留用户自定义
  expect(byId.get("base")!.content).toBe("MY CUSTOM BASE");
  expect(byId.has("delegate-network")).toBe(true);

  // 磁盘文件已写入新 schemaVersion
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw.schemaVersion).toBe(PROMPTS_SCHEMA_VERSION);
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 迁移后幂等（版本匹配不再重写）", async () => {
  const f = tempFile();
  const legacy: PromptSegment[] = [
    { id: "base", content: "KEEP ME" },
    { id: "subagent-clarify", content: "OLD" },
  ];
  writeFileSync(f, JSON.stringify({ segments: legacy }, null, 2));

  await ensurePromptsConfig(f);   // 第一次：迁移
  const afterFirst = await loadPromptSegments(f);
  expect(afterFirst!.find(s => s.id === "subagent-clarify")!.content).toBe(DEFAULT_SUBAGENT_CLARIFY_PROMPT);

  // 手动篡改静态段，验证第二次不再重写
  const tampered = JSON.parse(readFileSync(f, "utf8"));
  tampered.segments[1].content = "TAMPERED AFTER MIGRATION";
  writeFileSync(f, JSON.stringify(tampered));

  await ensurePromptsConfig(f);   // 第二次：版本匹配，应不动
  const afterSecond = await loadPromptSegments(f);
  expect(afterSecond!.find(s => s.id === "subagent-clarify")!.content).toBe("TAMPERED AFTER MIGRATION");
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 全新机器首次写入含 schemaVersion + 最新静态段", async () => {
  const f = tempFile();
  await ensurePromptsConfig(f);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw.schemaVersion).toBe(PROMPTS_SCHEMA_VERSION);
  expect(raw.segments).toEqual(DEFAULT_PROMPT_SEGMENTS);
  rmSync(f, { force: true });
});

test("savePromptSegments 写入 schemaVersion，loadPromptSegments 往返仅返回 segments", async () => {
  const f = tempFile();
  const segs: PromptSegment[] = [{ id: "base" }, { id: "delegate-syntax", content: "x" }];
  await savePromptSegments(f, segs);
  // 磁盘含 schemaVersion
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw.schemaVersion).toBe(PROMPTS_SCHEMA_VERSION);
  // load 仍只返回 segments（向后兼容）
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(segs);
  rmSync(f, { force: true });
});
