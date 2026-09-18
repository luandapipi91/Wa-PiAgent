// runtime-deps.cjs 的 seed 同步逻辑测试（bun --compile 单二进制形态）。
// seed = WaPiKernel(.exe) + package.json + bun.lock；不再有 kernel.js / bridge 文件 / patches。
// 覆盖：seed 复制、patches 不再复制（patch 编译期已生效）、kernel.js 时代遗留文件清理。
import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRuntimeDeps, syncSeed } from "../src/util/runtime-deps.cjs";

const noopLog = { info: () => {}, error: () => {} };
const KERNEL_BIN =
  process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";

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
    await writeFile(
      join(seedDir, "patches", "pi-mcp-adapter@2.17.0.patch"),
      "diff --git",
    );

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readdir(runtimeDir)).not.toContain("patches");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: runtime 留有旧内核（历史动态更新结果）→ 被随包 seed 覆盖（回退为包内内核）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    // seed 是随包的当前内核
    await writeFile(join(seedDir, KERNEL_BIN), "seed-bundled");
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");
    // runtime 是历史动态更新过的内核 + 旧标记
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, KERNEL_BIN), "runtime-dynamic-old");
    await writeFile(join(runtimeDir, ".kernel-version"), "20260823-1");

    await syncSeed(seedDir, runtimeDir, noopLog);

    // 内核回退为随包版本，动态标记被清理
    expect(await readFile(join(runtimeDir, KERNEL_BIN), "utf8")).toBe(
      "seed-bundled",
    );
    expect(await readdir(runtimeDir)).not.toContain(".kernel-version");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("ensureRuntimeDeps: .installed-version 与 app 版本一致 → 跳过 install（内核随包不参与判定）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    // seed 三件套
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");
    // runtime 已有 node_modules + 装好的标记（按 app 版本）
    await mkdir(join(runtimeDir, "node_modules"), { recursive: true });
    await writeFile(join(runtimeDir, "package.json"), "{}");
    await writeFile(join(runtimeDir, ".installed-version"), "1.0.0");
    const logs: string[] = [];
    const log = {
      info: (...a: string[]) => logs.push(a.join(" ")),
      error: () => {},
    };

    const runDir = await ensureRuntimeDeps({
      isPackaged: true,
      seedDir,
      runtimeDir,
      kernelExe: join(runtimeDir, KERNEL_BIN),
      version: "1.0.0", // app 版本 == 已装标记 → 跳过 install
      log,
      onStatus: () => {},
    });

    expect(runDir).toBe(runtimeDir);
    expect(
      logs.some((l) =>
        l.includes("node_modules 已安装 v1.0.0，跳过 install"),
      ),
    ).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: 清理历史遗留文件（kernel.js 时代 + 已移除的动态内核标记）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    // 模拟老版本 runtime 目录的遗留
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "kernel.js"), "// old bundle");
    await writeFile(join(runtimeDir, ".kernel-version"), "20260823-1");
    await writeFile(join(runtimeDir, "tool-schemas.ts"), "// old");
    await writeFile(join(runtimeDir, "wa-pi-bridge.extension.ts"), "// old");
    await writeFile(join(runtimeDir, "file-snapshot.ts"), "// old");
    await mkdir(join(runtimeDir, "patches"), { recursive: true });
    await writeFile(
      join(runtimeDir, "patches", "pi-mcp-adapter@2.17.0.patch"),
      "old",
    );

    await syncSeed(seedDir, runtimeDir, noopLog);

    const files = await readdir(runtimeDir);
    expect(files).not.toContain("kernel.js");
    expect(files).not.toContain("tool-schemas.ts");
    expect(files).not.toContain("wa-pi-bridge.extension.ts");
    expect(files).not.toContain("file-snapshot.ts");
    expect(files).not.toContain("patches");
    expect(files).not.toContain(".kernel-version");
    expect(files).toContain(KERNEL_BIN);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

