import { test, expect } from "bun:test";
import { openBrowserCommand } from "../open-browser";

test("openBrowserCommand 在当前平台返回有效命令", () => {
  const cmd = openBrowserCommand();
  expect(cmd).not.toBeNull();
  expect(cmd!.shell.length).toBeGreaterThan(0);
  // args 在所有平台都是数组(可能为空,如 mac 的 open 直接接 url);
  // 关键是 shell + args + url 拼起来能执行
  expect(Array.isArray(cmd!.args)).toBe(true);
});
