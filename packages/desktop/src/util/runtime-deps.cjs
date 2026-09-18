// 首启动态安装 kernel 运行时依赖（bun --compile 单二进制形态）。
// 背景：编译产物内联了全部 JS 依赖，只有 4 个包必须在磁盘 node_modules：
//   ① 原生 .node（@napi-rs/keyring，--external）；② pi RPC 子进程入口（pi-coding-agent/dist/cli.js）；
//   ③ 内置扩展（pi-web-access、pi-mcp-adapter）。
// .app 内 Resources/kernel 只读，不能就地 install，故：
//   seed  （.app 只读）：package.json + bun.lock（内核二进制不进 runtime——见 SEED_FILES 注释）
//   runtime（WA_PI_DIR/runtime 可写，默认 ~/.pi/agent/runtime）：复制 seed → 编译产物以
//   BUN_BE_BUN=1 充当 bun CLI 执行 install 产出 node_modules → spawn 编译产物跑 kernel。
// 用 .installed-version 标记触发升级重装；默认阿里源(npmmirror)，失败回退官方源。
//
// 依赖重装判定（2026-09-18 修正）：标记内容 =「app 版本 \t 依赖清单指纹」，判定只看指纹。
// 原实现按 app 版本号判定，导致每次发版（哪怕依赖一字未改）都重跑一轮 bun install：
// 生产日志实测 version=0.4.7/installed=0.4.5 触发的重装，bun 自己报
// "Checked 332 installs across 378 packages (no changes)"，白付一次子进程 95MB 镜像启动
// （2.2~5.5s；冷网络下 26s+ 的下载还叠加在上面）。指纹取 package.json + bun.lock 内容哈希：
// 依赖真变了才会变，版本号无关。旧格式标记（纯版本号）无法比对指纹 → 重装一次完成迁移。
//
// 坑位记录：bun install 退出码 0 不等于依赖可用（半装仍 0 退出）。因此：
// ① 安装必须带 --ignore-scripts（跳过所有 lifecycle scripts——keyring 经 optionalDependencies
//   分发平台预编译 .node 变体，无需任何编译环节，网络通即 100% 成功）；
// ② 安装后 verifyInstall 校验顶层依赖真实存在，失败则清理 node_modules 重装（installWithRetry）；
// ③ 全部失败不写标记 → 下次启动自动重试（门禁）。
// patch 不需要复制：patch 编译期已生效（--compile 内联的是已 patch 源码），
// 运行时磁盘 node_modules 无 pi-mcp-adapter。
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

// 语言来源：桌面主进程通过 onStatus 把进度文案透传给用户（desktop 无 react-i18next）。
// 本模块在 bun 测试环境下无 electron，故延迟探测；非 Electron 环境回退 zh。
const MSG = {
	zh: {
		downloading: "正在下载依赖…",
		downloadingN: "正在下载依赖… {{n}} 个包",
	},
	en: {
		downloading: "Downloading dependencies…",
		downloadingN: "Downloading dependencies… {{n}} packages",
	},
};
let cachedLocale;
function detectDesktopLocale() {
	if (cachedLocale) return cachedLocale;
	try {
		// 仅在实际 Electron 进程才 require("electron")：非 Electron（如 bun 测试）下
		// require("electron") 会触发二进制下载并阻塞/超时，故先验 process.versions.electron。
		if (!process.versions.electron) throw new Error("非 Electron 进程");
		const { app } = require("electron");
		cachedLocale = String(app.getLocale()).startsWith("zh") ? "zh" : "en";
	} catch {
		cachedLocale = "zh";
	}
	return cachedLocale;
}
// t()：字典查询 + 可选参数插值（{{key}} 用法）。
const t = (k, params) => {
	let s = MSG[detectDesktopLocale()][k] ?? MSG.zh[k];
	if (params) {
		for (const [key, val] of Object.entries(params)) {
			s = s.replace(`{{${key}}}`, String(val));
		}
	}
	return s;
};

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";
const KERNEL_BIN =
	process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";
// ⚠️ 内核二进制**不在** seed 拷贝清单里（2026-09-18 修正）：
//   ① spawn 用的是随包 seed 路径（main.cjs 的 kernelExe：resources/kernel/WaPiKernel），
//      runtime 里那份副本无任何读取方；ensureRuntimeBinLinks 的 bun/node 链接也指向 seed。
//   ② 自 da951491「移除内核独立打包与独立升级机制」后，runtime 已不再承载内核二进制。
//   ③ 而旧实现每次启动都把它从安装包拷到 runtime（≈95MB 写入 + 杀软对"新写入大文件"的
//      实时扫描），属启动路径上的纯浪费（本机 NVMe 实测 30~57ms，慢盘/开实时防护的机器更贵）。
// 故只同步 install 与"关于页内核版本"真正需要的两个清单文件。
const SEED_FILES = ["package.json", "bun.lock"];

// seed 遗留：老用户 runtime 目录升级时清理，避免与新形态混淆。
// kernel.js 属 kernel.js 时代（≤0.2.15）；.kernel-version 属已移除的「内核独立更新」
// 机制（0.2.21~）残留标记——内核一律以随包 seed 为准，该标记不再有任何含义。
// WaPiKernel(.exe) 是老版本 syncSeed 拷进 runtime 的内核副本（da951491 后无人读取），
// 一并回收（约 95MB）。
const LEGACY_FILES = [
	KERNEL_BIN,
	"kernel.js",
	"tool-schemas.ts",
	"wa-pi-bridge.extension.ts",
	"file-snapshot.ts",
	"patches",
	".kernel-version",
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
// 并清理历史遗留文件。内核一律以随包 seed 为准：升级 app 即升级内核。
async function syncSeed(seedDir, runtimeDir, log) {
	await fsp.mkdir(runtimeDir, { recursive: true });
	for (const f of SEED_FILES) {
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
			if (m && onStatus) onStatus(t("downloadingN", { n: m[1] }));
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

// 依赖清单指纹：决定「要不要重装」的是依赖内容本身，不是 app 版本号（见文件头注释）。
// 只取两个真正决定 node_modules 内容的文件；文件缺失按空内容计入（指纹仍稳定、不抛错）。
const FINGERPRINT_FILES = ["package.json", "bun.lock"];

async function computeDepsFingerprint(dir) {
	const hash = crypto.createHash("sha256");
	for (const f of FINGERPRINT_FILES) {
		hash.update(f);
		hash.update("\0");
		hash.update(
			await fsp.readFile(path.join(dir, f)).catch(() => Buffer.alloc(0)),
		);
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

// 标记解析：新格式「<app 版本>\t<依赖指纹>」；旧格式（纯 app 版本号）指纹为空，
// 表示「无从比对依赖指纹」→ 安全起见重装一次完成迁移。
async function readInstallMarker(marker) {
	return await fsp.readFile(marker, "utf8").catch(() => "");
}

function parseInstallMarker(text) {
	const [version = "", fingerprint = ""] = String(text ?? "").split("\t");
	return { version: version.trim(), fingerprint: fingerprint.trim() };
}

// 是否跳过 install（纯函数，便于穷举决策表）：
// 只有「node_modules 在 + 标记里的指纹与当前依赖清单指纹一致」才跳过——
// app 版本号变化不再触发重装，依赖清单真变了才会。
function shouldSkipInstall({ nodeModulesExists, markerText, fingerprint }) {
	if (!nodeModulesExists) return false;
	const installed = parseInstallMarker(markerText).fingerprint;
	return Boolean(installed) && installed === fingerprint;
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
	// 依赖注入（测试用，可选）：默认全走真实实现，生产行为不变。
	//   runInstall      替换 runInstall（测试不真 spawn 95MB 编译产物）
	//   verifyInstallFn 替换 verifyInstall（产物校验另有独立测试覆盖）
	deps = {},
}) {
	const { runInstall: runInstallFn = runInstall, verifyInstallFn = verifyInstall } =
		deps;
	if (!isPackaged) return seedDir;

	const marker = path.join(runtimeDir, ".installed-version");
	const nmExists = await exists(path.join(runtimeDir, "node_modules"));

	// 始终同步 seed 清单文件（依赖可能随版本变；内核二进制不在 seed 里，见 SEED_FILES 注释）
	await syncSeed(seedDir, runtimeDir, log);

	// 指纹在 syncSeed 之后算：比对的必须是「本次随包带来的依赖清单」
	const markerText = nmExists ? await readInstallMarker(marker) : "";
	const fingerprint = await computeDepsFingerprint(runtimeDir);
	if (shouldSkipInstall({ nodeModulesExists: nmExists, markerText, fingerprint })) {
		const { version: installedVer } = parseInstallMarker(markerText);
		log.info(
			`[deps] 依赖清单未变（已装于 v${installedVer}，fingerprint=${fingerprint}），跳过 install`,
		);
		return runtimeDir;
	}
	if (nmExists && !parseInstallMarker(markerText).fingerprint) {
		log.info(
			`[deps] 旧格式标记（installed=${markerText.trim() || "无"}）无法比对依赖指纹，重装一次完成迁移`,
		);
	}

	log.info(
		`[deps] 需要安装依赖 (version=${version}, installed=${markerText.trim() || "无"}, fingerprint=${fingerprint})`,
	);

	const registries = [
		process.env.WA_PI_REGISTRY || DEFAULT_REGISTRY,
		FALLBACK_REGISTRY,
	];
	if (onStatus) onStatus(t("downloading"));
	// 主源 → 回退源，安装后校验产物；失败清理 node_modules 再重试一轮。
	// 全部失败时抛错（main.cjs 显示错误页），不写标记 → 下次启动自动重试（兜底）。
	await installWithRetry({
		registries,
		install: (registry) =>
			runInstallFn({ kernelExe, runtimeDir, registry, log, onStatus }),
		verify: () => verifyInstallFn(runtimeDir, log),
		cleanup: () => rmNodeModules(runtimeDir, log),
		log,
	});
	// 标记写「app 版本 \t 依赖指纹」：下次启动只比对指纹，与版本号无关
	await fsp.writeFile(marker, `${version}\t${fingerprint}`, "utf8").catch(() => {});
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
	computeDepsFingerprint,
	parseInstallMarker,
	shouldSkipInstall,
	DEFAULT_REGISTRY,
	FALLBACK_REGISTRY,
};
