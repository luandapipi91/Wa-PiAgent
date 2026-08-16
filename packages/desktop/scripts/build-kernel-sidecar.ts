// 组装 resources/kernel/(bun.exe + kernel.js + node_modules) + resources/web/(前端 dist)。
// 复用 tray-binary P2 的文件夹组装逻辑（解释 kernel sidecar = 已验证形态）。
import { spawnSync } from "node:child_process";
import {
	cp,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const RES = join(PKG, "resources");

function run(bin: string, args: string[], cwd = ROOT) {
	console.log(`[sidecar] $ ${bin} ${args.join(" ")}`);
	// bun 在 Windows 上通常是 .cmd 包装，直接 spawn 会失败（CreateProcess 不解析 .cmd 扩展名）；
	// 构建脚本跑在 bun 上，process.execPath 即真实 bun 可执行文件（bun.exe），用它可避免经 shell 解析。
	// 其余 bin（unzip/chmod）仅在 POSIX 分支调用，是原生二进制，直接 spawn 安全。
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

// 目标平台 → bun 解压目录名 + 期望二进制名
const BUN_TARGET = {
	win: {
		archive: "bun-windows-x64.zip",
		dir: "bun-windows-x64",
		bin: "bun.exe",
	},
	linux: { archive: "bun-linux-x64.zip", dir: "bun-linux-x64", bin: "bun" },
	darwin: {
		archive:
			process.arch === "arm64" ? "bun-darwin-arm64.zip" : "bun-darwin-x64.zip",
		dir: process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64",
		bin: "bun",
	},
} as const;

// 下载 URL（按优先级；github 可能被墙，npmmirror 是国内镜像）
function bunDownloadUrls(archive: string): string[] {
	return [
		`https://github.com/oven-sh/bun/releases/latest/download/${archive}`,
		`https://registry.npmmirror.com/-/binary/bun/bun-v1.3.14/${archive}`,
	];
}

async function downloadToFile(url: string, dest: string): Promise<boolean> {
	try {
		console.log(`[sidecar] 下载 ${url}`);
		// 必须带超时：GitHub 被墙/网络黑洞时 fetch 可能永不返回（无默认超时），
		// 会卡在第一个 URL 而到不了镜像回退与 host bun 兜底。20s 超时后抛错走下一镜像。
		const r = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(20_000),
		});
		if (!r.ok || !r.body) {
			console.warn(`[sidecar] HTTP ${r.status} ${url}`);
			return false;
		}
		const buf = Buffer.from(await r.arrayBuffer());
		await writeFile(dest, buf);
		const size = (await stat(dest)).size;
		if (size < 1_000_000) {
			console.warn(`[sidecar] 下载过小 (${size}B)，丢弃`);
			await rm(dest, { force: true });
			return false;
		}
		console.log(`[sidecar] 下载 OK ${(size / 1024 / 1024).toFixed(1)} MB`);
		return true;
	} catch (e) {
		console.warn(`[sidecar] 下载失败 ${url}: ${(e as Error).message}`);
		return false;
	}
}

// 解压 zip 到 dir；Windows 用 PowerShell Expand-Archive，Linux 用系统 unzip。
function extractZip(zip: string, outDir: string): void {
	if (process.platform === "win32") {
		// Expand-Archive 需 Windows 风格路径（POSIX /tmp 会被拒）
		const toWin = (p: string) =>
			p.replace(/\//g, "\\").replace(/^\\(\w+)\\/, "$1:\\");
		const ps = `Expand-Archive -Path '${toWin(zip)}' -DestinationPath '${toWin(outDir)}' -Force`;
		const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
			stdio: "inherit",
		});
		if (r.status !== 0)
			throw new Error(`PowerShell Expand-Archive 失败 (exit=${r.status})`);
	} else {
		run("unzip", ["-o", zip, "-d", outDir]);
	}
}

// 找到解压目录里的 bun 二进制（zip 内含 bun-<plat>-x64/bun[.exe]）。
async function findBunBinary(
	extractedRoot: string,
	binName: string,
): Promise<string | null> {
	if ((await stat(extractedRoot)).isDirectory()) {
		const entries = await readdir(extractedRoot);
		for (const e of entries) {
			const child = join(extractedRoot, e);
			if ((await stat(child)).isDirectory()) {
				const inner = await readdir(child);
				if (inner.includes(binName)) return join(child, binName);
			} else if (e === binName) {
				return child;
			}
		}
	}
	return null;
}

// 取目标平台的 bun 二进制：优先下载；下载不可用时仅在 host 与 target 平台一致时回退复制 host bun。
async function fetchTargetBun(
	target: "win" | "linux" | "darwin",
	kernelDir: string,
): Promise<void> {
	const spec = BUN_TARGET[target];
	const outBin = join(kernelDir, spec.bin);
	const tmpZip = join(tmpdir(), `wa-pi-${spec.archive}`);
	const tmpExtract = join(tmpdir(), `wa-pi-bun-extract-${process.pid}`);
	await rm(tmpExtract, { recursive: true, force: true });

	// 1) 尝试下载（多镜像）
	for (const url of bunDownloadUrls(spec.archive)) {
		if (await downloadToFile(url, tmpZip)) {
			try {
				await mkdir(tmpExtract, { recursive: true });
				extractZip(tmpZip, tmpExtract);
				const found = await findBunBinary(tmpExtract, spec.bin);
				if (found) {
					await cp(found, outBin);
					console.log(`[sidecar] 解压并放置 ${spec.bin} ← ${found}`);
					await rm(tmpZip, { force: true });
					await rm(tmpExtract, { recursive: true, force: true });
					return;
				}
				console.warn(`[sidecar] 解压后未找到 ${spec.bin}，尝试下一镜像`);
			} catch (e) {
				console.warn(`[sidecar] 解压失败: ${(e as Error).message}`);
			}
		}
	}
	await rm(tmpZip, { force: true });
	await rm(tmpExtract, { recursive: true, force: true });

	// 2) 兜底：仅当 host 与 target 平台一致时复制 host bun
	const hostMatchesTarget =
		(target === "win" && process.platform === "win32") ||
		(target === "linux" && process.platform === "linux") ||
		(target === "darwin" && process.platform === "darwin");
	if (hostMatchesTarget) {
		console.warn(
			`[sidecar] ⚠️ 所有镜像下载失败，回退复制 host bun (${process.execPath})——仅 host==target 时安全`,
		);
		await cp(process.execPath, outBin);
		return;
	}

	// 3) host != target：必须报错（绝不能把 host 平台的 bun 当作 target 的发出去）
	throw new Error(
		`[sidecar] 无法下载 target=${target} 的 bun 二进制，且 host 平台 (${process.platform}) 不匹配 target——` +
			`拒绝将 host bun 当作 ${target} 分发。请检查网络/代理或预置 bun 二进制。`,
	);
}

export async function buildSidecar(
	target: "win" | "linux" | "darwin" | string,
) {
	if (target !== "win" && target !== "linux" && target !== "darwin") {
		throw new Error(
			`[sidecar] 不支持的 target: ${target}（仅 win / linux / darwin）`,
		);
	}
	const kernelDir = join(RES, "kernel");
	const webDir = join(RES, "web");
	await rm(RES, { recursive: true, force: true });
	await mkdir(kernelDir, { recursive: true });

	// 1. kernel.js（解释 bundle；--target bun，平台中立，一次构建）
	// --external registry-js：读 Windows 注册表的原生 addon（os-proxy-config→windows-system-proxy→registry-js），
	// 无法内联，若不用 external 会被 bun build 当 asset 输出导致 --outfile 报「多个输出文件」。
	// 标记 external 后，运行时从首启动态安装的 node_modules 加载（依赖清单里已加 registry-js）。
	run("bun", [
		"build",
		join(ROOT, "packages", "kernel", "src", "desktop-server.ts"),
		"--target",
		"bun",
		"--external",
		"registry-js",
		"--outfile",
		join(kernelDir, "kernel.js"),
	]);

	// 2. 依赖清单（package.json + bun.lock）：JS 已 bundle 进 kernel.js，但 ast-grep/better-sqlite3/koffi
	//    等原生 addon 无法内联，运行时需要 node_modules。这里【只产出清单 + 锁文件，不打包 node_modules】——
	//    首启动态安装到用户可写目录（runtime-deps.cjs），既避免 .app 只读、又减小安装包体积，
	//    且首启只装用户本机平台的原生预编译。
	//    ⚠️ bun install --production 不生成锁文件，必须先用无 --production 跑一次产出 bun.lock。
	//    带 patchedDependencies 并复制补丁文件：pi-mcp-adapter 的 exports/类型补丁在打包态也需应用。
	await writeFile(
		join(kernelDir, "package.json"),
		JSON.stringify(
			{
				name: "wa-pi-kernel-sidecar",
				private: true,
				patchedDependencies: {
					"pi-mcp-adapter@2.17.0": "patches/pi-mcp-adapter@2.17.0.patch",
				},
				dependencies: {
					"@earendil-works/pi-coding-agent": "^0.84.2",
					"@earendil-works/pi-ai": "^0.84.2",
					"pi-web-access": "^0.17.1",
					"@amaster.ai/pi-memory": "^0.1.5",
					"pi-mcp-adapter": "^2.13.0",
					"@modelcontextprotocol/sdk": "^1.29.0",
					typebox: "^1.3.6",
					// 读系统代理的注册表原生 addon（os-proxy-config 间接依赖），kernel.js 里标记 external，
					// 需随依赖清单首启动态安装 .node 供运行时加载。
					"registry-js": "^1.16.1",
				},
			},
			null,
			2,
		),
	);
	// 复制补丁文件到 kernel 目录：bun install --cwd kernelDir 需要能按相对路径找到补丁
	await cp(join(ROOT, "patches"), join(kernelDir, "patches"), {
		recursive: true,
	});
	run("bun", ["install", "--cwd", kernelDir]); // 产出 bun.lock（--production 不生成锁文件）
	await rm(join(kernelDir, "node_modules"), { recursive: true, force: true });
	console.log(
		"[sidecar] 已剔除 node_modules（首启用阿里源动态安装；仅随包分发 package.json + bun.lock）",
	);

	// 4. bridge-extension 依赖文件：复制到 kernel.js 同级，确保打包后 __dirname 可找到
	const bridgeExtSrc = join(
		ROOT,
		"packages",
		"kernel",
		"src",
		"wa-pi-bridge.extension.ts",
	);
	const toolSchemasSrc = join(
		ROOT,
		"packages",
		"shared",
		"src",
		"tool-schemas.ts",
	);
	const fileSnapshotSrc = join(
		ROOT,
		"packages",
		"kernel",
		"src",
		"file-snapshot.ts",
	);
	await cp(bridgeExtSrc, join(kernelDir, "wa-pi-bridge.extension.ts"));
	await cp(toolSchemasSrc, join(kernelDir, "tool-schemas.ts"));
	await cp(fileSnapshotSrc, join(kernelDir, "file-snapshot.ts"));

	// 5. bun 运行时（下载 TARGET 平台 bun；不再无条件复制 host bun，避免 Linux CI 误把 Linux bun 当 bun.exe 发出去）
	await fetchTargetBun(target, kernelDir);
	// 重命名 bun → wa-pi-kernel（分发进程名不暴露 bun；Bun CLI 不依赖自身文件名）
	const finalBin = target === "win" ? "wa-pi-kernel.exe" : "wa-pi-kernel";
	await rename(
		join(kernelDir, BUN_TARGET[target].bin),
		join(kernelDir, finalBin),
	);
	// POSIX 目标需保证可执行位（下载/解压偶尔丢失）
	if (target !== "win") run("chmod", ["+x", join(kernelDir, finalBin)]);

	// 6. web（前端 dist）
	run("bun", ["run", "--filter", "@wa-pi/frontend", "build"]);
	await cp(join(ROOT, "packages", "frontend", "dist"), webDir, {
		recursive: true,
	});
	console.log("[sidecar] ✅ resources/kernel + resources/web 组装完成");
}
