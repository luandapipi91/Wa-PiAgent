// runtime-bin.cjs 单元测试。
// 覆盖：findSystemNode 类型验证、ensureRuntimeBinLinks 的每个判断节点
// （isPackaged 开关、有/无 nodeExe 时 binDir 文件差异、文件内容正确性）。
import { test, expect } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	lstat,
	writeFile,
	mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findSystemNode,
	ensureRuntimeBinLinks,
	buildRuntimePath,
	toPosixPath,
} from "../src/util/runtime-bin.cjs";

const isWin = process.platform === "win32";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as any;

async function makeTempDir() {
	return mkdtemp(join(tmpdir(), "runtime-bin-test-"));
}

// ===================== findSystemNode =====================

test("findSystemNode: 返回 null 或有效路径（不抛异常）", () => {
	const result = findSystemNode();
	expect(result === null || typeof result === "string").toBe(true);
});

// ===================== ensureRuntimeBinLinks: isPackaged 开关 =====================

test("ensureRuntimeBinLinks: isPackaged=false → null（dev 模式不生成）", async () => {
	const waPiDir = await makeTempDir();
	try {
		const result = await ensureRuntimeBinLinks({
			kernelExe: "/fake/wa-pi-kernel",
			waPiDir,
			log: noopLog,
			nodeExe: null,
			isPackaged: false,
		} as any);
		expect(result).toBeNull();
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});

// ===================== ensureRuntimeBinLinks: 有真实 node =====================

test("ensureRuntimeBinLinks: 有 nodeExe → binDir 只有 bun.cmd（不遮蔽 node 自带 npm/npx）", async () => {
	const waPiDir = await makeTempDir();
	try {
		await ensureRuntimeBinLinks({
			kernelExe: "/fake/wa-pi-kernel",
			waPiDir,
			log: noopLog,
			nodeExe: "/fake/node",
			isPackaged: true,
		} as any);

		const files = await readdir(join(waPiDir, "bin"));
		const bunName = process.platform === "win32" ? "bun.cmd" : "bun";
		expect(files).toContain(bunName);
		// 有真实 node 时不应生成 bun x 包装脚本
		const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
		const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
		expect(files).not.toContain(npxName);
		expect(files).not.toContain(npmName);
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});

test("ensureRuntimeBinLinks: bun wrapper 内容含 kernelExe 路径与 BUN_BE_BUN=1", async () => {
	const waPiDir = await makeTempDir();
	try {
		const kernelExe =
			process.platform === "win32"
				? "C:\\fake\\WaPiKernel.exe"
				: "/fake/WaPiKernel";
		await ensureRuntimeBinLinks({
			kernelExe,
			waPiDir,
			log: noopLog,
			nodeExe: "/fake/node",
			isPackaged: true,
		} as any);

		const bunName = process.platform === "win32" ? "bun.cmd" : "bun";
		const bunWrapper = await readFile(join(waPiDir, "bin", bunName), "utf8");
		expect(bunWrapper).toContain(kernelExe);
		expect(bunWrapper).toContain("BUN_BE_BUN=1");
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});

// ===================== ensureRuntimeBinLinks: 无 node（bun fallback） =====================

test("ensureRuntimeBinLinks: 无 nodeExe → bun.cmd 仍生成（fallback 保底）", async () => {
	const waPiDir = await makeTempDir();
	try {
		await ensureRuntimeBinLinks({
			kernelExe: "/fake/wa-pi-kernel",
			waPiDir,
			log: noopLog,
			nodeExe: null,
			isPackaged: true,
		} as any);

		const files = await readdir(join(waPiDir, "bin"));
		const bunName = process.platform === "win32" ? "bun.cmd" : "bun";
		expect(files).toContain(bunName);
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});

test("ensureRuntimeBinLinks: 无 nodeExe → node/npm/npx fallback wrapper 也带 BUN_BE_BUN=1", async () => {
	const waPiDir = await makeTempDir();
	try {
		await ensureRuntimeBinLinks({
			kernelExe:
				process.platform === "win32"
					? "C:\\fake\\WaPiKernel.exe"
					: "/fake/WaPiKernel",
			waPiDir,
			log: noopLog,
			nodeExe: null,
			isPackaged: true,
		} as any);

		// Windows 无 nodeExe 时 findSystemNode() 可能在本机找到真实 node 而跳过
		// fallback（此时 binDir 只有 bun.cmd）；只断言真实存在的 wrapper 文本
		// （POSIX 有真实 node 时 node 是符号链接，读它无意义，排除）。
		const binDir = join(waPiDir, "bin");
		const files = await readdir(binDir);
		const bunName = process.platform === "win32" ? "bun.cmd" : "bun";
		expect(files).toContain(bunName);
		const symlinkSet = new Set<string>();
		for (const n of files) {
			try {
				if ((await lstat(join(binDir, n))).isSymbolicLink()) symlinkSet.add(n);
			} catch {}
		}
		const names = (
			process.platform === "win32"
				? ["bun.cmd", "node.cmd", "npm.cmd", "npx.cmd"]
				: ["bun", "node", "npm", "npx"]
		).filter((n) => files.includes(n) && !symlinkSet.has(n));
		for (const name of names) {
			const content = await readFile(join(waPiDir, "bin", name), "utf8");
			expect(content).toContain("BUN_BE_BUN=1");
		}
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});

// ===================== Windows: bash 可执行的无后缀 bun shim =====================

// 背景：Git Bash / MSYS 查找命令只认无后缀或 .exe，不按 PATHEXT 解析 .cmd。
// 只生成 bun.cmd 时，bash 里 `bun` 永远解析到系统全局 bun。
test.skipIf(!isWin)(
	"ensureRuntimeBinLinks: win32 额外生成无后缀 bun（Git Bash 能识别）",
	async () => {
		const waPiDir = await makeTempDir();
		try {
			const kernelExe = join(waPiDir, "WaPiKernel.exe");
			const binDir = await ensureRuntimeBinLinks({
				kernelExe,
				waPiDir,
				log: noopLog,
				nodeExe: "/fake/node",
				isPackaged: true,
			} as any);

			const files = await readdir(binDir!);
			expect(files).toContain("bun");
			const content = await readFile(join(binDir!, "bun"), "utf8");
			expect(content.startsWith("#!/bin/sh")).toBe(true);
			expect(content).toContain("BUN_BE_BUN=1 exec");
			// 脚本里必须是 POSIX 路径（反斜杠在 sh 中会被当转义符）
			expect(content).toContain(toPosixPath(kernelExe));
			expect(content).not.toContain("\\");
			// Windows 上 chmod 只切只读位，能否执行由 MSYS 的 noacl 规则决定；
			// 「真实 bash 可执行」由 runtime-bin-bash.integration.test.ts 验证。
		} finally {
			await rm(waPiDir, { recursive: true, force: true });
		}
	},
);

// ===================== Windows: 遗留 cmd 清理与刷新 =====================

test.skipIf(!isWin)(
	"ensureRuntimeBinLinks: 有真实 node → 删除遗留 node/npm/npx.cmd（前置 PATH 后不再遮蔽真实 node）",
	async () => {
		const waPiDir = await makeTempDir();
		try {
			const binDir = join(waPiDir, "bin");
			await mkdir(binDir, { recursive: true });
			// 模拟旧版本遗留：指向已不存在的旧安装路径
			for (const name of ["node.cmd", "npm.cmd", "npx.cmd"]) {
				await writeFile(
					join(binDir, name),
					`@echo off\r\nset BUN_BE_BUN=1\r\n"D:\\Program Files\\WA PI Agent\\resources\\kernel\\wa-pi-kernel.exe" %*\r\n`,
				);
			}

			await ensureRuntimeBinLinks({
				kernelExe: join(waPiDir, "WaPiKernel.exe"),
				waPiDir,
				log: noopLog,
				nodeExe: "C:\\Program Files\\nodejs\\node.exe",
				isPackaged: true,
			} as any);

			const files = await readdir(binDir);
			expect(files).not.toContain("node.cmd");
			expect(files).not.toContain("npm.cmd");
			expect(files).not.toContain("npx.cmd");
			expect(files).toContain("bun.cmd");
			expect(files).toContain("bun");
		} finally {
			await rm(waPiDir, { recursive: true, force: true });
		}
	},
);

test.skipIf(!isWin)(
	"ensureRuntimeBinLinks: 无 node → fallback cmd 每次重写为当前 kernelExe（覆盖旧安装路径）",
	async () => {
		const waPiDir = await makeTempDir();
		try {
			const binDir = join(waPiDir, "bin");
			await mkdir(binDir, { recursive: true });
			for (const name of ["node.cmd", "npm.cmd", "npx.cmd"]) {
				await writeFile(
					join(binDir, name),
					`@echo off\r\nset BUN_BE_BUN=1\r\n"D:\\old\\wa-pi-kernel.exe" %*\r\n`,
				);
			}

			const kernelExe = join(waPiDir, "WaPiKernel.exe");
			await ensureRuntimeBinLinks({
				kernelExe,
				waPiDir,
				log: noopLog,
				nodeExe: null,
				// 注入「找不到系统 node」，稳定命中 fallback 分支
				findSystemNodeFn: () => null,
				isPackaged: true,
			} as any);

			const nodeCmd = await readFile(join(binDir, "node.cmd"), "utf8");
			expect(nodeCmd).toContain(kernelExe);
			expect(nodeCmd).not.toContain("D:\\old");
		} finally {
			await rm(waPiDir, { recursive: true, force: true });
		}
	},
);

// ===================== buildRuntimePath =====================

test("buildRuntimePath: 目录前置到 PATH 最前，保留原有条目", () => {
	expect(buildRuntimePath("C:\\sys1;C:\\sys2", ["C:\\bin", "C:\\node"], ";")).toBe(
		"C:\\bin;C:\\node;C:\\sys1;C:\\sys2",
	);
	expect(buildRuntimePath("/usr/bin:/bin", ["/home/u/.pi/agent/bin"], ":")).toBe(
		"/home/u/.pi/agent/bin:/usr/bin:/bin",
	);
});

test("buildRuntimePath: 原 PATH 已有同一目录时移到最前（不重复）", () => {
	expect(
		buildRuntimePath("C:\\sys;C:\\bin;C:\\other", ["C:\\bin"], ";"),
	).toBe("C:\\bin;C:\\sys;C:\\other");
});

test("buildRuntimePath: 空 / 未定义 PATH 只保留前置目录", () => {
	expect(buildRuntimePath("", ["/a"], ":")).toBe("/a");
	expect(buildRuntimePath(undefined as any, ["/a"], ":")).toBe("/a");
	expect(buildRuntimePath("/sys", [], ":")).toBe("/sys");
});

// ===================== main.cjs 契约 =====================

test("main.cjs: PATH 走 buildRuntimePath 前置（禁止再退回字符串拼接追加）", async () => {
	const src = await readFile(join(import.meta.dir, "../src/main.cjs"), "utf8");
	expect(src).toContain("buildRuntimePath");
	expect(src).not.toMatch(/process\.env\.PATH = \(process\.env\.PATH \|\| ""\) \+ sep/);
});

// ===================== ensureRuntimeBinLinks: 返回值 =====================

test("ensureRuntimeBinLinks: 返回 binDir 路径（waPiDir/bin）", async () => {
	const waPiDir = await makeTempDir();
	try {
		const result = await ensureRuntimeBinLinks({
			kernelExe: "/fake/wa-pi-kernel",
			waPiDir,
			log: noopLog,
			nodeExe: "/fake/node",
			isPackaged: true,
		} as any);
		expect(result).toBe(join(waPiDir, "bin"));
	} finally {
		await rm(waPiDir, { recursive: true, force: true });
	}
});
