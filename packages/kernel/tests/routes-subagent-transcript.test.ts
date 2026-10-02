// packages/kernel/tests/routes-subagent-transcript.test.ts
// 任务 7：子代理转录只读接口的单元 + HTTP 契约测试。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRouter } from "../src/http-router";
import { registerProjectSessionRoutes } from "../src/routes/projects-sessions";
import {
	handleSubagentMessages,
	handleSubagentList,
} from "../src/routes/projects-sessions";
import { jsonlPath, writeMeta, type SubagentMeta } from "../src/subagent-instance-store";

let dir: string;
/**
 * 模块加载期快照：全局 preload（packages/kernel/tests/setup.ts）已把 WA_PI_DIR 指到隔离临时目录，
 * 测试结束必须**恢复原值**而不是 delete —— delete 会清掉 preload 的隔离，让后续测试读到正式 ~/.pi/agent
 * （仓库既有惯例：另外 4 个碰 WA_PI_DIR 的测试都是快照→恢复）。
 */
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;
const SID = "s-2222";

const AID = "a3f8c1d0a";

function meta(over: Partial<SubagentMeta> = {}): SubagentMeta {
	return {
		agentId: AID,
		parentSessionId: SID,
		toolCallId: "c1",
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

/**
 * 造一条含 thinking + toolCall 的转录，证明整条链路能带出用户弹窗要看的全部块。
 */
async function seedTranscript(agentId = AID): Promise<void> {
	await mkdir(join(dir, "subagents", SID), { recursive: true });
	await writeMeta(meta({ agentId }));
	await writeFile(
		jsonlPath(SID, agentId),
		[
			JSON.stringify({ type: "session", version: 3, id: "poc", cwd: dir }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-10-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "想一想" },
						{ type: "text", text: "答" },
						{ type: "toolCall", id: "tc1", name: "ls", arguments: {} },
					],
				},
			}),
		].join("\n") + "\n",
	);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sa-route-"));
	process.env.WA_PI_DIR = dir;
});
afterEach(async () => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	await rm(dir, { recursive: true, force: true });
});

describe("GET 子代理转录", () => {
	test("合法 agentId 且文件存在 → 200 且返回 messages", async () => {
		await seedTranscript();
		const res = await handleSubagentMessages(SID, AID);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.meta.agentId).toBe(AID);
		expect(body.messages.length).toBe(1);
	});

	test("messages 精确带出 thinking 与 toolCall 块（不是空数组）", async () => {
		await seedTranscript();
		const body = await (await handleSubagentMessages(SID, AID)).json();
		const blocks = body.messages.flatMap((m: any) => m.message?.content ?? []);
		expect(blocks.filter((b: any) => b.type === "thinking").length).toBe(1);
		expect(blocks.filter((b: any) => b.type === "toolCall").length).toBe(1);
		expect(blocks.filter((b: any) => b.type === "text").length).toBe(1);
	});

	test("非法 agentId → 400（即便 meta 也不存在，仍是 400 而非 404）", async () => {
		const res = await handleSubagentMessages(SID, "../../etc/passwd");
		expect(res.status).toBe(400);
	});

	test("meta 不存在 → 404", async () => {
		const res = await handleSubagentMessages(SID, "a00000000");
		expect(res.status).toBe(404);
	});

	test("meta 存在但 jsonl 缺失 → 404（handler 不崩）", async () => {
		await mkdir(join(dir, "subagents", SID), { recursive: true });
		await writeMeta(meta());
		const res = await handleSubagentMessages(SID, AID);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("transcript_not_found");
	});

	test("会话内列表 → 200 且返回 meta 数组", async () => {
		await seedTranscript();
		const res = await handleSubagentList(SID);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.subagents.length).toBe(1);
		expect(body.subagents[0].agentId).toBe(AID);
	});

	test("会话目录不存在时列表返回空数组而非崩溃", async () => {
		const res = await handleSubagentList("s-none");
		expect(res.status).toBe(200);
		expect((await res.json()).subagents).toEqual([]);
	});
});

describe("HTTP 契约（真实 HttpRouter，含路径穿越防护）", () => {
	async function serve(): Promise<{ base: string; stop: () => void }> {
		const router = new HttpRouter();
		registerProjectSessionRoutes(router, async () => Response.json({}), {
			projectStore: null as any,
		});
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const url = new URL(req.url);
				if (url.pathname.startsWith("/api/")) {
					const res = await router.handle(req);
					return res ?? Response.json({ error: "not_found" }, { status: 404 });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		return {
			base: `http://127.0.0.1:${server.port}`,
			stop: () => server.stop(true),
		};
	}

	test("200 / 404 / 400 三条路径 + 编码斜杠穿越返回 400", async () => {
		await seedTranscript();
		const s = await serve();
		try {
			const ok = await fetch(`${s.base}/api/sessions/${SID}/subagents/${AID}`);
			expect(ok.status).toBe(200);
			const body = await ok.json();
			const blocks = body.messages.flatMap((m: any) => m.message?.content ?? []);
			expect(blocks.filter((b: any) => b.type === "thinking").length).toBe(1);
			expect(blocks.filter((b: any) => b.type === "toolCall").length).toBe(1);

			const missing = await fetch(`${s.base}/api/sessions/${SID}/subagents/a00000000`);
			expect(missing.status).toBe(404);

			const traversal = await fetch(
				`${s.base}/api/sessions/${SID}/subagents/..%2F..%2Fetc%2Fpasswd`,
			);
			expect(traversal.status).toBe(400);

			const list = await fetch(`${s.base}/api/sessions/${SID}/subagents`);
			expect(list.status).toBe(200);
			expect((await list.json()).subagents.length).toBe(1);
		} finally {
			s.stop();
		}
	});
});
