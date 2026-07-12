import { test, expect } from "bun:test";
import {
  DEFAULT_AGENT_TOOLS,
  EXTENSION_TOOL_MAP,
  resolveAgentTools,
} from "../src/constants";

test("DEFAULT_AGENT_TOOLS 含 Pi 内置文件工具、pi-web-access 网络工具与 amaster memory 记忆工具", () => {
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
});

// ---- resolveAgentTools：按可选插件启用态过滤工具 allowlist ----

test("resolveAgentTools: pi-lens 启用 → 9 个 lens 工具全部保留", () => {
  const result = resolveAgentTools(DEFAULT_AGENT_TOOLS, new Set(["pi-lens"]));
  for (const tool of EXTENSION_TOOL_MAP["pi-lens"]) {
    expect(result).toContain(tool);
  }
  // 非 lens 工具不受影响
  expect(result).toContain("read");
  expect(result).toContain("memory_read");
});

test("resolveAgentTools: pi-lens 禁用 → 9 个 lens 工具被过滤，其余工具不受影响", () => {
  const result = resolveAgentTools(DEFAULT_AGENT_TOOLS, new Set());
  // lens 工具全部移除
  for (const tool of EXTENSION_TOOL_MAP["pi-lens"]) {
    expect(result).not.toContain(tool);
  }
  // 基础工具/记忆工具/网络工具原样保留
  expect(result).toContain("read");
  expect(result).toContain("edit");
  expect(result).toContain("bash");
  expect(result).toContain("memory_add");
  expect(result).toContain("web_search");
  expect(result).toContain("ask_user_question");
  // 过滤后数量 = 默认集 - 9 个 lens 工具
  expect(result.length).toBe(DEFAULT_AGENT_TOOLS.length - EXTENSION_TOOL_MAP["pi-lens"].length);
});

test("resolveAgentTools: 空插件集等价于全部禁用 → 过滤掉所有可选插件工具", () => {
  const base = ["read", "lsp_navigation", "ast_grep_search", "edit"];
  const result = resolveAgentTools(base, new Set());
  expect(result).toEqual(["read", "edit"]);
});

test("resolveAgentTools: 不修改原数组（不可变）", () => {
  const base = ["read", "lsp_navigation", "edit"];
  const snapshot = [...base];
  resolveAgentTools(base, new Set());
  expect(base).toEqual(snapshot);
});
