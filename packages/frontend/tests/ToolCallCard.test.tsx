import { test, expect, describe } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ToolCallCard } from "../src/components/blocks/ToolCallCard";

// 复现：edit 工具携带大段代码参数（oldText/newText 含真实换行/制表符），
// 旧实现用 JSON.stringify 渲染时会把真实换行转义成字面 "\n"/"\t"，一坨不可读。
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
});
