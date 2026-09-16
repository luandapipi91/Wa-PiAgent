import { describe, expect, test } from "bun:test";
import {
	isWideChar,
	parseSgrSpans,
	splitByCellWidth,
	stripOsc,
	takeLinks,
} from "./tui-ansi";

describe("parseSgrSpans", () => {
	test("无 ANSI 时返回单段纯文本", () => {
		expect(parseSgrSpans("hello")).toEqual([{ text: "hello", attrs: {} }]);
	});

	test("解析粗体与下划线，并在 reset 处结束", () => {
		const spans = parseSgrSpans("\u001b[1;4m重点\u001b[0m普通");
		expect(spans).toEqual([
			{ text: "重点", attrs: { bold: true, underline: true } },
			{ text: "普通", attrs: {} },
		]);
	});

	test("反显与暗色属性", () => {
		const spans = parseSgrSpans("\u001b[7mA\u001b[2mB\u001b[0m");
		expect(spans).toEqual([
			{ text: "A", attrs: { inverse: true } },
			{ text: "B", attrs: { dim: true, inverse: true } },
		]);
	});

	test("非 SGR（光标/清屏）序列被丢弃，不外泄到文本", () => {
		expect(parseSgrSpans("a\u001b[2Kb")).toEqual([{ text: "ab", attrs: {} }]);
	});
});

describe("isWideChar / splitByCellWidth（终端「全角占两格」语义）", () => {
	test("汉字/假名/谚文/全角形式算两格", () => {
		for (const ch of [
			"中",
			"文",
			"、",
			"。",
			"あ",
			"ア",
			"한",
			"Ａ",
			"１",
			"￥",
			"　",
		]) {
			expect([ch, isWideChar(ch.codePointAt(0)!)]).toEqual([ch, true]);
		}
	});

	test("ASCII 与 East Asian Ambiguous（如 ▸ ○ ·）算一格", () => {
		for (const ch of ["a", "Z", "9", " ", "·", "▸", "○", "—", "€"]) {
			expect([ch, isWideChar(ch.codePointAt(0)!)]).toEqual([ch, false]);
		}
	});

	test("按全角/半角把一行切成片段（全角片段整体占两倍的格数）", () => {
		expect(splitByCellWidth("▸ 中文 ok")).toEqual([
			{ text: "▸ ", wide: false },
			{ text: "中文", wide: true },
			{ text: " ok", wide: false },
		]);
		// 无全角字符时只有一段、且是半角段（调用方据此走原路径，不产生额外节点）
		expect(splitByCellWidth("plain")).toEqual([{ text: "plain", wide: false }]);
		expect(splitByCellWidth("")).toEqual([]);
	});

	test("代理对（CJK 扩展 B 的汉字）不会被拆坏", () => {
		const ch = "\u{20000}";
		expect(splitByCellWidth(`a${ch}b`)).toEqual([
			{ text: "a", wide: false },
			{ text: ch, wide: true },
			{ text: "b", wide: false },
		]);
	});
});

describe("stripOsc / takeLinks", () => {
	test("剥离 OSC 8 之外的所有 OSC（如 OSC 52 剪贴板）", () => {
		expect(stripOsc("a\u001b]52;c;Zm9v\u0007b")).toBe("ab");
	});

	test("抽取 OSC 8 链接的文本与 URL", () => {
		const links = takeLinks(
			"看\u001b]8;;https://x.dev\u0007这里\u001b]8;;\u0007！",
		);
		expect(links).toEqual([{ text: "这里", url: "https://x.dev" }]);
		expect(
			stripOsc("看\u001b]8;;https://x.dev\u0007这里\u001b]8;;\u0007！"),
		).toBe("看这里！");
	});
});
