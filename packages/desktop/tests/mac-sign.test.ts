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
import { readFile } from "node:fs/promises";

describe("resolveIdentity", () => {
	const noCert = {
		exec: () => {
			throw new Error("cert not found");
		},
	};
	const hasCertEnv = {
		exec: () => "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----",
	};

	test("无 CODESIGN_IDENTITY 且钥匙串无证书 → 报错（禁止静默回退 ad-hoc，防 OTA 断更新）", () => {
		// ad-hoc 签名的 requirement 是 cdhash，已装用户的 Squirrel.Mac 更新验证必败
		// （0.9.1 断更新根因），故回退路径改为直接报错并给出修复指引。
		expect(() => resolveIdentity({}, noCert)).toThrow(/WA PI Agent Self-Signed/);
		expect(() => resolveIdentity({}, noCert)).toThrow(/OTA|更新失败/);
		expect(() => resolveIdentity({ CODESIGN_IDENTITY: "  " }, noCert)).toThrow();
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
	test("无证书（身份解析失败）→ signed:false + 含修复指引的 error", () => {
		// 纯桩逻辑（security 无证书 → resolveIdentity 抛错，根本走不到 codesign），全平台可跑
		const app = makeFakeApp();
		try {
			const result = signMacApp(app, { env: {}, exec: execNoCert });
			expect(result.signed).toBe(false);
			expect(result.error).toMatch(/WA PI Agent Self-Signed/);
			expect(result.error).toMatch(/OTA|更新失败/);
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
		// 显式 ad-hoc 绕过证书查找，聚焦测 codesign 执行失败的错误传播
		const result = signMacApp("/nonexistent.app", {
			env: { CODESIGN_IDENTITY: "-" },
			exec,
		});
		expect(result.signed).toBe(false);
		expect(result.error).toBe("codesign: invalid identity");
	});

	test("verify 失败 → 返回 signed:false", () => {
		let call = 0;
		const exec = () => {
			call += 1;
			if (call > 1) throw new Error("code object is not signed at all");
		};
		const result = signMacApp("/tmp/any.app", {
			env: { CODESIGN_IDENTITY: "-" },
			exec,
		});
		expect(result.signed).toBe(false);
		expect(result.error).toBe("code object is not signed at all");
	});
});

describe("electron-builder 打包配置：macOS 签名与 Apple TSA 解耦", () => {
	// 背景：electron-builder 内部签名 pass（@electron/osx-sign）对每个文件无条件追加
	// `--timestamp`（不带 URL → 走 Apple 默认时间戳服务），TSA 抖动/超时就整包中止。
	// `mac.timestamp: null` 无效：MacTargetHelper.buildSignOptions 里是
	// `timestamp: customSignOptions.timestamp || undefined`，null 被吞成 undefined，
	// osx-sign 收到 undefined 又回落到默认 TSA 分支。
	// 解法：codesign 同一选项「后者覆盖前者」，用 additionalArguments 追加
	// `--timestamp=none`（osx-sign 把它拼在 --timestamp 之后、文件路径之前）。
	test("mac.additionalArguments 追加 --timestamp=none", async () => {
		const yml = await readFile(
			join(import.meta.dir, "..", "electron-builder.yml"),
			"utf8",
		);
		expect(yml).toContain('"--timestamp=none"');
		// hardened runtime 必须保留：这是时间戳被强制引入的原因，去掉它会改变签名语义
		expect(yml).toContain("hardenedRuntime: true");
	});
});
