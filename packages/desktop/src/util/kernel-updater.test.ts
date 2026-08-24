// kernel-updater.cjs 的动态 kernel 同步器测试。
// 覆盖：build 比较（needsUpdate）、sha256 校验、清单拉取降级、syncKernel 主流程、
//       幂等 up-to-date、下载/校验失败清理临时 zip、applyKernelUpdate 解压失败回滚、
//       zip 路径穿越防护（isSafeZipEntry）。
import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readLocalBuild,
	needsUpdate,
	verifySha256,
	fetchManifest,
	syncKernel,
	applyKernelUpdate,
	isSafeZipEntry,
	currentPlatform,
	KERNEL_BIN,
} from "./kernel-updater.cjs";

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };
const TMP = join(tmpdir(), `kernel-updater-test-${Date.now()}`);
const FEED_URL = "https://oss.example/kernel/kernel-latest.json";
// 仅当系统有 `zip`/`unzip` 时才跑「成功更新」集成测试（验证真实解压提取链路），
// 否则跳过（Windows 交叉环境可能无 zip CLI；解压逻辑本身用 unzip/tar）。
const HAS_ZIP = spawnSync("zip", ["-v"]).status === 0;

afterEach(async () => {
	await rm(TMP, { recursive: true, force: true });
});

test("needsUpdate: 本地为空(首次) → true", () => {
	expect(needsUpdate(null, { build: "20260823-1" })).toBe(true);
});
test("needsUpdate: build 相同 → false", () => {
	expect(needsUpdate("20260823-1", { build: "20260823-1" })).toBe(false);
});
test("needsUpdate: build 不同(新版) → true", () => {
	expect(needsUpdate("20260822-1", { build: "20260823-1" })).toBe(true);
});
test("needsUpdate: 远端 build 低于本地(降级) → false（不降级覆盖）", () => {
	expect(needsUpdate("20260823-1", { build: "20260822-1" })).toBe(false);
});
// seq 未零填充跨个位/十位时，字符串字典序会失准（"20260823-9" > "20260823-10"），
// 这里验证按日期+seq 数值比较，避免降级/升级漏判。
test("needsUpdate: 同日跨个位升级（-9 → -10）→ true", () => {
	expect(needsUpdate("20260823-9", { build: "20260823-10" })).toBe(true);
});
test("needsUpdate: 同日跨个位降级（-10 → -9）→ false（降级防护）", () => {
	expect(needsUpdate("20260823-10", { build: "20260823-9" })).toBe(false);
});
test("needsUpdate: manifest 无 build → false（不更新）", () => {
	expect(needsUpdate("20260823-1", {})).toBe(false);
	expect(needsUpdate(null, null)).toBe(false);
});

test("verifySha256: 匹配 → true，不匹配 → false", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ku-test-"));
	try {
		const f = join(dir, "a.bin");
		await writeFile(f, "hello");
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update("hello").digest("hex");
		expect(await verifySha256(f, hash)).toBe(true);
		expect(await verifySha256(f, "bad")).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fetchManifest: 网络失败返回 null（降级）", async () => {
	const m = await fetchManifest(
		() => {
			throw new Error("net");
		},
		"http://x",
	);
	expect(m).toBeNull();
});
test("fetchManifest: 解析成功返回对象", async () => {
	const m = await fetchManifest(
		() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ build: "20260823-1" }),
			}),
		"http://x",
	);
	expect(m.build).toBe("20260823-1");
});

test("syncKernel: 无更新 → up-to-date", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ku-sync-"));
	try {
		const runtimeDir = join(dir, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		await writeFile(join(runtimeDir, ".kernel-version"), "20260823-1");
		const res = await syncKernel({
			runtimeDir,
			seedDir: dir,
			feedUrl: "http://x",
			fetchImpl: () =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ build: "20260823-1" }),
				}),
			log: noopLog,
		});
		expect(res.status).toBe("up-to-date");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("syncKernel: 清单平台与当前平台不匹配 → up-to-date（跳过更新）", async () => {
	const runtimeDir = join(TMP, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	// 本地 build 较旧（本应更新），但清单声明异平台 → 必须跳过，防止半更新
	await writeFile(join(runtimeDir, ".kernel-version"), "20260101-1");
	const otherPlatform = currentPlatform().includes("x64")
		? currentPlatform().replace("x64", "arm64")
		: currentPlatform().replace("arm64", "x64");
	const res = await syncKernel({
		runtimeDir,
		seedDir: TMP,
		feedUrl: FEED_URL,
		fetchImpl: () =>
			Promise.resolve({
				ok: true,
				json: async () => ({
					build: "20260824-2",
					platform: otherPlatform,
				}),
			}),
		log: noopLog,
	});
	expect(res.status).toBe("up-to-date");
});

test("syncKernel: runtimeDir 不存在时先创建（首启 ENOENT 防护）", async () => {
	const runtimeDir = join(TMP, "first-run", "runtime");
	// 不预先创建 runtimeDir，模拟全新安装首次启动
	const fetchImpl = async (url: string) => {
		if (url.includes("kernel-latest.json")) {
			return {
				ok: true,
				json: async () => ({
					build: "20260824-2",
					url: "kernel-x.zip",
					sha256: "deadbeef", // sha 不匹配 → 下载后被校验拦截
				}),
			};
		}
		return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]) };
	};
	const res = await syncKernel({
		runtimeDir,
		seedDir: TMP,
		feedUrl: FEED_URL,
		fetchImpl,
		log: noopLog,
	});
	// runtimeDir 被 mkdir 创建（而非 writeFile 写 zip 抛 ENOENT）
	await expect(access(runtimeDir)).resolves.toBeDefined();
	expect(res.status).toBe("failed");
	expect(res.error).toMatch(/sha256/);
});

test("syncKernel: 清单不可用（网络失败）→ up-to-date 降级", async () => {
	const runtimeDir = join(TMP, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	const res = await syncKernel({
		runtimeDir,
		seedDir: TMP,
		feedUrl: FEED_URL,
		fetchImpl: () => {
			throw new Error("net down");
		},
		log: noopLog,
	});
	expect(res.status).toBe("up-to-date");
});

test("syncKernel: 下载失败 → failed 降级，不残留临时 zip", async () => {
	const runtimeDir = join(TMP, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	// 清单可拉、需要更新（本地无 .kernel-version）；下载响应 500
	const fetchImpl = async (url: string) => {
		if (url.includes("kernel-latest.json")) {
			return {
				ok: true,
				json: async () => ({ build: "20260824-2", url: "kernel-x.zip" }),
			};
		}
		return { ok: false, status: 500 };
	};
	const res = await syncKernel({
		runtimeDir,
		seedDir: TMP,
		feedUrl: FEED_URL,
		fetchImpl,
		log: noopLog,
	});
	expect(res.status).toBe("failed");
	await expect(
		access(join(runtimeDir, ".kernel-update-20260824-2.zip")),
	).rejects.toThrow();
});

test("syncKernel: sha256 校验失败 → failed 并清理临时 zip", async () => {
	const runtimeDir = join(TMP, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	const fetchImpl = async (url: string) => {
		if (url.includes("kernel-latest.json")) {
			return {
				ok: true,
				json: async () => ({
					build: "20260824-2",
					url: "kernel-x.zip",
					sha256: "deadbeef",
				}),
			};
		}
		// 下载成功但内容与清单 sha256 不符
		return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]) };
	};
	const res = await syncKernel({
		runtimeDir,
		seedDir: TMP,
		feedUrl: FEED_URL,
		fetchImpl,
		log: noopLog,
	});
	expect(res.status).toBe("failed");
	expect(res.error).toMatch(/sha256/);
	await expect(
		access(join(runtimeDir, ".kernel-update-20260824-2.zip")),
	).rejects.toThrow();
});

test("applyKernelUpdate: 解压失败 → 回滚恢复旧 kernel，不写新版本标记", async () => {
	const runtimeDir = join(TMP, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	const bin = join(runtimeDir, KERNEL_BIN);
	await writeFile(bin, "OLD_BIN");
	await writeFile(join(runtimeDir, "package.json"), '{"name":"old"}');
	await writeFile(join(runtimeDir, ".kernel-version"), "20260823-1");
	// 无效 zip（非合法归档）→ extractZip 列表/解压失败 → 触发回滚
	const zipPath = join(TMP, "bad.zip");
	await writeFile(zipPath, "not a zip");
	const backupDir = join(TMP, "backup");
	await expect(
		applyKernelUpdate({
			runtimeDir,
			zipPath,
			manifest: { build: "20260824-2" },
			log: noopLog,
			backupDir,
		}),
	).rejects.toThrow();
	// 旧 kernel 三件套与版本标记未被破坏（未进入半更新状态）
	expect(await readFile(bin, "utf8")).toBe("OLD_BIN");
	expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
		'{"name":"old"}',
	);
	expect(await readFile(join(runtimeDir, ".kernel-version"), "utf8")).toBe(
		"20260823-1",
	);
});

test("isSafeZipEntry: 拒绝 ../、绝对路径、盘符；放行正常相对路径", () => {
	expect(isSafeZipEntry("WaPiKernel")).toBe(true);
	expect(isSafeZipEntry("package.json")).toBe(true);
	expect(isSafeZipEntry("node_modules/a/b.js")).toBe(true);
	expect(isSafeZipEntry("folder/")).toBe(true);
	expect(isSafeZipEntry("../etc/passwd")).toBe(false);
	expect(isSafeZipEntry("../../foo")).toBe(false);
	expect(isSafeZipEntry("a/../b")).toBe(false);
	expect(isSafeZipEntry("/etc/passwd")).toBe(false);
	expect(isSafeZipEntry("C:\\Windows\\evil")).toBe(false);
	expect(isSafeZipEntry("")).toBe(false);
});

if (HAS_ZIP) {
	test(
		"syncKernel: 下载→sha 校验→真实解压→写 .kernel-version → updated（集成）",
		async () => {
			const runtimeDir = join(TMP, "runtime");
			await mkdir(runtimeDir, { recursive: true });
			// 造一个 staging 目录，打包成有效 zip（条目位于根，含新 kernel/pkq/lock）
			const stage = join(TMP, "stage");
			await mkdir(stage, { recursive: true });
			const newBin = "NEW_BIN_CONTENT";
			await writeFile(join(stage, KERNEL_BIN), newBin);
			await writeFile(join(stage, "package.json"), '{"name":"new"}');
			await writeFile(join(stage, "bun.lock"), "lock");
			const zipPath = join(TMP, "kernel-20260824-2.zip");
			const zipRes = spawnSync("zip", ["-q", zipPath, KERNEL_BIN, "package.json", "bun.lock"], {
				cwd: stage,
			});
			expect(zipRes.status).toBe(0);
			const buf = await readFile(zipPath);
			const sha = createHash("sha256").update(buf).digest("hex");

			const fetchImpl = async (url: string) => {
				if (url.includes("kernel-latest.json")) {
					return {
						ok: true,
						json: async () => ({
							build: "20260824-2",
							url: "kernel-20260824-2.zip",
							sha256: sha,
						}),
					};
				}
				return { ok: true, arrayBuffer: async () => buf };
			};
			const res = await syncKernel({
				runtimeDir,
				seedDir: TMP,
				feedUrl: FEED_URL,
				fetchImpl,
				log: noopLog,
			});
			expect(res.status).toBe("updated");
			expect(res.build).toBe("20260824-2");
			expect(await readFile(join(runtimeDir, KERNEL_BIN), "utf8")).toBe(newBin);
			expect(await readFile(join(runtimeDir, "package.json"), "utf8")).toBe(
				'{"name":"new"}',
			);
			expect(await readFile(join(runtimeDir, "bun.lock"), "utf8")).toBe("lock");
			expect(await readFile(join(runtimeDir, ".kernel-version"), "utf8")).toBe(
				"20260824-2",
			);
			// 更新成功后临时 zip 已清理
			await expect(access(join(runtimeDir, ".kernel-update-20260824-2.zip"))).rejects.toThrow();
		},
	);
}
