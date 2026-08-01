import { test, expect, describe } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToolCallCard } from "../src/components/blocks/ToolCallCard";

// ── 卡片内部长文本预览区自动滚动（write 工具 content 流式增长跟随到底部）──

function setScrollMetrics(
	el: HTMLElement,
	{
		scrollHeight,
		clientHeight,
		scrollTop,
	}: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
	Object.defineProperty(el, "scrollHeight", {
		value: scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: clientHeight,
		configurable: true,
	});
	el.scrollTop = scrollTop;
}

const writeCall = (content: string) => ({
	type: "toolCall" as const,
	id: "w1",
	name: "write",
	arguments: { path: "docs/a.md", content },
});

describe("ToolCallCard 参数预览区自动滚动", () => {
	test("write content 流式增长且用户停在底部 → 预览区自动滚动到底部", async () => {
		const { rerender } = render(
			<ToolCallCard toolCall={writeCall("line1\nline2")} isStreaming />,
		);
		const pre = screen.getByTestId("toolcall-w1-body").querySelector("pre")!;
		// 初始：内容高度 400（底部位置 100）
		setScrollMetrics(pre, {
			scrollHeight: 400,
			clientHeight: 300,
			scrollTop: 100,
		});
		fireEvent.scroll(pre); // 停在底部

		// 流式增长：内容更长 → scrollHeight 增长到 1000
		setScrollMetrics(pre, {
			scrollHeight: 1000,
			clientHeight: 300,
			scrollTop: 100,
		});
		rerender(
			<ToolCallCard
				toolCall={writeCall("line1\nline2\nline3\n...（流式写入的长文本）")}
				isStreaming
			/>,
		);
		await waitFor(() => expect(pre.scrollTop).toBe(1000), { timeout: 1000 });
	});

	test("write content 流式增长时用户上翻 → 预览区不抢滚动", async () => {
		const { rerender } = render(
			<ToolCallCard toolCall={writeCall("line1\nline2")} isStreaming />,
		);
		const pre = screen.getByTestId("toolcall-w1-body").querySelector("pre")!;
		setScrollMetrics(pre, {
			scrollHeight: 1000,
			clientHeight: 300,
			scrollTop: 700,
		});
		fireEvent.scroll(pre); // 停在底部

		// 用户上翻到 300（离开底部）
		pre.scrollTop = 300;
		fireEvent.scroll(pre);

		// 内容继续增长
		setScrollMetrics(pre, {
			scrollHeight: 1500,
			clientHeight: 300,
			scrollTop: 300,
		});
		rerender(
			<ToolCallCard
				toolCall={writeCall("line1\nline2\n...更长内容")}
				isStreaming
			/>,
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(pre.scrollTop).toBe(300); // 未被拉回底部
	});

	test("定稿卡片展开（首次挂载）不自动滚到底 → 从顶部开始看", () => {
		render(<ToolCallCard toolCall={writeCall("line1\nline2\nline3")} />);
		const pre = screen.getByTestId("toolcall-w1-body").querySelector("pre")!;
		setScrollMetrics(pre, {
			scrollHeight: 1000,
			clientHeight: 300,
			scrollTop: 0,
		});
		// 无内容增长：scrollTop 保持 0（顶部）
		expect(pre.scrollTop).toBe(0);
	});
});

const editCall = {
	type: "toolCall" as const,
	id: "t1",
	name: "edit",
	arguments: {
		path: "src/App.tsx",
		edits: [
			{
				oldText: "\t\t<div>\n\t\t\t<p>hi</p>\n\t\t</div>",
				newText: "\t\t<div>\n\t\t\t<AgentProgressItem p={p} />\n\t\t</div>",
			},
		],
	},
};

describe("ToolCallCard 工具参数渲染", () => {
	test("edit：展开区以真实代码展示 oldText/newText，无 JSON 转义字面", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		const text = body.textContent ?? "";
		// 代码内容可见
		expect(text).toContain("<p>hi</p>");
		expect(text).toContain("<AgentProgressItem p={p} />");
		// 不再出现 JSON.stringify 的转义字面（反斜杠+n / 反斜杠+t）
		expect(text).not.toContain("\\n");
		expect(text).not.toContain("\\t");
	});

	test("通用工具：长字符串以真实换行展示，无转义字面", () => {
		const call = {
			type: "toolCall" as const,
			id: "t2",
			name: "bash",
			arguments: { command: "echo hello\nworld" },
		};
		render(<ToolCallCard toolCall={call} />);
		const body = screen.getByTestId("toolcall-t2-body");
		const text = body.textContent ?? "";
		expect(text).toContain("echo hello");
		expect(text).toContain("world");
		expect(text).not.toContain("\\n");
	});

	test("edit：畸形 edits 参数（含非对象/非字符串字段）不崩溃，降级为通用参数视图", () => {
		// 工具参数来自 LLM 输出，流式中可能是截断/部分解析的 JSON，
		// 畸形形状是现实场景——渲染崩溃会把单张卡片问题升级为整个消息列表崩溃
		const call = {
			type: "toolCall" as const,
			id: "t4",
			name: "edit",
			arguments: {
				path: "a.ts",
				edits: [null, { oldText: { truncated: true }, newText: "y" }],
			},
		};
		render(<ToolCallCard toolCall={call} />);
		const body = screen.getByTestId("toolcall-t4-body");
		const text = body.textContent ?? "";
		// 不崩溃，且降级后的通用视图仍展示参数内容
		expect(text).toContain("oldText");
		expect(text).toContain("truncated");
	});

	test("edit：兼容平铺 oldText/newText 参数（无 edits 数组）", () => {
		const call = {
			type: "toolCall" as const,
			id: "t3",
			name: "edit",
			arguments: {
				path: "a.ts",
				oldText: "const a = 1;",
				newText: "const a = 2;",
			},
		};
		render(<ToolCallCard toolCall={call} />);
		const body = screen.getByTestId("toolcall-t3-body");
		const text = body.textContent ?? "";
		expect(text).toContain("const a = 2;");
		expect(text).toContain("const a = 1;");
		expect(text).not.toContain("\\n");
	});

	test("edit：代码块带行号，行号从 1 递增", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		const lineNums = body.querySelectorAll('[data-testid="code-line-num"]');
		// oldText 3 行 + newText 3 行 = 6 个行号
		expect(lineNums.length).toBe(6);
		expect(lineNums[0]!.textContent).toBe("1");
		expect(lineNums[1]!.textContent).toBe("2");
		// newText 第一行也从 1 开始
		expect(lineNums[3]!.textContent).toBe("1");
	});

	test("edit：代码块不设限高滚动，完整展示", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		expect(body.querySelector(".max-h-60")).toBeNull();
		expect(body.querySelector(".overflow-auto")).toBeNull();
	});
});
