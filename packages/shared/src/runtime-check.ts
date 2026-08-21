// 运行时环境检查：Bun 版本强制 ≥ 1.4.0。
// 背景：代码已升级到 bun 1.4.0 并依赖其行为——scheduler.ts 的 Bun.cron
// 自 1.4 起按系统本地时区解析（1.3.x 固定 UTC，dev 用 1.3.x 时定时任务静默错 8 小时）；
// crash-logger 移除 bun#25633 autoSelectFamily 白名单需 1.3.15+（1.4 已修复）。
// 纯函数 + 文案生成放 shared：dev.ts（bun 进程）与 kernel（bun 进程）共用，
// 浏览器 bundle 中不会被调用（且 typeof Bun 保护）。

export interface BunVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 最低要求：1.4.0（Bun.cron 本地时区行为的起点） */
export const MIN_BUN_VERSION: BunVersion = { major: 1, minor: 4, patch: 0 };

/**
 * 解析 Bun.version 字符串为可比较的三段版本号。
 * Bun.version 形如 "1.4.0"；canary 形如 "1.2.3-canary.0"（剥离 - 后缀取主三段）；
 * 缺失段（如 "1.2"）补 0；非数字段按 0 容错。
 */
export function parseBunVersion(version: string): BunVersion {
  const [major = 0, minor = 0, patch = 0] = version
    .split("-")[0]
    .split(".")
    .map((p) => parseInt(p, 10) || 0);
  return { major, minor, patch };
}

/** 版本是否 ≥ 最低要求（逐段比较） */
export function isBunAtLeast(
  version: string,
  min: BunVersion = MIN_BUN_VERSION,
): boolean {
  const v = parseBunVersion(version);
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** 当前进程的 Bun 版本；非 bun 运行时（Node/Electron/浏览器）返回 null */
export function currentBunVersion(): string | null {
  return typeof Bun !== "undefined" && typeof Bun.version === "string"
    ? Bun.version
    : null;
}

/** 检查当前运行时是否满足 Bun ≥ 1.4.0（不退出进程，由调用方决定行为） */
export function checkBunVersion(): { ok: boolean; version: string | null } {
  const version = currentBunVersion();
  if (version == null) return { ok: false, version: null };
  return { ok: isBunAtLeast(version), version };
}

/** 生成中文错误文案（纯函数，调用方负责打印 + 退出） */
export function bunVersionCheckMessage(version: string | null): string {
  const got = version ?? "未知（非 Bun 运行时）";
  return [
    `[env] Bun 版本不满足要求：当前 ${got}，需要 ≥ 1.4.0`,
    `[env] 当前代码依赖 Bun ≥ 1.4.0 的行为：`,
    `[env]   - Bun.cron 按系统本地时区解析（1.3.x 固定 UTC，定时任务会静默错 8 小时）`,
    `[env]   - 修复 bun#25633 autoSelectFamily 竞态（需 1.3.15+，1.4.0 已修复）`,
    `[env] 请升级 Bun 后重试：`,
    `[env]   - 已用 npm 安装（Windows）：npm install -g bun@latest`,
    `[env]   - 其他方式：bun upgrade  或  curl -fsSL https://bun.sh/install | bash`,
  ].join("\n");
}

/**
 * 版本不满足时打印中文错误并 process.exit(1)。
 * 供启动入口（dev.ts / kernel startKernel）调用；version 参数仅测试注入用。
 */
export function assertBunVersionOrExit(version?: string): void {
  const got = version ?? currentBunVersion();
  if (got != null && isBunAtLeast(got)) return;
  console.error(bunVersionCheckMessage(got));
  process.exit(1);
}
