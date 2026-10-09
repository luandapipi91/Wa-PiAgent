// runtime-deps.cjs 的安装验证与重试逻辑测试。
// verifyInstall：产物校验（顶层依赖 package.json 必须存在）
// installWithRetry：主源/回退源 2 轮重试、失败清理重装、全败抛错
// buildInstallArgs：必须带 --ignore-scripts（消除编译环节，保证安装 100% 成功）
import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	verifyInstall,
	installWithRetry,
	buildInstallArgs,
	buildInstallEnv,
	linkNativeAssets,
} from "../runtime-deps.cjs";

const TMP = join(tmpdir(), `test-runtime-deps-${Date.now()}`);

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

// 原生依赖链接：bun 编译产物的运行时解析根是 cwd/node_modules（不是可执行文件同目录，
// NODE_PATH 对包内 require 也不可靠），故随包分发的 resources/native/node_modules/* 必须
// 以链接形式出现在 WA_PI_DIR/runtime/node_modules（= kernel 的 cwd）。
describe("linkNativeAssets", () => {
	test("逐包（含作用域包）链接进 runtime/node_modules，且幂等", async () => {
		const base = join(TMP, "link-basic");
		const native = join(base, "resources", "native", "node_modules");
		const runtime = join(base, "runtime");
		await mkdir(join(native, "foo"), { recursive: true });
		await writeFile(join(native, "foo", "package.json"), "{}", "utf8");
		await mkdir(join(native, "@scope", "bar"), { recursive: true });
		await writeFile(
			join(native, "@scope", "bar", "package.json"),
			"{}",
			"utf8",
		);

		const first = await linkNativeAssets(native, runtime, noopLog);
		expect(first).toEqual({ linked: 2, skipped: 0, failed: 0 });
		// 通过链接能读到源包内容（证明链接真的建到了 runtime/node_modules 下）
		expect(
			await Bun.file(
				join(runtime, "node_modules", "foo", "package.json"),
			).text(),
		).toBe("{}");
		expect(
			await Bun.file(
				join(runtime, "node_modules", "@scope", "bar", "package.json"),
			).text(),
		).toBe("{}");

		// 幂等：再次调用不重建也不报错
		const second = await linkNativeAssets(native, runtime, noopLog);
		expect(second).toEqual({ linked: 0, skipped: 2, failed: 0 });
	});

	test("源目录缺失/未提供时静默降级（不抛错）；语义检索由 kernel 自行降级为词法", async () => {
		const runtime = join(TMP, "link-missing", "runtime");
		for (const src of [undefined, join(TMP, "link-missing", "nope")]) {
			const r = await linkNativeAssets(src, runtime, noopLog);
			expect(r.linked).toBe(0);
			expect(r.failed).toBe(0);
		}
	});

	test("目标同名条目存在但不是链接 → 跳过不动（不删非本模块创建的东西）", async () => {
		const base = join(TMP, "link-notlink");
		const native = join(base, "native", "node_modules");
		const runtime = join(base, "runtime");
		await mkdir(join(native, "kept"), { recursive: true });
		await writeFile(join(native, "kept", "marker"), "src", "utf8");
		await mkdir(join(runtime, "node_modules", "kept"), { recursive: true });
		await writeFile(
			join(runtime, "node_modules", "kept", "marker"),
			"local",
			"utf8",
		);

		const r = await linkNativeAssets(native, runtime, noopLog);
		expect(r.skipped).toBe(1);
		expect(r.linked).toBe(0);
		// 原目录完好（未被删除、未被替换成链接）
		expect(
			await Bun.file(join(runtime, "node_modules", "kept", "marker")).text(),
		).toBe("local");
	});
});

const SEED_MANIFEST = {
	name: "wa-pi-kernel-sidecar",
	private: true,
	dependencies: {
		"@earendil-works/pi-coding-agent": "^0.84.2",
		"registry-js": "^1.16.1",
	},
};

// 造一个「安装完成」的 runtime 目录：顶层依赖 package.json 存在
async function makeInstalledRuntime() {
	const dir = join(TMP, "runtime");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify(SEED_MANIFEST),
		"utf8",
	);
	await mkdir(join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), {
		recursive: true,
	});
	await writeFile(
		join(
			dir,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"package.json",
		),
		'{"name":"@earendil-works/pi-coding-agent","version":"0.84.2"}',
	);
	await mkdir(join(dir, "node_modules", "registry-js"), { recursive: true });
	await writeFile(
		join(dir, "node_modules", "registry-js", "package.json"),
		'{"name":"registry-js","version":"1.16.1"}',
	);
	return dir;
}

const silentLog = { info: () => {}, error: () => {} };

afterEach(async () => {
	await rm(TMP, { recursive: true, force: true });
});

describe("verifyInstall", () => {
	test("完整安装（顶层依赖齐全）→ 通过", async () => {
		const dir = await makeInstalledRuntime();
		await expect(verifyInstall(dir, silentLog)).resolves.toBeUndefined();
	});

	test("registry-js 无 .node 原生产物（--ignore-scripts 安装）→ 仍通过", async () => {
		// Windows 读系统代理已改为 PowerShell 兜底（settings-store.ts），不再依赖 registry-js 编译产物
		const dir = await makeInstalledRuntime();
		await expect(verifyInstall(dir, silentLog)).resolves.toBeUndefined();
	});

	test("缺少顶层依赖 → 抛错并指出包名", async () => {
		const dir = await makeInstalledRuntime();
		await rm(join(dir, "node_modules", "registry-js"), {
			recursive: true,
			force: true,
		});
		await expect(verifyInstall(dir, silentLog)).rejects.toThrow(/registry-js/);
	});
});

describe("buildInstallArgs", () => {
	test("必须带 --ignore-scripts（消除编译环节，安装 100% 成功的关键）", () => {
		const args = buildInstallArgs("/tmp/runtime");
		expect(args).toContain("--ignore-scripts");
		expect(args).toContain("--production");
		expect(args).toContain("--cwd");
		expect(args).toContain("/tmp/runtime");
	});
});

describe("installWithRetry", () => {
	const registries = ["https://registry.a", "https://registry.b"];

	test("第一个源安装+验证成功 → 不再尝试其他源", async () => {
		const calls: string[] = [];
		const cleanup = async () => {
			calls.push("cleanup");
		};
		const install = async (registry: string) => {
			calls.push(`install:${registry}`);
		};
		const verify = async () => {
			calls.push("verify");
		};
		await installWithRetry({
			registries,
			install,
			verify,
			cleanup,
			log: silentLog,
		});
		expect(calls).toEqual(["install:https://registry.a", "verify"]);
	});

	test("第一轮全失败 → cleanup 后第二轮成功", async () => {
		const calls: string[] = [];
		let failCount = 2; // 前两次安装失败（a、b）
		const cleanup = async () => {
			calls.push("cleanup");
		};
		const install = async (registry: string) => {
			calls.push(`install:${registry}`);
			if (failCount > 0) {
				failCount--;
				throw new Error("网络超时");
			}
		};
		const verify = async () => {
			calls.push("verify");
		};
		await installWithRetry({
			registries,
			install,
			verify,
			cleanup,
			log: silentLog,
		});
		expect(calls).toEqual([
			"install:https://registry.a",
			"install:https://registry.b",
			"cleanup",
			"install:https://registry.a",
			"verify",
		]);
	});

	test("安装成功但验证失败（postinstall 未产出产物）→ 也走 cleanup 重试", async () => {
		const calls: string[] = [];
		const cleanup = async () => {
			calls.push("cleanup");
		};
		const install = async (registry: string) => {
			calls.push(`install:${registry}`);
		};
		let verifyFail = 2; // 两个源安装后产物校验都失败 → cleanup 重装后才成功
		const verify = async () => {
			calls.push("verify");
			if (verifyFail > 0) {
				verifyFail--;
				throw new Error("registry-js 原生模块缺失");
			}
		};
		await installWithRetry({
			registries,
			install,
			verify,
			cleanup,
			log: silentLog,
		});
		expect(calls).toEqual([
			"install:https://registry.a",
			"verify",
			"install:https://registry.b",
			"verify",
			"cleanup",
			"install:https://registry.a",
			"verify",
		]);
	});

	test("两轮全失败 → 抛出最终错误（含最后一次原因）", async () => {
		const cleanup = async () => {};
		const install = async (_registry: string) => {
			throw new Error("postinstall 编译失败");
		};
		const verify = async () => {};
		await expect(
			installWithRetry({ registries, install, verify, cleanup, log: silentLog }),
		).rejects.toThrow(/postinstall 编译失败/);
	});

	test("cleanup 抛错（node_modules 被锁）→ 直接抛出", async () => {
		const cleanup = async () => {
			throw new Error("删除 node_modules 失败（文件被占用）");
		};
		const install = async (_registry: string) => {
			throw new Error("安装失败");
		};
		const verify = async () => {};
		await expect(
			installWithRetry({ registries, install, verify, cleanup, log: silentLog }),
		).rejects.toThrow(/文件被占用/);
	});
});

describe("buildInstallEnv", () => {
	test("含 BUN_BE_BUN=1（编译产物充当 bun CLI 执行 install）与 registry", () => {
		const env = buildInstallEnv("https://registry.npmmirror.com");
		expect(env.BUN_BE_BUN).toBe("1");
		expect(env.BUN_CONFIG_REGISTRY).toBe("https://registry.npmmirror.com");
	});
});
