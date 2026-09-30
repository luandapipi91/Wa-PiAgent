// stage-native-assets（模型 + 原生依赖按目标平台准备）的纯逻辑与打包配置校验。
//
// 真正的 staging 需要 23MB 模型缓存与平台分包在场（且会写 60MB 到 resources/），不适合放进
// 单元测试；这里覆盖三件「错了会静默发布出坏包」的事：
//   ① 目标平台标识（交叉打包必须显式切换平台二进制，写错就带病出包）；
//   ② bun 编译产物 fallback 解析只认包根 index.* 的兼容层（少了它运行时 Cannot find module）；
//   ③ electron-builder 的 extraResources 映射（漏了 native/models 就等于没把资产发出去）。
import { describe, test, expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	dirSize,
	ensureRootEntry,
	nativeTargetSpec,
	vectorBinaryName,
} from "../scripts/stage-native-assets";

const TMP = join(tmpdir(), `test-stage-native-${Date.now()}`);

describe("nativeTargetSpec", () => {
	test("win / linux 固定 x64，且平台分包名与 onnxruntime 目录名对应", () => {
		expect(nativeTargetSpec("win")).toEqual({
			ortPlatform: "win32",
			ortArch: "x64",
			sharpPackage: "@img/sharp-win32-x64",
			vectorPackage: "@sqliteai/sqlite-vector-win32-x86_64",
		});
		expect(nativeTargetSpec("linux")).toEqual({
			ortPlatform: "linux",
			ortArch: "x64",
			sharpPackage: "@img/sharp-linux-x64",
			vectorPackage: "@sqliteai/sqlite-vector-linux-x86_64",
		});
	});

	test("darwin 随构建机架构（本机编译，Intel 构建机只能出 x64 包）", () => {
		const spec = nativeTargetSpec("darwin");
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		expect(spec).toEqual({
			ortPlatform: "darwin",
			ortArch: arch,
			sharpPackage: `@img/sharp-darwin-${arch}`,
			vectorPackage: `@sqliteai/sqlite-vector-darwin-${arch === "arm64" ? "arm64" : "x86_64"}`,
		});
	});

	test("不支持的 target 直接抛错（不静默 fallback 到 host 平台）", () => {
		expect(() => nativeTargetSpec("freebsd")).toThrow();
	});

	test("平台分包里的扩展名与平台对应", () => {
		expect(vectorBinaryName("win32")).toBe("vector.dll");
		expect(vectorBinaryName("linux")).toBe("vector.so");
		expect(vectorBinaryName("darwin")).toBe("vector.dylib");
	});
});

describe("ensureRootEntry", () => {
	test("入口在子目录（main=dist/…）→ 补根级 index.js（bun fallback 只认包根 index.*）", async () => {
		const dir = join(TMP, "sub-entry");
		await mkdir(join(dir, "dist"), { recursive: true });
		await writeFile(join(dir, "dist", "index.js"), "module.exports = 1;", "utf8");
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "p", main: "dist/index.js" }),
			"utf8",
		);
		const entry = await ensureRootEntry(dir, "dist/index.js");
		expect(entry).toBe("index.js");
		const stub = await readFile(join(dir, "index.js"), "utf8");
		expect(stub).toContain("require(\"./dist/index.js\")");
	});

	test("CJS 入口 → index.js；根 type=module 的包 → index.cjs（stub 自身必须是 CJS 解析）", async () => {
		const cjs = join(TMP, "cjs-entry");
		await mkdir(join(cjs, "dist"), { recursive: true });
		await writeFile(join(cjs, "dist", "index.cjs"), "module.exports = 1;", "utf8");
		expect(await ensureRootEntry(cjs, "./dist/index.cjs")).toBe("index.js");

		const esm = join(TMP, "esm-entry");
		await mkdir(join(esm, "dist", "cjs"), { recursive: true });
		await writeFile(join(esm, "dist", "cjs", "index.js"), "module.exports = 1;", "utf8");
		await writeFile(
			join(esm, "package.json"),
			JSON.stringify({ name: "e", type: "module", main: "dist/cjs/index.js" }),
			"utf8",
		);
		expect(await ensureRootEntry(esm, "dist/cjs/index.js")).toBe("index.cjs");

		const mjs = join(TMP, "mjs-entry");
		await mkdir(join(mjs, "dist"), { recursive: true });
		await writeFile(join(mjs, "dist", "index.mjs"), "export default 1;", "utf8");
		expect(await ensureRootEntry(mjs, "dist/index.mjs")).toBe("index.mjs");
	});

	test("包根已有 index.* → 不覆盖（返回 null）", async () => {
		const dir = join(TMP, "already-root");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "index.js"), "// 原有入口", "utf8");
		expect(await ensureRootEntry(dir, "dist/index.js")).toBe(null);
		expect(await readFile(join(dir, "index.js"), "utf8")).toBe("// 原有入口");
	});
});

describe("electron-builder 配置：原生资产必须随包分发到 asar 之外", () => {
	test("extraResources 映射 resources/{kernel,web,models,native/node_modules}", async () => {
		const yml = await readFile(
			join(import.meta.dir, "..", "electron-builder.yml"),
			"utf8",
		);
		expect(yml).toContain("from: resources/kernel");
		expect(yml).toContain("from: resources/web");
		// 模型：asar 内只读且 transformers 默认 cacheDir 在包内 → 不内置就每次启动联网重下
		expect(yml).toContain("from: resources/models");
		expect(yml).toContain("to: models");
		// 原生二进制：asar 内无法 dlopen；运行时由 main.cjs 链接到 runtime/node_modules
		// ⚠️ from 必须直接指向 node_modules（源目录根下名为 node_modules 的那层会被 electron-builder
		//    的 filter 无条件排掉，实测会让整包资产静默消失）
		expect(yml).toContain("from: resources/native/node_modules");
		expect(yml).toContain("to: native/node_modules");
	});
});

describe("dirSize", () => {
	test("统计目录字节数；目录不存在时返回 0", async () => {
		const dir = join(TMP, "size");
		await mkdir(join(dir, "a"), { recursive: true });
		await writeFile(join(dir, "a", "f1"), Buffer.alloc(10));
		await writeFile(join(dir, "f2"), Buffer.alloc(5));
		expect(await dirSize(dir)).toBe(15);
		expect(await dirSize(join(TMP, "nope"))).toBe(0);
	});
});

// 收尾：临时目录常被 Windows 文件锁占用，清理尽力而为
test("cleanup", async () => {
	await rm(TMP, { recursive: true, force: true }).catch(() => {});
	expect(existsSync(TMP)).toBe(false);
});
