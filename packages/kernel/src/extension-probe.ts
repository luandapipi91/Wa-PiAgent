/**
 * 插件注册面探测（运行时，问 pi 而不是猜源码）。
 *
 * 为什么不用静态扫源码：pi 扩展的命令名**不在 package.json 里声明**（`pi.extensions` 只给入口
 * 文件路径），扫源码只能靠正则猜写法——插件一旦用循环注册、字符串拼接、常量拼接或编译产物，
 * 就会漏判（漏判=该拦没拦）。而 pi 运行时自己就有权威数据：`get_commands` 返回的每条命令都带
 * `sourceInfo.path`，可反推出归属包（现成实现见 tui-command-filter 的 attachPackageName）。
 *
 * 另一个实测事实：pi 遇到命令重名**既不报错也不拦**，而是给两侧加 `:1` / `:2` 后缀都加载
 * （实测 pi-goal-x 与 @narumitw/pi-goal 共存 → `goal:1` + `goal:2`），谁生效取决于加载顺序。
 * 所以「同一原始命令名归属 >= 2 个包」就是冲突判据。
 *
 * 失败语义：探测本身失败（pi 起不来 / 超时）返回 null，调用方据此放行——校验是增益，不该因为
 * 探测不顺而阻断正常安装。
 */

import { WA_PI_DIR } from "@wa-pi/shared";
import {
	RpcClient,
	buildPiArgs,
	resolvePiCliPath,
	resolvePiRuntime,
} from "./rpc-client";
import { type RawCommandInfo, attachPackageName } from "./tui-command-filter";

/** 同一命令名归属的多个包 */
export interface CommandConflict {
	/** 原始命令名（已去掉 pi 的重名后缀） */
	name: string;
	/** 注册了该名字的所有包 */
	packages: string[];
}

/** pi 用 `名字:N` 区分同名命令（N 从 1 起），去掉后缀还原原始名 */
function stripDedupeSuffix(name: string): string {
	return name.replace(/:\d+$/, "");
}

/**
 * 起一个临时 pi（--no-session --offline，读同一 agentDir 的 settings.json）拉取
 * 「命令名 → 归属包集合」。探测失败返回 null。
 */
export async function probeCommandPackages(
	timeoutMs = 30_000,
): Promise<Map<string, Set<string>> | null> {
	const client = new RpcClient({
		cliPath: resolvePiCliPath(),
		runtime: resolvePiRuntime(),
		args: buildPiArgs({ noSession: true, offline: true }),
		cwd: WA_PI_DIR,
		env: { PI_CODING_AGENT_DIR: WA_PI_DIR },
		onEvent: () => {},
		commandTimeoutMs: timeoutMs,
	});
	try {
		await client.start();
		const { commands } = await client.getCommands();
		const withPkg = attachPackageName((commands ?? []) as RawCommandInfo[]);
		const byName = new Map<string, Set<string>>();
		for (const cmd of withPkg) {
			// 只认扩展来源且有归属包的命令（内置 / prompt / skill 不参与）
			if (cmd.source !== "extension" || !cmd.packageName) continue;
			const raw = stripDedupeSuffix(cmd.name);
			const owners = byName.get(raw) ?? new Set<string>();
			owners.add(cmd.packageName);
			byName.set(raw, owners);
		}
		return byName;
	} catch (err) {
		console.warn("[extension-probe] 命令归属探测失败，跳过冲突校验:", err);
		return null;
	} finally {
		await client.dispose().catch(() => undefined);
	}
}

/**
 * 挑出与 `target` 包相关的命令冲突：同名命令归属 >= 2 个包，且其中之一是 `target`。
 *
 * 只报「涉及本次新装包」的冲突——两个老插件之间的历史冲突不该阻碍安装第三个无关插件。
 */
export function findConflictsFor(
	byName: Map<string, Set<string>>,
	target: string,
): CommandConflict[] {
	const conflicts: CommandConflict[] = [];
	for (const [name, owners] of byName) {
		if (owners.size < 2 || !owners.has(target)) continue;
		conflicts.push({ name, packages: [...owners] });
	}
	return conflicts;
}
