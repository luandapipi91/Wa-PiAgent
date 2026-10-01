// delegate 转录落盘 + agentId + XML 返回 + details.subagents（任务 5）
//
// 覆盖四件事：
// 1. 格式化纯函数：耗时（秒/分秒）与 token 缩写；
// 2. renderSubagentBlock 的 XML 定稿形状（规格 §7）：标签同行紧凑、全字段保留、
//    <agent_id> 与 <transcript> 都是独立子元素、<result> 换行包裹正文；
// 3. execute 全链路：spawn 前生成 agentId 并写 meta(running) → spawn 收到
//    <WA_PI_DIR>/subagents/<父会话 id>/<agentId>.jsonl 路径 → 结束后写终态 meta；
//    返回块与 details.subagents[] 双通道一致（文本给主 agent，details 给前端）；
// 4. makeSpawnFn：sessionFile 透传到 runSubagentAgent，进度事件带 agentId。
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { SubagentDetails } from "@wa-pi/shared";
import {
	formatElapsedShort,
	formatTokensShort,
	makeDelegateTool,
	makeSpawnFn,
	renderSubagentBlock,
} from "../src/delegate-tool";
import { jsonlPath, readMeta, subagentDir } from "../src/subagent-instance-store";
import type { SubagentMeta } from "../src/subagent-instance-store";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const askTo = [
	{ name: "代码审查", description: "评审改动" },
	{ name: "质量验收", description: "测试与验收" },
];

/** 从返回文本里取某个任务的 agentId（按 <index> 定位，避免多项时串位） */
function agentIdOf(text: string, index: number): string {
	const m = new RegExp(
		`<index>${index}</index><agent_id>([^<]*)</agent_id>`,
	).exec(text);
	if (!m) throw new Error(`返回文本里找不到 index=${index} 的 agent_id：${text}`);
	return m[1]!;
}

/** 从返回文本里取某个任务的转录路径 */
function transcriptOf(text: string, index: number): string {
	const m = new RegExp(
		`<index>${index}</index>[\\s\\S]*?<transcript>([^<]*)</transcript>`,
	).exec(text);
	if (!m) throw new Error(`返回文本里找不到 index=${index} 的 transcript：${text}`);
	return m[1]!;
}

const usage = {
	tokens: {
		input: 300,
		output: 130,
		cacheRead: 1000,
		cacheWrite: 0,
		total: 1430,
	},
	costTotal: 0.01,
};

describe("耗时 / 用量格式化", () => {
	test("秒与分秒", () => {
		expect(formatElapsedShort(32_000)).toBe("32s");
		expect(formatElapsedShort(95_000)).toBe("1m35s");
		expect(formatElapsedShort(3_600_000)).toBe("60m0s");
	});
	test("token 缩写", () => {
		expect(formatTokensShort(950)).toBe("950");
		expect(formatTokensShort(8_100)).toBe("8.1k");
		expect(formatTokensShort(24_300)).toBe("24.3k");
		expect(formatTokensShort(undefined)).toBe("?");
	});
});

describe("XML 块渲染（规格 §7 定稿形状）", () => {
	test("紧凑同行、全字段、agent_id 与 transcript 为独立子元素", () => {
		const s = renderSubagentBlock({
			taskIndex: 0,
			agentId: "a3f8c1d0a",
			subagentType: "Explore",
			status: "completed",
			elapsedMs: 32_000,
			totalTokens: 8_100,
			resumed: false,
			jsonlPath: "C:/x/subagents/sid/a3f8c1d0a.jsonl",
			text: "结论第一行\n结论第二行",
		});
		expect(s).toBe(
			'<subagent><index>0</index><agent_id>a3f8c1d0a</agent_id><type>Explore</type>' +
				"<status>completed</status><elapsed>32s</elapsed><tokens>8.1k</tokens>" +
				"<resumed>false</resumed>" +
				"<transcript>C:/x/subagents/sid/a3f8c1d0a.jsonl</transcript><result>\n" +
				"结论第一行\n结论第二行\n</result></subagent>",
		);
	});
	test("缺省耗时/用量降级为 0s / ?，块本身仍以 </subagent> 收尾", () => {
		const s = renderSubagentBlock({
			taskIndex: 2,
			agentId: "",
			subagentType: "陌生人",
			status: "failed",
			resumed: false,
			jsonlPath: "",
			text: "错误：不在可调起列表中",
		});
		expect(s).toBe(
			'<subagent><index>2</index><agent_id></agent_id><type>陌生人</type>' +
				"<status>failed</status><elapsed>0s</elapsed><tokens>?</tokens><resumed>false</resumed>" +
				"<transcript></transcript><result>\n错误：不在可调起列表中\n</result></subagent>",
		);
		expect(s.endsWith("</subagent>")).toBe(true);
	});

	test("<result> 正文与 <type> 做 XML 转义（正文含代码/标签字面串也不破坏结构）", () => {
		// 子代理正文是任意文本，报告常引用 <subagent> / </result> 等标签字面串；
		// 不转义会提前闭合结构，破环多项单换行拼接（主 agent 与按标记切分的消费方读错）
		const s = renderSubagentBlock({
			taskIndex: 0,
			agentId: "a3f8c1d0a",
			subagentType: "a<b&c",
			status: "completed",
			resumed: false,
			jsonlPath: "",
			text: "引用 </result> 与 <subagent> 标签 & 使用 a && b",
		});
		// 先转 & 再转 <：不出现二次转义（&lt; 不得变成 &amp;lt;）；`>` 按约定不转义
		expect(s).toContain(
			"<result>\n引用 &lt;/result> 与 &lt;subagent> 标签 &amp; 使用 a &amp;&amp; b\n</result>",
		);
		// 动态取值同理（越权项会把请求名原样塞进 <type>）
		expect(s).toContain("<type>a&lt;b&amp;c</type>");
		// 结构字符不被转义：块仍以 </subagent> 收尾，正文里的 </result> 未提前闭合
		expect(s.endsWith("</subagent>")).toBe(true);
		expect(s.split("</result>")).toHaveLength(2);
	});
});

describe("execute：身份、落盘与返回块", () => {
	test("spawn 收到 <父会话 id>/<agentId>.jsonl 路径；返回块与 details.subagents 一致", async () => {
		const SID = "s-transcript-fields";
		const seen: Array<{ agent: string; sessionFile?: string }> = [];
		const spawn = mock(
			async (
				agent: string,
				_task: string,
				_tc: string,
				_index?: number,
				sessionFile?: string,
			) => {
				seen.push({ agent, sessionFile });
				return { text: "结论第一行\n结论第二行", isError: false, elapsedMs: 32_000, usage };
			},
		);
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-fields", {
			tasks: [{ agent: "代码审查", task: "评审改动" }],
		});

		const text = res.content[0].text;
		const agentId = agentIdOf(text, 0);
		const transcript = transcriptOf(text, 0);
		// agentId 形如 a + 8 位 hex；转录路径就是 subagent-instance-store 算出的那份
		expect(agentId).toMatch(/^a[0-9a-f]{8}$/);
		expect(transcript).toBe(jsonlPath(SID, agentId));
		expect(seen[0]!.sessionFile).toBe(transcript);
		// 归一化后的类型传给 spawn（中文别名不影响）
		expect(seen[0]!.agent).toBe("代码审查");
		// 返回块：XML、标签同行、全字段（tokens 由 usage.total 缩写得来）
		expect(text).toBe(
			`<subagent><index>0</index><agent_id>${agentId}</agent_id><type>代码审查</type>` +
				"<status>completed</status><elapsed>32s</elapsed><tokens>1.4k</tokens>" +
				"<resumed>false</resumed>" +
				`<transcript>${transcript}</transcript><result>\n结论第一行\n结论第二行\n</result></subagent>`,
		);

		// details.subagents[]（前端唯一数据来源，不解析文本）
		const details = res.details as SubagentDetails;
		expect(details.interrupted).toBe(false);
		expect(details.subagents).toHaveLength(1);
		expect(details.subagents[0]).toMatchObject({
			taskIndex: 0,
			agentId,
			agent: "代码审查",
			subagentType: "代码审查",
			resumed: false,
			status: "completed",
			elapsedMs: 32_000,
			usage,
			interrupted: false,
		});
	});

	test("多项之间用单换行连接（不出现空行分隔）", async () => {
		const SID = "s-transcript-multi";
		const spawn = mock(async (agent: string) => ({
			text: `${agent}完成`,
			isError: false,
			elapsedMs: 1000,
		}));
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-multi", {
			tasks: [
				{ agent: "代码审查", task: "a" },
				{ agent: "质量验收", task: "b" },
			],
		});
		const text = res.content[0].text;
		expect(text.startsWith("<subagent>")).toBe(true);
		expect(text.endsWith("</subagent>")).toBe(true);
		expect(text.split("</subagent>\n<subagent>")).toHaveLength(2);
		expect(text).not.toContain("</subagent>\n\n<subagent>");
		// 两个任务各自独立实例（agentId 不重复）
		expect(agentIdOf(text, 0)).not.toBe(agentIdOf(text, 1));
	});

	test("meta：spawn 前 running、spawn 后终态 + 扁平 usage + elapsedMs/toolStats", async () => {
		const SID = "s-transcript-meta";
		// 用可变容器记录 spawn 期间读到的 meta（闭包内赋值，避免 TS 把它窄化成 null）
		const seen: { running?: SubagentMeta | null } = {};
		const spawn = mock(
			async (
				_agent: string,
				_task: string,
				_tc: string,
				_index?: number,
				sessionFile?: string,
			) => {
				// spawn 期间 meta 必须是 running（resume 据此拒绝并发续写同一 jsonl）
				const id = /([^\\/]+)\.jsonl$/.exec(sessionFile!)?.[1];
				seen.running = id ? await readMeta(SID, id) : null;
				return {
					text: "完成",
					isError: false,
					elapsedMs: 12_345,
					toolStats: { total: 3, done: 2, error: 1, running: 0 },
					usage,
				};
			},
		);
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-meta", {
			tasks: [{ agent: "探索子智能体", task: "看看目录" }],
		});
		const agentId = agentIdOf(res.content[0].text, 0);

		expect(seen.running?.status).toBe("running");
		expect(seen.running?.agentId).toBe(agentId);

		const meta = await readMeta(SID, agentId);
		expect(meta).toMatchObject({
			agentId,
			parentSessionId: SID,
			toolCallId: "tc-meta",
			taskIndex: 0,
			// 中文别名归一化后的实际类型 + 原始请求名各存一份
			subagentType: "Explore",
			requestedAgent: "探索子智能体",
			task: "看看目录",
			status: "completed",
			resumeCount: 0,
			elapsedMs: 12_345,
			toolStats: { total: 3, done: 2, error: 1, running: 0 },
			// usage 落盘为扁平结构（input/output/cacheRead/cacheWrite/total + costTotal）
			usage: {
				input: 300,
				output: 130,
				cacheRead: 1000,
				cacheWrite: 0,
				total: 1430,
				costTotal: 0.01,
			},
		});
		expect(meta!.createdAt).toBeGreaterThan(0);
		expect(meta!.updatedAt).toBeGreaterThanOrEqual(meta!.createdAt);
	});

	test("meta 终态与返回 status 对齐：失败→failed、中断→interrupted", async () => {
		const SID = "s-transcript-status";
		const spawn = mock(async (agent: string): Promise<any> => {
			if (agent === "质量验收")
				return { text: "断言失败", isError: true, elapsedMs: 500 };
			return {
				text: "子智能体已被中止",
				isError: true,
				interrupted: true,
				elapsedMs: 700,
			};
		});
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-status", {
			tasks: [
				{ agent: "质量验收", task: "跑测试" },
				{ agent: "Explore", task: "探索" },
			],
		});
		const text = res.content[0].text;
		expect(text).toContain("<index>0</index>");
		expect(text).toContain("<status>failed</status>");
		expect(text).toContain("<status>interrupted</status>");
		// 中断块带部分进度说明（沿用 subagent-runner 的收尾文案）
		expect(text).toContain("子智能体已被中止");

		const details = res.details as SubagentDetails;
		expect(details.subagents.map((s) => s.status)).toEqual([
			"failed",
			"interrupted",
		]);
		expect(details.subagents.map((s) => s.interrupted)).toEqual([false, true]);
		expect(details.interrupted).toBe(true);
		expect(res.isError).toBe(true);

		expect((await readMeta(SID, agentIdOf(text, 0)))?.status).toBe("failed");
		expect((await readMeta(SID, agentIdOf(text, 1)))?.status).toBe("interrupted");
	});

	test("spawn 抛异常：meta 不留 running（收尾为 interrupted），其余任务不受影响", async () => {
		const SID = "s-transcript-throw";
		const spawn = mock(async (_agent: string, task: string): Promise<any> => {
			if (task === "崩") throw new Error("配置读取崩溃");
			return { text: "ok", isError: false, elapsedMs: 1 };
		});
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-throw", {
			tasks: [
				{ agent: "代码审查", task: "崩" },
				{ agent: "质量验收", task: "正常" },
			],
		});
		const text = res.content[0].text;
		expect(text).toContain("配置读取崩溃");
		expect((await readMeta(SID, agentIdOf(text, 0)))?.status).toBe("interrupted");
		expect((await readMeta(SID, agentIdOf(text, 1)))?.status).toBe("completed");
		expect(res.isError).toBe(true);
	});

	test("越权任务不建实例：agent_id / transcript 留空，且没有落盘目录", async () => {
		const SID = "s-transcript-notallow";
		const spawn = mock(async () => ({ text: "不应被调用", isError: false }));
		const tool = makeDelegateTool({ askTo, spawn, sessionId: SID });
		const res = await tool.execute("tc-notallow", {
			tasks: [{ agent: "陌生人", task: "x" }],
		});
		const text = res.content[0].text;
		expect(spawn).not.toHaveBeenCalled();
		expect(text).toContain(
			"<agent_id></agent_id><type>陌生人</type><status>failed</status>",
		);
		expect(text).toContain("<transcript></transcript>");
		expect(text).toContain("不在可调起列表");
		// 无实例 = 无 meta 目录（该会话 id 只在本用例使用）
		expect(existsSync(subagentDir(SID))).toBe(false);
		expect((res.details as SubagentDetails).subagents[0]!.agentId).toBe("");
	});

	test("非法父会话 id：jsonlPath 抛错不阻断派发，<transcript> 给空串（不宣告不存在路径）", async () => {
		// 既有防线：jsonlPath（assertSessionId）对非法父会话 id 抛错——此前无测试覆盖。
		// 契约：不抛异常、不阻断 spawn、<transcript> 为空（降级为不落盘），且有告警（不静默）
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const seen: Array<string | undefined> = [];
			const spawn = mock(
				async (
					_agent: string,
					_task: string,
					_tc: string,
					_index?: number,
					sessionFile?: string,
				) => {
					seen.push(sessionFile);
					return { text: "ok", isError: false, elapsedMs: 1 };
				},
			);
			const tool = makeDelegateTool({ askTo, spawn, sessionId: "bad/../id" });
			const res = await tool.execute("tc-bad-sid", {
				tasks: [{ agent: "代码审查", task: "x" }],
			});
			expect(res.isError).toBe(false);
			expect(transcriptOf(res.content[0].text, 0)).toBe("");
			expect(res.content[0].text).toContain("<transcript></transcript>");
			// 派发不受阻：spawn 仍被调用，只是拿到空路径（走 --no-session）
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(seen[0]).toBe("");
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("转录目录创建失败：不阻断派发，<transcript> 给空串并有告警", async () => {
		// 让 WA_PI_DIR 指向一个「文件」→ mkdir(dirname(jsonl)) 必然失败（ENOTDIR），
		// 验证 spawn 前显式建目录失败时降级为不落盘（而非宣告一条不存在的 <transcript>）
		const rootTmp = mkdtempSync(join(tmpdir(), "wa-pi-delegate-mkdirfail-"));
		const notADir = join(rootTmp, "not-a-dir");
		writeFileSync(notADir, "x");
		const prevDir = process.env.WA_PI_DIR;
		process.env.WA_PI_DIR = notADir;
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const seen: Array<string | undefined> = [];
			const spawn = mock(
				async (
					_agent: string,
					_task: string,
					_tc: string,
					_index?: number,
					sessionFile?: string,
				) => {
					seen.push(sessionFile);
					return { text: "ok", isError: false };
				},
			);
			const tool = makeDelegateTool({ askTo, spawn, sessionId: "s-transcript-mkdir-fail" });
			const res = await tool.execute("tc-mkdir-fail", {
				tasks: [{ agent: "代码审查", task: "x" }],
			});
			expect(res.isError).toBe(false);
			expect(transcriptOf(res.content[0].text, 0)).toBe("");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(seen[0]).toBe("");
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			if (prevDir === undefined) delete process.env.WA_PI_DIR;
			else process.env.WA_PI_DIR = prevDir;
			rmSync(rootTmp, { recursive: true, force: true });
		}
	});
});

describe("makeSpawnFn：转录路径与进度事件", () => {
	const baseConfig = () => ({
		name: "Explore",
		description: "",
		systemPrompt: "",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	});

	test("sessionFile 透传给 runSubagentAgent（pi --session 落盘开关）", async () => {
		const seen: Array<string | undefined> = [];
		const spawn = makeSpawnFn({
			resolveConfig: async () => baseConfig(),
			cwd: "/tmp",
			runSubagentAgent: (async (
				_config: unknown,
				_task: string,
				_cwd: string,
				opts: { sessionFile?: string },
			) => {
				seen.push(opts?.sessionFile);
				return { text: "ok", isError: false, elapsedMs: 1 };
			}) as never,
		});
		const jsonl = jsonlPath("s-spawn-session", "a3f8c1d0a");
		await spawn("Explore", "task", "tc-session", 0, jsonl);
		expect(seen).toEqual([jsonl]);
	});

	test("进度事件带 agentId（从转录路径反解实例 id）与 taskIndex", async () => {
		const events: Array<{ agentId?: string; taskIndex?: number }> = [];
		const spawn = makeSpawnFn({
			resolveConfig: async () => baseConfig(),
			cwd: "/tmp",
			onProgress: (_tcId, event) =>
				events.push({ agentId: event.agentId, taskIndex: event.taskIndex }),
			runSubagentAgent: (async (
				_config: unknown,
				_task: string,
				_cwd: string,
				opts: { onProgress?: (e: unknown) => void },
			) => {
				opts?.onProgress?.({
					agent: "Explore",
					status: "running",
					output: "",
					tools: [],
					elapsedMs: 1,
				});
				return { text: "ok", isError: false, elapsedMs: 1 };
			}) as never,
		});
		await spawn("Explore", "task", "tc-ai", 1, jsonlPath("s-spawn-ai", "a3f8c1d0a"));
		expect(events).toEqual([
			{ agentId: "a3f8c1d0a", taskIndex: 1 },
		]);
	});

	test("未传 sessionFile（不落盘路径）：进度事件不带 agentId", async () => {
		const events: Array<{ agentId?: string }> = [];
		const spawn = makeSpawnFn({
			resolveConfig: async () => baseConfig(),
			cwd: "/tmp",
			onProgress: (_tcId, event) => events.push({ agentId: event.agentId }),
			runSubagentAgent: (async (
				_config: unknown,
				_task: string,
				_cwd: string,
				opts: { onProgress?: (e: unknown) => void },
			) => {
				opts?.onProgress?.({
					agent: "Explore",
					status: "running",
					output: "",
					tools: [],
					elapsedMs: 1,
				});
				return { text: "ok", isError: false, elapsedMs: 1 };
			}) as never,
		});
		await spawn("Explore", "task", "tc-noai");
		expect(events).toEqual([{ agentId: undefined }]);
	});
});
