import { describe, expect, test } from "bun:test";
import { parseSgrSpans, stripOsc, takeLinks } from "./tui-ansi";

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

describe("stripOsc / takeLinks", () => {
	test("剥离 OSC 8 之外的所有 OSC（如 OSC 52 剪贴板）", () => {
		expect(stripOsc("a\u001b]52;c;Zm9v\u0007b")).toBe("ab");
	});

	test("抽取 OSC 8 链接的文本与 URL", () => {
		const links = takeLinks("看\u001b]8;;https://x.dev\u0007这里\u001b]8;;\u0007！");
		expect(links).toEqual([{ text: "这里", url: "https://x.dev" }]);
		expect(stripOsc("看\u001b]8;;https://x.dev\u0007这里\u001b]8;;\u0007！")).toBe("看这里！");
	});
});
