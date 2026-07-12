// 单 exe（--external SDK + default bundle workspace）+ node_modules 文件夹组装构建编排：
//   [0] 测试钩子（typecheck + root suite + kernel HTTP 集成）
//   [1] vite build frontend + 物化嵌入资源（web + traybin）到 src/embedded
//   [2] genicon → 托盘图标
//   [3] 生成 embedded-assets.ts 清单（walk src/embedded 全量：web + traybin + icons）
//   [4] 每目标文件夹组装：单 exe（--external SDK 包，workspace/systray2/fs-extra bundle 进 exe；
//        web/traybin/icons 以 {type:"file"} 嵌入）+ folder package.json + bun install --production
//
// 关键：--external 只外部化 SDK npm 包（pi-coding-agent / pi-intercom / ...），运行时从 exe
// 同级 node_modules 解析（含 SDK 动态 require("pi-intercom/package.json")）。workspace 包
// （@hiagent/kernel、@hiagent/shared）被 bundle 进 exe（bun 能 bundle TS 源，跨包 import
// 在编译期内联）—— 不需要磁盘 node_modules 条目。
// {type:"file"} 资源（web/traybin/icons）正常嵌入 exe 字节，不受 --external 影响。
//
// 产物：dist/desktop/<平台>/HiAgent/ 内含 HiAgent.exe + node_modules/（+ folder package.json/lockfile）。
// 无 launcher.exe / bun.exe / kernel.js / web/ —— kernel 进程内、web 嵌入、exe 即 bun。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, readdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const KERNEL_PKG = join(ROOT, "packages", "kernel");
const FRONTEND_PKG = join(ROOT, "packages", "frontend");
const EMBED = join(PKG, "src", "embedded");
const DIST = join(ROOT, "dist", "desktop");

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

// ---- 步骤 1: vite build + 物化嵌入资源（web + traybin）----

async function step1ViteAndMaterialize() {
  console.log("[build] 步骤1: vite build frontend + 物化 web/traybin 到 src/embedded");
  runOrDie("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  await rm(join(EMBED, "web"), { recursive: true, force: true });
  await rm(join(EMBED, "traybin"), { recursive: true, force: true });
  await cp(join(FRONTEND_PKG, "dist"), join(EMBED, "web"), { recursive: true });
  await mkdir(join(EMBED, "traybin"), { recursive: true });
  const helperDir = join(PKG, "node_modules", "systray2", "traybin");
  for (const f of ["tray_windows_release.exe", "tray_darwin_release", "tray_linux_release"]) {
    await cp(join(helperDir, f), join(EMBED, "traybin", f));
  }
}

// ---- 步骤 2: genicon ----

function step2Genicon() {
  console.log("[build] 步骤2: 生成图标");
  runOrDie("python", ["scripts/genicon.py", join(ROOT, "logo.svg"), join(EMBED, "icons")], PKG);
}

// ---- 步骤 3: 生成 embedded-assets.ts 清单 ----

async function step3Manifest() {
  console.log("[build] 步骤3: 生成 embedded-assets.ts 清单（walk src/embedded 全量）");
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

// ---- 步骤 4: 每目标文件夹组装（单 exe --external SDK + node_modules）----

const TARGET_DIR: Record<string, string> = {
  "bun-windows-x64": "win-x64",
  "bun-darwin-arm64": "mac-arm64",
  "bun-darwin-x64": "mac-x64",
  "bun-linux-x64": "linux-x64",
};

/**
 * 只外部化非 scoped 的扩展包：这些包在运行时被 kernel 的 extensions.ts 通过
 * `require.resolve("pkg/package.json")` 解析（bun 编译产物的 require 只能从磁盘
 * 解析非 scoped 包；scoped 包有 bun#1.3.14 编译二进制解析 bug，不可外部化）。
 *
 * scoped 包（@earendil-works/pi-coding-agent、@amaster.ai/pi-memory）不在此列表 →
 * 被 bundle 进 exe（bun 能 bundle TS 源；动态 import("@earendil-works/...") 由
 * bun 在编译期内联为 bundled 模块引用）。typebox 同理（静态 import，可 bundle）。
 *
 * 扩展包自身的传递依赖（包括 scoped 的，如 pi-lens → @earendil-works/pi-tui）
 * 由 SDK 的 jiti 加载器在运行时从磁盘 node_modules 解析（jiti 用 Node 兼容解析，
 * 不受 bun 编译二进制 scoped 解析 bug 影响）。故 folder node_modules 仍需全量 npm deps。
 */
const EXTERNAL_PACKAGES = [
  "pi-intercom",
  "pi-web-access",
  "pi-lens",
];

async function step4Assemble() {
  const targets = values.target ?? ["bun-windows-x64"];

  // 收集 kernel + desktop 的 npm 运行时依赖（排除 workspace:* —— 它们被 bundle 进 exe）
  const kernelPkg = JSON.parse(await readFile(join(KERNEL_PKG, "package.json"), "utf8"));
  const desktopPkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
  const npmDeps: Record<string, string> = {};
  for (const [name, version] of Object.entries<string>({ ...kernelPkg.dependencies, ...desktopPkg.dependencies })) {
    if (version === "workspace:*") continue;
    npmDeps[name] = version;
  }

  for (const t of targets) {
    const dirName = TARGET_DIR[t] ?? t;
    const folder = join(DIST, dirName, "HiAgent");
    const isWin = t.includes("windows");
    console.log(`[build] 步骤4: 组装 ${t} → ${folder}`);

    // 清理 + 创建目标文件夹
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });

    // 4a. 编译单 exe（--external SDK 包；workspace/systray2/fs-extra 被 bundle；{type:"file"} 资源嵌入）
    const outfile = join(folder, isWin ? "HiAgent.exe" : "HiAgent");
    const externalArgs = EXTERNAL_PACKAGES.flatMap((p) => ["--external", p]);
    runOrDie(
      "bun",
      ["build", join(PKG, "src", "main.ts"), "--compile", ...externalArgs, `--target=${t}`, `--outfile=${outfile}`],
      PKG,
    );

    // 4b. Windows PE 子系统 patch（CONSOLE → GUI）
    if (isWin) {
      console.log("[build] Windows PE 子系统 patch");
      const { patchPeSubsystemToGui } = await import(join(PKG, "src", "util", "pe-subsystem.ts"));
      const r = await patchPeSubsystemToGui(outfile);
      console.log(`[build] subsystem ${r.before} -> ${r.after}`);
    }

    // 4c. folder package.json：列全部 npm 运行时依赖（SDK + systray2 + fs-extra）。
    //     workspace 包不需要（已 bundle 进 exe）。
    const folderPkg = {
      name: "hiagent-desktop-runtime",
      version: "0.0.0",
      type: "module",
      dependencies: npmDeps,
    };
    await writeFile(join(folder, "package.json"), JSON.stringify(folderPkg, null, 2));

    // 4d. bun install --production（folder node_modules）—— SDK + 传递依赖一并落盘
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

    // 4e. 校验外部化的 SDK 扩展包在 node_modules 中存在（运行时从磁盘解析）
    for (const name of EXTERNAL_PACKAGES) {
      const p = join(folder, "node_modules", name, "package.json");
      const ok = await access(p).then(() => true).catch(() => false);
      if (!ok) {
        console.error(`[build] 校验失败：folder node_modules 缺失 ${name}`);
        process.exit(1);
      }
    }
    console.log(`[build] folder node_modules 校验通过（${EXTERNAL_PACKAGES.length} SDK 包）`);
  }
}

// ---- 主编排 ----

(async () => {
  try {
    await step0TestGate();
    await step1ViteAndMaterialize();
    step2Genicon();
    await step3Manifest();
    await step4Assemble();
    console.log("[build] 完成");
  } finally {
    await writeStub(); // 恢复 stub，保持工作区干净
  }
})();
