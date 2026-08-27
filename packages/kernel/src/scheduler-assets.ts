/**
 * 定时任务资产分发：把 CLI 脚本与 README 落到全局目录 ~/.pi/agent/scheduled-tasks/。
 * 版本戳比对（首行），旧版自动覆盖升级；用户自加的其他文件不动。
 *
 * 打包方式：kernel 走 bun build --compile 单文件编译，外置 assets 目录不会随
 * 二进制分发，故用 Bun text import 把两个资产内嵌进 bundle（dev 的 bun run /
 * bun test 同样原生支持 text import）；tsc 不认识 text import，屏蔽之。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
// @ts-expect-error Bun text import：编译期把 cron-task.ts 全文内嵌为字符串
import cliSource from "../assets/scheduled-tasks/cron-task.ts" with {
	type: "text",
};
// @ts-expect-error Bun text import：README.md 非 TS 模块，tsc 无法解析
import readmeSource from "../assets/scheduled-tasks/README.md" with {
	type: "text",
};

export const SCHEDULER_ASSET_VERSION = 2;

const STAMP_CLI = `// wa-pi-cron-task-asset v${SCHEDULER_ASSET_VERSION}`;
const STAMP_README = `<!-- wa-pi-scheduled-tasks-assets v${SCHEDULER_ASSET_VERSION} -->`;

/** 读文件首行作为版本戳；文件不存在返回 null */
async function stampOf(file: string): Promise<string | null> {
	try {
		const content = await readFile(file, "utf8");
		return content.split("\n")[0] ?? null;
	} catch {
		return null;
	}
}

/** 原子写：先写临时文件再 rename，避免分发中断留下半个文件 */
export async function atomicWrite(
	file: string,
	content: string,
): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, file);
}

export async function ensureScheduledTasksAssets(
	base: string = join(WA_PI_DIR, "scheduled-tasks"),
): Promise<void> {
	await mkdir(join(base, "tasks"), { recursive: true });
	await mkdir(join(base, "logs"), { recursive: true });
	const cliTarget = join(base, "cron-task.ts");
	if ((await stampOf(cliTarget)) !== STAMP_CLI)
		await atomicWrite(cliTarget, cliSource);
	const readmeTarget = join(base, "README.md");
	if ((await stampOf(readmeTarget)) !== STAMP_README)
		await atomicWrite(readmeTarget, readmeSource);
}
