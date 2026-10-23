import { describe, expect, test } from "bun:test";
import {
	resolveClickKeys,
	translateMouseRow,
} from "../src/tui-host/click.ts";

/**
 * 点击回退（鼠标 → 键盘）解析器的纯函数契约。
 *
 * 背景：自定义对话框（如 pi-goal-x 的问卷）只实现键盘交互，pi-tui 的鼠标分发
 * 在没有 `handleMouse` 的组件上会一路落到「文本选择」，用户点击选项行等于没反应。
 * 宿主在组件未消费鼠标时按帧文本推断等价键盘序列，把点击翻译成 ↑↓ + Enter。
 *
 * 断言刻意用**真实的 pi-goal-x 帧**（含 ANSI 前景色）而不是裸文本，
 * 否则「ANSI 剥离」这一环会假绿。
 */

/** 模拟 pi-goal-x 的主题着色：每行都带 SGR 前景色 */
const fg = (code: string, text: string) => `\u001b[${code}m${text}\u001b[39m`;
const DIM = "90";
const ACCENT = "36";
const TEXT = "37";

/** 提案确认对话框（goal-questionnaire.ts 的渲染结果，缩略成 3 个选项） */
function draftDialog(overrides: Partial<{ options: string[]; selected: number }> = {}): string[] {
	const { options, selected = 0 } = overrides;
	const opts = options ?? [
		"Confirm — create this goal now",
		"Continue chatting — keep refining",
		"Cancel — discard this draft",
	];
	const lines = [
		fg(ACCENT, "─".repeat(64)),
		fg(ACCENT, " Confirm Goal Draft"),
		" " + fg(DIM, "Goal draft ready for confirmation."),
		"",
		" " + fg(DIM, "[目标] 修复智能体「读知识库却直接委派子智能体」的判定缺陷"),
		"",
	];
	opts.forEach((label, i) => {
		const isSel = i === selected;
		lines.push((isSel ? fg(ACCENT, "> ") : "  ") + fg(isSel ? ACCENT : TEXT, `${i + 1}. ${label}`) + (i === 0 ? fg("32", " ★") : ""));
	});
	lines.push("");
	lines.push(" " + fg(DIM, "↑↓ navigate • Enter select • Esc cancel"));
	lines.push(fg(ACCENT, "─".repeat(64)));
	return lines;
}

/** 选项行的帧下标（与 draftDialog 的排布耦合，改渲染时一起改） */
const OPTION1_ROW = 6;
const OPTION2_ROW = 7;
const OPTION3_ROW = 8;

describe("resolveClickKeys：编号选项", () => {
	test("点选项 3（当前选中 1）→ 下移两次 + 回车", () => {
		expect(resolveClickKeys(draftDialog(), OPTION3_ROW)).toEqual(["\u001b[B", "\u001b[B", "\r"]);
	});

	test("点选项 2（当前选中 1）→ 下移一次 + 回车", () => {
		expect(resolveClickKeys(draftDialog(), OPTION2_ROW)).toEqual(["\u001b[B", "\r"]);
	});

	test("点已选中的选项 1 → 只回车（不空转方向键）", () => {
		expect(resolveClickKeys(draftDialog(), OPTION1_ROW)).toEqual(["\r"]);
	});

	test("选中项在下方时向上移动（点 1、选中 3）→ 上移两次 + 回车", () => {
		expect(resolveClickKeys(draftDialog({ selected: 2 }), OPTION1_ROW)).toEqual(["\u001b[A", "\u001b[A", "\r"]);
	});

	test("选项文本折行的续行也算该选项（长对话框窄宽度下的常见形态）", () => {
		const lines = draftDialog();
		// 把选项 2 换成折成两行的长文本：续行不含编号，但属于选项 2
		lines[OPTION2_ROW] = "  " + fg(TEXT, "2. Continue chatting — keep refining");
		lines.splice(OPTION2_ROW + 1, 0, "     " + fg(TEXT, "the draft before creating it"));
		expect(resolveClickKeys(lines, OPTION2_ROW + 1)).toEqual(["\u001b[B", "\r"]);
	});
});

describe("resolveClickKeys：不该动的点击保持原位（返回 null）", () => {
	test("点标题行 → null", () => {
		expect(resolveClickKeys(draftDialog(), 1)).toBeNull();
	});

	test("点正文/上下文行 → null", () => {
		expect(resolveClickKeys(draftDialog(), 4)).toBeNull();
	});

	test("点选项块里的空行 → null（不能因为「上面是选项」就替用户按回车）", () => {
		const lines = draftDialog();
		// 选项与底部提示之间那一行是空的（见 draftDialog 的排布）
		expect(resolveClickKeys(lines, lines.length - 3)).toBeNull();
	});

	test("点底部提示行 → null", () => {
		const lines = draftDialog();
		expect(resolveClickKeys(lines, lines.length - 2)).toBeNull();
	});

	test("行下标越界 → null", () => {
		expect(resolveClickKeys(draftDialog(), 99)).toBeNull();
		expect(resolveClickKeys(draftDialog(), -1)).toBeNull();
	});

	test("帧里没有选项列表（纯文本面板）→ null", () => {
		expect(resolveClickKeys(["hello", "world"], 0)).toBeNull();
	});

	test("没有选项行的选中标记（无从推断当前项）→ null", () => {
		const lines = draftDialog({ selected: -1 });
		expect(resolveClickKeys(lines, OPTION2_ROW)).toBeNull();
	});

	test("正文里的行内编号（如「1. 复现步骤」）不会被当成选项块", () => {
		const lines = [
			" 复核清单",
			" 1. 复现步骤",
			" 2. 根因",
			"",
			fg(ACCENT, "> ") + fg(ACCENT, "1. Confirm — create this goal now"),
			"   " + fg(TEXT, "2. Cancel — discard this draft"),
			"",
			" " + fg(DIM, "↑↓ navigate • Enter select • Esc cancel"),
		];
		// 正文里的 "1. 复现步骤"：不在选项块内 → 不动作
		expect(resolveClickKeys(lines, 1)).toBeNull();
		// 真正的选项仍可点
		expect(resolveClickKeys(lines, 5)).toEqual(["\u001b[B", "\r"]);
	});
});

describe("resolveClickKeys：对话框自带的可点击提示", () => {
	test("带 (press 'a' to toggle) 的开关行 → 直接发那个键", () => {
		const lines = draftDialog();
		lines.splice(
			OPTION1_ROW - 1,
			0,
			" " + fg("32", "● Auditor enabled") + fg(DIM, "  (press 'a' to toggle)"),
		);
		expect(resolveClickKeys(lines, OPTION1_ROW - 1)).toEqual(["a"]);
	});
});

describe("translateMouseRow：帧行 → 终端视口行", () => {
	/** 前端发的是**帧行**（用户点的是画面上那一行），而 pi-tui 的 SGR 坐标是终端屏幕行 */
	const mouse = (phase: "down" | "up", row: number) =>
		`\u001b[<0;8;${row}${phase === "up" ? "m" : "M"}`;

	test("长帧：帧行减去视口偏移（frameLines - terminalRows）", () => {
		// 37 行帧、17 行终端：alt-screen 视口停在底部、偏移 20 行
		expect(translateMouseRow(mouse("down", 34), 37, 17)).toBe(
			"\u001b[<0;8;14M",
		);
		expect(translateMouseRow(mouse("up", 34), 37, 17)).toBe("\u001b[<0;8;14m");
	});

	test("视口首行（帧行 = 偏移 + 1）→ 终端第 1 行", () => {
		expect(translateMouseRow(mouse("down", 21), 37, 17)).toBe(
			"\u001b[<0;8;1M",
		);
	});

	test("视口之外的帧行 → null（终端里没有这一行，宁可丢掉也不折算到别的行）", () => {
		expect(translateMouseRow(mouse("down", 20), 37, 17)).toBeNull();
		expect(translateMouseRow(mouse("down", 1), 37, 17)).toBeNull();
	});

	test("短帧（装得下）→ 偏移 0，原样透传", () => {
		expect(translateMouseRow(mouse("down", 3), 5, 17)).toBe(
			"\u001b[<0;8;3M",
		);
	});

	test("滚轮与右键同样翻译（行决定命中哪个滚动容器/组件）", () => {
		expect(translateMouseRow("\u001b[<64;8;34M", 37, 17)).toBe(
			"\u001b[<64;8;14M",
		);
		expect(translateMouseRow("\u001b[<2;8;34M", 37, 17)).toBe(
			"\u001b[<2;8;14M",
		);
	});

	test("非鼠标序列原样返回（按键/粘贴/尺寸上报都走同一条 inject）", () => {
		expect(translateMouseRow("\u001b[B", 37, 17)).toBe("\u001b[B");
		expect(translateMouseRow("a", 37, 17)).toBe("a");
		expect(translateMouseRow("", 37, 17)).toBe("");
	});

	test("终端行数或帧行数不合法时不动它（不猜）", () => {
		expect(translateMouseRow(mouse("down", 3), 0, 0)).toBe(mouse("down", 3));
		expect(translateMouseRow(mouse("down", 0), 37, 17)).toBeNull();
	});
});
