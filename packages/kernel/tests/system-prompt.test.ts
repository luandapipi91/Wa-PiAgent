import { test, expect } from "bun:test";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composePrompt,
  loadPromptSegments,
  savePromptSegments,
  ensurePromptsConfig,
  DEFAULT_PROMPT_SEGMENTS,
  DEFAULT_DELEGATE_MECHANISM_PROMPT,
  HIAGENT_DEFAULT_BASE_PROMPT,
  ENV_CONSTRAINTS_SUFFIX,
  PROMPTS_SCHEMA_VERSION,
  STATIC_SEGMENT_IDS,
  type PromptSegment,
} from "../src/system-prompt";
import { buildDelegateRoster } from "../src/delegate-tool";

const defaultCtx = {
  defaultBasePrompt: HIAGENT_DEFAULT_BASE_PROMPT,
  delegateRoster: "## Available Subagents\n\nInvoke via the delegate tool:\n- Explore: explore",
  builtinSkillsDir: "/tmp/skills",
  memorySnapshot: "## Memory Snapshot\n\nuser prefers typescript",
};

function tempFile() {
  return join(import.meta.dir, ".tmp-prompts-" + Math.random().toString(36).slice(2) + ".json");
}

// ===== composePrompt：段落结构与顺序（不验证具体文案）=====

test("composePrompt 默认段落全部出现", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, defaultCtx);
  // 5 段都应出现（base / delegate-mechanism / delegate-roster / env-constraints / memory-snapshot）
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(result).toContain(DEFAULT_DELEGATE_MECHANISM_PROMPT);
  expect(result).toContain("## Available Subagents");
  expect(result).toContain("Built-in directory: /tmp/skills");
  expect(result).toContain("## Memory Snapshot");
});

test("composePrompt 默认段落顺序：base → delegate-mechanism → delegate-roster → env → memory", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, defaultCtx);
  const basePos = result.indexOf(HIAGENT_DEFAULT_BASE_PROMPT);
  const mechanismPos = result.indexOf(DEFAULT_DELEGATE_MECHANISM_PROMPT);
  const rosterPos = result.indexOf("## Available Subagents");
  const envPos = result.indexOf("Built-in directory:");
  const memPos = result.indexOf("## Memory Snapshot");
  expect(basePos).toBeLessThan(mechanismPos);
  expect(mechanismPos).toBeLessThan(rosterPos);
  expect(rosterPos).toBeLessThan(envPos);
  expect(envPos).toBeLessThan(memPos);
});

test("composePrompt delegateRoster 空串 → delegate-roster 段不出现", () => {
  const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...defaultCtx,
    delegateRoster: "",
  });
  expect(result).not.toContain("## Available Subagents");
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
  const result = composePrompt([{ id: "base" }], defaultCtx);
  expect(result).toBe(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt 静态段（delegate-mechanism）写了 content → 用用户内容", () => {
  const custom = "## My Custom Mechanism";
  const result = composePrompt(
    [{ id: "delegate-mechanism", content: custom }],
    defaultCtx,
  );
  expect(result).toBe(custom);
});

test("composePrompt 静态段（delegate-mechanism）没写 content → 返回空串（不出现）", () => {
  const result = composePrompt(
    [{ id: "delegate-mechanism" }],
    defaultCtx,
  );
  expect(result).toBe("");
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
  const result = composePrompt([{ id: "base" }], defaultCtx);
  expect(result).toBe(HIAGENT_DEFAULT_BASE_PROMPT);
});

test("composePrompt 未知 id 且无 content → 被过滤", () => {
  const result = composePrompt(
    [
      { id: "base" },
      { id: "custom-unknown" },
      { id: "another-unknown", content: "Has content" },
    ],
    defaultCtx,
  );
  expect(result).toContain(HIAGENT_DEFAULT_BASE_PROMPT);
  expect(result).toContain("Has content");
});

// ===== 集成测试：完整组装链路（buildDelegateRoster → composePrompt）=====

test("集成：askTo 含命名智能体时，系统提示词的 roster 段含内置+命名", () => {
  // 模拟真实链路：buildDelegateRoster 产出 roster 段 → 注入 composePrompt
  const roster = buildDelegateRoster(
    [{ name: "代码审查", description: "评审改动", delegationHints: { whenToDelegate: "需评审", benefit: "反馈" } }],
    { "Explore": { whenToDelegate: "跨多文件探索", benefit: "省上下文" } },
  );
  const prompt = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...defaultCtx,
    delegateRoster: roster,
  });
  // 内置类型出现
  expect(prompt).toContain("Explore");
  expect(prompt).toContain("Plan");
  expect(prompt).toContain("general-purpose");
  // 命名智能体出现且含 hints
  expect(prompt).toContain("代码审查");
  expect(prompt).toContain("需评审");
  // delegate-mechanism 段仍在（@语法 + fleet）
  expect(prompt).toContain("Delegation Mechanism");
  expect(prompt).toContain("fleet");
});

test("集成：askTo 为空时，系统提示词的 roster 段只含内置类型", () => {
  const roster = buildDelegateRoster([]);
  const prompt = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
    ...defaultCtx,
    delegateRoster: roster,
  });
  expect(prompt).toContain("Explore");
  expect(prompt).toContain("Plan");
  // delegate-roster 段标题在
  expect(prompt).toContain("## Available Subagents");
});

// ===== 文件 I/O =====

test("savePromptSegments + loadPromptSegments 往返", async () => {
  const f = tempFile();
  const segs = [
    { id: "base" },
    { id: "delegate-mechanism", content: "custom content" },
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
  await ensurePromptsConfig(f);
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(custom);
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 失败不抛错（不阻塞启动）", async () => {
  const f = join(import.meta.dir, ".non-existent-dir-" + Date.now(), "prompts.json");
  await expect(ensurePromptsConfig(f)).resolves.toBeUndefined();
});

// ===== schemaVersion 迁移 =====

test("ensurePromptsConfig 迁移旧格式文件（无 schemaVersion）→ 只刷新静态段，保留动态段", async () => {
  const f = tempFile();
  // 模拟旧版磁盘文件：含已废弃的 subagent-clarify / delegate-network 段 id
  const legacySegments: PromptSegment[] = [
    { id: "base", content: "MY CUSTOM BASE" },
    { id: "delegate-mechanism", content: "OLD MECHANISM TEXT" },   // 静态段，应刷新
    { id: "delegate-roster" },                                     // 动态段，保留原样
    { id: "subagent-clarify", content: "OBSOLETE" },               // 旧 id，不在新版静态段里 → 保留原样（不刷新）
  ];
  writeFileSync(f, JSON.stringify({ segments: legacySegments }, null, 2));

  await ensurePromptsConfig(f);

  const loaded = await loadPromptSegments(f);
  expect(loaded).not.toBeNull();
  const byId = new Map((loaded as PromptSegment[]).map(s => [s.id, s]));

  // delegate-mechanism 被刷新为代码最新值
  expect(byId.get("delegate-mechanism")!.content).toBe(DEFAULT_DELEGATE_MECHANISM_PROMPT);
  // 动态段保留用户自定义
  expect(byId.get("base")!.content).toBe("MY CUSTOM BASE");
  expect(byId.has("delegate-roster")).toBe(true);

  // 磁盘文件已写入新 schemaVersion
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw.schemaVersion).toBe(PROMPTS_SCHEMA_VERSION);
  rmSync(f, { force: true });
});

test("ensurePromptsConfig 迁移后幂等（版本匹配不再重写）", async () => {
  const f = tempFile();
  const legacy: PromptSegment[] = [
    { id: "base", content: "KEEP ME" },
    { id: "delegate-mechanism", content: "OLD" },
  ];
  writeFileSync(f, JSON.stringify({ segments: legacy }, null, 2));

  await ensurePromptsConfig(f);
  const afterFirst = await loadPromptSegments(f);
  expect(afterFirst!.find(s => s.id === "delegate-mechanism")!.content).toBe(DEFAULT_DELEGATE_MECHANISM_PROMPT);

  // 手动篡改静态段，验证第二次不再重写
  const tampered = JSON.parse(readFileSync(f, "utf8"));
  const mechIdx = tampered.segments.findIndex((s: PromptSegment) => s.id === "delegate-mechanism");
  tampered.segments[mechIdx].content = "TAMPERED AFTER MIGRATION";
  writeFileSync(f, JSON.stringify(tampered));

  await ensurePromptsConfig(f);
  const afterSecond = await loadPromptSegments(f);
  expect(afterSecond!.find(s => s.id === "delegate-mechanism")!.content).toBe("TAMPERED AFTER MIGRATION");
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
  const segs: PromptSegment[] = [{ id: "base" }, { id: "delegate-mechanism", content: "x" }];
  await savePromptSegments(f, segs);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw.schemaVersion).toBe(PROMPTS_SCHEMA_VERSION);
  const loaded = await loadPromptSegments(f);
  expect(loaded).toEqual(segs);
  rmSync(f, { force: true });
});
