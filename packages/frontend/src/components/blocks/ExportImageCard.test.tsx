// ExportImageCard 排版测试：用户气泡 / AI markdown / 署名行。
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ExportImageCard } from "./ExportImageCard";

const TURNS = [
	{ user: "什么是 TDD？", assistant: "**TDD** 是先写测试。", agentName: "dev", timestamp: new Date(2026, 7, 4, 15, 30).getTime() },
	{ user: "第二轮问题", assistant: "第二轮回答", agentName: "dev", timestamp: new Date(2026, 7, 4, 15, 32).getTime() },
];

test("渲染用户消息与 AI 回复（markdown 渲染为 HTML）", () => {
	render(<ExportImageCard turns={TURNS} />);
	expect(screen.getByText("什么是 TDD？")).toBeTruthy();
	expect(screen.getByText("第二轮问题")).toBeTruthy();
	// markdown 加粗 → <strong>
	const strong = document.querySelector("strong");
	expect(strong?.textContent).toBe("TDD");
	// agent 名 + 时间标注
	expect(screen.getAllByText(/dev · 15:3\d/).length).toBe(2);
});

test("底部署名行 WA PI Agent", () => {
	render(<ExportImageCard turns={TURNS} />);
	expect(screen.getByText("WA PI Agent")).toBeTruthy();
});
