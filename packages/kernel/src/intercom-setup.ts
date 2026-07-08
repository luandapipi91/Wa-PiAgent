import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HIAGENT_DIR } from "@hiagent/shared";

/** pi-intercom 扩展的 npm 包标识（Pi SDK 的 packages 字段格式） */
const INTERCOM_PACKAGE = "npm:pi-intercom";

/**
 * 确保 pi-intercom 扩展已配置到指定目录的 settings.json。
 *
 * 首次启动时 ~/.hiagent/settings.json 不存在或不含 pi-intercom，
 * 本函数会写入 packages 字段；Pi SDK 的 DefaultResourceLoader 首次加载时
 * 会据此从 npm 拉取并安装到 ~/.hiagent/npm/。
 *
 * 幂等：已配置则直接返回，不重复写入、不覆盖其他字段。
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

  // 幂等：packages 已包含 pi-intercom 则无需写入
  if (Array.isArray(settings.packages) && settings.packages.includes(INTERCOM_PACKAGE)) {
    return;
  }

  // 追加 pi-intercom 到 packages（保留已有包与其他字段）
  settings.packages = [...(settings.packages ?? []), INTERCOM_PACKAGE];
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`[kernel] 已写入 settings.json packages: [${INTERCOM_PACKAGE}]`);
}
