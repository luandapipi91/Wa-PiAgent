import { describe, expect, test } from "bun:test";
import { WaPiFakeTerminal } from "../src/tui-host/terminal.ts";

describe("WaPiFakeTerminal", () => {
	test("默认字符网格 85×24", () => {
		const t = new WaPiFakeTerminal();
		expect(t.columns).toBe(85);
		expect(t.rows).toBe(24);
	});

	test("start 保存回调，inject 把按键原样交给 onInput", () => {
		const t = new WaPiFakeTerminal();
		const seen: string[] = [];
		t.start((d) => seen.push(d), () => {});
		t.inject("\u001b[A");
		t.inject("a");
		expect(seen).toEqual(["\u001b[A", "a"]);
	});

	test("resize 更新尺寸并触发 onResize；同尺寸不重复触发", () => {
		const t = new WaPiFakeTerminal();
		let n = 0;
		t.start(() => {}, () => { n += 1; });
		t.resize(100, 30);
		expect(t.columns).toBe(100);
		expect(t.rows).toBe(30);
		expect(n).toBe(1);
		t.resize(100, 30);
		expect(n).toBe(1);
	});

	test("尺寸有下限保护：最小 20 列 × 5 行", () => {
		const t = new WaPiFakeTerminal();
		t.resize(3, 1);
		expect(t.columns).toBe(20);
		expect(t.rows).toBe(5);
	});

	test("write 丢弃字节并计数；kittyProtocolActive 恒为 false", () => {
		const t = new WaPiFakeTerminal();
		t.write("\u001b[2J\u001b[H");
		expect(t.bytesDiscarded).toBe(7);
		expect(t.kittyProtocolActive).toBe(false);
	});

	test("stop 之后 inject 不再投递", () => {
		const t = new WaPiFakeTerminal();
		const seen: string[] = [];
		t.start((d) => seen.push(d), () => {});
		t.stop();
		t.inject("a");
		expect(seen).toEqual([]);
	});
});
