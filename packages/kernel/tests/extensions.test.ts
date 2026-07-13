import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildAdditionalExtensionPaths } from "../src/extensions";
import { GENERATED_DIR } from "@hiagent/shared";

test("buildAdditionalExtensionPaths 返回 npm 扩展入口，provider-extension 按需追加", () => {
  const paths = buildAdditionalExtensionPaths();

  // npm 包入口必须存在且解析到实际 .ts 文件
  const intercom = paths.find((p) => p.includes("pi-intercom"));
  const webAccess = paths.find((p) => p.includes("pi-web-access"));
  expect(intercom).toBeTruthy();
  expect(webAccess).toBeTruthy();
  for (const p of [intercom, webAccess]) {
    expect(p!.endsWith(".ts")).toBe(true);
    expect(existsSync(p!)).toBe(true);
  }

  // provider-extension 由 GENERATED_DIR 按需追加（文件存在时才加入）。
  // 用存在性等同断言而非创建文件，避免与 provider-extension.test.ts 并发写同一文件产生 flaky。
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  expect(paths.includes(providerExt)).toBe(existsSync(providerExt));
});
