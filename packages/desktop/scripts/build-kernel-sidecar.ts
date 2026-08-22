// 组装 resources/kernel/(WaPiKernel 单二进制 + package.json + bun.lock) + resources/web/(前端 dist)。
// kernel 用 bun --compile 编译成原生可执行文件（内含 bun runtime + 内核代码 + 已 patch 的
// pi-mcp-adapter），不再下载 bun、不再有 kernel.js/bridge 文件/patches 复制。
// 首启由 runtime-deps.cjs 用 BUN_BE_BUN=1（编译产物充当 bun CLI）动态安装磁盘依赖。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compileKernelBinary,
	kernelBinaryName,
} from "../../kernel/scripts/compile-binary";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const RES = join(PKG, "resources");

function run(bin: string, args: string[], cwd = ROOT) {
	console.log(`[sidecar] $ ${bin} ${args.join(" ")}`);
	// bun 在 Windows 上通常是 .cmd 包装，直接 spawn 会失败（CreateProcess 不解析 .cmd 扩展名）；
	// 构建脚本跑在 bun 上，process.execPath 即真实 bun 可执行文件（bun.exe），用它可避免经 shell 解析。
	const resolvedBin = bin === "bun" ? process.execPath : bin;
	const r = spawnSync(resolvedBin, args, {
		cwd,
		stdio: "inherit",
		shell: false,
	});
	if (r.status !== 0) {
		console.error(`[sidecar] 失败: ${bin}`);
		process.exit(1);
	}
}

/**
 * 运行时磁盘依赖清单（精简 external 清单）。只有两类包必须在磁盘：
 *   ① 原生 .node 依赖（@napi-rs/keyring——无法内联进虚拟 FS，编译时 --external）；
 *   ② 需作为独立子进程入口的包（@earendil-works/pi-coding-agent——pi RPC 子进程
 *      执行其 dist/cli.js，子进程读不到父进程的虚拟 FS）。
 * 其余全部内联进编译产物（jiti 在虚拟 FS 内解析，规避 2026-07-12 external 失败根因）。
 * 无 patchedDependencies：patch 编译期已生效（--compile 内联的是已 patch 源码）。
 * 该清单经 Task 6 集成测试（agent:prompt 全链路无 Cannot find module）审计确认。
 */
const RUNTIME_DEPENDENCIES = {
	"@earendil-works/pi-coding-agent": "^0.84.2",
	"@napi-rs/keyring": "^1.3.0",
};

/** 运行时 package.json（纯函数，便于测试断言） */
export function buildRuntimeManifest() {
	return {
		name: "wa-pi-kernel-sidecar",
		private: true,
		dependencies: RUNTIME_DEPENDENCIES,
	};
}

export async function buildSidecar(
	target: "win" | "linux" | "darwin" | string,
) {
	if (target !== "win" && target !== "linux" && target !== "darwin") {
		throw new Error(
			`[sidecar] 不支持的 target: ${target}（仅 win / linux / darwin）`,
		);
	}
	// bun --compile 按 host 平台编译（交叉编译需另下载目标 runtime，不在本设计范围——POC 双端各自本机编译）
	const targetPlatform =
		target === "win" ? "win32" : target === "darwin" ? "darwin" : "linux";
	if (process.platform !== targetPlatform) {
		throw new Error(
			`[sidecar] bun --compile 仅支持本机编译：target=${target} 需在 ${targetPlatform} 机器上打包（当前 ${process.platform}）`,
		);
	}
	const kernelDir = join(RES, "kernel");
	const webDir = join(RES, "web");
	await rm(RES, { recursive: true, force: true });
	await mkdir(kernelDir, { recursive: true });

	// 1. WaPiKernel 单二进制（bun --compile；bridge 三文件经 --asset 嵌入产物 assets/）
	compileKernelBinary(join(kernelDir, kernelBinaryName()));

	// 2. 依赖清单（package.json + bun.lock）：仅磁盘必需的 external 包。
	//    【只产出清单 + 锁文件，不打包 node_modules】——首启 BUN_BE_BUN=1 动态安装到
	//    用户可写目录（runtime-deps.cjs），避免 .app 只读、减小安装包体积。
	//    ⚠️ bun install --production 不生成锁文件，必须先用无 --production 跑一次产出 bun.lock。
	//    ⚠️ keyring 经 optionalDependencies 分发平台 .node 变体，无需 postinstall 编译，
	//    首启安装带 --ignore-scripts（runtime-deps.cjs）→ 网络通即 100% 安装成功。
	await writeFile(
		join(kernelDir, "package.json"),
		JSON.stringify(buildRuntimeManifest(), null, 2),
	);
	run("bun", ["install", "--cwd", kernelDir]); // 产出 bun.lock（--production 不生成锁文件）
	await rm(join(kernelDir, "node_modules"), { recursive: true, force: true });
	console.log(
		"[sidecar] 已剔除 node_modules（首启 BUN_BE_BUN=1 动态安装；仅随包分发 package.json + bun.lock）",
	);

	// 3. web（前端 dist）
	// --bun：vite bin shebang 为 #!/usr/bin/env node，系统 node v14 过旧不支持
	// vite 8 的 ??= 语法（SyntaxError），强制用 bun runtime 执行（与 dev.ts 一致）。
	run("bun", ["--bun", "run", "--filter", "@wa-pi/frontend", "build"]);
	await cp(join(ROOT, "packages", "frontend", "dist"), webDir, {
		recursive: true,
	});
	console.log("[sidecar] ✅ resources/kernel + resources/web 组装完成");
}
