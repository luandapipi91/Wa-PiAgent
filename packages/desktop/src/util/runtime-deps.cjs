// 首启动态安装 kernel 运行时依赖。
// 背景：kernel.js 已 bundle 所有 JS，但 ast-grep / better-sqlite3 / koffi 等原生 addon 无法内联，
// 运行时需要 node_modules。.app 内 Resources/kernel 只读，不能就地 install，故：
//   seed  （.app 只读）：kernel.js + package.json + bun.lock + wa-pi-kernel
//   runtime（WA_PI_DIR/runtime 可写，默认 ~/.pi/agent/runtime）：复制 seed → bun install 产出 node_modules → 跑 kernel.js
// 用 .installed-version 标记触发升级重装；默认阿里源(npmmirror)，失败回退官方源。
//
// 坑位记录：bun install 退出码 0 不等于依赖可用。registry-js 等原生 addon 的
// postinstall（node-gyp 编译 / prebuild 下载）失败时，bun 仍会以 0 退出（依赖包已
// 解压，重跑 install 报 no changes），导致「假成功」写入标记、后续启动永久跳过安装，
// 直到 kernel 加载 registry-js 报 Cannot find module .../registry.node 才暴露。
//
// 因此：① 安装必须带 --ignore-scripts（跳过所有 lifecycle scripts，包括 registry-js
// 的 node-gyp 编译）——seed 依赖全部是纯 JS 包（已确认仅有 protobufjs 打版本警告的
// 无害 postinstall），跳过脚本后安装只依赖下载解压，网络通即 100% 成功；
// ② Windows 读系统代理改用 PowerShell（settings-store.ts），不再依赖 registry-js 的
// .node 产物；③ 安装后 verifyInstall 校验顶层依赖真实存在，失败则清理 node_modules
// 重装（installWithRetry）；④ 全部失败不写标记 → 下次启动自动重试（门禁）。
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";
const SEED_FILES = [
	"kernel.js",
	"package.json",
	"bun.lock",
	"tool-schemas.ts",
	"wa-pi-bridge.extension.ts",
	"file-snapshot.ts",
];

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
		await fsp.rm(path.join(runtimeDir, "patches"), {
			recursive: true,
			force: true,
		});
		await fsp.cp(patchesSrc, path.join(runtimeDir, "patches"), {
			recursive: true,
		});
	}
	log.info(`[deps] seed → ${runtimeDir}`);
}

// 安装后产物校验：顶层依赖的 package.json 必须存在（校验失败说明安装未真正完成，
// 可能是网络中断导致的半装）。仅看 bun install 退出码会漏掉这类情况。
// 注意：不校验 registry-js 的 .node 产物——Windows 读系统代理已改为 PowerShell 兜底
// （settings-store.ts），首启安装带 --ignore-scripts 不编译原生模块。
async function verifyInstall(runtimeDir, log) {
	let manifest;
	try {
		manifest = JSON.parse(
			await fsp.readFile(path.join(runtimeDir, "package.json"), "utf8"),
		);
	} catch (e) {
		throw new Error(`package.json 读取/解析失败: ${e.message}`);
	}
	const missing = [];
	for (const name of Object.keys(manifest.dependencies || {})) {
		const pkgJson = path.join(runtimeDir, "node_modules", name, "package.json");
		if (!(await exists(pkgJson))) missing.push(`${name}（包未安装）`);
	}
	if (missing.length) {
		throw new Error(`安装产物校验失败: ${missing.join("；")}`);
	}
	if (log) log.info("[deps] 安装产物校验通过");
}

// 删除 node_modules（重装前清理脏状态）。Windows 上会话占用扩展文件会锁目录，
// 参照 npm-package-service.repair 重试 3 次×1s，仍失败抛错（提示关闭占用）。
async function rmNodeModules(runtimeDir, log) {
	const nm = path.join(runtimeDir, "node_modules");
	if (!(await exists(nm))) return;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fsp.rm(nm, { recursive: true, force: true });
			return;
		} catch (e) {
			if (attempt === 2) {
				throw new Error(
					`删除 node_modules 失败（可能被占用，请关闭 WA PI Agent 其他实例后重试）: ${e.message}`,
				);
			}
			if (log)
				log.info(`[deps] 删除 node_modules 被占用，1s 后重试 (${attempt + 1}/3)`);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

// 安装重试：registries 依次尝试，每轮安装后 verify 校验产物；一轮全失败则 cleanup
// （清理 node_modules）后进入下一轮。返回即成功；两轮（2×registries.length 次）全败抛错。
async function installWithRetry({ registries, install, verify, cleanup, log }) {
	let lastErr = null;
	for (let round = 1; round <= 2; round++) {
		if (round === 2) {
			if (log) log.info("[deps] 首轮安装/校验失败，清理 node_modules 后重装…");
			await cleanup();
		}
		for (const registry of registries) {
			try {
				await install(registry);
				await verify();
				return;
			} catch (e) {
				lastErr = e;
				if (log) log.error(`[deps] 源 ${registry} 安装/校验失败: ${e.message}`);
			}
		}
	}
	throw new Error(
		`依赖安装重试 ${2 * registries.length} 次后仍失败: ${lastErr?.message || "未知原因"}`,
	);
}

// 跑一次 bun install；解析输出里的包计数回传给 UI 进度条
// args 抽成纯函数便于测试断言（--ignore-scripts 是 100% 安装成功的关键）。
function buildInstallArgs(runtimeDir) {
	return [
		"install",
		"--production",
		"--ignore-scripts", // 跳过所有 lifecycle scripts（registry-js 的 node-gyp 编译等），消除编译失败
		"--cwd",
		runtimeDir,
	];
}

function runInstall({ kernelExe, runtimeDir, registry, log, onStatus }) {
	return new Promise((resolve, reject) => {
		const args = buildInstallArgs(runtimeDir);
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
							`bun install 退出码 ${code}${errBuf ? `\n${errBuf.slice(-600)}` : ""}`,
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

	const registries = [
		process.env.WA_PI_REGISTRY || DEFAULT_REGISTRY,
		FALLBACK_REGISTRY,
	];
	if (onStatus) onStatus(`正在下载依赖…`);
	// 主源 → 回退源，安装后校验产物；失败清理 node_modules 再重试一轮。
	// 全部失败时抛错（main.cjs 显示错误页），不写标记 → 下次启动自动重试（兜底）。
	await installWithRetry({
		registries,
		install: (registry) =>
			runInstall({ kernelExe, runtimeDir, registry, log, onStatus }),
		verify: () => verifyInstall(runtimeDir, log),
		cleanup: () => rmNodeModules(runtimeDir, log),
		log,
	});
	await fsp.writeFile(marker, version, "utf8").catch(() => {});
	log.info("[deps] ✅ 安装完成");
	return runtimeDir;
}

module.exports = {
	ensureRuntimeDeps,
	syncSeed,
	verifyInstall,
	installWithRetry,
	rmNodeModules,
	buildInstallArgs,
	DEFAULT_REGISTRY,
	FALLBACK_REGISTRY,
};
