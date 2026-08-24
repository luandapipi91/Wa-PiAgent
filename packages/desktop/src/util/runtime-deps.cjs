// 首启动态安装 kernel 运行时依赖（bun --compile 单二进制形态）。
// 背景：编译产物内联了全部 JS 依赖，只有 4 个包必须在磁盘 node_modules：
//   ① 原生 .node（@napi-rs/keyring，--external）；② pi RPC 子进程入口（pi-coding-agent/dist/cli.js）；
//   ③ 内置扩展（pi-web-access、pi-mcp-adapter）。
// .app 内 Resources/kernel 只读，不能就地 install，故：
//   seed  （.app 只读）：WaPiKernel(.exe) + package.json + bun.lock
//   runtime（WA_PI_DIR/runtime 可写，默认 ~/.pi/agent/runtime）：复制 seed → 编译产物以
//   BUN_BE_BUN=1 充当 bun CLI 执行 install 产出 node_modules → spawn 编译产物跑 kernel。
// 用 .installed-version 标记触发升级重装；默认阿里源(npmmirror)，失败回退官方源。
//
// 坑位记录：bun install 退出码 0 不等于依赖可用（半装仍 0 退出）。因此：
// ① 安装必须带 --ignore-scripts（跳过所有 lifecycle scripts——keyring 经 optionalDependencies
//   分发平台预编译 .node 变体，无需任何编译环节，网络通即 100% 成功）；
// ② 安装后 verifyInstall 校验顶层依赖真实存在，失败则清理 node_modules 重装（installWithRetry）；
// ③ 全部失败不写标记 → 下次启动自动重试（门禁）。
// patch 不需要复制：patch 编译期已生效（--compile 内联的是已 patch 源码），
// 运行时磁盘 node_modules 无 pi-mcp-adapter。
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { readLocalBuild } = require("./kernel-updater.cjs");

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";
const KERNEL_BIN = process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";
const SEED_FILES = [KERNEL_BIN, "package.json", "bun.lock"];

// kernel.js 时代（≤0.2.15）的 seed 遗留：老用户 runtime 目录升级时清理，避免与新形态混淆
const LEGACY_FILES = [
	"kernel.js",
	"tool-schemas.ts",
	"wa-pi-bridge.extension.ts",
	"file-snapshot.ts",
	"patches",
];

async function exists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

// 复制 seed 文件到 runtime 目录（升级时覆盖旧二进制 / package.json / bun.lock），
// 并清理 kernel.js 时代的遗留文件。
// 动态 kernel 存在（runtimeDir 有 .kernel-version）时，KERNEL_BIN 不回退覆盖——
// 保留 kernel-updater 动态更新后的新二进制；package.json / bun.lock 仍随 seed 照常同步。
async function syncSeed(seedDir, runtimeDir, log, opts = {}) {
	await fsp.mkdir(runtimeDir, { recursive: true });
	// 判定「动态 kernel」：runtimeDir 已有 .kernel-version（被动态更新过）。
	// opts.kernelBuild 可预先传入（避免重复读文件），否则从 runtimeDir 读 .kernel-version 得到，
	// 读不到则为 null（首次/无动态标记 → 用 seed 覆盖 kernel）。
	let kernelBuild = opts.kernelBuild;
	if (kernelBuild == null) kernelBuild = await readLocalBuild(runtimeDir);
	const isDynamicKernel = kernelBuild != null;
	for (const f of SEED_FILES) {
		// 动态 kernel（runtimeDir 有 .kernel-version）：runtime 的 kernel 二进制 + package.json + bun.lock
		// 已是 kernel 动态更新后的最新版本（zip 内自带新依赖清单），不得用 seed 覆盖——seed 是 app 打包时
		// 捆绑的旧内核版本（如 0.1），覆盖会把 runtime 回退成旧清单、关于页内核版本显示旧值。
		// 依赖是否重装交由 ensureRuntimeDeps 按 build 号判定，不在此覆盖。
		if (isDynamicKernel) continue;
		const src = path.join(seedDir, f);
		if (!(await exists(src))) continue;
		await fsp.copyFile(src, path.join(runtimeDir, f));
	}
	for (const f of LEGACY_FILES) {
		await fsp
			.rm(path.join(runtimeDir, f), { recursive: true, force: true })
			.catch(() => {});
	}
	log.info(`[deps] seed → ${runtimeDir}`);
}

// 安装后产物校验：顶层依赖的 package.json 必须存在（校验失败说明安装未真正完成，
// 可能是网络中断导致的半装）。仅看 bun install 退出码会漏掉这类情况。
// 注意：不校验 keyring 的 .node 产物——@napi-rs/keyring 经 optionalDependencies
// 分发平台预编译 .node 变体，首启安装带 --ignore-scripts 不编译原生模块。
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
		"--ignore-scripts", // 跳过所有 lifecycle scripts（keyring 的 node-gyp 编译等），消除编译失败
		"--cwd",
		runtimeDir,
	];
}

// install 子进程 env（纯函数便于测试断言）：BUN_BE_BUN=1 让编译产物充当 bun CLI
// （bun 1.2.16+；编译产物默认运行内嵌应用，缺了它 install 不会执行）。
function buildInstallEnv(registry) {
	return {
		...process.env,
		BUN_BE_BUN: "1",
		BUN_CONFIG_REGISTRY: registry,
	};
}

function runInstall({ kernelExe, runtimeDir, registry, log, onStatus }) {
	return new Promise((resolve, reject) => {
		const args = buildInstallArgs(runtimeDir);
		const child = spawn(kernelExe, args, {
			cwd: runtimeDir,
			env: buildInstallEnv(registry),
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
	kernelBuild,
	log,
	onStatus,
}) {
	if (!isPackaged) return seedDir;

	// 依赖重装判定改按 kernel build 号：kernelBuild 优先（来自 .kernel-version），
	// 未传入时从 runtimeDir 读 .kernel-version 得到；读不到用 app version 兜底
	// （兼容旧版首次 / 未被动态更新过）。
	if (kernelBuild == null) kernelBuild = await readLocalBuild(runtimeDir);
	const buildToUse = kernelBuild || version;
	const marker = path.join(runtimeDir, ".installed-version");
	const nmExists = await exists(path.join(runtimeDir, "node_modules"));

	// 始终同步 seed 文件（编译产物可能同版本号重新构建，内容已变）
	await syncSeed(seedDir, runtimeDir, log, { kernelBuild });

	// syncSeed 在动态 kernel + seed 包清单变化时可能删除 .installed-version（触发重装）。
	// 必须在 syncSeed 之后读 markerVer：否则本会话仍用删除前的旧值判定，跳过真正需要的重装。
	const markerVer = nmExists
		? await fsp.readFile(marker, "utf8").catch(() => "")
		: "";

	if (nmExists && markerVer === buildToUse) {
		log.info(`[deps] node_modules 已安装 v${buildToUse}，跳过 install`);
		return runtimeDir;
	}

	log.info(
		`[deps] 需要安装依赖 (version=${buildToUse}, installed=${markerVer || "无"})`,
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
	await fsp.writeFile(marker, buildToUse, "utf8").catch(() => {});
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
	buildInstallEnv,
	DEFAULT_REGISTRY,
	FALLBACK_REGISTRY,
};
