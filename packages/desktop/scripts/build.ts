// 构建编排：[0]测试钩子 → [1]build-kernel-sidecar(组装 resources/) → [2]electron-builder 出 portable/AppImage。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildSidecar } from "./build-kernel-sidecar";

// 固化国内镜像：electron-builder 默认从 GitHub 下载 Electron 二进制 / winCodeSign / nsis，
// 国内直连 20.205.243.166(GitHub) 经常 ETIMEDOUT，导致打包 hang 住数分钟。
// 用 npmmirror 镜像避免联网超时；这些 env 必须在 spawn electron-builder 之前设置，
// run() 调用 spawnSync 时会继承当前 process.env。
process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://npmmirror.com/mirrors/electron-builder-binaries/";

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
function run(bin: string, args: string[], cwd = PKG) {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  // 必须显式传 env：Bun(Windows) 的 spawnSync 不继承进程启动后新设置的 process.env
  // （实测 cmd /c echo %VAR% 打印字面量），上面 ??= 设置的镜像变量会到不了 electron-builder，
  // 导致其回退 GitHub 下载 Electron 二进制并 ETIMEDOUT。
  // bun 用 process.execPath（真实 bun 可执行文件）：Windows 下 PATH 解析受 shell 环境
  // 影响（MSYS/宿主环境 PATH 可能不含 bun 目录，spawnSync("bun", shell:true) 报
  // "The system cannot find the path specified"），直接传完整路径规避（与
  // build-kernel-sidecar.ts 的 run 同款处理）。
  const resolvedBin = bin === "bun" ? process.execPath : bin;
  const r = spawnSync(resolvedBin, args, { cwd, stdio: "inherit", shell: false, env: { ...process.env } });
  if (r.status !== 0) { console.error(`[build] 失败: ${bin}`); process.exit(1); }
}

async function step0TestGate(noTest: boolean) {
  if (noTest) { console.log("[build] 跳过测试钩子(--no-test)"); return; }
  console.log("[build] 步骤0: 测试钩子");
  run("bun", ["run", "typecheck"], ROOT);
  run("bun", ["run", "test"], ROOT);
}

(async () => {
  const { values } = parseArgs({ options: { target: { type: "string" }, "no-test": { type: "boolean" } } });
  const target = values.target ?? "win";
  await step0TestGate(!!values["no-test"]);
  console.log("[build] 步骤1: 组装 kernel sidecar + web");
  // electron-builder 用 --mac；sidecar 平台名为 darwin
  const sidecarTarget = target === "mac" ? "darwin" : target;
  await buildSidecar(sidecarTarget);
  // macOS：用 iconutil 预生成标准 .icns（避免 electron-builder 内置转换产生 JPEG-2000 花屏图标）
  if (target === "mac") run("bash", [join(import.meta.dir, "generate-icons.sh")]);
  console.log(`[build] 步骤2: electron-builder 出 ${target}`);
  // --bun：electron-builder 依赖 stream/promises（Node 15+），系统 node v14 没有；
  // 强制 bun runtime 执行（与前端 vite --bun 同理）。env 镜像变量已在上方 process.env 设置，
  // bun 子进程继承，electron-builder 仍能走 npmmirror 镜像。
  run("bun", ["--bun", "x", "electron-builder", `--${target}`]);
  console.log("[build] ✅ 完成 → packages/desktop/release/");
})();
