// McpResultView（变体 C「摘要优先式」）：MCP 工具（mcp__ 前缀）结果的重新设计渲染。
// 截图痛点：大 JSON 输出裸 Linkify 平铺——无格式、无高亮、无限高，pi 的截断警告
// 原文（"Warning: truncated output (original token count: …) Total output lines: …"）
// 混在正文里。变体 C：截断警告条独立 + JSON 摘要条（条数/主题，默认收起）+
// 展开后才格式化高亮（延迟渲染）+ 复制完整原文 + 失败整块 danger 色。
import { test, expect, describe, beforeEach } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ToolResultMessage } from "@wa-pi/shared";
import { McpResultView } from "../src/components/blocks/McpResultView";

function textResult(text: string, isError = false): ToolResultMessage {
	return {
		id: "r1",
		role: "toolResult",
		content: [{ type: "text", text }],
		isError,
	} as unknown as ToolResultMessage;
}

const TRUNC_PREFIX =
	"Warning: truncated output (original token count: 16242) Total output lines: 2405 ";

beforeEach(() => {
	cleanup();
});

describe("McpResultView：截断横幅", () => {
	test("解析 pi 截断前缀为警告条，正文不再出现 Warning 原文", () => {
		const body = `${TRUNC_PREFIX}{ "items": [1, 2] }`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		const banner = screen.getByTestId("mcp-result-truncated");
		expect(banner.textContent).toContain("16,242");
		expect(banner.textContent).toContain("2,405");
		expect(document.body.textContent).not.toContain(
			"Warning: truncated output",
		);
	});

	test("无截断前缀：不渲染警告条", () => {
		render(
			<McpResultView result={textResult('{ "ok": true }')} failed={false} />,
		);
		expect(screen.queryByTestId("mcp-result-truncated")).toBeNull();
	});
});

describe("McpResultView：摘要优先（变体 C 核心）", () => {
	test("数组集合：摘要条显示条数 + 主题，JSON 默认收起不可见", () => {
		const body = `${TRUNC_PREFIX}${JSON.stringify({
			items: [
				{ subject: "预约查看-表格查看增加显示列", id: "a1" },
				{ subject: "项目消耗表支持快捷复制项目", id: "a2" },
			],
			total: 200,
		})}`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		// 服务端 total(200) 优先于本地条数(2)
		expect(screen.getByTestId("mcp-result-count").textContent).toBe("200");
		const titles = screen.getByTestId("mcp-result-titles").textContent ?? "";
		expect(titles).toContain("预约查看-表格查看增加显示列");
		expect(titles).toContain("项目消耗表支持快捷复制项目");
		// 默认收起：无高亮代码、无徽标
		expect(screen.queryByTestId("mcp-result-code")).toBeNull();
		expect(screen.queryByTestId("mcp-result-kind")).toBeNull();
		// 展开入口存在
		expect(screen.getByTestId("mcp-result-expand")).toBeDefined();
	});

	test("点击展开：JSON 高亮渲染（token 着色 + 行号），可再收起", () => {
		const body = `${TRUNC_PREFIX}${JSON.stringify({
			items: [{ subject: "需求甲" }],
			ok: false,
			cursor: null,
		})}`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		fireEvent.click(screen.getByTestId("mcp-result-expand"));
		expect(screen.getByTestId("mcp-result-kind").textContent).toBe("JSON");
		const pre = screen.getByTestId("mcp-result-code");
		expect(pre.querySelectorAll("[data-tok=key]").length).toBeGreaterThan(0);
		expect(pre.querySelectorAll("[data-tok=bool]").length).toBeGreaterThan(0);
		expect(pre.querySelectorAll("[data-line]").length).toBeGreaterThan(3);
		expect(pre.textContent).toContain("需求甲");
		// 收起：回到摘要条
		fireEvent.click(screen.getByTestId("mcp-result-collapse"));
		expect(screen.queryByTestId("mcp-result-code")).toBeNull();
		expect(screen.getByTestId("mcp-result-expand")).toBeDefined();
	});

	test("对象（无集合包装）：摘要显示字段数与字段名", () => {
		const body = `${TRUNC_PREFIX}${JSON.stringify({
			sessionId: "s-1",
			orgId: "o-1",
			page: 2,
		})}`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		expect(screen.getByTestId("mcp-result-count").textContent).toBe("3");
		expect(screen.getByTestId("mcp-result-objkeys").textContent).toContain(
			"sessionId",
		);
	});

	test("截断导致 JSON 畸形：无摘要条，降级行号原文块（不抛错）", () => {
		const body = `${TRUNC_PREFIX}{ "items": [{ "id": "abc", "name": "未完`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		expect(screen.queryByTestId("mcp-result-summary")).toBeNull();
		expect(screen.queryByTestId("mcp-result-expand")).toBeNull();
		expect(screen.getByTestId("mcp-result-code").textContent).toContain(
			'"id": "abc"',
		);
	});

	test("非 JSON 纯文本输出：直接原文渲染", () => {
		render(
			<McpResultView result={textResult("工单创建成功，ID=123")} failed={false} />,
		);
		expect(screen.queryByTestId("mcp-result-summary")).toBeNull();
		expect(screen.getByTestId("mcp-result-code").textContent).toContain(
			"工单创建成功，ID=123",
		);
	});

	test("超大 JSON：展开后限量渲染 500 行并提示剩余，收起态零 DOM 成本", () => {
		const big = JSON.stringify({
			items: Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `n${i}` })),
		});
		render(
			<McpResultView result={textResult(`${TRUNC_PREFIX}${big}`)} failed={false} />,
		);
		// 收起态：不渲染任何行（延迟渲染）
		expect(screen.queryByTestId("mcp-result-code")).toBeNull();
		fireEvent.click(screen.getByTestId("mcp-result-expand"));
		const pre = screen.getByTestId("mcp-result-code");
		const rendered = pre.querySelectorAll("[data-line]").length;
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThanOrEqual(520);
		const note = screen.getByTestId("mcp-result-more");
		expect(note.textContent).toMatch(/\d/);
		expect(note.textContent).toContain(",");
	});
});

describe("McpResultView：复制", () => {
	test("展开后复制按钮写原始完整文本（含截断前缀）", async () => {
		let written = "";
		const orig = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: (t: string) => ((written = t), Promise.resolve()) },
			configurable: true,
		});
		const body = `${TRUNC_PREFIX}{ "a": 1 }`;
		render(<McpResultView result={textResult(body)} failed={false} />);
		fireEvent.click(screen.getByTestId("mcp-result-expand"));
		fireEvent.click(screen.getByTestId("mcp-result-copy"));
		await act(async () => {});
		expect(written).toBe(body);
		Object.defineProperty(navigator, "clipboard", {
			value: orig,
			configurable: true,
		});
	});
});

describe("McpResultView：失败结果", () => {
	test("isError 结果以错误色呈现正文", () => {
		render(<McpResultView result={textResult("调用失败：超时", true)} failed />);
		const pre = screen.getByTestId("mcp-result-code");
		expect(pre.textContent).toContain("调用失败：超时");
		expect(pre.getAttribute("data-failed")).toBe("true");
	});
});
