// TuiPanel（ctx.ui.custom 三态浮窗）单测。
// 覆盖：三态渲染与切换、ANSI 属性、OSC 8 链接、光标、键盘/粘贴/鼠标/滚轮上报、
// 尺寸上报与 NaN 守卫、快照补发（成功/空/失败/竞态）、窗口拖动与缩放。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ExtensionTuiSnapshotResult } from "@wa-pi/shared";
import { useTuiPanelStore } from "../store/tui-panel";
import { encodeMouse, encodeWheel } from "../lib/tui-keys";
import { CELL, TuiPanel } from "./TuiPanel";

const META = {
	panelId: "p1",
	kind: "custom" as const,
	title: "pi-goal-x · Confirm",
	cols: 85,
	rows: 24,
	pending: 1,
};

// === fetch 桩 ===
// 所有上报都走 api-client → fetch：记录 (url, body)，按 url 分派响应。
type Recorded = { url: string; body: any };
let calls: Recorded[] = [];
let tuiInputFails = false;
let snapshotDeferred: {
	promise: Promise<Response>;
	resolve: (body: unknown) => void;
	reject: (err?: unknown) => void;
} | null = null;

/** 让下一次快照请求挂起，由用例决定何时 resolve/reject（不设定则永挂起，不干扰其他用例） */
function deferSnapshot() {
	let resolve!: (body: unknown) => void;
	let reject!: (err?: unknown) => void;
	const promise = new Promise<Response>((res, rej) => {
		resolve = (b) => res(new Response(JSON.stringify(b), { status: 200 }));
		reject = (e) => rej(e);
	});
	snapshotDeferred = { promise, resolve, reject };
	return snapshotDeferred;
}

const tuiInputCalls = (type?: string) =>
	calls.filter(
		(c) =>
			c.url === "/api/extensions/tui-input" &&
			(type === undefined || c.body?.type === type),
	);

// === getBoundingClientRect 桩（happy-dom 无布局，全为 0）===
const restores: Array<() => void> = [];
function stubRects(rect: {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
}) {
	const original = HTMLElement.prototype.getBoundingClientRect;
	const r = { left: 0, top: 0, width: 0, height: 0, ...rect };
	HTMLElement.prototype.getBoundingClientRect = function () {
		return {
			...r,
			right: r.left + r.width,
			bottom: r.top + r.height,
			x: r.left,
			y: r.top,
			toJSON: () => ({}),
		} as DOMRect;
	};
	restores.push(() => {
		HTMLElement.prototype.getBoundingClientRect = original;
	});
}

beforeEach(() => {
	localStorage.clear();
	useTuiPanelStore.setState({ bySession: {} });
	calls = [];
	tuiInputFails = false;
	snapshotDeferred = null;
	globalThis.fetch = mock(async (url: any, init: any) => {
		calls.push({
			url: String(url),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		if (String(url).includes("tui-snapshot")) {
			return snapshotDeferred ? snapshotDeferred.promise : new Promise<Response>(() => {});
		}
		if (tuiInputFails) return new Response("boom", { status: 500 });
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as never;
});

afterEach(() => {
	for (const restore of restores) restore();
	restores.length = 0;
	cleanup();
});

const body = () => screen.getByTestId("tui-panel-body");

describe("TuiPanel 三态渲染", () => {
	test("当前会话无面板时不渲染", () => {
		const { container } = render(<TuiPanel sessionId="s1" />);
		expect(container.firstChild).toBeNull();
	});

	test("sessionId 为 null 时不渲染", () => {
		const { container } = render(<TuiPanel sessionId={null} />);
		expect(container.firstChild).toBeNull();
	});

	test("展开态渲染标题与帧行，且 ANSI 属性参与渲染（attrs: true）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["Objective", "\u001b[1m▸ Confirm\u001b[0m"], null);
		render(<TuiPanel sessionId="s1" />);
		expect(screen.getByText(/pi-goal-x/)).toBeTruthy();
		expect(screen.getByText(/Objective/)).toBeTruthy();
		// 粗体来自 SGR 1：默认（attrs: false）会被丢弃，这里必须保留
		expect(screen.getByText("▸ Confirm").style.fontWeight).toBe("600");
		// ANSI 码不外泄
		expect(body().textContent).not.toContain("\u001b");
	});

	test("OSC 8 链接渲染为可点锚点（新窗口 + noopener）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame(
				"s1",
				"p1",
				["见 \u001b]8;;https://example.com/docs\u0007文档\u001b]8;;\u0007 结尾"],
				null,
			);
		render(<TuiPanel sessionId="s1" />);
		const link = body().querySelector("a")!;
		expect(link.getAttribute("href")).toBe("https://example.com/docs");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noreferrer");
		expect(link.textContent).toBe("文档");
		// 标记与可见文本之外的部分仍在
		expect(body().textContent).toContain("见 ");
		expect(body().textContent).toContain("结尾");
	});

	test("帧光标按 (row, col) 叠加方块", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["aaa", "bb"], { row: 1, col: 3 });
		render(<TuiPanel sessionId="s1" />);
		const cursor = screen.getByTestId("tui-panel-cursor");
		// 列 = 文本区内边距 + col 格；行 = row 格
		expect(cursor.style.left).toBe(`${12 + 3 * CELL.width}px`);
		expect(cursor.style.top).toBe(`${1 * CELL.height}px`);
	});

	test("无光标时不渲染方块", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore.getState().setFrame("s1", "p1", ["aaa"], null);
		render(<TuiPanel sessionId="s1" />);
		expect(screen.queryByTestId("tui-panel-cursor")).toBeNull();
	});

	test("pending > 1 时显示排队角标", () => {
		useTuiPanelStore.getState().open("s1", { ...META, pending: 3 });
		render(<TuiPanel sessionId="s1" />);
		const badge = screen.getByTestId("tui-panel-pending");
		expect(badge.textContent).toBe("+2");
		expect(badge.getAttribute("title")).toBe("等待你输入");
	});
});

describe("TuiPanel 三态切换", () => {
	test("点「—」收起为挂件态，点挂件主体展开回来", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("收起"));
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("badge");
		fireEvent.click(screen.getByTestId("tui-panel-badge"));
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("expanded");
	});

	test("挂件态预览实时帧，点「–」收成胶囊，点胶囊展开", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["第一行", "第二行", "第三行"], null);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("收起"));
		expect(screen.getByTestId("tui-panel-badge").textContent).toContain("第二行");
		// 「—」收起后回到上次收起级别（首次为 badge）也是 badge：再深一层用「收成胶囊」
		fireEvent.click(screen.getByTitle("收成胶囊"));
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("pill");
		expect(screen.getByTestId("tui-panel-pill").textContent).toContain("pi-goal-x");
		fireEvent.click(screen.getByTestId("tui-panel-pill"));
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("expanded");
	});

	test("收起态不渲染帧正文（只有预览/标题）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["可见行", "被预览截掉的行"], null);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("收起"));
		fireEvent.click(screen.getByTitle("收成胶囊"));
		expect(screen.queryByTestId("tui-panel-body")).toBeNull();
	});

	/**
	 * 简报里的断言是「POST body 含 ArrowDown」，但 ESC（\u001b）经 JSON.stringify
	 * 会转义成 \u001b 字面量，键名不会出现在体里。这里改断言序列本身。
	 */
	test("展开态方向键 → POST 终端序列到 tui-input", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.keyDown(body(), { key: "ArrowDown" });
		const call = tuiInputCalls("key").at(-1)!;
		expect(call.body).toEqual({
			sessionId: "s1",
			panelId: "p1",
			type: "key",
			data: "\u001b[B",
		});
	});

	test("展开态自动接管键盘焦点", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		expect(document.activeElement).toBe(screen.getByTestId("tui-panel-expanded"));
	});

	test("不认识的功能键与 Cmd 组合放行（不发序列）", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.keyDown(body(), { key: "F5" });
		// Cmd+C 等必须留给浏览器复制，否则面板里无法复制文本
		fireEvent.keyDown(body(), { key: "c", metaKey: true });
		expect(tuiInputCalls("key")).toHaveLength(0);
	});

	test("展开态粘贴 → bracketed paste 序列", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.paste(body(), {
			clipboardData: { getData: () => "第一行\n第二行" },
		});
		expect(tuiInputCalls("paste").at(-1)!.body.data).toBe(
			"\u001b[200~第一行\n第二行\u001b[201~",
		);
	});

	test("点「✕」发送 cancel（关闭由 kernel 回推 close 事件）", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("取消该交互"));
		expect(tuiInputCalls("cancel")).toHaveLength(1);
		// 组件不自行关闭：生命周期归 kernel（规格 §5）
		expect(useTuiPanelStore.getState().bySession.s1).toBeDefined();
	});
});

describe("TuiPanel 鼠标上报", () => {
	// 文本区原点在 (0,0)：列 = (x - 12) / CELL.width，行 = y / CELL.height（1-based）。
	// 取整格边界（12 + n*CELL.width）以避免浮点误差把坐标推到上一格
	const atCol = (n: number) => 12 + n * CELL.width;

	test("点击（down → up）按同一份 CELL 常量换算成终端列行", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		const el = body();
		fireEvent.mouseDown(el, { clientX: atCol(5), clientY: 2 * CELL.height, button: 0 });
		fireEvent.mouseUp(window, { clientX: atCol(5), clientY: 2 * CELL.height });

		expect(tuiInputCalls("mouse").map((c) => c.body.data)).toEqual([
			encodeMouse("down", 0, 6, 3),
			encodeMouse("up", 0, 6, 3),
		]);
	});

	test("按住拖选 → drag 序列带左键修饰", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		const el = body();
		fireEvent.mouseDown(el, { clientX: atCol(0), clientY: 0, button: 0 });
		fireEvent.mouseMove(el, { clientX: atCol(5), clientY: CELL.height });
		fireEvent.mouseUp(window, { clientX: atCol(5), clientY: CELL.height });

		expect(tuiInputCalls("mouse").map((c) => c.body.data)).toEqual([
			encodeMouse("down", 0, 1, 1),
			encodeMouse("drag", 0, 6, 2),
			encodeMouse("up", 0, 6, 2),
		]);
	});

	test("未按下时移动不产生 drag 序列", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		fireEvent.mouseMove(body(), { clientX: atCol(5), clientY: CELL.height });
		expect(tuiInputCalls("mouse")).toHaveLength(0);
	});

	/**
	 * 派发带坐标的滚轮事件：happy-dom 的 WheelEvent 继承 UIEvent（没有 clientX），
	 * 真实浏览器的 WheelEvent 继承 MouseEvent（有坐标）。手工补上坐标，
	 * 才能验证「事件坐标 → 终端列行」的换算。
	 */
	const wheelAt = (el: HTMLElement, clientX: number, deltaY: number) => {
		const ev = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
		Object.defineProperty(ev, "clientX", { value: clientX });
		Object.defineProperty(ev, "clientY", { value: 0 });
		fireEvent(el, ev);
	};

	test("滚轮 → SGR 滚轮序列（上为 64）", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		wheelAt(body(), atCol(5), -100);
		wheelAt(body(), atCol(5), 100);
		expect(tuiInputCalls("mouse").map((c) => c.body.data)).toEqual([
			encodeWheel("up", 6, 1),
			encodeWheel("down", 6, 1),
		]);
	});

	test("坐标缺失（非有限值）兜底为第 1 列 1 行，不把 NaN 发出去", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.mouseDown(body(), { button: 0 });
		expect(tuiInputCalls("mouse").at(-1)!.body.data).toBe(
			encodeMouse("down", 0, 1, 1),
		);
	});
});

describe("TuiPanel 尺寸上报", () => {
	test("展开时按元素实际宽高上报 resize", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		expect(tuiInputCalls("resize").map((c) => c.body)).toEqual([
			{ sessionId: "s1", panelId: "p1", type: "resize", cols: 100, rows: 20 },
		]);
	});

	test("宽高非有限值（NaN 透传历史坑）不上报", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: Number.NaN, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		expect(tuiInputCalls("resize")).toHaveLength(0);
	});

	test("宽高不足一格时不上报", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 4, height: 3 });
		render(<TuiPanel sessionId="s1" />);
		expect(tuiInputCalls("resize")).toHaveLength(0);
	});

	test("收起态不上报 resize（挂件不占终端列行）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore.getState().collapse("s1");
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		expect(tuiInputCalls("resize")).toHaveLength(0);
	});
});

describe("TuiPanel 窗口拖动与缩放", () => {
	const expanded = () => screen.getByTestId("tui-panel-expanded");
	const header = () => screen.getByTestId("tui-panel-header");

	test("拖标题栏移动浮窗（阈值 5px，mouseup 提交）", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		const left = parseFloat(expanded().style.left);
		const top = parseFloat(expanded().style.top);

		// 往左上拖（默认位置本就贴着视口右缘，往右会被 clamp 掉）
		fireEvent.mouseDown(header(), { clientX: 500, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 503, clientY: 302 }); // ≤5px：不算拖动
		expect(parseFloat(expanded().style.left)).toBe(left);
		fireEvent.mouseMove(window, { clientX: 460, clientY: 320 });
		fireEvent.mouseUp(window);

		expect(parseFloat(expanded().style.left)).toBe(left - 40);
		expect(parseFloat(expanded().style.top)).toBe(top + 20);
		// 位置随窗口状态持久化（重开应用仍在原处）
		expect(JSON.parse(localStorage.getItem("hiagent.tuiPanel.rect")!).x).toBe(
			left - 40,
		);
	});

	test("拖右下角把手缩放浮窗并上报新列行", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		expect(parseFloat(expanded().style.width)).toBe(680);

		fireEvent.mouseDown(screen.getByTestId("tui-panel-resize"), {
			clientX: 900,
			clientY: 600,
		});
		fireEvent.mouseMove(window, { clientX: 972, clientY: 619.4 });
		fireEvent.mouseUp(window);

		expect(parseFloat(expanded().style.width)).toBe(752);
		expect(parseFloat(expanded().style.height)).toBe(399.4);
		expect(tuiInputCalls("resize").map((c) => c.body)).toEqual([
			{ sessionId: "s1", panelId: "p1", type: "resize", cols: 104, rows: 20 },
		]);
	});

	test("拖动标题栏上的按钮不触发移动", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		const left = parseFloat(expanded().style.left);
		fireEvent.mouseDown(screen.getByTitle("取消该交互"), {
			clientX: 500,
			clientY: 300,
		});
		fireEvent.mouseMove(window, { clientX: 560, clientY: 360 });
		fireEvent.mouseUp(window);
		expect(parseFloat(expanded().style.left)).toBe(left);
	});

	test("缩放不小于最小尺寸，且不越出视口", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.mouseDown(screen.getByTestId("tui-panel-resize"), {
			clientX: 900,
			clientY: 600,
		});
		fireEvent.mouseMove(window, { clientX: -900, clientY: -900 });
		fireEvent.mouseUp(window);
		expect(parseFloat(expanded().style.width)).toBe(320);
		expect(parseFloat(expanded().style.height)).toBe(200);
	});

	test("会话切换后记忆的位置仍生效（组件重挂载读回）", () => {
		useTuiPanelStore.getState().open("s1", META);
		const { unmount } = render(<TuiPanel sessionId="s1" />);
		fireEvent.mouseDown(header(), { clientX: 500, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 600, clientY: 400 });
		fireEvent.mouseUp(window);
		const moved = parseFloat(expanded().style.left);
		unmount();

		useTuiPanelStore.getState().open("s2", META);
		render(<TuiPanel sessionId="s2" />);
		expect(parseFloat(expanded().style.left)).toBe(moved);
	});
});

describe("TuiPanel 快照补发", () => {
	const snapshot = (
		panels: ExtensionTuiSnapshotResult["panels"],
	): ExtensionTuiSnapshotResult => ({ type: "extension:tui:snapshot", panels });

	test("切会话时拉快照并铺回面板与最后一帧", async () => {
		const { rerender } = render(<TuiPanel sessionId="s1" />);
		const deferred = deferSnapshot();
		rerender(<TuiPanel sessionId="s2" />);
		await act(async () => {
			deferred.resolve(
				snapshot([
					{
						panelId: "p9",
						kind: "custom",
						title: "pi-lens",
						cols: 80,
						rows: 20,
						pending: 1,
						lastFrame: { lines: ["恢复的帧"], cursor: { row: 0, col: 2 } },
					},
				]),
			);
		});
		expect(
			calls.some((c) =>
				c.url.includes("/api/extensions/tui-snapshot?sessionId=s2"),
			),
		).toBe(true);
		expect(screen.getByText(/pi-lens/)).toBeTruthy();
		expect(screen.getByText(/恢复的帧/)).toBeTruthy();
	});

	test("快照里没有 custom 面板 → 清掉陈旧状态（断开期间面板已关）", async () => {
		useTuiPanelStore.getState().open("s1", META);
		const deferred = deferSnapshot();
		render(<TuiPanel sessionId="s1" />);
		await act(async () => {
			deferred.resolve(snapshot([]));
		});
		expect(useTuiPanelStore.getState().bySession.s1).toBeUndefined();
	});

	test("快照请求失败 → 保留当前面板（失败 ≠ 无面板）", async () => {
		useTuiPanelStore.getState().open("s1", META);
		const deferred = deferSnapshot();
		render(<TuiPanel sessionId="s1" />);
		await act(async () => {
			deferred.reject(new Error("kernel 重启中"));
		});
		expect(useTuiPanelStore.getState().bySession.s1?.panelId).toBe("p1");
		expect(screen.getByText(/pi-goal-x/)).toBeTruthy();
	});

	test("请求期间 SSE 推来新面板 → 慢到的空快照不覆盖它", async () => {
		const deferred = deferSnapshot();
		render(<TuiPanel sessionId="s1" />);
		// 请求在途时面板才打开（SSE open 与快照竞态）
		act(() => {
			useTuiPanelStore.getState().open("s1", { ...META, panelId: "p2" });
		});
		await act(async () => {
			deferred.resolve(snapshot([]));
		});
		expect(useTuiPanelStore.getState().bySession.s1?.panelId).toBe("p2");
	});

	test("sessionId 为 null 时不发快照请求", () => {
		render(<TuiPanel sessionId={null} />);
		expect(calls.filter((c) => c.url.includes("tui-snapshot"))).toHaveLength(0);
	});
});

describe("TuiPanel 链接与挂件态的配合", () => {
	test("挂件态里点链接不触发展开（只开链接）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["\u001b]8;;https://example.com\u0007文档\u001b]8;;\u0007"], null);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("收起"));
		fireEvent.click(screen.getByTestId("tui-panel-badge").querySelector("a")!);
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("badge");
	});
});
