// 把 bun --compile 产出的 hiagent-kernel 复制成带 Rust target triple 后缀的副本
// Tauri 2 externalBin + sidecar() 按 {name}-{triple} 解析文件
// triple 映射 Rust host：x86_64-apple-darwin / aarch64-apple-darwin / x86_64-pc-windows-msvc ...
import { copyFileSync, existsSync } from "node:fs";
import { arch, platform } from "node:os";

// Node arch → Rust arch
const ARCH_MAP = { x64: "x86_64", arm64: "aarch64" };
// Node platform → Rust OS + ABI
const PLATFORM_MAP = {
  darwin: (a) => `${a}-apple-darwin`,
  win32: (a) => `${a}-pc-windows-msvc`,
  linux: (a) => `${a}-unknown-linux-gnu`,
};

const rustArch = ARCH_MAP[arch()];
const makeSuffix = PLATFORM_MAP[platform()];
if (!rustArch || !makeSuffix) {
  console.error(`[copy-sidecar] 不支持的平台: ${platform()}/${arch()}`);
  process.exit(1);
}
const triple = makeSuffix(rustArch);

const src = "dist/hiagent-kernel";
const dst = `dist/hiagent-kernel-${triple}`;

if (!existsSync(src)) {
  console.error(`[copy-sidecar] 源文件不存在: ${src}（先跑 bun build --compile）`);
  process.exit(1);
}
copyFileSync(src, dst);
console.log(`[copy-sidecar] ${src} → ${dst} (${triple})`);
