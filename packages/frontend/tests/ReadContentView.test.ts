import { test, expect, describe } from "bun:test";
import { parseReadResult } from "../src/components/blocks/ReadContentView";

// pi read 工具的正文尾部提示格式（见 pi-coding-agent core/tools/read.js）：
//   "\n\n[Showing lines 1-200 of 1850. Use offset=201 to continue.]"
//   "\n\n[Showing lines 1-200 of 1850 (16KB limit). Use offset=201 to continue.]"
//   "\n\n[300 more lines in file. Use offset=201 to continue.]"
//   "[Line 1 is 20KB, exceeds 16KB limit. Use bash: ...]"
const textOf = (text: string) => [{ type: "text" as const, text }];

describe("parseReadResult 解析 read 结果", () => {
	test("无截断：返回全部行，行号从 1 开始", () => {
		const r = parseReadResult(textOf("a\nb\nc"), {});
		expect(r.lines).toEqual(["a", "b", "c"]);
		expect(r.startLine).toBe(1);
		expect(r.truncation).toBeNull();
	});

	test("offset 指定起始行：行号从 offset 开始", () => {
		const r = parseReadResult(textOf("x\ny"), { offset: 200 });
		expect(r.startLine).toBe(200);
		expect(r.lines).toEqual(["x", "y"]);
	});

	test("剥离 [Showing lines X-Y of N] 提示，并用它给出截断信息", () => {
		const r = parseReadResult(
			textOf("l1\nl2\n\n[Showing lines 1-2 of 1850. Use offset=3 to continue.]"),
			{},
		);
		expect(r.lines).toEqual(["l1", "l2"]);
		expect(r.truncation).toEqual({ shown: 2, total: 1850 });
	});

	test("带字节限制的 Showing lines 提示同样剥离", () => {
		const r = parseReadResult(
			textOf("l1\n\n[Showing lines 1-1 of 900 (16KB limit). Use offset=2 to continue.]"),
			{},
		);
		expect(r.lines).toEqual(["l1"]);
		expect(r.truncation).toEqual({ shown: 1, total: 900 });
	});

	test("[N more lines in file] 提示：总数 = 已显示 + N", () => {
		const r = parseReadResult(
			textOf("a\nb\n\n[194 more lines in file. Use offset=201 to continue.]"),
			{ limit: 6 },
		);
		expect(r.lines).toEqual(["a", "b"]);
		expect(r.truncation).toEqual({ shown: 2, total: 196 });
	});

	test("details.truncation 优先于正文提示（outputLines / totalLines）", () => {
		const r = parseReadResult(
			textOf("a\n\n[Showing lines 1-1 of 1850. Use offset=2 to continue.]"),
			{},
			{ truncation: { truncated: true, outputLines: 1, totalLines: 1850 } },
		);
		expect(r.truncation).toEqual({ shown: 1, total: 1850 });
	});

	test("首行超限提示保留为 notice，不当成正文行", () => {
		const r = parseReadResult(
			textOf("[Line 1 is 20KB, exceeds 16KB limit. Use bash: sed -n '1p' x | head -c 16384]"),
			{},
		);
		expect(r.lines).toEqual([]);
		expect(r.notice).toContain("exceeds");
	});

	test("空内容 / 非文本内容不崩溃", () => {
		expect(parseReadResult([], {})).toEqual({
			lines: [],
			startLine: 1,
			truncation: null,
			notice: null,
		});
		expect(parseReadResult([{ type: "image" } as any], {})).toEqual({
			lines: [],
			startLine: 1,
			truncation: null,
			notice: null,
		});
	});
});
