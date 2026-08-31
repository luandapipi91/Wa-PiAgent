import { test, expect } from "bun:test";
import { resolvePort } from "../src/constants";

test("resolvePort: 合法正整数用之", () => {
  expect(resolvePort("8888", 9776)).toBe(8888);
});

test("resolvePort: undefined/空/非数字/0/负数 → 默认", () => {
  expect(resolvePort(undefined, 9776)).toBe(9776);
  expect(resolvePort("", 9776)).toBe(9776);
  expect(resolvePort("abc", 9776)).toBe(9776);
  expect(resolvePort("0", 9776)).toBe(9776);
  expect(resolvePort("-1", 9776)).toBe(9776);
});
