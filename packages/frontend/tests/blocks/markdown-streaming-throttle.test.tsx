// 流式渲染节流契约（卡顿修复终版，替代「纯文本↔markdown 停顿降级」）：
// 停顿降级（useSettled）用户实测闪烁——阈值下每条 delta 都可能触发 plain↔markdown
// 交替；切换会话时流式行也先纯文本再格式化闪一下。
// 终版：流式中始终渲染 markdown（不闪），解析节流 150ms（useThrottledValue），
// 结束/历史消息立即完整渲染。
import { test, expect } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { MarkdownBlock } from "../../src/components/MessageList";
import { collectMediaItems } from "../../src/components/blocks/media-utils";

const md = "**粗体** 正文";

test("流式中：始终渲染 markdown（不闪，无纯文本交替）", () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			throttleMs={10_000}
		/>,
	);
	// 流式中 markdown 直接渲染（旧降级方案此处是纯文本 plain，红灯）
	expect(screen.queryByTestId("text-block-plain")).toBeNull();
	expect(
		screen.getByTestId("text-block").querySelector("strong")?.textContent,
	).toBe("粗体");
});

test("流式中内容增长：解析节流——变化后立即查看仍是旧内容，节流窗口后追上", async () => {
	const md1 = "第一段内容";
	const { rerender } = render(
		<MarkdownBlock
			text={md1}
			sessionId="s1"
			mediaItems={collectMediaItems(md1)}
			isStreaming
			throttleMs={20}
		/>,
	);
	await act(async () => {
		await new Promise((r) => setTimeout(r, 40));
	});
	// delta 到达：text 变化，节流窗口内 DOM 保持旧内容（不逐帧重解析）
	const md2 = `${md1} **新增加粗**`;
	rerender(
		<MarkdownBlock
			text={md2}
			sessionId="s1"
			mediaItems={collectMediaItems(md2)}
			isStreaming
			throttleMs={20}
		/>,
	);
	expect(screen.queryByText("新增加粗")).toBeNull();
	// 节流窗口后追上
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	expect(screen.getByTestId("text-block").textContent).toContain("新增加粗");
});

test("非流式（历史消息/回复完成）：立即完整渲染（零延迟，不走节流）", () => {
	const { rerender } = render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			throttleMs={10_000}
		/>,
	);
	// 流式结束：立即同步最终内容（即使节流窗口未到）
	const md2 = `${md} 收尾`;
	rerender(
		<MarkdownBlock
			text={md2}
			sessionId="s1"
			mediaItems={collectMediaItems(md2)}
			isStreaming={false}
			throttleMs={10_000}
		/>,
	);
	expect(screen.getByTestId("text-block").textContent).toContain("收尾");
});

test("流式中切换会话再切回（重新挂载）：直接渲染 markdown，无纯文本闪烁过程", () => {
	render(
		<MarkdownBlock
			text={md}
			sessionId="s1"
			mediaItems={collectMediaItems(md)}
			isStreaming
			throttleMs={10_000}
		/>,
	);
	// 挂载即 markdown（首帧不含 plain 阶段）
	expect(screen.queryByTestId("text-block-plain")).toBeNull();
	expect(screen.getByTestId("text-block").querySelector("strong")).toBeTruthy();
});
