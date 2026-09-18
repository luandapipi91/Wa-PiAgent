// tui-host-deploy.ts —— 部署 wa-pi-tui-host 宿主扩展到 GENERATED_DIR。
//
// RPC 模式下 pi 以子进程运行：扩展入口经 -e 注入（extensions.ts 的
// buildAdditionalExtensionPaths），把 pi-tui 面板渲染成整帧文本经 kernel 送给图形界面。
// 与 wa-pi-bridge 同款形态：kernel 启动时把静态扩展文件复制到 GENERATED_DIR，
// 入口 import "./tui-host/host.ts" 之类的相对路径在目标目录下按同样结构解析，无需改写 import。
//
// 为什么逐文件而不是整目录 cp：kernel 会被 bun build --compile 编成单二进制，
// 此时源码不存在磁盘路径上，只有 --asset 嵌入到产物 __dirname/assets/ 的文件可读，
// 且 assets/ 里是按 basename 平铺的（不带目录结构）。整目录 cp 在虚拟 FS 下不可行，
// 只能按「同目录 → assets/<basename> → 兜底」三段式逐文件解析后读内容写入
// （bridge-extension.ts 同款处理）。

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@wa-pi/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 扩展入口文件名（部署到 GENERATED_DIR 后的名字） */
export const TUI_HOST_EXTENSION_NAME = "wa-pi-tui-host";

/**
 * 部署清单：[源文件相对路径（相对 kernel/src）, 目标相对路径（相对 GENERATED_DIR）]。
 * 入口落为 wa-pi-tui-host.ts，tui-host/ 各模块保持子目录结构——
 * 入口的 `import ... from "./tui-host/host.ts"` 因此原样可解析。
 * 新增模块必须同时加进 scripts/compile-binary.ts 的 KERNEL_ASSET_FILES，否则打包版缺文件；
 * 漏加本清单则 dev 下 GENERATED_DIR 缺文件 → pi 加载扩展报 "Cannot find module" → 新会话 agent 启动失败
 * （tests/tui-host-deploy.test.ts 的目录护栏会报红）。
 */
export const TUI_HOST_EXTENSION_FILES: ReadonlyArray<
	readonly [source: string, target: string]
> = [
	["wa-pi-tui-host.extension.ts", `${TUI_HOST_EXTENSION_NAME}.ts`],
	["tui-host/terminal.ts", "tui-host/terminal.ts"],
	["tui-host/frame.ts", "tui-host/frame.ts"],
	["tui-host/click.ts", "tui-host/click.ts"],
	["tui-host/panel.ts", "tui-host/panel.ts"],
	["tui-host/widget.ts", "tui-host/widget.ts"],
	["tui-host/host.ts", "tui-host/host.ts"],
];

/**
 * 解析扩展源文件路径（相对 kernel/src 的 rel）。
 * - dev / 解释运行：__dirname 即 packages/kernel/src，与源码同相对路径。
 * - packaged：bun --compile --asset 把文件按 basename 平铺嵌入 __dirname/assets/。
 * 两处都没有时回退同目录路径，让 readFileSync 抛出带真实路径的 ENOENT（不静默成功）。
 */
function resolveSourceFile(rel: string): string {
	const flat = join(__dirname, rel);
	if (existsSync(flat)) return flat;
	const inAssets = join(__dirname, "assets", basename(rel));
	if (existsSync(inAssets)) return inAssets;
	return flat;
}

/**
 * 部署宿主扩展到目标目录（默认 GENERATED_DIR），返回入口路径。
 * 每次覆盖写，幂等。dir 参数可注入，便于测试与将来支持自定义数据目录。
 */
export async function deployTuiHostExtension(
	dir: string = GENERATED_DIR,
): Promise<string> {
	for (const [source, target] of TUI_HOST_EXTENSION_FILES) {
		const targetPath = join(dir, target);
		await mkdir(dirname(targetPath), { recursive: true });
		await writeFile(targetPath, readFileSync(resolveSourceFile(source)));
	}
	return join(dir, `${TUI_HOST_EXTENSION_NAME}.ts`);
}
