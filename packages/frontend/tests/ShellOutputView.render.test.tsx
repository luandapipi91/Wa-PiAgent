// ShellOutputView 组件渲染测试（第一层 parse + 第二层 DOM）
//
// 背景（pi 1.6.1）：bash 工具在「输出被截断且全量输出未能落盘」时，
// 正文页脚变成 "Could not save the full output: <原因>"，details 也从
// fullOutputPath 换成 fullOutputError。用户必须能看到「为什么没有完整输出文件」，
// 而不是只看到一句「输出已截断」。
import { test, expect, describe } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
	ShellOutputView,
	parseShellResult,
} from "../src/components/blocks/ShellOutputView";

const textOf = (text: string) => [{ type: "text" as const, text }];

describe("ShellOutputView 渲染「存盘失败」状态", () => {
	test("details.fullOutputError → 页脚显示失败原因而不是文件路径", () => {
		const view = parseShellResult(
			textOf("line1\n\n[Showing lines 1-1 of 9999. Could not save the full output: ENOSPC]"),
			{
				truncation: { truncated: true, outputLines: 1, totalLines: 9999 },
				fullOutputError: "ENOSPC: no space left on device",
			},
			false,
		);
		render(
			<ShellOutputView
				shell="bash"
				command="yes"
				view={view}
				testId="shell-save-failed"
			/>,
		);
		const card = screen.getByTestId("shell-save-failed");
		// 正文不含页脚原文
		expect(card.textContent).not.toContain("Could not save the full output");
		expect(card.textContent).not.toContain("Showing lines");
		// 失败原因要可见
		expect(screen.getByTestId("shell-save-failed-full-output-error")).toBeTruthy();
		expect(card.textContent).toContain("no space left on device");
	});

	test("details.fullOutputPath → 页脚显示文件路径（存盘成功路径不回归）", () => {
		const view = parseShellResult(
			textOf("line1\n\n[Showing lines 1-1 of 9999. Full output: /tmp/pi-bash-9.log]"),
			{
				truncation: { truncated: true, outputLines: 1, totalLines: 9999 },
				fullOutputPath: "/tmp/pi-bash-9.log",
			},
			false,
		);
		render(
			<ShellOutputView
				shell="bash"
				command="yes"
				view={view}
				testId="shell-save-ok"
			/>,
		);
		const card = screen.getByTestId("shell-save-ok");
		expect(card.textContent).toContain("/tmp/pi-bash-9.log");
		expect(screen.queryByTestId("shell-save-ok-full-output-error")).toBeNull();
	});
});
