import { test, expect } from "bun:test";
import { resolveKernelDir, resolveWebDir } from "../src/util/paths.cjs";

test("packaged: 用 resourcesPath/kernel", () => {
  const env = {};
  expect(resolveKernelDir(true, "R:/resources", env)).toMatch(/R:[\\/]resources[\\/]kernel$/);
  expect(resolveWebDir(true, "R:/resources", env)).toMatch(/R:[\\/]resources[\\/]web$/);
});

test("dev: env 覆盖优先，否则回退 dev 默认", () => {
  expect(resolveKernelDir(false, "R:/resources", { HIAGENT_KERNEL_DIR: "/dev/kernel" })).toBe("/dev/kernel");
  expect(resolveKernelDir(false, "R:/resources", {})).toMatch(/packages[\\/]kernel$/);
});
