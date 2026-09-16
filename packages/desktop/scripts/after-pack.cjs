// afterPack 钩子：
//  - macOS：对 .app 做稳定签名（未签名应用在 macOS 15 上屏幕录制 TCC 权限绑定失效，
//    重装后权限丢失，system 源录音报 "Invalid capture constraints"）
//  - Windows：图标/版本信息由 electron-builder 内置的 resEdit（纯 JS PE 资源编辑）自动嵌入，
//    无需 here 手动处理。早期曾用 signAndEditExecutable:false 绕过 electron-builder 的资源编辑
//    （并以 here 的手动 rcedit 补偿），但 rcedit 在 macOS 交叉打包下必然找不到、静默跳过，
//    导致 exe 图标是 Electron 默认。现改用 signExecutable:false 只跳过签名、保留图标嵌入。
const path = require("node:path");
const fs = require("node:fs");
const { signMacApp } = require("./mac-sign.cjs");

/** macOS：对打包产物签名（在 dmg/zip 生成前，签名会进入安装包）。 */
function signMacArtifact(appOutDir, packager) {
	const appPath = path.join(
		appOutDir,
		`${packager.appInfo.productFilename}.app`,
	);
	if (!fs.existsSync(appPath)) {
		console.log(`[afterPack] ${appPath} 不存在，跳过签名`);
		return;
	}
	const result = signMacApp(appPath);
	if (result.signed) {
		console.log(
			`[afterPack] ✅ macOS 产物已签名 (identity=${result.identity}) → ${appPath}`,
		);
	} else {
		console.warn(
			`[afterPack] ⚠️ macOS 产物签名失败（重装后屏幕录制权限可能失效）: ${result.error}`,
		);
	}
}

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async (context) => {
	const { appOutDir, packager, electronPlatformName } = context;
	if (electronPlatformName === "darwin") {
		// WA_PI_SKIP_MAC_SIGN=1：跳过 macOS 签名——测试/本地打包用，避免 codesign 访问
		// 钥匙串自签名证书私钥时弹出钥匙串密码授权框（阻塞/用户不知密码）。
		// 正式发版不设此变量，即照常用 mac-sign.cjs 的自签名（或正式身份）签名。
		if (process.env.WA_PI_SKIP_MAC_SIGN === "1") {
			console.log(
				"[afterPack] ⏭️ WA_PI_SKIP_MAC_SIGN=1，跳过 macOS 签名（测试包；屏幕录制等 TCC 权限需在系统设置手动授权）",
			);
			return;
		}
		signMacArtifact(appOutDir, packager);
	}
};
