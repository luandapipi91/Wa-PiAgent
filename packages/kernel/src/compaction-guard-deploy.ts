// compaction-guard-deploy.ts —— 部署压缩守卫扩展到 GENERATED_DIR。
//
// 与 wa-pi-bridge / wa-pi-tui-host 同款形态：kernel 启动时把静态扩展源文件复制到
// GENERATED_DIR，pi 子进程经 -e 加载（extensions.ts 的 buildAdditionalExtensionPaths）。
// 入口 import "./compaction-guard-core.ts" 的相对路径在目标目录下按同样结构解析，无需改写。
//
// 为什么逐文件而不是整目录 cp：kernel 会被 bun build --compile 编成单二进制，
// 此时源码不在磁盘路径上，只有 --asset 嵌入到产物 __dirname/assets/ 的文件可读，
// 且 assets/ 里按 basename 平铺（无目录结构）。所以按「同目录 → assets/<basename> → 兜底」
// 三段式逐文件解析后写入。

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@wa-pi/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 扩展入口文件名（部署到 GENERATED_DIR 后的名字） */
export const COMPACTION_GUARD_EXTENSION_NAME = "compaction-guard";

/**
 * 部署清单：[源文件相对路径（相对 kernel/src）, 目标相对路径（相对 GENERATED_DIR）]。
 * 入口落为 compaction-guard.ts；纯逻辑模块落为 compaction-guard-core.ts（入口相对 import 它）。
 * 新增文件必须同时加进 scripts/compile-binary.ts 的 KERNEL_ASSET_FILES，否则打包版缺文件。
 */
export const COMPACTION_GUARD_EXTENSION_FILES: ReadonlyArray<
	readonly [source: string, target: string]
> = [
	["compaction-guard.extension.ts", `${COMPACTION_GUARD_EXTENSION_NAME}.ts`],
	["compaction-guard-core.ts", "compaction-guard-core.ts"],
];

/**
 * §bun --compile 打包版只有 assets/ 下的平铺副本可读，故三段式解析。
 * 两处都没有时回退同目录路径，让 readFileSync 抛 ENOENT（不静默成功）。
 */
function resolveSourceFile(rel: string): string {
	const flat = join(__dirname, rel);
	if (existsSync(flat)) return flat;
	const inAssets = join(__dirname, "assets", basename(rel));
	if (existsSync(inAssets)) return inAssets;
	return flat;
}

/**
 * 部署压缩守卫扩展到目标目录（默认 GENERATED_DIR），返回入口路径。
 * 每次覆盖写，幂等。dir 参数可注入，便于测试与自定义数据目录。
 */
export async function deployCompactionGuardExtension(
	dir: string = GENERATED_DIR,
): Promise<string> {
	for (const [source, target] of COMPACTION_GUARD_EXTENSION_FILES) {
		const targetPath = join(dir, target);
		await mkdir(dirname(targetPath), { recursive: true });
		await writeFile(targetPath, readFileSync(resolveSourceFile(source)));
	}
	return join(dir, `${COMPACTION_GUARD_EXTENSION_NAME}.ts`);
}
