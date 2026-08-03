// runtime-deps.cjs 的 seed 同步逻辑测试。
// 回归场景：~/.wa-pi/runtime 执行 bun remove 时因缺 patches/ 报
// "Couldn't find patch file" 导致卸载失败（bun 1.3 解析 patchedDependencies 会校验 patch 文件）。
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSeed } from "../src/util/runtime-deps.cjs";

const noopLog = { info: () => {}, error: () => {} };

async function makeTempDirs() {
  const base = await mkdtemp(join(tmpdir(), "runtime-deps-test-"));
  const seedDir = join(base, "seed");
  const runtimeDir = join(base, "runtime");
  await mkdir(seedDir, { recursive: true });
  return { base, seedDir, runtimeDir };
}

test("syncSeed: 复制 seed 文件（含 patches 目录）到 runtime", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    // 模拟 build-kernel-sidecar 产出的 seed：文件 + patches/pi-mcp-adapter@2.17.0.patch
    await writeFile(join(seedDir, "kernel.js"), "// kernel");
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");
    await mkdir(join(seedDir, "patches"), { recursive: true });
    await writeFile(join(seedDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "diff --git a/package.json b/package.json\n");

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readFile(join(runtimeDir, "kernel.js"), "utf8")).toBe("// kernel");
    expect(await readFile(join(runtimeDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "utf8")).toContain("diff --git");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: patches 目录缺失时静默跳过（老 seed / dev 场景）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, "kernel.js"), "// kernel");
    // 不创建 patches 目录
    await syncSeed(seedDir, runtimeDir, noopLog);
    expect(await readdir(runtimeDir)).not.toContain("patches");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: runtime 里已过期的旧 patches 会被整体替换", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    // runtime 里先有旧的（已删除的 pi-coding-agent）patch
    await mkdir(join(runtimeDir, "patches"), { recursive: true });
    await writeFile(join(runtimeDir, "patches", "old@1.0.0.patch"), "old");

    // seed 里只有 pi-mcp-adapter patch
    await mkdir(join(seedDir, "patches"), { recursive: true });
    await writeFile(join(seedDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "new");

    await syncSeed(seedDir, runtimeDir, noopLog);

    const files = await readdir(join(runtimeDir, "patches"));
    expect(files).toEqual(["pi-mcp-adapter@2.17.0.patch"]);
    expect(await readFile(join(runtimeDir, "patches", "pi-mcp-adapter@2.17.0.patch"), "utf8")).toBe("new");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
