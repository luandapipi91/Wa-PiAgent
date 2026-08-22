// dev 启动的 bun 下载/缓存工具：当前 bun <1.4.0 时下载固定版本到用户缓存目录，
// 用下载的 bun 重启 dev.ts 自身（进程树 kernel/frontend/pi rpc/插件安装全部跟随）。
// 参考：packages/desktop/scripts/build-kernel-sidecar.ts（发版 sidecar 下载同款策略）。
import {
  mkdirSync,
  statSync,
  copyFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import {
  bunAssetForPlatform,
  bunDownloadUrls,
  isBunAtLeast,
} from "@wa-pi/shared";

/** dev 缓存目录：env 覆盖 > Windows %LOCALAPPDATA% > POSIX ~/.cache */
export function devBunCacheDir(): string {
  if (process.env.WA_PI_BUN_CACHE_DIR) return process.env.WA_PI_BUN_CACHE_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "wa-pi", "bun");
  }
  const home = process.env.HOME || homedir();
  return join(home, ".cache", "wa-pi", "bun");
}

/** 缓存里 bun 二进制的完整路径（不一定存在/可用） */
export function cachedBunPath(): string {
  return join(
    devBunCacheDir(),
    bunAssetForPlatform(process.platform, process.arch).bin,
  );
}

/** 粗略判断文件是可用 bun：存在且 >1MB（挡半截下载）。版本由调用方另行校验。 */
export function isUsableBunFile(p: string): boolean {
  try {
    return statSync(p).size > 1_000_000;
  } catch {
    return false;
  }
}

/** 读取一个 bun 二进制的版本号；不可执行/不存在返回 null */
export function bunVersionOf(exe: string): string | null {
  try {
    const r = spawnSync(exe, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim().split(/\s+/)[0];
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string): Promise<boolean> {
  try {
    console.log(`[dev] 下载 ${url}`);
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok || !r.body) {
      console.warn(`[dev] HTTP ${r.status} ${url}`);
      return false;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, buf);
    const size = statSync(dest).size;
    if (size < 1_000_000) {
      console.warn(`[dev] 下载过小 (${size}B)，丢弃`);
      rmSync(dest, { force: true });
      return false;
    }
    console.log(`[dev] 下载 OK ${(size / 1024 / 1024).toFixed(1)} MB`);
    return true;
  } catch (e) {
    console.warn(`[dev] 下载失败 ${url}: ${(e as Error).message}`);
    return false;
  }
}

function extractZip(zip: string, outDir: string): void {
  if (process.platform === "win32") {
    const toWin = (p: string) =>
      p.replace(/\//g, "\\").replace(/^\\(\w+)\\/, "$1:\\");
    const ps = `Expand-Archive -Path '${toWin(zip)}' -DestinationPath '${toWin(outDir)}' -Force`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
      stdio: "inherit",
    });
    if (r.status !== 0)
      throw new Error(`PowerShell Expand-Archive 失败 (exit=${r.status})`);
  } else {
    const r = spawnSync("unzip", ["-o", zip, "-d", outDir], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`unzip 失败 (exit=${r.status})`);
  }
}

function findBunBinary(extractedRoot: string, binName: string): string | null {
  try {
    for (const e of readdirSync(extractedRoot)) {
      const child = join(extractedRoot, e);
      const st = statSync(child);
      if (st.isDirectory()) {
        for (const inner of readdirSync(child)) {
          if (inner === binName) return join(child, binName);
        }
      } else if (e === binName) {
        return child;
      }
    }
  } catch {
    /* 解压目录缺失等 → null */
  }
  return null;
}

/**
 * 下载 bun 到用户缓存目录（多镜像回退 + 解压 + 放置 + 版本校验）。
 * 成功返回缓存二进制路径；全失败返回 null（调用方走 assertBunVersionOrExit 兜底）。
 */
export async function downloadDevBun(): Promise<string | null> {
  const cacheDir = devBunCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const asset = bunAssetForPlatform(process.platform, process.arch);
  const outBin = join(cacheDir, asset.bin);
  const tmpZip = join(cacheDir, asset.archive); // 必须 .zip 扩展名（Expand-Archive 拒绝 .part）
  const tmpExtract = join(cacheDir, `.extract-${process.pid}`);
  for (const url of bunDownloadUrls(asset.archive)) {
    if (await downloadToFile(url, tmpZip)) {
      try {
        rmSync(tmpExtract, { recursive: true, force: true });
        extractZip(tmpZip, tmpExtract);
        const found = findBunBinary(tmpExtract, asset.bin);
        if (found) {
          copyFileSync(found, outBin);
          rmSync(tmpZip, { force: true });
          rmSync(tmpExtract, { recursive: true, force: true });
          const v = bunVersionOf(outBin);
          if (v && isBunAtLeast(v)) {
            console.log(`[dev] bun 已就绪: ${outBin} (${v})`);
            return outBin;
          }
          console.warn(
            `[dev] 下载的 bun 版本 ${v ?? "未知"} 不满足 ≥1.4.0，丢弃`,
          );
          rmSync(outBin, { force: true });
        }
      } catch (e) {
        console.warn(`[dev] 解压失败: ${(e as Error).message}`);
      }
    }
    rmSync(tmpZip, { force: true });
  }
  rmSync(tmpExtract, { recursive: true, force: true });
  return null;
}

/** 用指定 bun 重启当前脚本（用于版本不足时切到下载的 bun 重跑 dev）。 */
export function relaunchSelfWith(
  exe: string,
  scriptArgs: string[],
): Promise<never> {
  const child = spawn(exe, scriptArgs, { stdio: "inherit" });
  return new Promise<never>((resolve) => {
    child.on("close", (code) => {
      process.exit(code ?? 0);
      resolve();
    });
    child.on("error", (e) => {
      console.error("[dev] 重启失败:", e);
      process.exit(1);
    });
  });
}

/** 把缓存 bun 所在目录前置到 PATH（覆盖 kernel 内任何 Bun.which("bun") 场景） */
export function prependBunDirToPath(exe: string): void {
  const dir = dirname(exe);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
}
