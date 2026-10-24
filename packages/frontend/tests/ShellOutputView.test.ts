import { test, expect, describe } from "bun:test";
import { parseShellResult, formatDuration } from "../src/components/blocks/ShellOutputView";

// pi bash 工具的输出约定（见 pi-coding-agent core/tools/bash.js）：
//   非 0 退出码 → 抛错，输出末尾追加 "\n\nCommand exited with code N"
//   截断时正文尾部带 "[Full output: <path>. Truncated: showing X of Y lines]"
//   details: { truncation, fullOutputPath }
const textOf = (text: string) => [{ type: "text" as const, text }];

describe("formatDuration 耗时格式化", () => {
	test("<1s 用毫秒，<60s 用一位小数秒，否则分秒", () => {
		expect(formatDuration(850)).toBe("850ms");
		expect(formatDuration(1600)).toBe("1.6s");
		expect(formatDuration(72_000)).toBe("1m 12s");
	});

	test("非法/负值返回空串", () => {
		expect(formatDuration(-1)).toBe("");
		expect(formatDuration(Number.NaN)).toBe("");
	});
});

describe("parseShellResult 解析 shell 结果", () => {
	test("成功输出：exitCode 0，正文原样", () => {
		const r = parseShellResult(textOf("177 pass\n0 fail"), undefined, false);
		expect(r.output).toBe("177 pass\n0 fail");
		expect(r.exitCode).toBe(0);
		expect(r.truncated).toBeNull();
		expect(r.fullOutputPath).toBeNull();
	});

	test("失败输出：从末尾剥离 Command exited with code N 并解析退出码", () => {
		const r = parseShellResult(
			textOf("src/a.ts(1,1): error TS2307\n\nCommand exited with code 2"),
			undefined,
			true,
		);
		expect(r.exitCode).toBe(2);
		expect(r.output).toBe("src/a.ts(1,1): error TS2307");
	});

	test("失败但正文没有退出码（超时/中断）：exitCode 为 null，正文保留", () => {
		const r = parseShellResult(
			textOf("partial output\n\nCommand timed out after 300 seconds"),
			undefined,
			true,
		);
		expect(r.exitCode).toBeNull();
		expect(r.output).toContain("timed out");
	});

	test("剥离 [Full output: ... Truncated: showing X of Y lines] 并解析", () => {
		const r = parseShellResult(
			textOf(
				"line1\nline2\n\n[Full output: C:\\Temp\\pi-bash-1.log. Truncated: showing 200 of 2000 lines]",
			),
			{ truncation: { truncated: true, outputLines: 200, totalLines: 2000 } },
			false,
		);
		expect(r.output).toBe("line1\nline2");
		expect(r.fullOutputPath).toBe("C:\\Temp\\pi-bash-1.log");
		expect(r.truncated).toEqual({ shown: 200, total: 2000 });
	});

	test("details.truncation 优先于正文提示", () => {
		const r = parseShellResult(
			textOf("a\n\n[Truncated: showing 10 of 99 lines]"),
			{ truncation: { truncated: true, outputLines: 20, totalLines: 200 } },
			false,
		);
		expect(r.truncated).toEqual({ shown: 20, total: 200 });
	});

	test("空内容 / 无文本块不崩溃", () => {
		expect(parseShellResult([], undefined, false)).toEqual({
			output: "",
			exitCode: 0,
			truncated: null,
			fullOutputPath: null,
		});
		expect(parseShellResult([{ type: "image" } as any], undefined, false).output).toBe("");
	});
});
