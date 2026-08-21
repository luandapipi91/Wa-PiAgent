import { test, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import type { AttachmentDraft } from "@wa-pi/shared";
import { AttachmentChip } from "./AttachmentChip";

const KINDS: AttachmentDraft[] = [
	{ kind: "image", name: "a.png", path: "/a.png", size: 1 },
	{ kind: "file", name: "b.txt", path: "/b.txt", size: 1 },
	{ kind: "audio", name: "c.mp3", path: "/c.mp3", size: 1 },
	{ kind: "folder", name: "dir", path: "/dir" },
	{ kind: "snippet", name: "s", content: "一段超过二十个字符的片段内容用于截断测试xxxx" },
	{
		kind: "element",
		name: "index.html:5 <div>",
		path: "/proj/index.html",
		selector: "html > body > div#card",
		elLabel: "div",
		startLine: 5,
		endLine: 8,
	},
];

test("所有 kind 渲染 SVG 图标，无 emoji", () => {
	for (const a of KINDS) {
		const { unmount } = render(<AttachmentChip attachment={a} onRemove={() => {}} />);
		const chip = document.querySelector('[data-testid="attachment-chip"]')!;
		expect(chip.querySelector("svg")).toBeTruthy();
		// emoji 已移除：chip 文本不含这些字符
		for (const emoji of ["📷", "🎤", "📁", "📝", "📄"]) {
			expect(chip.textContent).not.toContain(emoji);
		}
		unmount();
	}
});

test("element chip 展示 name（文件名:行 <标签>）", () => {
	render(<AttachmentChip attachment={KINDS[5]} onRemove={() => {}} />);
	const chip = document.querySelector('[data-testid="attachment-chip"]')!;
	expect(chip.textContent).toContain("index.html:5 <div>");
});

test("删除按钮触发 onRemove 且不冒泡 onClick", () => {
	let removed = false;
	let clicked = false;
	render(
		<AttachmentChip
			attachment={KINDS[0]}
			onRemove={() => (removed = true)}
			onClick={() => (clicked = true)}
		/>,
	);
	fireEvent.click(document.querySelector('[data-testid="attachment-remove"]')!);
	expect(removed).toBe(true);
	expect(clicked).toBe(false);
});
