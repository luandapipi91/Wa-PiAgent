import { describe, expect, test } from "bun:test";
import {
	encodeKey,
	encodeMouse,
	encodePaste,
	encodeWheel,
	isComposingKey,
} from "./tui-keys";

const base = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe("encodeKey", () => {
	test("方向键与常用导航键", () => {
		expect(encodeKey({ ...base, key: "ArrowUp" })).toBe("\u001b[A");
		expect(encodeKey({ ...base, key: "ArrowDown" })).toBe("\u001b[B");
		expect(encodeKey({ ...base, key: "ArrowRight" })).toBe("\u001b[C");
		expect(encodeKey({ ...base, key: "ArrowLeft" })).toBe("\u001b[D");
		expect(encodeKey({ ...base, key: "Home" })).toBe("\u001b[H");
		expect(encodeKey({ ...base, key: "End" })).toBe("\u001b[F");
		expect(encodeKey({ ...base, key: "PageUp" })).toBe("\u001b[5~");
		expect(encodeKey({ ...base, key: "PageDown" })).toBe("\u001b[6~");
		expect(encodeKey({ ...base, key: "Delete" })).toBe("\u001b[3~");
	});

	test("回车 / Esc / Tab / Shift+Tab / 退格", () => {
		expect(encodeKey({ ...base, key: "Enter" })).toBe("\r");
		expect(encodeKey({ ...base, key: "Escape" })).toBe("\u001b");
		expect(encodeKey({ ...base, key: "Tab" })).toBe("\t");
		expect(encodeKey({ ...base, key: "Tab", shiftKey: true })).toBe("\u001b[Z");
		expect(encodeKey({ ...base, key: "Backspace" })).toBe("\u007f");
	});

	test("方向键与 Home/End 带修饰键时用 xterm 的 CSI 1;<mod><final>", () => {
		// mod = 1 + shift*1 + alt*2 + ctrl*4（Ctrl=5、Shift+Ctrl=6、Alt+Ctrl=7、Shift+Alt+Ctrl=8）
		expect(encodeKey({ ...base, key: "ArrowUp", ctrlKey: true })).toBe(
			"\u001b[1;5A",
		);
		expect(encodeKey({ ...base, key: "ArrowDown", ctrlKey: true })).toBe(
			"\u001b[1;5B",
		);
		expect(
			encodeKey({ ...base, key: "ArrowRight", shiftKey: true, ctrlKey: true }),
		).toBe("\u001b[1;6C");
		expect(encodeKey({ ...base, key: "Home", altKey: true, ctrlKey: true })).toBe(
			"\u001b[1;7H",
		);
		expect(
			encodeKey({
				...base,
				key: "ArrowLeft",
				shiftKey: true,
				altKey: true,
				ctrlKey: true,
			}),
		).toBe("\u001b[1;8D");
		expect(encodeKey({ ...base, key: "ArrowUp", shiftKey: true })).toBe(
			"\u001b[1;2A",
		);
		expect(encodeKey({ ...base, key: "End", altKey: true })).toBe("\u001b[1;3F");
	});

	test("Ctrl+字母 编成控制字节；Ctrl+Enter 用 CSI u", () => {
		expect(encodeKey({ ...base, key: "a", ctrlKey: true })).toBe("\u0001");
		expect(encodeKey({ ...base, key: "C", ctrlKey: true })).toBe("\u0003");
	});

	test("Alt+字母 前缀 ESC", () => {
		expect(encodeKey({ ...base, key: "b", altKey: true })).toBe("\u001bb");
	});

	test("普通可打印字符原样返回；CJK 字符也可", () => {
		expect(encodeKey({ ...base, key: "x" })).toBe("x");
		expect(encodeKey({ ...base, key: "中" })).toBe("中");
	});

	test("Cmd（meta）组合一律返回 null，交给浏览器原生行为（复制/粘贴）", () => {
		expect(encodeKey({ ...base, key: "c", metaKey: true })).toBeNull();
		expect(encodeKey({ ...base, key: "v", metaKey: true })).toBeNull();
	});

	test("修饰键单独按下与未知功能键返回 null", () => {
		expect(encodeKey({ ...base, key: "Shift" })).toBeNull();
		expect(encodeKey({ ...base, key: "F13" })).toBeNull();
	});
});

describe("鼠标与粘贴", () => {
	test("左键按下/释放用 SGR 鼠标序列（坐标 1-based）", () => {
		expect(encodeMouse("down", 0, 12, 5)).toBe("\u001b[<0;12;5M");
		expect(encodeMouse("up", 0, 12, 5)).toBe("\u001b[<0;12;5m");
	});

	test("拖拽移动带 motion 位（+32）", () => {
		expect(encodeMouse("drag", 0, 3, 4)).toBe("\u001b[<32;3;4M");
	});

	test("滚轮上下分别为 64/65", () => {
		expect(encodeWheel("up", 10, 8)).toBe("\u001b[<64;10;8M");
		expect(encodeWheel("down", 10, 8)).toBe("\u001b[<65;10;8M");
	});

	test("粘贴用 bracketed paste 包裹", () => {
		expect(encodePaste("hello")).toBe("\u001b[200~hello\u001b[201~");
	});
});

describe("isComposingKey（IME 组词判定）", () => {
	test("isComposing=true → 组词中（按键归输入法）", () => {
		expect(isComposingKey({ isComposing: true })).toBe(true);
	});

	test("keyCode 229 兜底：不置 isComposing 的引擎同样判为组词中", () => {
		expect(isComposingKey({ keyCode: 229 })).toBe(true);
	});

	test("非组词态：普通按键不是组词中（isComposing=false / 其它 keyCode / 无字段）", () => {
		expect(isComposingKey({ isComposing: false })).toBe(false);
		expect(isComposingKey({ keyCode: 13 })).toBe(false);
		expect(isComposingKey({})).toBe(false);
	});
});
