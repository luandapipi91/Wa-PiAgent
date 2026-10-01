// resume（主 agent 续聊同一子代理实例，任务 6）：
// 校验顺序 = agentId 格式 → meta 存在 → status !== running → 同一次调用内重复 resume 拒绝
// → 类型以 meta.subagentType 为准 → 复用 meta 的 jsonl（不新建实例）。
// resume 时不再做 askTo 越权校验（权限在首次派发时已校验）。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeDelegateTool } from "../src/delegate-tool";
import {
	jsonlPath,
	readMeta,
	writeMeta,
} from "../src/subagent-instance-store";

let dir: string;
/**
 * 模块加载期快照：全局 preload（packages/kernel/tests/setup.ts）已把 WA_PI_DIR 指到隔离临时目录，
 * 测试结束必须**恢复原值**而不是 delete —— delete 会清掉 preload 的隔离，让后续测试读到正式 ~/.pi/agent
 * （仓库既有惯例：另外 4 个碰 WA_PI_DIR 的测试都是快照→恢复）。
 */
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;
let spawned: Array<{ agent: string; task: string; sessionFile: string }>;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sa-resume-"));
	process.env.WA_PI_DIR = dir;
	spawned = [];
});
afterEach(async () => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	await rm(dir, { recursive: true, force: true });
});

const SID = "s-1111";
const baseMeta = {
	parentSessionId: SID,
	toolCallId: "c1",
	taskIndex: null,
	subagentType: "Explore",
	requestedAgent: "Explore",
	task: "第一轮",
	createdAt: 1,
	updatedAt: 1,
	resumeCount: 0,
};

function tool() {
	return makeDelegateTool({
		askTo: [],
		sessionId: SID,
		// 显式标注参数类型：外层 `as never` 抹掉了 makeDelegateTool 的上下文推导（tsc noImplicitAny）
		spawn: async (
			agent: string,
			task: string,
			_toolCallId: string,
			_taskIndex: number,
			sessionFile: string,
		) => {
			spawned.push({ agent, task, sessionFile });
			return { text: "ok", isError: false, elapsedMs: 5 };
		},
	} as never);
}

describe("resume 分支", () => {
	test("实例不存在 → 该任务返回错误文本，不 spawn", async () => {
		const r = await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "x", resume: "a00000000" }],
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("子代理实例不存在");
		expect(spawned.length).toBe(0);
	});

	test("status=running → 拒绝续聊", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000001",
			status: "running",
		} as never);
		const r = await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "x", resume: "a00000001" }],
		});
		expect(r.content[0].text).toContain("正在运行");
		expect(spawned.length).toBe(0);
	});

	test("非法 agentId 格式 → 拒绝（防路径穿越）", async () => {
		const r = await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "x", resume: "../../etc/passwd" }],
		});
		expect(r.isError).toBe(true);
		expect(spawned.length).toBe(0);
	});

	test("非法 agentId 格式 → agent_id 降级为空串（不回显原始值、不破坏 XML）", async () => {
		// 原始 resume 值可能含 < & 等字符：原样塞进 <agent_id> 会破坏 XML 结构，
		// 且把非法 id 当实例句柄回显会误导模型复用 → 该分支必须置空（同越权项降级形状）
		const r = await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "x", resume: "<x>&</x>" }],
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("<agent_id></agent_id>");
		expect(r.content[0].text).not.toContain("<x>");
	});

	test("同一次调用内两个 task 续同一实例 → 拒绝", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000002",
			status: "completed",
		} as never);
		const r = await tool().execute("c1", {
			tasks: [
				{ agent: "Explore", task: "x", resume: "a00000002" },
				{ agent: "Explore", task: "y", resume: "a00000002" },
			],
		});
		expect(r.content[0].text).toContain("同一次调用");
	});

	test("正常 resume → 复用同一 jsonl、resumeCount 递增、返回 resumed=true", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000003",
			status: "completed",
		} as never);
		const r = await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "接着干", resume: "a00000003" }],
		});
		expect(spawned.length).toBe(1);
		expect(spawned[0].sessionFile).toBe(
			join(dir, "subagents", SID, "a00000003.jsonl"),
		);
		expect(r.content[0].text).toContain("<resumed>true</resumed>");
		expect(r.content[0].text).toContain("<agent_id>a00000003</agent_id>");
	});

	test("resume 时类型以 meta 为准（忽略本次传入的 agent 名）", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000004",
			subagentType: "Plan",
			status: "completed",
		} as never);
		await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "x", resume: "a00000004" }],
		});
		expect(spawned[0].agent).toBe("Plan");
	});

	test("resume 不再过 askTo 越权校验（权限在首次派发时已校验）", async () => {
		// askTo 为空且实例类型不在内置清单里：续聊仍然放行（只看实例是否存在）
		await writeMeta({
			...baseMeta,
			agentId: "a00000005",
			subagentType: "代码审查",
			status: "completed",
		} as never);
		const r = await tool().execute("c1", {
			tasks: [{ agent: "陌生人", task: "接着干", resume: "a00000005" }],
		});
		expect(spawned.length).toBe(1);
		expect(spawned[0].agent).toBe("代码审查");
		expect(r.content[0].text).not.toContain("不在可调起列表中");
	});

	test("resume 成功后 meta 写终态：resumeCount +1、status 按本轮结果、usage 取本轮", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000006",
			status: "completed",
		} as never);
		const r = await makeDelegateTool({
			askTo: [],
			sessionId: SID,
			spawn: async () => ({
				text: "ok",
				isError: false,
				elapsedMs: 7,
				usage: {
					tokens: {
						input: 10,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						total: 12,
					},
					costTotal: 0.001,
				},
			}),
		} as never).execute("c1", {
			tasks: [{ agent: "Explore", task: "接着干", resume: "a00000006" }],
		});
		expect(r.content[0].text).toContain("<tokens>12</tokens>");
		const m = await readMeta(SID, "a00000006");
		expect(m?.status).toBe("completed");
		expect(m?.resumeCount).toBe(1);
		expect(m?.elapsedMs).toBe(7);
		expect(m?.usage?.total).toBe(12);
		expect(m?.usage?.costTotal).toBe(0.001);
		// meta.task 是实例身份（首轮任务），不被本轮续聊文本覆盖
		expect(m?.task).toBe("第一轮");
	});

	test("resume 本轮失败 → meta 写 failed（不再停在 running）", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000007",
			status: "completed",
		} as never);
		const r = await makeDelegateTool({
			askTo: [],
			sessionId: SID,
			spawn: async () => ({
				text: "拿不到上下文",
				isError: true,
				elapsedMs: 3,
			}),
		} as never).execute("c1", {
			tasks: [{ agent: "Explore", task: "接着干", resume: "a00000007" }],
		});
		expect(r.isError).toBe(true);
		const m = await readMeta(SID, "a00000007");
		expect(m?.status).toBe("failed");
		expect(m?.resumeCount).toBe(1);
	});

	test("resume 时 spawn 抛异常 → execute 不 reject、返回 isError 文本、meta 落 interrupted", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000009",
			status: "completed",
			// 上一轮的真实审计数据：本轮异常收尾不得继承（否则 usage/toolStats 张冠李戴）
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
			toolStats: { total: 3, done: 3, error: 0, running: 0 },
			elapsedMs: 9876,
		} as never);
		const r = await makeDelegateTool({
			askTo: [],
			sessionId: SID,
			// 抛异常：模拟 spawn 闭包内 try 块外路径（resolveConfig / ensureExtension 等）失败
			//（先耗 50ms 再抛：让「真实耗时 vs 编造的 0」可区分）
			spawn: async () => {
				await new Promise((r) => setTimeout(r, 50));
				throw new Error("spawn 内部炸了");
			},
		} as never).execute("c1", {
			tasks: [{ agent: "Explore", task: "接着干", resume: "a00000009" }],
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("spawn 内部炸了");
		expect(r.content[0].text).toContain("<status>interrupted</status>");
		// meta 收尾为 interrupted：否则永久停在 running → 该实例此后每次 resume 都被误拒
		const m = await readMeta(SID, "a00000009");
		expect(m?.status).toBe("interrupted");
		expect(m?.resumeCount).toBe(1);
		// 上一轮的 usage/toolStats 不得继承；elapsedMs 是本轮真实耗时（不再写编造的 0）
		expect(m?.usage).toBeUndefined();
		expect(m?.toolStats).toBeUndefined();
		expect(typeof m?.elapsedMs).toBe("number");
		expect(m!.elapsedMs!).toBeGreaterThanOrEqual(40); // ≥ 实际流逝的 50ms（宽松下限）
	});

	test("resume spawn 异常不连坐：同批其它任务结果照常返回", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a0000000a",
			status: "completed",
		} as never);
		const r = await makeDelegateTool({
			askTo: [],
			sessionId: SID,
			spawn: async (_agent: string, task: string) => {
				if (task === "boom") throw new Error("续聊炸了");
				return { text: "兄弟任务正常", isError: false, elapsedMs: 5 };
			},
		} as never).execute("c1", {
			tasks: [
				{ agent: "Explore", task: "boom", resume: "a0000000a" },
				{ agent: "Explore", task: "fine" },
			],
		});
		expect(r.content[0].text).toContain("续聊炸了");
		expect(r.content[0].text).toContain("兄弟任务正常");
	});

	test("resume 前按 jsonl 首行 cwd 补建目录（pi resume 校验目录存在）", async () => {
		await writeMeta({
			...baseMeta,
			agentId: "a00000008",
			status: "completed",
		} as never);
		const jsonl = jsonlPath(SID, "a00000008");
		await mkdir(dirname(jsonl), { recursive: true });
		const lost = join(dir, "lost-cwd", "nested");
		await writeFile(
			jsonl,
			`${JSON.stringify({ type: "session", id: "s", cwd: lost })}\n`,
			"utf8",
		);
		expect(existsSync(lost)).toBe(false);
		await tool().execute("c1", {
			tasks: [{ agent: "Explore", task: "接着干", resume: "a00000008" }],
		});
		expect(existsSync(lost)).toBe(true);
	});
});
