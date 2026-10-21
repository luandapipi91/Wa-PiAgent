// pi-tui 真实组件（Input / Editor）的中文 IME 文本注入测试——第三层 API 集成验证的组件半。
//
// 关注点：整串中文经假终端注入后，pi-tui 组件按整串插入（一行内连续可见），
// 且 CJK 按 2 列宽参与宽度计算：换行不把汉字劈成两半、每行可见宽度不超过终端宽度（不破格）。
//
// 既有覆盖引用（避免重复断言）：
// - tests/tui-host-terminal.test.ts「start 保存回调，inject 把按键原样交给 onInput」
//   已证明假终端把 inject 的字符串原样（不拆分、不改写）交给 onInput；
// - tests/tui-host-frame.test.ts「定位并剥离光标标记，按可见宽度算列号（CJK 占两格）」
//   已证明 extractFrame 用 pi-tui 的 visibleWidth 计算光标列（CJK 占两格）。
// 本次新增的断言是：把整串中文真正喂给 pi-tui 的 Input/Editor 组件后，
// **组件渲染出的帧**里中文整串连续出现、光标列等于 visibleWidth 之和（而非 UTF-16 码元数），
// 换行后无字符被劈开、每行可见宽度都不超过终端宽度。
import { describe, expect, test } from "bun:test";
import {
	type Component,
	Editor,
	Input,
	TuiAltScreen,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { WaPiFakeTerminal } from "../src/tui-host/terminal.ts";
import { extractFrame } from "../src/tui-host/frame.ts";

/** 中文样例：4 个汉字，UTF-16 长度 4，可见宽度 8（每个占 2 列） */
const 中文串 = "你好世界";

/** pi-tui 的 Editor 需要最小主题：只用到 borderColor 与 selectList 的透传函数 */
const 最小主题 = {
	borderColor: (s: string) => s,
	selectList: {
		selectedPrefix: (t: string) => t,
		selectedText: (t: string) => t,
		description: (t: string) => t,
		scrollInfo: (t: string) => t,
		noMatch: (t: string) => t,
	},
	// Editor 的构造签名来自 pi-tui，主题类型只在 pi-coding-agent 里，这里用 never 兜类型
} as never;

/**
 * 建真实 TuiAltScreen + 假终端，挂载组件并聚焦。
 * 与 src/tui-host/panel.ts 的宿主同款接法（addChild + setFocus + start），
 * 区别是本测试直接拿组件自己渲染的帧，不经过 createPanelHost 的采样节流。
 */
function 建宿主(建组件: (tui: TuiAltScreen) => Component, cols: number) {
	const terminal = new WaPiFakeTerminal({ cols, rows: 12 });
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const 组件 = 建组件(tui);
	tui.addChild(组件);
	tui.setFocus(组件);
	tui.start();
	return { terminal, tui };
}

describe("pi-tui 真实组件的中文整串注入", () => {
	test("Input：整串中文注入后 value 为整串，帧内中文连续出现", () => {
		const input = new Input({ prompt: "> " });
		const { terminal, tui } = 建宿主(() => input, 40);
		terminal.inject(中文串);

		// 整串进、整串存：value 与原串完全相同
		expect(input.getValue()).toBe(中文串);

		const frame = extractFrame(tui.render(40));
		// 整串在同一行内连续出现（未被拆成多行、未插入额外字符）
		expect(frame.lines.some((l) => l.includes(中文串))).toBe(true);
		tui.stop();
	});

	test("Input：中文按 2 列宽参与光标列计算（不是 UTF-16 码元数）", () => {
		const input = new Input({ prompt: "> " });
		const { terminal, tui } = 建宿主(() => input, 40);
		terminal.inject(中文串);

		const frame = extractFrame(tui.render(40));
		// 光标落在整串末尾：prompt(2 列) + 4 个汉字 × 2 列 = 10
		expect(frame.cursor).toEqual({ row: 0, col: 2 + visibleWidth(中文串) });
		expect(frame.cursor?.col).toBe(10);
		// 反证：若按 UTF-16 码元数算会是 2 + 4 = 6，那才是「按 1 列宽」的错误行为
		expect(frame.cursor?.col).not.toBe(2 + 中文串.length);
		tui.stop();
	});

	test("Editor：整串中文渲染在同一行内，光标列按 2 列宽计（padding + 汉字宽）", () => {
		const { terminal, tui } = 建宿主(
			(t) => new Editor(t, 最小主题, { paddingX: 1 }),
			40,
		);
		terminal.inject(中文串);

		const frame = extractFrame(tui.render(40));
		// 中文内容行（去掉纯边框行）里含整串
		const 内容行 = frame.lines.filter((l) => !/^[─\s]*$/.test(l));
		expect(内容行.some((l) => l.includes(中文串))).toBe(true);
		// 光标列 = 左侧 padding(1 列) + 4 个汉字 × 2 列 = 9
		expect(frame.cursor).toEqual({ row: 1, col: 1 + visibleWidth(中文串) });
		tui.stop();
	});

	test("Editor：长中文串换行时每行不超过终端宽度、汉字不被劈开（不破格）", () => {
		const 长串 = 中文串 + 中文串; // 8 个汉字 = 16 列，超出 12 列终端必然换行
		const { terminal, tui } = 建宿主(
			(t) => new Editor(t, 最小主题, { paddingX: 1 }),
			12,
		);
		terminal.inject(长串);

		const lines = tui.render(12);
		// 不破格：每一行的可见宽度都不超过终端列数
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		}
		// 不劈字：去掉边框行、终端转义与空白后，可见文本恰好等于原整串——
		// 若换行把某个汉字劈成两半，这里既会出现替换符，也会少字，无法还原
		const 可见文本 = extractFrame(lines)
			.lines.map((l) => stripTerminalSequences(l))
			.filter((l) => !/^[─\s]*$/.test(l))
			.map((l) => l.replace(/\s+/g, ""))
			.join("");
		expect(可见文本).toBe(长串);
		tui.stop();
	});
});
