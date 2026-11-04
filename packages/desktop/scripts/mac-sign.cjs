// macOS 产物签名：afterPack 钩子专用（可单测的纯逻辑 + 执行）。
//
// 背景：未签名应用在 macOS 15 上「屏幕录制」TCC 权限绑定失效——系统设置显示「已开启」
// 但实际不生效，且重装应用后权限记录丢失，导致 system 源录音的 getDisplayMedia 报
// "Invalid capture constraints"。构建时对 .app 做稳定签名（有证书用证书，否则 ad-hoc），
// 让 TCC 能按签名身份绑定权限。
const { execFileSync } = require("node:child_process");

/** 项目自签名证书默认名（登录钥匙串）。OTA 更新依赖它：ad-hoc 签名的 requirement 是 cdhash，
 *  更新验证必然失败；自签名证书签名的 requirement 是 certificate leaf = H"..."（证书哈希），
 *  同一证书签的新版本互相满足，Squirrel.Mac 更新验证可过。 */
const DEFAULT_SELF_SIGNED_CERT = "WA PI Agent Self-Signed";

/** 钥匙串里是否存在给定证书（只读查询，不弹窗）。
 * 注意：macOS 上 `security find-certificate` 无匹配时 exit code 仍为 0，
 * 只靠退出码会误判证书存在（→ 用不存在的证书名签名必失败）。
 * 这里改用 -p 输出的 PEM 内容判断：有证书会输出 BEGIN CERTIFICATE 块。 */
function hasCert(name, exec = execFileSync) {
	try {
		const out = exec("security", ["find-certificate", "-c", name, "-a", "-p"], {
			encoding: "utf8",
		});
		return String(out ?? "").includes("BEGIN CERTIFICATE");
	} catch {
		return false;
	}
}

/**
 * 决定签名身份，优先级：
 * 1. CODESIGN_IDENTITY（显式指定，正式 Developer ID 或自签名证书名；传 "-" 强制 ad-hoc）
 * 2. 钥匙串存在默认自签名证书（WA_PI_SELF_SIGNED_CERT 可覆盖名称）时自动使用，保证 OTA 更新签名验证稳定
 * 3. WA_PI_SELF_SIGNED_CERT 显式设为空串 → 显式 ad-hoc（尊重调用者意图）
 * 4. 找不到证书 → 直接报错终止打包（禁止静默回退 ad-hoc：其 requirement 是 cdhash，
 *    已装用户的 Squirrel.Mac 更新验证必败，0.9.1 断更新即此根因）
 */
function resolveIdentity(env = process.env, options = {}) {
	const { exec = execFileSync } = options;
	const id = (env.CODESIGN_IDENTITY || "").trim();
	if (id) return id;
	const raw =
		env.WA_PI_SELF_SIGNED_CERT === undefined
			? DEFAULT_SELF_SIGNED_CERT
			: env.WA_PI_SELF_SIGNED_CERT;
	const selfSigned = raw.trim();
	if (selfSigned && hasCert(selfSigned, exec)) return selfSigned;
	// 显式禁用自签证书查找（WA_PI_SELF_SIGNED_CERT=""）→ 显式 ad-hoc，尊重调用者意图
	if (!selfSigned) return "-";
	// 找不到证书：报错终止打包（给打包执行者的修复指引）
	throw new Error(
		`macOS 打包签名身份不可用：默认钥匙串搜索路径找不到证书 "${selfSigned}"，禁止静默回退 ad-hoc（已装用户 OTA 更新验证必败）。修复：① security list-keychains -s <login.keychain-db> <wapi-sign.keychain-db> 临时挂载证书所在钥匙串后重试（签完移除）；② 显式设 CODESIGN_IDENTITY=<可用身份>；③ 测试打包显式设 WA_PI_SKIP_MAC_SIGN=1 跳过签名`,
	);
}

/** 构造 codesign 参数。保留 --deep 确保内部 Framework/helpers 全部签名（否则
 *  codesign 拒绝签名 .app 外层）。--deep 破坏 zip 符号链接的问题由 afterAllArtifactBuild
 *  钩子用 ditto 重新打包 zip 解决。 */
function buildSignArgs(appPath, identity) {
	return ["--force", "--deep", "--sign", identity, appPath];
}

/**
 * 对 macOS .app 产物做稳定签名并验证。
 * @returns {{ signed: boolean, identity: string, error?: string }}
 */
function signMacApp(appPath, options = {}) {
	const { env = process.env, exec = execFileSync } = options;
	try {
		// resolveIdentity 放进 try：无证书抛错也转成 {signed:false, error}，
		// 让调用方（after-pack 钩子）拿到含修复指引的完整信息后终止打包。
		const identity = resolveIdentity(env, { exec });
		const args = buildSignArgs(appPath, identity);
		exec("codesign", args, { stdio: "inherit" });
		exec("codesign", ["--verify", "--deep", appPath], { stdio: "inherit" });
		return { signed: true, identity };
	} catch (e) {
		return {
			signed: false,
			identity: "-",
			error: e?.message?.split("\n")[0] || String(e),
		};
	}
}

module.exports = {
	resolveIdentity,
	buildSignArgs,
	signMacApp,
	hasCert,
	DEFAULT_SELF_SIGNED_CERT,
};
