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
});

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
	const meta = screen.getByTestId("transcript-meta").textContent ?? "";
	expect(meta).toContain("Explore");
	expect(meta).toContain(AGENT_ID);
	expect(meta).toContain("完成");
	expect(meta).toContain("32s");

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
