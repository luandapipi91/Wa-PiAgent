// Windows 签名支撑模块：工具定位 + 签名校验 + 内核清单刷新。
//
// 分工：签名动作本身交给 electron-builder 内置的 osslsigncode 路径（它按正确顺序处理
// 主程序 resEdit 之后再签、extraResources 的 exe、NSIS 安装包与卸载器，并在签名之后
// 才计算 blockmap 与 latest.yml 的 sha512）。本模块只负责 electron-builder 不管的三件事：
//   ① 找到可用的 osslsigncode（优先 electron-builder 缓存里 winCodeSign 自带的版本，
//      不依赖系统 openssl；PATH/环境变量可覆盖）；
//   ② 签名会改变 kernel exe 大小，而应用启动的壳/核一致性自检按大小比对
//      → 打包后刷新 resources/kernel/manifest.json 的 exe.size/sha256；
//   ③ 产物落盘后校验签名确实存在 + latest-win.yml 的哈希与已签名安装包一致
//      （签完不重算清单会让 Windows OTA 直接失败）。
//
// 实测要点（macOS + winCodeSign-2.6.0 自带 osslsigncode）：
//   · 该版本的 verify 对「没有签名」的文件**退出码仍是 0**，判定只能解析输出文本；
//   · 该版本能覆盖已存在的输出文件，也不需要 stdin 为 tty——但仍显式把 stdin 设为
//     ignore：新版 osslsigncode 在 stdin 是管道时会去读密码，读到 EOF 就报
//     "Failed to read certificate from: (null)"。
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * 解析 osslsigncode verify 的输出文本。
 * 注意 `No signature found.` / `Succeeded` 会同时出现，退出码不可信。
 */
function parseVerifyOutput(text) {
	const t = String(text || "");
	const countMatch =
		t.match(/Number of signers:\s*(\d+)/i) ||
		t.match(/Number of verified signatures:\s*(\d+)/i);
	const count = countMatch ? Number(countMatch[1]) : 0;
	const failed = /Signature verification:\s*failed/i.test(t);
	const noSignature = /No signature found/i.test(t);
	const okHint = /Signature verification:\s*ok/i.test(t);
	const signed = !failed && !noSignature && (count > 0 || okHint);
	const subjectMatch = t.match(/Subject:\s*(\/?.+)/);
	return {
		signed,
		count,
		subject: signed && subjectMatch ? subjectMatch[1].trim() : null,
		timestamp: /timestamp/i.test(t),
	};
}

/** 版本号自然排序比较（winCodeSign-2.10.0 > winCodeSign-2.6.0）。 */
function compareWinCodeSignDir(a, b) {
	const parse = (n) =>
		n
			.replace("winCodeSign-", "")
			.split(".")
			.map((x) => Number.parseInt(x, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pb[i] || 0) - (pa[i] || 0); // 降序：新版本优先
		if (d !== 0) return d;
	}
	return 0;
}

/** 二进制同目录若有 lib/，用 DYLD_LIBRARY_PATH 带出（winCodeSign 的 mac 版依赖它）。 */
function withLibEnv(binPath, exists) {
	const lib = path.join(path.dirname(binPath), "lib");
	return exists(lib)
		? { path: binPath, env: { DYLD_LIBRARY_PATH: lib } }
		: { path: binPath, env: {} };
}

/**
 * 定位 osslsigncode：WA_PI_OSSLSIGNCODE > electron-builder 的 winCodeSign 缓存 > null。
 * @returns {{path: string, env: Record<string,string>} | null}
 */
function resolveOsslsigncode({
	env = process.env,
	home = os.homedir(),
	exists = fs.existsSync,
	readdir = fs.readdirSync,
} = {}) {
	const explicit = String(env.WA_PI_OSSLSIGNCODE || "").trim();
	if (explicit) return withLibEnv(explicit, exists);

	const cacheRoot = env.ELECTRON_BUILDER_CACHE
		? path.join(env.ELECTRON_BUILDER_CACHE, "winCodeSign")
		: path.join(home, "Library", "Caches", "electron-builder", "winCodeSign");
	if (exists(cacheRoot)) {
		const versions = readdir(cacheRoot)
			.filter((n) => n.startsWith("winCodeSign-"))
			.sort(compareWinCodeSignDir);
		for (const version of versions) {
			for (const rel of ["darwin/10.12/osslsigncode", "darwin/osslsigncode"]) {
				const bin = path.join(cacheRoot, version, rel);
				if (exists(bin)) return withLibEnv(bin, exists);
			}
		}
	}
	return null;
}

/**
 * 校验单个文件的签名。工具不可用即抛错（绝不静默放行）。
 * @returns {{signed: boolean, count: number, subject: string|null, timestamp: boolean, detail: string}}
 */
function verifySignature(file, { tool, exec = execFileSync } = {}) {
	const resolved = tool === undefined ? resolveOsslsigncode() : tool;
	if (!resolved) {
		throw new Error(
			"[win-sign] 找不到 osslsigncode，无法校验 Windows 产物签名。修复：① 先跑一次 win 打包让 electron-builder 下载 winCodeSign（含 osslsigncode）；② 或安装 osslsigncode 并设 USE_SYSTEM_OSSLSIGNCODE=1；③ 或用 WA_PI_OSSLSIGNCODE=<路径> 指定",
		);
	}
	// stdin 必须 ignore：新版 osslsigncode 在 stdin 是管道时会去读密码（读到 EOF → null）
	const opts = {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		env: { ...process.env, ...resolved.env },
	};
	try {
		const out = exec(resolved.path, ["verify", "-in", file], opts);
		return { ...parseVerifyOutput(out), detail: "verify" };
	} catch (e) {
		const text = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join("\n");
		return { ...parseVerifyOutput(text), detail: "verify-error" };
	}
}

/**
 * 签名会改变 kernel exe 大小 → 刷新 manifest.json 的 exe.size/sha256，
 * 否则应用启动时的壳/核一致性自检会误报 size-mismatch。
 * 写入格式与 build-kernel-sidecar.ts 保持一致（tab 缩进、无尾随换行）。
 */
function refreshKernelManifest(kernelDir) {
	const manifestPath = path.join(kernelDir, "manifest.json");
	let raw;
	try {
		raw = fs.readFileSync(manifestPath, "utf8");
	} catch {
		return { updated: false, reason: "manifest-missing" };
	}
	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch {
		return { updated: false, reason: "manifest-corrupt" };
	}
	const exeName = manifest?.exe?.name;
	if (!exeName) return { updated: false, reason: "no-exe-entry" };
	let buf;
	try {
		buf = fs.readFileSync(path.join(kernelDir, exeName));
	} catch {
		return { updated: false, reason: "exe-missing" };
	}
	const size = buf.length;
	const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
	const before = { size: manifest.exe.size, sha256: manifest.exe.sha256 };
	if (before.size === size && before.sha256 === sha256) {
		return { updated: false, before, after: before };
	}
	manifest.exe.size = size;
	manifest.exe.sha256 = sha256;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	return { updated: true, before, after: { size, sha256 } };
}

/** 必须带签名的产物：主程序、内核 exe、各 .exe 安装包（不存在/非 exe 的自动跳过）。 */
function collectVerifyTargets({ appOutDir, productFilename, artifactPaths = [] }) {
	const mainExe = path.join(appOutDir, `${productFilename}.exe`);
	if (!fs.existsSync(mainExe)) {
		throw new Error(
			`[win-sign] 未找到主程序 ${mainExe}（Windows 构建必有主程序，拒绝静默跳过校验）`,
		);
	}
	const candidates = [
		mainExe,
		path.join(appOutDir, "resources", "kernel", "WaPiKernel.exe"),
		...artifactPaths,
	];
	const seen = new Set();
	const out = [];
	for (const file of candidates) {
		if (!file.endsWith(".exe") || seen.has(file) || !fs.existsSync(file)) continue;
		seen.add(file);
		out.push(file);
	}
	return out;
}

/** 全量校验；任何产物没有签名即抛错（坏包不许流入 release/）。 */
function verifyWindowsArtifacts(
	options,
	{ collectTargets = collectVerifyTargets, verify = verifySignature } = {},
) {
	const targets = collectTargets(options);
	if (targets.length === 0) {
		throw new Error(
			`[win-sign] 未找到需要校验签名的 Windows 产物（appOutDir=${options.appOutDir}），拒绝静默跳过`,
		);
	}
	const results = targets.map((file) => ({ file, ...verify(file) }));
	const missing = results.filter((r) => !r.signed);
	if (missing.length > 0) {
		throw new Error(
			`[win-sign] 以下 Windows 产物没有有效签名，终止打包：${missing
				.map((m) => m.file)
				.join(", ")}`,
		);
	}
	return results;
}

/**
 * latest-win.yml 的 sha512/size 必须等于最终（已签名）安装包。
 * 签名若发生在清单生成之后，哈希会失配 → 已装用户 OTA 校验失败。
 */
function checkWinYmlHash({ ymlPath, installerPath, exists = fs.existsSync }) {
	if (!ymlPath || !installerPath || !exists(ymlPath) || !exists(installerPath)) {
		return { ok: true, skipped: true };
	}
	const yml = fs.readFileSync(ymlPath, "utf8");
	const buf = fs.readFileSync(installerPath);
	const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
	const listedSha = (yml.match(/sha512:\s*(\S+)/) || [])[1];
	const listedSize = Number((yml.match(/size:\s*(\d+)/) || [])[1]);
	const reasons = [];
	if (listedSha !== sha512) reasons.push("sha512 不一致");
	if (listedSize !== buf.length) reasons.push("size 不一致");
	return {
		ok: reasons.length === 0,
		reasons,
		listed: { sha512: listedSha || null, size: listedSize || null },
		actual: { sha512, size: buf.length },
	};
}

/**
 * 把 latest.yml 的 sha512/size 对齐到最终（已签名）安装包。
 *
 * 为什么需要：electron-builder 有可能在签名前后不同的时机计算清单哈希（实测出现过清单
 * 记的是签名前大小、而盘上安装包已被签名的情况）。签名会让文件大小变化，清单一旦失配，
 * 已装用户的 Windows OTA 校验必失败（往期 mac 0.9.1 断更新同类事故）。
 * 做法与 mac 分支修正 latest-mac.yml 一致：只替换 sha512/size，其余字段原样保留。
 */
function syncWinYmlHash({ ymlPath, installerPath, exists = fs.existsSync }) {
	if (!ymlPath || !installerPath || !exists(ymlPath) || !exists(installerPath)) {
		return { skipped: true, fixed: false };
	}
	const check = checkWinYmlHash({ ymlPath, installerPath, exists });
	if (check.ok) return { fixed: false, skipped: false };
	const body = fs.readFileSync(installerPath);
	const sha512 = crypto.createHash("sha512").update(body).digest("base64");
	// 逐行只改已知字段（files[] 项缩进 4 空格、顶层无缩进），且每项只改第一次出现：
	// 用全局正则会把 releaseNotes 正文里的「sha512: …」「size: 123」一并改掉。
	const lines = fs.readFileSync(ymlPath, "utf8").split("\n");
	let fileShaDone = false;
	let topShaDone = false;
	let sizeDone = false;
	for (let i = 0; i < lines.length; i++) {
		if (!fileShaDone && /^ {4}sha512:/.test(lines[i])) {
			lines[i] = `    sha512: ${sha512}`;
			fileShaDone = true;
		} else if (!topShaDone && /^sha512:/.test(lines[i])) {
			lines[i] = `sha512: ${sha512}`;
			topShaDone = true;
		} else if (!sizeDone && /^ {4}size:/.test(lines[i])) {
			lines[i] = `    size: ${body.length}`;
			sizeDone = true;
		}
	}
	fs.writeFileSync(ymlPath, lines.join("\n"));
	return { fixed: true, skipped: false, before: check.listed, after: check.actual };
}

/**
 * Windows 打包收尾校验（必须在 electron-builder 进程退出后调用）。
 *
 * latest.yml 是 electron-builder 在 afterAllArtifactBuild 钩子**之后**才写的
 * （PublishManager.awaitTasks 在 executeFinally 里），所以清单一致性只能在外层做：
 * 签名会改变安装包大小，若清单记的是签名前的大小，已装用户 Windows OTA 校验必失败。
 * 这里做两件事：安装包必须存在；清单哈希不一致就地对齐，对齐后复核。
 */
function verifyWindowsRelease({ outDir, version, exists = fs.existsSync }) {
	const exes = fs
		.readdirSync(outDir)
		.filter(
			(f) =>
				f.endsWith(".exe") &&
				!f.includes("__uninstaller") &&
				!f.includes("-signed-"),
		);
	// 精确匹配 `-<version>.exe`：release/ 会累积历史版本，用 includes 子串会把
	// 0.10.1 误配成 0.10.10/0.10.11/0.10.12（readdir 顺序碰运气）。
	let installerName = null;
	if (version) {
		installerName = exes.find((f) => f.endsWith(`-${version}.exe`)) || null;
	} else {
		// 未给版本（非发版场景）：取最新修改的那个
		installerName =
			exes
				.map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
				.sort((a, b) => b.m - a.m)[0]?.f || null;
	}
	if (!installerName) {
		throw new Error(
			`[win-sign] 未找到 Windows 安装包（目录 ${outDir}，期望 *-${version ?? "<任意版本>"}.exe），产物目录异常，拒绝宣告成功`,
		);
	}
	const installerPath = path.join(outDir, installerName);
	const ymlPath = path.join(outDir, "latest.yml");
	if (!exists(ymlPath)) {
		return {
			ok: false,
			reason: "缺少 latest.yml（electron-updater 依赖它判断新版本，发布脚本会拦下）",
			installer: installerPath,
			fixed: false,
		};
	}
	// 守卫：清单必须指向本次待校验的安装包。否则（例如拿旧版本包去比对、或清单是上一版
	// 残留）绝不能"顺手改写"清单——那会把线上清单指向错误产物。
	const ymlText = fs.readFileSync(ymlPath, "utf8");
	const listedPath =
		(ymlText.match(/^path:\s*(\S+)/m) || [])[1] ||
		(ymlText.match(/^\s+- url:\s*(\S+)/m) || [])[1];
	const installerBase = path.basename(installerPath);
	if (listedPath && listedPath !== installerBase) {
		throw new Error(
			`[win-sign] 清单指向 ${listedPath}，与待校验的 ${installerBase} 不一致；拒绝改写 latest.yml（请确认产物目录未被其它版本污染）`,
		);
	}
	const synced = syncWinYmlHash({ ymlPath, installerPath, exists });
	const final = checkWinYmlHash({ ymlPath, installerPath, exists });
	return {
		ok: final.ok,
		reason: final.ok ? null : final.reasons.join("、"),
		installer: installerPath,
		ymlPath,
		fixed: synced.fixed,
		listed: final.listed,
		actual: final.actual,
	};
}

module.exports = {
	checkWinYmlHash,
	collectVerifyTargets,
	parseVerifyOutput,
	refreshKernelManifest,
	resolveOsslsigncode,
	syncWinYmlHash,
	verifySignature,
	verifyWindowsArtifacts,
	verifyWindowsRelease,
};
