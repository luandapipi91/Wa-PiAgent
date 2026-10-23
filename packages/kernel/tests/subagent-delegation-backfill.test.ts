// 旧 meta 的历史委派归属回填（修复前写入的 meta 没有 delegations 字段）：
// 列表接口惰性从父会话 jsonl 的 delegate/fleet 工具结果里还原「这个实例参与过哪些委派」，
// 否则旧那轮弹窗的左栏永远缺掉被 resume 走的实例。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSubagentList } from "../src/routes/projects-sessions";
import { parseDelegationsFromSessionLog } from "../src/subagent-delegation-backfill";
import { readMeta, writeMeta, type SubagentMeta } from "../src/subagent-instance-store";

let dir: string;
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;
const SID = "s-3333";
const A1 = "a00000001";
const A2 = "a00000002";

function meta(over: Partial<SubagentMeta>): SubagentMeta {
	return {
		agentId: A1,
		parentSessionId: SID,
		toolCallId: "c-old",
		taskIndex: null,
		subagentType: "Explore",
		requestedAgent: "Explore",
		task: "t",
		status: "completed",
		createdAt: 1,
		updatedAt: 1,
		resumeCount: 0,
		...over,
	};
}

/** 两轮委派：旧轮 c-old（a1/a2），新一轮 c-new 只 resume 了 a2 */
const SESSION_LOG = [
	JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c-old",
			toolName: "delegate",
			details: {
				subagents: [
					{ agentId: A1, taskIndex: 0 },
					{ agentId: A2, taskIndex: 1 },
				],
			},
		},
	}),
	JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c-new",
			toolName: "delegate",
			details: { subagents: [{ agentId: A2, taskIndex: 0, resumed: true }] },
		},
	}),
].join("\n") + "\n";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sa-backfill-"));
	process.env.WA_PI_DIR = dir;
});
afterEach(async () => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	await rm(dir, { recursive: true, force: true });
});

describe("parseDelegationsFromSessionLog", () => {
	test("按出现顺序还原每个实例参与过的委派（含被 resume 的新一轮）", () => {
		const map = parseDelegationsFromSessionLog(SESSION_LOG);
		expect(map.get(A1)).toEqual([{ toolCallId: "c-old", taskIndex: 0 }]);
		expect(map.get(A2)).toEqual([
			{ toolCallId: "c-old", taskIndex: 1 },
			{ toolCallId: "c-new", taskIndex: 0 },
		]);
	});

	test("坏行 / 非 delegate 结果 / 空 agentId / 重复行 一律忽略", () => {
		const raw = [
			"{ 坏 JSON",
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolCallId: "c-x", toolName: "read", details: {} },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c-y",
					toolName: "delegate",
					details: { subagents: [{ agentId: "", taskIndex: 0 }] },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c-old",
					toolName: "delegate",
					details: { subagents: [{ agentId: A1, taskIndex: 0 }] },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c-old",
					toolName: "delegate",
					details: { subagents: [{ agentId: A1, taskIndex: 0 }] },
				},
			}),
		].join("\n");
		expect(parseDelegationsFromSessionLog(raw).get(A1)).toEqual([
			{ toolCallId: "c-old", taskIndex: 0 },
		]);
	});
});

describe("列表接口历史归属回填", () => {
	async function seed(opts?: { withDelegations?: boolean }): Promise<void> {
		await writeFile(
			join(dir, "projects.json"),
			JSON.stringify({
				projects: [],
				sessions: [
					{
						id: SID,
						projectId: "p",
						primaryAgent: "x",
						title: "t",
						createdAt: 1,
						lastActivity: 1,
						piSessionFile: join(dir, "sessions", `${SID}.jsonl`),
					},
				],
			}),
			"utf8",
		);
		await mkdir(join(dir, "sessions"), { recursive: true });
		await writeFile(join(dir, "sessions", `${SID}.jsonl`), SESSION_LOG, "utf8");
		await mkdir(join(dir, "subagents", SID), { recursive: true });
		await writeMeta(
			meta({
				agentId: A1,
				toolCallId: "c-old",
				taskIndex: 0,
				...(opts?.withDelegations
					? { delegations: [{ toolCallId: "c-old", taskIndex: 0 }] }
					: {}),
			}),
		);
		await writeMeta(
			meta({
				agentId: A2,
				toolCallId: "c-new",
				taskIndex: 0,
				resumeCount: 1,
				...(opts?.withDelegations
					? {
							delegations: [
								{ toolCallId: "c-old", taskIndex: 1 },
								{ toolCallId: "c-new", taskIndex: 0 },
							],
						}
					: {}),
			}),
		);
	}

	test("缺 delegations 的旧 meta：列表返回补齐后的归属，并落盘", async () => {
		await seed();
		const body = await (await handleSubagentList(SID)).json();
		const byId = new Map(body.subagents.map((s: SubagentMeta) => [s.agentId, s]));
		expect((byId.get(A1) as SubagentMeta).delegations).toEqual([
			{ toolCallId: "c-old", taskIndex: 0 },
		]);
		expect((byId.get(A2) as SubagentMeta).delegations).toEqual([
			{ toolCallId: "c-old", taskIndex: 1 },
			{ toolCallId: "c-new", taskIndex: 0 },
		]);
		// 写盘：下次打开不再读会话日志
		expect((await readMeta(SID, A2))?.delegations).toEqual([
			{ toolCallId: "c-old", taskIndex: 1 },
			{ toolCallId: "c-new", taskIndex: 0 },
		]);
	});

	test("已有 delegations 的 meta 不被改写", async () => {
		await seed({ withDelegations: true });
		await rm(join(dir, "sessions"), { recursive: true, force: true });
		const body = await (await handleSubagentList(SID)).json();
		const a2 = body.subagents.find((s: SubagentMeta) => s.agentId === A2);
		expect(a2.delegations).toEqual([
			{ toolCallId: "c-old", taskIndex: 1 },
			{ toolCallId: "c-new", taskIndex: 0 },
		]);
	});
});
