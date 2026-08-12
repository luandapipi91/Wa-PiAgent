import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AskParams } from "@wa-pi/shared";

const sent: any[] = [];
// 测试钩子：可注入 post 失败/响应，模拟网络异常或 stale ask（400）
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

import { AskFormCard } from "../src/components/ask/AskFormCard";

const params: AskParams = {
	questions: [
		{
			question: "数据存储方案?",
			header: "存储",
			options: [
				{ label: "SQLite", description: "轻量" },
				{ label: "PostgreSQL", description: "生产级" },
			],
		},
	],
};

describe("AskFormCard", () => {
	beforeEach(() => {
		sent.length = 0;
		postImpl = () => Promise.resolve({});
	});

	it("渲染问题与选项；点选 + 提交 → 发 answer", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		expect(screen.getByText("数据存储方案?", { exact: false })).toBeTruthy();
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent).toHaveLength(1);
		expect(sent[0].path).toContain("/api/sessions/s1/answer");
		expect(sent[0].body.toolCallId).toBe("tc1");
		expect(sent[0].body.reply.replies[0].selected).toEqual(["PostgreSQL"]);
	});

	it("未选择时提交禁用", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
	});

	it("取消 → 发 cancel-ask", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(sent).toHaveLength(1);
		expect(sent[0].path).toContain("/api/sessions/s1/cancel-ask");
	});

	it("不再有右上角 ✕（终止提问已移除，取消统一走 footer 取消）", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		expect(screen.queryByRole("button", { name: "终止提问" })).toBeNull();
	});

	it("footer 最左侧有「收起」按钮；点击触发 onCollapse（不发 cancel-ask）", () => {
		let collapsed = false;
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				onCollapse={() => (collapsed = true)}
			/>,
		);
		const footer = screen.getByRole("button", { name: "收起" }).closest("div");
		expect(footer?.className).toContain("flex");
		// 收起按钮应在取消/提交之前（最左）
		const buttons = Array.from(footer?.querySelectorAll("button") ?? []).map(
			(b) => b.getAttribute("aria-label") || b.textContent,
		);
		expect(buttons[0]).toBe("收起");
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		expect(collapsed).toBe(true);
		expect(sent).toHaveLength(0);
	});

	it("Other：展开文本框，填入后可提交（kind=custom）", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("其他…"));
		const input = screen.getByPlaceholderText(
			"输入自定义答案…",
		) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "Redis" } });
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent[0].body.reply.replies[0].customText).toBe("Redis");
		expect(sent[0].body.reply.replies[0].selected).toEqual([]);
	});

	it("多选：可勾多个；切换 multiSelect 互不干扰", () => {
		const mp: AskParams = {
			questions: [
				{
					question: "多选?",
					header: "h",
					multiSelect: true,
					options: [
						{ label: "A", description: "x" },
						{ label: "B", description: "y" },
						{ label: "C", description: "z" },
					],
				},
			],
		};
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={mp} />);
		fireEvent.click(screen.getByText("A"));
		fireEvent.click(screen.getByText("C"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent[0].body.reply.replies[0].selected.sort()).toEqual(["A", "C"]);
	});

	it("选项 preview 中的链接在新标签页打开", () => {
		const p: AskParams = {
			questions: [
				{
					question: "选一个?",
					header: "h",
					options: [
						{
							label: "A",
							description: "x",
							preview: "详见 [文档](https://example.com)",
						},
					],
				},
			],
		};
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={p} />);
		fireEvent.click(screen.getByText("A"));
		const link = screen.getByRole("link", {
			name: "文档",
		}) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("https://example.com");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("选「其他」取消普通选项选择；未输入文字时提交禁用；输入后可提交", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByText("其他…"));
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		const input = screen.getByPlaceholderText(
			"输入自定义答案…",
		) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "Redis" } });
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent[0].body.reply.replies[0].selected).toEqual([]);
		expect(sent[0].body.reply.replies[0].customText).toBe("Redis");
	});

	it("提交失败（网络错误）→ 恢复提交按钮并显示错误提示，可重试", async () => {
		postImpl = () => Promise.reject(new Error("network down"));
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		// 等待失败处理后 UI 恢复
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
		expect(screen.getByText("提交失败，请重试", { exact: false })).toBeTruthy();
	});

	it("提交收到 400（stale ask 已失效）→ 显示提问已失效提示", async () => {
		postImpl = () =>
			Promise.reject(
				Object.assign(
					new Error("该提问已失效（可能已取消或会话已切换），请重新发起"),
					{ status: 400 },
				),
			);
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
	});

	it("提交成功 → 按钮保持“提交中…”（等待 toolResult 关闭卡片）", async () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByRole("button", { name: "提交中…" })).toBeTruthy();
	});

	it("stale 卡片（后端已无此 ask）→ 显示失效提示且提交禁用（double check）", () => {
		render(
			<AskFormCard sessionId="s1" toolCallId="tc1" params={params} stale />,
		);
		fireEvent.click(screen.getByText("PostgreSQL"));
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
	});

	it("initialSelected：预选中普通选项；提交时带过去", () => {
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				initialSelected={{ 0: new Set(["PostgreSQL"]) }}
			/>,
		);
		// 预选后直接可提交
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent[0].body.reply.replies[0].selected).toEqual(["PostgreSQL"]);
	});

	it("initialSelected 缺省 → 行为与原来一致（未选禁用）", () => {
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		const submit = screen.getByRole("button", {
			name: "提交",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
	});
});
