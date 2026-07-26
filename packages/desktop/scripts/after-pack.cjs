// afterPack 钩子：electron-builder 跳过 rcedit（Windows Defender 竞态），
// 但在 win-unpacked 生成后、NSIS 打包前手动 rcedit 注入图标和版本信息。
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function findRcedit() {
	const cacheDir = path.join(
		os.homedir(),
		"AppData",
		"Local",
		"electron-builder",
		"Cache",
		"winCodeSign",
	);
	if (!fs.existsSync(cacheDir)) return null;
	const dirs = fs
		.readdirSync(cacheDir)
		.filter((d) => d.startsWith("winCodeSign"));
	for (const d of dirs) {
		const rcedit = path.join(cacheDir, d, "rcedit-x64.exe");
		if (fs.existsSync(rcedit)) return rcedit;
	}
	return null;
}

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async (context) => {
	const { appOutDir, packager, electronPlatformName } = context;
	if (electronPlatformName !== "win32") return;

	const rcedit = findRcedit();
	if (!rcedit) {
		console.log("[afterPack] rcedit 未找到，跳过图标注入");
		return;
	}

	const exe = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
	if (!fs.existsSync(exe)) {
		console.log(`[afterPack] ${exe} 不存在，跳过`);
		return;
	}

	const ico = path.join(packager.info.projectDir, "src", "assets", "icon.ico");
	const ver = packager.appInfo.version;
	const name = packager.appInfo.productName;

	const args = [
		exe,
		"--set-version-string",
		"FileDescription",
		name,
		"--set-version-string",
		"ProductName",
		name,
		"--set-version-string",
		"LegalCopyright",
		`Copyright (c) 2025 ${name}`,
		"--set-file-version",
		ver,
		"--set-product-version",
		`${ver}.0`,
		"--set-version-string",
		"InternalName",
		name,
		"--set-icon",
		ico,
	];

	console.log("[afterPack] 注入图标:", rcedit, args.join(" "));

	// Windows Defender 会在 exe 创建后短暂锁定文件，重试最多 5 次
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			await new Promise((r) => setTimeout(r, 3000 * attempt));
			execFileSync(rcedit, args, { stdio: "inherit", timeout: 30000 });
			console.log(`[afterPack] 图标注入成功 (第 ${attempt} 次)`);
			return;
		} catch (e) {
			if (attempt < 5) {
				console.log(`[afterPack] 第 ${attempt} 次失败，重试...`);
			} else {
				console.warn(
					"[afterPack] rcedit 5 次均失败（图标可能为默认 Electron 图标）:",
					e.message?.split("\n")[0],
				);
			}
		}
	}
};
