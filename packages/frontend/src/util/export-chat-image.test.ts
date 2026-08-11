// export-chat-image 纯逻辑单测：collectTurns 切片/配对/过滤/上限 + downloadBlob。
import { test, expect, mock } from "bun:test";
import {
	collectTurns,
	downloadBlob,
	renderTurnsToPngBlob,
} from "./export-chat-image";

// 构造 SessionMessage 形 fixture（只保留 collectTurns 关心的字段）
function userMsg(text: string, ts: number) {
	return { message: { role: "user", content: text, timestamp: ts } } as any;
}
function aiMsg(
	texts: string[],
	ts: number,
	agentName = "dev",
	extraBlocks: any[] = [],
) {
	return {
		message: {
			role: "assistant",
			content: [
				...extraBlocks,
				...texts.map((t) => ({ type: "text", text: t })),
			],
			timestamp: ts,
		},
		agentName,
	} as any;
}

test("基本配对：user + 后续 assistant 合成一轮，时间正序返回", () => {
	const msgs = [userMsg("问题一", 100), aiMsg(["回答一"], 200)];
	const turns = collectTurns(msgs, 200);
	expect(turns).toEqual([
		{ user: "问题一", assistant: "回答一", agentName: "dev", timestamp: 200 },
	]);
});

test("范围：只取 uptoTimestamp（含）之前的消息", () => {
	const msgs = [
		userMsg("早问题", 100),
		aiMsg(["早回答"], 200),
		userMsg("晚问题", 300),
		aiMsg(["晚回答"], 400),
	];
	const turns = collectTurns(msgs, 200);
	expect(turns).toHaveLength(1);
	expect(turns[0].user).toBe("早问题");
});

test("5 轮上限：超过时只保留最近 5 轮", () => {
	const msgs: any[] = [];
	for (let i = 0; i < 8; i++) {
		msgs.push(userMsg(`问题${i}`, i * 100));
		msgs.push(aiMsg([`回答${i}`], i * 100 + 50));
	}
	const turns = collectTurns(msgs, 9999);
	expect(turns).toHaveLength(5);
	expect(turns[0].user).toBe("问题3"); // 最早两轮被截掉
	expect(turns[4].user).toBe("问题7");
});

test("过程块过滤：thinking/toolCall 不进导出，同轮拆分 assistant 合并", () => {
	const msgs = [
		userMsg("问题", 100),
		aiMsg(["前半"], 200, "dev", [{ type: "thinking", thinking: "想…" }]),
		aiMsg(["后半"], 300, "dev", [
			{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
		]),
	];
	const turns = collectTurns(msgs, 300);
	expect(turns).toHaveLength(1);
	expect(turns[0].assistant).toBe("前半\n\n后半"); // text 块 \n\n 拼接（与 MessageList fullText 同口径）
	expect(turns[0].timestamp).toBe(300); // 轮结束时刻
});

test("纯过程轮（无文字回复）跳过；无配对 user 的 assistant 跳过", () => {
	const msgs = [
		aiMsg([], 50, "dev", [
			{ type: "toolCall", id: "c0", name: "bash", arguments: {} },
		]), // 无文字
		userMsg("问题", 100),
		aiMsg(["回答"], 200),
	];
	const turns = collectTurns(msgs, 200);
	expect(turns).toHaveLength(1);
	expect(turns[0].assistant).toBe("回答");
});

test("空白 text 块过滤：与 MessageList fullText 同口径，不保留空字符串/纯空白块", () => {
	const msgs = [userMsg("问题", 100), aiMsg(["前半", "", "   ", "后半"], 200)];
	const turns = collectTurns(msgs, 200);
	expect(turns).toHaveLength(1);
	// 空白块被丢弃，非空块 \n\n 拼接（与 MessageList segmentBlocks 行为一致）
	expect(turns[0].assistant).toBe("前半\n\n后半");
});

test("仅导出 agent 回复：includeUser=false 时 user 留空、assistant 保留", () => {
	const msgs = [userMsg("问题一", 100), aiMsg(["回答一"], 200)];
	const turns = collectTurns(msgs, 200, 5, false);
	expect(turns).toEqual([
		{ user: "", assistant: "回答一", agentName: "dev", timestamp: 200 },
	]);
});

test("仅导出 agent 回复：includeUser=false 不丢轮、不影响轮数上限", () => {
	const msgs = [
		userMsg("问题一", 100),
		aiMsg(["回答一"], 200),
		userMsg("问题二", 300),
		aiMsg(["回答二"], 400),
	];
	const turns = collectTurns(msgs, 400, 5, false);
	expect(turns).toHaveLength(2);
	expect(turns[0].user).toBe("");
	expect(turns[1].user).toBe("");
	expect(turns[0].assistant).toBe("回答一");
	expect(turns[1].assistant).toBe("回答二");
});

test("空结果：当条往前无文本对话返回空数组", () => {
	const msgs = [
		aiMsg([], 100, "dev", [{ type: "thinking", thinking: "只想不说" }]),
	];
	expect(collectTurns(msgs, 100)).toEqual([]);
	expect(collectTurns([], 100)).toEqual([]);
});

test("downloadBlob：创建 a[download] 并触发 click", () => {
	// happy-dom 无 URL.createObjectURL，打桩
	(URL as any).createObjectURL = () => "blob:mock";
	(URL as any).revokeObjectURL = () => {};
	const clicks: string[] = [];
	const origClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
		clicks.push(this.download);
	};
	try {
		downloadBlob(new Blob(["x"]), "wa-pi-chat-test.png");
		expect(clicks).toEqual(["wa-pi-chat-test.png"]);
	} finally {
		HTMLAnchorElement.prototype.click = origClick;
	}
});

// renderTurnsToPngBlob：mock html-to-image（happy-dom 无 canvas），
// 验证屏外容器挂载/卸载与 toBlob 调用参数。
mock.module("html-to-image", () => ({
	toBlob: async (node: HTMLElement, opts: any) => {
		(globalThis as any).__toBlobArgs = { text: node.textContent, opts };
		return new Blob(["png-bytes"], { type: "image/png" });
	},
}));

test("renderTurnsToPngBlob：屏外渲染卡片→toBlob→清理容器", async () => {
	const before = document.body.children.length;
	const blob = await renderTurnsToPngBlob([
		{ user: "问", assistant: "答", agentName: "dev", timestamp: 100 },
	]);
	expect(blob.type).toBe("image/png");
	const args = (globalThis as any).__toBlobArgs;
	expect(args.text).toContain("问");
	expect(args.text).toContain("答");
	expect(args.opts.pixelRatio).toBe(2);
	// 容器已清理（不残留屏外 DOM）
	expect(document.body.children.length).toBe(before);
});
