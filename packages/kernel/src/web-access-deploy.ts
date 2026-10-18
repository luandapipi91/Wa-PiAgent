// web-access-deploy.ts —— 部署 web-access 扩展（DeepSeek 搜索/抓取）到 GENERATED_DIR。
//
// 与 bridge-extension.ts 同模式：把静态扩展源文件复制到 GENERATED_DIR，
// pi 进程经 -e 加载（主会话 buildAdditionalExtensionPaths + 子代理 extensionPaths）。
// 扩展文件自含（无相对 import 依赖），只需复制一个文件。

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@wa-pi/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 生成的 web-access 扩展文件路径（kernel spawn pi 时经 -e 注入） */
export const WEB_ACCESS_EXTENSION_PATH = join(GENERATED_DIR, "web-access.ts");

/**
 * 静态 web-access 扩展源文件。
 * - packaged：bun --compile --asset 嵌入编译产物 assets/ → 优先取。
 * - dev：回退到 monorepo 源码路径。
 */
function resolveWebAccessExtensionSource(): string {
	const flat = join(__dirname, "web-access.extension.ts");
	if (existsSync(flat)) return flat;
	const inAssets = join(__dirname, "assets", "web-access.extension.ts");
	if (existsSync(inAssets)) return inAssets;
	return flat; // 兜底同路径（bundled kernel 场景）
}

/**
 * 部署 web-access 扩展到 GENERATED_DIR：复制静态扩展文件。
 * 每次覆盖写，幂等。返回扩展入口路径。
 */
export async function ensureWebAccessExtension(): Promise<string> {
	await mkdir(GENERATED_DIR, { recursive: true });
	// POC：bun --compile 虚拟 FS 里 copyFile 不可用，改 readFileSync + writeFile（同 bridge）。
	const { writeFile } = await import("node:fs/promises");
	await writeFile(
		WEB_ACCESS_EXTENSION_PATH,
		readFileSync(resolveWebAccessExtensionSource()),
	);
	return WEB_ACCESS_EXTENSION_PATH;
}
