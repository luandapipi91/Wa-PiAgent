// agent-browser 会话隔离与回收。
//
// 每个 wa-pi 会话通过 AGENT_BROWSER_SESSION 映射到独立的 agent-browser daemon/浏览器；
// 会话拆除时主动 close，闲置超时只做兜底（宿主崩溃/强杀）。
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

/** 平台 → 可能的原生包名（linux 先 gnu 后 musl） */
const PLATFORM_PACKAGES: Record<string, string[]> = {
  "darwin-x64": ["@agent-browser/cli-darwin-x64"],
  "darwin-arm64": ["@agent-browser/cli-darwin-arm64"],
  "linux-x64": [
    "@agent-browser/cli-linux-x64-gnu",
    "@agent-browser/cli-linux-x64-musl",
  ],
  "linux-arm64": [
    "@agent-browser/cli-linux-arm64-gnu",
    "@agent-browser/cli-linux-arm64-musl",
  ],
  "win32-x64": ["@agent-browser/cli-win32-x64-msvc"],
};

export interface ResolveBinaryOpts {
  runtimeDir?: string;
  repoRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fileExists?: (path: string) => boolean;
}

/** 会话 id → agent-browser 合法会话名（字母/数字/连字符/下划线） */
export function browserSessionName(sessionId: string): string {
  const name = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return name.length > 0 ? name : "wa-pi";
}

/**
 * 解析平台原生二进制：优先 runtime（打包态首启安装），回退仓库 node_modules（开发态）。
 * 找不到返回 null（内置条目会以占位 command 物化，状态接口报未安装）。
 */
export function resolveAgentBrowserBinary(opts: ResolveBinaryOpts = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const packages = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (!packages) return null;
  const runtimeDir = opts.runtimeDir ?? join(WA_PI_DIR, "runtime");
  const repoRoot = opts.repoRoot ?? process.cwd();
  const exists = opts.fileExists ?? existsSync;
  const bin = platform === "win32" ? "agent-browser.exe" : "agent-browser";
  for (const pkg of packages) {
    for (const root of [runtimeDir, repoRoot]) {
      const candidate = join(root, "node_modules", pkg, "bin", bin);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface CloseSessionOpts {
  /** 测试注入 */
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}

/** 关闭某会话的 agent-browser daemon：fire-and-forget，失败只吞掉，不阻断拆除 */
export async function closeBrowserSession(
  binary: string | null,
  sessionId: string,
  opts: CloseSessionOpts = {},
): Promise<void> {
  if (!binary) return;
  const spawn = opts.spawn ?? nodeSpawn;
  const name = browserSessionName(sessionId);
  try {
    const child = spawn(binary, ["--session", name, "close"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    const timer = setTimeout(() => child.kill?.(), opts.timeoutMs ?? 5_000);
    timer.unref?.();
  } catch {
    // 关闭失败不影响会话拆除
  }
}
