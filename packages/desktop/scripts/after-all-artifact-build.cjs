// afterAllArtifactBuild 钩子：zip 生成后用 ditto 重新打包。
//
// 问题：electron-builder 内部用 zip 打包 macOS .app，不保留 .framework 的符号链接
// 结构——Versions/A/Electron Framework（205MB 实际文件）被丢失，只留下 35 字节的
// 符号链接路径。Squirrel.Mac 安装时 ditto 找不到文件 → "No such file or directory"。
//
// 解法：在所有产物生成后，用 macOS 原生 ditto 重新打包 zip（--keepParent 保留符号链接
// 和扩展属性）。必须同时更新 blockmap（electron-builder 用它做增量下载）。
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// app-builder-lib 由 electron-builder 依赖携带（bun 安装下其他包不可直接解析），
// 从 electron-builder 的解析起点加载，确保打包/测试环境均可解析。
let buildBlockMapFn = null;
function resolveBuildBlockMap() {
	if (buildBlockMapFn) return buildBlockMapFn;
	const ebDir = path.dirname(require.resolve("electron-builder"));
	const ebRequire = createRequire(path.join(ebDir, "package.json"));
	buildBlockMapFn =
		ebRequire("app-builder-lib/out/targets/blockmap/blockmap").buildBlockMap;
	return buildBlockMapFn;
}

/**
 * 对 zip 重新生成 differential blockmap（增量下载需要）。
 * ditto 重打包后 electron-builder 内部生成的旧 blockmap 与 zip 内容不一致，
 * 必须重算；用 app-builder-lib 的纯 JS buildBlockMap（Rabin 分块，无外部二进制依赖）。
 */
async function regenerateBlockmap(zipPath, blockmapPath) {
	const buildBlockMap = resolveBuildBlockMap();
	await buildBlockMap(zipPath, "gzip", blockmapPath);
}

exports.default = async (context) => {
	if (context.electronPlatformName !== "darwin") return [];

	const zipPath = context.artifactPaths.find((p) => p.endsWith(".zip"));
	if (!zipPath || !fs.existsSync(zipPath)) return [];

	const appName = context.packager.appInfo.productFilename;
	const appPath = path.join(context.outDir, "mac", `${appName}.app`);
	if (!fs.existsSync(appPath)) return [];

	console.log(`[afterAllArtifactBuild] ditto 重新打包 zip（保留符号链接）→ ${zipPath}`);

	// ditto 重新打包
	fs.unlinkSync(zipPath);
	execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);
	console.log(`[afterAllArtifactBuild] ✅ zip 重打包完成 (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)}MB)`);

	// 重新生成 blockmap（增量下载需要）：ditto 重打包后旧 blockmap 与 zip 内容不一致。
	// 原实现用 `npx electron-builder --mac --dir` 尝试重生成——该命令只产出 .app 目录、
	// 不产出 zip 的 blockmap，导致 blockmap 实际缺失、增量更新退化为全量下载。
	const blockmapPath = zipPath + ".blockmap";
	if (fs.existsSync(blockmapPath)) {
		fs.unlinkSync(blockmapPath);
	}
	try {
		await regenerateBlockmap(zipPath, blockmapPath);
		console.log(
			`[afterAllArtifactBuild] ✅ blockmap 重新生成 (${(fs.statSync(blockmapPath).size / 1024).toFixed(1)}KB)`,
		);
	} catch (e) {
		// blockmap 缺失/失效不会让安装失败，但 macOS 增量更新会退化为全量下载
		// （zip 可能 100MB+）。显式报错让发布者知晓，不阻塞整个打包流程。
		console.error(
			"[afterAllArtifactBuild] ❌ blockmap 重新生成失败，macOS 增量更新将退化为全量下载",
			e instanceof Error ? e.message : e,
		);
	}

	// 更新 latest-mac.yml 中的 sha512
	const ymlPath = path.join(context.outDir, "latest-mac.yml");
	if (fs.existsSync(ymlPath)) {
		const buf = fs.readFileSync(zipPath);
		const hash = crypto.createHash("sha512").update(buf).digest("base64");
		let yml = fs.readFileSync(ymlPath, "utf8");
		yml = yml.replace(/sha512: .+/g, `sha512: ${hash}`);
		const stat = fs.statSync(zipPath);
		yml = yml.replace(/size: \d+/g, `size: ${stat.size}`);
		fs.writeFileSync(ymlPath, yml);
		console.log("[afterAllArtifactBuild] ✅ latest-mac.yml sha512/size 已更新");
	}

	return [];
};

exports.regenerateBlockmap = regenerateBlockmap;
