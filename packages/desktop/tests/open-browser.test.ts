import { test, expect } from "bun:test";
import { openBrowserCommand } from "../src/util/open-browser";

test("openBrowserCommand: 当前平台返回非空", () => {
  const cmd = openBrowserCommand();
  expect(cmd).not.toBeNull();
  expect(cmd!.shell.length).toBeGreaterThan(0);
});
