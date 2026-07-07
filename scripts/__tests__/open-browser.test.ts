import { test, expect } from "bun:test";
import { openBrowserCommand } from "../open-browser";

test("openBrowserCommand 在当前平台返回有效命令", () => {
  const cmd = openBrowserCommand();
  expect(cmd).not.toBeNull();
  expect(cmd!.shell.length).toBeGreaterThan(0);
  expect(cmd!.args.length).toBeGreaterThan(0);
});
