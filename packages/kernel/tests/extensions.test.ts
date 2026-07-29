import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildAdditionalExtensionPaths } from "../src/extensions";
import { GENERATED_DIR } from "@wa-pi/shared";

test("buildAdditionalExtensionPaths 返回 npm 扩展入口，provider-extension 按需追加", () => {
  const paths = buildAdditionalExtensionPaths();

  // npm 包入口必须存在且解析到实际 .ts 文件
  const subagents = paths.find((p) => p.includes("pi-open-agents"));
  const webAccess = paths.find((p) => p.includes("pi-web-access"));
  expect(subagents).toBeTruthy();
  expect(webAccess).toBeTruthy();
  for (const p of [subagents, webAccess]) {
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

// ---- 动态扩展注入（option B Gap 1）：把运行时安装并启用的第三方 Pi 扩展入口
// 加入扩展路径（pi 进程经 -e 加载），否则它们的工具/钩子不注册。

test("buildAdditionalExtensionPaths: 纳入声明 pi.extensions 的动态扩展入口", () => {
  // pi-web-access 声明 pi.extensions:["./index.ts"] 且可从 kernel 上下文解析，
  // 用它模拟一个「动态安装的 Pi 扩展」（它同时也是 builtin，故至少 1 条命中）。
  const paths = buildAdditionalExtensionPaths(["pi-web-access"]);
  const webAccessPaths = paths.filter((p) => p.includes("pi-web-access"));
  expect(webAccessPaths.length).toBeGreaterThanOrEqual(1);
  for (const p of webAccessPaths) {
    expect(p.endsWith(".ts")).toBe(true);
    expect(existsSync(p)).toBe(true);
  }
});

test("buildAdditionalExtensionPaths: 不存在 / 非 Pi 扩展的包被跳过且不抛错", () => {
  const before = buildAdditionalExtensionPaths();
  // 一个肯定不存在于 node_modules 的包名：既非 Pi 扩展也无法解析，必须被静默跳过
  const after = buildAdditionalExtensionPaths(["totally-fake-pkg-xyz-123"]);
  expect(after).toEqual(before);
});

test("内置扩展清单：含 pi-open-agents，不含 pi-intercom", async () => {
  const paths = buildAdditionalExtensionPaths([]);
  expect(paths.some(p => p.includes("pi-open-agents"))).toBe(true);
  expect(paths.some(p => p.includes("pi-intercom"))).toBe(false);
});
