// 启动时同步 kernel 二进制动态更新：拉 kernel-latest.json → 比对本地 build →
// 下载/校验/解压覆盖 runtime 的 WaPiKernel + package.json + bun.lock，并写 .kernel-version。
// 失败降级：绝不阻塞启动（只有依赖安装才阻塞）。
//
// 坑位（与 seed/runtime 关系有关）：
//   kernel 最终从 runtimeDir 启动，而非只读 seedDir。因此更新目标是 runtimeDir/KERNEL_BIN，
//   绝不能用传入的 kernelExe（它指向 seed）。`.kernel-version` 记录 runtimeDir 当前 build，
//   供 Task 4 runtime-deps.cjs 判定依赖是否需要重装。
// 安全：
//   解压前必须校验 zip 条目（防 zip-slip/路径穿越），只允许解压到 runtimeDir 内。
// 回滚：
//   备份旧 kernel 三件套 → 解压覆盖 → 写版本标记；任一环节失败则拷回备份，避免半更新状态。
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");

// 语言来源：桌面主进程通过 onStatus 把进度文案透传给用户（desktop 无 react-i18next）。
// 本模块在 bun 测试环境下无 electron，故延迟探测；非 Electron 环境回退 zh。
const MSG = {
	zh: { checkingKernelUpdate: "正在检查内核更新…" },
	en: { checkingKernelUpdate: "Checking kernel update…" },
};
let cachedLocale;
function detectDesktopLocale() {
	if (cachedLocale) return cachedLocale;
	try {
		const { app } = require("electron");
		cachedLocale = String(app.getLocale()).startsWith("zh") ? "zh" : "en";
	} catch {
		cachedLocale = "zh";
	}
	return cachedLocale;
}
const t = (k) => MSG[detectDesktopLocale()][k] ?? MSG.zh[k];

/** 默认内核更新清单 URL。清单按平台区分（多平台共存互不覆盖）：
 *   kernel-latest-<platform>.json，platform 形如 darwin-x64 / win32-x64 / linux-x64。
 *   旧版单清单（kernel-latest.json）仅保留向后兼容，不再新写入。 */
function defaultFeedUrl() {
	const platform = currentPlatform();
	return `https://oss.wapiagent.top/releases/kernel/kernel-latest-${platform}.json`;
}
const KERNEL_BIN =
	process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";

// 更新涉及的文件：kernel 二进制 + 依赖清单（seed 三件套） + 版本标记
const KERNEL_FILES = [
	KERNEL_BIN,
	"package.json",
	"bun.lock",
	".kernel-version",
];
const BACKUP_DIR = ".kernel-update-backup";
const ZIP_PREFIX = ".kernel-update-";

// 当前进程的平台标识，与 publish-kernel.ts 的 platformFor 一致：
// win→win32-<arch>, linux→linux-<arch>, darwin→darwin-<arch>；arch 为 arm64 否则 x64。
// 用于校验远程清单的 platform 强相关字段，防止异平台「半更新」。
function currentPlatform() {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${process.platform}-${arch}`;
}

async function exists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

// 读本地 .kernel-version（不存在返回 null）
async function readLocalBuild(runtimeDir) {
	try {
		return (
			await fsp.readFile(path.join(runtimeDir, ".kernel-version"), "utf8")
		).trim();
	} catch {
		return null;
	}
}

// build 解析：<YYYYMMDD>-<seq> → { date, seq }；无法解析（非字符串、日期非 8 位数字、seq 非数字）返回 null。
function parseBuild(build) {
	if (typeof build !== "string" || !build) return null;
	const m = /^(\d{8})-(\d+)$/.exec(build);
	if (!m) return null;
	return { date: Number(m[1]), seq: Number(m[2]) };
}

// 数值语义比较：按 date + seq 数值判定（seq 未零填充也稳健）；任一解析失败回退字符串比较。
function compareBuild(a, b) {
	const pa = parseBuild(a);
	const pb = parseBuild(b);
	if (pa && pb) {
		if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1;
		if (pa.seq !== pb.seq) return pa.seq < pb.seq ? -1 : 1;
		return 0;
	}
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

// build 比较：manifest 无 build → 不更新；本地无有效 build（首次/空）→ 更新；
// 否则仅当远端 build 更大才更新（同值不更新，降级不覆盖），防止 OSS 清单滞后把本地回退。
// build 格式 <YYYYMMDD>-<seq>，seq 未零填充（如 -9/-10）时字符串字典序会失准，故按数值比较。
function needsUpdate(localBuild, manifest) {
	if (!manifest?.build) return false;
	if (!localBuild) return true;
	return compareBuild(manifest.build, localBuild) > 0;
}

// sha256 校验：读文件算 hash，与清单值（大小写不敏感）比对
async function verifySha256(filePath, expected) {
	const buf = await fsp.readFile(filePath);
	const hash = createHash("sha256").update(buf).digest("hex");
	return hash === String(expected || "").toLowerCase();
}

// 拉远程清单（fetch 注入）：网络/HTTP/解析失败均返回 null（降级到跳过更新）。
// fetchImpl 声明为宽松可调用类型：测试桩只需返回带 ok/json() 的对象，不必是完整 DOM Response。
/**
 * @param {(url: string, init?: any) => Promise<any>} fetchImpl
 * @param {string} url
 */
async function fetchManifest(fetchImpl, url) {
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// 判断 zip 条目是否安全（防路径穿越/zip-slip）：
// 拒绝空白、绝对路径、Windows 盘符、含 `..` 段的条目。
function isSafeZipEntry(entry) {
	const name = String(entry || "")
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "");
	if (!name) return false;
	if (name.startsWith("/")) return false; // 绝对路径
	if (/^[a-zA-Z]:/.test(name)) return false; // 盘符（如 C:\evil）
	if (name.split("/").some((s) => s === "..")) return false; // 上级目录逃逸
	return true;
}

// 列出 zip 条目名（用于解压前安全校验）。macOS/Linux 用 unzip -Z1，Windows 交叉用 tar -tf。
function listZipEntries(zipPath) {
	return new Promise((resolve, reject) => {
		const isWin = process.platform === "win32";
		const args = isWin ? ["-tf", zipPath] : ["-Z1", zipPath];
		const child = spawn(isWin ? "tar" : "unzip", args, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (b) => {
			out += b.toString();
		});
		child.on("error", (e) =>
			reject(new Error(`列出 zip 条目失败: ${e.message}`)),
		);
		child.on("exit", (code) => {
			if (code !== 0) return reject(new Error(`列出 zip 条目退出码 ${code}`));
			resolve(
				out
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
			);
		});
	});
}

// 【安全】仅当 zip 全部条目都安全（不会写到 targetDir 之外）时才允许解压。
async function assertSafeZip(zipPath) {
	const entries = await listZipEntries(zipPath);
	const bad = entries.find((e) => !isSafeZipEntry(e));
	if (bad) throw new Error(`zip 含不安全条目，已拒绝解压: ${bad}`);
	if (!entries.length) throw new Error("zip 为空，已拒绝解压");
	return entries;
}

// 解压 zip 到 targetDir（macOS/Linux 用 unzip，Windows 交叉环境用 tar）。
// 先校验条目安全（防 zip-slip），再解压；校验失败或子进程异常 → 抛错（由调用方回滚）。
async function extractZip(zipPath, targetDir, log) {
	await assertSafeZip(zipPath);
	await new Promise((resolve, reject) => {
		const isWin = process.platform === "win32";
		const args = isWin
			? ["-xf", zipPath, "-C", targetDir]
			: ["-o", zipPath, "-d", targetDir];
		const child = spawn(isWin ? "tar" : "unzip", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let err = "";
		child.stderr.on("data", (b) => {
			err += b.toString();
		});
		child.on("error", (e) => reject(new Error(`解压失败: ${e.message}`)));
		child.on("exit", (code) => {
			if (code === 0) return resolve();
			reject(new Error(`解压退出码 ${code}${err ? `: ${err.slice(-200)}` : ""}`));
		});
	});
}

// 备份旧 kernel → 解压覆盖 → 写 .kernel-version；任一环节失败则回滚备份。
// 变更目标统一用 runtimeDir/KERNEL_BIN（不要用指向 seed 的 kernelExe）。
async function applyKernelUpdate({
	runtimeDir,
	zipPath,
	manifest,
	log,
	backupDir,
}) {
	const bk = backupDir || path.join(runtimeDir, BACKUP_DIR);
	await fsp.mkdir(bk, { recursive: true });

	// 1. 记录哪些文件原本存在（决定回滚时是「拷回旧内容」还是「删除新产物」），并备份旧内容
	const existedBefore = new Set();
	for (const f of KERNEL_FILES) {
		const src = path.join(runtimeDir, f);
		if (await exists(src)) {
			await fsp.copyFile(src, path.join(bk, f));
			existedBefore.add(f);
		}
	}

	// 2-3. 解压覆盖 + 写版本标记；失败则回滚，保证不留下半更新状态
	try {
		await extractZip(zipPath, runtimeDir, log);
		await fsp.writeFile(
			path.join(runtimeDir, ".kernel-version"),
			manifest.build,
			"utf8",
		);
	} catch (e) {
		for (const f of KERNEL_FILES) {
			const target = path.join(runtimeDir, f);
			if (existedBefore.has(f)) {
				// 原本存在 → 拷回旧内容，覆盖已写入的新产物
				await fsp
					.copyFile(path.join(bk, f), target)
					.catch((err) =>
						log?.warn(`[kernel-updater] 回滚 ${f} 失败: ${err.message}`),
					);
			} else {
				// 原本不存在 → 删除解压产物 / 版本标记，还原到「无」状态
				await fsp.rm(target, { force: true }).catch(() => {});
			}
		}
		await fsp.rm(bk, { recursive: true, force: true }).catch(() => {});
		throw e;
	}

	// 4. 更新成功，清理备份
	await fsp.rm(bk, { recursive: true, force: true }).catch(() => {});
}

// 主入口：同步 kernel 二进制。全程失败降级（返回 failed），绝不向上抛（不阻塞启动）。
// fetchImpl 为宽松可调用类型（见 fetchManifest），未注入时回退全局 fetch。
/**
 * @param {{
 *   seedDir?: string,
 *   runtimeDir: string,
 *   kernelExe?: string,
 *   version?: string,
 *   feedUrl?: string,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   log?: any,
 *   onStatus?: (t: string) => void,
 *   backupDir?: string,
 * }} opts
 */
async function syncKernel({
	seedDir,
	runtimeDir,
	kernelExe,
	version,
	feedUrl,
	fetchImpl,
	log,
	onStatus,
	backupDir,
}) {
	// 未注入时用全局 fetch（Node 18+）。不写成默认参数，避免 TS 把 fetchImpl 推断成
	// typeof fetch 而让测试桩函数报缺 preconnect 的类型告警；行为完全等价。
	const doFetch = fetchImpl || globalThis.fetch;
	const url = feedUrl || defaultFeedUrl();
	// M9：全新安装首次启动时 runtimeDir（WA_PI_DIR/runtime）可能尚未创建，先确保存在，
	// 否则后续写 zip 会抛 ENOENT → 首次启动误判更新失败并跳过 kernel 同步。
	await fsp.mkdir(runtimeDir, { recursive: true });
	const manifest = await fetchManifest(doFetch, url);
	if (!manifest) {
		log?.info("[kernel-updater] 清单不可用，跳过更新");
		return { status: "up-to-date" };
	}

	// C1：kernel 二进制平台强相关。清单声明的 platform 若与当前进程平台不一致，
	// 直接跳过更新（返回 up-to-date），避免出现「解压成功但二进制名不等于本平台
	// KERNEL_BIN，而 package.json/bun.lock/.kernel-version 却被更新」的半更新状态。
	const platform = currentPlatform();
	if (manifest.platform && manifest.platform !== platform) {
		log?.info(
			`[kernel-updater] 清单平台 ${manifest.platform} 与当前平台 ${platform} 不匹配，跳过更新`,
		);
		return { status: "up-to-date" };
	}

	const localBuild = await readLocalBuild(runtimeDir);
	if (!needsUpdate(localBuild, manifest)) return { status: "up-to-date" };

	log?.info(
		`[kernel-updater] 发现新 build ${manifest.build}（本地 ${localBuild || "无"}）`,
	);
	onStatus?.(t("checkingKernelUpdate"));

	const zipName = manifest.url || `kernel-${manifest.build}.zip`;
	const zipUrl = /^https?:\/\//i.test(zipName)
		? zipName
		: new URL(zipName, url).href;
	const zipPath = path.join(runtimeDir, `${ZIP_PREFIX}${manifest.build}.zip`);

	try {
		// 下载
		const res = await doFetch(zipUrl, {
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
		await fsp.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

		// 校验：失败即删除临时文件（fail-safe，不更新未校验二进制）
		if (!(await verifySha256(zipPath, manifest.sha256))) {
			await fsp.rm(zipPath, { force: true });
			throw new Error("sha256 校验失败，已删除临时文件");
		}

		// 应用（内部含备份 + 失败回滚）
		const bk = backupDir || path.join(runtimeDir, BACKUP_DIR);
		await applyKernelUpdate({
			runtimeDir,
			zipPath,
			manifest,
			log,
			backupDir: bk,
		});

		await fsp.rm(zipPath, { force: true });
		// package.json 一旦变化由 runtime-deps.cjs 判定是否重装（本任务只写 .kernel-version）
		log?.info(`[kernel-updater] ✅ 已更新到 build ${manifest.build}`);
		return { status: "updated", build: manifest.build };
	} catch (e) {
		log?.error("[kernel-updater] 更新失败，降级继续", e);
		// 清理临时 zip（下载/校验/解压失败都不留残余）
		await fsp.rm(zipPath, { force: true }).catch(() => {});
		return { status: "failed", error: e.message };
	}
}

module.exports = {
	syncKernel,
	readLocalBuild,
	needsUpdate,
	verifySha256,
	fetchManifest,
	extractZip,
	applyKernelUpdate,
	isSafeZipEntry,
	currentPlatform,
	KERNEL_BIN,
	defaultFeedUrl,
};
