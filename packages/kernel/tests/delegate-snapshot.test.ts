// delegate-snapshot.test.ts — 用户主动停止时的中止快照落盘测试（kernel 侧修法 A）
//
// 背景：用户在父会话点停止 → pi 侧 bridge 流被 cancel，delegate 的 final 帧
// 无人消费（流已死）。修法 A：execute 在 abort 瞬间用内存进度组装 final 快照立即
// 落盘（pi 侧轮询窗口仅 abort 后 5 秒且只认 final，settle 收尾最长 10s 必然错过
// 窗口）、全部子任务 settle 后再用最终状态覆盖写同一文件
//（WA_PI_DIR/subagent-results/<toolCallId>.json），pi 侧 catch 分支轮询读取中转给
// 父模型（修法 B，见 bridge-extension.test.ts）。
//
// 覆盖：
// 1. delegate 中止：abort 瞬间快照立即为 final 且可读（不等 settle）、
//    settle 后最终状态覆盖更新；
// 2. abort 瞬间文本由最近进度事件组装（无进度事件则只有中止说明）；
// 3. 正常完成（无 abort）不落盘。
//
// 快照目录在调用时读取 process.env.WA_PI_DIR（非模块加载期），beforeAll 指向临时
// 目录实现测试隔离，afterAll 恢复原值并清理。

import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import type { SubagentDetails } from "@wa-pi/shared";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTool } from "../src/delegate-tool";
import { jsonlPath } from "../src/subagent-instance-store";
import * as subagentStore from "../src/subagent-instance-store";

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

/** 父会话 id（本期新增：子代理实例目录按父会话隔离，与本文件的快照目录同根） */
const SID = "s-delegate-snapshot";

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
		sessionId: SID,
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-d1", {
		tasks: [{ agent: "代码审查", task: "任务" }],
	});
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
	// 新形状（与正常完成同一套 XML）：status=interrupted，正文保留中止说明；
	// details.subagents[] 带**非空** agentId/jsonlPath（spawn 前已生成），
	// 前端据此渲染「查看全部内容」，主 agent 据此 resume。
	expect(immediate.text).toContain(
		"<type>代码审查</type><status>interrupted</status>",
	);
	expect(immediate.text).toContain("子智能体执行中断：子智能体已被中止");
	const immediateSa = immediate.details.subagents[0];
	expect(immediateSa).toMatchObject({
		taskIndex: 0,
		agent: "代码审查",
		subagentType: "代码审查",
		status: "interrupted",
		interrupted: true,
		resumed: false,
	});
	// 中断返回文本可被解析出 <agent_id>（主 agent resume 被中断实例的前提）
	const immediateAgentId = /<index>0<\/index><agent_id>(a[0-9a-f]{8})<\/agent_id>/.exec(
		immediate.text,
	)?.[1];
	expect(immediateAgentId).toBeTruthy();
	expect(immediateSa.agentId).toBe(immediateAgentId);
	expect(immediateSa.jsonlPath).toBe(jsonlPath(SID, immediateAgentId!));
	expect(immediate.text).toContain(
		`<transcript>${immediateSa.jsonlPath}</transcript>`,
	);
	expect(immediate.details.interrupted).toBe(true);

	// execute 返回（全部子任务 settle）后：最终状态覆盖同一文件（信息更全）
	const res = await exec;
	// 工具返回值走新形状（details.subagents）
	expect(res.details).toMatchObject({
		subagents: [
			{
				taskIndex: 0,
				agent: "代码审查",
				status: "interrupted",
				interrupted: true,
			},
		],
		interrupted: true,
	});
	const final = JSON.parse(readFileSync(file, "utf8"));
	expect(final.phase).toBe("final");
	expect(final.tool).toBe("delegate");
	expect(final.text).toContain("部分进度");
	// 覆盖写与 execute 返回值逐字一致（中断返回 = 正常完成的同一套 XML + details）
	expect(final.text).toBe(res.content[0].text);
	expect(final.details).toEqual(res.details);
});

test("delegate 中止即时快照：用最近进度事件组装部分进度文本", async () => {
	const ctrl = new AbortController();
	const tool = makeDelegateTool({
		askTo,
		spawn: abortAwareSpawn(ctrl, "子智能体已被中止"),
		sessionId: SID,
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-d2", {
		tasks: [{ agent: "代码审查", task: "任务" }],
	});
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
	// abort 瞬间用当时内存状态组装的部分进度文本（只报工具调用数量统计）；
	// 正文已 XML 转义后包在 <result> 里，断言只看内容本身
	expect(immediate.text).toContain(
		"部分进度：工具调用 2 个（成功 1 / 失败 0 / 中断 1）",
	);
	// 瞬时进度里的 toolStats 同步进新形状 details.subagents[]（前端行统计的数据源）
	expect(immediate.details.subagents[0].toolStats).toEqual({
		total: 2,
		done: 1,
		error: 0,
		running: 1,
	});
	expect(immediate.text).not.toContain("已完成步骤");
	expect(immediate.text).not.toContain("bash ✅");
	expect(immediate.text).not.toContain("read ⏸");
	await exec;
});

test("多任务中止：abort 瞬间 final 逐任务（中断）标题，settle 后覆盖为完整文本", async () => {
	const ctrl = new AbortController();
	const tool = makeDelegateTool({
		askTo,
		spawn: abortAwareSpawn(ctrl, "子智能体已被中止"),
		sessionId: SID,
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
	expect(immediate.tool).toBe("delegate");
	// abort 瞬间：每个子任务都用新形状 XML（status=interrupted），逐行独立
	expect(immediate.text).toContain(
		"<type>代码审查</type><status>interrupted</status>",
	);
	expect(immediate.text).toContain(
		"<type>质量验收</type><status>interrupted</status>",
	);
	expect(immediate.details.interrupted).toBe(true);
	expect(
		immediate.details.subagents.map(
			(s: { taskIndex: number; status: string; interrupted: boolean }) => [
				s.taskIndex,
				s.status,
				s.interrupted,
			],
		),
	).toEqual([
		[0, "interrupted", true],
		[1, "interrupted", true],
	]);

	const res = await exec;
	const final = JSON.parse(readFileSync(file, "utf8"));
	expect(final.phase).toBe("final");
	// 覆盖写与返回值逐字一致（两行都是同一套 XML，且都带各自的 agentId）
	expect(final.text).toBe(res.content[0].text);
	expect(final.details).toEqual(res.details);
});

test("正常完成（无 abort）不写快照文件", async () => {
	const tool = makeDelegateTool({
		askTo,
		spawn: async () => ({ text: "完成", isError: false }),
		sessionId: SID,
		getCallSignal: () => new AbortController().signal,
	});
	// 快照目录内容前后不变（顺序无关：同文件前面的中止测试可能已建目录）
	const resultsDir = join(tmpRoot, "subagent-results");
	const listDir = () => (existsSync(resultsDir) ? readdirSync(resultsDir).sort() : []);
	const before = listDir();
	const res = await tool.execute("snap-ok", {
		tasks: [{ agent: "代码审查", task: "任务" }],
	});
	// 新形状：正常完成 → status completed、整条 interrupted 为 false
	expect(res.details).toMatchObject({
		subagents: [
			{
				taskIndex: 0,
				agent: "代码审查",
				status: "completed",
				interrupted: false,
			},
		],
		interrupted: false,
	});
	expect(existsSync(snapshotPath("snap-ok"))).toBe(false);
	expect(listDir()).toEqual(before);
});

// 边界（要求 6）：任务在生成 agentId 之前就被中断（abort 先于派发 / 越权早退 / 配置解析失败）
// → 该行按空 agentId/空 transcript 的降级形状处理，**绝不伪造 id**（前端双非空门控自然不给入口）。
// 构造即已中止：此刻两个 thunk 都还没跑到 id 生成点，即时快照里两行的实例信息必然为空。
test("中止先于派发：未生成 agentId 的任务在快照里留空降级（不伪造）", async () => {
	const ctrl = new AbortController();
	ctrl.abort();
	const tool = makeDelegateTool({
		askTo,
		// settle 延迟 200ms：留出窗口读到 abort 瞬间的即时快照（空 id）而非覆盖后的终态
		spawn: () =>
			new Promise<any>((resolve) =>
				setTimeout(
					() =>
						resolve({
							text: "子智能体已被中止",
							isError: true,
							interrupted: true,
						}),
					200,
				),
			),
		sessionId: SID,
		getCallSignal: () => ctrl.signal,
	});

	const exec = tool.execute("snap-early", {
		tasks: [
			{ agent: "代码审查", task: "a" },
			{ agent: "质量验收", task: "b" },
		],
	});
	const file = snapshotPath("snap-early");
	expect(await waitFor(() => existsSync(file))).toBe(true);
	const immediate = JSON.parse(readFileSync(file, "utf8"));
	expect(immediate.phase).toBe("final");
	// 字段齐全但身份为空串：形状与新返回块一致，只是没有可查的转录
	expect(immediate.details.subagents).toHaveLength(2);
	for (const sa of immediate.details.subagents) {
		expect(sa).toMatchObject({ status: "interrupted", interrupted: true });
		expect(sa.agentId).toBe("");
		expect(sa.jsonlPath).toBe("");
	}
	expect(immediate.text).toContain("<agent_id></agent_id>");
	expect(immediate.text).toContain("<transcript></transcript>");
	await exec;
});

// 回归（审查发现 1）：meta 写盘失败时 jsonl 必须已经降级为空**再登记实例**——否则返回块
// 已给空串（正确），即时快照（bridge 读走、落进会话、前端实际渲染的那一份）却仍宣告非空
// jsonlPath → 前端双非空门控放行 → 用户点「查看全部内容」拿到 404。
// 构造：mkdir 照常成功（目录可建），只让 writeMeta 抛错——精确命中「jsonl 被 meta 降级」这条路径。
test("meta 写盘失败：即时快照里该任务的 jsonlPath 降级为空（不宣告必然 404 的转录）", async () => {
	const ctrl = new AbortController();
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	// writeMeta 是模块命名空间上的函数：delegate-tool 调用时按属性取值，spy 生效（用后必须还原）
	const writeSpy = spyOn(subagentStore, "writeMeta").mockRejectedValue(
		new Error("磁盘满"),
	);
	try {
		const tool = makeDelegateTool({
			askTo: askTo,
			// settle 延迟 200ms：留出窗口读到 abort 瞬间的即时快照（而非覆盖后的终态）
			spawn: abortAwareSpawn(ctrl, "子智能体已被中止", 200),
			sessionId: SID,
			getCallSignal: () => ctrl.signal,
		});

		const exec = tool.execute("snap-metafail", {
			tasks: [{ agent: "代码审查", task: "任务" }],
		});
		setTimeout(() => ctrl.abort(), 15);

		const file = snapshotPath("snap-metafail");
		expect(await waitFor(() => existsSync(file))).toBe(true);
		const immediate = JSON.parse(readFileSync(file, "utf8"));
		const sa = immediate.details.subagents[0];
		expect(sa.status).toBe("interrupted");
		// 身份真实生成（不是早退路径），但路径必须为空：前端门控据此不给入口
		expect(sa.agentId).toMatch(/^a[0-9a-f]{8}$/);
		expect(sa.jsonlPath).toBe("");
		expect(immediate.text).toContain("<transcript></transcript>");

		// settle 后的返回块与即时快照同源：两处都不宣告不存在的转录
		const res = await exec;
		expect((res.details as SubagentDetails).subagents[0]!.jsonlPath).toBe("");
	} finally {
		writeSpy.mockRestore();
		warn.mockRestore();
	}
});
