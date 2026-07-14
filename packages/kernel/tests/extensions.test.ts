import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildAdditionalExtensionPaths, extractRuntimeToolNames } from "../src/extensions";
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

// ---- 动态扩展注入（option B Gap 1）：把运行时安装并启用的第三方 Pi 扩展入口
// 加入 additionalExtensionPaths，使 SDK loader 真正加载它们（否则它们的工具/钩子不注册）。

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

// ---- 运行时工具名抽取（option B Gap 2）：loader.reload() 后从扩展注册的工具
// 收集全部工具名，喂给 resolveAgentTools 注入 allowlist。SDK 0.80.6 提供
// runtime.getAllTools() 聚合接口，也支持遍历各扩展的 tools Map 兜底。

test("extractRuntimeToolNames: 从 runtime.getAllTools() 提取工具名", () => {
  const loader = {
    getExtensions: () => ({
      runtime: { getAllTools: () => ["hypa_shell", "hypa_read"] },
    }),
  };
  expect(extractRuntimeToolNames(loader)).toEqual(["hypa_shell", "hypa_read"]);
});

test("extractRuntimeToolNames: 从各扩展的 tools Map 兜底提取", () => {
  const loader = {
    getExtensions: () => ({
      runtime: {},
      extensions: [
        { tools: new Map([["hypa_shell", {}]]) },
        { tools: new Map([["hypa_read", {}]]) },
      ],
    }),
  };
  expect(extractRuntimeToolNames(loader)).toEqual(["hypa_shell", "hypa_read"]);
});

test("extractRuntimeToolNames: loader 缺失 / 结构不符时返回空数组（容错不抛）", () => {
  expect(extractRuntimeToolNames({})).toEqual([]);
  expect(extractRuntimeToolNames({ getExtensions: () => null })).toEqual([]);
  expect(extractRuntimeToolNames({ getExtensions: () => ({ runtime: {} }) })).toEqual([]);
});
