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
const {
	runSubagentAgent,
	COMMAND_TIMEOUT_MS,
	LIVENESS_IDLE_MS,
	LIVENESS_TOOL_IDLE_MS,
} = (await import(REAL_RUNNER_SPEC)) as RunnerModule;

// 默认委派整体硬上限（RPC 命令超时 + settle 兕底共用）应为 2 小时
// （用户拍板 2026-08-31：单个子代理委派上限由 60 分钟增长到 2 小时，长任务 fleet 不再被 1h 误杀）
test("默认委派超时 COMMAND_TIMEOUT_MS 为 2 小时", () => {
	expect(COMMAND_TIMEOUT_MS).toBe(2 * 60 * 60_000);
});

// 默认无进展探活窗口：非工具执行（模型静默）2 分钟（用户拍板 2026-09-20，由 5 分钟收紧：
// 模型调用等不到首 token/流中断基本已挂死，不必白等）；工具执行中 20 分钟
// （静默长命令保护，见「工具执行中静默按工具窗口判死」用例）
test("默认探活窗口：非工具 2 分钟、工具执行中 20 分钟", () => {
	expect(LIVENESS_IDLE_MS).toBe(2 * 60_000);
	expect(LIVENESS_TOOL_IDLE_MS).toBe(20 * 60_000);
});

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");
const ARGV_DUMP_PI = join(import.meta.dir, "fixtures", "argv-dump-pi.ts");
const HANG_PI = join(import.meta.dir, "fixtures", "hang-pi.ts");
const RUNTIME = process.execPath;

const tmpPaths: string[] = [];
afterEach(() => {
	delete process.env.ARGV_DUMP_FILE;
	delete process.env.FAKE_EVENT_TYPE;
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
	// 首帧在任务启动时即发（产出为空）：前端据此立即渲染任务行，
	// 不然并行派发启动阶段（等各任务首个业务事件）会「任务行显示不全」
	expect(events[0]).toMatchObject({ status: "running", output: "", tools: [] });
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
	expect(argv).toContain("--offline");
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

// 工具执行中静默（tool_execution_start 后无任何事件，如输出重定向的长编译/MCP 等待）→
// 不再按基础窗口判死，改用独立的工具窗口（默认 20 分钟）：静默长命令完全可能十几分钟零事件，
// 基础窗口会误杀（2026-09-21 生产事故：98 分钟任务、347 次工具调用毁于最后一次长命令）。
// 仍保留判死：工具窗口内无任何事件基本已挂死，防卡死语义不变；
// 正常长工具持续发 tool_execution_update 流式输出刷新计时，不受影响。
const TOOL_EXEC_PI = join(import.meta.dir, "fixtures", "tool-exec-pi.ts");
test("工具执行中静默按工具窗口判死（默认 20 分钟，放宽误杀窗口）", async () => {
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_EXEC_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时故意拉长：验证探活先触发
		idleTimeoutMs: 400, // 基础窗口 400ms（工具执行中不适用）
		toolIdleTimeoutMs: 1_200, // 工具执行中窗口 1200ms
	});
	// 先挂返回监听（必须在 await 之前，否则 resolve 后注册回调丢失首帧）
	let returned = false;
	void resultP.then(() => {
		returned = true;
	});
	// 基础窗口（400ms）已过、工具窗口（1200ms）未到：放宽生效，不判死
	await new Promise((r) => setTimeout(r, 700));
	expect(returned).toBe(false);
	// 超过工具窗口：仍判死（防卡死语义保留）
	await new Promise((r) => setTimeout(r, 1_800));
	expect(returned).toBe(true);
	const result = await resultP;
	expect(result.isError).toBe(true);
	expect(result.text).toContain("无进展超时 (1200ms)");
}, 10_000);

// 工具执行中持续流式输出（tool_execution_update，如 bash 逐行输出）→ 有进展，不得判死。
// 背景：tool_execution_update 是长运行工具的 partialResult 流式事件（pi rpc.md）。
// 只要工具有输出，事件就会刷新 idle 计时；只有完全静默才判死。
const TOOL_EXEC_UPDATE_PI = join(
	import.meta.dir,
	"fixtures",
	"tool-exec-update-pi.ts",
);
test("工具执行中持续流式输出（tool_execution_update）→ 不算卡死，不判死", async () => {
	const ctrl = new AbortController();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_EXEC_UPDATE_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		idleTimeoutMs: 200, // 每 50ms 一个 update 刷新计时，远超 idle 也不判死
		abortGraceMs: 300,
		signal: ctrl.signal,
	});
	// 先挂返回监听（必须在 await 之前，否则 resolve 后注册回调丢失首帧）
	let returned = false;
	void resultP.then(() => {
		returned = true;
	});
	// 等待远超 idleTimeoutMs（200ms）：持续流式输出应不断刷新计时，不判死
	await new Promise((r) => setTimeout(r, 800));
	expect(returned).toBe(false); // 未返回：流式输出 = 有进展，探活不触发
	ctrl.abort();
	const result = await resultP;
	expect(result.isError).toBe(true);
	expect(result.text).toContain("中止");
}, 10_000);

// ===== 官方事件全集都必须刷新探活计时（防漏：漏一类事件就会在真实场景里误杀）=====
// pi 的 rpc 模式把会话事件流全量转发到 stdout（AgentSessionEvent 共 22 类），而 kernel 侧
// 的 RpcEvent 是开放类型（rpc-client.ts:45，type: string + 索引签名）→ switch 漏 case 没有
// 任何编译期提示。漏掉的后果（按 pi 源码逐个核对过的事件时序）：
//   - 压缩期间：摘要调用走 agent.streamFunction 并在内部消费完流，全程不发会话事件，
//     唯一会到达的是 compaction_start / summarization_retry_*（默认重试下静默 8~12 分钟）；
//   - 回合间隙：turn_end →（可能压缩）→ turn_start，压缩静默夹在中间；
//   - 首 token 之前：message_start 之后到第一个 delta 之间没有任何事件。
// 这些若不算「有进展」，默认 2 分钟窗口会把正常子代理判死（误杀）。
const LIVENESS_TOUCH_EVENTS = [
	// pi AgentSessionEvent 全量（agent_settled 除外：它本身会正常结束子代理）
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
	// kernel 由 extension_ui_request 合成的 5 类（rpc-client.ts:500-537）
	"extension_notify",
	"extension_status",
	"extension_widget",
	"extension_title",
	"extension_editor_text",
] as const;

const EVENT_STREAM_PI = join(import.meta.dir, "fixtures", "event-stream-pi.ts");

test("官方事件全量：任一类型持续到达都刷新探活（不漏一类，防误杀）", async () => {
	for (const type of LIVENESS_TOUCH_EVENTS) {
		process.env.FAKE_EVENT_TYPE = type;
		const ctrl = new AbortController();
		const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
			cliPath: EVENT_STREAM_PI,
			runtime: RUNTIME,
			commandTimeoutMs: 60_000,
			idleTimeoutMs: 120, // fixture 每 50ms 发一个事件：只有刷新计时才活得过该窗口
			toolIdleTimeoutMs: 120, // 工具窗口同样收紧，避免宽工具窗口掩盖缺失的刷新
			abortGraceMs: 150,
			signal: ctrl.signal,
		});
		// 先挂返回监听（必须在 await 之前）：判死会立刻 resolve，晚注册就丢首帧
		let returned: string | null = null;
		void resultP.then((r) => {
			returned = r.text;
		});
		await new Promise((r) => setTimeout(r, 350));
		expect(returned, `事件 ${type} 未刷新探活（被误判无进展）`).toBeNull();
		ctrl.abort();
		const result = await resultP;
		expect(result.text).toContain("中止");
	}
	delete process.env.FAKE_EVENT_TYPE;
}, 60_000);

// 工具结束后窗口回落：tool_execution_end 必须先复位 toolRunning、再刷新计时，
// 否则窗口会停在工具窗口（默认 20 分钟）上，工具跑完后的静默挂死迟迟不判。
const TOOL_END_IDLE_PI = join(import.meta.dir, "fixtures", "tool-end-idle-pi.ts");
test("工具结束后探活窗口回落到基础窗口（复位 toolRunning 后才刷新计时）", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_END_IDLE_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证由探活先判死
		idleTimeoutMs: 300, // 基础窗口 300ms
		toolIdleTimeoutMs: 5_000, // 工具窗口 5s：若窗口没回落，300ms 内不会判死
	});
	expect(result.isError).toBe(true);
	expect(result.text).toContain("无进展超时 (300ms)");
}, 10_000);
