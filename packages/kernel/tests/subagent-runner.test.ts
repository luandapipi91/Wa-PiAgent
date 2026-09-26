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
	LIVENESS_FALLBACK_MS,
	PROBE_INTERVAL_MS,
	PROBE_TIMEOUT_MS,
} = (await import(REAL_RUNNER_SPEC)) as RunnerModule;

// 默认委派整体硬上限（RPC 命令超时 + settle 兕底共用）应为 2 小时
// （用户拍板 2026-08-31：单个子代理委派上限由 60 分钟增长到 2 小时，长任务 fleet 不再被 1h 误杀）
test("默认委派超时 COMMAND_TIMEOUT_MS 为 2 小时", () => {
	expect(COMMAND_TIMEOUT_MS).toBe(2 * 60 * 60_000);
});

// 默认无进展探活窗口：非工具执行（模型静默）2 分钟（用户拍板 2026-09-20，由 5 分钟收紧：
// 模型调用等不到首 token/流中断基本已挂死，不必白等）；工具执行中 20 分钟
// （静默长命令保护，见「工具执行中静默按工具窗口判死」用例）
test("默认探活参数：事件兜底 30 分钟 / 探活每 5 秒一次 / 单次超时 30 秒（一次失败即判死）", () => {
	expect(LIVENESS_FALLBACK_MS).toBe(30 * 60_000);
	expect(PROBE_INTERVAL_MS).toBe(5_000);
	expect(PROBE_TIMEOUT_MS).toBe(30_000);
});

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
	// 首帧在任务启动时即发（产出为空）：前端据此立即渲染任务行，
	// 不然并行派发启动阶段（等各任务首个业务事件）会「任务行显示不全」
	expect(events[0]).toMatchObject({ status: "running", output: "", tools: [] });
	expect(events.some((e) => e.status === "running")).toBe(true);
	expect(events.at(-1)?.status).toBe("done");
	expect(events.every((e) => e.agent === "research")).toBe(true);
});

// 回归（2026-09-23「运行中 · 153s」）：进度事件必须携带绝对起点 startedAtMs。
// 静默期（长工具）只剩最后一次推送的相对 elapsedMs，前端卡片重挂载后若按过期
// 相对值重推起点，计时会回跳（实际 26 分钟仍显示 153s）。绝对起点随事件下发后
// 前端用 store 里的事件即可恢复正确起点；所有事件必须同源（同一个 startedAt）。
test("进度事件携带绝对起点 startedAtMs 且全部同源", async () => {
	const events: SubagentProgressEvent[] = [];
	const before = Date.now();
	await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
		onProgress: (e) => events.push(e),
	});
	expect(events.length).toBeGreaterThan(0);
	for (const e of events) {
		expect(typeof e.startedAtMs).toBe("number");
		// 起点必须在「发起前 → 现在」区间内（它就是 runner 的 startedAt）
		expect(e.startedAtMs!).toBeGreaterThanOrEqual(before);
		expect(e.startedAtMs!).toBeLessThanOrEqual(Date.now());
	}
	// 全部事件同源：同一子代理的 startedAt 唯一
	expect(new Set(events.map((e) => e.startedAtMs)).size).toBe(1);
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
	// 对外文案（用户指定）：不暴露内部毫秒数与内部机制名，直接告知「超过时限已自动终止」
	expect(result.text).toContain(
		"子智能体执行失败: 子智能体超过2小时时限，已自动终止。",
	);
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

// ── 探活机制（2026-09-23 改版）──────────────────────────────────────────────
// 旧实现是「事件驱动的窗口」：非工具 2 分钟 / 工具执行中 20 分钟，任一 tool_execution_end
// 就把窗口拉回基础值。但 pi 的工具执行期没有心跳（零输出命令期间零事件），并行批次里短命令
// 先结束还会吃掉长命令的余量 —— 正常的长静默命令被误杀。新实现拆成两把互补的尺：
//   1) get_state 探活：收到 RPC 事件后开始，每 PROBE_INTERVAL_MS 发一次 get_state（同时只
//      允许一个在途），单次超时即算失败、成功即归零，连续 PROBE_MAX_FAILURES 次失败 → 判死。
//      依据：pi 的 stdin 是逐行 fire-and-forget 分派（rpc-mode.js），工具执行是异步子进程，
//      所以工具执行期 get_state 仍会即刻回包；不回包即“进程/通道已僵死”。
//   2) 事件兜底：距上一次事件超过 LIVENESS_FALLBACK_MS（30 分钟）→ 判死。不区分是否工具
//      执行中；成功探活不续命（否则工具僵死无人管）。
const TOOL_EXEC_PI = join(import.meta.dir, "fixtures", "tool-exec-pi.ts");
const TOOL_EXEC_UPDATE_PI = join(import.meta.dir, "fixtures", "tool-exec-update-pi.ts");
const PROBE_SILENT_PI = join(import.meta.dir, "fixtures", "probe-silent-pi.ts");
const PROBE_FAIL_PI = join(import.meta.dir, "fixtures", "probe-fail-pi.ts");
const PROBE_FAIL_SILENT_PI = join(
	import.meta.dir,
	"fixtures",
	"probe-fail-silent-pi.ts",
);
const PROBE_FAIL_ONCE_PI = join(
	import.meta.dir,
	"fixtures",
	"probe-fail-once-pi.ts",
);

// 工具执行中零输出长静默（如输出重定向的长编译）+ 探活正常 → 不判死。
// 旧实现会在这里按 2 分钟/20 分钟窗口误杀，正是本次要修掉的误杀。
test("工具执行中零输出长静默 + 探活正常 → 不判死（旧工具窗口误杀已消除）", async () => {
	const ctrl = new AbortController();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_EXEC_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 10_000, // 兜底远未到：判死只能来自旧窗口机制
		probeIntervalMs: 100,
		abortGraceMs: 200,
		signal: ctrl.signal,
	});
	// 先挂返回监听（必须在 await 之前，否则 resolve 后注册回调丢失首帧）
	let returned = false;
	void resultP.then(() => {
		returned = true;
	});
	// 工具已 start 且此后零事件：1 秒内不得判死
	await new Promise((r) => setTimeout(r, 1_000));
	expect(returned).toBe(false);
	ctrl.abort();
	const result = await resultP;
	expect(result.text).toContain("中止");
}, 10_000);

// 探活失败：pi 对 get_state 回 success:false（命令层面报错）→ 一次失败即判死强杀。
test("探活失败：get_state 报错 → 判死（强杀）", async () => {
	const startedAt = Date.now();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: PROBE_FAIL_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证探活先触发
		livenessFallbackMs: 60_000, // 兜底远未到：必须是探活判的死
		probeIntervalMs: 150,
	});
	expect(result.isError).toBe(true);
	// 对外文案只报「执行过程中中断」：探活 / get_state / 毫秒数等内部细节不进结果文本
	expect(result.text).toBe("子智能体执行失败: 子智能体执行过程中中断");
	expect(result.text).not.toContain("探活");
	expect(result.text).not.toContain("get_state");
	expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 10_000);

// 单次失败即判死（不做连续计数）：只让第一次 get_state 失败、之后都正常。
// 若保留连续计数，第二次成功会归零 → 永不判死；单次判定则第一次失败即强杀。
test("探活单次失败即判死：首次 get_state 报错就强杀（不累计、不等待重试）", async () => {
	const startedAt = Date.now();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: PROBE_FAIL_ONCE_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 60_000, // 兜底远未到：判死只能来自探活
		probeIntervalMs: 150,
		probeTimeoutMs: 100,
	});
	expect(result.isError).toBe(true);
	expect(result.text).toBe("子智能体执行失败: 子智能体执行过程中中断");
	expect(Date.now() - startedAt).toBeLessThan(5_000);
}, 10_000);

// 探活超时：pi 不回 get_state → 单次等待上限（默认 30 秒；测试用 200ms）到期即判死。
// 默认 30 秒是为了容忍短暂挂起（实测尖峰 ≤1.9s，启动期 3.75s）。
test("探活超时：不回 get_state 单次到期 → 判死（强杀）", async () => {
	const startedAt = Date.now();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: PROBE_SILENT_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证探活先触发
		livenessFallbackMs: 60_000, // 兜底远未到：必须是探活判的死
		probeIntervalMs: 100,
		probeTimeoutMs: 200,
	});
	expect(result.isError).toBe(true);
	expect(result.text).toBe("子智能体执行失败: 子智能体执行过程中中断");
	expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 10_000);

// 探活自启动即开始（不等 RPC 事件）：pi 只回命令响应、一个事件都不发时，探活照样在跑
// ——该 fixture 的 get_state 回 success:false，连续 3 次即判死。
test("探活自启动即生效：pi 不发任何事件也会被探活检出 → 判死", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: PROBE_FAIL_SILENT_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 60_000, // 兜底远未到
		probeIntervalMs: 150,
		probeTimeoutMs: 100,
	});
	expect(result.isError).toBe(true);
	expect(result.text).toBe("子智能体执行失败: 子智能体执行过程中中断");
}, 10_000);

// 事件兜底：距上次事件超过窗口 → 判死。hang-pi 发 agent_start 后永久静默但正常回 get_state
// → 探活一直成功，仍必须判死（工具僵死靠兜底检出，成功探活不续命）。
test("事件兜底：距上次事件超过窗口 → 判死（探活成功也不续命）", async () => {
	const startedAt = Date.now();
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: HANG_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 400,
		probeIntervalMs: 100,
	});
	expect(result.isError).toBe(true);
	expect(result.text).toContain("无进展超时 (400ms)");
	expect(Date.now() - startedAt).toBeLessThan(10_000);
}, 10_000);

// 事件持续到达（tool_execution_update 流式输出）→ 不断刷新兜底，不判死。
test("事件持续到达（tool_execution_update）不断刷新兜底 → 不判死", async () => {
	const ctrl = new AbortController();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: TOOL_EXEC_UPDATE_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000,
		livenessFallbackMs: 200, // 每 50ms 一个 update，远超兜底窗口也不判死
		probeIntervalMs: 100,
		abortGraceMs: 300,
		signal: ctrl.signal,
	});
	let returned = false;
	void resultP.then(() => {
		returned = true;
	});
	await new Promise((r) => setTimeout(r, 800));
	expect(returned).toBe(false);
	ctrl.abort();
	const result = await resultP;
	expect(result.text).toContain("中止");
}, 10_000);
