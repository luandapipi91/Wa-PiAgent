import { test, expect, describe } from "bun:test";
import {
	resolveIdentity,
	buildSignArgs,
	signMacApp,
	hasCert,
	DEFAULT_SELF_SIGNED_CERT,
} from "../scripts/mac-sign.cjs";
import {
	mkdtempSync,
	mkdirSync,
	copyFileSync,
	chmodSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("resolveIdentity", () => {
	const noCert = {
		exec: () => {
			throw new Error("cert not found");
		},
	};
	const hasCertEnv = {
		exec: () => "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----",
	};

	test("无 CODESIGN_IDENTITY 且钥匙串无证书 → 回退 ad-hoc（-）", () => {
		expect(resolveIdentity({}, noCert)).toBe("-");
		expect(resolveIdentity({ CODESIGN_IDENTITY: "  " }, noCert)).toBe("-");
	});

	test("钥匙串有默认自签名证书时自动使用（避免静默回退 ad-hoc）", () => {
		expect(resolveIdentity({}, hasCertEnv)).toBe("WA PI Agent Self-Signed");
		expect(DEFAULT_SELF_SIGNED_CERT).toBe("WA PI Agent Self-Signed");
	});

	test("WA_PI_SELF_SIGNED_CERT 可覆盖证书名 / 空字符串禁用回退", () => {
		expect(
			resolveIdentity({ WA_PI_SELF_SIGNED_CERT: "My Cert" }, hasCertEnv),
		).toBe("My Cert");
		expect(resolveIdentity({ WA_PI_SELF_SIGNED_CERT: "" }, hasCertEnv)).toBe("-");
	});

	test("设置了 CODESIGN_IDENTITY → 使用证书身份（去空白），传 - 强制 ad-hoc", () => {
		expect(
			resolveIdentity(
				{ CODESIGN_IDENTITY: "Developer ID Application: ACME (ABC123)" },
				hasCertEnv,
			),
		).toBe("Developer ID Application: ACME (ABC123)");
		expect(
			resolveIdentity({ CODESIGN_IDENTITY: "  my-cert  " }, hasCertEnv),
		).toBe("my-cert");
		expect(resolveIdentity({ CODESIGN_IDENTITY: "-" }, hasCertEnv)).toBe("-");
	});
});

describe("hasCert", () => {
	test("security 返回 PEM 证书内容 → true", () => {
		expect(
			hasCert(
				"X",
				(() =>
					"-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----") as unknown as typeof execFileSync,
			),
		).toBe(true);
	});
	test("security 无匹配但 exit 0（无 PEM 输出）→ false", () => {
		expect(hasCert("X", (() => "") as unknown as typeof execFileSync)).toBe(
			false,
		);
	});
	test("security 查询失败（异常）→ false", () => {
		expect(
			hasCert("X", (() => {
				throw new Error("no");
			}) as unknown as typeof execFileSync),
		).toBe(false);
	});
});

describe("buildSignArgs", () => {
	test("构造 codesign 参数（--force --deep --sign）", () => {
		expect(buildSignArgs("/tmp/WA PI Agent.app", "-")).toEqual([
			"--force",
			"--deep",
			"--sign",
			"-",
			"/tmp/WA PI Agent.app",
		]);
		expect(buildSignArgs("/tmp/A.app", "my-cert")).toEqual([
			"--force",
			"--deep",
			"--sign",
			"my-cert",
			"/tmp/A.app",
		]);
	});
});

// 构造一个可被 codesign 接受的最小 .app 目录
function makeFakeApp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mac-sign-test-"));
	const contents = join(dir, "Contents");
	const macos = join(contents, "MacOS");
	mkdirSync(macos, { recursive: true });
	// 拷贝任意系统 Mach-O 作为可执行文件（签名只要求是有效二进制/脚本）
	copyFileSync("/bin/echo", join(macos, "FakeApp"));
	chmodSync(join(macos, "FakeApp"), 0o755);
	writeFileSync(
		join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fake</string></dict></plist>
`,
	);
	return dir;
}

const realExecFileSync = require("node:child_process").execFileSync;

/** codesign 走真实执行、security 视为无证书（强制 ad-hoc 路径）的桩。 */
function execNoCert(cmd, args, opts) {
	if (cmd === "security") throw new Error("cert not found");
	return realExecFileSync(cmd, args, opts);
}

const darwin = process.platform === "darwin" ? test : test.skip;

describe("signMacApp", () => {
	darwin("成功签名最小 .app 并通过 verify（无证书→ad-hoc）", () => {
		const app = makeFakeApp();
		try {
			const result = signMacApp(app, { env: {}, exec: execNoCert });
			expect(result.signed).toBe(true);
			expect(result.identity).toBe("-");
		} finally {
			rmSync(app, { recursive: true, force: true });
		}
	});

	darwin("CODESIGN_IDENTITY 参与身份选择", () => {
		const app = makeFakeApp();
		try {
			const result = signMacApp(app, { env: { CODESIGN_IDENTITY: "-" } });
			expect(result.signed).toBe(true);
		} finally {
			rmSync(app, { recursive: true, force: true });
		}
	});

	test("codesign 失败 → 返回 signed:false + 首行错误", () => {
		const exec = () => {
			throw new Error("codesign: invalid identity\nat line 2");
		};
		const result = signMacApp("/nonexistent.app", { exec });
		expect(result.signed).toBe(false);
		expect(result.error).toBe("codesign: invalid identity");
	});

	test("verify 失败 → 返回 signed:false", () => {
		let call = 0;
		const exec = () => {
			call += 1;
			if (call > 1) throw new Error("code object is not signed at all");
		};
		const result = signMacApp("/tmp/any.app", { exec });
		expect(result.signed).toBe(false);
		expect(result.error).toBe("code object is not signed at all");
	});
});
