import { test, expect } from "bun:test";
import { DEFAULT_AGENT_TOOLS } from "../src/constants";

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
