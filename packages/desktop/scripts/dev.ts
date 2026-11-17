// dev 桌面版启动器（macOS/Linux/Windows 通用）。
//
// 为什么需要它：从终端（尤其是从 Wa-Pi 桌面应用内部起的终端）启动时，会继承
// 一堆 WA_PI_* —— 最要命的是 WA_PI_WEB_DIR 指向「已安装应用」的 Resources/web，
// 于是 dev 版加载的是旧前端：改了源码看不到效果，还会因为缺少新组件出现错位。
// 同时 WA_PI_WS_PORT 默认 9778 与正在运行的正式版撞端口。
//
// 这里做三件事：剥离继承的 WA_PI_*、给 dev 一套独立的端口与数据目录、
// 起 electron 并透传额外参数（如 --remote-debugging-port）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "..", "..");

/** 会污染 dev 实例的环境变量：全部来自宿主（已安装的桌面应用） */
export const INHERITED_KEYS = [
	"WA_PI_WEB_DIR",
	"WA_PI_KERNEL_DIR",
	"WA_PI_RUNTIME_DIR",
	"WA_PI_BRIDGE_URL",
	"WA_PI_BRIDGE_TOKEN",
	"WA_PI_SESSION_ID",
	"WA_PI_BROWSER_SESSION",
	"WA_PI_SCHEDULER_PROJECT_ID",
	"WA_PI_SQLITE_DYLIB",
	"WA_PI_WEB_PORT",
	"ELECTRON_RUN_AS_NODE",
];

/** dev 默认值：端口避开正式版的 9778，数据目录隔离以免两个 kernel 抢同一份数据 */
export const DEV_DEFAULT_PORT = "9788";

export function buildDevEnv(
	source: Record<string, string | undefined>,
	home = homedir(),
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined) continue;
		env[k] = v;
	}
	for (const key of INHERITED_KEYS) delete env[key];
	// 显式关掉沙箱外的 node 模式：ELECTRON_RUN_AS_NODE 被继承时 electron 会当纯 node 跑
	delete env.ELECTRON_RUN_AS_NODE;
	env.WA_PI_WS_PORT = env.WA_PI_DEV_PORT ?? DEV_DEFAULT_PORT;
	env.WA_PI_DIR = env.WA_PI_DEV_DIR ?? join(home, ".wa-pi-dev");
	return env;
}

/** electron 的 userData 也隔离：否则单实例锁会被正在运行的正式版占住，dev 窗口一启动就退出 */
export function devUserDataDir(home = homedir(), profile = "default"): string {
	return join(home, ".wa-pi-dev", `userdata-${profile}`);
}

function main() {
	const env = buildDevEnv(process.env);
	const webDir = join(repoRoot, "packages", "frontend", "dist");
	if (!existsSync(join(webDir, "index.html"))) {
		console.error(
			`[dev] 前端产物不存在：${webDir}\n` +
				"      先跑 `bun run --filter @wa-pi/frontend build`（或根目录 bun run build:web）",
		);
		process.exit(1);
	}
	const electronBin = join(pkgDir, "node_modules", ".bin", "electron");
	if (!existsSync(electronBin)) {
		console.error(`[dev] 找不到 electron：${electronBin}，先跑 bun install`);
		process.exit(1);
	}
	const userData = devUserDataDir();
	console.log(`[dev] 端口     ${env.WA_PI_WS_PORT}`);
	console.log(`[dev] 数据目录 ${env.WA_PI_DIR}`);
	console.log(`[dev] 前端产物 ${webDir}`);
	console.log(`[dev] userData ${userData}`);
	const child = spawn(
		electronBin,
		[".", `--user-data-dir=${userData}`, ...process.argv.slice(2)],
		{ cwd: pkgDir, env, stdio: "inherit" },
	);
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

if (import.meta.main) main();
