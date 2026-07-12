// P2 文件夹组装构建编排：
//   [0] 测试钩子（typecheck + root suite + kernel HTTP 集成）
//   [1] vite build frontend
//   [2] genicon → launcher 托盘图标
//   [3] 物化 launcher 嵌入资源（traybin + icons）→ 生成 embedded-assets.ts 清单
//   [4] 构建 kernel.js（platform-neutral，一次构建，所有目标共用）
//   [5] 每目标文件夹组装：launcher exe / bun.exe / kernel.js / node_modules / web
//
// P2 与 P1 的核心区别：产物从单 exe 变为 FOLDER（launcher exe + bun 解释运行的 kernel + 磁盘 node_modules）。
// launcher 仍嵌入自己的 tray icon + systray helper（EMBEDDED_ASSETS），但 kernel/web 不再嵌入——
// 它们作为 launcher exe 的同级文件存在，让 SDK 的动态 require.resolve / import.meta.resolve 正常工作。
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const KERNEL_PKG = join(ROOT, "packages", "kernel");
const FRONTEND_PKG = join(ROOT, "packages", "frontend");
const EMBED = join(PKG, "src", "embedded");
const DIST = join(ROOT, "dist", "desktop");
const KERNEL_STAGING = join(DIST, ".kernel-staging");

const STUB_PATH = join(PKG, "src", "embedded-assets.ts");
const STUB_CONTENT = `// 本文件由 packages/desktop/scripts/build.ts 在打包时临时重新生成为嵌入资源清单\n// （各 \`import aN from "./embedded/..." with { type: "file" }\`）。此空 stub 是入库基线。\nexport const EMBEDDED_ASSETS: { src: string; dest: string }[] = [];\n`;
function writeStub(): Promise<void> { return writeFile(STUB_PATH, STUB_CONTENT); }

const { values } = parseArgs({
  options: {
    target: { type: "string", multiple: true },
    "no-test": { type: "boolean" },
  },
});

// ---- 命令执行 ----

function run(
  bin: string,
  args: string[],
  cwd = ROOT,
  env: Record<string, string> = {},
): number {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  return r.status ?? 1;
}

function runOrDie(
  bin: string,
  args: string[],
  cwd = ROOT,
  env: Record<string, string> = {},
): void {
  if (run(bin, args, cwd, env) !== 0) {
    console.error(`[build] 失败: ${bin} ${args.join(" ")}`);
    process.exit(1);
  }
}

// ---- 步骤 0: 测试钩子 ----

async function step0TestGate() {
  if (values["no-test"]) { console.log("[build] 跳过测试钩子(--no-test)"); return; }
  console.log("[build] 步骤0: 打包前测试钩子");
  await writeStub();
  runOrDie("bun", ["run", "typecheck"]);
  runOrDie("bun", ["run", "test"]);
  runOrDie("bun", ["test", "tests/static-serve.integration.test.ts"], join(ROOT, "packages", "kernel"));
}

// ---- 步骤 1: vite build + 清理 embedded ----

async function step1ViteBuild() {
  console.log("[build] 步骤1: vite build frontend + 清理 embedded/");
  runOrDie("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  // 清理 embedded/（P1 残留的 web/ 等不再需要）；genicon 和 traybin 物化在后续步骤重建。
  await rm(EMBED, { recursive: true, force: true });
  await mkdir(EMBED, { recursive: true });
}

// ---- 步骤 2: genicon ----

function step2Genicon() {
  console.log("[build] 步骤2: 生成图标");
  runOrDie("python", ["scripts/genicon.py", join(ROOT, "logo.svg"), join(EMBED, "icons")], PKG);
}

// ---- 步骤 3: 物化 launcher 嵌入资源（traybin + icons）+ 生成清单 ----

async function step3MaterializeAndManifest() {
  console.log("[build] 步骤3: 物化 traybin + 生成 embedded-assets.ts 清单");
  // traybin: systray2 helper（launcher 运行时解压到 ~/.hiagent/.cache/traybin/ 供 systray2 用）
  await mkdir(join(EMBED, "traybin"), { recursive: true });
  const helperDir = join(PKG, "node_modules", "systray2", "traybin");
  for (const f of ["tray_windows_release.exe", "tray_darwin_release", "tray_linux_release"]) {
    await cp(join(helperDir, f), join(EMBED, "traybin", f));
  }

  // 生成 embedded-assets.ts：walk src/embedded 全量（traybin + icons，不含 web）
  const files: string[] = [];
  for await (const p of walk(EMBED)) files.push(p);
  const rel = (p: string) => "./embedded/" + p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const dest = (p: string) => p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const imports = files.map((p, i) => `import a${i} from ${JSON.stringify(rel(p))} with { type: "file" };`).join("\n");
  const arr = `export const EMBEDDED_ASSETS = [\n${files.map((p, i) => `  { src: a${i}, dest: ${JSON.stringify(dest(p))} }`).join(",\n")}\n];`;
  await writeFile(STUB_PATH, `// @ts-nocheck\n${imports}\n\n${arr}\n`);
  console.log(`[build] 嵌入清单 ${files.length} 项`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ---- 步骤 4: 构建 kernel.js（一次构建，所有目标共用）----

function step4BuildKernel() {
  console.log("[build] 步骤4: 构建 kernel.js (platform-neutral, --target bun)");
  // --target bun = 打包成 bun 解释执行的 JS（非 compile）；静态依赖内联进 kernel.js，
  // 运行时动态 require.resolve / import.meta.resolve 从同级 node_modules 解析。
  runOrDie(
    "bun",
    ["build", "src/desktop-server.ts", "--target", "bun", "--outfile", join(KERNEL_STAGING, "kernel.js")],
    KERNEL_PKG,
  );
}

// ---- 步骤 5: 文件夹组装 ----

const TARGET_DIR: Record<string, string> = {
  "bun-windows-x64": "win-x64",
  "bun-darwin-arm64": "mac-arm64",
  "bun-darwin-x64": "mac-x64",
  "bun-linux-x64": "linux-x64",
};

async function step5Assemble() {
  const targets = values.target ?? ["bun-windows-x64"];

  // 提取 kernel npm 运行时依赖（排除 workspace:* — @hiagent/kernel / @hiagent/shared 已内联进 kernel.js）
  const kernelPkg = JSON.parse(await readFile(join(KERNEL_PKG, "package.json"), "utf8"));
  const deps: Record<string, string> = {};
  for (const [name, version] of Object.entries<string>(kernelPkg.dependencies)) {
    if (version === "workspace:*") continue;
    deps[name] = version;
  }

  for (const t of targets) {
    const dirName = TARGET_DIR[t] ?? t;
    const folder = join(DIST, dirName, "HiAgent");
    const isWin = t.includes("windows");
    console.log(`[build] 步骤5: 组装 ${t} → ${folder}`);

    // 清理 + 创建目标文件夹
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });

    // 5a. 编译 launcher
    const outfile = join(folder, isWin ? "HiAgent.exe" : "HiAgent");
    runOrDie(
      "bun",
      ["build", join(PKG, "src", "main.ts"), "--compile", `--target=${t}`, `--outfile=${outfile}`],
      PKG,
    );

    // 5b. Windows PE 子系统 patch（CONSOLE → GUI）
    if (isWin) {
      console.log("[build] Windows PE 子系统 patch");
      const { patchPeSubsystemToGui } = await import(join(PKG, "src", "util", "pe-subsystem.ts"));
      const r = await patchPeSubsystemToGui(outfile);
      console.log(`[build] subsystem ${r.before} -> ${r.after}`);
    }

    // 5c. bun.exe：HOST 平台直接复制 process.execPath（win-on-win）
    const bunExeName = isWin ? "bun.exe" : "bun";
    if ((isWin && process.platform === "win32") || (!isWin && process.platform !== "win32")) {
      await copyFile(process.execPath, join(folder, bunExeName));
      console.log(`[build] 复制 host bun → ${bunExeName}`);
    } else {
      // TODO(follow-up): 非 HOST 平台需从 github releases 拉取对应 bun runtime
      console.log(`[build] TODO: ${t} 非 HOST 平台，需从 github releases 拉取 bun（暂跳过）`);
    }

    // 5d. kernel.js（从 staging 复制，所有目标共用同一份）
    await copyFile(join(KERNEL_STAGING, "kernel.js"), join(folder, "kernel.js"));
    console.log("[build] 复制 kernel.js");

    // 5e. node_modules：写 package.json + bun install --production
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name: "hiagent-desktop", version: "0.0.0", type: "module", dependencies: deps }, null, 2),
    );
    console.log("[build] bun install --production（folder node_modules）");
    const installEnv = { BUN_CONFIG_REGISTRY: "https://registry.npmjs.org/" };
    let installCode = run("bun", ["install", "--production", "--cwd", folder], ROOT, installEnv);
    if (installCode !== 0) {
      // EPERM workaround（Windows 大包/原生包本地缓存隔离）
      console.log("[build] bun install 失败，使用本地缓存隔离重试");
      const cacheDir = join(folder, ".bun-cache");
      installCode = run("bun", ["install", "--production", "--cwd", folder], ROOT, {
        ...installEnv,
        BUN_INSTALL_CACHE_DIR: cacheDir,
      });
      await rm(cacheDir, { recursive: true, force: true });
    }
    if (installCode !== 0) {
      console.error("[build] bun install 最终失败");
      process.exit(1);
    }

    // 5f. web/（前端 dist 复制为同级 web/）
    await cp(join(FRONTEND_PKG, "dist"), join(folder, "web"), { recursive: true });
    console.log("[build] 复制 web/");
  }
}

// ---- 主编排 ----

(async () => {
  try {
    await step0TestGate();
    await step1ViteBuild();
    step2Genicon();
    await step3MaterializeAndManifest();
    step4BuildKernel();
    await step5Assemble();
    console.log("[build] 完成");
  } finally {
    await writeStub(); // 恢复 stub，保持工作区干净
  }
})();
