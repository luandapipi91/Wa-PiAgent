// runtime-deps.cjs 的 seed 同步逻辑测试（bun --compile 单二进制形态）。
// seed = WaPiKernel(.exe) + package.json + bun.lock；不再有 kernel.js / bridge 文件 / patches。
// 覆盖：seed 复制、patches 不再复制（patch 编译期已生效）、kernel.js 时代遗留文件清理。
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSeed } from "../src/util/runtime-deps.cjs";

const noopLog = { info: () => {}, error: () => {} };
const KERNEL_BIN = process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";

async function makeTempDirs() {
  const base = await mkdtemp(join(tmpdir(), "runtime-deps-test-"));
  const seedDir = join(base, "seed");
  const runtimeDir = join(base, "runtime");
  await mkdir(seedDir, { recursive: true });
  return { base, seedDir, runtimeDir };
}

test("syncSeed: 复制新形态 seed（WaPiKernel + package.json + bun.lock）到 runtime", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readFile(join(runtimeDir, KERNEL_BIN), "utf8")).toBe("binary");
    expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe("{}");
    expect(await readFile(join(runtimeDir, "bun.lock"), "utf8")).toBe("{}");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: seed 里的 patches 不再复制（patch 编译期已生效，运行时磁盘无 pi-mcp-adapter）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    await mkdir(join(seedDir, "patches"), { recursive: true });
    await writeFile(join(seedDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "diff --git");

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readdir(runtimeDir)).not.toContain("patches");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: 清理 kernel.js 时代遗留文件（老用户 runtime 目录升级）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    // 模拟老版本 runtime 目录的遗留
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "kernel.js"), "// old bundle");
    await writeFile(join(runtimeDir, "tool-schemas.ts"), "// old");
    await writeFile(join(runtimeDir, "wa-pi-bridge.extension.ts"), "// old");
    await writeFile(join(runtimeDir, "file-snapshot.ts"), "// old");
    await mkdir(join(runtimeDir, "patches"), { recursive: true });
    await writeFile(join(runtimeDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "old");

    await syncSeed(seedDir, runtimeDir, noopLog);

    const files = await readdir(runtimeDir);
    expect(files).not.toContain("kernel.js");
    expect(files).not.toContain("tool-schemas.ts");
    expect(files).not.toContain("wa-pi-bridge.extension.ts");
    expect(files).not.toContain("file-snapshot.ts");
    expect(files).not.toContain("patches");
    expect(files).toContain(KERNEL_BIN);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
