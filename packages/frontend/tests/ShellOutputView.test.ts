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
			fullOutputError: null,
		});
		expect(parseShellResult([{ type: "image" } as any], undefined, false).output).toBe("");
	});
});

// ===== pi 1.6.1：bash 截断页脚的格式与「存盘失败」分支 =====
// pi 1.6.0/1.6.1 的 formatOutput（pi-coding-agent dist/core/tools/bash.js）实际写的是
//   \n\n[Showing lines A-B of C. Full output: <path>]
//   \n\n[Showing lines A-B of C. Could not save the full output: <reason>]   ← 1.6.1 新增
//   \n\n[Showing last <size> of line N (line is <size>). <同上后缀>]        ← 长单行截断
// 老版本（0.x）才是 "[Full output: path. Truncated: showing X of Y lines]"。
// 升级前正文页脚一直没被剥离，靠 details.truncation 兜住数字、页脚原样留在输出里；
// 1.6.1 把「存盘失败」也做成页脚后，用户会在输出末尾看到这句英文（且无法定位文件）。

describe("pi 1.6.1 截断页脚解析", () => {
	test("剥离 [Showing lines A-B of C. Full output: path]", () => {
		const r = parseShellResult(
			textOf(
				"line1\nline2\n\n[Showing lines 1801-2000 of 2000. Full output: /tmp/pi-bash-1.log]",
			),
			undefined,
			false,
		);
		expect(r.output).toBe("line1\nline2");
		expect(r.fullOutputPath).toBe("/tmp/pi-bash-1.log");
		expect(r.fullOutputError).toBeNull();
		expect(r.truncated).toEqual({ shown: 200, total: 2000 });
	});

	test("剥离字节上限变体 [Showing lines A-B of C (NKB limit). Full output: path]", () => {
		const r = parseShellResult(
			textOf(
				"l1\n\n[Showing lines 1801-2000 of 2000 (51200KB limit). Full output: /tmp/pi-bash-2.log]",
			),
			undefined,
			false,
		);
		expect(r.output).toBe("l1");
		expect(r.fullOutputPath).toBe("/tmp/pi-bash-2.log");
		expect(r.truncated).toEqual({ shown: 200, total: 2000 });
	});

	test("剥离存盘失败页脚 → fullOutputError 带原因，不进正文", () => {
		const r = parseShellResult(
			textOf(
				"l1\nl2\n\n[Showing lines 1801-2000 of 2000. Could not save the full output: ENOSPC: no space left on device]",
			),
			undefined,
			false,
		);
		expect(r.output).toBe("l1\nl2");
		expect(r.fullOutputPath).toBeNull();
		expect(r.fullOutputError).toBe("ENOSPC: no space left on device");
		expect(r.truncated).toEqual({ shown: 200, total: 2000 });
	});

	test("剥离长单行截断页脚 [Showing last X of line N (line is Y). …]", () => {
		const withPath = parseShellResult(
			textOf(
				"a\n\n[Showing last 25KB of line 3 (line is 80KB). Full output: /tmp/pi-bash-3.log]",
			),
			undefined,
			false,
		);
		expect(withPath.output).toBe("a");
		expect(withPath.fullOutputPath).toBe("/tmp/pi-bash-3.log");

		const failed = parseShellResult(
			textOf(
				"a\n\n[Showing last 25KB of line 3 (line is 80KB). Could not save the full output: EACCES: permission denied]",
			),
			undefined,
			false,
		);
		expect(failed.output).toBe("a");
		expect(failed.fullOutputError).toBe("EACCES: permission denied");
	});

	test("details.fullOutputError 优先于正文页脚", () => {
		const r = parseShellResult(
			textOf("l1\n\n[Showing lines 1-2 of 2. Full output: /tmp/x.log]"),
			{
				truncation: { truncated: true, outputLines: 200, totalLines: 2000 },
				fullOutputError: "EMFILE: too many open files",
			},
			false,
		);
		expect(r.fullOutputError).toBe("EMFILE: too many open files");
		expect(r.fullOutputPath).toBeNull();
	});

	test("details.fullOutputPath 与页脚并存时以 details 为准", () => {
		const r = parseShellResult(
			textOf("l1\n\n[Showing lines 1-2 of 2. Could not save the full output: ENOSPC]"),
			{
				truncation: { truncated: true, outputLines: 2, totalLines: 2 },
				fullOutputPath: "/tmp/real.log",
			},
			false,
		);
		expect(r.fullOutputPath).toBe("/tmp/real.log");
		expect(r.fullOutputError).toBeNull();
	});

	test("退出码页脚与截断页脚同时存在时两者都剥离", () => {
		const r = parseShellResult(
			textOf(
				"oops\n\n[Showing lines 1-1 of 9999. Full output: /tmp/pi-bash-4.log]\n\nCommand exited with code 2",
			),
			undefined,
			true,
		);
		expect(r.exitCode).toBe(2);
		expect(r.output).toBe("oops");
		expect(r.fullOutputPath).toBe("/tmp/pi-bash-4.log");
	});

	test("老格式页脚仍然兼容（历史会话回读）", () => {
		const r = parseShellResult(
			textOf("l1\n\n[Full output: /old/path.log. Truncated: showing 200 of 2000 lines]"),
			undefined,
			false,
		);
		expect(r.output).toBe("l1");
		expect(r.fullOutputPath).toBe("/old/path.log");
		expect(r.truncated).toEqual({ shown: 200, total: 2000 });
	});
});
