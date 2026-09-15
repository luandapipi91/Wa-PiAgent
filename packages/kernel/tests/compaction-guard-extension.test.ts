// compaction-guard 扩展接线单测（TDD：先于实现编写）
//
// 只验证「扩展文件把 pi 的钩子接到纯逻辑上」这一层接线；行为细节已由
// compaction-guard-handler.test.ts 用 fake 依赖覆盖。
// 这里用真实 pi 包提供的序列化函数，确认扩展在真实依赖下也能拿到 handler。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY = join(
	import.meta.dir,
	"..",
	"src",
	"compaction-guard.extension.ts",
);

type Handler = (event: any, ctx: any) => Promise<unknown>;

async function loadExtension(): Promise<Map<string, Handler>> {
	const mod = await import(pathToFileURL(ENTRY).href);
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (type: string, handler: Handler) => {
			handlers.set(type, handler);
		},
	};
	mod.default(pi);
	return handlers;
}

function fakeCtx(): any {
	const model = {
		provider: "deepseek",
		id: "deepseek-v4-pro",
		contextWindow: 1_000_000,
		maxTokens: 384_000,
	};
	return {
		model,
		modelRegistry: {
			complete: async () => ({
				stopReason: "stop",
				content: [{ type: "text", text: "摘要" }],
			}),
		},
		ui: { notify: () => {} },
	};
}

describe("compaction-guard 扩展接线", () => {
	test("注册 session_before_compact 钩子", async () => {
		const handlers = await loadExtension();
		expect(typeof handlers.get("session_before_compact")).toBe("function");
	});

	test("用真实 pi 序列化依赖也能接管压缩", async () => {
		const handlers = await loadExtension();
		const handler = handlers.get("session_before_compact");
		expect(handler).toBeDefined();

		const result: any = await handler!(
			{
				preparation: {
					messagesToSummarize: [
						{
							role: "user",
							content: [{ type: "text", text: "帮我改 A" }],
							timestamp: 1,
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "已改好 A" }],
							timestamp: 2,
						},
					],
					turnPrefixMessages: [],
					firstKeptEntryId: "entry-1",
					tokensBefore: 500,
				},
				signal: undefined,
			},
			fakeCtx(),
		);

		expect(result.compaction.summary).toBe("摘要");
		expect(result.compaction.firstKeptEntryId).toBe("entry-1");
		expect(result.compaction.tokensBefore).toBe(500);
	});

	test("摘要请求里带上了会话内容（序列化生效）", async () => {
		const handlers = await loadExtension();
		const handler = handlers.get("session_before_compact")!;
		let prompted = "";
		const ctx = fakeCtx();
		ctx.modelRegistry.complete = async (_model: any, context: any) => {
			prompted = context.messages[0].content[0].text;
			return { stopReason: "stop", content: [{ type: "text", text: "摘要" }] };
		};

		await handler(
			{
				preparation: {
					messagesToSummarize: [
						{
							role: "user",
							content: [{ type: "text", text: "把接口改成兼容旧签名" }],
							timestamp: 1,
						},
					],
					turnPrefixMessages: [],
					firstKeptEntryId: "e",
					tokensBefore: 1,
				},
				signal: undefined,
			},
			ctx,
		);

		expect(prompted).toContain("把接口改成兼容旧签名");
		expect(prompted).toContain("## Progress");
	});
});
