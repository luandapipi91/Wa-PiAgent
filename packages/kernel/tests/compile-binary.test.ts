// compile-binary.ts 纯函数测试：编译参数、asset 暂存、平台二进制名。
// 不真的跑 bun build --compile（那是 Task 6 集成测试的职责）。
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readdirSync, rmSync } from "node:fs";
import {
  buildCompileArgs,
  stageAssetDir,
  EXTERNAL_PACKAGES,
  KERNEL_ASSET_FILES,
  kernelBinaryName,
} from "../scripts/compile-binary";
import { basename, join } from "node:path";

test("buildCompileArgs: 入口是 desktop-server.ts，含 --compile/--external/--asset/--outfile", () => {
  const args = buildCompileArgs("/tmp/out/WaPiKernel.exe", "/tmp/assets");
  expect(args[0]).toBe("build");
  expect(
    args[1]
      .replace(/\\/g, "/")
      .endsWith("packages/kernel/src/desktop-server.ts"),
  ).toBe(true);
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

test("buildCompileArgs: target=win 追加 --target bun-windows-x64（交叉编译）", () => {
  const args = buildCompileArgs(
    "/tmp/out/WaPiKernel.exe",
    "/tmp/assets",
    "win",
  );
  expect(args).toContain("--target");
  expect(args[args.indexOf("--target") + 1]).toBe("bun-windows-x64");
  expect(buildCompileArgs("/tmp/out/k", "/tmp/assets", "linux")).toContain(
    "bun-linux-x64",
  );
  // darwin：本机编译不追加 --target
  const darwin = buildCompileArgs("/tmp/out/k", "/tmp/assets", "darwin");
  expect(darwin).not.toContain("--target");
});

test("EXTERNAL_PACKAGES: 只含原生 .node 依赖 @napi-rs/keyring", () => {
  expect(EXTERNAL_PACKAGES).toEqual(["@napi-rs/keyring"]);
});

test("KERNEL_ASSET_FILES: 全部资产真实存在且包含 preview-inspect.js", () => {
  // preview-inspect.js 必须嵌入（ws-server /preview-inspect.js 路由用 new URL(..., import.meta.url)
  // 读取，bun --compile 不会自动打包该引用，漏加则打包版元素选中/高亮失效——回归护栏）。
  const names = KERNEL_ASSET_FILES.map((f) => basename(f));
  expect(names).toContain("preview-inspect.js");
  expect(KERNEL_ASSET_FILES).toHaveLength(4);
  for (const f of KERNEL_ASSET_FILES) expect(existsSync(f)).toBe(true);
});

test("stageAssetDir: 返回字面 assets 目录（bun 1.4.0 --asset 按目录名挂载）且资产平铺", () => {
  const dir = stageAssetDir();
  try {
    // bun --compile --asset 把目录名挂到虚拟根：--asset ./assets → 产物 B:\~BUN\root\assets\。
    // bridge-extension.ts 固定读 __dirname/assets/，故嵌入目录必须字面叫 assets。
    expect(basename(dir)).toBe("assets");
    const expected = [
      "file-snapshot.ts",
      "preview-inspect.js",
      "tool-schemas.ts",
      "wa-pi-bridge.extension.ts",
    ].sort();
    expect(readdirSync(dir).sort()).toEqual(expected);
  } finally {
    // 清理唯一父目录（assets 子目录 + 父目录一并移除，避免 tmp 泄漏）
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("kernelBinaryName: 按平台返回 WaPiKernel(.exe)", () => {
  const name = kernelBinaryName();
  expect(name === "WaPiKernel.exe" || name === "WaPiKernel").toBe(true);
  if (process.platform === "win32") expect(name).toBe("WaPiKernel.exe");
  // 显式 target 时按目标平台命名（交叉编译场景）
  expect(kernelBinaryName("win")).toBe("WaPiKernel.exe");
  expect(kernelBinaryName("darwin")).toBe("WaPiKernel");
  expect(kernelBinaryName("linux")).toBe("WaPiKernel");
});
