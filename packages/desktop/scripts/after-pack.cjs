// afterPack 钩子：
//  - macOS：对 .app 做稳定签名（未签名应用在 macOS 15 上屏幕录制 TCC 权限绑定失效，
//    重装后权限丢失，system 源录音报 "Invalid capture constraints"）
//  - Windows：签名的实际动作由 electron-builder 内置的 osslsigncode 路径完成
//    （win.signtoolOptions 配好后：extraResources 的 exe 在拷贝时签、主程序在 resEdit
//    之后签、NSIS 安装包与卸载器在打包时签，顺序由 electron-builder 保证）。
//    这里只做 electron-builder 不知道的一件事：签名会改变 resources/kernel/WaPiKernel.exe
//    的大小，而应用启动的壳/核一致性自检按大小比对，必须同步刷新 manifest.json。
//  - 图标/版本信息由 electron-builder 内置的 resEdit（纯 JS PE 资源编辑）自动嵌入。
const path = require("node:path");
const fs = require("node:fs");
// 不解构，保留延迟属性查找：测试可替换缓存对象上的方法做 mock
const macSign = require("./mac-sign.cjs");
const winSign = require("./win-sign.cjs");

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
	const result = macSign.signMacApp(appPath);
	if (result.signed) {
		console.log(
			`[afterPack] ✅ macOS 产物已签名 (identity=${result.identity}) → ${appPath}`,
		);
	} else {
		// 直接报错终止打包：无签名/坏签名的包会导致已装用户 OTA 更新验证失败（0.9.1 教训），
		// 不能让坏包流入产物目录。错误信息含修复指引（来自 resolveIdentity/signMacApp）。
		throw new Error(
			`[afterPack] macOS 产物签名失败，终止打包（无签名包会导致 OTA 断更新）: ${result.error}`,
		);
	}
}

/**
 * Windows：签名已改变内核 exe 大小（extraResources 拷贝时签的），刷新相容清单。
 * 不刷新会让应用启动自检每天在 desktop.log 里误报 size-mismatch，掩盖真正的问题。
 */
function refreshWindowsKernelManifest(appOutDir) {
	const kernelDir = path.join(appOutDir, "resources", "kernel");
	const r = winSign.refreshKernelManifest(kernelDir);
	if (r.updated) {
		const skipped = process.env.WA_PI_SKIP_WIN_SIGN === "1";
		console.log(
			`[afterPack] ✅ Windows 内核清单已刷新（${skipped ? "产物大小变化" : "签名改变 exe 大小"}）: size ${r.before?.size} → ${r.after?.size}`,
		);
	} else if (r.reason) {
		console.log(
			`[afterPack] Windows 内核清单未刷新（${r.reason}）→ ${kernelDir}`,
		);
	} else {
		console.log("[afterPack] Windows 内核清单与产物一致，无需刷新");
	}
}

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async (context) => {
	const { appOutDir, packager, electronPlatformName } = context;
	if (electronPlatformName === "win32") {
		refreshWindowsKernelManifest(appOutDir);
		return;
	}
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

exports.refreshWindowsKernelManifest = refreshWindowsKernelManifest;
