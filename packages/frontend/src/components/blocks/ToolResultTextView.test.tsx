// ToolResultTextView 测试：工具返回文本美化渲染（JSON 结构化 / 非 JSON 原样 / 畸形容错）。
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolResultText, parseToolResultText } from "./ToolResultTextView";
import { ToolCallCard } from "./ToolCallCard";
import type { ToolResultMessage } from "@wa-pi/shared";

/** 模拟 browser_navigate 返回体：单行 JSON 原文，snapshot 里的 \n 是字面量转义序列 */
const NAV_JSON = JSON.stringify({
	ok: true,
	sessionId: "abc-123",
	url: "https://example.com",
	refCount: 29,
	snapshot: '- generic\n - link "新闻" [ref=141]\n - link "hao123" [ref=142]',
});

// —— 纯函数：解析分类 ——

test("parseToolResultText：object/array 归为 json，其余归为 text", () => {
	expect(parseToolResultText(NAV_JSON)).toEqual({
		kind: "json",
		data: expect.any(Object),
	});
	expect(parseToolResultText("[1,2]").kind).toBe("json");
	// 顶层标量（parse 成功但非 object）按原样文本处理
	expect(parseToolResultText('"just a string"').kind).toBe("text");
	expect(parseToolResultText("普通\n多行文本").kind).toBe("text");
	// 畸形/截断 JSON 降级原文
	expect(parseToolResultText('{"ok":true,').kind).toBe("text");
});

// —— 渲染：JSON 结构化 ——

test("JSON 返回体：简单字段逐行展示，snapshot 换行与前导空格真实可见", () => {
	const { container } = render(<ToolResultText text={NAV_JSON} />);
	const text = container.textContent ?? "";
	// 简单字段逐行 `字段: 值`
	expect(text).toMatch(/ok:\s*true/);
	expect(text).toMatch(/sessionId:\s*abc-123/);
	expect(text).toMatch(/url:\s*https:\/\/example\.com/);
	expect(text).toMatch(/refCount:\s*29/);
	// 长文本块：字面量 \n 已转真实换行，树形缩进（前导空格）保留
	const block = container.querySelector(
		'pre[data-testid="tool-result-longtext"]',
	);
	expect(block).not.toBeNull();
	expect(block!.textContent).toContain('\n - link "新闻" [ref=141]');
	expect(block!.textContent).toContain('\n - link "hao123" [ref=142]');
	// 单行 JSON 原文不应再出现
	expect(text).not.toContain('\\"');
});

// —— 渲染：非 JSON 原样 ——

test("非 JSON 多行文本原样保留换行渲染", () => {
	const raw = "第一行\n第二行\n  缩进行";
	const { container } = render(<ToolResultText text={raw} />);
	const pre = container.querySelector("pre");
	expect(pre).not.toBeNull();
	expect(pre!.textContent).toBe(raw);
});

test("顶层 JSON 标量按原文渲染，不做结构化", () => {
	const { container } = render(<ToolResultText text='"just a string"' />);
	expect(container.textContent).toContain('"just a string"');
	expect(
		container.querySelector('[data-testid="tool-result-longtext"]'),
	).toBeNull();
});

// —— 渲染：畸形容错 ——

test("畸形 JSON（截断）不抛错不白屏，按原文渲染", () => {
	const raw = '{"ok":true,"snapshot":"- generic\\n - link \\"x\\"';
	const { container } = render(<ToolResultText text={raw} />);
	const pre = container.querySelector("pre");
	expect(pre).not.toBeNull();
	expect(pre!.textContent).toBe(raw);
});

// —— 交互：长文本展开 / 收起 ——

test("超长文本默认前 8 行 + 展开按钮；展开显示全部；收起恢复", () => {
	const lines = Array.from({ length: 12 }, (_, i) => `- line ${i + 1}`);
	const raw = JSON.stringify({ ok: true, snapshot: lines.join("\n") });
	const { container } = render(<ToolResultText text={raw} />);

	// 默认收起：只见前 8 行，第 9 行不可见
	const text = () => container.textContent ?? "";
	expect(text()).toContain("- line 8");
	expect(text()).not.toContain("- line 9");
	// 展开按钮复用 readExpandMore 文案（展开其余 {{n}} 行）
	const expand = screen.getByTestId("tool-result-expand");
	expect(expand.textContent).toContain("4");

	// 展开显示全部
	fireEvent.click(expand);
	expect(text()).toContain("- line 12");

	// 收起恢复预览
	fireEvent.click(screen.getByTestId("tool-result-collapse"));
	expect(text()).not.toContain("- line 9");
});

// —— 链路：ToolCallCard 非 MCP/codemode 工具替换点生效 ——

function mkResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "browser_navigate",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

/** browser_navigate 返回体：单行 JSON、snapshot 含字面量 \n（旧渲染为一坨无法阅读的平铺文本） */
test("ToolCallCard browser 工具：JSON 返回体经 ToolResultText 结构化渲染，缩进可见", () => {
	render(
		<ToolCallCard
			toolCall={{
				type: "toolCall",
				id: "b1",
				name: "browser_navigate",
				arguments: { url: "https://example.com" },
			}}
			result={mkResult("b1", NAV_JSON)}
		/>,
	);
	// 完成态折叠是设计行为：点 header 展开后再断言 body
	fireEvent.click(screen.getByTestId("toolcall-b1-header"));
	expect(document.body.textContent).toMatch(/refCount:\s*29/);
	const block = document.querySelector(
		'pre[data-testid="tool-result-longtext"]',
	);
	expect(block).not.toBeNull();
	expect(block!.textContent).toContain('\n - link "新闻" [ref=141]');
});
