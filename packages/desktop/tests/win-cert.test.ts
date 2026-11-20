// win-cert.test.ts — Windows 代码签名证书的解析/生成逻辑。
//
// 背景：Windows 客户端此前完全跳过签名（electron-builder.yml 的 signExecutable: false），
// 用户安装时 UAC 显示「未知的发布者」。现改为自签代码签名证书（EKU=Code Signing，
// CA:FALSE）对 exe/安装包签名。证书文件放仓库之外的用户目录，避免私钥进 git；
// 路径可用 WA_PI_WIN_SIGN_P12 / WA_PI_WIN_SIGN_PASSWORD 覆盖（CI 场景）。
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const winCert = require("../scripts/win-cert.cjs");

describe("win-cert（证书路径与来源解析）", () => {
	test("certPaths：p12/pass/cer 三个文件都在指定目录下", () => {
		const p = winCert.certPaths("/tmp/ac-test");
		expect(p.p12).toBe("/tmp/ac-test/win-signing.p12");
		expect(p.password).toBe("/tmp/ac-test/win-signing.pass");
		expect(p.cer).toBe("/tmp/ac-test/win-signing.cer"); // DER（Windows Import-Certificate 只认 DER）
		expect(p.pem).toBe("/tmp/ac-test/win-signing.pem"); // PEM 另存，供 openssl 校验用
	});

	test("resolveCertDir：默认 ~/.wa-pi-ac，WA_PI_AC_DIR 可覆盖", () => {
		expect(winCert.resolveCertDir({ env: {}, home: "/Users/x" })).toBe(
			"/Users/x/.wa-pi-ac",
		);
		expect(
			winCert.resolveCertDir({ env: { WA_PI_AC_DIR: "/data/ac" }, home: "/Users/x" }),
		).toBe("/data/ac");
	});

	test("readSigningMaterial：环境变量（p12 + 密码）优先于文件", () => {
		const m = winCert.readSigningMaterial({
			env: {
				WA_PI_WIN_SIGN_P12: "/env/cert.p12",
				WA_PI_WIN_SIGN_PASSWORD: "env-pass",
			},
			home: "/Users/x",
			exists: () => true,
			readFile: () => "file-pass\n",
		});
		expect(m).toEqual({ p12: "/env/cert.p12", password: "env-pass", source: "env" });
	});

	test("readSigningMaterial：只给 p12 不给密码 → 明确报错（不接受半套配置）", () => {
		expect(() =>
			winCert.readSigningMaterial({
				env: { WA_PI_WIN_SIGN_P12: "/env/cert.p12" },
				home: "/Users/x",
				exists: () => true,
				readFile: () => "file-pass\n",
			}),
		).toThrow(/WA_PI_WIN_SIGN_PASSWORD/);
	});

	test("readSigningMaterial：只给密码不给 p12 → 明确报错", () => {
		expect(() =>
			winCert.readSigningMaterial({
				env: { WA_PI_WIN_SIGN_PASSWORD: "pw" },
				home: "/Users/x",
				exists: () => false,
			}),
		).toThrow(/WA_PI_WIN_SIGN_P12/);
	});

	test("readSigningMaterial：读文件并 trim 密码", () => {
		const m = winCert.readSigningMaterial({
			env: {},
			home: "/Users/x",
			exists: (p: string) => p.endsWith(".p12") || p.endsWith(".pass"),
			readFile: () => "  secret-pass\n\n",
		});
		expect(m).toEqual({
			p12: "/Users/x/.wa-pi-ac/win-signing.p12",
			password: "secret-pass",
			source: "file",
		});
	});

	test("readSigningMaterial：p12 不存在 → null", () => {
		const m = winCert.readSigningMaterial({
			env: {},
			home: "/Users/x",
			exists: () => false,
			readFile: () => {
				throw new Error("不该读文件");
			},
		});
		expect(m).toBeNull();
	});

	test("ensureSigningMaterial：材料缺失 → 报错且给出创建命令", () => {
		expect(() =>
			winCert.ensureSigningMaterial({
				env: {},
				home: "/Users/x",
				exists: () => false,
			}),
		).toThrow(/win-cert\.cjs create/);
	});

	test("generatePassword：24 位字母数字（无 shell 特殊字符）", () => {
		const pw = winCert.generatePassword();
		expect(pw).toHaveLength(24);
		expect(pw).toMatch(/^[A-Za-z0-9]{24}$/);
		expect(winCert.generatePassword()).not.toBe(pw);
	});

	test("CERT_CONFIG_TEXT：带 Code Signing EKU 且不是 CA", () => {
		const text = winCert.CERT_CONFIG_TEXT();
		expect(text).toContain("extendedKeyUsage=critical,codeSigning");
		expect(text).toContain("basicConstraints=critical,CA:FALSE");
		expect(text).toContain("keyUsage=critical,digitalSignature");
	});
});

describe("win-cert create（幂等生成）", () => {
	test("证书已存在 → 不执行 openssl（绝不覆盖已有证书）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-cert-test-"));
		try {
			const paths = winCert.certPaths(dir);
			writeFileSync(paths.p12, "x");
			const calls: string[][] = [];
			const r = winCert.createCert({
				dir,
				exec: (_bin: string, args: string[]) => {
					calls.push(args);
					return "";
				},
				exists: (p: string) => p === paths.p12,
			});
			expect(r.created).toBe(false);
			expect(calls).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("首次生成：req → x509 DER → pkcs12 三条命令，配置含 Code Signing EKU", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-cert-test-"));
		try {
			const paths = winCert.certPaths(dir);
			const calls: string[][] = [];
			const r = winCert.createCert({
				dir,
				exec: (_bin: string, args: string[]) => {
					calls.push(args);
					// 模拟 openssl 产出文件
					if (args[0] === "req") writeFileSync(paths.p12, "dummy");
					return "";
				},
				exists: () => false,
				writeFile: (p: string, c: string) => {
					writeFileSync(p, c);
					if (p === paths.p12) mkdirSync(dir, { recursive: true });
				},
			});
			expect(r.created).toBe(true);
			expect(r.password).toHaveLength(24);
			// req（出 PEM）→ x509 -outform DER（出用户导入的 .cer）→ pkcs12（出 p12）
			expect(calls).toHaveLength(3);
			expect(calls[0][0]).toBe("req");
			expect(calls[1][0]).toBe("x509");
			expect(calls[1]).toContain("-outform");
			expect(calls[1]).toContain("DER");
			expect(calls[2][0]).toBe("pkcs12");
			// 配置文本断言：EKU/CA 约束写在临时 cnf 里，经 -config 传入
			const cfgArg = calls[0].find((a) => a.includes("win-signing.cnf"));
			expect(cfgArg).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
