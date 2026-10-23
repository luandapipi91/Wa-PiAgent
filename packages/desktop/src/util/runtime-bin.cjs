// 从 main.cjs 提取，使 findSystemNode + ensureRuntimeBinLinks 可独立测试。
// ensureRuntimeBinLinks 接收 isPackaged 参数（不依赖 Electron app 全局变量）。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

/** 搜索系统上的真实 Node.js 安装路径 */
function findSystemNode() {
	const exeName = process.platform === "win32" ? "node.exe" : "node";
	const pathSep = process.platform === "win32" ? ";" : ":";

	// 1. 优先检查 PATH（最可靠——能找到任何位置的 node：scoop/choco/volta/asdf 等）
	// 排除 wa-pi 自身的 binDir（里面的 node 是 bun fallback，不是真实 node）
	for (const dir of (process.env.PATH || "").split(pathSep)) {
		if (!dir || dir.includes(".pi" + path.sep + "agent")) continue;
		const p = path.join(dir, exeName);
		try {
			if (fs.existsSync(p)) return p;
		} catch {}
	}

	// 2. 补充检查常见固定路径（nvm/fnm 等可能不在当前进程 PATH 里）
	const candidates =
		process.platform === "win32"
			? [
					path.join(
						process.env.ProgramFiles || "C:\\Program Files",
						"nodejs",
						"node.exe",
					),
				]
			: [
					"/opt/homebrew/bin/node", // Apple Silicon Homebrew
					"/usr/local/bin/node", // Intel Homebrew / manual install
					"/usr/bin/node", // Xcode CLT / system
				];
	// also check common nvm paths
	const home = os.homedir();
	const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
	try {
		const versionsDir = path.join(nvmDir, "versions", "node");
		if (fs.existsSync(versionsDir)) {
			const versions = fs.readdirSync(versionsDir).sort().reverse();
			for (const v of versions) {
				const p =
					process.platform === "win32"
						? path.join(nvmDir, "versions", "node", v, "node.exe")
						: path.join(versionsDir, v, "bin", "node");
				if (fs.existsSync(p)) candidates.push(p);
			}
		}
	} catch {}
	// fnm
	try {
		const fnmDir = process.env.FNM_DIR || path.join(home, ".fnm");
		if (fs.existsSync(fnmDir)) {
			const aliasDefault = path.join(fnmDir, "aliases", "default");
			if (fs.existsSync(aliasDefault)) {
				const ver = fs.readFileSync(aliasDefault, "utf8").trim();
				const p = path.join(
					fnmDir,
					"node-versions",
					ver,
					"installation",
					"bin",
					"node",
				);
				if (fs.existsSync(p)) candidates.push(p);
			}
		}
	} catch {}
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

/**
 * Windows 路径 → MSYS/Git Bash 可用的 POSIX 路径（C:\\a\\b → /c/a/b）。
 * sh 脚本里反斜杠是转义符，不能直接写 Windows 路径。
 */
function toPosixPath(p) {
	if (!p) return p;
	if (process.platform !== "win32") return p;
	// UNC：\\server\share → //server/share
	if (/^[\\/]{2}/.test(p)) return p.replace(/\\/g, "/");
	const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
	if (!m) return p.replace(/\\/g, "/");
	return "/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/");
}

/**
 * 把目录前置到 PATH 最前（同目录已在 PATH 中时会移到最前而不是重复）。
 * 前置原因：shim 目录必须优先于系统 bun/node，否则同名的系统版本先命中。
 */
function buildRuntimePath(currentPath, dirs, sep) {
	const isWin = process.platform === "win32";
	const norm = (p) => (isWin ? p.toLowerCase() : p);
	const wanted = (dirs || []).filter(Boolean);
	const wantedSet = new Set(wanted.map(norm));
	const rest = String(currentPath || "")
		.split(sep)
		.filter(Boolean)
		.filter((d) => !wantedSet.has(norm(d)));
	return [...wanted, ...rest].join(sep);
}

/**
 * 为 packaged 运行环境补充 bun/node 命令，供动态插件安装/运行 npm 包工具。
 * 有真实 node 时 binDir 放 bun.cmd + 无后缀 bun（后者给 Git Bash；node/npm/npx 由 node 自带）；
 * 无 node 时 bun fallback，binDir 生成 node/npx/npm 包装脚本。
 *
 * @param {Object} opts
 * @param {string} opts.kernelExe - WaPiKernel 二进制路径
 * @param {string} opts.waPiDir - WA_PI_DIR
 * @param {Object} opts.log - 日志对象
 * @param {string|null} [opts.nodeExe] - 真实 node 路径（系统 node 或首启下载的 node）
 * @param {() => string|null} [opts.findSystemNodeFn] - 系统 node 探测函数（测试注入）
 * @param {boolean} opts.isPackaged - 是否打包模式
 * @returns {Promise<string|null>} binDir 路径，null 表示非 packaged
 */
async function ensureRuntimeBinLinks({
	kernelExe,
	waPiDir,
	log,
	nodeExe,
	findSystemNodeFn = findSystemNode,
	isPackaged,
}) {
	if (!isPackaged) return null;
	const binDir = path.join(waPiDir, "bin");
	const target = kernelExe;
	await fsp.mkdir(binDir, { recursive: true });
	if (process.platform === "win32") {
		const t = target;
		await fsp.writeFile(
			path.join(binDir, "bun.cmd"),
			`@echo off\r\nset BUN_BE_BUN=1\r\n"${t}" %*\r\n`,
		);
		// Git Bash / MSYS 查找命令只认无后缀或 .exe，不按 PATHEXT 解析 .cmd，
		// 只放 bun.cmd 会让 bash 里的 bun 落到系统全局版本。再补一个无后缀 sh 脚本（
		// 与 POSIX 分支同形，用 POSIX 路径——sh 中反斜杠是转义符）。
		const bunSh = path.join(binDir, "bun");
		await fsp.writeFile(
			bunSh,
			`#!/bin/sh\nBUN_BE_BUN=1 exec "${toPosixPath(t)}" "$@"\n`,
		);
		await fsp.chmod(bunSh, 0o755);
		const nodePath = nodeExe || findSystemNodeFn();
		if (nodePath) {
			// PATH 已前置 binDir：遗留的 fallback cmd 会遮蔽真实 node（旧版本路径还可能已失效），清掉
			for (const name of ["node.cmd", "npm.cmd", "npx.cmd"]) {
				await fsp.rm(path.join(binDir, name), { force: true });
			}
			log.info(
				`[runtime-bin] Windows: bun.cmd + bun(sh) -> ${t}; node/npm/npx -> ${nodePath}（node 自带）`,
			);
		} else {
			// 每次启动重写，保证指向当前安装路径（旧安装目录残留会让命令失效）
			await fsp.writeFile(
				path.join(binDir, "npx.cmd"),
				`@echo off\r\nset BUN_BE_BUN=1\r\n"${t}" x %*\r\n`,
			);
			await fsp.writeFile(
				path.join(binDir, "node.cmd"),
				`@echo off\r\nset BUN_BE_BUN=1\r\n"${t}" %*\r\n`,
			);
			await fsp.writeFile(
				path.join(binDir, "npm.cmd"),
				`@echo off\r\nset BUN_BE_BUN=1\r\nif /i "%~1"=="exec" (shift & "${t}" x %*) else "${t}" %*\r\n`,
			);
			log.info(
				`[runtime-bin] Windows: npx/bun/node/npm -> ${t}（bun fallback）`,
			);
		}
		return binDir;
	}
	const bunLink = path.join(binDir, "bun");
	const nodeLink = path.join(binDir, "node");
	const npxPath = path.join(binDir, "npx");
	const npmPath = path.join(binDir, "npm");
	await fsp.rm(bunLink, { force: true });
	await fsp.rm(nodeLink, { force: true });
	await fsp.rm(npxPath, { force: true });
	await fsp.rm(npmPath, { force: true });
	// bun 用 wrapper 脚本而非符号链接：编译产物需 BUN_BE_BUN=1 才充当 bun CLI，
	// 符号链接无法携带 env（kernel 子进程靠 env 继承，wrapper 兜底非继承场景如用户终端直接调用）
	const bunScript = `#!/bin/sh\nBUN_BE_BUN=1 exec "${target}" "$@"\n`;
	await fsp.writeFile(bunLink, bunScript);
	await fsp.chmod(bunLink, 0o755);
	const nodePath = nodeExe || findSystemNodeFn();
	if (nodePath) {
		await fsp.symlink(nodePath, nodeLink);
		log.info(`[runtime-bin] node -> ${nodePath}（node 自带 npm/npx）`);
	} else {
		const nodeScript = `#!/bin/sh\nBUN_BE_BUN=1 exec "${target}" "$@"\n`;
		await fsp.writeFile(nodeLink, nodeScript);
		await fsp.chmod(nodeLink, 0o755);
		log.info(`[runtime-bin] node -> ${target}（bun fallback）`);
		const npxScript = `#!/bin/sh\nBUN_BE_BUN=1 exec "${target}" x "$@"\n`;
		await fsp.writeFile(npxPath, npxScript);
		await fsp.chmod(npxPath, 0o755);
		const npmScript = `#!/bin/sh\nif [ "$1" = "exec" ]; then shift; BUN_BE_BUN=1 exec "${target}" x "$@"; fi\nBUN_BE_BUN=1 exec "${target}" "$@"\n`;
		await fsp.writeFile(npmPath, npmScript);
		await fsp.chmod(npmPath, 0o755);
	}
	log.info(`[runtime-bin] bun -> ${target}`);
	return binDir;
}

module.exports = {
	findSystemNode,
	ensureRuntimeBinLinks,
	buildRuntimePath,
	toPosixPath,
};
