// bash-runtime 纯函数测试：系统 bash 检测、PortableGit 路径/URL、版本校验。
// 注意：不触发 ensurePortableBash（会真实下载 64MB PortableGit——那是端到端验证的职责）。
import { test, expect } from "bun:test";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	chmodSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findSystemBash,
	portableBashDir,
	portableBashExe,
	portableBashDownloadUrls,
	bashVersionOf,
	ensureBashAvailable,
	PORTABLE_GIT_VERSION,
} from "../src/bash-runtime";

test("portableBashDir: env 覆盖优先", () => {
	const prev = process.env.WA_PI_BASH_CACHE_DIR;
	process.env.WA_PI_BASH_CACHE_DIR = "C:\\custom\\bash-cache";
	try {
		expect(portableBashDir()).toBe("C:\\custom\\bash-cache");
	} finally {
		if (prev === undefined) delete process.env.WA_PI_BASH_CACHE_DIR;
		else process.env.WA_PI_BASH_CACHE_DIR = prev;
	}
});

test("portableBashExe: 解压后 bash 在 bin/bash.exe", () => {
	// Windows 下 join 用反斜杠（C:\cache\bin\bash.exe），POSIX 用正斜杠——
	// 期望值用 join 计算，保证跨平台断言成立（该逻辑只服务 Windows 运行时）。
	expect(portableBashExe("C:\\cache")).toBe(
		join("C:\\cache", "bin", "bash.exe"),
	);
});

test("portableBashDownloadUrls: npmmirror 主源 + GitHub 回退，含固定版本号", () => {
	const urls = portableBashDownloadUrls();
	expect(urls).toHaveLength(2);
	expect(urls[0]).toContain("registry.npmmirror.com");
	expect(urls[1]).toContain("github.com/git-for-windows");
	expect(urls[0]).toContain(`v${PORTABLE_GIT_VERSION}`);
	expect(urls[0]).toContain("64-bit.7z.exe");
});

test("findSystemBash: Windows 有 Git Bash 时返回存在路径（开发机已装 Git）", () => {
	const bash = findSystemBash();
	if (process.platform === "win32") {
		// 开发机装 Git for Windows → 应命中标准路径；CI/无 Git 环境跳过断言
		if (bash) {
			expect(existsSync(bash)).toBe(true);
		}
	} else {
		// POSIX：bash 应在 PATH
		expect(bash).not.toBeNull();
	}
});

test("bashVersionOf: 真实 bash 返回版本号；不存在路径返回 null", () => {
	const bash = findSystemBash();
	if (bash) {
		const v = bashVersionOf(bash);
		expect(v).not.toBeNull();
		expect(String(v).length).toBeGreaterThan(0);
	}
	expect(bashVersionOf("C:\\nonexistent\\bash.exe")).toBeNull();
	expect(bashVersionOf(join("Z:\\no-such-dir", "bash.exe"))).toBeNull();
});

// 核心回归：Windows 10/11 自带 WSL 占位 stub（C:\Windows\system32\bash.exe）
// 存在于 PATH 且 existsSync 为真，但 WSL 未装时跑 --version 返回 null。
// 若 findSystemBash 只查 existsSync 不校验可用性，会误判"系统已装 Git Bash"，
// 导致 ensureBashAvailable 提前 return null，跳过 PortableGit 下载接线 →
// settings.json.shellPath 恒为空 → pi bash 工具报 "No bash shell found"。
// 修复：findSystemBash 命中候选后必须 bashVersionOf(candidate) 非 null 才算可用。
// mock Bun.which 返回指定 bash 并在用例结束时恢复。
// 注意：globalThis.Bun 引用本身 readonly 但对象可变、which 属性 writable:true，
// 故只替换 Bun.which 的值，不要整体替换 Bun 对象（会 Attempted to assign to readonly property）。
function withMockedWhich(fakeBash: string, fn: () => void): void {
	const bun = (globalThis as any).Bun;
	const originalWhich = bun?.which;
	if (bun) bun.which = () => fakeBash;
	try {
		fn();
	} finally {
		if (bun) {
			if (typeof originalWhich === "function") bun.which = originalWhich;
			else delete bun.which;
		}
	}
}

test("findSystemBash: PATH 上是『存在但跑不通 --version 的假 bash』(如 WSL stub) → 返回 null，不信文件存在", () => {
	// 用临时目录造一个"存在但非合法 bash"的文件：空文件跑 --version 必然失败/无输出
	const fakeDir = join(tmpdir(), `wa-pi-fake-bash-${Date.now()}`);
	mkdirSync(fakeDir, { recursive: true });
	const fakeBash = join(fakeDir, "bash");
	writeFileSync(fakeBash, "", "utf8"); // 空文件：existsSync=true，但跑不出版本号
	try {
		expect(existsSync(fakeBash)).toBe(true);
		withMockedWhich(fakeBash, () => {
			// 关键断言：存在但不可用 → 不能视为系统 bash，必须返回 null
			expect(findSystemBash()).toBeNull();
		});
	} finally {
		rmSync(fakeDir, { recursive: true, force: true });
	}
});

test("findSystemBash: PATH 上是真实可用 bash → 返回该路径", () => {
	// 临时创建一个可执行的假 bash：返回 version 输出（模拟真 Git Bash 的 --version 行为）
	const fakeDir = join(tmpdir(), `wa-pi-fake-bash-ok-${Date.now()}`);
	mkdirSync(fakeDir, { recursive: true });
	const fakeBash = join(fakeDir, "bash");
	writeFileSync(
		fakeBash,
		'#!/bin/sh\n# fake bash stub for test\necho "GNU bash, version 5.2.0(1)-release"\n',
		"utf8",
	);
	try {
		// POSIX 下需要可执行权限脚本才能被 spawnSync 跑起来
		if (process.platform !== "win32") chmodSync(fakeBash, 0o755);
		withMockedWhich(fakeBash, () => {
			expect(findSystemBash()).toBe(fakeBash);
		});
	} finally {
		rmSync(fakeDir, { recursive: true, force: true });
	}
});

test("ensureBashAvailable: 系统已有 bash → null（不下载 PortableGit，不接线）", async () => {
	// 开发机有 Git Bash：应走 findSystemBash 分支返回 null，绝不触发下载
	const result = await ensureBashAvailable();
	if (process.platform === "win32" && findSystemBash()) {
		expect(result).toBeNull();
	}
});
