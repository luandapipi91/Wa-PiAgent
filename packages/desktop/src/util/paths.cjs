// 解析 kernel sidecar 与 web 目录：packaged 走 resourcesPath，dev 走 env 或 repo 默认。
const path = require("node:path");

function devRepoRoot() {
  // dev 下从 CWD 找 repo 根（含 packages/kernel）
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (require("node:fs").existsSync(path.join(dir, "packages", "kernel"))) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveKernelDir(isPackaged, resourcesPath, env) {
  if (!isPackaged && env.HIAGENT_KERNEL_DIR) return env.HIAGENT_KERNEL_DIR;
  if (isPackaged) return path.join(resourcesPath, "kernel");
  return path.join(devRepoRoot(), "packages", "kernel"); // dev: 解释跑 kernel 源码
}

function resolveWebDir(isPackaged, resourcesPath, env) {
  if (!isPackaged && env.HIAGENT_WEB_DIR) return env.HIAGENT_WEB_DIR;
  if (isPackaged) return path.join(resourcesPath, "web");
  return path.join(devRepoRoot(), "packages", "frontend", "dist");
}

// runtime 目录：用户可写（~/.hiagent/runtime）。packaged 下首启在此动态安装 node_modules（原生 addon）并跑 kernel.js。
// .app 内 Resources/kernel 是只读 seed，无法就地 install，故复制 seed 到 runtime 再装。
function resolveRuntimeDir(hiagentDir) {
  return path.join(hiagentDir, "runtime");
}

module.exports = { resolveKernelDir, resolveWebDir, resolveRuntimeDir };
