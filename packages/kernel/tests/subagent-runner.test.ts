// subagent-runner.test.ts — runSubagentAgent（一次性 pi rpc 子进程）测试
//
// RPC 迁移后 runSubagentAgent 直接 spawn `pi --mode rpc --no-session` 子进程。
// 测试用 tests/fixtures/fake-pi.ts 作为 cliPath、process.execPath 作 runtime 真实跑通：
// - fake-pi：prompt 后回 "回声:<task>" 事件流并 settled（协议对齐 pi --mode rpc）；
// - argv-dump-pi：把启动参数 dump 到 ARGV_DUMP_FILE 指定文件（断言 config → CLI 参数映射）。
//
// 注意：agent-manager-subagent-overrides.test.ts 用 mock.module 全局 mock 了
// "../src/subagent-runner"（bun 的 mock.module 进程级生效且 mock.restore() 无法撤销）。
// 本文件用 cache-bust 查询串动态 import，绕过该 mock 拿真实实现。
import { test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WaPiSpawnConfig } from "../src/subagent-runner";
import type { SubagentProgressEvent } from "@wa-pi/shared";

// cache-bust：绕过 overrides 测试的 mock.module，加载真实 subagent-runner
const REAL_RUNNER_SPEC = "../src/subagent-runner.ts?real=1";
type RunnerModule = typeof import("../src/subagent-runner");
const { runSubagentAgent } = (await import(REAL_RUNNER_SPEC)) as RunnerModule;

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");
const ARGV_DUMP_PI = join(import.meta.dir, "fixtures", "argv-dump-pi.ts");
const HANG_PI = join(import.meta.dir, "fixtures", "hang-pi.ts");
const RUNTIME = process.execPath;

const tmpPaths: string[] = [];
afterEach(() => {
	delete process.env.ARGV_DUMP_FILE;
	for (const f of tmpPaths.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			/* 临时文件清理失败不影响测试 */
		}
	}
});

function baseConfig(patch: Partial<WaPiSpawnConfig> = {}): WaPiSpawnConfig {
	return {
		name: "research",
		description: "调研",
		systemPrompt: "你是一个调研员",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
		...patch,
	};
}

test("正常流程：回声文本 + isError=false + onProgress 收到 running/done 事件", async () => {
	const events: SubagentProgressEvent[] = [];
	const result = await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
		onProgress: (e) => events.push(e),
	});

	expect(result.isError).toBe(false);
	expect(result.text).toContain("回声:测试任务");
	// toolStats 字段存在且结构正确（fake-pi 不发工具事件 → 全零）
	expect(result.toolStats).toEqual({
		total: 0,
		done: 0,
		error: 0,
		running: 0,
	});
	// fake-pi 有 message_update(text_delta) → 触发 running 进度事件；结束时发 done
	expect(events.some((e) => e.status === "running")).toBe(true);
	expect(events.at(-1)?.status).toBe("done");
	expect(events.every((e) => e.agent === "research")).toBe(true);
});

test("config 映射为 CLI 参数：--model/--thinking(max→xhigh)/--tools/--no-session/--name", async () => {
	const dumpFile = join(
		"/tmp",
		`wa-pi-argv-dump-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
	);
	tmpPaths.push(dumpFile);
	process.env.ARGV_DUMP_FILE = dumpFile;

	const result = await runSubagentAgent(
		baseConfig({
			model: "openai/gpt-4o",
			thinking: "max",
			tools: ["read", "grep"],
		}),
		"任务",
		"/tmp",
		{ cliPath: ARGV_DUMP_PI, runtime: RUNTIME },
	);
	expect(result.isError).toBe(false);

	expect(existsSync(dumpFile)).toBe(true);
	const argv: string[] = JSON.parse(
		readFileSync(dumpFile, "utf8").trim().split("\n")[0],
	);
	// 包装进程的 argv.slice(2) = ["--mode", "rpc", ...buildPiArgs]
	expect(argv[0]).toBe("--mode");
	expect(argv[1]).toBe("rpc");
	expect(argv).toContain("--no-session");
	const valueOf = (flag: string) => argv[argv.indexOf(flag) + 1];
	expect(valueOf("--model")).toBe("openai/gpt-4o");
	expect(valueOf("--thinking")).toBe("xhigh"); // max → xhigh 映射
	expect(valueOf("--tools")).toBe("read,grep");
	expect(valueOf("--name")).toBe("research");
	// systemPrompt 非空 → 写临时文件经 --system-prompt 传入
	expect(argv).toContain("--system-prompt");
});

test("thinking 映射：disabled → off；null → 不传 --thinking", async () => {
	const dumpFile = join(
		"/tmp",
		`wa-pi-argv-dump-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
	);
	tmpPaths.push(dumpFile);
	process.env.ARGV_DUMP_FILE = dumpFile;

	await runSubagentAgent(baseConfig({ thinking: "disabled" }), "任务", "/tmp", {
		cliPath: ARGV_DUMP_PI,
		runtime: RUNTIME,
	});
	await runSubagentAgent(baseConfig({ thinking: null }), "任务", "/tmp", {
		cliPath: ARGV_DUMP_PI,
		runtime: RUNTIME,
	});

	const lines = readFileSync(dumpFile, "utf8").trim().split("\n");
	const argv1: string[] = JSON.parse(lines[0]);
	const argv2: string[] = JSON.parse(lines[1]);
	expect(argv1[argv1.indexOf("--thinking") + 1]).toBe("off");
	expect(argv2).not.toContain("--thinking");
});

test("systemPrompt 为空 → 仍写临时文件并传 --system-prompt（自我保护段兜底注入）", async () => {
	const dumpFile = join(
		"/tmp",
		`wa-pi-argv-dump-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
	);
	tmpPaths.push(dumpFile);
	process.env.ARGV_DUMP_FILE = dumpFile;

	const result = await runSubagentAgent(
		baseConfig({ systemPrompt: "" }),
		"任务",
		"/tmp",
		{
			cliPath: ARGV_DUMP_PI,
			runtime: RUNTIME,
		},
	);
	expect(result.isError).toBe(false);

	expect(existsSync(dumpFile)).toBe(true);
	const argv: string[] = JSON.parse(
		readFileSync(dumpFile, "utf8").trim().split("\n")[0],
	);
	// 空提示词子代理也必须注入自我保护段（经 --system-prompt 传临时文件）
	expect(argv).toContain("--system-prompt");
});

test("进程异常（cliPath 指向不存在文件）→ isError=true 且不 throw", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: join(import.meta.dir, "fixtures", "no-such-pi.ts"),
		runtime: RUNTIME,
	});

	expect(result.isError).toBe(true);
	expect(result.text).toContain("子智能体");
});

test("遥测：fake-pi 支持 get_session_stats 时返回 usage 与 elapsedMs", async () => {
	const result = await runSubagentAgent(baseConfig(), "统计任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
	});

	expect(result.isError).toBe(false);
	expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
	expect(result.usage).toBeDefined();
	expect(result.usage!.tokens.output).toBe(250);
	expect(result.usage!.tokens.total).toBe(1750);
	expect(result.usage!.costTotal).toBeCloseTo(0.0042);
});

test("遥测降级：pi 不支持 get_session_stats（返回空 data）时 usage 为 undefined 且不报错", async () => {
	// argv-dump-pi 对未知命令回 success:true data:{} —— tokens 缺失 → usage 降级
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ARGV_DUMP_PI,
		runtime: RUNTIME,
	});

	expect(result.isError).toBe(false);
	expect(result.usage).toBeUndefined();
	expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});

// 回归：子代理 pi 进程卡死（永不发 agent_settled）时，runSubagentAgent 必须在
// commandTimeoutMs 后超时返回 isError，并 dispose 子进程（防泄漏 + 防 macOS SIGKILL）。
// 历史 bug：await settled 无超时 → 卡死时进程永不回收 → 累积超内存被 SIGKILL。
test("卡死超时：pi 永不 settle 时按 commandTimeoutMs 超时返回 isError 且不永久阻塞", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: HANG_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 1500, // 1.5s 超时（hang-pi 永不 settle）
	});
	expect(result.isError).toBe(true);
	expect(result.text).toContain("超时");
}, 10000); // 测试自身 10s 兜底（验证不永久阻塞）

test("abort 短路：子代理不响应 abort 时按 abortGraceMs 强制返回，不等 settle 超时", async () => {
	const ctrl = new AbortController();
	const startedAt = Date.now();
	// hang-pi 收到 abort RPC 只回 success、永不 settle（模拟卡在不可中断工具里）
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: HANG_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时故意拉长：验证不等它
		abortGraceMs: 300,
		signal: ctrl.signal,
	});
	await new Promise((r) => setTimeout(r, 200));
	ctrl.abort();
	const result = await resultP;
	expect(Date.now() - startedAt).toBeLessThan(5_000);
	expect(result.isError).toBe(true);
	expect(result.text).toContain("中止");
}, 10_000);

test("Infinity：commandTimeoutMs=Infinity 时正常 settle，不误判超时", async () => {
	const result = await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
		commandTimeoutMs: Infinity,
	});
	expect(result.isError).toBe(false);
	expect(result.text).toContain("回声:测试任务");
});

// 无进展探活：子代理进程存活但不发任何业务事件（hang-pi 发 agent_start 后永久静默）→
// idleTimeoutMs 后判死返回 isError（比 settle 超时更早发现卡死，不杀主代理）。
test("无进展探活：无任何业务事件超过 idleTimeoutMs 判死返回 isError", async () => {
	const startedAt = Date.now();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: HANG_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时故意拉长：验证探活先触发，不等它
		idleTimeoutMs: 400,
	});
	expect(result.isError).toBe(true);
	expect(result.text).toContain("无进展");
	expect(Date.now() - startedAt).toBeLessThan(10_000); // 远早于 60s settle 兑底
}, 10_000);

// 工具执行中豁免：子代理发 tool_execution_start 后长时间无事件（MCP HTTP 等待）→
// 探活不得判死；用户 abort 才终止。
const TOOL_EXEC_PI = join(import.meta.dir, "fixtures", "tool-exec-pi.ts");
test("工具执行中豁免：tool_execution_start 后静默不判死，abort 才终止", async () => {
	const ctrl = new AbortController();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_EXEC_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长
		idleTimeoutMs: 300, // 探活短阈值：验证豁免后不被判死
		abortGraceMs: 300,
		signal: ctrl.signal,
	});
	// 等待远超探活阈值（300ms）→ 工具执行中，探活应豁免不判死
	await new Promise((r) => setTimeout(r, 800));
	let returned = false;
	void resultP.then(() => {
		returned = true;
	});
	expect(returned).toBe(false); // 未返回：探活豁免生效
	ctrl.abort();
	const result = await resultP;
	expect(result.isError).toBe(true);
	expect(result.text).toContain("中止");
}, 10_000);
