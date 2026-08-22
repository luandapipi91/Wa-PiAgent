// bash-runtime 纯函数测试：系统 bash 检测、PortableGit 路径/URL、版本校验。
// 注意：不触发 ensurePortableBash（会真实下载 64MB PortableGit——那是端到端验证的职责）。
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
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

test("ensureBashAvailable: 系统已有 bash → null（不下载 PortableGit，不接线）", async () => {
	// 开发机有 Git Bash：应走 findSystemBash 分支返回 null，绝不触发下载
	const result = await ensureBashAvailable();
	if (process.platform === "win32" && findSystemBash()) {
		expect(result).toBeNull();
	}
});
