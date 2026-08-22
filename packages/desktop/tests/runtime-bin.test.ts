// runtime-bin.cjs 单元测试。
// 覆盖：findSystemNode 类型验证、ensureRuntimeBinLinks 的每个判断节点
// （isPackaged 开关、有/无 nodeExe 时 binDir 文件差异、文件内容正确性）。
import { test, expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findSystemNode,
	ensureRuntimeBinLinks,
} from "../src/util/runtime-bin.cjs";

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
