// macOS 产物签名：afterPack 钩子专用（可单测的纯逻辑 + 执行）。
//
// 背景：未签名应用在 macOS 15 上「屏幕录制」TCC 权限绑定失效——系统设置显示「已开启」
// 但实际不生效，且重装应用后权限记录丢失，导致 system 源录音的 getDisplayMedia 报
// "Invalid capture constraints"。构建时对 .app 做稳定签名（有证书用证书，否则 ad-hoc），
// 让 TCC 能按签名身份绑定权限。
const { execFileSync } = require("node:child_process");

/**
 * 决定签名身份：优先环境变量 CODESIGN_IDENTITY（正式 Developer ID 证书），
 * 未设置时回退 ad-hoc（"-"，不需要证书）。
 */
function resolveIdentity(env = process.env) {
	const id = (env.CODESIGN_IDENTITY || "").trim();
	return id || "-";
}

/** 构造 codesign 参数。--deep 递归签名内部 Electron Framework/helpers。 */
function buildSignArgs(appPath, identity) {
	return ["--force", "--deep", "--sign", identity, appPath];
}

/**
 * 对 macOS .app 产物做稳定签名并验证。
 * @returns {{ signed: boolean, identity: string, error?: string }}
 */
function signMacApp(appPath, options = {}) {
	const { env = process.env, exec = execFileSync } = options;
	const identity = resolveIdentity(env);
	const args = buildSignArgs(appPath, identity);
	try {
		exec("codesign", args, { stdio: "inherit" });
		exec("codesign", ["--verify", "--deep", appPath], { stdio: "inherit" });
		return { signed: true, identity };
	} catch (e) {
		return {
			signed: false,
			identity,
			error: e?.message?.split("\n")[0] || String(e),
		};
	}
}

module.exports = { resolveIdentity, buildSignArgs, signMacApp };
