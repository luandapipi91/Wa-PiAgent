// win-sign.test.ts — Windows 签名的校验/工具解析/内核清单刷新。
//
// 背景：签名本身由 electron-builder 内置的 osslsigncode 路径完成（macOS 交叉签名），
// 本模块只负责三件我们自己的事：
//   ① 找到 osslsigncode（优先用 electron-builder 缓存里的 winCodeSign 自带的那个：
//      legacy 版本不依赖系统 openssl，且对 stdin 管道化/覆盖输出都正常）；
//   ② 签名后刷新 resources/kernel/manifest.json 的 exe.size/sha256（签名会改变 exe 大小，
//      而应用启动时的壳/核一致性自检按大小比对，不刷新会每天误报）；
//   ③ 打包结束前校验产物真的带签名（坏包不许流入 release/）。
//
// 关键事实：osslsigncode verify 对「没有签名」的文件**退出码仍是 0**（打印 No signature found），
// 因此判定必须解析输出文本，不能看退出码。
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const winSign = require("../scripts/win-sign.cjs");

// 真实输出（macOS + winCodeSign-2.6.0 自带 osslsigncode 实测抓取）
const OUT_SIGNED = `Current PE checksum   : 0B3BF0A2
Calculated PE checksum: 0B3BF0A2

Message digest algorithm  : SHA256
Current message digest    : F31F8BD7AE8FAC3B7E03CBD25AEA078E0C9B074282F27393C57E2D9534223975
Calculated message digest : F31F8BD7AE8FAC3B7E03CBD25AEA078E0C9B074282F27393C57E2D9534223975

Signature verification: ok

Number of signers: 1
\tSigner #0:
\t\tSubject: /CN=WA PI Agent Windows Self-Signed/O=WA PI/C=CN
\t\tIssuer : /CN=WA PI Agent Windows Self-Signed/O=WA PI/C=CN
\t\tSerial : D670403080ECE2FF

Number of certificates: 4
\tCert #3:
\t\tSubject: /C=US/O=DigiCert, Inc./CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1

Succeeded`;

const OUT_UNSIGNED = `Current PE checksum   : 00000000
Calculated PE checksum: 0B3B97C1

No signature found.

Succeeded`;

describe("parseVerifyOutput（必须按文本判定，退出码不可信）", () => {
	test("有签名 + 时间戳 → signed/timestamp/subject 正确", () => {
		const r = winSign.parseVerifyOutput(OUT_SIGNED);
		expect(r.signed).toBe(true);
		expect(r.count).toBe(1);
		expect(r.subject).toContain("WA PI Agent Windows Self-Signed");
		expect(r.timestamp).toBe(true);
	});

	test("无签名 → signed=false（尽管输出以 Succeeded 结尾）", () => {
		const r = winSign.parseVerifyOutput(OUT_UNSIGNED);
		expect(r.signed).toBe(false);
		expect(r.subject).toBeNull();
	});

	test("签名校验失败 → signed=false", () => {
		const r = winSign.parseVerifyOutput(
			"Signature verification: failed\n\nNumber of signers: 1\n",
		);
		expect(r.signed).toBe(false);
	});

	test("空输出 → signed=false（工具异常时不能误判为已签名）", () => {
		expect(winSign.parseVerifyOutput("").signed).toBe(false);
	});
});

describe("resolveOsslsigncode（工具来源优先级）", () => {
	test("WA_PI_OSSLSIGNCODE 环境变量最高优先，且带出同目录 lib 的 DYLD_LIBRARY_PATH", () => {
		const r = winSign.resolveOsslsigncode({
			env: { WA_PI_OSSLSIGNCODE: "/opt/bin/osslsigncode" },
			home: "/Users/x",
			exists: (p: string) => p === "/opt/bin/lib",
			readdir: () => [],
		});
		expect(r.path).toBe("/opt/bin/osslsigncode");
		expect(r.env.DYLD_LIBRARY_PATH).toBe("/opt/bin/lib");
	});

	test("扫描 electron-builder 缓存：多个 winCodeSign 版本取最新的 10.12 二进制", () => {
		const r = winSign.resolveOsslsigncode({
			env: {},
			home: "/Users/x",
			exists: () => true,
			readdir: (p: string) => {
				if (p.includes("/winCodeSign")) {
					return ["winCodeSign-2.6.0", "winCodeSign-2.10.0"];
				}
				return [];
			},
		});
		expect(r.path).toContain("winCodeSign-2.10.0");
		expect(r.path).toContain("darwin/10.12/osslsigncode");
		expect(r.env.DYLD_LIBRARY_PATH).toContain("darwin/10.12/lib");
	});

	test("全都没有 → null（由调用方给出修复指引）", () => {
		const r = winSign.resolveOsslsigncode({
			env: {},
			home: "/Users/x",
			exists: () => false,
			readdir: () => [],
		});
		expect(r).toBeNull();
	});
});

describe("refreshKernelManifest（签名改变 exe 大小，清单必须跟着改）", () => {
	test("大小/哈希与清单不符 → 更新；再次调用不再改动", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const kernelDir = join(dir, "kernel");
			mkdirSync(kernelDir, { recursive: true });
			const exeName = "WaPiKernel.exe";
			const exePath = join(kernelDir, exeName);
			writeFileSync(exePath, Buffer.from("signed-kernel-bytes"));
			const realSize = readFileSync(exePath).length;
			const realHash = createHash("sha256")
				.update(readFileSync(exePath))
				.digest("hex");
			writeFileSync(
				join(kernelDir, "manifest.json"),
				JSON.stringify({
					version: "1.2.3",
					exe: { name: exeName, size: 1, sha256: "deadbeef" },
				}),
			);

			const r1 = winSign.refreshKernelManifest(kernelDir);
			expect(r1.updated).toBe(true);
			const manifest = JSON.parse(
				readFileSync(join(kernelDir, "manifest.json"), "utf8"),
			);
			expect(manifest.exe.size).toBe(realSize);
			expect(manifest.exe.sha256).toBe(realHash);
			// 其他字段不许被改（version 是壳/核一致性校验的主键）
			expect(manifest.version).toBe("1.2.3");
			expect(manifest.exe.name).toBe(exeName);

			const r2 = winSign.refreshKernelManifest(kernelDir);
			expect(r2.updated).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("manifest 不存在 → 不报错、返回 updated=false（老产物兼容）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			expect(winSign.refreshKernelManifest(dir).updated).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifySignature（调用 osslsigncode verify 并按文本判定）", () => {
	test("成功路径：stdin 必须 ignore（管道化会让 osslsigncode 去读密码）", () => {
		let seenStdio: unknown;
		const r = winSign.verifySignature("/x/a.exe", {
			tool: { path: "/t/osslsigncode", env: { DYLD_LIBRARY_PATH: "/t/lib" } },
			exec: (_bin: string, _args: string[], opts: Record<string, unknown>) => {
				seenStdio = opts.stdio;
				return OUT_SIGNED;
			},
		});
		expect(r.signed).toBe(true);
		expect(seenStdio).toEqual(["ignore", "pipe", "pipe"]);
	});

	test("工具报错（无签名/校验失败）→ signed=false，不抛出（由调用方决定是否终止）", () => {
		const r = winSign.verifySignature("/x/a.exe", {
			tool: { path: "/t/osslsigncode", env: {} },
			exec: () => {
				const e: any = new Error("exit 1");
				e.stdout = OUT_UNSIGNED;
				throw e;
			},
		});
		expect(r.signed).toBe(false);
	});

	test("找不到工具 → 抛错并给出安装指引（绝不静默放行）", () => {
		expect(() => winSign.verifySignature("/x/a.exe", { tool: null })).toThrow(
			/osslsigncode/,
		);
	});
});

describe("collectVerifyTargets（哪些文件必须带签名）", () => {
	test("主程序 + 内核 exe + 安装包；跳过不存在的与 blockmap/yml", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const appOutDir = join(dir, "win-unpacked");
			mkdirSync(join(appOutDir, "resources", "kernel"), { recursive: true });
			writeFileSync(join(appOutDir, "WA PI Agent.exe"), "mz");
			writeFileSync(join(appOutDir, "resources", "kernel", "WaPiKernel.exe"), "mz");
			writeFileSync(join(dir, "WaPi-Setup-1.0.0.exe"), "mz");
			writeFileSync(join(dir, "WaPi-Setup-1.0.0.exe.blockmap"), "{}");
			writeFileSync(join(dir, "latest.yml"), "x");

			const targets = winSign.collectVerifyTargets({
				appOutDir,
				productFilename: "WA PI Agent",
				artifactPaths: [
					join(dir, "WaPi-Setup-1.0.0.exe"),
					join(dir, "WaPi-Setup-1.0.0.exe.blockmap"),
					join(dir, "latest.yml"),
					join(dir, "missing.exe"),
				],
			});
			expect(targets).toHaveLength(3);
			expect(targets.some((p: string) => p.endsWith("WA PI Agent.exe"))).toBe(true);
			expect(targets.some((p: string) => p.endsWith("WaPiKernel.exe"))).toBe(true);
			expect(targets.some((p: string) => p.endsWith("WaPi-Setup-1.0.0.exe"))).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifyWindowsArtifacts（坏包不许流入 release/）", () => {
	test("有未签名文件 → 抛错并指名文件", () => {
		expect(() =>
			winSign.verifyWindowsArtifacts(
				{ appOutDir: "/x", productFilename: "WA PI Agent", artifactPaths: [] },
				{
					collectTargets: () => ["/x/a.exe", "/x/b.exe"],
					verify: (f: string) => ({ signed: f === "/x/a.exe", detail: "mock" }),
				},
			),
		).toThrow(/b\.exe/);
	});

	test("全部已签名 → 不抛错并返回明细", () => {
		const results = winSign.verifyWindowsArtifacts(
			{ appOutDir: "/x", productFilename: "WA PI Agent", artifactPaths: [] },
			{
				collectTargets: () => ["/x/a.exe"],
				verify: () => ({ signed: true, detail: "ok" }),
			},
		);
		expect(results).toHaveLength(1);
		expect(results[0].signed).toBe(true);
	});

	test("没有任何目标文件 → 视为失败（防止静默跳过校验）", () => {
		expect(() =>
			winSign.verifyWindowsArtifacts(
				{ appOutDir: "/x", productFilename: "WA PI Agent", artifactPaths: [] },
				{ collectTargets: () => [], verify: () => ({ signed: true }) },
			),
		).toThrow(/未找到/);
	});
});

describe("checkWinYmlHash（清单哈希必须等于已签名安装包的实际哈希）", () => {
	test("sha512/size 一致 → ok", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const installer = join(dir, "WaPi-Setup-1.0.0.exe");
			const body = Buffer.from("installer-bytes");
			writeFileSync(installer, body);
			const sha512 = createHash("sha512").update(body).digest("base64");
			writeFileSync(
				join(dir, "latest.yml"),
				`version: 1.0.0\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: ${sha512}\n    size: ${body.length}\n`,
			);
			const r = winSign.checkWinYmlHash({
				ymlPath: join(dir, "latest.yml"),
				installerPath: installer,
			});
			expect(r.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("哈希不一致（例如签了安装包但清单没重算）→ ok=false", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const installer = join(dir, "WaPi-Setup-1.0.0.exe");
			writeFileSync(installer, "installer-bytes");
			writeFileSync(
				join(dir, "latest.yml"),
				`version: 1.0.0\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: AAAArealhash\n    size: 999999\n`,
			);
			const r = winSign.checkWinYmlHash({
				ymlPath: join(dir, "latest.yml"),
				installerPath: installer,
			});
			expect(r.ok).toBe(false);
			expect(r.reasons.join(",")).toContain("sha512");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("清单缺失 → 跳过（返回 ok=true + skipped）", () => {
		const r = winSign.checkWinYmlHash({
			ymlPath: "/nonexistent/latest.yml",
			installerPath: "/nonexistent/setup.exe",
			exists: () => false,
		});
		expect(r.ok).toBe(true);
		expect(r.skipped).toBe(true);
	});
});

test("模块可被 after-pack/after-all-artifact-build 钩子按 CJS 加载", () => {
	expect(existsSync(join(__dirname, "..", "scripts", "win-sign.cjs"))).toBe(true);
	expect(typeof winSign.verifyWindowsArtifacts).toBe("function");
});

describe("syncWinYmlHash（签名后强制对齐清单哈希）", () => {
	test("哈希/大小不一致 → 就地修正 sha512 与 size，其余字段原样保留", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const installer = join(dir, "WaPi-Setup-1.0.0.exe");
			const body = Buffer.from("signed-installer-bytes");
			writeFileSync(installer, body);
			const sha512 = createHash("sha512").update(body).digest("base64");
			const ymlPath = join(dir, "latest.yml");
			writeFileSync(
				ymlPath,
				`version: 1.2.3\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: OLD\n    size: 1\npath: setup.exe\nsha512: OLD\nreleaseDate: '2026-11-20T03:03:16.341Z'\n`,
			);
			const r = winSign.syncWinYmlHash({ ymlPath, installerPath: installer });
			expect(r.fixed).toBe(true);
			const yml = readFileSync(ymlPath, "utf8");
			expect(yml).toContain(`sha512: ${sha512}`);
			expect(yml).toContain(`size: ${body.length}`);
			expect(yml).toContain("version: 1.2.3");
			expect(yml).toContain("releaseDate: '2026-11-20T03:03:16.341Z'");
			expect(yml).not.toContain("OLD");
			// 修正后再次校验必须通过
			expect(winSign.checkWinYmlHash({ ymlPath, installerPath: installer }).ok).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("已经一致 → 不写文件（fixed=false）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const installer = join(dir, "WaPi-Setup-1.0.0.exe");
			const body = Buffer.from("bytes");
			writeFileSync(installer, body);
			const sha512 = createHash("sha512").update(body).digest("base64");
			const ymlPath = join(dir, "latest.yml");
			const original = `version: 1.0.0\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: ${sha512}\n    size: ${body.length}\n`;
			writeFileSync(ymlPath, original);
			const r = winSign.syncWinYmlHash({ ymlPath, installerPath: installer });
			expect(r.fixed).toBe(false);
			expect(readFileSync(ymlPath, "utf8")).toBe(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("清单缺失 → skipped（不凭空生成）", () => {
		const r = winSign.syncWinYmlHash({
			ymlPath: "/nonexistent/latest.yml",
			installerPath: "/nonexistent/setup.exe",
			exists: () => false,
		});
		expect(r.skipped).toBe(true);
	});
});

describe("verifyWindowsRelease（外层收尾：清单必须与已签名安装包一致）", () => {
	test("清单失配 → 自动对齐并报告", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const body = Buffer.from("final-signed-installer");
			writeFileSync(join(dir, "WaPi-Setup-1.0.0.exe"), body);
			writeFileSync(
				join(dir, "latest.yml"),
				"version: 1.0.0\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: OLD\n    size: 1\n",
			);
			const r = winSign.verifyWindowsRelease({ outDir: dir, version: "1.0.0" });
			expect(r.fixed).toBe(true);
			expect(r.ok).toBe(true);
			expect(r.installer.endsWith("WaPi-Setup-1.0.0.exe")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("清单已一致 → fixed=false、ok=true", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const body = Buffer.from("abc");
			writeFileSync(join(dir, "WaPi-Setup-1.0.0.exe"), body);
			const sha512 = createHash("sha512").update(body).digest("base64");
			writeFileSync(
				join(dir, "latest.yml"),
				`version: 1.0.0\nfiles:\n  - url: WaPi-Setup-1.0.0.exe\n    sha512: ${sha512}\n    size: ${body.length}\n`,
			);
			const r = winSign.verifyWindowsRelease({ outDir: dir, version: "1.0.0" });
			expect(r.fixed).toBe(false);
			expect(r.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("没有安装包 → 抛错（产物目录异常，必须让打包失败）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			expect(() =>
				winSign.verifyWindowsRelease({ outDir: dir, version: "1.0.0" }),
			).toThrow(/未找到/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("安装包在但清单缺失 → ok=false 且给出提示（不抛错，发布脚本会拦）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			writeFileSync(join(dir, "WaPi-Setup-1.0.0.exe"), "x");
			const r = winSign.verifyWindowsRelease({ outDir: dir, version: "1.0.0" });
			expect(r.ok).toBe(false);
			expect(r.reason).toContain("latest.yml");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("审查发现的缺陷回归", () => {
	test("verifyWindowsRelease 按版本精确选包：查 0.10.1 不能选中 0.10.10/0.10.11/0.10.12", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			for (const v of ["0.10.1", "0.10.10", "0.10.11", "0.10.12"]) {
				writeFileSync(join(dir, `WaPi-Setup-${v}.exe`), `body-${v}`);
			}
			writeFileSync(
				join(dir, "latest.yml"),
				"version: 0.10.1\nfiles:\n  - url: WaPi-Setup-0.10.1.exe\n    sha512: x\n    size: 1\n",
			);
			const r = winSign.verifyWindowsRelease({ outDir: dir, version: "0.10.1" });
			expect(r.installer.endsWith("WaPi-Setup-0.10.1.exe")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("syncWinYmlHash 不得改坏 releaseNotes 里出现的 sha512/size 字样", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const installer = join(dir, "WaPi-Setup-1.0.0.exe");
			const body = Buffer.from("body");
			writeFileSync(installer, body);
			const sha512 = createHash("sha512").update(body).digest("base64");
			const ymlPath = join(dir, "latest.yml");
			writeFileSync(
				ymlPath,
				[
					"version: 1.0.0",
					"files:",
					"  - url: WaPi-Setup-1.0.0.exe",
					"    sha512: OLD",
					"    size: 1",
					"path: setup.exe",
					"sha512: OLD",
					"releaseNotes: |",
					"  修复日志里出现 sha512: 手写样例，以及 size: 12 这样的描述",
					"",
				].join("\n"),
			);
			winSign.syncWinYmlHash({ ymlPath, installerPath: installer });
			const yml = readFileSync(ymlPath, "utf8");
			// 结构字段被修正
			expect(yml).toContain(`    sha512: ${sha512}`);
			expect(yml).toContain(`    size: ${body.length}`);
			// 说明文字原样保留
			expect(yml).toContain("修复日志里出现 sha512: 手写样例，以及 size: 12 这样的描述");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("collectVerifyTargets：主程序 exe 缺失 → 抛错（Windows 构建必有主程序）", () => {
		const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
		try {
			const appOutDir = join(dir, "win-unpacked");
			mkdirSync(appOutDir, { recursive: true }); // 只有目录，没有主程序 exe
			writeFileSync(join(dir, "setup.exe"), "mz");
			expect(() =>
				winSign.collectVerifyTargets({
					appOutDir,
					productFilename: "WA PI Agent",
					artifactPaths: [join(dir, "setup.exe")],
				}),
			).toThrow(/主程序/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("verifyWindowsRelease：清单指向的安装包与待校验包不一致 → 抛错且不改写清单", () => {
	const dir = mkdtempSync(join(tmpdir(), "win-sign-test-"));
	try {
		writeFileSync(join(dir, "WaPi-Setup-0.10.12.exe"), "new");
		writeFileSync(join(dir, "WaPi-Setup-0.9.1.exe"), "old");
		const ymlPath = join(dir, "latest.yml");
		const original =
			"version: 0.10.12\nfiles:\n  - url: WaPi-Setup-0.10.12.exe\n    sha512: KEEP\n    size: 1\npath: WaPi-Setup-0.10.12.exe\nsha512: KEEP\n";
		writeFileSync(ymlPath, original);
		// 误用：拿 0.9.1 去和指向 0.10.12 的清单比对
		expect(() =>
			winSign.verifyWindowsRelease({ outDir: dir, version: "0.9.1" }),
		).toThrow(/清单指向/);
		expect(readFileSync(ymlPath, "utf8")).toBe(original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
