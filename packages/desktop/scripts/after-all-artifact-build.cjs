// afterAllArtifactBuild 钩子：zip 生成后用 ditto 重新打包。
//
// 问题：electron-builder 内部用 zip 打包 macOS .app，不保留 .framework 的符号链接
// 结构——Versions/A/Electron Framework（205MB 实际文件）被丢失，只留下 35 字节的
// 符号链接路径。Squirrel.Mac 安装时 ditto 找不到文件 → "No such file or directory"。
//
// 解法：在所有产物生成后，用 macOS 原生 ditto 重新打包 zip（--keepParent 保留符号链接
// 和扩展属性）。必须同时更新 blockmap（electron-builder 用它做增量下载）。
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

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

	// 重新生成 blockmap（增量下载需要）
	const blockmapPath = zipPath + ".blockmap";
	if (fs.existsSync(blockmapPath)) {
		fs.unlinkSync(blockmapPath);
	}
	try {
		const { generateDifferential } = require("app-builder-lib");
		// electron-builder 26: 用其内部工具重新生成 blockmap
		execFileSync("npx", [
			"electron-builder",
			"--mac",
			"--dir",
			"--projectDir",
			context.outDir,
		], { stdio: "ignore" });
	} catch {
		console.log("[afterAllArtifactBuild] blockmap 重新生成跳过（增量下载可能受影响）");
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
