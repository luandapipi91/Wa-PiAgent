import { test, expect } from "bun:test";
import {
  DEFAULT_AGENT_TOOLS,
  EXTENSION_TOOL_MAP,
  resolveAgentTools,
  SYSTEM_PROJECT_ID,
  SYSTEM_PROJECT_NAME,
  SYSTEM_PROJECT_CWD,
  WORKDIR_TTL_DAYS,
} from "../src/constants";

// pi-lens 已彻底移除：这些工具名不应再出现在默认 allowlist 或扩展映射里
const REMOVED_LENS_TOOLS = [
  "ast_grep_search",
  "ast_grep_replace",
  "ast_grep_outline",
  "module_report",
  "read_symbol",
  "read_enclosing",
];

test("DEFAULT_AGENT_TOOLS 含 Pi 内置文件工具、网络工具与 amaster memory 记忆工具", () => {
  expect(DEFAULT_AGENT_TOOLS).toContain("read");
  expect(DEFAULT_AGENT_TOOLS).toContain("bash");
  expect(DEFAULT_AGENT_TOOLS).toContain("edit");
  expect(DEFAULT_AGENT_TOOLS).toContain("write");
  expect(DEFAULT_AGENT_TOOLS).toContain("grep");
  expect(DEFAULT_AGENT_TOOLS).toContain("find");
  expect(DEFAULT_AGENT_TOOLS).toContain("ls");
  expect(DEFAULT_AGENT_TOOLS).toContain("web_search");
  expect(DEFAULT_AGENT_TOOLS).toContain("fetch_content");
  expect(DEFAULT_AGENT_TOOLS).toContain("get_search_content");
  // amaster host-controlled 记忆工具（须在 allowlist 显式放行，否则被 SDK 过滤）
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_add");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_replace");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_remove");
  expect(DEFAULT_AGENT_TOOLS).toContain("memory_read");
  expect(DEFAULT_AGENT_TOOLS).toContain("session_search");
  expect(DEFAULT_AGENT_TOOLS).toContain("ask_user_question");
});

test("DEFAULT_AGENT_TOOLS 不再包含 pi-lens 专属工具", () => {
  for (const tool of REMOVED_LENS_TOOLS) {
    expect(DEFAULT_AGENT_TOOLS).not.toContain(tool);
  }
});

test("EXTENSION_TOOL_MAP 不再包含 pi-lens 键", () => {
  expect(EXTENSION_TOOL_MAP).not.toHaveProperty("pi-lens");
});

// ---- resolveAgentTools：按已启用扩展「注入」工具（替代旧的从默认集过滤）----
// 第 4 个参数 toolMap 可注入伪注册表，便于测试，默认用 EXTENSION_TOOL_MAP

test("resolveAgentTools: 注入已启用扩展的工具（保留 base 顺序）", () => {
  const fakeMap = { "demo-ext": ["demo_tool_a", "demo_tool_b"] };
  const result = resolveAgentTools(["read", "edit"], new Set(["demo-ext"]), undefined, fakeMap);
  expect(result).toEqual(["read", "edit", "demo_tool_a", "demo_tool_b"]);
});

test("resolveAgentTools: 未启用的扩展工具不被注入", () => {
  const fakeMap = { "demo-ext": ["demo_tool_a"] };
  const result = resolveAgentTools(["read"], new Set(), undefined, fakeMap);
  expect(result).toEqual(["read"]);
});

test("resolveAgentTools: 已注入工具与 base 重复时去重", () => {
  const fakeMap = { "demo-ext": ["read", "demo_tool_a"] };
  const result = resolveAgentTools(["read", "edit"], new Set(["demo-ext"]), undefined, fakeMap);
  expect(result).toEqual(["read", "edit", "demo_tool_a"]);
});

test("resolveAgentTools: 不修改原数组（不可变）", () => {
  const base = ["read", "edit"];
  const snapshot = [...base];
  resolveAgentTools(base, new Set(), undefined, {});
  expect(base).toEqual(snapshot);
});

// ---- 动态工具发现（option B）：第 5 个参数 harvestedTools 注入 loader.reload() 后
// 从 runtime.tools 枚举出的工具名。替代手动维护 EXTENSION_TOOL_MAP 的静态登记。

test("resolveAgentTools: 注入运行时发现的扩展工具名（harvested）", () => {
  const result = resolveAgentTools(["read"], new Set(), undefined, {}, ["hypa_shell", "hypa_read"]);
  expect(result).toEqual(["read", "hypa_shell", "hypa_read"]);
});

test("resolveAgentTools: harvested 与 base / toolMap 去重", () => {
  const result = resolveAgentTools(
    ["read", "bash"],
    new Set(["e"]),
    undefined,
    { e: ["hypa_shell"] },
    ["read", "hypa_shell", "hypa_ls"],
  );
  // read(base) + bash(base) + hypa_shell(toolMap) + hypa_ls(harvested，去重 hypa_shell 已存在)
  expect(result).toEqual(["read", "bash", "hypa_shell", "hypa_ls"]);
});

test("resolveAgentTools: harvested 默认空（向后兼容 4 参调用）", () => {
  const result = resolveAgentTools(["read"], new Set(["e"]), undefined, { e: ["demo_tool_a"] });
  expect(result).toEqual(["read", "demo_tool_a"]);
});

test("resolveAgentTools: 扩展原生 subagent 工具被剔除；delegate 放行", () => {
  const out = resolveAgentTools(DEFAULT_AGENT_TOOLS, new Set(), "dev", {}, ["subagent", "some_ext_tool"]);
  expect(out).not.toContain("subagent");
  expect(out).toContain("delegate");
  expect(out).toContain("some_ext_tool");
});

// ---- 默认工作区（虚拟系统项目）常量 ----

test("SYSTEM_PROJECT_* 常量定义", () => {
  expect(SYSTEM_PROJECT_ID).toBe("__system__");
  expect(SYSTEM_PROJECT_NAME).toBe("默认工作区");
  expect(SYSTEM_PROJECT_CWD.endsWith("workdir")).toBe(true);
  expect(SYSTEM_PROJECT_CWD.includes("hiagent")).toBe(true);
  expect(WORKDIR_TTL_DAYS).toBe(7);
});
