// packages/kernel/tests/session-history.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	readSessionHistory,
	computeSessionUsage,
} from "../src/session-history";

let dir: string;
beforeEach(() => {
	dir = join(import.meta.dir, ".tmp-sh-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function msg(
	id: string,
	parentId: string | null,
	role: string,
	text: string,
	ts: number,
	lineTs: number = ts,
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(lineTs).toISOString(),
		message: { role, content: [{ type: "text", text }], timestamp: ts },
	});
}

/** 构造带 usage 的 assistant 消息（token 累计依赖 assistant.usage） */
function msgUsage(
	id: string,
	parentId: string | null,
	role: string,
	text: string,
	ts: number,
	usage: { input: number; output: number },
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
			timestamp: ts,
			...(role === "assistant" ? { usage } : {}),
		},
	});
}

/** 构造 compaction 节点（对齐 pi session-manager.appendCompaction） */
function compactionEntry(
	id: string,
	parentId: string,
	firstKeptEntryId: string,
	summary: string,
	tokensBefore: number,
	ts: number,
): string {
	return JSON.stringify({
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore,
	});
}

test("线性历史：按序返回当前分支全部消息", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "uuid-1",
				timestamp: "2026-01-01T00:00:00Z",
			}),
			JSON.stringify({
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
			}),
			msg("m1", "mc1", "user", "问题一", 1),
			msg("m2", "m1", "assistant", "回答一", 2),
			msg("m3", "m2", "user", "问题二", 3),
			msg("m4", "m3", "assistant", "回答二", 4),
			JSON.stringify({
				type: "session_info",
				id: "si1",
				parentId: "m4",
				timestamp: "2026-01-01T00:00:05Z",
			}),
		].join("\n") + "\n",
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history.map((m) => m.content[0].text)).toEqual([
		"问题一",
		"回答一",
		"问题二",
		"回答二",
	]);
});

test("分支历史：只返回当前分支（末尾叶子所在链），不含被 retry 替换的旧分支", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题", 1),
			msg("m2", "m1", "assistant", "旧回答", 2), // 旧分支
			msg("m3", "m1", "assistant", "新回答", 3), // retry 产生的新分支（文件末尾=当前分支）
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history.map((m) => m.content[0].text)).toEqual(["问题", "新回答"]);
});

// ── 压缩感知：readSessionHistory 需与 pi buildContextEntries 同语义 ──
// 背景：pi 压缩是 append-only（compaction 节点后旧消息仍在链上），不感知的话
// 直读 jsonl 会把压缩前的旧消息全部带出（token 累计不变、历史列表不缩）。

test("压缩感知：压缩前的旧消息省略，插入 compactionSummary 摘要消息", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题一", 1),
			msg("m2", "m1", "assistant", "回答一", 2),
			msg("m3", "m2", "user", "问题二", 3),
			msg("m4", "m3", "assistant", "回答二", 4),
			// firstKeptEntryId 指向链上不存在的 id：旧消息（m1-m4）全部被压缩省略
			compactionEntry(
				"c1",
				"m4",
				"gone-entry",
				"（压缩摘要：早期对话）",
				5000,
				5,
			),
			msg("m5", "c1", "user", "压缩后问题", 6),
			msg("m6", "m5", "assistant", "压缩后回答", 7),
		].join("\n") + "\n",
	);

	const history = (await readSessionHistory(file)) as any[];
	// 旧消息（m1-m4）省略，只保留压缩摘要 + 压缩后的新消息
	expect(history.map((m) => m.content?.[0]?.text ?? m.summary)).toEqual([
		"（压缩摘要：早期对话）",
		"压缩后问题",
		"压缩后回答",
	]);
	// 摘要消息 role=compactionSummary（与 pi createCompactionSummaryMessage 对齐）
	expect(history[0].role).toBe("compactionSummary");
	expect(history[0].summary).toBe("（压缩摘要：早期对话）");
	expect(history[0].tokensBefore).toBe(5000);
});

test("压缩感知：firstKeptEntryId 之后的旧消息保留（对齐 pi 保留最近上下文）", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题一", 1),
			msg("m2", "m1", "assistant", "回答一", 2),
			msg("m3", "m2", "user", "问题二", 3),
			msg("m4", "m3", "assistant", "回答二", 4),
			// firstKeptEntryId=m3：m1/m2 被压缩，m3/m4 保留
			compactionEntry("c1", "m4", "m3", "（摘要）", 5000, 5),
			msg("m5", "c1", "user", "压缩后问题", 6),
		].join("\n") + "\n",
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history.map((m) => m.content?.[0]?.text ?? m.summary)).toEqual([
		"（摘要）",
		"问题二",
		"回答二",
		"压缩后问题",
	]);
});

test("压缩感知：token 累计只累加压缩后保留的 assistant usage", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msgUsage("m1", null, "user", "问题一", 1, { input: 0, output: 0 }),
			msgUsage("m2", "m1", "assistant", "回答一", 2, {
				input: 1000,
				output: 500,
			}),
			msgUsage("m3", "m2", "user", "问题二", 3, { input: 0, output: 0 }),
			msgUsage("m4", "m3", "assistant", "回答二", 4, {
				input: 2000,
				output: 800,
			}),
			compactionEntry("c1", "m4", "m3", "（摘要）", 5000, 5),
			msgUsage("m5", "c1", "user", "压缩后问题", 6, { input: 0, output: 0 }),
			msgUsage("m6", "m5", "assistant", "压缩后回答", 7, {
				input: 300,
				output: 100,
			}),
		].join("\n") + "\n",
	);

	const history = (await readSessionHistory(file)) as any[];
	// 只有压缩后保留的 assistant（m4 + m6）带 usage；m2 被压缩省略
	const usageSum = history
		.filter((m) => m.role === "assistant" && m.usage)
		.reduce((acc, m) => acc + m.usage.input + m.usage.output, 0);
	expect(usageSum).toBe(2000 + 800 + 300 + 100);
});

// ── computeSessionUsage：全会话 token 累计（含压缩前历史 + 缓存），供 UI「累计」胶囊 ──

/** 构造带完整 usage（含缓存字段）的 assistant 消息 */
function msgUsageFull(
	id: string,
	parentId: string | null,
	role: string,
	text: string,
	ts: number,
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	},
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
			timestamp: ts,
			...(role === "assistant"
				? {
						usage: {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead ?? 0,
							cacheWrite: usage.cacheWrite ?? 0,
						},
					}
				: {}),
		},
	});
}

test("computeSessionUsage：无压缩会话累加全部 assistant usage（含 cacheRead/cacheWrite）", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msgUsageFull("m1", null, "user", "问题一", 1, { input: 0, output: 0 }),
			msgUsageFull("m2", "m1", "assistant", "回答一", 2, {
				input: 500,
				output: 100,
				cacheRead: 4000,
			}),
			msgUsageFull("m3", "m2", "user", "问题二", 3, { input: 0, output: 0 }),
			msgUsageFull("m4", "m3", "assistant", "回答二", 4, {
				input: 800,
				output: 200,
				cacheRead: 9000,
				cacheWrite: 300,
			}),
		].join("\n") + "\n",
	);

	const split = await computeSessionUsage(file);
	expect(split.main).toEqual({
		input: 1300,
		output: 300,
		cacheRead: 13000,
		cacheWrite: 300,
		total: 1300 + 300 + 13000 + 300,
	});
	expect(split.subagent.total).toBe(0);
});

test("computeSessionUsage：压缩后仍包含压缩前的 usage（区别于可见消息过滤）", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msgUsageFull("m1", null, "user", "问题一", 1, { input: 0, output: 0 }),
			msgUsageFull("m2", "m1", "assistant", "回答一", 2, {
				input: 1000,
				output: 500,
				cacheRead: 20000,
			}),
			msgUsageFull("m3", "m2", "user", "问题二", 3, { input: 0, output: 0 }),
			msgUsageFull("m4", "m3", "assistant", "回答二", 4, {
				input: 2000,
				output: 800,
				cacheRead: 30000,
			}),
			compactionEntry("c1", "m4", "m3", "（摘要）", 50000, 5),
			msgUsageFull("m5", "c1", "user", "压缩后问题", 6, {
				input: 0,
				output: 0,
			}),
			msgUsageFull("m6", "m5", "assistant", "压缩后回答", 7, {
				input: 300,
				output: 100,
				cacheRead: 1000,
			}),
		].join("\n") + "\n",
	);

	const split = await computeSessionUsage(file);
	// 与 readSessionHistory 的可见过滤不同：m2（压缩前）的消耗必须保留在累计里
	expect(split.main).toEqual({
		input: 1000 + 2000 + 300,
		output: 500 + 800 + 100,
		cacheRead: 20000 + 30000 + 1000,
		cacheWrite: 0,
		total: 3300 + 1400 + 51000 + 0,
	});
});

test("computeSessionUsage：无任何 usage 时返回全 0；文件不存在抛错", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msgUsageFull("m1", null, "user", "问题一", 1, { input: 0, output: 0 }),
			msgUsageFull("m2", "m1", "assistant", "回答一", 2, {
				input: 0,
				output: 0,
			}),
		].join("\n") + "\n",
	);
	const split = await computeSessionUsage(file);
	expect(split.main).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
	expect(split.subagent.total).toBe(0);

	await expect(
		computeSessionUsage(join(dir, "missing.jsonl")),
	).rejects.toThrow();
});

test("computeSessionUsage：toolResult.usage 计入子代理拆分，compaction usage 计入主代理", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msgUsageFull("m1", null, "user", "问题", 1, { input: 0, output: 0 }),
			msgUsageFull("m2", "m1", "assistant", "回答", 2, {
				input: 500,
				output: 100,
				cacheRead: 4000,
			}),
			// delegate/fleet 的 toolResult 携带子代理 LLM 用量（pi 官方 stats 原生计入）
			JSON.stringify({
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: new Date(3).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "delegate",
					content: [{ type: "text", text: "子代理结果" }],
					isError: false,
					timestamp: 3,
					usage: { input: 300, output: 130, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}),
			// compaction 条目自带的摘要生成 usage 计入主代理（对齐官方 totals）
			JSON.stringify({
				type: "compaction",
				id: "c1",
				parentId: "m3",
				timestamp: new Date(4).toISOString(),
				summary: "（摘要）",
				firstKeptEntryId: "m1",
				tokensBefore: 50000,
				usage: { input: 32000, output: 1200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } },
			}),
		].join("\n") + "\n",
	);

	const split = await computeSessionUsage(file);
	expect(split.subagent).toEqual({
		input: 300,
		output: 130,
		cacheRead: 1000,
		cacheWrite: 0,
		total: 1430,
	});
	expect(split.main.input).toBe(500 + 32000);
	expect(split.main.output).toBe(100 + 1200);
	expect(split.main.cacheRead).toBe(4000);
	expect(split.main.total).toBe(500 + 100 + 4000 + 33200);
});

test("坏行容错：非法 JSON 行跳过，不影响其余消息", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			'{"type":"message","id":"broken"', // 截断坏行
			msg("m2", "m1", "assistant", "回答", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history).toHaveLength(2);
});

test("文件不存在：抛错（调用方回退进程路径）", async () => {
	await expect(readSessionHistory(join(dir, "nope.jsonl"))).rejects.toThrow();
});

test("空文件/无有效行：抛错", async () => {
	const file = join(dir, "empty.jsonl");
	writeFileSync(file, "\n\n  \n");
	await expect(readSessionHistory(file)).rejects.toThrow(/无有效行/);
});

test("无消息的合法文件：返回空数组（新会话）", async () => {
	const file = join(dir, "fresh.jsonl");
	writeFileSync(
		file,
		JSON.stringify({ type: "session", version: 3, id: "uuid-1" }) + "\n",
	);
	expect(await readSessionHistory(file)).toEqual([]);
});

test("悬挂 ask：无 toolResult 的 ask_user_question 注入 cancelled 对账", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "ask-1",
							name: "ask_user_question",
							arguments: {},
						},
					],
					timestamp: 2,
				},
			}),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	const cancelled = history.find(
		(m) => m.role === "toolResult" && m.toolCallId === "ask-1",
	);
	expect(cancelled).toBeTruthy();
	expect(cancelled.toolName).toBe("ask_user_question");
});

// 网络类错误消息过滤：transient error（Connection error / timeout）在历史回读时被剔除，
// 不再进对话流；fatal error（鉴权失败 / 配额耗尽）保留，需提示用户改配置。
function errMsg(
	id: string,
	parentId: string | null,
	errorMessage: string,
	ts: number,
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage,
			timestamp: ts,
		},
	});
}

test("历史过滤：transient error（Connection error.）被剔除，不进对话流", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			errMsg("m2", "m1", "Connection error.", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// transient error 应被过滤掉，只剩用户消息
	expect(history).toHaveLength(1);
	expect(history[0].role).toBe("user");
});

test("历史过滤：transient error（Request timed out.）被剔除", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			errMsg("m2", "m1", "Request timed out.", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history).toHaveLength(1);
	expect(history[0].role).toBe("user");
});

test("历史保留：fatal error（401 Unauthorized）不被剔除，需提示用户", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			errMsg("m2", "m1", "401 Unauthorized", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history).toHaveLength(2);
	expect(history[1].stopReason).toBe("error");
	expect(history[1].errorMessage).toBe("401 Unauthorized");
});

test("历史保留：fatal error（insufficient_quota）不被剔除", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			errMsg("m2", "m1", "insufficient_quota", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	expect(history).toHaveLength(2);
});

test("历史混合：transient 被剔除，fatal 保留，正常消息不受影响", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题一", 1),
			errMsg("m2", "m1", "Connection error.", 2), // transient → 剔除
			msg("m3", "m2", "user", "问题二", 3),
			errMsg("m4", "m3", "401 Unauthorized", 4), // fatal → 保留
			msg("m5", "m4", "assistant", "回答", 5),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// 应为：问题一 / 问题二 / 401错误 / 回答（transient 的 m2 被剔除）
	expect(history).toHaveLength(4);
	expect(
		history.find((m) => m.errorMessage === "Connection error."),
	).toBeUndefined();
	expect(
		history.find((m) => m.errorMessage === "401 Unauthorized"),
	).toBeTruthy();
});

// ========== 失败回合去重（重发场景）==========
//
// 根因：重发失败消息时 pi 每次都 append 进 jsonl，刷新后出现多条相同的 user
// 发送记录。dedupeConsecutiveFailedTurns 把连续的失败对折叠到只剩最后一组，
// 既消除重发堆积，又保留最后一组的 fatal error 提示。

test("重发去重：连续3次失败回合，只保留最后一组 user+error", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "123", 1),
			errMsg("m2", "m1", "404 Not Found", 2),
			msg("m3", "m2", "user", "123", 3), // 重发
			errMsg("m4", "m3", "404 Not Found", 4),
			msg("m5", "m4", "user", "123", 5), // 再次重发
			errMsg("m6", "m5", "404 Not Found", 6),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// 3 组失败回合 → 去重后只剩最后 1 组（user + error）
	expect(history).toHaveLength(2);
	expect(history[0].role).toBe("user");
	expect(history[0].content[0].text).toBe("123");
	expect(history[1].stopReason).toBe("error");
});

test("重发去重：连续失败后最终成功，只保留成功回合", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "hi", 1),
			errMsg("m2", "m1", "404 Not Found", 2), // 失败
			msg("m3", "m2", "user", "hi", 3), // 重发
			errMsg("m4", "m3", "404 Not Found", 4), // 又失败（连续 → 折叠前一组）
			msg("m5", "m4", "user", "hi", 5), // 再次重发
			msg("m6", "m5", "assistant", "成功了", 6), // 这次成功
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// 前两组失败回合被折叠，只剩最后一次成功的 user + assistant
	expect(history).toHaveLength(2);
	expect(history[0].content[0].text).toBe("hi");
	expect(history[1].content[0].text).toBe("成功了");
});

test("非连续失败回合不去重：中间隔着成功对话的失败各自保留", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题一", 1),
			errMsg("m2", "m1", "401 Unauthorized", 2), // 失败回合 A
			msg("m3", "m2", "user", "问题二", 3),
			msg("m4", "m3", "assistant", "回答二", 4), // 成功对话（隔断）
			msg("m5", "m4", "user", "问题三", 5),
			errMsg("m6", "m5", "403 Forbidden", 6), // 失败回合 B（非连续，保留）
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// 两组失败回合中间有成功对话，不连续 → 都保留
	expect(history).toHaveLength(6);
});

test("单次失败回合不去重：保留 fatal error 提示用户", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			msg("m1", null, "user", "问题", 1),
			errMsg("m2", "m1", "404 Not Found", 2),
		].join("\n"),
	);

	const history = (await readSessionHistory(file)) as any[];
	// 只有一组失败回合，无后续重发 → 保留（fatal error 需提示用户）
	expect(history).toHaveLength(2);
	expect(history[1].stopReason).toBe("error");
});

test("轮级耗时：成功轮注入 turnElapsedMs（最后 assistant − user）", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题", 1000),
			msg("m2", "m1", "assistant", "回答", 5000),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[1].turnElapsedMs).toBe(4000);
});

test("轮级耗时：失败回合（error 结尾）不注入", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题", 1000),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: new Date(2000).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "报错" }],
					timestamp: 2000,
					stopReason: "error",
				},
			}),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[1].turnElapsedMs).toBeUndefined();
});

test("轮级耗时：连续多轮各自注入", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题一", 1000),
			msg("m2", "m1", "assistant", "回答一", 3000),
			msg("m3", "m2", "user", "问题二", 4000),
			msg("m4", "m3", "assistant", "回答二", 8000),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[1].turnElapsedMs).toBe(2000);
	expect(history[3].turnElapsedMs).toBe(4000);
});

test("轮级耗时：用行级落盘时刻计算（单块轮 message.timestamp 不可靠场景）", async () => {
	// 真实场景：单块轮（无工具调用直接回复）的 assistant 消息对象在 prompt 时预创建，
	// message.timestamp ≈ user（差 38ms），真实耗时在行级落盘时刻（差 6000ms）。
	// 注入必须用行级 timestamp，否则时长算成 0 秒。
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题", 1000, 1000),
			msg("m2", "m1", "assistant", "回答", 1038, 7000),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[1].turnElapsedMs).toBe(6000);
});

test("轮级耗时：assistant 行缺行级 timestamp 时不注入 NaN", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "user", "问题", 1000, 1000),
			// assistant 行缺行级 timestamp（旧 jsonl 格式）：真实落盘时刻缺失，
			// _lineTs 为 undefined，若直接相减会注入 NaN（前端显示 NaN 分 NaN 秒）。
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "回答" }],
					timestamp: 5000,
					stopReason: "end_turn",
				},
			}),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[1].turnElapsedMs).toBeUndefined();
});

test("轮级耗时：无 user 起点（只有 assistant）不注入", async () => {
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
			msg("m1", null, "assistant", "回答", 2000),
		].join("\n"),
	);
	const history = (await readSessionHistory(file)) as any[];
	expect(history[0].turnElapsedMs).toBeUndefined();
});
