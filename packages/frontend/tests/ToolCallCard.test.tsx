import { test, expect, describe, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
	ToolCallCard,
	editLineStats,
} from "../src/components/blocks/ToolCallCard";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import type { ToolResultMessage } from "@wa-pi/shared";

// 本文件专注验证卡片参数 / 滚动渲染逻辑，基线为「回复过程折叠开关关闭」（展开）。
// 折叠开关行为由 store-ui-prefs-collapse / useAutoCollapse 测试单独覆盖。
beforeEach(() => {
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

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
	test("write 流式增长且用户停在底部 → 内容跟随到底部", async () => {
		const { rerender } = render(
			<ToolCallCard toolCall={writeCall("line1\nline2")} isStreaming />,
		);
		const el = screen.getByTestId("toolcall-w1-write-lines");
		// 初始：内容高度 400（底部位置 100）
		setScrollMetrics(el, {
			scrollHeight: 400,
			clientHeight: 300,
			scrollTop: 100,
		});
		fireEvent.scroll(el); // 停在底部

		// 流式增长：内容更长 → scrollHeight 增长到 1000
		setScrollMetrics(el, {
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
		await waitFor(() => expect(el.scrollTop).toBe(1000), { timeout: 1000 });
	});

	test("write 流式增长时用户上翻 → 预览区不抢滚动", async () => {
		const { rerender } = render(
			<ToolCallCard toolCall={writeCall("line1\nline2")} isStreaming />,
		);
		const el = screen.getByTestId("toolcall-w1-write-lines");
		setScrollMetrics(el, {
			scrollHeight: 1000,
			clientHeight: 300,
			scrollTop: 700,
		});
		fireEvent.scroll(el); // 停在底部

		// 用户上翻到 300（离开底部）
		el.scrollTop = 300;
		fireEvent.scroll(el);

		// 内容继续增长
		setScrollMetrics(el, {
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
		expect(el.scrollTop).toBe(300); // 未被拉回底部
	});

	test("定稿卡片展开（首次挂载）：默认只给 6 行预览，从顶部开始看", () => {
		render(
			<ToolCallCard
				toolCall={writeCall(Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n"))}
			/>,
		);
		const body = screen.getByTestId("toolcall-w1-body");
		expect(body.querySelectorAll('[data-testid="read-line"]').length).toBe(6);
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
	test("edit：展开区渲染 diff 行（删除块 + 新增块），内容无 JSON 转义字面", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		const text = body.textContent ?? "";
		// 代码内容可见
		expect(text).toContain("<p>hi</p>");
		expect(text).toContain("<AgentProgressItem p={p} />");
		// 不再出现 JSON.stringify 的转义字面（反斜杠+n / 反斜杠+t）
		expect(text).not.toContain("\\n");
		expect(text).not.toContain("\\t");
		// 旧 / 新各自成块：3 行删除 + 3 行新增
		expect(body.querySelectorAll('[data-testid="edit-diff-del"]').length).toBe(3);
		expect(body.querySelectorAll('[data-testid="edit-diff-add"]').length).toBe(3);
	});

	test("edit：折叠态标题带「编辑」动作词，能一眼看出是编辑而非普通工具", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const card = screen.getByTestId("toolcall-t1");
		expect(card.textContent).toMatch(/编辑|Edit/);
		expect(card.textContent).toContain("App.tsx");
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

	test("edit：执行中预览不伪造文件行号（行号列留空）", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		// 执行中只有参数，无法得知真实文件行号 → 双列行号均为空
		const rows = body.querySelectorAll('[data-testid="edit-diff-add"]');
		expect(rows.length).toBe(3);
		for (const row of rows) {
			const spans = row.querySelectorAll("span");
			expect(spans[0]!.textContent).toBe("");
			expect(spans[1]!.textContent).toBe("");
		}
	});

	test("edit：完成后用 details.diff 渲染真实行号 + 词级高亮 + 摘要", () => {
		const result = {
			type: "toolResult" as const,
			id: "r1",
			toolCallId: "t1",
			toolName: "edit",
			content: [{ type: "text" as const, text: "Successfully replaced 2 block(s)." }],
			details: {
				diff: [
					" 40 type mallOrderMsg struct {",
					"+41 \tLastUpdateUser json.RawMessage",
					" 41 \tMallOrder *struct {",
					"  ...",
					"-67 \t\tCreateUser: rawString(msg.MallOrder.LastUpdateUser),",
					"+68 \t\tCreateUser: rawString(pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)),",
					" 68 \t})",
				].join("\n"),
			},
		};
		render(<ToolCallCard toolCall={editCall} result={result as any} />);
		// 完成后卡片自动折叠，先展开再断言内容
		fireEvent.click(screen.getByTestId("toolcall-t1-header"));
		const body = screen.getByTestId("toolcall-t1-body");
		// 真实行号：上下文 40/40，新增行旧列空、新列 41
		const addRow = body.querySelector('[data-testid="edit-diff-add"]')!;
		const nums = addRow.querySelectorAll("span");
		expect(nums[0]!.textContent).toBe("");
		expect(nums[1]!.textContent).toBe("41");
		// 词级高亮：单行替换只标出变化段
		const marks = body.querySelectorAll("mark");
		expect(marks.length).toBeGreaterThan(0);
		expect(marks[marks.length - 1]!.textContent).toBe(
			"pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)",
		);
		// 摘要：2 处修改 + 位置
		const summary = screen.getByTestId("toolcall-t1-diff-summary");
		expect(summary.textContent).toContain("2");
		expect(summary.textContent).toContain("41");
		// 成功文案不再独占一行平铺
		expect(body.textContent).not.toContain("Successfully replaced");
	});

	test("edit：失败时显示错误块，不渲染 diff", () => {
		const result = {
			type: "toolResult" as const,
			id: "r2",
			toolCallId: "t1",
			toolName: "edit",
			isError: true,
			content: [{ type: "text" as const, text: "oldText not found in src/App.tsx" }],
		};
		render(<ToolCallCard toolCall={editCall} result={result as any} />);
		fireEvent.click(screen.getByTestId("toolcall-t1-header"));
		const body = screen.getByTestId("toolcall-t1-body");
		expect(body.textContent).toContain("oldText not found");
		expect(body.querySelector('[data-testid="edit-diff-add"]')).toBeNull();
	});

	test("edit：代码块不设限高滚动，完整展示", () => {
		render(<ToolCallCard toolCall={editCall} />);
		const body = screen.getByTestId("toolcall-t1-body");
		expect(body.querySelector(".max-h-60")).toBeNull();
		expect(body.querySelector(".overflow-auto")).toBeNull();
	});
});

const readCall = {
	type: "toolCall" as const,
	id: "r1",
	name: "read",
	arguments: { path: "logs/agent-crash.log", offset: 1, limit: 200 },
};

const readLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const readResult = {
	type: "toolResult" as const,
	id: "rr1",
	toolCallId: "r1",
	toolName: "read",
	content: [
		{
			type: "text" as const,
			text:
				readLines.join("\n") +
				"\n\n[Showing lines 1-10 of 1850. Use offset=11 to continue.]",
		},
	],
	details: { truncation: { truncated: true, outputLines: 10, totalLines: 1850 } },
};

describe("ToolCallCard read 卡片（渐进摘要）", () => {
	test("折叠态标题带「读取」动作词、文件名与行范围", () => {
		render(<ToolCallCard toolCall={readCall} />);
		const card = screen.getByTestId("toolcall-r1");
		expect(card.textContent).toMatch(/读取|Read/);
		expect(card.textContent).toContain("agent-crash.log");
		expect(card.textContent).toContain("1");
		expect(card.textContent).toContain("200");
	});

	test("完成后展开：默认只给 6 行预览 + 「展开其余 N 行」", () => {
		render(<ToolCallCard toolCall={readCall} result={readResult as any} />);
		fireEvent.click(screen.getByTestId("toolcall-r1-header"));
		const body = screen.getByTestId("toolcall-r1-body");
		expect(body.querySelectorAll('[data-testid="read-line"]').length).toBe(6);
		const toggle = screen.getByTestId("toolcall-r1-read-toggle");
		expect(toggle.textContent).toContain("4");
	});

	test("点击展开其余行：显示全部内容，按钮变「收起」", () => {
		render(<ToolCallCard toolCall={readCall} result={readResult as any} />);
		fireEvent.click(screen.getByTestId("toolcall-r1-header"));
		fireEvent.click(screen.getByTestId("toolcall-r1-read-toggle"));
		const body = screen.getByTestId("toolcall-r1-body");
		expect(body.querySelectorAll('[data-testid="read-line"]').length).toBe(10);
		expect(screen.getByTestId("toolcall-r1-read-toggle").textContent).toMatch(
			/收起|Collapse/,
		);
	});

	test("行号从 offset 开始；截断状态外显，正文提示不重复渲染", () => {
		render(
			<ToolCallCard
				toolCall={{
					...readCall,
					arguments: { ...readCall.arguments, offset: 200 },
				}}
				result={readResult as any}
			/>,
		);
		fireEvent.click(screen.getByTestId("toolcall-r1-header"));
		const body = screen.getByTestId("toolcall-r1-body");
		const first = body.querySelector('[data-testid="read-line"]')!;
		expect(first.textContent).toContain("200");
		const truncated = screen.getByTestId("toolcall-r1-read-truncated");
		expect(truncated.textContent).toContain("10");
		expect(truncated.textContent).toContain("1850");
		expect(body.textContent).not.toContain("Showing lines");
	});
});

const bashCall = {
	type: "toolCall" as const,
	id: "sh1",
	name: "bash",
	arguments: { command: "bun test tests/a.test.ts", timeout: 300 },
};
const bashResult = {
	type: "toolResult" as const,
	id: "shr1",
	toolCallId: "sh1",
	toolName: "bash",
	content: [{ type: "text" as const, text: "177 pass\n0 fail" }],
	isError: false,
	timestamp: 2,
};

describe("ToolCallCard shell 卡片（终端卡）", () => {
	test("折叠态标题带「执行」、命令与 shell 标签", () => {
		render(<ToolCallCard toolCall={bashCall} />);
		const card = screen.getByTestId("toolcall-sh1");
		expect(card.textContent).toMatch(/执行|Run/);
		expect(card.textContent).toContain("bun test");
		expect(card.textContent).toMatch(/BASH/i);
	});

	test("折叠态 meta 不再出现「完成 0」式歧义：直接写「退出码 0」", () => {
		render(<ToolCallCard toolCall={bashCall} result={bashResult as any} />);
		const card = screen.getByTestId("toolcall-sh1");
		const header = screen.getByTestId("toolcall-sh1-header");
		// 成功态不再渲染「完成」+ 裸数字，而是明确的「退出码 0」
		expect(header.textContent).toContain("退出码 0");
		expect(header.textContent).not.toMatch(/完成\s*✓?\s*0/);
		expect(card.textContent).toContain("退出码 0");
	});

	test("展开后渲染终端块：提示符 + 命令 + 输出 + 退出码", () => {
		render(<ToolCallCard toolCall={bashCall} result={bashResult as any} />);
		fireEvent.click(screen.getByTestId("toolcall-sh1-header"));
		const term = screen.getByTestId("toolcall-sh1-shell");
		expect(term.textContent).toContain("$");
		expect(term.textContent).toContain("bun test tests/a.test.ts");
		expect(term.textContent).toContain("177 pass");
		expect(screen.getByTestId("toolcall-sh1-exit").textContent).toContain("0");
	});

	test("失败：退出码从正文解析并外显，正文里的提示不重复渲染", () => {
		const failed = {
			...bashResult,
			isError: true,
			content: [
				{ type: "text" as const, text: "error TS2307\n\nCommand exited with code 2" },
			],
		};
		render(<ToolCallCard toolCall={bashCall} result={failed as any} />);
		fireEvent.click(screen.getByTestId("toolcall-sh1-header"));
		const term = screen.getByTestId("toolcall-sh1-shell");
		expect(term.textContent).toContain("error TS2307");
		expect(term.textContent).not.toContain("Command exited");
		expect(screen.getByTestId("toolcall-sh1-exit").textContent).toContain("2");
	});

	test("完成后展开：卡片恢复不透明（折叠态才弱化）", () => {
		render(<ToolCallCard toolCall={bashCall} result={bashResult as any} />);
		const card = screen.getByTestId("toolcall-sh1");
		// 折叠态：历史卡弱化
		expect(card.className).toContain("opacity-55");
		fireEvent.click(screen.getByTestId("toolcall-sh1-header"));
		const opened = screen.getByTestId("toolcall-sh1");
		// 展开查看明细时不再透明，但 data-muted 语义保留（仍是历史卡）
		expect(opened.className).not.toContain("opacity-55");
		expect(opened.getAttribute("data-muted")).toBe("true");
	});

	test("显示执行耗时：assistant 时间戳到 toolResult 时间戳", () => {
		const result = { ...bashResult, timestamp: 2600 };
		render(
			<ToolCallCard toolCall={bashCall} result={result as any} startedAt={1000} />,
		);
		fireEvent.click(screen.getByTestId("toolcall-sh1-header"));
		expect(
			screen.getByTestId("toolcall-sh1-shell-duration").textContent,
		).toContain("1.6s");
	});

	test("powershell：标签为 PWSH，提示符为 >", () => {
		const call = {
			...bashCall,
			id: "ps1",
			name: "powershell",
			arguments: { command: "Get-ChildItem" },
		};
		const result = {
			...bashResult,
			toolCallId: "ps1",
			toolName: "powershell",
		};
		render(<ToolCallCard toolCall={call} result={result as any} />);
		expect(screen.getByTestId("toolcall-ps1").textContent).toMatch(/PWSH/i);
		fireEvent.click(screen.getByTestId("toolcall-ps1-header"));
		const term = screen.getByTestId("toolcall-ps1-shell");
		expect(term.textContent).toContain(">");
	});
});

const writeDocCall = {
	type: "toolCall" as const,
	id: "w1",
	name: "write",
	arguments: {
		path: ".superpowers/sdd/2026-10-24-image-annotation/progress.md",
		content: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
	},
};
const writeDocResult = {
	type: "toolResult" as const,
	id: "wr1",
	toolCallId: "w1",
	toolName: "write",
	content: [
		{
			type: "text" as const,
			text: "Successfully wrote to .superpowers/sdd/2026-10-24-image-annotation/progress.md",
		},
	],
	isError: false,
	timestamp: 3,
};

describe("ToolCallCard write 卡片（渐进摘要）", () => {
	test("折叠态标题带「写入」动作词与文件名", () => {
		render(<ToolCallCard toolCall={writeDocCall} />);
		const card = screen.getByTestId("toolcall-w1");
		expect(card.textContent).toMatch(/写入|Write/);
		expect(card.textContent).toContain("progress.md");
	});

	test("展开：默认 6 行预览 + 「展开其余 N 行」，点击后全部可见", () => {
		render(<ToolCallCard toolCall={writeDocCall} result={writeDocResult as any} />);
		fireEvent.click(screen.getByTestId("toolcall-w1-header"));
		const body = screen.getByTestId("toolcall-w1-body");
		expect(body.querySelectorAll('[data-testid="read-line"]').length).toBe(6);
		const toggle = screen.getByTestId("toolcall-w1-write-toggle");
		expect(toggle.textContent).toContain("4");
		fireEvent.click(toggle);
		expect(
			screen
				.getByTestId("toolcall-w1-body")
				.querySelectorAll('[data-testid="read-line"]').length,
		).toBe(10);
	});

	test("成功文案不平铺（只保留正文预览）", () => {
		render(<ToolCallCard toolCall={writeDocCall} result={writeDocResult as any} />);
		fireEvent.click(screen.getByTestId("toolcall-w1-header"));
		const body = screen.getByTestId("toolcall-w1-body");
		expect(body.textContent).not.toContain("Successfully wrote");
		expect(body.textContent).toContain("line 1");
	});
});

// ── edit/write 行数统计（卡片右侧 meta 的 +N -M）──

const editResultMsg = (
	over: Partial<ToolResultMessage> = {},
): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: "t1",
	toolName: "edit",
	content: [{ type: "text", text: "Done." }],
	isError: false,
	timestamp: 0,
	...over,
});

describe("editLineStats 纯函数", () => {
	test("优先用 result.details.diff：数 +行/-行，上下文与省略行不计", () => {
		// pi edit 返回的 diff 行格式：+<行号> 内容 / -<行号> 内容 / 空格开头=上下文 / "  ..."=省略
		const result = editResultMsg({
			details: {
				diff: "+12 \t<div>\n-5 \t<p>hi</p>\n 11 \t</div>\n  ...\n+13 \t</div>",
			},
		});
		expect(editLineStats("edit", editCall.arguments, result)).toEqual({
			added: 2,
			removed: 1,
		});
	});

	test("diff 的 +++/--- 文件头不计入", () => {
		const result = editResultMsg({
			details: { diff: "--- a/x.ts\n+++ b/x.ts\n+1 new\n-2 old" },
		});
		expect(editLineStats("edit", editCall.arguments, result)).toEqual({
			added: 1,
			removed: 1,
		});
	});

	test("执行中（无 result）→ 从 edits 参数推算", () => {
		// editCall：oldText 3 行 / newText 3 行
		expect(editLineStats("edit", editCall.arguments, undefined)).toEqual({
			added: 3,
			removed: 3,
		});
	});

	test("兼容平铺 oldText/newText 参数", () => {
		const args = {
			path: "a.ts",
			oldText: "const a = 1;\nconst b = 2;",
			newText: "const a = 2;",
		};
		expect(editLineStats("edit", args, undefined)).toEqual({
			added: 1,
			removed: 2,
		});
	});

	test("result 无 details → 回退参数推算", () => {
		expect(editLineStats("edit", editCall.arguments, editResultMsg())).toEqual({
			added: 3,
			removed: 3,
		});
	});

	test("失败结果 / 畸形或空参数 → null（不渲染无意义的统计）", () => {
		expect(
			editLineStats("edit", editCall.arguments, editResultMsg({ isError: true })),
		).toBeNull();
		expect(
			editLineStats("edit", { path: "a.ts", edits: [null] }, undefined),
		).toBeNull();
		expect(
			editLineStats(
				"edit",
				{ path: "a.ts", edits: [{ oldText: "", newText: "" }] },
				undefined,
			),
		).toBeNull();
	});

	test("write：content 行数为新增数，无删除数", () => {
		expect(
			editLineStats("write", { path: "a.md", content: "l1\nl2\nl3" }, undefined),
		).toEqual({
			added: 3,
			removed: 0,
		});
		expect(editLineStats("write", { path: "a.md" }, undefined)).toBeNull();
	});

	test("其他工具 → null", () => {
		expect(editLineStats("bash", { command: "ls" }, undefined)).toBeNull();
	});
});

describe("ToolCallCard 行数统计 meta", () => {
	test("edit 完成后卡片右侧显示 +N -M", () => {
		render(
			<ToolCallCard
				toolCall={editCall}
				result={editResultMsg({ details: { diff: "+10 x\n-3 y\n-4 z" } })}
			/>,
		);
		const stats = screen.getByTestId("toolcall-t1-stats");
		expect(stats.textContent).toContain("+1");
		expect(stats.textContent).toContain("-2");
	});

	test("edit 执行中（无 result）→ 按参数推算并显示", () => {
		render(<ToolCallCard toolCall={editCall} isStreaming />);
		const stats = screen.getByTestId("toolcall-t1-stats");
		expect(stats.textContent).toContain("+3");
		expect(stats.textContent).toContain("-3");
	});

	test("edit 失败结果 → 不显示统计", () => {
		render(
			<ToolCallCard
				toolCall={editCall}
				result={editResultMsg({ isError: true })}
			/>,
		);
		expect(screen.queryByTestId("toolcall-t1-stats")).toBeNull();
	});

	test("write 显示 +N（无删除数）", () => {
		render(<ToolCallCard toolCall={writeCall("a\nb\nc")} />);
		const stats = screen.getByTestId("toolcall-w1-stats");
		expect(stats.textContent).toContain("+3");
		expect(stats.textContent).not.toContain("-3");
	});

	test("非 edit/write 工具不显示统计", () => {
		const call = {
			type: "toolCall" as const,
			id: "t9",
			name: "bash",
			arguments: { command: "ls" },
		};
		render(<ToolCallCard toolCall={call} />);
		expect(screen.queryByTestId("toolcall-t9-stats")).toBeNull();
	});
});
