// subagent-progress-terminal.test.ts — 子智能体进度必须以终态帧收尾（回归 2026-09-23）
//
// 事故：子代理跑了 79.6 分钟、结果完整回传（落盘 details.interrupted=false），
// 前端卡片却显示「已中断」。根因：runner 只在成功路径 emit("done")，
// 中止 / 模型报错 / 异常三条返回路径一帧终态都不发，前端 store 里的 progress
// 永久停在 running，卡片的兜底逻辑遂把「已完成」判成「已中断」。
//
// 断言：任何返回路径都必须让最后一条进度帧是终态（done / error），且终态帧只发一次。
//
// 注意：agent-manager-subagent-overrides.test.ts 用 mock.module 全局 mock 了
// "../src/subagent-runner"（进程级生效且无法撤销），本文件用 cache-bust 查询串
// 动态 import 拿真实实现。
import { test, expect } from "bun:test";
import { join } from "node:path";
import type { SubagentProgressEvent } from "@wa-pi/shared";
import type { WaPiSpawnConfig } from "../src/subagent-runner";

const REAL_RUNNER_SPEC = "../src/subagent-runner.ts?terminal=1";
type RunnerModule = typeof import("../src/subagent-runner");
const { runSubagentAgent } = (await import(REAL_RUNNER_SPEC)) as RunnerModule;

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");
const SAW_ERROR_PI = join(import.meta.dir, "fixtures", "saw-error-pi.ts");
const ABORTED_TOOLS_PI = join(import.meta.dir, "fixtures", "aborted-tools-pi.ts");
const RUNTIME = process.execPath;

function baseConfig(): WaPiSpawnConfig {
	return {
		name: "research",
		description: "调研",
		systemPrompt: "你是一个调研员",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	};
}

/** 收集进度事件并按顺序返回 */
function collector(): {
	events: SubagentProgressEvent[];
	onProgress: (e: SubagentProgressEvent) => void;
} {
	const events: SubagentProgressEvent[] = [];
	return { events, onProgress: (e) => events.push(e) };
}

test("成功路径：终态帧恰一条 done（原有行为回归保护）", async () => {
	const { events, onProgress } = collector();
	const result = await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
		onProgress,
	});
	expect(result.isError).toBe(false);
	expect(events.at(-1)?.status).toBe("done");
	expect(events.filter((e) => e.status !== "running").length).toBe(1);
});

test("模型报错后仍正常收尾：进度必须落到终态，不得停在 running", async () => {
	const { events, onProgress } = collector();
	const result = await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: SAW_ERROR_PI,
		runtime: RUNTIME,
		onProgress,
	});
	// 模型中途报错 → 返回失败（isError），但进程是正常收尾的
	expect(result.isError).toBe(true);
	// 关键断言：最后一条进度帧必须是终态，否则前端会永久停在「运行中」
	expect(events.length).toBeGreaterThan(0);
	expect(events.at(-1)?.status).not.toBe("running");
	expect(events.filter((e) => e.status !== "running").length).toBe(1);
});

test("中止路径：进度必须落到终态", async () => {
	const ctrl = new AbortController();
	const { events, onProgress } = collector();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ABORTED_TOOLS_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // 拉长 settle 超时：验证 abort 短路先触发
		abortGraceMs: 300,
		signal: ctrl.signal,
		onProgress,
	});
	await new Promise((r) => setTimeout(r, 400)); // 等 fixture 发完工具事件
	ctrl.abort();
	const result = await resultP;
	expect(result.interrupted).toBe(true);
	expect(events.length).toBeGreaterThan(0);
	expect(events.at(-1)?.status).not.toBe("running");
	expect(events.filter((e) => e.status !== "running").length).toBe(1);
}, 10_000);

test("无进展判死路径：进度必须落到终态", async () => {
	const { events, onProgress } = collector();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ABORTED_TOOLS_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 500, // 500ms 无事件即判死
		onProgress,
	});
	expect(result.interrupted).toBe(true);
	expect(events.length).toBeGreaterThan(0);
	expect(events.at(-1)?.status).not.toBe("running");
	expect(events.filter((e) => e.status !== "running").length).toBe(1);
}, 10_000);
