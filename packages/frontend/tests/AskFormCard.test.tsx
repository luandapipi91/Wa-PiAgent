import { describe, it, expect, mock, beforeEach, afterEach, vi } from "bun:test";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { AskParams } from "@wa-pi/shared";

const sent: any[] = [];
// 测试钩子：可注入 post 失败/响应，模拟网络异常或 stale ask（400）
let postImpl: (path: string, body?: any, timeoutMs?: number) => Promise<any> = () =>
	Promise.resolve({});

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: (path: string, body?: any, timeoutMs?: number) => {
			sent.push({ path, body, timeoutMs });
			return postImpl(path, body, timeoutMs);
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

// 组件卸载必须清理挂起的计时器（否则提交循环在已卸载组件上继续重试/发请求）。
// 每个用例结束显式 unmount + 还原真实计时器，避免 fake timers 泄漏到其它用例。
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

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

	it("选项 preview 中的裸 URL 也可点击（remark-gfm 自动链接）", () => {
		const p: AskParams = {
			questions: [
				{
					question: "选一个?",
					header: "h",
					options: [
						{
							label: "A",
							description: "x",
							preview: "请在浏览器打开 http://localhost:53213/?key=abc",
						},
					],
				},
			],
		};
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={p} />);
		fireEvent.click(screen.getByText("A"));
		const link = screen.getByRole("link", {
			name: "http://localhost:53213/?key=abc",
		}) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("http://localhost:53213/?key=abc");
		expect(link.getAttribute("target")).toBe("_blank");
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

	// —— 失效取消：内核 registry 已无此 ask，取消请求是 no-op、也不会有 toolResult，
	// 只能靠本地关闭把卡片从阻塞中拿出来 ——

	it("stale 卡片点取消 → 直接本地关闭，不发 cancel-ask", () => {
		let dismissed = false;
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				stale
				onDismiss={() => (dismissed = true)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(dismissed).toBe(true);
		expect(sent).toHaveLength(0);
	});

	it("取消收到 400（后端说该提问已失效）→ 本地关闭卡片", async () => {
		postImpl = () =>
			Promise.reject(Object.assign(new Error("stale"), { status: 400 }));
		let dismissed = false;
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				onDismiss={() => (dismissed = true)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(sent[0].path).toContain("/api/sessions/s1/cancel-ask");
		await new Promise((r) => setTimeout(r, 0));
		expect(dismissed).toBe(true);
	});

	it("取消失败（非 400）→ 保留卡片并提示，按钮恢复可点", async () => {
		postImpl = () =>
			Promise.reject(Object.assign(new Error("boom"), { status: 500 }));
		let dismissed = false;
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				onDismiss={() => (dismissed = true)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(dismissed).toBe(false);
		expect(screen.getByText("取消失败，请重试", { exact: false })).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("提交收到 400 后点取消 → 本地关闭（同一张卡片的兜底出口）", async () => {
		postImpl = (path: string) =>
			path.includes("/answer")
				? Promise.reject(Object.assign(new Error("stale"), { status: 400 }))
				: Promise.resolve({});
		let dismissed = false;
		render(
			<AskFormCard
				sessionId="s1"
				toolCallId="tc1"
				params={params}
				onDismiss={() => (dismissed = true)}
			/>,
		);
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(dismissed).toBe(true);
		// 已失效 → 不再向取消端点发无意义请求
		expect(sent.filter((s) => s.path.includes("cancel-ask"))).toHaveLength(0);
	});
});

// —— 提交超时重试的状态机 ——
// 覆盖两种卡死成因：① 提交请求本身挂住不返回；② 请求已返回 200 但 toolResult 永不到达。
// 用 fake timers 控制「等待结果」的 2s 计时，无需真实等待。

const timeoutErr = () => {
	const e = new Error("timeout");
	e.name = "TimeoutError";
	return e;
};
const stale400 = () => Object.assign(new Error("stale"), { status: 400 });

const answerCalls = () => sent.filter((s) => s.path.includes("/answer"));
const cancelCalls = () => sent.filter((s) => s.path.includes("cancel-ask"));

// 可控卸载的 harness：hideCard 由测试调用，模拟「父层因 toolResult 卸载卡片」（真成功）。
// 卡片自身的 onDismiss 也会隐藏它，模拟本地关闭收尾。
let hideCard: () => void = () => {};
function Harness({ onDismiss }: { onDismiss?: () => void }) {
	const [visible, setVisible] = useState(true);
	hideCard = () => setVisible(false);
	return visible ? (
		<AskFormCard
			sessionId="s1"
			toolCallId="tc1"
			params={params}
			onDismiss={() => {
				onDismiss?.();
				setVisible(false);
			}}
		/>
	) : null;
}

describe("AskFormCard 提交超时重试 / 重试耗尽自动取消", () => {
	beforeEach(() => {
		sent.length = 0;
		vi.useFakeTimers();
	});

	it("首次超时 → 自动重试；重试 200 且卡片随即卸载 → 只发 2 次、不取消", async () => {
		let n = 0;
		postImpl = () => {
			n++;
			return n === 1 ? Promise.reject(timeoutErr()) : Promise.resolve({});
		};
		render(<Harness />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(2);
		// 单次请求超时（第 3 参）必须是 2s
		expect(answerCalls()[0].timeoutMs).toBe(2000);

		// 2s 内父层卸载卡片（= toolResult 到达，真成功）→ 收尾，不再取消
		await act(async () => {
			hideCard();
		});
		expect(answerCalls()).toHaveLength(2);
		expect(cancelCalls()).toHaveLength(0);
	});

	it("三次尝试全部超时 → 自动 cancel-ask 一次并本地关闭卡片", async () => {
		postImpl = () => Promise.reject(timeoutErr());
		let dismissed = false;
		render(
			<Harness
				onDismiss={() => {
					dismissed = true;
				}}
			/>,
		);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(3);
		expect(cancelCalls()).toHaveLength(1);
		expect(dismissed).toBe(true);
		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();
	});

	it("首次 200 但 2s 内未卸载 → 重试；重试 400 → 本地关闭且不再有第 3 次", async () => {
		let n = 0;
		postImpl = (path: string) => {
			if (path.includes("cancel-ask")) return Promise.resolve({});
			n++;
			return n === 1 ? Promise.resolve({}) : Promise.reject(stale400());
		};
		let dismissed = false;
		render(
			<Harness
				onDismiss={() => {
					dismissed = true;
				}}
			/>,
		);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(1);

		// 等待结果 2s 到期 → 触发重试。先卡边界：1999ms 尚未到期，不该重试
		await act(async () => {
			vi.advanceTimersByTime(1999);
		});
		expect(answerCalls()).toHaveLength(1);
		// 再多走 1ms 恰好到期 → 触发第 2 次尝试
		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		expect(answerCalls()).toHaveLength(2);
		expect(dismissed).toBe(true);
		expect(cancelCalls()).toHaveLength(0);
	});

	it("首次 400（真 stale）→ 不重试、只发一次，显示失效文案", async () => {
		postImpl = () => Promise.reject(stale400());
		render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(1);
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
	});

	it("首次 200 且卡片立即卸载 → 只发一次、不取消", async () => {
		postImpl = () => Promise.resolve({});
		render(<Harness />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(1);
		await act(async () => {
			hideCard();
		});
		expect(answerCalls()).toHaveLength(1);
		expect(cancelCalls()).toHaveLength(0);
	});

	it("请求进行中卸载 → 返回 200 后不再启动计时器/不重试（并行保护）", async () => {
		let resolvePost: (v: unknown) => void = () => {};
		postImpl = () =>
			new Promise((r) => {
				resolvePost = r;
			});
		render(<Harness />);
		fireEvent.click(screen.getByText("PostgreSQL"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "提交" }));
		});
		expect(answerCalls()).toHaveLength(1);

		// 请求挂起期间父层卸载（如切换会话）
		await act(async () => {
			hideCard();
		});
		// 之后请求才成功返回 200 → 不该再进入等待/重试
		await act(async () => {
			resolvePost({});
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(answerCalls()).toHaveLength(1);
		expect(cancelCalls()).toHaveLength(0);
	});
});
