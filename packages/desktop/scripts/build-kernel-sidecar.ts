// 组装 resources/kernel/(bun.exe + kernel.js + node_modules) + resources/web/(前端 dist)。
// 复用 tray-binary P2 的文件夹组装逻辑（解释 kernel sidecar = 已验证形态）。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const RES = join(PKG, "resources");

function run(bin: string, args: string[], cwd = ROOT) {
  console.log(`[sidecar] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`[sidecar] 失败: ${bin}`); process.exit(1); }
}

export async function buildSidecar(target: string) {
  const kernelDir = join(RES, "kernel");
  const webDir = join(RES, "web");
  await rm(RES, { recursive: true, force: true });
  await mkdir(kernelDir, { recursive: true });

  // 1. kernel.js（解释 bundle；--target bun，平台中立，一次构建）
  run("bun", ["build", join(ROOT, "packages", "kernel", "src", "desktop-server.ts"), "--target", "bun", "--outfile", join(kernelDir, "kernel.js")]);

  // 2. node_modules（kernel 生产依赖；排除 workspace，已内联进 kernel.js）
  await writeFile(join(kernelDir, "package.json"), JSON.stringify({
    name: "hiagent-kernel-sidecar", private: true,
    dependencies: {
      "@earendil-works/pi-coding-agent": "^0.80.0", "pi-intercom": "^0.6.0",
      "pi-web-access": "^0.13.0", "pi-lens": "^3.8.0", "@amaster.ai/pi-memory": "^0.1.5",
      typebox: "1.1.38",
    },
  }, null, 2));
  run("bun", ["install", "--production", "--cwd", kernelDir]); // CI 加 BUN_CONFIG_REGISTRY

  // 3. bun 运行时（host 平台复制 process.execPath；非 host 待 wine/跨平台补）
  await cp(process.execPath, join(kernelDir, process.platform === "win32" ? "bun.exe" : "bun"));

  // 4. web（前端 dist）
  run("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  await cp(join(ROOT, "packages", "frontend", "dist"), webDir, { recursive: true });
  console.log("[sidecar] ✅ resources/kernel + resources/web 组装完成");
}
