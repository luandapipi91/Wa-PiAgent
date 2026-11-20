// Windows 代码签名证书（自签）：生成 / 定位 / 读取。
//
// 背景：Windows 客户端此前完全跳过签名（electron-builder.yml 的 signExecutable: false），
// 用户安装时 UAC 显示「未知的发布者」。现改为用自签代码签名证书对主程序、内核 exe
// 与 NSIS 安装包签名；用户一次性把导出的 .cer 导入「受信任的根证书颁发机构」后，
// UAC 显示「已验证的发布者」。
//
// 私钥（p12）刻意放在**仓库之外**的用户目录（默认 ~/.wa-pi-ac），避免私钥进 git；
// CI/多机场景用 WA_PI_WIN_SIGN_P12 + WA_PI_WIN_SIGN_PASSWORD 覆盖。
// 证书必须跨版本稳定：用户导入过一次根证书后，后续版本都要用同一张证书签。
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CERT_BASENAME = "win-signing";
const CERT_CN = "WA PI Agent Windows Self-Signed";

/** 证书目录：默认 ~/.wa-pi-ac，WA_PI_AC_DIR 覆盖（测试/CI 用）。 */
function resolveCertDir({ env = process.env, home = os.homedir() } = {}) {
	const custom = String(env.WA_PI_AC_DIR || "").trim();
	return custom || path.join(home, ".wa-pi-ac");
}

/** 证书相关文件路径。password 文件权限由创建时设为 0600。 */
function certPaths(dir) {
	const base = path.join(dir, CERT_BASENAME);
	return {
		dir,
		p12: `${base}.p12`,
		password: `${base}.pass`,
		cnf: `${base}.cnf`,
		key: `${base}.key`,
		// .cer 用 DER：Windows 的 Import-Certificate / 双击安装向导只认 DER，
		// PEM（-----BEGIN CERTIFICATE-----）常报 "Cannot find the requested object"
		cer: `${base}.cer`,
		// .pem 保留一份供 openssl / osslsigncode -CAfile 使用
		pem: `${base}.pem`,
	};
}

/** openssl 配置：自签代码签名证书（Code Signing EKU、非 CA、只做数字签名）。
 *  用 -config 传文件而不是 -addext：macOS 自带 LibreSSL 不支持 -addext。 */
function CERT_CONFIG_TEXT() {
	return `[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=${CERT_CN}
O=WA PI
C=CN
[v3]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
`;
}

/** 随机密码：只含字母数字，避免 shell/env 转义问题。 */
function generatePassword(randomBytes = crypto.randomBytes) {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const buf = randomBytes(24);
	let out = "";
	for (let i = 0; i < 24; i++) out += alphabet[buf[i] % alphabet.length];
	return out;
}

/**
 * 解析可用的签名材料（p12 + 密码）。
 * 优先级：环境变量（必须成对）> ~/.wa-pi-ac 下的文件。
 * @returns {{p12: string, password: string, source: "env"|"file"} | null}
 */
function readSigningMaterial({
	env = process.env,
	home = os.homedir(),
	exists = fs.existsSync,
	readFile = (p) => fs.readFileSync(p, "utf8"),
} = {}) {
	const envP12 = String(env.WA_PI_WIN_SIGN_P12 || "").trim();
	const envPassword = String(env.WA_PI_WIN_SIGN_PASSWORD || "").trim();
	// 只配一半属于配置错误：p12 与密码必须成对，否则会拿 A 证书的 p12 配 B 证书的密码
	if (envP12 && !envPassword) {
		throw new Error(
			"[win-cert] 设置了 WA_PI_WIN_SIGN_P12 但缺少 WA_PI_WIN_SIGN_PASSWORD（两者必须成对设置）",
		);
	}
	if (!envP12 && envPassword) {
		throw new Error(
			"[win-cert] 设置了 WA_PI_WIN_SIGN_PASSWORD 但缺少 WA_PI_WIN_SIGN_P12（两者必须成对设置）",
		);
	}
	if (envP12 && envPassword) {
		return { p12: envP12, password: envPassword, source: "env" };
	}
	const paths = certPaths(resolveCertDir({ env, home }));
	if (!exists(paths.p12) || !exists(paths.password)) return null;
	const password = String(readFile(paths.password)).trim();
	if (!password) return null;
	return { p12: paths.p12, password, source: "file" };
}

/** 同 readSigningMaterial，但缺失时直接报错终止打包（禁止静默产出未签名包）。 */
function ensureSigningMaterial(opts = {}) {
	const material = readSigningMaterial(opts);
	if (material) return material;
	const paths = certPaths(resolveCertDir(opts));
	throw new Error(
		`[win-sign] 未找到 Windows 签名证书，终止打包（未签名的包会让 UAC 显示「未知的发布者」）。\n` +
			`修复：① 生成证书（只做一次）：bun run scripts/win-cert.cjs create\n` +
			`      ② 或用 WA_PI_WIN_SIGN_P12 / WA_PI_WIN_SIGN_PASSWORD 指定已有 p12\n` +
			`      ③ 仅本地测试可设 WA_PI_SKIP_WIN_SIGN=1 跳过签名\n` +
			`当前查找路径：${paths.p12}`,
	);
}

/**
 * 生成自签证书（幂等：p12 已存在就完全不动，绝不覆盖）。
 * @returns {{created: boolean, password: string | null, paths: object}}
 */
function createCert({
	dir = resolveCertDir(),
	exec = execFileSync,
	exists = fs.existsSync,
	writeFile = (p, c, o) => fs.writeFileSync(p, c, o),
	randomBytes,
} = {}) {
	const paths = certPaths(dir);
	if (exists(paths.p12)) return { created: false, password: null, paths };
	fs.mkdirSync(dir, { recursive: true });
	const password = generatePassword(randomBytes);
	writeFile(paths.cnf, CERT_CONFIG_TEXT());
	exec("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:3072",
		"-keyout",
		paths.key,
		"-out",
		paths.pem,
		"-days",
		"3650",
		"-nodes",
		"-config",
		paths.cnf,
	]);
	// PEM → DER：这是发给 Windows 用户导入的正式格式
	exec("openssl", [
		"x509",
		"-in",
		paths.pem,
		"-outform",
		"DER",
		"-out",
		paths.cer,
	]);
	exec("openssl", [
		"pkcs12",
		"-export",
		"-out",
		paths.p12,
		"-inkey",
		paths.key,
		"-in",
		paths.pem,
		"-passout",
		`pass:${password}`,
		"-name",
		CERT_CN,
	]);
	writeFile(paths.password, `${password}\n`, { mode: 0o600 });
	// 私钥文件同样收紧权限（openssl 默认 0644）
	try {
		fs.chmodSync(paths.key, 0o600);
		fs.chmodSync(paths.p12, 0o600);
	} catch {}
	return { created: true, password, paths };
}

// ─── CLI ──────────────────────────────────────────────────────────────────
function main(argv) {
	const cmd = argv[0] || "info";
	const dir = resolveCertDir();
	const paths = certPaths(dir);
	if (cmd === "create") {
		const r = createCert({ dir });
		if (!r.created) {
			console.log(`✅ 证书已存在，跳过生成（绝不覆盖）：${paths.p12}`);
		} else {
			console.log(`✅ 已生成 Windows 代码签名证书（有效期 10 年）：
  p12（私钥，勿外传）: ${paths.p12}
  cer（DER，发给 Windows 用户导入）: ${paths.cer}
  pem（openssl 校验用）: ${paths.pem}
  密码文件:            ${paths.password}（0600）`);
		}
		console.log(`
用户一次性导入根证书（管理员 PowerShell）：
  Import-Certificate -FilePath "${paths.cer}" -CertStoreLocation Cert:\\LocalMachine\\Root
导入后安装包的 UAC 弹窗显示「已验证的发布者：${CERT_CN}」。`);
		return;
	}
	if (cmd === "cer") {
		console.log(paths.cer);
		return;
	}
	// info
	const material = readSigningMaterial();
	console.log(`证书目录: ${dir}`);
	console.log(`p12: ${paths.p12} ${fs.existsSync(paths.p12) ? "✓" : "✗ 缺失"}`);
	console.log(`cer: ${paths.cer} ${fs.existsSync(paths.cer) ? "✓" : "✗ 缺失"}（DER）`);
	console.log(`pem: ${paths.pem} ${fs.existsSync(paths.pem) ? "✓" : "✗ 缺失"}`);
	console.log(
		material
			? `材料来源: ${material.source}`
			: "材料: ✗ 不可用（先执行 create）",
	);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
	CERT_CN,
	CERT_CONFIG_TEXT,
	certPaths,
	createCert,
	ensureSigningMaterial,
	generatePassword,
	readSigningMaterial,
	resolveCertDir,
};
