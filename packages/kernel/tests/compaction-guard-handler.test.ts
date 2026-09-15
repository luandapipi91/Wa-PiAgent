// compaction-guard handler 编排单测（TDD：先于实现编写）
//
// 被测对象是 createCompactionGuardHandler(deps) 返回的 session_before_compact 处理函数：
// 不依赖 pi 包（序列化由 deps.serialize 注入），因此可用纯 fake 的 ctx 覆盖全部分支。

import { describe, expect, test } from "bun:test";
import { createCompactionGuardHandler } from "../src/compaction-guard-core.ts";

/** 测试用序列化：把消息按行拼起来 */
const serialize = (messages: unknown[]): string =>
	messages
		.map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
		.join("\n");

interface CtxOptions {
	contextWindow?: number;
	maxTokens?: number;
}

function makeCtx(
	opts: CtxOptions = {},
	response: { stopReason: string; content?: unknown[] } = {
		stopReason: "stop",
		content: [{ type: "text", text: "摘要正文" }],
	},
) {
	const calls: Array<{ model: unknown; context: any; options: any }> = [];
	const notify: string[] = [];
	const ctx = {
		model: {
			provider: "deepseek",
			id: "deepseek-v4-pro",
			contextWindow: opts.contextWindow ?? 1_000_000,
			maxTokens: opts.maxTokens ?? 384_000,
		},
		modelRegistry: {
			complete: async (model: unknown, context: any, options: any) => {
				calls.push({ model, context, options });
				return response;
			},
		},
		ui: { notify: (message: string) => notify.push(message) },
	};
	return { ctx, calls, notify };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
	return {
		preparation: {
			messagesToSummarize: ["甲".repeat(300)],
			turnPrefixMessages: [],
			firstKeptEntryId: "entry-1",
			tokensBefore: 12_345,
			...overrides,
		},
		signal: undefined as AbortSignal | undefined,
	};
}

describe("createCompactionGuardHandler —— 接管压缩", () => {
	test("正常生成摘要：返回 compaction，沿用 preparation 的 firstKeptEntryId 与 tokensBefore", async () => {
		const { ctx } = makeCtx();
		const result: any = await createCompactionGuardHandler({ serialize })(
			makeEvent(),
			ctx,
		);
		expect(result.compaction.summary).toBe("摘要正文");
		expect(result.compaction.firstKeptEntryId).toBe("entry-1");
		expect(result.compaction.tokensBefore).toBe(12_345);
	});

	test("输出预算按模型能力动态计算，不再受 pi 内置 13107 限制", async () => {
		const { ctx, calls } = makeCtx();
		await createCompactionGuardHandler({ serialize, wantOutputTokens: 32_768 })(
			makeEvent(),
			ctx,
		);
		expect(calls[0].options.maxTokens).toBe(32_768);
	});

	test("摘要被输出上限截断（length）时，按上限采用并标注", async () => {
		const { ctx } = makeCtx(
			{},
			{ stopReason: "length", content: [{ type: "text", text: "半截摘要" }] },
		);
		const result: any = await createCompactionGuardHandler({
			serialize,
			wantOutputTokens: 1_200,
		})(makeEvent(), ctx);
		expect(result.compaction.summary).toContain("半截摘要");
		expect(result.compaction.summary).toContain("截断");
	});

	test("摘要为空（只有 thinking）时返回 undefined，交回内置压缩", async () => {
		const { ctx } = makeCtx(
			{},
			{
				stopReason: "stop",
				content: [{ type: "thinking", thinking: "没写正文" }],
			},
		);
		expect(
			await createCompactionGuardHandler({ serialize })(makeEvent(), ctx),
		).toBeUndefined();
	});

	test("调用抛错时返回 undefined，交回内置压缩", async () => {
		const ctx: any = {
			model: {
				provider: "p",
				id: "m",
				contextWindow: 1_000_000,
				maxTokens: 384_000,
			},
			modelRegistry: {
				complete: async () => {
					throw new Error("网络炸了");
				},
			},
			ui: { notify: () => {} },
		};
		expect(
			await createCompactionGuardHandler({ serialize })(makeEvent(), ctx),
		).toBeUndefined();
	});

	test("被取消（aborted）时返回 undefined", async () => {
		const { ctx } = makeCtx({}, { stopReason: "aborted", content: [] });
		expect(
			await createCompactionGuardHandler({ serialize })(makeEvent(), ctx),
		).toBeUndefined();
	});

	test("输入超窗口时丢弃最旧消息，摘要请求拿到的是裁剪后的文本", async () => {
		const { ctx, calls } = makeCtx({ contextWindow: 4_000 });
		const event = makeEvent({
			messagesToSummarize: ["最旧".repeat(2_000), "最新".repeat(50)],
		});
		await createCompactionGuardHandler({ serialize, wantOutputTokens: 1_024 })(
			event,
			ctx,
		);
		const promptText: string = calls[0].context.messages[0].content[0].text;
		expect(promptText).toContain("最新");
		expect(promptText).not.toContain("最旧");
	});

	test("窗口连安全余量都装不下时返回 undefined（交回内置，不硬来）", async () => {
		const { ctx } = makeCtx({ contextWindow: 2_000 });
		const event = makeEvent({ messagesToSummarize: ["内容".repeat(4_000)] });
		expect(
			await createCompactionGuardHandler({ serialize })(event, ctx),
		).toBeUndefined();
	});

	test("缺少准备信息或当前模型时返回 undefined", async () => {
		const { ctx } = makeCtx();
		expect(
			await createCompactionGuardHandler({ serialize })({}, ctx),
		).toBeUndefined();
		expect(
			await createCompactionGuardHandler({ serialize })(makeEvent(), {}),
		).toBeUndefined();
	});
});
