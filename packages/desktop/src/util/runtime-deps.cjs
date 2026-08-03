// 首启动态安装 kernel 运行时依赖。
// 背景：kernel.js 已 bundle 所有 JS，但 ast-grep / better-sqlite3 / koffi 等原生 addon 无法内联，
// 运行时需要 node_modules。.app 内 Resources/kernel 只读，不能就地 install，故：
//   seed  （.app 只读）：kernel.js + package.json + bun.lock + wa-pi-kernel
//   runtime（~/.wa-pi/runtime 可写）：复制 seed → bun install 产出 node_modules → 跑 kernel.js
// 用 .installed-version 标记触发升级重装；默认阿里源(npmmirror)，失败回退官方源。
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";
const SEED_FILES = ["kernel.js", "package.json", "bun.lock", "tool-schemas.ts", "wa-pi-bridge.extension.ts"];

async function exists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

// 复制 seed 文件到 runtime 目录（升级时覆盖旧 kernel.js / package.json / bun.lock）
async function syncSeed(seedDir, runtimeDir, log) {
	await fsp.mkdir(runtimeDir, { recursive: true });
	for (const f of SEED_FILES) {
		const src = path.join(seedDir, f);
		if (await exists(src)) await fsp.copyFile(src, path.join(runtimeDir, f));
	}
	// patchedDependencies（pi-mcp-adapter 补丁）必须随 seed 复制到 runtime：
	// 运行时在此目录执行 bun remove/add 会重新解析依赖树并校验 patch 文件，
	// 缺 patches/ 会报 "Couldn't find patch file … 卸载失败"（bun 1.3）。
	// seedDir 无 patches 时静默跳过（老 seed / dev 场景）。
	const patchesSrc = path.join(seedDir, "patches");
	if (await exists(patchesSrc)) {
		await fsp.rm(path.join(runtimeDir, "patches"), { recursive: true, force: true });
		await fsp.cp(patchesSrc, path.join(runtimeDir, "patches"), { recursive: true });
	}
	log.info(`[deps] seed → ${runtimeDir}`);
}

// 跑一次 bun install；解析输出里的包计数回传给 UI 进度条
function runInstall({ kernelExe, runtimeDir, registry, log, onStatus }) {
	return new Promise((resolve, reject) => {
		const args = ["install", "--production", "--cwd", runtimeDir];
		const child = spawn(kernelExe, args, {
			cwd: runtimeDir,
			env: { ...process.env, BUN_CONFIG_REGISTRY: registry },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let errBuf = "";
		const handle = (b) => {
			const text = b.toString().trim();
			if (!text) return;
			log.info(`[deps] ${text}`);
			const m = text.match(/downloaded and extracted \[?(\d+)\]?/);
			if (m && onStatus) onStatus(`正在下载依赖… ${m[1]} 个包`);
		};
		child.stdout.on("data", handle);
		child.stderr.on("data", (b) => {
			handle(b);
			errBuf += b.toString();
		});
		child.on("error", (e) => reject(new Error(`spawn 失败: ${e.message}`)));
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(
						new Error(
							`bun install 退出码 ${code}${errBuf ? "\n" + errBuf.slice(-600) : ""}`,
						),
					),
		);
	});
}

/**
 * 确保 runtime 依赖就绪。返回应运行 kernel 的目录：
 *   packaged → runtimeDir（已装好 node_modules）
 *   dev      → seedDir（原样，用 repo 的 node_modules）
 */
async function ensureRuntimeDeps({
	isPackaged,
	seedDir,
	runtimeDir,
	kernelExe,
	version,
	log,
	onStatus,
}) {
	if (!isPackaged) return seedDir;

	const marker = path.join(runtimeDir, ".installed-version");
	const nmExists = await exists(path.join(runtimeDir, "node_modules"));
	const markerVer = nmExists
		? await fsp.readFile(marker, "utf8").catch(() => "")
		: "";

	// 始终同步 seed 文件（kernel.js 可能同版本号重新构建，内容已变）
	await syncSeed(seedDir, runtimeDir, log);

	if (nmExists && markerVer === version) {
		log.info(`[deps] node_modules 已安装 v${version}，跳过 install`);
		return runtimeDir;
	}

	log.info(
		`[deps] 需要安装依赖 (version=${version}, installed=${markerVer || "无"})`,
	);

	const primary = process.env.WA_PI_REGISTRY || DEFAULT_REGISTRY;
	if (onStatus) onStatus(`正在下载依赖…`);
	try {
		await runInstall({
			kernelExe,
			runtimeDir,
			registry: primary,
			log,
			onStatus,
		});
	} catch (e1) {
		log.error(
			`[deps] 主源(${primary})失败，回退 ${FALLBACK_REGISTRY}: ${e1.message}`,
		);
		if (onStatus) onStatus(`主源失败，尝试官方源…`);
		await runInstall({
			kernelExe,
			runtimeDir,
			registry: FALLBACK_REGISTRY,
			log,
			onStatus,
		});
	}
	await fsp.writeFile(marker, version, "utf8").catch(() => {});
	log.info("[deps] ✅ 安装完成");
	return runtimeDir;
}

module.exports = { ensureRuntimeDeps, syncSeed, DEFAULT_REGISTRY, FALLBACK_REGISTRY };
