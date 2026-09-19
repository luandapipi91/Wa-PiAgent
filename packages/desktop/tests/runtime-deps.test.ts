// runtime-deps.cjs 的 seed 同步与依赖判定逻辑测试（bun --compile 单二进制形态）。
// seed = package.json + bun.lock（内核二进制不再进 runtime，见下）；不再有 kernel.js / bridge 文件 / patches。
// 覆盖：seed 复制、patches 不再复制（patch 编译期已生效）、kernel.js 时代遗留清理、
//      依赖指纹判定（app 版本变化但依赖未变不重装）。
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
import {
  ensureRuntimeDeps,
  syncSeed,
  computeDepsFingerprint,
  parseInstallMarker,
  shouldSkipInstall,
} from "../src/util/runtime-deps.cjs";

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

test("syncSeed: 复制 package.json + bun.lock（install 与关于页内核版本需要它们）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(seedDir, "bun.lock"), "{}");

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
      '{"version":"1.0.0"}',
    );
    expect(await readFile(join(runtimeDir, "bun.lock"), "utf8")).toBe("{}");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: 不复制内核二进制（spawn 与 bin 链接都用随包 seed 路径，runtime 副本无人读）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "95MB-binary");
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");

    await syncSeed(seedDir, runtimeDir, noopLog);

    // 每次启动白拷 95MB 是启动卡顿的构成之一（写入 + 杀软扫描），且该副本无任何读取方
    expect(await readdir(runtimeDir)).not.toContain(KERNEL_BIN);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: 清掉老版本留在 runtime 的内核二进制副本（回收 ~95MB）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, "package.json"), "{}");
    await writeFile(join(seedDir, "bun.lock"), "{}");
    // 老版本 syncSeed 会把内核二进制拷进 runtime
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, KERNEL_BIN), "old-copy");
    await writeFile(join(runtimeDir, "node_modules"), "");

    await syncSeed(seedDir, runtimeDir, noopLog);

    expect(await readdir(runtimeDir)).not.toContain(KERNEL_BIN);
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

test("syncSeed: runtime 留有旧内核副本（历史动态更新结果）→ 清除（已无读取方，回收 ~95MB）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    // seed 是随包的当前内核清单
    await writeFile(join(seedDir, KERNEL_BIN), "seed-bundled");
    await writeFile(join(seedDir, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(seedDir, "bun.lock"), "{}");
    // runtime 是历史动态更新过的内核 + 旧标记
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, KERNEL_BIN), "runtime-dynamic-old");
    await writeFile(join(runtimeDir, ".kernel-version"), "20260823-1");

    await syncSeed(seedDir, runtimeDir, noopLog);

    // 内核一律以随包 seed 路径运行（spawn/bin 链接都用它），runtime 副本与动态标记一并清理
    expect(await readdir(runtimeDir)).not.toContain(KERNEL_BIN);
    expect(await readdir(runtimeDir)).not.toContain(".kernel-version");
    // 依赖清单仍随包同步（install 与关于页内核版本需要）
    expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
      '{"version":"1.0.0"}',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// 依赖指纹：只认「依赖清单内容」，不认 app 版本号——升级不再白装。
test("computeDepsFingerprint: 同内容同指纹；package.json 或 bun.lock 变化则指纹变", async () => {
  const { base, seedDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, "package.json"), '{"dependencies":{"a":"1"}}');
    await writeFile(join(seedDir, "bun.lock"), "lock-v1");
    const f1 = await computeDepsFingerprint(seedDir);
    expect(await computeDepsFingerprint(seedDir)).toBe(f1);

    await writeFile(join(seedDir, "package.json"), '{"dependencies":{"a":"2"}}');
    const f2 = await computeDepsFingerprint(seedDir);
    expect(f2).not.toBe(f1);

    await writeFile(join(seedDir, "package.json"), '{"dependencies":{"a":"1"}}');
    await writeFile(join(seedDir, "bun.lock"), "lock-v2");
    expect(await computeDepsFingerprint(seedDir)).not.toBe(f1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("computeDepsFingerprint: 清单文件缺失按空内容计入（不抛错，指纹仍稳定）", async () => {
  const { base, seedDir } = await makeTempDirs();
  try {
    const f = await computeDepsFingerprint(seedDir);
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(await computeDepsFingerprint(seedDir)).toBe(f);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("parseInstallMarker: 新格式「版本\t指纹」；旧格式（纯版本号）指纹为空", () => {
  expect(parseInstallMarker("1.2.3\tabc123")).toEqual({
    version: "1.2.3",
    fingerprint: "abc123",
  });
  expect(parseInstallMarker("1.2.3")).toEqual({ version: "1.2.3", fingerprint: "" });
  expect(parseInstallMarker("")).toEqual({ version: "", fingerprint: "" });
});

test("shouldSkipInstall: 指纹一致（app 版本号已变）→ 跳过（升级不再白装依赖）", () => {
  expect(
    shouldSkipInstall({
      nodeModulesExists: true,
      markerText: "0.4.5\tabc123", // 装的时候是 0.4.5，现在是 0.4.7
      fingerprint: "abc123",
    }),
  ).toBe(true);
});

test("shouldSkipInstall: 依赖清单指纹不一致 → 不跳过（依赖真变了必须重装）", () => {
  expect(
    shouldSkipInstall({
      nodeModulesExists: true,
      markerText: "0.4.5\tabc123",
      fingerprint: "def456",
    }),
  ).toBe(false);
});

test("shouldSkipInstall: 旧格式标记（纯版本号）无指纹可比 → 不跳过（迁移一次）", () => {
  expect(
    shouldSkipInstall({
      nodeModulesExists: true,
      markerText: "0.4.5",
      fingerprint: "abc123",
    }),
  ).toBe(false);
});

test("shouldSkipInstall: 无 node_modules / 空标记 → 不跳过", () => {
  expect(
    shouldSkipInstall({
      nodeModulesExists: false,
      markerText: "0.4.5\tabc123",
      fingerprint: "abc123",
    }),
  ).toBe(false);
  expect(
    shouldSkipInstall({
      nodeModulesExists: true,
      markerText: "",
      fingerprint: "abc123",
    }),
  ).toBe(false);
});

// 造一个「依赖已装好、标记为指定内容」的 runtime（install 注入为空实现，真装路径不在此测）
async function makeRuntimeWithMarker(seedDir: string, runtimeDir: string, markerText: string) {
  await writeFile(join(seedDir, "package.json"), '{"dependencies":{}}');
  await writeFile(join(seedDir, "bun.lock"), "lock");
  await mkdir(join(runtimeDir, "node_modules"), { recursive: true });
  await writeFile(join(runtimeDir, ".installed-version"), markerText);
  return computeDepsFingerprint(seedDir);
}

test("ensureRuntimeDeps: app 版本变了但依赖指纹一致 → 跳过 install（本次修复的核心）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    const fp = await makeRuntimeWithMarker(seedDir, runtimeDir, `0.4.5\tPLACEHOLDER`);
    // 用真实指纹改写标记：模拟「0.4.5 时装好依赖，现在 app 已是 0.4.7」
    await writeFile(join(runtimeDir, ".installed-version"), `0.4.5\t${fp}`);

    const logs: string[] = [];
    let installCalls = 0;
    const runDir = await ensureRuntimeDeps({
      isPackaged: true,
      seedDir,
      runtimeDir,
      kernelExe: join(runtimeDir, KERNEL_BIN),
      version: "0.4.7", // 版本号变了
      log: { info: (m: string) => logs.push(m), error: () => {} },
      onStatus: () => {},
      deps: {
        runInstall: async () => {
          installCalls++;
        },
      },
    });

    expect(runDir).toBe(runtimeDir);
    expect(installCalls).toBe(0);
    expect(logs.some((l) => l.includes("跳过 install"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("ensureRuntimeDeps: 依赖指纹变化 → 真装，并把标记写成「版本\t新指纹」", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await makeRuntimeWithMarker(seedDir, runtimeDir, `0.4.7\tstale-old-fingerprint`);

    const logs: string[] = [];
    let installCalls = 0;
    await ensureRuntimeDeps({
      isPackaged: true,
      seedDir,
      runtimeDir,
      kernelExe: join(runtimeDir, KERNEL_BIN),
      version: "0.4.7",
      log: { info: (m: string) => logs.push(m), error: () => {} },
      onStatus: () => {},
      deps: {
        runInstall: async () => {
          installCalls++;
        },
        verifyInstallFn: async () => {}, // 注入安装不做产物校验（真实校验另有测试覆盖）
      },
    });

    expect(installCalls).toBeGreaterThan(0);
    const fp = await computeDepsFingerprint(runtimeDir);
    expect(await readFile(join(runtimeDir, ".installed-version"), "utf8")).toBe(
      `0.4.7\t${fp}`,
    );
    expect(logs.some((l) => l.includes("需要安装依赖"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("ensureRuntimeDeps: 旧格式标记（纯版本号）→ 迁移重装一次，之后转为指纹标记", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await makeRuntimeWithMarker(seedDir, runtimeDir, `0.4.7`);

    const logs: string[] = [];
    let installCalls = 0;
    await ensureRuntimeDeps({
      isPackaged: true,
      seedDir,
      runtimeDir,
      kernelExe: join(runtimeDir, KERNEL_BIN),
      version: "0.4.7",
      log: { info: (m: string) => logs.push(m), error: () => {} },
      onStatus: () => {},
      deps: {
        runInstall: async () => {
          installCalls++;
        },
        verifyInstallFn: async () => {},
      },
    });

    expect(installCalls).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("旧格式标记"))).toBe(true);
    const fp = await computeDepsFingerprint(runtimeDir);
    expect(await readFile(join(runtimeDir, ".installed-version"), "utf8")).toBe(
      `0.4.7\t${fp}`,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("syncSeed: 清理历史遗留文件（kernel.js 时代 + 已移除的动态内核标记 + 内核副本）", async () => {
  const { base, seedDir, runtimeDir } = await makeTempDirs();
  try {
    await writeFile(join(seedDir, KERNEL_BIN), "binary");
    await writeFile(join(seedDir, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(seedDir, "bun.lock"), "lock");
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
    // 内核二进制不进 runtime（spawn/bin 链接用随包 seed 路径）；依赖清单仍然随包同步
    expect(files).not.toContain(KERNEL_BIN);
    expect(files).toContain("package.json");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

