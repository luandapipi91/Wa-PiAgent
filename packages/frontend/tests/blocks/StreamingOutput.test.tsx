// StreamingOutput 流式节流契约（终版，替代 plain↔md 停顿降级——同主回复闪烁根因）：
// 流式中始终 markdown（不闪），解析经 useThrottledValue 节流；结束后零延迟同步。
import { test, expect } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { StreamingOutput } from "../../src/components/blocks/StreamingOutput";

test("流式中：始终 markdown 渲染（无纯文本交替闪烁）", () => {
	render(
		<StreamingOutput text={"**粗体** 正文"} sessionId="s1" streaming throttleMs={10_000} />,
	);
	// 旧降级方案的 streaming-output-plain 已不存在
	expect(screen.queryByTestId("streaming-output-plain")).toBeNull();
	expect(
		screen.getByTestId("streaming-output-md").querySelector("strong")?.textContent,
	).toBe("粗体");
});

test("流式中内容增长：节流——窗口内 DOM 保持旧内容，窗口后追上", async () => {
	const { rerender } = render(
		<StreamingOutput text="第一段" sessionId="s1" streaming throttleMs={20} />,
	);
	await act(async () => {
		await new Promise((r) => setTimeout(r, 40));
	});
	rerender(<StreamingOutput text="第一段 第二段" sessionId="s1" streaming throttleMs={20} />);
	expect(screen.queryByText("第二段")).toBeNull();
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	expect(screen.getByTestId("streaming-output-md").textContent).toContain("第二段");
});

test("非流式（子代理已完成）：markdown 渲染且内容零延迟同步", () => {
	render(
		<StreamingOutput text={"**粗体** 结果"} sessionId="s1" streaming={false} throttleMs={10_000} />,
	);
	expect(
		screen.getByTestId("streaming-output-md").querySelector("strong")?.textContent,
	).toBe("粗体");
});
