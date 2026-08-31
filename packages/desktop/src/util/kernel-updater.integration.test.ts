// kernel-updater.cjs 的集成测试：用 node:http 起本地 mock 服务（serve kernel-latest.json +
// 真实 zip 包），用 Node 18+ 全局 fetch 走完整链路 —— 下载 → sha256 校验 → 真实 unzip/tar
// 解压 → 覆盖 runtimeDir 的 WaPiKernel + 依赖清单 → 写 .kernel-version → 清理临时 zip/备份目录。
// 不 mock 被测逻辑、不跨进程下载远端；网络、解压、文件 IO 均为真实。
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	access,
	readdir,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncKernel, KERNEL_BIN } from "./kernel-updater.cjs";

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };
// 打包/解压链路跨平台：Windows 用内置 tar -a（bsdtar 按扩展名出 zip）打包 + tar -xf 解压；
// macOS/Linux 用 zip/unzip。仅当平台工具齐备才跑集成测试（保证真的执行而非被跳过）。
const HAS_ZIP =
	process.platform === "win32"
		? spawnSync("tar", ["--version"]).status === 0
		: spawnSync("zip", ["-v"]).status === 0;

const MANIFEST_BUILD = "20260823-1";

let server;
let feedUrl;
let tmpDir;
let zipBuf;
let sha256Hex;
let newBin;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "kernel-updater-int-"));

	// 造一个真实 zip：把假 kernel 三件套（junk path，条目位于根目录）压入
	const stage = join(tmpDir, "stage");
	await mkdir(stage, { recursive: true });
	newBin = `FAKE_KERNEL_BIN_${Date.now()}`;
	await writeFile(join(stage, KERNEL_BIN), newBin);
	await writeFile(
		join(stage, "package.json"),
		'{"name":"fake-kernel","version":"1.0.0"}',
	);
	await writeFile(join(stage, "bun.lock"), "fake-bun-lock-content");

	const zipPath = join(tmpDir, "kernel.zip");
	// 打包测试数据：Windows 无 zip 命令，用内置 tar -a（bsdtar 按扩展名出 zip 格式，
	// 条目位于根目录，产物与 Info-ZIP 等价）；macOS/Linux 保持 zip 命令。
	const isWin = process.platform === "win32";
	const zipRes = isWin
		? spawnSync(
				"tar",
				["-a", "-cf", zipPath, KERNEL_BIN, "package.json", "bun.lock"],
				{ cwd: stage },
			)
		: spawnSync(
				"zip",
				["-j", "-q", zipPath, KERNEL_BIN, "package.json", "bun.lock"],
				{ cwd: stage },
			);
	expect(zipRes.status).toBe(0);

	zipBuf = await readFile(zipPath);
	sha256Hex = createHash("sha256").update(zipBuf).digest("hex");

	// 起本地 mock 服务：分发 kernel-latest.json 与 kernel.zip（按 URL 结尾分发）
	server = createServer((req, res) => {
		if (req.url?.endsWith("kernel-latest.json")) {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					build: MANIFEST_BUILD,
					url: "kernel.zip",
					sha256: sha256Hex,
					size: zipBuf.length,
				}),
			);
		} else if (req.url?.endsWith("kernel.zip")) {
			res.setHeader("content-type", "application/zip");
			res.end(zipBuf);
		} else {
			res.statusCode = 404;
			res.end();
		}
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	feedUrl = `http://127.0.0.1:${server.address().port}/kernel-latest.json`;
});

afterAll(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

if (HAS_ZIP) {
	test("集成: 本地 mock HTTP 走 下载→sha 校验→真实解压→覆盖 runtime→写版本→清理临时 zip/备份", async () => {
		// runtimeDir 含旧 WaPiKernel 与旧 .kernel-version（旧 build），无新三件套 → 应触发更新
		const runtimeDir = join(tmpDir, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		const oldBin = "OLD_KERNEL_BIN";
		await writeFile(join(runtimeDir, KERNEL_BIN), oldBin);
		await writeFile(join(runtimeDir, ".kernel-version"), "20260822-1");

		// 不注入 fetchImpl —— 用真实全局 fetch 走完整链路
		const res = await syncKernel({ runtimeDir, feedUrl, log: noopLog });

		expect(res.status).toBe("updated");
		expect(res.build).toBe(MANIFEST_BUILD);

		// 真实解压覆盖成功：KERNEL_BIN == zip 里的假 kernel
		expect(await readFile(join(runtimeDir, KERNEL_BIN), "utf8")).toBe(newBin);
		expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
			'{"name":"fake-kernel","version":"1.0.0"}',
		);
		expect(await readFile(join(runtimeDir, "bun.lock"), "utf8")).toBe(
			"fake-bun-lock-content",
		);
		// 版本标记 == manifest.build
		expect(await readFile(join(runtimeDir, ".kernel-version"), "utf8")).toBe(
			MANIFEST_BUILD,
		);

		// 临时 zip 已清理（无 .kernel-update-*.zip 残留）
		await expect(
			access(join(runtimeDir, `.kernel-update-${MANIFEST_BUILD}.zip`)),
		).rejects.toThrow();
		const leftovers = (await readdir(runtimeDir)).filter((f) =>
			f.startsWith(".kernel-update-"),
		);
		expect(leftovers).toHaveLength(0);

		// 备份目录已清理
		await expect(
			access(join(runtimeDir, ".kernel-update-backup")),
		).rejects.toThrow();
	});
}
