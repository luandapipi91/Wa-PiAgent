// tool-schemas 共享模块测试
// 验证所有宿主工具的 description/schema 可从 @wa-pi/shared 统一导入，
// 消除 bridge-extension.ts 与 delegate-tool/ask-tool/amaster-memory 之间的文案重复。

import { test, expect } from "bun:test";

test("DELEGATE_DESCRIPTION 可从 @wa-pi/shared 导入且内容非空", async () => {
  // 当前 tool-schemas.ts 还不存在 —— 预期 import 失败，测试红灯
  const { DELEGATE_DESCRIPTION } = await import("@wa-pi/shared/tool-schemas");
  expect(typeof DELEGATE_DESCRIPTION).toBe("string");
  expect(DELEGATE_DESCRIPTION.length).toBeGreaterThan(100);
  expect(DELEGATE_DESCRIPTION).toContain("subagent");
  expect(DELEGATE_DESCRIPTION).toContain("delegate");
});

test("FLEET_DESCRIPTION 可从 @wa-pi/shared 导入", async () => {
  const { FLEET_DESCRIPTION } = await import("@wa-pi/shared/tool-schemas");
  expect(typeof FLEET_DESCRIPTION).toBe("string");
  expect(FLEET_DESCRIPTION).toContain("parallel");
});

test("ASK_DESCRIPTION / ASK_PROMPT_GUIDELINES 可从 @wa-pi/shared 导入", async () => {
  const { ASK_DESCRIPTION, ASK_PROMPT_GUIDELINES } = await import(
    "@wa-pi/shared/tool-schemas"
  );
  expect(typeof ASK_DESCRIPTION).toBe("string");
  expect(Array.isArray(ASK_PROMPT_GUIDELINES)).toBe(true);
  expect(ASK_PROMPT_GUIDELINES.length).toBeGreaterThan(0);
});

test("memory 工具描述可从 @wa-pi/shared 导入", async () => {
  const {
    MEM_TARGET_DESC,
    MEM_SCOPE_DESC,
    MEM_ADD_DESC,
    MEM_ADD_SNIPPET,
    MEM_REPLACE_DESC,
    MEM_REPLACE_SNIPPET,
    MEM_REMOVE_DESC,
    MEM_REMOVE_SNIPPET,
    MEM_READ_DESC,
    MEM_READ_SNIPPET,
  } = await import("@wa-pi/shared/tool-schemas");
  expect(typeof MEM_TARGET_DESC).toBe("string");
  expect(typeof MEM_SCOPE_DESC).toBe("string");
  expect(typeof MEM_ADD_DESC).toBe("string");
  expect(typeof MEM_ADD_SNIPPET).toBe("string");
  expect(typeof MEM_REPLACE_DESC).toBe("string");
  expect(typeof MEM_REPLACE_SNIPPET).toBe("string");
  expect(typeof MEM_REMOVE_DESC).toBe("string");
  expect(typeof MEM_REMOVE_SNIPPET).toBe("string");
  expect(typeof MEM_READ_DESC).toBe("string");
  expect(typeof MEM_READ_SNIPPET).toBe("string");
});

test("MEM_ADD_DESC 明确「双类型记录、琐事不记、任务完成必写执行记录」的存储准则", async () => {
  const { MEM_ADD_DESC } = await import("@wa-pi/shared/tool-schemas");
  // 双类型定义：knowledge = 通用事实，execution = 已完成任务的流水记录
  expect(MEM_ADD_DESC).toContain("generalizable facts");
  expect(MEM_ADD_DESC).toContain(
    "'execution' entries are a dated log of completed tasks",
  );
  // 明确排除临时状态/原始输出/文件清单/未完成工作（不再否定“修了什么 bug”——那是执行记录的典型内容）
  expect(MEM_ADD_DESC).toContain("Do NOT record transient state");
  expect(MEM_ADD_DESC).toContain("unfinished work");
  expect(MEM_ADD_DESC).not.toContain("what bug you fixed");
  // 不确定不记仅限定 knowledge；完成任务时必须写执行记录
  expect(MEM_ADD_DESC).toContain(
    "When in doubt about a knowledge entry, do not record",
  );
  expect(MEM_ADD_DESC).toContain("always write a concise execution entry");
  // target/scope 参数指引必须保留（agent 依赖）
  expect(MEM_ADD_DESC).toContain("TARGETS");
  expect(MEM_ADD_DESC).toContain("SCOPE");
});

test("DELEGATE_DESCRIPTION 与 existing delegate-tool.ts 输出一致", async () => {
  // 这个测试确保 tool-schemas.ts 的值和当前 delegate-tool.ts 的 delegateDescription() 完全一致
  const { DELEGATE_DESCRIPTION } = await import("@wa-pi/shared/tool-schemas");

  // 从 kernel 侧 delegate-tool 动态获取当前值（绕过 import 缓存，确保读到真实实现）
  const { makeDelegateTool, makeFleetTool } = await import(
    "../../kernel/src/delegate-tool"
  );
  const spawn = async () => ({ text: "", isError: false });
  const delegateReal = makeDelegateTool({ askTo: [], spawn });
  const fleetReal = makeFleetTool({ askTo: [], spawn });

  expect(DELEGATE_DESCRIPTION).toBe(delegateReal.description);

  const { FLEET_DESCRIPTION } = await import("@wa-pi/shared/tool-schemas");
  expect(FLEET_DESCRIPTION).toBe(fleetReal.description);
});

test("browser_* 工具描述可从 @wa-pi/shared 导入且非空", async () => {
  const {
    BROWSER_NAVIGATE_DESCRIPTION,
    BROWSER_EVALUATE_DESCRIPTION,
    BROWSER_SCREENSHOT_DESCRIPTION,
    BROWSER_CLOSE_DESCRIPTION,
  } = await import("@wa-pi/shared/tool-schemas");
  expect(typeof BROWSER_NAVIGATE_DESCRIPTION).toBe("string");
  expect(BROWSER_NAVIGATE_DESCRIPTION.length).toBeGreaterThan(10);
  expect(typeof BROWSER_EVALUATE_DESCRIPTION).toBe("string");
  expect(BROWSER_EVALUATE_DESCRIPTION.length).toBeGreaterThan(10);
  expect(typeof BROWSER_SCREENSHOT_DESCRIPTION).toBe("string");
  expect(BROWSER_SCREENSHOT_DESCRIPTION.length).toBeGreaterThan(10);
  expect(typeof BROWSER_CLOSE_DESCRIPTION).toBe("string");
  expect(BROWSER_CLOSE_DESCRIPTION.length).toBeGreaterThan(10);
});

test("browser_* 工具 schema 定义关键字段", async () => {
  const {
    BrowserNavigateParamsSchema,
    BrowserEvaluateParamsSchema,
    BrowserScreenshotParamsSchema,
  } = await import("@wa-pi/shared/tool-schemas");
  expect(Object.keys(BrowserNavigateParamsSchema.properties)).toContain("url");
  const evalProps = BrowserEvaluateParamsSchema.properties as Record<
    string,
    unknown
  >;
  expect(evalProps.action).toBeDefined();
  expect(evalProps.script).toBeDefined();
  expect(Object.keys(BrowserScreenshotParamsSchema.properties)).toContain(
    "format",
  );
});

test("记忆工具的模型可见文案不再指向已废弃的 MEMORY.md / USER.md 文件", async () => {
  const schemas = (await import("@wa-pi/shared/tool-schemas")) as Record<
    string,
    unknown
  >;
  // 这 5 个常量的文本会作为 description / promptSnippet 进入模型上下文
  for (const name of [
    "MEM_TARGET_DESC",
    "MEM_ADD_SNIPPET",
    "MEM_REPLACE_SNIPPET",
    "MEM_REMOVE_SNIPPET",
    "MEM_READ_SNIPPET",
  ]) {
    const value = schemas[name];
    expect(typeof value).toBe("string");
    expect(value as string).not.toContain("MEMORY.md");
    expect(value as string).not.toContain("USER.md");
  }
});

test("tool-schemas 全模块字符串导出都不得出现 MEMORY.md / USER.md（防回归）", async () => {
  const schemas = (await import("@wa-pi/shared/tool-schemas")) as Record<
    string,
    unknown
  >;
  const offenders = Object.entries(schemas)
    .filter(
      ([, value]) =>
        typeof value === "string" && /MEMORY\.md|USER\.md/.test(value),
    )
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});

test("MEM_TARGET_DESC 保留「target 怎么选」的分层语义", async () => {
  const { MEM_TARGET_DESC } = await import("@wa-pi/shared/tool-schemas");
  // user = 关于用户是谁；memory = 我自己的笔记
  expect(MEM_TARGET_DESC).toContain("'user'");
  expect(MEM_TARGET_DESC).toContain("'memory'");
  expect(MEM_TARGET_DESC).toContain("who the user is");
  expect(MEM_TARGET_DESC).toContain("your own notes");
});

test("MEM_REPLACE_DESC / MEM_REMOVE_DESC 说明「id 优先，无 id 才用 oldText」", async () => {
  const { MEM_REPLACE_DESC, MEM_REMOVE_DESC } = await import(
    "@wa-pi/shared/tool-schemas"
  );
  for (const desc of [MEM_REPLACE_DESC, MEM_REMOVE_DESC]) {
    // 工具实现是 id 优先，描述必须让模型能学到这件事
    expect(desc).toMatch(/[Pp]refer/);
    expect(desc).toContain("id");
    expect(desc).toContain("memory_search");
    expect(desc).toContain("memory_read");
    expect(desc).toContain("oldText");
  }
});

test("BRIDGE_TOOL_NAMES 包含 4 个 browser 工具", async () => {
  const { BRIDGE_TOOL_NAMES } = await import("@wa-pi/shared/tool-schemas");
  for (const name of [
    "browser_navigate",
    "browser_evaluate",
    "browser_screenshot",
    "browser_close",
  ]) {
    expect(BRIDGE_TOOL_NAMES).toContain(name);
  }
});
