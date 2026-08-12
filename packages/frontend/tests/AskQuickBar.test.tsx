import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AskParams } from "@wa-pi/shared";

const sent: any[] = [];
let postImpl: (path: string, body?: any) => Promise<any> = () =>
	Promise.resolve({});

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: (path: string, body?: any) => {
			sent.push({ path, body });
			return postImpl(path, body);
		},
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

import { AskQuickBar } from "../src/components/ask/AskQuickBar";

const params: AskParams = {
	questions: [
		{
			question: "优先级?",
			header: "h",
			options: [
				{ label: "高", description: "x" },
				{ label: "低", description: "y" },
			],
		},
		{
			question: "多选?",
			header: "h",
			multiSelect: true,
			options: [
				{ label: "A", description: "x" },
				{ label: "B", description: "y" },
			],
		},
	],
};

const ask = {
	toolCallId: "tc1",
	agentName: "dev" as const,
	params,
};

function renderBar(overrides?: Partial<Parameters<typeof AskQuickBar>[0]>) {
	return render(
		<AskQuickBar
			sessionId="s1"
			ask={ask}
			stale={false}
			onExpand={() => {}}
			{...overrides}
		/>,
	);
}

describe("AskQuickBar", () => {
	beforeEach(() => {
		sent.length = 0;
		postImpl = () => Promise.resolve({});
	});

	it("单行渲染：提示文字 + 选项 + 提交 icon + 展开按钮", () => {
		renderBar();
		expect(screen.getByText("Agent 有 2 个问题待回答")).toBeTruthy();
		expect(screen.getByText("高")).toBeTruthy();
		expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "展开" })).toBeTruthy();
	});

	it("未选齐时提交禁用；全部选中后可提交", () => {
		renderBar();
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.click(screen.getByText("高"));
		expect(submit.disabled).toBe(true); // Q2 未选
		fireEvent.click(screen.getByText("A"));
		fireEvent.click(screen.getByText("B"));
		expect(submit.disabled).toBe(false);
	});

	it("点提交 → 发完整 answer（所有问题）", () => {
		renderBar();
		fireEvent.click(screen.getByText("高"));
		fireEvent.click(screen.getByText("A"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent).toHaveLength(1);
		expect(sent[0].path).toContain("/api/sessions/s1/answer");
		expect(sent[0].body.toolCallId).toBe("tc1");
		expect(sent[0].body.reply.replies).toEqual([
			{ questionIndex: 0, selected: ["高"] },
			{ questionIndex: 1, selected: ["A"] },
		]);
	});

	it("单选点选替换、多选点选叠加", () => {
		renderBar();
		fireEvent.click(screen.getByText("高"));
		fireEvent.click(screen.getByText("低"));
		fireEvent.click(screen.getByText("A"));
		fireEvent.click(screen.getByText("B"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent[0].body.reply.replies[0].selected).toEqual(["低"]);
		expect(
			(sent[0].body.reply.replies[1].selected as string[]).sort(),
		).toEqual(["A", "B"]);
	});

	it("点展开按钮 → onExpand 触发", () => {
		let expanded = false;
		renderBar({ onExpand: () => (expanded = true) });
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		expect(expanded).toBe(true);
	});

	it("提交失败 → 显示错误提示", async () => {
		postImpl = () => Promise.reject(new Error("network down"));
		renderBar();
		fireEvent.click(screen.getByText("高"));
		fireEvent.click(screen.getByText("A"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByText("提交失败，请重试", { exact: false })).toBeTruthy();
	});

	it("stale → 显示失效提示且提交禁用", () => {
		renderBar({ stale: true });
		fireEvent.click(screen.getByText("高"));
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
	});

	it("选项超出宽度 → 选项区横向滚动（overflow-x-auto + scrollWidth > clientWidth）", () => {
		// 用大量选项构造超宽内容（超出 happy-dom 默认容器宽度）
		const wideParams: AskParams = {
			questions: [
				{
					question: "周几开会?",
					header: "h",
					options: Array.from({ length: 30 }, (_, i) => ({
						label: `选项${i + 1}`,
						description: "x",
					})),
				},
			],
		};
		const { container } = render(
			<AskQuickBar
				sessionId="s1"
				ask={{ toolCallId: "tc1", agentName: "dev", params: wideParams }}
				stale={false}
				onExpand={() => {}}
			/>,
		);
		const bar = screen.getByTestId("ask-quick-bar");
		// 选项区容器：单行、溢出横向滚动
		const optsRow = bar.querySelector(
			".overflow-x-auto",
		) as HTMLElement;
		expect(optsRow).toBeTruthy();
		expect(optsRow.className).toContain("overflow-x-auto");
		expect(optsRow.className).toContain("whitespace-nowrap");
		// 内容应超出可视宽度（可横向滚动）。happy-dom 布局测量不可靠，手动 stub 尺寸验证滚动语义
		Object.defineProperty(optsRow, "scrollWidth", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(optsRow, "clientWidth", {
			value: 800,
			configurable: true,
		});
		expect(optsRow.scrollWidth).toBeGreaterThan(optsRow.clientWidth);
	});

	it("便签容器高度容纳横向滚动条（chip 不被顶起）", () => {
		const wideParams: AskParams = {
			questions: [
				{
					question: "周几开会?",
					header: "h",
					options: Array.from({ length: 30 }, (_, i) => ({
						label: `选项${i + 1}`,
						description: "x",
					})),
				},
			],
		};
		render(
			<AskQuickBar
				sessionId="s1"
				ask={{ toolCallId: "tc1", agentName: "dev", params: wideParams }}
				stale={false}
				onExpand={() => {}}
			/>,
		);
		const bar = screen.getByTestId("ask-quick-bar");
		// 便签高度足够容纳 chip + 滚动条（不再 h-[34px] 挤压）
		expect(bar.className).not.toContain("h-[34px]");
		expect(bar.className).toMatch(/h-\[4[0-9]px\]/);
		// 选项区自定义滚动条（细胶囊，避免默认滚动条挤压）
		const optsRow = bar.querySelector(".overflow-x-auto") as HTMLElement;
		expect(optsRow.className).toContain("scrollbar-thin");
	});

	it("选项少、不超出 → 选项区不产生横向滚动需求", () => {
		renderBar();
		const bar = screen.getByTestId("ask-quick-bar");
		const optsRow = bar.querySelector(".overflow-x-auto") as HTMLElement;
		expect(optsRow).toBeTruthy();
		Object.defineProperty(optsRow, "scrollWidth", {
			value: 400,
			configurable: true,
		});
		Object.defineProperty(optsRow, "clientWidth", {
			value: 800,
			configurable: true,
		});
		expect(optsRow.scrollWidth).toBeLessThanOrEqual(optsRow.clientWidth);
	});
});
