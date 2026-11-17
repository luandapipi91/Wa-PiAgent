// MCP stdio 子进程的 cwd 兜底（2026-11-17 Context7 运行时 0 工具根因）。
//
// 不变量：
//   1. 包管理器命令（npx/npm/...）未显式配置 cwd 时补数据目录 —— 它们会读 cwd 的
//      package.json，项目带 overrides 时 npm 直接 EOVERIDE 秒退、握手从未开始；
//   2. 用户显式配置的 cwd 一律尊重（含相对路径），非空才算显式；
//   3. HTTP server 与非包管理器 stdio 不补 —— 后者可能刻意依赖会话（项目）目录。
import { describe, expect, test } from "bun:test";
import { isPackageManagerCommand, withStdioCwdFallback } from "../mcp-cwd.ts";

describe("isPackageManagerCommand", () => {
	test("识别常见包管理器命令", () => {
		for (const cmd of ["npx", "npm", "pnpm", "yarn", "bunx", "corepack"]) {
			expect(isPackageManagerCommand(cmd)).toBe(true);
		}
	});

	test("大小写与 Windows 后缀不影响识别", () => {
		expect(isPackageManagerCommand("NPX")).toBe(true);
		expect(isPackageManagerCommand("npx.cmd")).toBe(true);
		expect(isPackageManagerCommand("npm.EXE")).toBe(true);
	});

	test("识别绝对路径里的命令名", () => {
		expect(isPackageManagerCommand("/usr/local/bin/npx")).toBe(true);
		expect(isPackageManagerCommand("/Users/co/.nvm/versions/node/v24.22.2/bin/npm")).toBe(
			true,
		);
		expect(isPackageManagerCommand("C:\\Program Files\\nodejs\\npx.cmd")).toBe(true);
	});

	test("普通命令与非法输入不命中", () => {
		for (const cmd of ["node", "python", "bun", "/Users/co/.dbx/bin/dbx-mcp"]) {
			expect(isPackageManagerCommand(cmd)).toBe(false);
		}
		expect(isPackageManagerCommand(undefined)).toBe(false);
		expect(isPackageManagerCommand(42)).toBe(false);
	});
});

describe("withStdioCwdFallback", () => {
	const fallback = "/Users/co/.pi/agent";

	test("npx 型 stdio 缺 cwd 时补兜底目录", () => {
		const out = withStdioCwdFallback(
			{ command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
			fallback,
		);
		expect(out.cwd).toBe(fallback);
	});

	test("空字符串 cwd 视同未配置", () => {
		const out = withStdioCwdFallback({ command: "npx", cwd: "  " }, fallback);
		expect(out.cwd).toBe(fallback);
	});

	test("显式 cwd（含相对路径）原样保留", () => {
		expect(withStdioCwdFallback({ command: "npx", cwd: "./tools" }, fallback).cwd).toBe(
			"./tools",
		);
		expect(withStdioCwdFallback({ command: "npx", cwd: "/opt/mcp" }, fallback).cwd).toBe(
			"/opt/mcp",
		);
	});

	test("HTTP 条目不补（cwd 对 url 型 server 无意义）", () => {
		const entry = { url: "https://example.com/mcp" };
		expect(withStdioCwdFallback(entry, fallback)).toBe(entry);
	});

	test("非包管理器 stdio 不补（可能刻意依赖项目目录）", () => {
		const entry = { command: "node", args: ["server.js"] };
		expect(withStdioCwdFallback(entry, fallback)).toBe(entry);
	});

	test("已补过的条目原样返回（幂等）", () => {
		const entry = { command: "npx", args: ["-y", "pkg"], cwd: fallback };
		expect(withStdioCwdFallback(entry, fallback)).toBe(entry);
	});
});
