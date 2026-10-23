import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import {
	CodemodeResultView,
	CodemodeScriptView,
	splitOutputItems,
	extractConsole,
	parseScriptStatus,
} from "./CodemodeView";
import { ToolCallCard } from "./ToolCallCard";
import { useUiPrefsStore } from "../../store/ui-prefs";
import type { ToolResultMessage } from "@wa-pi/shared";

function mkResult(content: any[], isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "codemode",
		content,
		isError,
		timestamp: 0,
	};
}

// —— 协议解析纯函数 ——

test("parseScriptStatus：提取头部状态行；splitOutputItems 剥离状态行后拆项", () => {
	const out =
		"Script completed (0.5s)\n==> text 1/2 <==\n第一段\n==> text 2/2 <==\n第二段";
	expect(parseScriptStatus(out)).toBe("Script completed (0.5s)");
	expect(splitOutputItems(out)).toEqual(["第一段", "第二段"]);
	expect(
		parseScriptStatus("Script failed (0.2s)\nScript error: boom"),
	).toBe("Script failed (0.2s)");
	expect(parseScriptStatus("没有状态行")).toBeNull();
});

test("splitOutputItems：纯文本无分隔行 → 单项", () => {
	expect(splitOutputItems("Script completed (0.1s)\n只有一段")).toEqual([
		"只有一段",
	]);
});

test("extractConsole：<console_output> 块提取；无块 → null", () => {
	expect(
		extractConsole("A\n<console_output>\nlog1\nlog2\n</console_output>"),
	).toBe("log1\nlog2");
	expect(extractConsole("没有块")).toBeNull();
});

// —— 渲染 ——

test("渲染状态行与文本项；console 块独立小节且分隔行原文不出现", () => {
	render(
		<CodemodeResultView
			result={mkResult([
				{
					type: "text",
					text: "Script completed (0.5s)\n==> text 1/2 <==\n第一段\n==> text 2/2 <==\n第二段\n<console_output>\nlog1\n</console_output>",
				},
			])}
			failed={false}
		/>,
	);
	expect(screen.getByTestId("codemode-status")).toBeTruthy();
	expect(screen.getByText(/第一段/)).toBeTruthy();
	expect(screen.getByText(/第二段/)).toBeTruthy();
	expect(screen.getByTestId("codemode-console")).toBeTruthy();
	expect(screen.getByText(/log1/)).toBeTruthy();
	// 分隔行原文不得出现
	expect(screen.queryByText(/==> text/)).toBeNull();
});

test("image 块渲染为 <img>（data URI，不被丢弃）", () => {
	render(
		<CodemodeResultView
			result={mkResult([
				{ type: "text", text: "Script completed (0.1s)" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			])}
			failed={false}
		/>,
	);
	const img = screen.getByAltText("codemode-image-1") as HTMLImageElement;
	expect(img.src).toBe("data:image/png;base64,aGk=");
});

test("CodemodeScriptView 渲染 CodeBlockCard（javascript 高亮块存在）", () => {
	const { container } = render(<CodemodeScriptView code={"return 1 + 1;"} />);
	expect(container.querySelector('[data-testid="code-block-card"] pre')).toBeTruthy();
});

// —— ToolCallCard 路由 ——

test("ToolCallCard codemode 调用：标题行数、脚本块、结构化结果", () => {
	render(
		<ToolCallCard
			toolCall={{
				type: "toolCall",
				id: "c1",
				name: "codemode",
				arguments: { code: "return 1 + 1;" },
			}}
			result={mkResult([{ type: "text", text: "Script completed (0.1s)\n2" }])}
		/>,
	);
	// 完成态折叠是设计行为：点 header 展开后再断言 body
	fireEvent.click(screen.getByTestId("toolcall-c1-header"));
	expect(screen.getByText(/1L/)).toBeTruthy(); // 标题行数
	expect(screen.getByText(/脚本（1 行）/)).toBeTruthy();
	expect(screen.getByText(/Script completed/)).toBeTruthy();
});
