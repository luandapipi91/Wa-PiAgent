// McpResultView 行为快照测试：护住「摘要优先式」既有交互（摘要条/延迟展开/收起/截断前缀/失败态），
// 作为抽共享件重构的安全网——重构前后必须保持全绿（行为零变化）。
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpResultView } from "./McpResultView";
import type { ToolResultMessage } from "@wa-pi/shared";

function mkResult(text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "m1",
		toolName: "mcp__x__list",
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

test("JSON 结果：默认摘要条收起，展开后格式化 JSON，可收起", () => {
	render(
		<McpResultView
			result={mkResult('{"items":[{"name":"a"},{"name":"b"}],"total":2}')}
			failed={false}
		/>,
	);
	// 摘要条：条数 + 默认无代码块（延迟展开）
	expect(screen.getByTestId("mcp-result-summary")).toBeTruthy();
	expect(screen.getByTestId("mcp-result-count").textContent).toBe("2");
	expect(screen.queryByTestId("mcp-result-code")).toBeNull();

	// 展开显示格式化 JSON（延迟 stringify），可再收起
	fireEvent.click(screen.getByTestId("mcp-result-expand"));
	const code = screen.getByTestId("mcp-result-code");
	expect(code.textContent).toContain('"items"');
	expect(code.textContent).toContain('"b"');
	fireEvent.click(screen.getByTestId("mcp-result-collapse"));
	expect(screen.queryByTestId("mcp-result-code")).toBeNull();
});

test("文本结果：无摘要条，行号原文块直接展示", () => {
	render(<McpResultView result={mkResult("第一行\n第二行")} failed={false} />);
	expect(screen.queryByTestId("mcp-result-summary")).toBeNull();
	const code = screen.getByTestId("mcp-result-code");
	expect(code.textContent).toContain("第一行");
	expect(code.textContent).toContain("第二行");
});

test("截断前缀：警告条解析 token/行数，正文剥离前缀后渲染", () => {
	render(
		<McpResultView
			result={mkResult(
				"Warning: truncated output (original token count: 1234) Total output lines: 50\nplain body",
			)}
			failed={false}
		/>,
	);
	expect(screen.getByTestId("mcp-result-truncated").textContent).toContain(
		"1,234",
	);
	const code = screen.getByTestId("mcp-result-code");
	expect(code.textContent).toContain("plain body");
	expect(code.textContent).not.toContain("Warning: truncated");
});

test("失败态：代码块带 data-failed（danger 色承载）", () => {
	render(<McpResultView result={mkResult("boom", true)} failed={true} />);
	expect(screen.getByTestId("mcp-result-code").getAttribute("data-failed")).toBe(
		"true",
	);
});
