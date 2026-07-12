// 构建编排：[0]测试钩子 → [1]vite build + 物化 dist/helper 到 src/embedded → [2]genicon → [3]生成嵌入清单(walk src/embedded) → [4]每目标 bun build --compile → [5]Windows PE patch。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const EMBED = join(PKG, "src", "embedded");
const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, "no-test": { type: "boolean" } } });

function run(bin: string, args: string[], cwd = ROOT) {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`[build] 失败: ${bin}`); process.exit(1); }
}

async function step0TestGate() {
  if (values["no-test"]) { console.log("[build] 跳过测试钩子(--no-test)"); return; }
  console.log("[build] 步骤0: 打包前测试钩子");
  run("bun", ["run", "typecheck"]);
  run("bun", ["run", "test"]);   // 根脚本已排除 e2e
}

async function step1Materialize() {
  console.log("[build] 步骤1: vite build + 物化 dist/helper 到 src/embedded");
  run("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  await rm(join(EMBED, "web"), { recursive: true, force: true });
  await rm(join(EMBED, "traybin"), { recursive: true, force: true });
  await cp(join(ROOT, "packages", "frontend", "dist"), join(EMBED, "web"), { recursive: true });
  await mkdir(join(EMBED, "traybin"), { recursive: true });
  const helperDir = join(PKG, "node_modules", "systray2", "traybin");
  for (const f of ["tray_windows_release.exe", "tray_darwin_release", "tray_linux_release"]) {
    await cp(join(helperDir, f), join(EMBED, "traybin", f));
  }
}

function step2Genicon() {
  console.log("[build] 步骤2: 生成图标");
  run("python", ["scripts/genicon.py", join(ROOT, "logo.svg"), join(EMBED, "icons")], PKG);
}

async function step3Manifest() {
  console.log("[build] 步骤3: 生成 embedded-assets.ts 清单（walk src/embedded 全量）");
  const files: string[] = [];
  for await (const p of walk(EMBED)) files.push(p);
  // main.ts 在 src/，import 路径相对 src/：./embedded/<rel>；dest 相对 src/embedded/。
  const rel = (p: string) => "./embedded/" + p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const dest = (p: string) => p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const imports = files.map((p, i) => `import a${i} from ${JSON.stringify(rel(p))} with { type: "file" };`).join("\n");
  const arr = `export const EMBEDDED_ASSETS = [\n${files.map((p, i) => `  { src: a${i}, dest: ${JSON.stringify(dest(p))} }`).join(",\n")}\n];`;
  await writeFile(join(PKG, "src", "embedded-assets.ts"), `${imports}\n\n${arr}\n`);
  console.log(`[build] 清单 ${files.length} 项`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// Bun target → 干净目录名；产物落 repo 根 dist/desktop/<name>/（根 .gitignore 的 dist/ 已排除）。
const TARGET_DIR: Record<string, string> = {
  "bun-windows-x64": "win-x64",
  "bun-darwin-arm64": "mac-arm64",
  "bun-darwin-x64": "mac-x64",
  "bun-linux-x64": "linux-x64",
};
function targetInfo(t: string): { outDir: string; outfile: string; isWin: boolean } {
  const outDir = join(ROOT, "dist", "desktop", TARGET_DIR[t] ?? t);
  return { outDir, outfile: join(outDir, t.includes("windows") ? "HiAgent.exe" : "HiAgent"), isWin: t.includes("windows") };
}

async function step4Compile() {
  const targets = values.target ?? ["bun-windows-x64"];
  for (const t of targets) {
    console.log(`[build] 步骤4: 编译 ${t}`);
    const { outDir, outfile, isWin } = targetInfo(t);
    await mkdir(outDir, { recursive: true });
    run("bun", ["build", join(PKG, "src", "main.ts"), "--compile", `--target=${t}`, `--outfile=${outfile}`], PKG);
    if (isWin) {
      console.log("[build] 步骤5: Windows PE 子系统 patch");
      const { patchPeSubsystemToGui } = await import(join(PKG, "src", "util", "pe-subsystem.ts"));
      const r = await patchPeSubsystemToGui(outfile);
      console.log(`[build] subsystem ${r.before} -> ${r.after}`);
    }
  }
}

(async () => {
  await step0TestGate();
  await step1Materialize();
  step2Genicon();
  await step3Manifest();
  await step4Compile();
  console.log("[build] ✅ 完成");
})();
