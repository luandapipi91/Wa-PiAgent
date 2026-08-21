// bun 下载资产与 URL 的纯函数（dev 自动下载与打包 sidecar 共用 URL 策略，防两处漂移）。
// 纯字符串逻辑、零 node:fs 依赖，进浏览器 bundle 无害（与 runtime-check 同款先例）。

export interface BunAssetSpec {
  archive: string;
  dir: string;
  bin: string;
}

/** 平台 + 架构 → bun 发布资产名（bun 资产 darwin 用 aarch64 而非 arm64，写错会 404） */
export function bunAssetForPlatform(
  platform: string,
  arch: string,
): BunAssetSpec {
  if (platform === "win32") {
    return {
      archive: "bun-windows-x64.zip",
      dir: "bun-windows-x64",
      bin: "bun.exe",
    };
  }
  if (platform === "linux") {
    return { archive: "bun-linux-x64.zip", dir: "bun-linux-x64", bin: "bun" };
  }
  if (platform === "darwin") {
    const a = arch === "arm64" ? "aarch64" : "x64";
    return {
      archive: `bun-darwin-${a}.zip`,
      dir: `bun-darwin-${a}`,
      bin: "bun",
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** 下载源列表：GitHub 固定 tag（可重复）+ npmmirror 固定版本（国内回退） */
export function bunDownloadUrls(archive: string, version = "1.4.0"): string[] {
  return [
    `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archive}`,
    `https://registry.npmmirror.com/-/binary/bun/bun-v${version}/${archive}`,
  ];
}
