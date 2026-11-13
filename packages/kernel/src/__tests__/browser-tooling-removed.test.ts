import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const BRIDGE = readFileSync(new URL("../wa-pi-bridge.extension.ts", import.meta.url), "utf8");
const AGENT_MANAGER = readFileSync(new URL("../agent-manager.ts", import.meta.url), "utf8");

test("bridge 扩展不再注册 browser_* 工具", () => {
  for (const name of ["browser_navigate", "browser_evaluate", "browser_screenshot", "browser_snapshot", "browser_read", "browser_wait", "browser_close"]) {
    expect(BRIDGE).not.toContain(`"${name}"`);
  }
});

test("agent-manager 不再引用浏览器实现与分派", () => {
  expect(AGENT_MANAGER).not.toContain("handleBrowserTool");
  expect(AGENT_MANAGER).not.toContain("BrowserManager");
  expect(AGENT_MANAGER).not.toContain('"browser_"');
});
