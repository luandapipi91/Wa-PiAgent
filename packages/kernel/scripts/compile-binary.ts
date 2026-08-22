// kernel 单二进制编译：bun build --compile 把 desktop-server.ts 连同全部依赖
// （含已 patch 的 pi-mcp-adapter）内联进原生可执行文件；--asset 把 bridge 三文件
// 嵌入到产物 import.meta.dir/assets/（bridge-extension.ts 运行时读取）。
// 只有原生 .node 依赖（@napi-rs/keyring）external——无法内联进虚拟 FS。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const KERNEL_SRC = join(import.meta.dir, "..", "src");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** bridge 扩展三文件：--asset 嵌入源（bridge-extension.ts 从 assets/ 读取后部署到 GENERATED_DIR） */
export const BRIDGE_ASSET_FILES = [
  join(KERNEL_SRC, "wa-pi-bridge.extension.ts"),
  join(KERNEL_SRC, "file-snapshot.ts"),
  join(REPO_ROOT, "packages", "shared", "src", "tool-schemas.ts"),
];

/** 必须 external 的包：原生 .node 依赖无法内联进虚拟 FS，运行时从磁盘 node_modules 加载 */
export const EXTERNAL_PACKAGES = ["@napi-rs/keyring"];

/** 编译产物文件名（分发进程名不暴露 bun；替代旧 wa-pi-kernel 命名） */
export function kernelBinaryName(): string {
  return process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";
}

/** bun build --compile 参数（纯函数，便于测试断言） */
export function buildCompileArgs(outfile: string, assetDir: string): string[] {
  return [
    "build",
    join(KERNEL_SRC, "desktop-server.ts"),
    "--compile",
    ...EXTERNAL_PACKAGES.flatMap((p) => ["--external", p]),
    "--asset",
    assetDir,
    "--outfile",
    outfile,
  ];
}

/** 把 bridge 三文件平铺到临时目录作为 --asset 嵌入源；调用方负责 rm */
export function stageAssetDir(): string {
  // bun 1.4.0 --asset 把「目录名」挂到虚拟根：--asset ./assets → 产物 B:\~BUN\root\assets\。
  // bridge-extension.ts 固定读 __dirname/assets/，故嵌入目录必须字面叫 assets——
  // 先 mkdtemp 拿唯一父目录，再在其下建 assets/ 子目录（避免 tmp 下多实例撞名）。
  const parent = mkdtempSync(join(tmpdir(), "wa-pi-kernel-assets-"));
  const dir = join(parent, "assets");
  mkdirSync(dir);
  for (const f of BRIDGE_ASSET_FILES) cpSync(f, join(dir, basename(f)));
  return dir;
}

/** 编译 kernel 单二进制到 outfile。用 process.execPath（真实 bun，≥1.4.0）避免 .cmd shim 问题。 */
export function compileKernelBinary(outfile: string): void {
  const assetDir = stageAssetDir();
  try {
    const args = buildCompileArgs(outfile, assetDir);
    console.log(`[compile] $ bun ${args.join(" ")}`);
    const r = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`bun build --compile 失败 (exit=${r.status})`);
    console.log(`[compile] ✅ ${outfile}`);
  } finally {
    rmSync(assetDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  compileKernelBinary(join(import.meta.dir, "..", "dist", kernelBinaryName()));
}
