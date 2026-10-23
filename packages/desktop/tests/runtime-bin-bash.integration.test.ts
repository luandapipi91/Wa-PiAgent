// 集成测试（真实 bash 进程）：验证生成的 bun shim 能被 Git Bash / POSIX shell 找到并执行。
// 对应问题：Windows 上只生成 bun.cmd 时，bash 不认 .cmd，`bun` 落到系统全局版本。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureRuntimeBinLinks,
	toPosixPath,
} from "../src/util/runtime-bin.cjs";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as any;
const isWin = process.platform === "win32";

function hasBash(): boolean {
	const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() === "ok";
}

const bashAvailable = hasBash();

test.skipIf(!bashAvailable)(
	"真实 bash：PATH 前置 binDir 后 `bun` 命中 shim，且 shim 可执行（--version）",
	async () => {
		const waPiDir = await mkdtemp(join(tmpdir(), "runtime-bin-bash-"));
		try {
			// 用当前真实 bun 可执行文件代替编译产物（验证的是 shim 形态与查找路径）
			const kernelExe = process.execPath;
			const binDir = await ensureRuntimeBinLinks({
				kernelExe,
				waPiDir,
				log: noopLog,
				nodeExe: "/fake/node",
				isPackaged: true,
			} as any);

			const shimPosix = isWin ? toPosixPath(join(binDir!, "bun")) : join(binDir!, "bun");
			const binPosix = isWin ? toPosixPath(binDir!) : binDir!;

			// 1) bash 的命令查找：应命中 shim（而非系统 ~/.bun/bin/bun）
			const found = spawnSync(
				"bash",
				["-c", 'PATH="$1":/usr/bin:/bin; command -v bun', "_", binPosix],
				{ encoding: "utf8" },
			);
			expect(found.status).toBe(0);
			const foundPath = found.stdout.trim().split(/\r?\n/)[0];
			expect(foundPath.endsWith("/bun")).toBe(true);
			expect(foundPath).toBe(shimPosix);

			// 2) 真实执行：shim 设 BUN_BE_BUN=1 后 exec 目标二进制，应输出 bun 版本
			const run = spawnSync("bash", ["-c", '"$1" --version', "_", shimPosix], {
				encoding: "utf8",
			});
			expect(run.status).toBe(0);
			expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		} finally {
			await rm(waPiDir, { recursive: true, force: true });
		}
	},
);
