// agent 进程崩溃日志 单测
//
// 背景：pi rpc 子进程被 SIGTRAP/SIGSEGV 等信号杀死时（如 Bun 运行时 panic），
// 之前只有 code=133 这类数字可查，panic 原文只打在子进程 stderr 上随对象丢弃。
// 修复后：RpcClient.onExit 以 signal 字段上报死因（exitCode 为 null），并落盘到
// <WA_PI_DIR>/logs/agent-crash.log。本文件覆盖：
//   1. RpcClient 对「被信号杀死」的子进程上报 (code=null, signal=SIGTRAP)
//   2. formatAgentCrashBlock 格式化（字段齐全 / 空降级 / 超长截断）
//   3. logAgentCrash 真实写盘（自动建目录、静默吞错）

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { RpcClient } from "../rpc-client";
import {
	formatAgentCrashBlock,
	logAgentCrash,
	type AgentCrashEntry,
} from "../crash-logger";

/** spawn 后自杀于指定信号的假 cli 脚本（信号内联进脚本，避开 argv 差异） */
function killSelfScript(sig: string): string {
	return `setTimeout(() => process.kill(process.pid, ${JSON.stringify(sig)}), 50);`;
}

/**
 * 构造 spawnFn：返回的假 Subprocess 由真实 Node 子进程驱动。
 * exit 时同步记录 signal 再 resolve exited，与 Bun 原生语义对齐
 * （onProcExit 回调读 signalCode 时值已就绪）。
 */
function makeKilledSpawnFn(sig: string) {
	return () => {
		let signalCode: string | null = null;
		let resolveExited!: (code: number | null) => void;
		const exited = new Promise<number | null>((res) => {
			resolveExited = res;
		});
		const child = spawn(process.execPath, ["-e", killSelfScript(sig)], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.once("exit", (_code, signal) => {
			if (signal) signalCode = signal;
			// 信号死亡 exitCode 为 null（与 Bun exited Promise 语义一致）
			resolveExited(null);
		});
		return {
			stdin: null,
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
			exited,
			get signalCode() {
				return signalCode;
			},
			exitCode: null,
			pid: child.pid ?? null,
			kill() {},
		} as unknown as Subprocess;
	};
}

/** 公共崩溃条目样例 */
const baseEntry: AgentCrashEntry = {
	sessionId: "s-1",
	agentName: "main",
	code: 133,
	signal: "SIGTRAP",
	pid: 4242,
	stderrLines: [
		"============================================================",
		"Bun v1.x.x a panic occurred",
		"boom panic",
	],
};

if (process.platform !== "win32") {
	describe("RpcClient 子进程被信号杀死", () => {
		test("以 (code=null, signal=SIGTRAP) 上报，不误报为退出码", async () => {
			// 用 ref 对象捕获：TS 流分析不追踪闭包内的直接变量赋值
			const exitRef: {
				value: { code: number | null; signal: string | null } | undefined;
			} = { value: undefined };
			const client = new RpcClient({
				cliPath: "fake-cli.js",
				runtime: "fake-runtime",
				cwd: tmpdir(),
				onEvent: () => {},
				onExit: (code, signal) => {
					exitRef.value = { code, signal };
				},
				spawnFn: makeKilledSpawnFn("SIGTRAP"),
			});
			await client.start();
			for (let i = 0; i < 100 && !exitRef.value; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(exitRef.value).toEqual({ code: null, signal: "SIGTRAP" });
			// pid 可取（用于与系统 .ips 报告交叉比对）
			expect(client.pid).not.toBeNull();
		});
	});
}

describe("formatAgentCrashBlock", () => {
	test("包含会话/代理/PID/code/signal 与 stderr 尾部原文", () => {
		const block = formatAgentCrashBlock(baseEntry);
		expect(block).toContain("session=s-1");
		expect(block).toContain("agent=main");
		expect(block).toContain("pid=4242");
		expect(block).toContain("code=133");
		expect(block).toContain("signal=SIGTRAP");
		expect(block).toContain("boom panic");
	});

	test("字段缺省时降级显示（code=null / signal=none / stderr 无）", () => {
		const block = formatAgentCrashBlock({
			...baseEntry,
			code: null,
			signal: null,
			pid: null,
			stderrLines: [],
		});
		expect(block).toContain("pid=?");
		expect(block).toContain("code=null");
		expect(block).toContain("signal=none");
		expect(block).toContain("(无)");
	});

	test("stderr 超 50 行只保留末 50 行，单行超长截断", () => {
		const lines = Array.from(
			{ length: 60 },
			(_, i) => `L${String(i).padStart(2, "0")}`,
		);
		lines[55] = "X".repeat(5000); // 超长行须落在末 50 行保留区内才能验证截断
		const block = formatAgentCrashBlock({
			...baseEntry,
			stderrLines: lines,
		});
		// 早期行丢弃、末行保留
		expect(block).not.toContain("\nL00");
		expect(block).toContain("\nL59");
		// 超长行截断到 2000 字符
		expect(block).toContain(`${"X".repeat(2000)}`);
		expect(block).not.toContain(`${"X".repeat(2001)}`);
	});
});

describe("logAgentCrash 落盘", () => {
	test("追加写入指定文件并自动创建目录", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wapi-agent-crash-"));
		try {
			const path = join(dir, "nested", "logs", "agent-crash.log");
			logAgentCrash(path, { ...baseEntry, signal: "SIGSEGV" });
			logAgentCrash(path, baseEntry);
			// fire-and-forget 写入，轮询等待内容就绪
			let text = "";
			for (let i = 0; i < 50; i++) {
				try {
					text = await readFile(path, "utf8");
				} catch {
					/* 目录/文件尚未就绪 */
				}
				if (text.split("=====").length > 5) break;
				await new Promise((r) => setTimeout(r, 20));
			}
			expect(text).toContain("signal=SIGSEGV");
			expect(text).toContain("signal=SIGTRAP");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("目标路径不可写时不抛错（日志失败绝不反向影响会话）", () => {
		// 目录路径当文件写 → appendFile 必失败，但调用方不应收到异常
		logAgentCrash(tmpdir(), baseEntry);
		expect(true).toBe(true);
	});
});
