import { test, expect } from "bun:test";
import { HIAGENT_VERSION } from "../src/index";

test("骨架可导入", () => {
  expect(HIAGENT_VERSION).toBe("0.0.0");
});
