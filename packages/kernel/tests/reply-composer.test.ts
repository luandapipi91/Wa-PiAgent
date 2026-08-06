import { expect, test } from "bun:test";
import {
	composeReply,
	extractChangedFiles,
	extractAssistantText,
	chunkByBytes,
} from "../src/channels/reply-composer";

const userMsg = { role: "user", content: [{ type: "text", text: "问" }] };
const assistantWithTools = {
	role: "assistant",
	content: [
		{ type: "text", text: "已修复。" },
		{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/auth.ts" } },
		{ type: "toolCall", id: "2", name: "write", arguments: { path: "src/new.ts" } },
		{ type: "toolCall", id: "3", name: "bash", arguments: { command: "ls" } },
		{ type: "toolCall", id: "4", name: "edit", arguments: { path: "src/auth.ts" } }, // 重复路径去重
	],
};

test("extractAssistantText：拼接 text 块、跳过 thinking 与 toolCall", () => {
	const msgs: any[] = [
		userMsg,
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "..." },
				{ type: "text", text: "第一段" },
				{ type: "text", text: "第二段" },
			],
		},
	];
	expect(extractAssistantText(msgs)).toBe("第一段\n第二段");
});

test("extractChangedFiles：仅 edit/write，去重保序", () => {
	expect(extractChangedFiles([assistantWithTools as any])).toEqual([
		"src/auth.ts",
		"src/new.ts",
	]);
});

test("composeReply：simple 只回正文", () => {
	expect(composeReply([assistantWithTools as any], "simple")).toBe("已修复。");
});

test("composeReply：standard 附文件变更；无变更时不附", () => {
	expect(composeReply([assistantWithTools as any], "standard")).toBe(
		"已修复。\n\n📄 修改：src/auth.ts、src/new.ts",
	);
	const noEdit = { role: "assistant", content: [{ type: "text", text: "好的" }] };
	expect(composeReply([noEdit as any], "standard")).toBe("好的");
});

test("chunkByBytes：按 UTF-8 字节上限切分且不在多字节字符中间切断", () => {
	const text = "汉".repeat(100); // 每字 3 字节
	const chunks = chunkByBytes(text, 30);
	expect(chunks.length).toBe(10);
	for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(30);
	expect(chunks.join("")).toBe(text);
	expect(chunkByBytes("短文本")).toEqual(["短文本"]);
});
