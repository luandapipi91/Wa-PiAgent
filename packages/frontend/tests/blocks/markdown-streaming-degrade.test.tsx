// 主回复 MarkdownBlock 流式降级契约（卡顿修复）：
// 根因——流式中的末 block 每帧全量重跑 ReactMarkdown/remarkGfm，超长回复后期
// 单帧解析可达数十至数百 ms，主线程被占满、点击无响应（实测 12 万字 ≈303ms/帧）。
// 修复——复用 StreamingOutput（子代理流式 3.3）的停顿降级模式：
// isStreaming 且未停顿 → 纯文本（data-testid="text-block-plain"）；
// 停顿 idleMs 或流式结束 → 完整 markdown（data-testid="text-block"）。
import { test, expect } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { MarkdownBlock } from "../../src/components/MessageList";
import { collectMediaItems } from "../../src/components/blocks/media-utils";

const md = "**粗体** 正文";

test("流式中未停顿：渲染纯文本预览，不解析 markdown", () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			idleMs={10_000}
		/>,
	);
	const plain = screen.getByTestId("text-block-plain");
	expect(plain.textContent).toBe(md);
	// markdown 语法不解析
	expect(plain.querySelector("strong")).toBeNull();
	expect(screen.queryByTestId("text-block")).toBeNull();
});

test("流式中停顿 idleMs 后切换为 markdown 渲染", async () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			idleMs={20}
		/>,
	);
	expect(screen.getByTestId("text-block-plain")).toBeTruthy();
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	const block = screen.getByTestId("text-block");
	expect(block.querySelector("strong")?.textContent).toBe("粗体");
	expect(screen.queryByTestId("text-block-plain")).toBeNull();
});

test("停顿后内容继续增长：回到纯文本预览（计时被新内容重置）", async () => {
	const { rerender } = render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			idleMs={20}
		/>,
	);
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	expect(screen.getByTestId("text-block")).toBeTruthy();
	// 流式继续：新 delta 到达（text 变化）→ 立即回纯文本，避免每帧 markdown
	const md2 = `${md} 追加内容`;
	rerender(
		<MarkdownBlock
			text={md2}
			sessionId="s1"
			mediaItems={collectMediaItems(md2)}
			isStreaming
			idleMs={20}
		/>,
	);
	expect(screen.getByTestId("text-block-plain")).toBeTruthy();
});

test("默认停顿阈值为 50ms：停顿后快速切回 markdown（用户感知优化）", async () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
		/>,
	);
	// 未停顿：纯文本
	expect(screen.getByTestId("text-block-plain")).toBeTruthy();
	// 停阦 50ms（等待 120ms > 阈值）应已切换；旧默认 500ms 时仍为纯文本（红灯）
	await act(async () => {
		await new Promise((r) => setTimeout(r, 120));
	});
	expect(screen.getByTestId("text-block")).toBeTruthy();
});

test("非流式（历史消息/回复完成）：直接 markdown 渲染", () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
		/>,
	);
	expect(screen.queryByTestId("text-block-plain")).toBeNull();
	expect(
		screen.getByTestId("text-block").querySelector("strong"),
	).toBeTruthy();
});
