// compile-binary.ts 纯函数测试：编译参数、asset 暂存、平台二进制名。
// 不真的跑 bun build --compile（那是 Task 6 集成测试的职责）。
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readdirSync, rmSync } from "node:fs";
import {
  buildCompileArgs,
  stageAssetDir,
  EXTERNAL_PACKAGES,
  BRIDGE_ASSET_FILES,
  kernelBinaryName,
} from "../scripts/compile-binary";

test("buildCompileArgs: 入口是 desktop-server.ts，含 --compile/--external/--asset/--outfile", () => {
  const args = buildCompileArgs("/tmp/out/WaPiKernel.exe", "/tmp/assets");
  expect(args[0]).toBe("build");
  expect(args[1].replace(/\\/g, "/").endsWith("packages/kernel/src/desktop-server.ts")).toBe(true);
  expect(args).toContain("--compile");
  expect(args).toContain("--asset");
  expect(args).toContain("/tmp/assets");
  expect(args).toContain("--outfile");
  expect(args).toContain("/tmp/out/WaPiKernel.exe");
  for (const pkg of EXTERNAL_PACKAGES) {
    const i = args.indexOf("--external", args.indexOf(pkg) - 1);
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(pkg);
  }
});

test("EXTERNAL_PACKAGES: 只含原生 .node 依赖 @napi-rs/keyring", () => {
  expect(EXTERNAL_PACKAGES).toEqual(["@napi-rs/keyring"]);
});

test("BRIDGE_ASSET_FILES: bridge 三文件都真实存在", () => {
  expect(BRIDGE_ASSET_FILES).toHaveLength(3);
  for (const f of BRIDGE_ASSET_FILES) expect(existsSync(f)).toBe(true);
});

test("stageAssetDir: 三文件平铺到临时目录（文件名无目录层级）", () => {
  const dir = stageAssetDir();
  try {
    const names = readdirSync(dir).sort();
    expect(names).toEqual([
      "file-snapshot.ts",
      "tool-schemas.ts",
      "wa-pi-bridge.extension.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kernelBinaryName: 按平台返回 WaPiKernel(.exe)", () => {
  const name = kernelBinaryName();
  expect(name === "WaPiKernel.exe" || name === "WaPiKernel").toBe(true);
  if (process.platform === "win32") expect(name).toBe("WaPiKernel.exe");
});
