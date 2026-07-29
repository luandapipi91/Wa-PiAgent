// 构建编排：[0]测试钩子 → [1]build-kernel-sidecar(组装 resources/) → [2]electron-builder 出 portable/AppImage。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildSidecar } from "./build-kernel-sidecar";

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
function run(bin: string, args: string[], cwd = PKG) {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
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
  run("npx", ["electron-builder", `--${target}`]);
  console.log("[build] ✅ 完成 → packages/desktop/release/");
})();
