// PoC：验证 runtime-bin 兼容层将 node 链接改用 bun 是否可行。
//
// 背景：desktop 打包版为动态插件（npm 包）与 MCP server 提供 node/npx/npm 命令
// （main.cjs ensureRuntimeBinLinks）。当前 node 链接优先系统 node，否则 bun 冒充。
// 本 PoC 验证「node 链接总是指向 bun」能否覆盖核心场景：node API 兼容、shebang
// 脚本、npx（bun x）运行工具、bun 冒充 node 直接运行 npm 包。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const BUN = process.execPath;
const isWin = process.platform === "win32";

/** 模拟 runtime-bin 产物：node/npx/npm 全部指向 bun（与 main.cjs 的 bun fallback 分支一致）。 */
function setupRuntimeBin(): {
	dir: string;
	node: string;
	npx: string;
	npm: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "poc-runtime-bin-"));
	const t = BUN;
	if (isWin) {
		const nodeCmd = join(dir, "node.cmd");
		writeFileSync(nodeCmd, `@echo off\r\n"${t}" %*\r\n`);
		const npxCmd = join(dir, "npx.cmd");
		writeFileSync(npxCmd, `@echo off\r\n"${t}" x %*\r\n`);
		const npmCmd = join(dir, "npm.cmd");
		writeFileSync(
			npmCmd,
			`@echo off\r\nif /i "%~1"=="exec" (shift & "${t}" x %*) else "${t}" %*\r\n`,
		);
		return { dir, node: nodeCmd, npx: npxCmd, npm: npmCmd };
	}
	const nodeLink = join(dir, "node");
	require("node:fs").symlinkSync(t, nodeLink);
	chmodSync(nodeLink, 0o755);
	const npxPath = join(dir, "npx");
	writeFileSync(npxPath, `#!/bin/sh\nexec "${t}" x "$@"\n`);
	chmodSync(npxPath, 0o755);
	const npmPath = join(dir, "npm");
	writeFileSync(
		npmPath,
		`#!/bin/sh\nif [ "$1" = "exec" ]; then shift; exec "${t}" x "$@"; fi\nexec "${t}" "$@"\n`,
	);
	chmodSync(npmPath, 0o755);
	return { dir, node: nodeLink, npx: npxPath, npm: npmPath };
}

function run(cmd: string, args: string[], timeoutMs = 30_000, cwd?: string) {
	return spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, cwd });
}

test("node 链接指向 bun：node --version 正常（bun 冒充 node，输出 bun 版本号而非 node 版本号）", () => {
	const { node } = setupRuntimeBin();
	const r = run(node, ["--version"]);
	expect(r.status).toBe(0);
	// 注意：bun 冒充 node 时 --version 输出 bun 版本（如 1.3.14），而非 node 的 v24.3.0。
	// 这是 PoC 发现的兼容性差异：严格正则检查 node 版本 >= 20 的脚本可能误判。
	expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test("node 链接指向 bun：运行 shebang（#!/usr/bin/env node）脚本", () => {
	const { node } = setupRuntimeBin();
	const script = join(tmpdir(), `poc-shebang-${Date.now()}.js`);
	writeFileSync(
		script,
		'#!/usr/bin/env node\nconst fs=require("node:fs");console.log("shebang-ok", process.version, typeof fs.readFileSync);\n',
	);
	chmodSync(script, 0o755);
	const r = run(node, [script]);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("shebang-ok");
});

test("node 链接指向 bun：Node API 兼容（fs/path/child_process 等核心模块）", () => {
	const { node } = setupRuntimeBin();
	const script = join(tmpdir(), `poc-api-${Date.now()}.js`);
	writeFileSync(
		script,
		[
			'const fs=require("node:fs");',
			'const path=require("node:path");',
			'const cp=require("node:child_process");',
			'const os=require("node:os");',
			'const http=require("node:http");',
			'console.log("api-ok", typeof fs.readFileSync, typeof path.join, typeof cp.spawnSync, typeof os.homedir, typeof http.createServer);',
		].join("\n"),
	);
	const r = run(node, [script]);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("api-ok");
});

test("npx 链接指向 bun x：运行 npm 包工具（tsc）", () => {
	const { npx } = setupRuntimeBin();
	// bun x 等价 npx；tsc 是常见动态插件工具。首次会下载（慢），设 120s 超时。
	const r = run(
		npx,
		["--yes", "typescript@latest", "tsc", "--version"],
		120_000,
	);
	expect(r.status).toBe(0);
	expect(r.stdout).toMatch(/Version \d+\.\d+/);
});

test("npm 链接指向 bun：安装并运行 npm 包（bun 冒充 node 执行包入口）", () => {
	const { npm, node } = setupRuntimeBin();
	const workDir = mkdtempSync(join(tmpdir(), "poc-npm-"));
	// 用 npm（bun）初始化一个临时包并安装 prettier（bun 兼容 npm install）
	const init = run(npm, ["init", "-y"], 30_000, workDir);
	expect(init.status).toBe(0);
	const install = run(npm, ["install", "prettier@3"], 120_000, workDir);
	expect(install.status).toBe(0);
	const binPath = join(workDir, "node_modules", ".bin");
	// prettier 的 bin 入口 shebang 是 #!/usr/bin/env node——用 node 链接（→bun）直接运行
	const prettierBin = join(binPath, "prettier");
	const r = run(node, [prettierBin, "--version"], 30_000);
	expect(r.stdout.trim()).toMatch(/^3\.\d+\.\d+/);
});
