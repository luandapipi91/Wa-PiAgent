// Task 2: AnsiText — ANSI SGR 颜色码解析的单测
// 说明：parseAnsiToNodes 是纯函数，直接断言返回的 ReactNode 结构。
import { test, expect } from "bun:test";
import { parseAnsiToNodes } from "../src/components/ui/AnsiText";
import { isValidElement } from "react";

test("无 ANSI 时原样返回字符串", () => {
	const nodes = parseAnsiToNodes("纯文本");
	expect(nodes).toEqual(["纯文本"]);
});

test("16 色 foreground 解析", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红色\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect(isValidElement(el)).toBe(true);
	expect((el as any).props.style.color).toBe("#dc2626");
	expect((el as any).props.children).toBe("红色");
});

test("256 色 foreground 解析", () => {
	// 注意：xterm 标准公式 214 → 16+5*36+3*6+0 = cube(5,3,0) → #ffaf00
	// （计划中写的 #ff8700 对应的是 208 号色，此处按真实 xterm 语义断言）
	const nodes = parseAnsiToNodes("\x1b[38;5;214m橙色\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect((el as any).props.style.color).toBe("#ffaf00");
});

test("RGB foreground 解析", () => {
	const nodes = parseAnsiToNodes("\x1b[38;2;18;52;86m深蓝\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect((el as any).props.style.color).toBe("#123456");
});

test("多段颜色解析", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红\x1b[32m绿\x1b[39m");
	expect(nodes).toHaveLength(2);
	expect((nodes[0] as any).props.style.color).toBe("#dc2626");
	expect((nodes[0] as any).props.children).toBe("红");
	expect((nodes[1] as any).props.style.color).toBe("#34a853");
	expect((nodes[1] as any).props.children).toBe("绿");
});

test("reset 后回到默认", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红\x1b[0m默认");
	expect(nodes).toHaveLength(2);
	expect((nodes[0] as any).props.style.color).toBe("#dc2626");
	expect(nodes[1]).toBe("默认");
});

test("非法/不支持的序列被丢弃", () => {
	const nodes = parseAnsiToNodes("\x1b[2J清屏\x1b[1m加粗\x1b[39m");
	expect(nodes).toEqual(["清屏加粗"]);
});
