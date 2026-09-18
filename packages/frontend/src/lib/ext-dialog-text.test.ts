// 扩展弹窗文本归一化：pi 的对话框正文常是**终端画出来的**排版
// （pi-goal-x 的 goal-draft.ts:34 会给目标每一行加 `│   ` 前缀，分节线是 `─── X ───`）。
// 直接丢给 markdown 解析器，被前缀挡住的表格/清单/标题全都解析不出来
// —— 用户看到的就是「表格没渲染出来」。这里把装饰还原成 markdown 结构。
import { describe, expect, test } from "bun:test";
import { normalizeDialogText } from "./ext-dialog-text";

describe("normalizeDialogText", () => {
	test("去掉行首的框线前缀，被挡住的 markdown 表格还原成表格", () => {
		const input = [
			"│   | 阶段 | 产出 |",
			"│   | --- | --- |",
			"│   | 一 | 验证报告 |",
		].join("\n");
		expect(normalizeDialogText(input)).toBe(
			["| 阶段 | 产出 |", "| --- | --- |", "| 一 | 验证报告 |"].join("\n"),
		);
	});

	test("分节线转成 markdown 小标题（─── / === / ┌─ X ─┐ 三种写法）", () => {
		expect(normalizeDialogText("─── Draft Details ───")).toBe(
			"### Draft Details",
		);
		expect(normalizeDialogText("=== Goal ===")).toBe("### Goal");
		expect(normalizeDialogText("┌─ TASKS ─────────────────────┐")).toBe(
			"### TASKS",
		);
	});

	test("去掉行尾的框线（方框行两侧都有边）", () => {
		expect(normalizeDialogText("│ [ ] task-1：确认契约          │")).toBe(
			"[ ] task-1：确认契约",
		);
		expect(normalizeDialogText("│   Mode: Normal goal")).toBe("Mode: Normal goal");
	});

	test("纯装饰线（无标题）整行丢掉：GUI 里没有意义", () => {
		expect(normalizeDialogText("────────────────────────")).toBe("");
		expect(normalizeDialogText("└──────────────────────┘")).toBe("");
	});

	test("pi-goal-x 提案确认的真实形态：整体还原成可解析的 markdown", () => {
		const input = [
			"● Goal draft ready for confirmation.",
			"",
			"─── Draft Details ───",
			"│   Mode: Normal goal",
			"│   Auto-continue: yes",
			"",
			"─── Original Topic ───",
			"",
			"│   端到端演示一次目标流程",
			"",
			"─── Proposed Goal ───",
			"",
			"│   **目标**：完成一次演示",
			"│   | 阶段 | 产出 |",
			"│   | --- | --- |",
			"│   | 一 | 验证报告 |",
			"",
			"┌─ TASKS ──────────────────────┐",
			"│ [ ] task-1：确认 goal 契约    │",
			"│ [ ] task-2：执行任务流        │",
			"└──────────────────────────────┘",
		].join("\n");
		expect(normalizeDialogText(input)).toBe(
			[
				"● Goal draft ready for confirmation.",
				"### Draft Details",
				"Mode: Normal goal",
				"Auto-continue: yes",
				"### Original Topic",
				"端到端演示一次目标流程",
				"### Proposed Goal",
				"**目标**：完成一次演示",
				"",
				"| 阶段 | 产出 |",
				"| --- | --- |",
				"| 一 | 验证报告 |",
				"### TASKS",
				"[ ] task-1：确认 goal 契约",
				"[ ] task-2：执行任务流",
			].join("\n"),
		);
	});

	test("块级结构前补一个空行：pi 把目标里的空行丢了，表格/清单会贴到上一段上就不是表格了", () => {
		const input = [
			"正文一段",
			"| 阶段 | 产出 |",
			"| --- | --- |",
			"| 一 | 报告 |",
			"- 第一条",
		].join("\n");
		expect(normalizeDialogText(input)).toBe(
			["正文一段", "", "| 阶段 | 产出 |", "| --- | --- |", "| 一 | 报告 |", "", "- 第一条"].join("\n"),
		);
	});

	test("表格后面要补空行：否则紧随其后的正文会被当成表格行吞进去", () => {
		const input = [
			"| a | b |",
			"| --- | --- |",
			"| 1 | 2 |",
			"**边界**：仅限演示流程。",
		].join("\n");
		expect(normalizeDialogText(input)).toBe(
			["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "**边界**：仅限演示流程。"].join("\n"),
		);
	});

	test("表格前的空行要保留（markdown 表格必须另起一块，否则解析不出表格）", () => {
		const input = ["正文一段", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
		expect(normalizeDialogText(input)).toBe(input);
	});

	test("普通正文不受影响（无装饰前缀的文本原样返回）", () => {
		const plain = "demo select：选一个\n\n第二段：确认继续吗？";
		expect(normalizeDialogText(plain)).toBe(plain);
	});

	test("不动 ASCII 竖线的正常 markdown 表格（`|` 与框线 `│` 是不同字符）", () => {
		const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
		expect(normalizeDialogText(md)).toBe(md);
	});
});
