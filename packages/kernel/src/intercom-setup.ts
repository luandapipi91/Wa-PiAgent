import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HIAGENT_DIR } from "@hiagent/shared";

/** pi-intercom 的 npm 包标识（旧格式，用于迁移检测） */
const LEGACY_INTERCOM_NPM = "npm:pi-intercom";

/**
 * 解析 pi-intercom 本地路径（打包在项目依赖中，不走运行时 npm install）。
 * 返回 pi-intercom 包的目录路径，供 Pi SDK 的 DefaultResourceLoader 以本地路径加载。
 *
 * @throws 若 pi-intercom 未作为项目依赖安装
 */
function resolveIntercomLocalPath(): string {
  const url = import.meta.resolve("pi-intercom");
  // import.meta.resolve 返回 file:///.../pi-intercom/index.ts
  // 取目录路径：file:///.../pi-intercom/ 
  const dirUrl = new URL(".", url);
  return dirUrl.pathname;
}

/**
 * 确保 pi-intercom 扩展已配置到指定目录的 settings.json。
 *
 * 首次启动时 ~/.hiagent/settings.json 不存在或不含 pi-intercom 本地路径，
 * 本函数会写入 packages 字段（使用本地路径，不再走 npm install）。
 * 若存在旧的 npm:pi-intercom 格式，自动迁移为本地路径。
 *
 * 幂等：已配置本地路径则直接返回，不重复写入、不覆盖其他字段。
 *
 * @param dir 数据目录，默认 HIAGENT_DIR；测试时注入临时目录以隔离
 */
export async function ensureIntercomInstalled(dir: string = HIAGENT_DIR): Promise<void> {
  const settingsPath = join(dir, "settings.json");
  let settings: { packages?: string[]; [k: string]: unknown } = {};

  // 读取现有 settings.json（不存在则用空对象，视为首次启动）
  try {
    const raw = await readFile(settingsPath, "utf8");
    settings = JSON.parse(raw);
  } catch {
    // 文件不存在或解析失败 —— 用空对象
  }

  const intercomPath = resolveIntercomLocalPath();

  // 幂等：packages 已包含本地 pi-intercom 路径则无需写入
  if (Array.isArray(settings.packages) && settings.packages.includes(intercomPath)) {
    return;
  }

  // 迁移：替换旧的 npm:pi-intercom 为本地路径（保留其他包）
  const existing = settings.packages ?? [];
  const migrated = existing.map((p) => (p === LEGACY_INTERCOM_NPM ? intercomPath : p));

  // 如果旧格式不存在且本地路径也不存在，追加本地路径
  if (!migrated.includes(intercomPath)) {
    migrated.push(intercomPath);
  }

  settings.packages = migrated;
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`[kernel] 已写入 settings.json packages: [${intercomPath}]`);
}
