import { test, expect, describe } from "bun:test";
import {
	resolveIdentity,
	buildSignArgs,
	signMacApp,
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

describe("resolveIdentity", () => {
	test("未设置 CODESIGN_IDENTITY → 回退 ad-hoc（-）", () => {
		expect(resolveIdentity({})).toBe("-");
		expect(resolveIdentity({ CODESIGN_IDENTITY: "  " })).toBe("-");
	});

	test("设置了 CODESIGN_IDENTITY → 使用证书身份（去空白）", () => {
		expect(
			resolveIdentity({
				CODESIGN_IDENTITY: "Developer ID Application: ACME (ABC123)",
			}),
		).toBe("Developer ID Application: ACME (ABC123)");
		expect(resolveIdentity({ CODESIGN_IDENTITY: "  my-cert  " })).toBe(
			"my-cert",
		);
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
		expect(buildSignArgs("/tmp/A.app", "my-cert").slice(3)).toEqual([
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

const darwin = process.platform === "darwin" ? test : test.skip;

describe("signMacApp", () => {
	darwin("成功签名最小 .app 并通过 verify（真实 codesign）", () => {
		const app = makeFakeApp();
		try {
			const result = signMacApp(app, { env: {} });
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
