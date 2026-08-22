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
  const { ASK_DESCRIPTION, ASK_PROMPT_GUIDELINES } = await import("@wa-pi/shared/tool-schemas");
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

test("DELEGATE_DESCRIPTION 与 existing delegate-tool.ts 输出一致", async () => {
  // 这个测试确保 tool-schemas.ts 的值和当前 delegate-tool.ts 的 delegateDescription() 完全一致
  const { DELEGATE_DESCRIPTION } = await import("@wa-pi/shared/tool-schemas");

  // 从 kernel 侧 delegate-tool 动态获取当前值（绕过 import 缓存，确保读到真实实现）
  const { makeDelegateTool, makeFleetTool } = await import("../../kernel/src/delegate-tool");
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
  const evalProps = BrowserEvaluateParamsSchema.properties as Record<string, unknown>;
  expect(evalProps.action).toBeDefined();
  expect(evalProps.script).toBeDefined();
  expect(Object.keys(BrowserScreenshotParamsSchema.properties)).toContain("format");
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
