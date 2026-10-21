// web-access-deploy.ts —— 部署 web-access 扩展（Bing/DeepSeek/智谱 搜索与抓取）到 GENERATED_DIR。
//
// 为什么 bundle 化：扩展经 pi 的 -e 加载，依赖必须自含。早期直接复制
// web-access.extension.ts 源文件（当时只依赖 typebox，pi 运行时能解析到）；2026-10-19 起
// 扩展引入链接库（linkedom/readability/turndown），GENERATED_DIR 下裸 import 无法解析
// → 加载即失败。改为构建期打包：产物单文件自含全部依赖。
//
// 两条路径：
// - dev（源码与 __dirname 同目录）→ 现场 Bun.build 打包写到 GENERATED_DIR；
// - packaged（bun --compile 产物，源码不在磁盘）→ 读 --asset 嵌入的
//   assets/web-access.bundle.js（compile-binary.ts 预构建）写到 GENERATED_DIR。
// 与 bridge/tui-host 的资产读取同模式；pi 进程经 -e 加载（主会话 + 子代理同款注入）。

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@wa-pi/shared";
import { buildWebAccessBundle } from "./web-access-bundle";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 生成的 web-access 扩展文件路径（kernel spawn pi 时经 -e 注入） */
export const WEB_ACCESS_EXTENSION_PATH = join(GENERATED_DIR, "web-access.ts");

/** 打包态预构建产物（compile-binary.ts 生成并 --asset 嵌入到产物 assets/） */
const BUNDLED_ASSET = join(__dirname, "assets", "web-access.bundle.js");

/**
 * 部署 web-access 扩展到 GENERATED_DIR：dev 现场打包 / packaged 复制预构建产物。
 * 每次重建，幂等。返回扩展入口路径。
 */
export async function ensureWebAccessExtension(): Promise<string> {
	await mkdir(GENERATED_DIR, { recursive: true });
	if (existsSync(join(__dirname, "web-access.extension.ts"))) {
		await buildWebAccessBundle(WEB_ACCESS_EXTENSION_PATH);
		return WEB_ACCESS_EXTENSION_PATH;
	}
	// POC：bun --compile 虚拟 FS 里 copyFile 不可用，改 readFileSync + writeFile（同 bridge）。
	const { writeFile } = await import("node:fs/promises");
	await writeFile(WEB_ACCESS_EXTENSION_PATH, readFileSync(BUNDLED_ASSET));
	return WEB_ACCESS_EXTENSION_PATH;
}
