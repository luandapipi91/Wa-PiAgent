// 任务 10：子代理转录只读弹窗 —— 纯函数单测 + 组件渲染/交互测试。
// 仓库前端测试用 bun:test + happy-dom preload（非 vitest）：
//   cd packages/frontend && bun --env-file=.env.test test --isolate --timeout=20000 tests/subagent-transcript-modal.test.tsx
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import {
	SubagentTranscriptModal,
	buildTranscriptSegments,
	segmentsToPlainText,
} from "../src/components/blocks/SubagentTranscriptModal";
import { useSessionStore } from "../src/store/session";
import { MODAL_POS_KEYS } from "../src/components/ui/modal-position";
import { MODAL_SIZE_KEYS } from "../src/components/ui/modal-size";

// ── 测试夹具 ──

const AGENT_ID = "a3f8c1d0a";
const SESSION_ID = "s1";

/** 转录接口 GET /api/sessions/:sid/subagents/:aid 的 meta（kernel SubagentMeta 的可渲染子集） */
const META = {
	agentId: AGENT_ID,
	subagentType: "Explore",
	status: "completed" as const,
	toolCallId: "tc-1",
	taskIndex: null,
	task: "列出 packages 目录并说明每个包",
	elapsedMs: 32_000,
	usage: { input: 1200, output: 800, cacheRead: 6000, total: 8000 },
};

/** 三类块齐全的转录：思考 → 工具调用 → 工具结果 → 正文 */
const MESSAGES: SessionMessage[] = [
	{
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "先看目录结构" }],
		} as unknown as SessionMessage["message"],
	},
	{
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "foo" } },
			],
		} as unknown as SessionMessage["message"],
	},
	{
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "grep",
			content: [{ type: "text", text: "3 处命中" }],
			isError: false,
		} as unknown as SessionMessage["message"],
	},
	{
		message: {
			role: "assistant",
			content: [{ type: "text", text: "结论：可以这样做" }],
		} as unknown as SessionMessage["message"],
	},
];

// ── fetch 桩：按 URL 分流（转录详情 / 会话内实例列表） ──

interface StubResponse {
	status?: number;
	body?: unknown;
}

let fetchUrls: string[] = [];

function jsonRes({ status = 200, body = {} }: StubResponse) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 404 ? "Not Found" : "OK",
		json: async () => body,
	} as unknown as Response;
}

/** 装 fetch：详情路由返回 detail，列表路由返回 list；deferDetail 时详情永远 pending（测加载态）；
 *  detailByAgent 按 agentId 覆盖单个实例的详情响应（目标实例 404、兄弟实例仍可用） */
function stubFetch(opts: {
	detail?: StubResponse;
	detailByAgent?: Record<string, StubResponse>;
	list?: StubResponse;
	deferDetail?: boolean;
}) {
	fetchUrls = [];
	globalThis.fetch = mock((url: unknown) => {
		const u = String(url);
		fetchUrls.push(u);
		if (/\/subagents\/[^/]+$/.test(u)) {
			const override = opts.detailByAgent?.[u.slice(u.lastIndexOf("/") + 1)];
			if (override) return Promise.resolve(jsonRes(override));
			if (opts.deferDetail) return new Promise<Response>(() => {});
			return Promise.resolve(jsonRes(opts.detail ?? { body: { meta: META, messages: MESSAGES } }));
		}
		return Promise.resolve(jsonRes(opts.list ?? { body: { subagents: [META] } }));
	}) as unknown as typeof fetch;
}

/** 详情请求次数（筛选切换不应增加它） */
function detailCallCount(): number {
	return fetchUrls.filter((u) => /\/subagents\/[^/]+$/.test(u)).length;
}

/** 时间线段计数（弹窗经 portal 渲染到 body，必须用 document 查） */
function blockCount(kind: "thinking" | "tool" | "text"): number {
	return document.querySelectorAll(`[data-block="${kind}"]`).length;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
	// 清掉本文件用例写入的进度事件（「实例是否在跑」的判定读它，残留会串到后面的 404 用例）
	useSessionStore.setState({ progressByToolCall: {} });
	// 还原布局尺寸 mock（详见文件末尾「滚动到底部」用例）
	delete (Element.prototype as unknown as Record<string, unknown>).scrollHeight;
	delete (Element.prototype as unknown as Record<string, unknown>).clientHeight;
});

/** happy-dom 不做真实布局：把 scrollHeight / clientHeight 固定成可用值，
 *  这样 scrollTop = scrollHeight 这个动作才能被断言（否则两边恒为 0，断言没判别力）。 */
function mockLayout(scrollHeight = 1000, clientHeight = 300) {
	Object.defineProperty(Element.prototype, "scrollHeight", {
		configurable: true,
		get: () => scrollHeight,
	});
	Object.defineProperty(Element.prototype, "clientHeight", {
		configurable: true,
		get: () => clientHeight,
	});
}

// ── 纯函数：把消息拍平成可渲染段 ──

test("buildTranscriptSegments：toolCall 与 toolResult 按 toolCallId 配对成一个工具段", () => {
	const segs = buildTranscriptSegments(MESSAGES);
	expect(segs.map((s) => s.kind)).toEqual(["thinking", "tool", "text"]);
	const tool = segs[1];
	expect(tool.kind).toBe("tool");
	if (tool.kind !== "tool") throw new Error("unreachable");
	expect(tool.toolCall.id).toBe("t1");
	expect(tool.toolCall.name).toBe("grep");
	expect(tool.toolResult?.toolCallId).toBe("t1");
});

test("buildTranscriptSegments：思考块缺失时工具与正文照常成段（简单任务不输出 thinking）", () => {
	const segs = buildTranscriptSegments(MESSAGES.filter((_, i) => i !== 0));
	expect(segs.map((s) => s.kind)).toEqual(["tool", "text"]);
});

test("buildTranscriptSegments：空白思考 / 空白正文被跳过", () => {
	const segs = buildTranscriptSegments([
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "   " },
					{ type: "text", text: "" },
				],
			} as unknown as SessionMessage["message"],
		},
	]);
	expect(segs).toEqual([]);
});

test("buildTranscriptSegments：找不到配对 toolCall 的 toolResult 被忽略（不产出空段）", () => {
	const segs = buildTranscriptSegments([
		{
			message: {
				role: "toolResult",
				toolCallId: "ghost",
				toolName: "grep",
				content: [{ type: "text", text: "孤儿结果" }],
				isError: false,
			} as unknown as SessionMessage["message"],
		},
	]);
	expect(segs).toEqual([]);
});

test("segmentsToPlainText：思考 / 工具（含参数与结果）/ 正文都进纯文本", () => {
	const text = segmentsToPlainText(buildTranscriptSegments(MESSAGES));
	expect(text).toContain("先看目录结构");
	expect(text).toContain("grep");
	expect(text).toContain("foo");
	expect(text).toContain("3 处命中");
	expect(text).toContain("结论：可以这样做");
});

// ── 组件 ──

test("buildTranscriptSegments：user 消息（resume 的每轮任务）渲染为 task 段", () => {
	// 规格 §6：resume 时 task 参数作为新一轮用户消息追加进同一份历史。
	// 此前只处理 assistant / toolResult → 续聊那轮的任务在弹窗里完全不可见
	// （用户实测：「第二次发出去的任务，没有写在正文里面，只能看到第一次下发的」）。
	const segs = buildTranscriptSegments([
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "第一轮任务" }],
			},
		} as never,
		{
			message: { role: "assistant", content: [{ type: "text", text: "第一轮结论" }] },
		} as never,
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "第二轮任务（续聊）" }],
			},
		} as never,
		{
			message: { role: "assistant", content: [{ type: "text", text: "第二轮结论" }] },
		} as never,
	]);
	expect(segs.map((s) => s.kind)).toEqual(["task", "text", "task", "text"]);
	expect((segs[0] as { text: string }).text).toBe("第一轮任务");
	expect((segs[2] as { text: string }).text).toBe("第二轮任务（续聊）");
});

test("buildTranscriptSegments：user 的字符串型 content 也能成段，空文本跳过", () => {
	const segs = buildTranscriptSegments([
		{ message: { role: "user", content: "裸字符串任务" } } as never,
		{ message: { role: "user", content: "   " } } as never,
	]);
	expect(segs.map((s) => s.kind)).toEqual(["task"]);
	expect((segs[0] as { text: string }).text).toBe("裸字符串任务");
});

test("续聊：两轮任务都出现在时间线（不再只看得到第一次下发的）", async () => {
	const multi = [
		{ message: { role: "user", content: [{ type: "text", text: "第一轮任务" }] } } as never,
		{ message: { role: "assistant", content: [{ type: "text", text: "第一轮结论" }] } } as never,
		{ message: { role: "user", content: [{ type: "text", text: "第二轮任务（续聊）" }] } } as never,
		{ message: { role: "assistant", content: [{ type: "text", text: "第二轮结论" }] } } as never,
	];
	stubFetch({ detail: { body: { meta: META, messages: multi } } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByText("第二轮任务（续聊）")).toBeTruthy());
	expect(screen.getByText("第一轮任务")).toBeTruthy();
	const kinds = [...document.querySelectorAll("[data-transcript-block]")].map((el) =>
		el.getAttribute("data-transcript-block"),
	);
	expect(kinds).toEqual(["task", "text", "task", "text"]);
});

test("打开弹窗时时间线滚到底部（长转录 / 运行中看重最新内容）", async () => {
	mockLayout(1000, 300);
	stubFetch({});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	const timeline = await screen.findByTestId("transcript-timeline");
	await waitFor(() => expect(timeline.scrollTop).toBe(1000));
});

test("实时刷新时跟随到底；但用户往上翻后不再把他拽回底部", async () => {
	mockLayout(1000, 300);
	let round = 0;
	fetchUrls = [];
	globalThis.fetch = mock((url: unknown) => {
		const u = String(url);
		fetchUrls.push(u);
		if (/\/subagents\/[^/]+$/.test(u)) {
			round += 1;
			return Promise.resolve(
				jsonRes({
					body: {
						meta: { ...META, status: "running" },
						messages: round === 1 ? [MESSAGES[0]] : MESSAGES,
					},
				}),
			);
		}
		return Promise.resolve(jsonRes({ body: { subagents: [META] } }));
	}) as unknown as typeof fetch;
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	const timeline = await screen.findByTestId("transcript-timeline");
	// 打开后贴底
	await waitFor(() => expect(timeline.scrollTop).toBe(1000));

	// 用户往上翻（距底超过阈值）→ 后续刷新不得再强制拉到底
	timeline.scrollTop = 100;
	fireEvent.scroll(timeline);
	timeline.scrollTop = 100; // 主动模拟被冲掉后的位置
	await waitFor(() => expect(blockCount("tool")).toBe(1), { timeout: 8000 });
	expect(timeline.scrollTop).toBe(100);

	// 滚回底部 → 恢复跟随
	timeline.scrollTop = 1000;
	fireEvent.scroll(timeline);
	expect(timeline.scrollTop).toBe(1000);
});

test("服务端 5xx / 网络异常 → 显示「加载失败」而不是「此委托早于转录功能上线」", async () => {
	// 404 是「没有这份转录」，5xx / 断网是「暂时取不到」—— 同一句话会把用户引向错误结论
	//（以为转录不存在，实际只是服务抖了）。
	stubFetch({ detail: { status: 500 } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-error")).toBeTruthy());
	expect(screen.queryByTestId("transcript-missing")).toBeNull();
});

test("网络异常（fetch reject）→ 同样显示「加载失败」，不是空态文案", async () => {
	fetchUrls = [];
	globalThis.fetch = mock((url: unknown) => {
		const u = String(url);
		fetchUrls.push(u);
		if (/\/subagents\/[^/]+$/.test(u)) return Promise.reject(new Error("network down"));
		return Promise.resolve(jsonRes({ body: { subagents: [META] } }));
	}) as unknown as typeof fetch;
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-error")).toBeTruthy());
	expect(screen.queryByTestId("transcript-missing")).toBeNull();
});

test("open 为 null 时不挂载弹窗、不发请求（按需加载）", () => {
	stubFetch({});
	const { container } = render(
		<SubagentTranscriptModal open={null} onClose={() => {}} />,
	);
	expect(container.firstChild).toBeNull();
	expect(fetchUrls).toEqual([]);
});

test("打开时显示加载中", async () => {
	stubFetch({ deferDetail: true });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	expect(screen.getByTestId("transcript-loading")).toBeTruthy();
	await waitFor(() => expect(detailCallCount()).toBe(1));
});

test("成功：思考 / 工具（含结果）/ 正文三类都在，展开后可读内容", async () => {
	stubFetch({});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	// 弹窗经 createPortal 渲染到 document.body，不在 render container 里
	await waitFor(() => expect(blockCount("text")).toBe(1));
	expect(blockCount("thinking")).toBe(1);
	expect(blockCount("tool")).toBe(1);
	// 正文直接可见
	expect(screen.getByText(/结论：可以这样做/)).toBeTruthy();
	// 思考卡：点开看内容
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	expect(screen.getByText(/先看目录结构/)).toBeTruthy();
	// 工具卡：点开看参数与结果（配对后的 toolResult 渲染在同一张卡里）
	fireEvent.click(screen.getByTestId("toolcall-t1-header"));
	const toolBody = screen.getByTestId("toolcall-t1-body").textContent ?? "";
	expect(toolBody).toContain("pattern");
	expect(toolBody).toContain("foo");
	expect(screen.getByText(/3 处命中/)).toBeTruthy();
});

test("404：显示「此委托早于转录功能上线」空态", async () => {
	stubFetch({ detail: { status: 404 } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: "a00000000" }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("transcript-missing")).toBeTruthy(),
	);
	expect(screen.getByText(/早于转录功能上线/)).toBeTruthy();
});

test("筛选：只做前端过滤，且不重新请求", async () => {
	stubFetch({});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(blockCount("thinking")).toBe(1));
	expect(detailCallCount()).toBe(1);

	fireEvent.click(screen.getByTestId("transcript-filter-thinking"));
	expect(blockCount("thinking")).toBe(1);
	expect(blockCount("tool")).toBe(0);
	expect(blockCount("text")).toBe(0);

	fireEvent.click(screen.getByTestId("transcript-filter-tool"));
	expect(blockCount("thinking")).toBe(0);
	expect(blockCount("tool")).toBe(1);

	fireEvent.click(screen.getByTestId("transcript-filter-all"));
	expect(blockCount("thinking") + blockCount("tool") + blockCount("text")).toBe(3);
	// 关键断言：筛选切换没有产生任何新请求
	expect(detailCallCount()).toBe(1);
});

test("左侧实例列表：同一次委托只有 1 个实例时隐藏", async () => {
	stubFetch({ list: { body: { subagents: [META] } } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(blockCount("text")).toBe(1));
	expect(screen.queryByTestId("transcript-siblings")).toBeNull();
});

test("左侧实例列表：同一次委托 ≥2 个实例时出现，点击切换到该实例", async () => {
	const sibling = {
		...META,
		agentId: "ab9c0483e",
		subagentType: "Plan",
		taskIndex: 1,
	};
	stubFetch({
		list: { body: { subagents: [META, sibling, { ...META, agentId: "a11111111", toolCallId: "tc-other" }] } },
	});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-siblings")).toBeTruthy());
	// 只列同一次委托（toolCallId 相同）的实例；另一次委托的实例不出现
	expect(document.querySelectorAll('[data-testid^="transcript-sibling-"]')).toHaveLength(2);

	fireEvent.click(screen.getByTestId("transcript-sibling-ab9c0483e"));
	await waitFor(() =>
		expect(fetchUrls.some((u) => u.includes("/subagents/ab9c0483e"))).toBe(true),
	);
});

// 回归：左栏可见性原先绑在详情响应上（data?.meta.toolCallId），详情加载窗口内/404 后左栏被卸载。
// 修复后左栏由会话级列表（group）+ 当前 agentId 推导，与详情请求状态解耦。

const SIBLING = {
	...META,
	agentId: "ab9c0483e",
	subagentType: "Plan",
	taskIndex: 1,
};

test("左侧实例列表：详情仍在加载时左栏保持可见（不随详情请求卸载）", async () => {
	stubFetch({
		deferDetail: true,
		list: { body: { subagents: [META, SIBLING] } },
	});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-siblings")).toBeTruthy());
	// 时间线仍是加载态，但左栏已经可用
	expect(screen.getByTestId("transcript-loading")).toBeTruthy();
	expect(document.querySelectorAll('[data-testid^="transcript-sibling-"]')).toHaveLength(2);
	expect(screen.getByTestId(`transcript-sibling-${SIBLING.agentId}`)).toBeTruthy();
});

test("左侧实例列表：目标实例 404（jsonl 缺失）时空态出现但左栏仍在，可切到兄弟实例", async () => {
	stubFetch({
		list: { body: { subagents: [META, SIBLING] } },
		detailByAgent: {
			[AGENT_ID]: { status: 404 },
			[SIBLING.agentId]: { body: { meta: SIBLING, messages: MESSAGES } },
		},
	});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	// 目标实例 404：空态与左栏同时在场（此前左栏被一并卸载，用户只能关掉弹窗重开）
	await waitFor(() => expect(screen.getByTestId("transcript-missing")).toBeTruthy());
	expect(screen.getByTestId("transcript-siblings")).toBeTruthy();

	fireEvent.click(screen.getByTestId(`transcript-sibling-${SIBLING.agentId}`));
	await waitFor(() => expect(blockCount("text")).toBe(1));
	expect(screen.queryByTestId("transcript-missing")).toBeNull();
	// 切换后左栏仍在
	expect(screen.getByTestId("transcript-siblings")).toBeTruthy();
});

test("弹窗形态：80vw × 80vh、可拖拽标题栏 + 可缩放，尺寸与位置按记录恢复", async () => {
	stubFetch({});
	localStorage.setItem(
		MODAL_SIZE_KEYS.transcript,
		JSON.stringify({ width: 700, height: 500 }),
	);
	localStorage.setItem(
		MODAL_POS_KEYS.transcript,
		JSON.stringify({ left: 40, top: 30 }),
	);
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	const card = screen.getByTestId("subagent-transcript-modal");
	expect(card.style.width).toBe("700px");
	expect(card.style.height).toBe("500px");
	expect(card.style.left).toBe("40px");
	expect(card.style.top).toBe("30px");
	expect(screen.getByTestId("modal-resize-handle")).toBeTruthy();
	expect(document.querySelector("[data-modal-drag-handle]")).toBeTruthy();
});

test("默认尺寸 80vw × 80vh、ESC 触发 onClose", async () => {
	stubFetch({});
	const onClose = mock();
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={onClose}
		/>,
	);
	const card = screen.getByTestId("subagent-transcript-modal");
	expect(card.style.width).toBe("80vw");
	expect(card.style.height).toBe("80vh");
	fireEvent.keyDown(window, { key: "Escape" });
	expect(onClose).toHaveBeenCalledTimes(1);
});

test("标题栏展示实例身份与终态用量，底部展示工具数 / 步数 / 输入输出缓存读", async () => {
	stubFetch({});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-meta")).toBeTruthy());
	// 耗时由 useLiveElapsed 的 effect 写入（不是直读 meta），需等 effect flush
	await waitFor(() =>
		expect(screen.getByTestId("transcript-meta").textContent ?? "").toContain("32s"),
	);
	const meta = screen.getByTestId("transcript-meta").textContent ?? "";
	expect(meta).toContain("Explore");
	expect(meta).toContain(AGENT_ID);
	expect(meta).toContain("完成");

	const footer = screen.getByTestId("transcript-footer").textContent ?? "";
	expect(footer).toContain("1 个工具"); // 1 个工具段
	expect(footer).toContain("3 步"); // 夹具里 3 条 assistant 消息 = 3 步
	expect(footer).toContain("1.2K"); // 输入
	expect(footer).toContain("800"); // 输出
	expect(footer).toContain("6K"); // 缓存读
	expect(screen.getByTestId("transcript-copy-all")).toBeTruthy();
});

test("任务正文渲染在时间线顶部（任务 → 思考 → 工具 → 正文）", async () => {
	stubFetch({});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(blockCount("text")).toBe(1));
	const blocks = Array.from(
		document.querySelectorAll("[data-transcript-block]"),
	).map((el) => el.getAttribute("data-transcript-block"));
	expect(blocks).toEqual(["task", "thinking", "tool", "text"]);
});

// ── 实时更新（2026-10-02）：子代理运行中时弹窗按间隔跟进最新已落盘内容 ──

test("实时更新：子代理仍在 running → 弹窗按间隔重新拉取，时间线跟着增长", async () => {
	let round = 0;
	fetchUrls = [];
	globalThis.fetch = mock((url: unknown) => {
		const u = String(url);
		fetchUrls.push(u);
		if (/\/subagents\/[^/]+$/.test(u)) {
			round += 1;
			// 第 1 次只拉到思考段；第 2 次起内容增长（模拟子代理边跑边落盘）
			const messages = round === 1 ? [MESSAGES[0]] : MESSAGES;
			return Promise.resolve(
				jsonRes({ body: { meta: { ...META, status: "running" }, messages } }),
			);
		}
		return Promise.resolve(jsonRes({ body: { subagents: [META] } }));
	}) as unknown as typeof fetch;

	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(blockCount("thinking")).toBe(1));
	// 跨过一个轮询周期（TRANSCRIPT_POLL_MS = 2000）后自动重拉 → 工具与正文出现
	await waitFor(() => expect(blockCount("tool")).toBe(1), { timeout: 8000 });
	expect(detailCallCount()).toBeGreaterThanOrEqual(2);
});

test("实例刚启动（404 但该实例仍在跑）→ 显示 loading 骨架而非「没有转录」，落盘后自动加载", async () => {
	// 用户实测：子代理刚 spawn、jsonl 还没落盘时点进去会显示「此委托早于转录功能上线」且不再刷新。
	// 需要区分两种 404：实例还在跑（该等） vs 真的没有（老数据）。信号来自 store 里的进度事件。
	useSessionStore.setState({
		progressByToolCall: {
			"tc-live": {
				"0": {
					agent: "Explore",
					agentId: AGENT_ID,
					status: "running",
					output: "",
					tools: [],
					elapsedMs: 0,
				},
			},
		},
	});
	let round = 0;
	fetchUrls = [];
	globalThis.fetch = mock((url: unknown) => {
		const u = String(url);
		fetchUrls.push(u);
		if (/\/subagents\/[^/]+$/.test(u)) {
			round += 1;
			// 第 1 次：还没落盘；第 2 次起：已落盘
			if (round === 1) return Promise.resolve(jsonRes({ status: 404 }));
			return Promise.resolve(jsonRes({ body: { meta: META, messages: MESSAGES } }));
		}
		return Promise.resolve(jsonRes({ body: { subagents: [META] } }));
	}) as unknown as typeof fetch;

	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	// 首次 404：实例在跑 → 仍是 loading，不得报「没有转录」
	await waitFor(() => expect(screen.getByTestId("transcript-loading")).toBeTruthy());
	expect(screen.queryByTestId("transcript-missing")).toBeNull();
	// 自动重试后拿到内容（用户要求「启动好之后自动加载内容」）
	await waitFor(() => expect(blockCount("thinking")).toBe(1), { timeout: 9000 });
	expect(screen.queryByTestId("transcript-missing")).toBeNull();
});

test("真缺失（404 且该实例不在跑）→ 仍显示「此委托早于转录功能上线」", async () => {
	useSessionStore.setState({ progressByToolCall: {} });
	stubFetch({ detail: { status: 404 } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("transcript-missing")).toBeTruthy(),
	);
	expect(screen.queryByTestId("transcript-loading")).toBeNull();
});

test("实时更新：子代理已终态（completed）→ 拉一次后不再轮询", async () => {
	stubFetch({}); // META.status = completed
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(detailCallCount()).toBe(1));
	// 跨过一个轮询间隔仍只有那一次（终态后 jsonl 不再增长，再拉只是白耗）
	await new Promise((r) => setTimeout(r, 2600));
	expect(detailCallCount()).toBe(1);
});

test("实时更新：详情请求失败（404）→ 落空态且不再重试", async () => {
	stubFetch({ detail: { status: 404 } });
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("transcript-missing")).toBeTruthy(),
	);
	await new Promise((r) => setTimeout(r, 2600));
	expect(detailCallCount()).toBe(1);
});

test("运行中：标题栏耗时按本地时间递增（meta.elapsedMs 只在终态写盘，运行期恒 0）", async () => {
	// 实际现象：子代理跑着，弹窗内容在实时涨，但标题栏一直「运行中 · 0s」——
	// 因为 elapsedMs 是 settle 时才落盘的字段。起点改用 meta.createdAt（spawn 前生成）本地推算。
	const created = Date.now() - 5000;
	stubFetch({
		detail: {
			body: {
				meta: { ...META, status: "running", elapsedMs: 0, createdAt: created },
				messages: MESSAGES,
			},
		},
	});
	render(
		<SubagentTranscriptModal
			open={{ sessionId: SESSION_ID, agentId: AGENT_ID }}
			onClose={() => {}}
		/>,
	);
	await waitFor(() => expect(screen.getByTestId("transcript-meta")).toBeTruthy());
	// 不得显示 0s：起点取自 createdAt，立即应是 ≈5s（同样等 effect flush）
	await waitFor(() =>
		expect(screen.getByTestId("transcript-meta").textContent ?? "").toMatch(/· [456]s/),
	);
	const t1 = screen.getByTestId("transcript-meta").textContent ?? "";
	expect(t1).toContain("运行中");
	// 秒数在往前走（不是冻结的持久化值）
	await new Promise((r) => setTimeout(r, 2400));
	const t2 = screen.getByTestId("transcript-meta").textContent ?? "";
	expect(t2).not.toBe(t1);
	expect(t2).toMatch(/· [67]s/);
});
