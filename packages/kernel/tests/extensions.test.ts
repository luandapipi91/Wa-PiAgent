import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildAdditionalExtensionPaths } from "../src/extensions";
import { GENERATED_DIR } from "@wa-pi/shared";

test("buildAdditionalExtensionPaths 返回 npm 扩展入口，provider-extension 按需追加", () => {
  const paths = buildAdditionalExtensionPaths();

  // npm 包入口必须存在且解析到实际 .ts 文件
  const webAccess = paths.find((p) => p.includes("pi-web-access"));
  const mcpAdapter = paths.find((p) => p.includes("pi-mcp-adapter"));
  expect(webAccess).toBeTruthy();
  expect(mcpAdapter).toBeTruthy();
  for (const p of [webAccess, mcpAdapter]) {
    expect(p!.endsWith(".ts")).toBe(true);
    expect(existsSync(p!)).toBe(true);
  }

  // provider-extension 由 GENERATED_DIR 按需追加（文件存在时才加入）。
  // 用存在性等同断言而非创建文件，避免与 provider-extension.test.ts 并发写同一文件产生 flaky。
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  expect(paths.includes(providerExt)).toBe(existsSync(providerExt));

  // wa-pi-bridge 同样按需追加（RPC 模式宿主工具桥，bridge-extension.ts 生成）
  const bridgeExt = join(GENERATED_DIR, "wa-pi-bridge.ts");
  expect(paths.includes(bridgeExt)).toBe(existsSync(bridgeExt));
});

test("内置扩展清单：不含已移除的 pi-open-agents / 不含 pi-intercom", async () => {
  const paths = buildAdditionalExtensionPaths();
  expect(paths.some((p) => p.includes("pi-open-agents"))).toBe(false);
  expect(paths.some((p) => p.includes("pi-intercom"))).toBe(false);
});

// 动态扩展不再走 -e（改由 pi 官方 packages 机制自动加载），故 buildAdditionalExtensionPaths
// 不再接收动态包名参数。动态扩展的加载/重载由 session.reload() 重读 settings.json packages 实现。
