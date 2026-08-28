/**
 * 「系统打开」出口的环境净化接线验证。
 *
 * 背景：文件树右键「默认方式打开」/ reveal-file 走 spawnOpen（mac open / win start /
 * linux xdg-open）。macOS 的 open 经 LaunchServices 把调用者环境传给目标应用，
 * .command 由 Terminal 继承执行——若不剥离 WA_PI_*，被打开脚本（如项目 start.command
 * → bun run dev）读到继承的端口变量后启动即 killPort，抢占宿主 wa-pi 实例的端口；
 * 访达双击走 launchd 环境干净，故仅在 wa-pi 内触发。
 *
 * 用 mock.module 拦截 child_process.spawn：不真启动应用，仅捕获收到的 options。
 */
import { describe, it, expect, mock } from "bun:test";

/** 捕获 spawn 收到的 options（本测试只关心 stdio/env 两个字段） */
interface SpawnOpts {
	stdio?: string;
	env?: Record<string, string | undefined>;
}
const spawnCalls: Array<{ cmd: string; args: string[]; opts?: SpawnOpts }> = [];

mock.module("node:child_process", () => ({
	spawn: (cmd: string, args: string[], opts?: SpawnOpts) => {
		spawnCalls.push({ cmd, args, opts });
		return { unref() {}, on() {}, pid: 12345 };
	},
	spawnSync: () => ({ status: 0 }),
	exec: () => {},
	execSync: () => "",
	execFile: () => {},
	execFileSync: () => "",
	fork: () => ({}),
}));

import { spawnOpen } from "../src/routes/fs";

describe("spawnOpen 环境净化", () => {
	it("传给 open 的 env 剥离 WA_PI_* 内部变量、保留系统变量", () => {
		process.env.WA_PI_TEST_WS_PORT = "9776";
		process.env.WA_PI_TEST_DIR = "/tmp/wa-pi-test";
		try {
			spawnCalls.length = 0;
			spawnOpen("open", "/tmp/demo.command");

			expect(spawnCalls.length).toBe(1);
			const { cmd, args, opts } = spawnCalls[0]!;
			expect(cmd).toBe("open");
			expect(args).toEqual(["/tmp/demo.command"]);
			// stdio ignore 保持（打开动作静默）
			expect(opts?.stdio).toBe("ignore");
			// env 必须显式传递且已净化
			expect(opts?.env).toBeTruthy();
			expect(opts?.env?.WA_PI_TEST_WS_PORT).toBeUndefined();
			expect(opts?.env?.WA_PI_TEST_DIR).toBeUndefined();
			expect(opts?.env?.PATH).toBeDefined();
			expect(opts?.env?.HOME).toBeDefined();
		} finally {
			delete process.env.WA_PI_TEST_WS_PORT;
			delete process.env.WA_PI_TEST_DIR;
		}
	});
});
