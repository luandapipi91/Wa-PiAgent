// libvips-runtime.cjs 单元测试。
// 背景：sharp 的 darwin 分包（@img/sharp-darwin-<arch>）dlopen 时经 @rpath 找
// libvips-cpp.<ver>.dylib（位于独立分包 @img/sharp-libvips-darwin-<arch>），历史安装包
// 未随包携带该分包且包内目录不可写 → 运行时从 npmmirror 下载解压到
// WA_PI_DIR/runtime/native/sharp-libvips/<版本>/，由 kernel-sidecar 注入
// DYLD_FALLBACK_LIBRARY_PATH（rpath 全 miss 后 dyld 兜底搜索，实测可让 sharp.node 加载成功）。
// 覆盖：spec 解析（win32 早退/版本读取/URL 拼接）、包内已带检测、缓存命中不下载、
// 下载解压落位、下载失败清理不抛、env 构造。
import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	resolveLibvipsSpec,
	isLibvipsStaged,
	ensureLibvipsRuntime,
	buildLibvipsEnv,
} from "../libvips-runtime.cjs";

const TMP = join(tmpdir(), `test-libvips-runtime-${Date.now()}`);
const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

/** 造一个 fake sharp 包（只含 package.json 的 optionalDependencies） */
async function makeSharpPkg(
	base: string,
	optionalDeps?: Record<string, string>,
) {
	const sharpDir = join(base, "native", "node_modules", "sharp");
	await mkdir(sharpDir, { recursive: true });
	await writeFile(
		join(sharpDir, "package.json"),
		JSON.stringify(
			optionalDeps === undefined
				? { name: "sharp", version: "0.35.5" }
				: { name: "sharp", version: "0.35.5", optionalDependencies: optionalDeps },
		),
		"utf8",
	);
	return sharpDir;
}

/** 造一个 fake libvips 分包（lib/ 下放一个 .dylib），返回 lib 目录 */
async function makeLibvipsPkg(libDir: string) {
	await mkdir(libDir, { recursive: true });
	await writeFile(join(libDir, "libvips-cpp.8.18.7.dylib"), "fake dylib");
	return libDir;
}

/** 用真实 tar 造 npm tarball fixture（内层 package/ 目录），返回 tgz 字节 */
async function makeTarball(version = "1.3.4"): Promise<Buffer> {
	const src = join(TMP, `tarball-src-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(src, "package", "lib"), { recursive: true });
	await writeFile(
		join(src, "package", "package.json"),
		JSON.stringify({ name: "@img/sharp-libvips-darwin-x64", version }),
		"utf8",
	);
	await writeFile(join(src, "package", "lib", "libvips-cpp.8.18.7.dylib"), "fake dylib");
	const tgz = join(src, "pkg.tgz");
	const r = spawnSync("tar", ["-czf", tgz, "-C", src, "package"]);
	if (r.status !== 0) throw new Error(`tar 造 fixture 失败: ${r.stderr}`);
	return Buffer.from(await Bun.file(tgz).arrayBuffer());
}

afterEach(async () => {
	await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("resolveLibvipsSpec", () => {
	test("darwin + x64：从 sharp 的 optionalDependencies 读分包与版本，拼 npmmirror tarball URL", async () => {
		const base = join(TMP, "spec-ok");
		const sharpDir = await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-x64": "1.3.4",
		});
		expect(
			resolveLibvipsSpec({ sharpDir, platform: "darwin", arch: "x64" }),
		).toEqual({
			pkgName: "@img/sharp-libvips-darwin-x64",
			version: "1.3.4",
			tarballUrl:
				"https://registry.npmmirror.com/@img/sharp-libvips-darwin-x64/-/sharp-libvips-darwin-x64-1.3.4.tgz",
		});
	});

	test("darwin + arm64：分包名随架构切换", async () => {
		const base = join(TMP, "spec-arm64");
		const sharpDir = await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-arm64": "1.3.4",
		});
		const spec = resolveLibvipsSpec({
			sharpDir,
			platform: "darwin",
			arch: "arm64",
		});
		expect(spec?.pkgName).toBe("@img/sharp-libvips-darwin-arm64");
	});

	test("win32：分包自带 dll，无需兜底 → null", async () => {
		const base = join(TMP, "spec-win");
		const sharpDir = await makeSharpPkg(base, {
			"@img/sharp-win32-x64": "0.35.5",
		});
		expect(resolveLibvipsSpec({ sharpDir, platform: "win32", arch: "x64" })).toBeNull();
	});

	test("sharp 缺 optionalDependencies / 缺对应分包 → null", async () => {
		const base1 = join(TMP, "spec-nodeps");
		const sharpDir1 = await makeSharpPkg(base1);
		expect(
			resolveLibvipsSpec({ sharpDir: sharpDir1, platform: "darwin", arch: "x64" }),
		).toBeNull();

		const base2 = join(TMP, "spec-noentry");
		const sharpDir2 = await makeSharpPkg(base2, {
			"@img/sharp-libvips-darwin-arm64": "1.3.4",
		});
		expect(
			resolveLibvipsSpec({ sharpDir: sharpDir2, platform: "darwin", arch: "x64" }),
		).toBeNull();
	});
});

describe("isLibvipsStaged", () => {
	test("包内已带 libvips 分包（lib/ 下有动态库）→ true；未带 → false", async () => {
		const base = join(TMP, "staged-yes");
		const pkgName = "@img/sharp-libvips-darwin-x64";
		const libDir = join(
			base,
			"native",
			"node_modules",
			pkgName,
			"lib",
		);
		await makeLibvipsPkg(libDir);
		expect(
			isLibvipsStaged({ nativeNodeModules: join(base, "native", "node_modules"), pkgName }),
		).toBe(true);

		const baseNo = join(TMP, "staged-no");
		expect(
			isLibvipsStaged({
				nativeNodeModules: join(baseNo, "native", "node_modules"),
				pkgName,
			}),
		).toBe(false);
	});
});

describe("ensureLibvipsRuntime", () => {
	test("非 darwin 平台：unsupported，不下载不注入", async () => {
		const base = join(TMP, "ens-win");
		const sharpDir = await makeSharpPkg(base, {
			"@img/sharp-win32-x64": "0.35.5",
		});
		let fetchCalls = 0;
		const result = await ensureLibvipsRuntime({
			nativeNodeModules: join(base, "native", "node_modules"),
			runtimeDir: join(base, "runtime"),
			platform: "win32",
			arch: "x64",
			log: noopLog,
			fetchImpl: (async () => {
				fetchCalls++;
				throw new Error("不应发起下载");
			}) as any,
		});
		expect(result).toEqual({ libDir: null, action: "unsupported" });
		expect(fetchCalls).toBe(0);
	});

	test("包内已带分包 → staged 跳过，不下载", async () => {
		const base = join(TMP, "ens-staged");
		const sharpDir = await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-x64": "1.3.4",
		});
		await makeLibvipsPkg(
			join(
				base,
				"native",
				"node_modules",
				"@img",
				"sharp-libvips-darwin-x64",
				"lib",
			),
		);
		const result = await ensureLibvipsRuntime({
			nativeNodeModules: join(base, "native", "node_modules"),
			runtimeDir: join(base, "runtime"),
			platform: "darwin",
			arch: "x64",
			log: noopLog,
			fetchImpl: (async () => {
				throw new Error("不应发起下载");
			}) as any,
		});
		expect(result).toEqual({ libDir: null, action: "staged" });
	});

	test("缓存命中（runtime 下已解压）→ cached 返回 lib 目录，不下载", async () => {
		const base = join(TMP, "ens-cached");
		await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-x64": "1.3.4",
		});
		const cacheLib = await makeLibvipsPkg(
			join(base, "runtime", "native", "sharp-libvips", "1.3.4", "lib"),
		);
		const result = await ensureLibvipsRuntime({
			nativeNodeModules: join(base, "native", "node_modules"),
			runtimeDir: join(base, "runtime"),
			platform: "darwin",
			arch: "x64",
			log: noopLog,
			fetchImpl: (async () => {
				throw new Error("不应发起下载");
			}) as any,
		});
		expect(result).toEqual({ libDir: cacheLib, action: "cached" });
	});

	test("下载成功：tarball 解压落位到 runtime/native/sharp-libvips/<版本>/，返回 lib 目录", async () => {
		const base = join(TMP, "ens-download");
		await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-x64": "1.3.4",
		});
		const tarball = await makeTarball("1.3.4");
		const result = await ensureLibvipsRuntime({
			nativeNodeModules: join(base, "native", "node_modules"),
			runtimeDir: join(base, "runtime"),
			platform: "darwin",
			arch: "x64",
			log: noopLog,
			fetchImpl: (async () => ({ ok: true, arrayBuffer: async () => tarball })) as any,
		});
		const libDir = join(
			base,
			"runtime",
			"native",
			"sharp-libvips",
			"1.3.4",
			"lib",
		);
		expect(result).toEqual({ libDir, action: "downloaded" });
		const files = await readdir(libDir);
		expect(files.some((f) => f.endsWith(".dylib"))).toBe(true);
	});

	test("下载失败：返回 failed（libDir null），残留目录清理，不抛异常", async () => {
		const base = join(TMP, "ens-fail");
		await makeSharpPkg(base, {
			"@img/sharp-libvips-darwin-x64": "1.3.4",
		});
		const result = await ensureLibvipsRuntime({
			nativeNodeModules: join(base, "native", "node_modules"),
			runtimeDir: join(base, "runtime"),
			platform: "darwin",
			arch: "x64",
			log: noopLog,
			fetchImpl: (async () => ({
				ok: false,
				status: 404,
				arrayBuffer: async () => new ArrayBuffer(0),
			})) as any,
		});
		expect(result).toEqual({ libDir: null, action: "failed" });
		const verDir = join(base, "runtime", "native", "sharp-libvips", "1.3.4");
		const stillThere = await readdir(verDir)
			.then(() => true)
			.catch(() => false);
		expect(stillThere).toBe(false);
	});
});

describe("buildLibvipsEnv", () => {
	test("libDir 有效 → DYLD_FALLBACK_LIBRARY_PATH；null → 空对象", () => {
		expect(buildLibvipsEnv("/fake/lib")).toEqual({
			DYLD_FALLBACK_LIBRARY_PATH: "/fake/lib",
		});
		expect(buildLibvipsEnv(null)).toEqual({});
	});
});
