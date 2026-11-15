// 组装 resources/kernel/(WaPiKernel 单二进制 + package.json + bun.lock) + resources/web/(前端 dist)。
// kernel 用 bun --compile 编译成原生可执行文件（内含 bun runtime + 内核代码），
// 不再下载 bun、不再有 kernel.js/bridge 文件/patches 复制。
// 首启由 runtime-deps.cjs 用 BUN_BE_BUN=1（编译产物充当 bun CLI）动态安装磁盘依赖。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compileKernelBinary,
	kernelBinaryName,
} from "../../kernel/scripts/compile-binary";
import kernelPkg from "../../kernel/package.json" with { type: "json" };

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
 * 运行时磁盘依赖清单（精简 external 清单）。必须落盘的有三类包：
 *   ① 原生 .node 依赖（@napi-rs/keyring——无法内联进虚拟 FS，编译时 --external）；
 *   ② 需作为独立子进程入口的包（@earendil-works/pi-coding-agent——pi RPC 子进程
 *      执行其 dist/cli.js，子进程读不到父进程的虚拟 FS）；
 *   ③ 内置 Pi 扩展（现已无 npm 形态内置扩展：PKG_EXTENSIONS 已清空，
 *      web_search/fetch_content 由自研 web-access 扩展提供，源码随内核 bundle 走 --asset）。
 * 其余全部内联进编译产物（jiti 在虚拟 FS 内解析，规避 2026-07-12 external 失败根因）。
 * 无 patchedDependencies：patch 编译期已生效（--compile 内联的是已 patch 源码；
 * 磁盘副本供 -e 扩展加载，patch 仅涉及类型 + exports 子路径，不影响扩展执行）。
 * 该清单经 Task 6 集成测试（agent:prompt 全链路无 Cannot find module）审计确认。
 * 版本统一从 packages/kernel/package.json 读取（单一来源）：升级依赖时打包自动跟随，
 * 无需手动同步本文件与 kernel-compile-it.ts 的硬编码版本串。
 */
export const kernelRuntimeDependencies = (kernelPkg: {
	dependencies: Record<string, string>;
}): Record<string, string> => ({
	"@earendil-works/pi-coding-agent":
		kernelPkg.dependencies["@earendil-works/pi-coding-agent"],
	"@napi-rs/keyring": kernelPkg.dependencies["@napi-rs/keyring"],
	// 浏览器自动化：agent-browser 平台原生二进制（Rust CLI + 内置 MCP server）
	"agent-browser": kernelPkg.dependencies["agent-browser"],
	// 内置 npm 扩展已清空（pi-web-access 2026-10-18 移除：web 工具改由自研
	// web-access 扩展提供，源码随内核 bundle 走 --asset，无需磁盘依赖）
});

/** 运行时 package.json（纯函数，便于测试断言）。
 * version 必须传应用版本（desktop package.json，发版唯一升版点）：
 * 2026-11-15 事故——恒用 kernelPkg.version（恒 0.1.5）导致壳新核旧静默共存数天
 * 无从发现；现在它是启动时壳/核一致性自检的比对源。
 * 打包写进 resources/kernel/package.json；关于页经 main.cjs 读 runtime/seed 的
 * package.json.version 作为「内核版本」。 */
export function buildRuntimeManifest(
	appVersion: string,
): {
	name: string;
	private: boolean;
	version: string;
	dependencies: Record<string, string>;
} {
	return {
		name: "wa-pi-kernel-sidecar",
		private: true,
		version: appVersion,
		dependencies: kernelRuntimeDependencies(kernelPkg),
	};
}

/** kernel 校验清单（纯函数，便于测试断言）：与 package.json 同目录落盘 manifest.json，
 * 应用启动时逐项比对壳/核一致性（version + exe 大小；哈希仅诊断不参与启动比对）。 */
export function buildKernelManifest(opts: {
	version: string;
	exeName: string;
	exeSize: number;
	exeSha256: string;
}) {
	return {
		version: opts.version,
		exe: {
			name: opts.exeName,
			size: opts.exeSize,
			sha256: opts.exeSha256,
		},
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
	// bun ≥1.4 支持 --target 交叉编译（首次编译会下载目标平台 runtime，~40MB），
	// 故 mac 上可打 win/linux 包；target 为 darwin 时本机编译不传 --target。
	const kernelDir = join(RES, "kernel");
	const webDir = join(RES, "web");
	await rm(RES, { recursive: true, force: true });
	await mkdir(kernelDir, { recursive: true });

	// 1. WaPiKernel 单二进制（bun --compile；bridge 三文件经 --asset 嵌入产物 assets/）
	const kernelBinary = join(kernelDir, kernelBinaryName(target));
	await compileKernelBinary(kernelBinary, target);

	// 1b) 校验清单（壳/核一致性自检的真相源）：version 取应用版本（desktop package.json，
	// 发版唯一升版点），exe 大小/哈希锁当次编译产物。NSIS 升级覆盖安装曾因 kernel 进程
	// 锁文件被静默跳过（2026-11-15 事故），启动自检靠这份清单发现不一致并弹窗提示。
	const appVersion = (
		JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as {
			version: string;
		}
	).version;
	const exeStat = await stat(kernelBinary);
	const exeSha256 = createHash("sha256")
		.update(await readFile(kernelBinary))
		.digest("hex");
	await writeFile(
		join(kernelDir, "manifest.json"),
		JSON.stringify(
			buildKernelManifest({
				version: appVersion,
				exeName: kernelBinaryName(target),
				exeSize: exeStat.size,
				exeSha256,
			}),
			null,
			"\t",
		),
	);
	console.log(
		`[sidecar] manifest.json 已写入（version=${appVersion} size=${exeStat.size}）`,
	);

	// 2. 依赖清单（package.json + bun.lock）：仅磁盘必需的 external 包。
	//    【只产出清单 + 锁文件，不打包 node_modules】——首启 BUN_BE_BUN=1 动态安装到
	//    用户可写目录（runtime-deps.cjs），避免 .app 只读、减小安装包体积。
	//    ⚠️ bun install --production 不生成锁文件，必须先用无 --production 跑一次产出 bun.lock。
	//    ⚠️ keyring 经 optionalDependencies 分发平台 .node 变体，无需 postinstall 编译，
	//    首启安装带 --ignore-scripts（runtime-deps.cjs）→ 网络通即 100% 安装成功。
	await writeFile(
		join(kernelDir, "package.json"),
		JSON.stringify(buildRuntimeManifest(appVersion), null, 2),
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
