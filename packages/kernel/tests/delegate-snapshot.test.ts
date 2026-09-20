// delegate-snapshot.test.ts — 用户主动停止时的中止快照落盘测试（kernel 侧修法 A）
//
// 背景：用户在父会话点停止 → pi 侧 bridge 流被 cancel，delegate/fleet 的 final 帧
// 无人消费（流已死）。修法 A：execute 在 abort 瞬间用内存进度组装 final 快照立即
// 落盘（pi 侧轮询窗口仅 abort 后 5 秒且只认 final，settle 收尾最长 10s 必然错过
// 窗口）、全部子任务 settle 后再用最终状态覆盖写同一文件
//（WA_PI_DIR/subagent-results/<toolCallId>.json），pi 侧 catch 分支轮询读取中转给
// 父模型（修法 B，见 bridge-extension.test.ts）。
//
// 覆盖：
// 1. delegate / fleet 中止：abort 瞬间快照立即为 final 且可读（不等 settle）、
//    settle 后最终状态覆盖更新；
// 2. abort 瞬间文本由最近进度事件组装（无进度事件则只有中止说明）；
// 3. 正常完成（无 abort）不落盘。
//
// 快照目录在调用时读取 process.env.WA_PI_DIR（非模块加载期），beforeAll 指向临时
// 目录实现测试隔离，afterAll 恢复原值并清理。

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTool, makeFleetTool } from "../src/delegate-tool";

const tmpRoot = mkdtempSync(join(tmpdir(), "wa-pi-snapshot-"));
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;

beforeAll(() => {
	process.env.WA_PI_DIR = tmpRoot;
});

afterAll(() => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	rmSync(tmpRoot, { recursive: true, force: true });
});

const askTo = [
	{ name: "代码审查", description: "评审改动" },
	{ name: "质量验收", description: "测试与验收" },
];

const snapshotPath = (toolCallId: string) =>
	join(tmpRoot, "subagent-results", `${toolCallId}.json`);

/** 轮询等待条件成立（abort 瞬间快照由监听器异步落盘，存在竞态） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (cond()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** 构造「abort 后经收尾耗时才 settle」的 spawn：模拟 kernel 侧宽限收尾路径
 * （settle 晚于 abort 瞬间快照落盘，保证两层快照时序可断言） */
function abortAwareSpawn(
	ctrl: AbortController,
	resultText: string,
	delayMs = 40,
) {
	return () =>
		new Promise<any>((resolve) => {
			ctrl.signal.addEventListener(
				"abort",
				() => {
					setTimeout(
						() =>
							resolve({
								text: resultText,
								isError: true,
								interrupted: true,
							}),
						delayMs,
					);
				},
				{ once: true },
			);
		});
}

test("delegate 中止：abort 瞬间快照立即为 final（不等 settle），settle 后覆盖更新", async () => {
	const ctrl = new AbortController();
	const tool = makeDelegateTool({
		askTo,
		// settle 延迟拉长到 200ms：确保第一层读到的是 abort 瞬间快照而非覆盖后的
		spawn: abortAwareSpawn(
			ctrl,
			"子智能体已被中止\n\n部分进度：工具调用 2 个（成功 1 / 失败 0 / 中断 1）。",
			200,
		),
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-d1", { agent: "代码审查", task: "任务" });
	// 模拟用户在父会话点停止（bridge-registry 触发调用级信号）
	setTimeout(() => ctrl.abort(), 15);

	// 第一层：abort 瞬间快照立即落盘且 phase=final（pi 侧轮询只认 final）
	const file = snapshotPath("snap-d1");
	expect(await waitFor(() => existsSync(file))).toBe(true);
	const immediate = JSON.parse(readFileSync(file, "utf8"));
	expect(immediate).toMatchObject({
		toolCallId: "snap-d1",
		tool: "delegate",
		phase: "final",
	});
	// 无进度事件：只有一句中止说明，但 text 可读、details 可消费
	expect(immediate.text).toContain("子智能体已被中止");
	expect(immediate.details).toEqual({ interrupted: true });

	// execute 返回（全部子任务 settle）后：最终状态覆盖同一文件（信息更全）
	const res = await exec;
	expect(res.details).toEqual({ interrupted: true });
	const final = JSON.parse(readFileSync(file, "utf8"));
	expect(final.phase).toBe("final");
	expect(final.tool).toBe("delegate");
	expect(final.text).toContain("部分进度");
	expect(final.details).toEqual({ interrupted: true });
});

test("delegate 中止即时快照：用最近进度事件组装部分进度文本", async () => {
	const ctrl = new AbortController();
	const tool = makeDelegateTool({
		askTo,
		spawn: abortAwareSpawn(ctrl, "子智能体已被中止"),
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-d2", { agent: "代码审查", task: "任务" });
	// 注册点经 notifyProgress 转发进度：工具 1 成功、工具 2 执行中
	(tool as any).notifyProgress?.("snap-d2", {
		agent: "代码审查",
		status: "running",
		output: "",
		tools: [
			{ id: "1", name: "bash", status: "done" },
			{ id: "2", name: "read", status: "running" },
		],
		elapsedMs: 5,
	});
	setTimeout(() => ctrl.abort(), 15);

	const file = snapshotPath("snap-d2");
	expect(await waitFor(() => existsSync(file))).toBe(true);
	const immediate = JSON.parse(readFileSync(file, "utf8"));
	expect(immediate.phase).toBe("final");
	// abort 瞬间用当时内存状态组装的部分进度文本（只报工具调用数量统计）
	expect(immediate.text).toContain(
		"部分进度：工具调用 2 个（成功 1 / 失败 0 / 中断 1）",
	);
	expect(immediate.text).not.toContain("已完成步骤");
	expect(immediate.text).not.toContain("bash ✅");
	expect(immediate.text).not.toContain("read ⏸");
	await exec;
});

test("fleet 中止：abort 瞬间 final 逐任务（中断）标题，settle 后覆盖为完整文本", async () => {
	const ctrl = new AbortController();
	const tool = makeFleetTool({
		askTo,
		spawn: abortAwareSpawn(ctrl, "子智能体已被中止"),
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-f1", {
		tasks: [
			{ agent: "代码审查", task: "a" },
			{ agent: "质量验收", task: "b" },
		],
	});
	setTimeout(() => ctrl.abort(), 15);

	const file = snapshotPath("snap-f1");
	expect(await waitFor(() => existsSync(file))).toBe(true);
	const immediate = JSON.parse(readFileSync(file, "utf8"));
	expect(immediate.phase).toBe("final");
	expect(immediate.tool).toBe("fleet");
	// abort 瞬间：每个子任务用瞬时状态组装，标题统一「（中断）」
	expect(immediate.text).toContain("【代码审查】（中断）");
	expect(immediate.text).toContain("【质量验收】（中断）");
	expect(immediate.details).toEqual({
		fleet: {},
		interrupted: { "0": true, "1": true },
	});

	await exec;
	const final = JSON.parse(readFileSync(file, "utf8"));
	expect(final.phase).toBe("final");
	expect(final.text).toContain("【代码审查】");
	expect(final.text).toContain("【质量验收】");
	expect(final.details).toEqual({
		fleet: {},
		interrupted: { "0": true, "1": true },
	});
});

test("正常完成（无 abort）不写快照文件", async () => {
	const tool = makeDelegateTool({
		askTo,
		spawn: async () => ({ text: "完成", isError: false }),
		getCallSignal: () => new AbortController().signal,
	});
	// 快照目录内容前后不变（顺序无关：同文件前面的中止测试可能已建目录）
	const resultsDir = join(tmpRoot, "subagent-results");
	const listDir = () => (existsSync(resultsDir) ? readdirSync(resultsDir).sort() : []);
	const before = listDir();
	const res = await tool.execute("snap-ok", { agent: "代码审查", task: "任务" });
	expect(res.details).toEqual({ interrupted: false });
	expect(existsSync(snapshotPath("snap-ok"))).toBe(false);
	expect(listDir()).toEqual(before);
});
