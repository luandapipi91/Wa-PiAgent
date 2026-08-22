// 首启按需下载 Node.js 运行时。
// 背景：打包版捆绑 bun --compile 编译产物（WaPiKernel）作 kernel 运行时，但不捆绑 node。
// MCP 服务器（npx -y <package>）需要真实 node + npm。
// 首启时检测系统 node，如果没有则通过 IP 地理位置检测选择下载源，
// 自动下载 node LTS 到 ~/.pi/agent/node/。
//
// 下载源选择：IP 检测为国内 → npmmirror 优先；国外 → nodejs.org 优先。

const { spawnSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// Node.js LTS 版本（Jod）
const NODE_LTS = "v22.23.2";
const IP_CHECK_TIMEOUT = 5_000;
const DOWNLOAD_TIMEOUT = 120_000;
// node zip 约 32MB，设 20MB 下限过滤异常响应
const MIN_ARCHIVE_SIZE = 20_000_000;

/**
 * IP 地理位置检测：判断用户是否在国内。
 * 使用 api.country.is（HTTPS、免费、无需 key）；超时或失败默认国内（安全 fallback，优先国内源）。
 * @returns {Promise<boolean>}
 */
async function detectIsCN(log = console) {
	try {
		const resp = await fetch("https://api.country.is/", {
			signal: AbortSignal.timeout(IP_CHECK_TIMEOUT),
		});
		const data = await resp.json();
		const isCN = data.country === "CN";
		log.info(`[node-runtime] IP 检测: country=${data.country}, isCN=${isCN}`);
		return isCN;
	} catch (e) {
		// 超时或网络异常 → 默认国内（安全 fallback，用国内源）
		log.info(`[node-runtime] IP 检测失败 (${e.message})，默认国内源`);
		return true;
	}
}

/**
 * 构建当前平台的 node 归档文件名与下载 URL 列表（按优先级排序）。
 */
function nodeDownloadSpecs(isCN) {
	const platform = process.platform;
	const arch = process.arch; // 'x64' | 'arm64'
	const a = arch === "arm64" ? "arm64" : "x64";

	let archive;
	if (platform === "win32") {
		archive = `node-${NODE_LTS}-win-${a}.zip`;
	} else if (platform === "darwin") {
		archive = `node-${NODE_LTS}-darwin-${a}.tar.gz`;
	} else {
		archive = `node-${NODE_LTS}-linux-${a}.tar.xz`;
	}

	const npmmirror = `https://cdn.npmmirror.com/binaries/node/${NODE_LTS}/${archive}`;
	const official = `https://nodejs.org/dist/${NODE_LTS}/${archive}`;

	// 国内优先 npmmirror，国外优先 nodejs.org
	const urls = isCN ? [npmmirror, official] : [official, npmmirror];
	return { archive, urls };
}

/**
 * 下载文件到指定路径。成功返回 true，失败返回 false。
 */
async function downloadToFile(url, dest, log = console) {
	try {
		log.info(`[node-runtime] 下载 ${url}`);
		const r = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
		});
		if (!r.ok || !r.body) {
			log.warn(`[node-runtime] HTTP ${r.status} ${url}`);
			return false;
		}
		const buf = Buffer.from(await r.arrayBuffer());
		if (buf.length < MIN_ARCHIVE_SIZE) {
			log.warn(`[node-runtime] 下载过小 (${buf.length}B)，丢弃`);
			return false;
		}
		await fsp.writeFile(dest, buf);
		log.info(
			`[node-runtime] 下载 OK ${(buf.length / 1024 / 1024).toFixed(1)} MB`,
		);
		return true;
	} catch (e) {
		log.warn(`[node-runtime] 下载失败 ${url}: ${e.message}`);
		return false;
	}
}

/**
 * 解压归档到目录。Windows zip 用 PowerShell Expand-Archive；macOS/Linux 用 tar。
 */
function extractArchive(archivePath, outDir) {
	if (process.platform === "win32") {
		// Expand-Archive 需 Windows 风格路径
		const toWin = (p) => p.replace(/\//g, "\\").replace(/^\\(\w+)\\/, "$1:\\");
		const ps = `Expand-Archive -Path '${toWin(archivePath)}' -DestinationPath '${toWin(outDir)}' -Force`;
		const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
			stdio: "pipe",
		});
		if (r.status !== 0) {
			throw new Error(
				`PowerShell Expand-Archive 失败 (exit=${r.status}): ${r.stderr?.toString().trim()}`,
			);
		}
	} else {
		const r = spawnSync("tar", ["-xf", archivePath, "-C", outDir], {
			stdio: "pipe",
		});
		if (r.status !== 0) {
			throw new Error(
				`tar 解压失败 (exit=${r.status}): ${r.stderr?.toString().trim()}`,
			);
		}
	}
}

/**
 * 在解压目录中查找 node 根目录（node-vXX.XX.X-<plat>-<arch>/）。
 */
async function findNodeRoot(extractedDir) {
	const entries = await fsp.readdir(extractedDir);
	for (const e of entries) {
		const child = path.join(extractedDir, e);
		const stat = await fsp.stat(child);
		if (stat.isDirectory() && e.startsWith("node-v")) {
			return child;
		}
	}
	return null;
}

async function fileExists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

// findSystemNode 从 runtime-bin.cjs 复用（消除重复）
const { findSystemNode } = require("./runtime-bin.cjs");

/**
 * 主函数：确保 node 运行时可用。
 * 优先级：系统 node > 已下载 node（版本匹配）> 下载安装 > null（fallback bun）
 *
 * @param {Object} opts
 * @param {string} opts.waPiDir - WA_PI_DIR（默认 ~/.pi/agent）
 * @param {Object} opts.log - 日志对象（需有 info/warn/error 方法）
 * @param {Function} [opts.onStatus] - 进度回调 (text: string) => void
 * @returns {Promise<string|null>} node 可执行文件路径，null 表示不可用
 */
async function ensureNodeRuntime({
	waPiDir,
	log = console,
	onStatus,
	forceDownload = false,
	findSystemNodeFn = findSystemNode,
} = {}) {
	const dir = waPiDir || path.join(os.homedir(), ".pi", "agent");

	// 1. 检测系统 node（forceDownload 时跳过，用于强制重装/POC 测试）
	if (!forceDownload) {
		const sysNode = findSystemNodeFn();
		if (sysNode) {
			log.info(`[node-runtime] 检测到系统 Node.js: ${sysNode}`);
			return sysNode;
		}
	}

	// 2. 检测已下载 node（forceDownload 时跳过，marker 版本匹配则跳过）
	const nodeDir = path.join(dir, "node");
	const nodeExe =
		process.platform === "win32"
			? path.join(nodeDir, "node.exe")
			: path.join(nodeDir, "bin", "node");
	const marker = path.join(nodeDir, ".installed-version");

	if (!forceDownload && (await fileExists(nodeExe))) {
		const markerVer = await fsp.readFile(marker, "utf8").catch(() => "");
		if (markerVer === NODE_LTS) {
			log.info(`[node-runtime] 已下载 Node.js ${NODE_LTS}，跳过`);
			return nodeExe;
		}
		log.info(
			`[node-runtime] 版本不匹配 (marker=${markerVer}, target=${NODE_LTS})，重新下载`,
		);
	}

	// 3. IP 地理位置检测
	if (onStatus) onStatus("正在检测网络环境…");
	const isCN = await detectIsCN(log);

	// 4. 下载（按 IP 检测结果排序的源列表，逐个尝试）
	const { urls, archive } = nodeDownloadSpecs(isCN);
	// 临时文件名必须带正确扩展名（.zip/.tar.gz），否则 PowerShell Expand-Archive 拒绝
	const tmpArchive = path.join(os.tmpdir(), archive);
	const tmpExtract = path.join(
		os.tmpdir(),
		`wa-pi-node-extract-${process.pid}`,
	);
	await fsp.rm(tmpExtract, { recursive: true, force: true });

	let downloaded = false;
	for (const url of urls) {
		if (onStatus) onStatus(`正在下载 Node.js ${NODE_LTS}…`);
		if (await downloadToFile(url, tmpArchive, log)) {
			downloaded = true;
			break;
		}
	}
	if (!downloaded) {
		log.error("[node-runtime] 所有下载源均失败");
		await fsp.rm(tmpArchive, { force: true });
		return null;
	}

	// 5. 解压 + 安装到目标目录
	if (onStatus) onStatus("正在安装 Node.js…");
	try {
		await fsp.mkdir(tmpExtract, { recursive: true });
		extractArchive(tmpArchive, tmpExtract);

		const nodeRoot = await findNodeRoot(tmpExtract);
		if (!nodeRoot) throw new Error("解压后未找到 node 目录");

		// 清空旧目录，复制新内容
		await fsp.rm(nodeDir, { recursive: true, force: true });
		await fsp.mkdir(nodeDir, { recursive: true });
		await fsp.cp(nodeRoot, nodeDir, { recursive: true });
		await fsp.writeFile(marker, NODE_LTS, "utf8");

		log.info(`[node-runtime] ✅ Node.js ${NODE_LTS} 已安装到 ${nodeDir}`);
		return nodeExe;
	} catch (e) {
		log.error(`[node-runtime] 解压/安装失败: ${e.message}`);
		return null;
	} finally {
		await fsp.rm(tmpArchive, { force: true });
		await fsp.rm(tmpExtract, { recursive: true, force: true });
	}
}

module.exports = {
	ensureNodeRuntime,
	detectIsCN,
	findSystemNode,
	nodeDownloadSpecs,
	NODE_LTS,
};
