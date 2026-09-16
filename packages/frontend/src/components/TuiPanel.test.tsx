// TuiPanel（ctx.ui.custom 三态浮窗）单测。
// 覆盖：三态渲染与切换、ANSI 属性、OSC 8 链接、光标、键盘/粘贴/鼠标/滚轮上报、
// 尺寸上报与 NaN 守卫、快照补发（成功/空/失败/竞态）、窗口拖动与缩放。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
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

function domRect(r: {
	left: number;
	top: number;
	width: number;
	height: number;
}): DOMRect {
	return {
		...r,
		right: r.left + r.width,
		bottom: r.top + r.height,
		x: r.left,
		y: r.top,
		toJSON: () => ({}),
	} as DOMRect;
}

/**
 * 面板里那个隐藏量宽 span 的桩矩形：一格 = cellWidth（默认取常量——JetBrains Mono
 * 12px 的真实前进宽，与现有用例的期望值同源）。非探针元素返回 null，交给各桩自己处理。
 *
 * 没有这条，全局矩形桩会把探针也算成面板宽，实测格宽就变成“面板宽 ÷ 探针字数”的垃圾值。
 */
function probeRect(el: HTMLElement, cellWidth = CELL.width): DOMRect | null {
	if (el.getAttribute?.("data-testid") !== "tui-panel-metric") return null;
	return domRect({
		left: 0,
		top: 0,
		width: cellWidth * (el.textContent?.length ?? 0),
		height: 0,
	});
}

function stubRects(rect: {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
}) {
	const original = HTMLElement.prototype.getBoundingClientRect;
	const r = { left: 0, top: 0, width: 0, height: 0, ...rect };
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		return probeRect(this) ?? domRect(r);
	};
	restores.push(() => {
		HTMLElement.prototype.getBoundingClientRect = original;
	});
}

/** 面板标题栏高度（px）：容器高 − 它就是文本区高（镜像真实布局） */
const HEADER_HEIGHT = 30;

/**
 * 格宽探针桩：面板里那个隐藏的量宽 span 给实测宽（cellWidth × 探针字符数），
 * 其余元素沿用已装的桩（通常是零布局的 happy-dom）。
 * 必须是**可叠加**的桩：测宽与面板布局是两个独立坐标，得同时生效。
 */
function stubMetricProbe(cellWidth: number) {
	const previous = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		return probeRect(this, cellWidth) ?? previous.call(this);
	};
	restores.push(() => {
		HTMLElement.prototype.getBoundingClientRect = previous;
	});
}

/**
 * 面板布局桩：面板尺寸取展开浮窗的**实时内联样式**（拖动/缩放直接改它），
 * 文本区尺寸 = 面板尺寸 − 标题栏高度。
 * 必须区分容器与文本区——「按容器上报」正是要修的错（多算标题栏那 1 行）。
 *
 * 面板**之外**的元素一律零矩形：面板是 absolute，坐标基准变成它的定位上下文
 * （聊天列容器），桩若把面板尺寸也塞给定位上下文，容器尺寸就被面板冒充了。
 */
function stubPanelLayout(headerHeight: number) {
	const original = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const probe = probeRect(this);
		if (probe) return probe;
		const boxEl = document.querySelector<HTMLElement>(
			'[data-testid="tui-panel-expanded"]',
		);
		if (!boxEl || (boxEl !== this && !boxEl.contains(this))) {
			return domRect({ left: 0, top: 0, width: 0, height: 0 });
		}
		const w = Number.parseFloat(boxEl.style.width) || 0;
		const h = Number.parseFloat(boxEl.style.height) || 0;
		const isBody = this.getAttribute?.("data-testid") === "tui-panel-body";
		return domRect(
			isBody
				? {
						left: 0,
						top: headerHeight,
						width: w,
						height: Math.max(0, h - headerHeight),
					}
				: { left: 0, top: 0, width: w, height: h },
		);
	};
	restores.push(() => {
		HTMLElement.prototype.getBoundingClientRect = original;
	});
}

/**
 * 聊天列容器桩：**可叠加**——面板是 absolute，坐标基准是最近的定位祖先（SessionView
 * 里聊天列那个 relative 容器），而 stubRects 给所有元素同一矩形，区分不出容器与面板。
 * 只对 `data-testid="chat-column"` 的元素返回容器尺寸，其余沿用已装的桩。
 */
function stubChatColumn(width: number, height: number) {
	const previous = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const probe = probeRect(this);
		if (probe) return probe;
		if (this.getAttribute?.("data-testid") === "chat-column") {
			return domRect({ left: 0, top: 0, width, height });
		}
		return previous.call(this);
	};
	restores.push(() => {
		HTMLElement.prototype.getBoundingClientRect = previous;
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
			return snapshotDeferred
				? snapshotDeferred.promise
				: new Promise<Response>(() => {});
		}
		if (tuiInputFails) return new Response("boom", { status: 500 });
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as never;
});

afterEach(() => {
	// 必须**倒序**恢复：桩是可叠加的（后装的包装先装的），正序恢复会把先装的那个
	// 再装回去——此后所有用例都读到残留的矩形（locateSize 读定位上下文时就会中招）。
	for (const restore of restores.slice().reverse()) restore();
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
		expect(screen.getByTestId("tui-panel-pill").textContent).toContain(
			"pi-goal-x",
		);
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
		fireEvent.mouseDown(el, {
			clientX: atCol(5),
			clientY: 2 * CELL.height,
			button: 0,
		});
		fireEvent.mouseUp(window, { clientX: atCol(5), clientY: 2 * CELL.height });

		expect(tuiInputCalls("mouse").map((c) => c.body.data)).toEqual([
			encodeMouse("down", 0, 6, 3),
			encodeMouse("up", 0, 6, 3),
		]);
	});

	/**
	 * 拖选不再转发 drag 序列：复制路径改成「浏览器原生选择 + Cmd+C」（规格 §7.5 的偏离裁定），
	 * 而 TUI 收到 drag 会自己走选择逻辑、把原生选字打断。点击要用的 down/up 仍照发。
	 */
	test("按住拖动只发 down/up（点击语义），不产出 drag 序列", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		const el = body();
		fireEvent.mouseDown(el, { clientX: atCol(0), clientY: 0, button: 0 });
		fireEvent.mouseMove(el, { clientX: atCol(5), clientY: CELL.height });
		fireEvent.mouseUp(window, { clientX: atCol(5), clientY: CELL.height });

		const mouse = tuiInputCalls("mouse").map((c) => c.body.data);
		expect(mouse).toEqual([
			encodeMouse("down", 0, 1, 1),
			encodeMouse("up", 0, 6, 2),
		]);
		expect(mouse).not.toContain(encodeMouse("drag", 0, 6, 2));
	});

	/**
	 * 长帧必须能滚到：pi 侧取的是**整帧快照**（不按可视行数裁剪），所以内容区一旦用
	 * overflow-hidden，超出的几十行会被静默裁掉——用户既看不到也滚不到。
	 * 真实场景：pi-goal-x 的提案确认面板（constraints/tasks/verification 全文 40+ 行）
	 * 远超面板的 ~19 行。
	 */
	test("长帧超出面板高度时内容区可纵向滚动，且全部行都在 DOM 里", () => {
		useTuiPanelStore.getState().open("s1", META);
		const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
		useTuiPanelStore.getState().setFrame("s1", "p1", lines, null);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);

		const el = body();
		// 纵向可滚（class 断言，与仓库其他组件测同口径：happy-dom 无真实 CSS 布局）
		expect(el.className).toContain("overflow-y-auto");
		// 不裁剪帧内容：首行与末行都在 DOM 里，滚动即可到达
		expect(screen.getByText("line-0")).toBeTruthy();
		expect(screen.getByText("line-59")).toBeTruthy();
	});

	/**
	 * 复制能力靠浏览器原生选择：mousedown 不能 preventDefault（否则拖选连选区都起不来），
	 * 元素上也要显式声明可选中（祖先若有 user-select: none，这一点能覆盖回来）。
	 */
	test("按下面板文本区不阻止默认行为，且文本可选中", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		const el = body();
		// fireEvent 返回 false = 默认行为被 preventDefault 吃掉
		expect(
			fireEvent.mouseDown(el, { button: 0, clientX: atCol(1), clientY: 0 }),
		).toBe(true);
		expect(el.style.userSelect).toBe("text");
		// 焦点仍要收回面板：Composer 已 disabled，焦点留在外面会静默丢键
		expect(document.activeElement).toBe(screen.getByTestId("tui-panel-expanded"));
	});

	test("未按下时移动不产生任何鼠标上报", () => {
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
		const ev = new WheelEvent("wheel", {
			deltaY,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(ev, "clientX", { value: clientX });
		Object.defineProperty(ev, "clientY", { value: 0 });
		fireEvent(el, ev);
	};

	/**
	 * 滚轮改为滚动面板内容本身，不再转发给插件。
	 *
	 * 真实缺陷（用户实测）：pi 侧取的是**整帧快照**（不按可视行数裁剪），插件的视口
	 * 滚动不会体现在帧里——转发出去等于「滚了没反应」，还会与本地滚动打架。
	 * 内容区必须是 overflow-y-auto，长帧要能滚到最后一行。
	 */
	test("滚轮滚动面板内容，不再产出 mouse 上报", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 720, height: 388 });
		render(<TuiPanel sessionId="s1" />);
		wheelAt(body(), atCol(5), -100);
		wheelAt(body(), atCol(5), 100);
		expect(tuiInputCalls("mouse")).toEqual([]);
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
	/**
	 * 上报基准必须是**文本区**（body），不是含标题栏的容器：
	 * 按容器（680×380）换算会得到 94×19，而可见网格只有 92×18（左内边距 12px、标题栏 30px），
	 * 多出来的 2 列 1 行会被 body 的 overflow-hidden 裁掉。
	 */
	test("上报的 cols/rows 与文本区尺寸一致（不含标题栏误差）", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubPanelLayout(HEADER_HEIGHT);
		render(<TuiPanel sessionId="s1" />);
		const reported = tuiInputCalls("resize").at(-1)!.body;
		expect(reported.cols).toBe(Math.floor((680 - 12) / CELL.width)); // 92
		expect(reported.rows).toBe(
			Math.floor((380 - HEADER_HEIGHT) / CELL.height), // 18
		);
		// 容器语义会多算标题栏那 1 行（19）与左内边距那 2 列（94）：钉住修的就是它
		expect(reported.cols).toBeLessThan(Math.floor(680 / CELL.width));
		expect(reported.rows).toBeLessThan(Math.floor(380 / CELL.height));
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

describe("TuiPanel 格宽实测", () => {
	/** 桩：实测格宽 8px（与兜底常量 7.2px 不同，以便区分用了哪一份度量） */
	const MEASURED = 8;

	test("尺寸上报按实测格宽换算（不再是硬编码常量）", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubPanelLayout(HEADER_HEIGHT);
		stubMetricProbe(MEASURED);
		render(<TuiPanel sessionId="s1" />);
		const reported = tuiInputCalls("resize").at(-1)!.body;
		expect(reported.cols).toBe(Math.floor((680 - 12) / MEASURED)); // 83
		expect(reported.rows).toBe(Math.floor((380 - HEADER_HEIGHT) / CELL.height)); // 行高仍由常量锁定
		// 用硬编码 7.2 会报 92 列（多报 9 列）：钒住修的就是它
		expect(reported.cols).not.toBe(Math.floor((680 - 12) / CELL.width));
	});

	test("鼠标列换算用同一份实测格宽（上报与命中同一度量）", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubRects({ width: 800, height: 400 });
		stubMetricProbe(MEASURED);
		render(<TuiPanel sessionId="s1" />);
		// 第 10 列：按实测 8px 是 12+9×8=84px（按常量 7.2px 会算成第 11 列）
		fireEvent.mouseDown(body(), {
			clientX: 12 + 9 * MEASURED,
			clientY: 2 * CELL.height,
			button: 0,
		});
		expect(tuiInputCalls("mouse").at(-1)!.body.data).toBe(
			encodeMouse("down", 0, 10, 3),
		);
	});

	/**
	 * 含中文的帧行：全角字符的列由 kernel 按「CJK 占 2 格」算好塞进 `cursor.col`，
	 * 前端只用同一份实测格宽做「列 → 像素」换算。若谁改回按字符个数换算，这个用例会红。
	 */
	test("含中文的帧行：光标列位置按实测格宽换算（全角占 2 格）", () => {
		useTuiPanelStore.getState().open("s1", META);
		// 「▸ 中文」= 1 + 1 + 2 + 2 = 6 格，col 5 落在「文」上（按字符个数只有 4）
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["▸ 中文"], { row: 0, col: 5 });
		stubRects({ width: 800, height: 400 });
		stubMetricProbe(MEASURED);
		render(<TuiPanel sessionId="s1" />);
		const cursor = screen.getByTestId("tui-panel-cursor");
		expect(cursor.style.left).toBe(`${12 + 5 * MEASURED}px`);
		expect(cursor.style.width).toBe(`${MEASURED}px`);
	});

	/**
	 * 浏览器回退字体的 CJK 前进宽 ≈ 1.67 格（≠ 终端语义的 2 格），不校正的话含中文的行
	 * 整体比 TUI 假设的窄，行内右对齐/边框字符与光标都会左移。因此每个全角字符包一个
	 * 固定宽度的行内块，宽 = 2 × 实测格宽。
	 */
	test("含中文的帧行：每个全角字符按 2 格宽渲染，半角部分不包 box", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore.getState().setFrame("s1", "p1", ["▸ 中文 ok"], null);
		stubRects({ width: 800, height: 400 });
		stubMetricProbe(MEASURED);
		render(<TuiPanel sessionId="s1" />);
		const boxes = [...body().querySelectorAll<HTMLElement>("[data-tui-wide]")];
		expect(boxes.map((b) => b.textContent)).toEqual(["中", "文"]);
		expect(boxes.map((b) => b.style.width)).toEqual([
			`${2 * MEASURED}px`,
			`${2 * MEASURED}px`,
		]);
		// 全角被拆成多个节点，但整行可见文本不变（复制/选择仍是原文本）
		expect(body().textContent).toBe("▸ 中文 ok");
	});

	test("带 ANSI 属性的帧行：全角字符同样按 2 格渲染（属性与格宽互不干扰）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["\u001b[1;4m中文\u001b[0m"], null);
		stubRects({ width: 800, height: 400 });
		stubMetricProbe(MEASURED);
		render(<TuiPanel sessionId="s1" />);
		const box = body().querySelector<HTMLElement>("[data-tui-wide]")!;
		expect(box.textContent).toBe("中");
		expect(box.style.width).toBe(`${2 * MEASURED}px`);
		// 粗体/下划线来自 SGR 1;4：外层片段仍带属性
		const styled = box.closest<HTMLElement>("span[style*=font-weight]")!;
		expect(styled.style.fontWeight).toBe("600");
		expect(styled.style.textDecoration).toBe("underline");
		// 行内块不继承祖先的 text-decoration，必须显式 inherit 才能让下划线画到汉字下
		expect(box.style.textDecoration).toBe("inherit");
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

	test("拖右下角把手缩放浮窗并上报新列行（按文本区，非容器）", () => {
		useTuiPanelStore.getState().open("s1", META);
		stubPanelLayout(HEADER_HEIGHT);
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
		// 展开时一次（容器 680×380 → 文本区 680×350），缩放提交再一次（752×399.4 → 752×369.4）
		expect(tuiInputCalls("resize").map((c) => c.body)).toEqual([
			{ sessionId: "s1", panelId: "p1", type: "resize", cols: 92, rows: 18 },
			{ sessionId: "s1", panelId: "p1", type: "resize", cols: 102, rows: 19 },
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

describe("TuiPanel 焦点归属", () => {
	const expanded = () => screen.getByTestId("tui-panel-expanded");

	/** 造一个面板外的可聚焦元素并聚焦它，模拟「用户点过 Composer / 侧栏」 */
	function focusOutside() {
		const outside = document.createElement("input");
		document.body.appendChild(outside);
		outside.focus();
		return outside;
	}

	/**
	 * mousedown 被 preventDefault 会吃掉浏览器「把焦点给可聚焦祖先」的默认动作，
	 * 必须显式把焦点还给面板容器——否则点过别处再点回面板时焦点回不来，
	 * 而 Composer 已 disabled：面板看着是活的却在丢键。
	 */
	test("焦点在别处时，按下面板文本区会把焦点收回面板", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		const outside = focusOutside();
		fireEvent.mouseDown(body(), { button: 0 });
		expect(document.activeElement).toBe(expanded());
		outside.remove();
	});

	test("焦点在别处时，按标题栏拖动也把焦点收回面板", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		const outside = focusOutside();
		fireEvent.mouseDown(screen.getByTestId("tui-panel-header"), {
			clientX: 500,
			clientY: 300,
		});
		expect(document.activeElement).toBe(expanded());
		outside.remove();
	});

	test("标题栏按钮不抢焦点（按钮自身是可聚焦元素）", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		const outside = focusOutside();
		fireEvent.mouseDown(screen.getByTitle("取消该交互"));
		expect(document.activeElement).not.toBe(expanded());
		outside.remove();
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
		// 全角字符被拆成固定宽度片段（「全角占两格」，见「TuiPanel 格宽实测」），
		// 连续文本查询命不中单个节点，改断容器文本；光标覆盖层是空 div，不贡献文本
		expect(screen.getByTestId("tui-panel-body").textContent).toBe("恢复的帧");
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
			.setFrame(
				"s1",
				"p1",
				["\u001b]8;;https://example.com\u0007文档\u001b]8;;\u0007"],
				null,
			);
		render(<TuiPanel sessionId="s1" />);
		fireEvent.click(screen.getByTitle("收起"));
		fireEvent.click(screen.getByTestId("tui-panel-badge").querySelector("a")!);
		expect(useTuiPanelStore.getState().bySession.s1!.mode).toBe("badge");
	});
});

/**
 * 用户实测缺陷（本组用例的由来）：
 *   1. 挂件没对齐聊天区域右上角——三态都是 `fixed` + 挂在 App 根节点上，
 *      坐标又以 window 为基准，于是贴的是**整个窗口**的右上角；
 *   2. 挂件不能拖动——拖动只实现在展开态；
 *   3. 挂件「只能停在一个固定位置、拖不动了」——收起态复用展开矩形的 x（680 宽的语义），
 *      渲染又按 `right: 容器宽 − (x + 680)` 定位，实际左缘 = x + 412，而 x 被按 680 clamp，
 *      可达区间被压成 [412, 898]，左侧 412px 永远拖不到。
 * 修法：面板挂进 SessionView 的聊天列容器（relative）内、三态改 absolute、
 * 坐标基准换成该容器；三态一律**左缘锚定**，且收起态（挂件/胶囊）与展开态各有各的位置，
 * clamp 各按自身宽度来。
 */
describe("TuiPanel 聊天列定位与挂件拖动", () => {
	/** 聊天列容器尺寸：比窗口（happy-dom 1024×768）窄，好抓「按窗口算」的错 */
	const CHAT = { width: 900, height: 600 };
	/** 展开态默认尺寸（与组件内 EXPANDED_SIZE 同口径） */
	const EXPANDED = { width: 680, height: 380 };
	/** 挂件宽（与组件内 BADGE_WIDTH 同口径）：收起态的位置与 clamp 都以它为基准 */
	const BADGE = { width: 268 };
	const LS_KEY = "hiagent.tuiPanel.rect";
	/** 收起态（挂件/胶囊）位置的持久化键：与展开态分开存 */
	const LS_POS = "hiagent.tuiPanel.collapsed";

	/** 与 SessionView 的真实结构一致：面板挂在聊天列容器（relative）内 */
	const renderInChatColumn = () =>
		render(
			<div data-testid="chat-column">
				<TuiPanel sessionId="s1" />
			</div>,
		);
	const expanded = () => screen.getByTestId("tui-panel-expanded");
	const badge = () => screen.getByTestId("tui-panel-badge");
	/** 胶囊态的定位在容器上（testid 在标题按钮上，与现网一致） */
	const pillBox = () =>
		screen.getByTestId("tui-panel-pill").parentElement as HTMLElement;
	const savedRect = () => JSON.parse(localStorage.getItem(LS_KEY)!);
	const savedPos = () => JSON.parse(localStorage.getItem(LS_POS)!);
	const mode = () => useTuiPanelStore.getState().bySession.s1!.mode;

	/** 收起态默认左缘：容器宽 − 挂件宽 − 16（贴聊天列右上角） */
	const collapsedDefaultX = CHAT.width - BADGE.width - 16;

	test("三态都改成 absolute 定位（相对聊天列，不再相对整个窗口）", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();

		expect(expanded().className).toContain("absolute");
		expect(expanded().className).not.toContain("fixed");

		act(() => useTuiPanelStore.getState().collapse("s1"));
		expect(badge().className).toContain("absolute");
		expect(badge().className).not.toContain("fixed");

		act(() => useTuiPanelStore.getState().collapseDeeper("s1"));
		expect(pillBox().className).toContain("absolute");
		expect(pillBox().className).not.toContain("fixed");
	});

	test("默认位置取聊天列右上角（容器宽 − 面板宽 − 16），不是窗口右上角", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();

		// 按窗口宽 1024 会算成 328：钉住基准是聊天列容器
		expect(parseFloat(expanded().style.left)).toBe(
			CHAT.width - EXPANDED.width - 16,
		);
		expect(parseFloat(expanded().style.top)).toBe(16);
	});

	test("挂件默认贴聊天列右上角：左缘 = 容器宽 − 挂件宽 − 16", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		expect(parseFloat(badge().style.left)).toBe(collapsedDefaultX);
		expect(parseFloat(badge().style.top)).toBe(16);
		// 左缘锚定：不再写 right（右缘锚定会让位置随自身宽度漂）
		expect(badge().style.right).toBe("");
	});

	/**
	 * 本次修复的核心回归：挂件左缘能到容器左缘 0。
	 * 旧实现把收起态的 x 按展开宽 clamp（[0, 容器宽 − 680]）又按 `right` 定位，
	 * 于是往左拖到极限只能停在 412（= 680 − 268）。
	 */
	test("挂件能拖到容器最左上角（左侧不再有 412px 死区）", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 800, clientY: 40 });
		// 拖到远超容器左上角的位置
		fireEvent.mouseMove(window, { clientX: -2400, clientY: -2400 });
		fireEvent.mouseUp(window);

		expect(parseFloat(badge().style.left)).toBe(0);
		expect(parseFloat(badge().style.top)).toBe(0);
		expect(savedPos()).toEqual({ x: 0, y: 0 });
	});

	/**
	 * 挂件拖动：只改**收起态自己的**位置（与展开态矩形分开存），
	 * 拖完再展开时面板用展开态自己的位置；拖动**不等于**点击展开。
	 */
	test("拖动挂件改收起态位置且不展开，展开后仍用展开态自己的位置", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 800, clientY: 40 });
		// ≤5px 的位移还算「点击」：位置一点都不能动
		fireEvent.mouseMove(window, { clientX: 797, clientY: 41 });
		expect(parseFloat(badge().style.left)).toBe(collapsedDefaultX);
		// 左移 100px、下移 20px
		fireEvent.mouseMove(window, { clientX: 700, clientY: 60 });
		fireEvent.mouseUp(window);

		expect(mode()).toBe("badge");
		expect(parseFloat(badge().style.left)).toBe(collapsedDefaultX - 100);
		expect(parseFloat(badge().style.top)).toBe(16 + 20);
		expect(savedPos()).toEqual({ x: collapsedDefaultX - 100, y: 16 + 20 });
		// 收起态不写展开态的键（两者各记各的位置）
		expect(localStorage.getItem(LS_KEY)).toBeNull();

		// 真实浏览器 mouseup 后会补一个 click：拖动过就必须吃掉它（否则一拖就展开）
		fireEvent.click(badge());
		expect(mode()).toBe("badge");
		// 没拖动的那次点击照常展开，且落到展开态自己的默认位置（不跟着挂件跑）
		fireEvent.click(badge());
		expect(mode()).toBe("expanded");
		expect(parseFloat(expanded().style.left)).toBe(
			CHAT.width - EXPANDED.width - 16,
		);
	});

	test("拖动展开态只改展开态位置，收起态仍是自己的默认位置", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();

		fireEvent.mouseDown(screen.getByTestId("tui-panel-header"), {
			clientX: 500,
			clientY: 300,
		});
		fireEvent.mouseMove(window, { clientX: 400, clientY: 260 });
		fireEvent.mouseUp(window);
		expect(parseFloat(expanded().style.left)).toBe(
			CHAT.width - EXPANDED.width - 16 - 100,
		);

		act(() => useTuiPanelStore.getState().collapse("s1"));
		expect(parseFloat(badge().style.left)).toBe(collapsedDefaultX);
		expect(parseFloat(badge().style.top)).toBe(16);
		// 展开态不写收起态的键
		expect(localStorage.getItem(LS_POS)).toBeNull();
	});

	test("挂件点击（位移 ≤ 5px）仍展开，且不写位置", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 800, clientY: 40 });
		fireEvent.mouseMove(window, { clientX: 803, clientY: 42 });
		fireEvent.mouseUp(window);
		fireEvent.click(badge());

		expect(mode()).toBe("expanded");
		// 点击不是拖动：不落盘用户位置（下次仍按容器默认右上角）
		expect(localStorage.getItem(LS_KEY)).toBeNull();
	});

	test("挂件拖不出聊天列：越过右边界被限制在容器宽 − 挂件宽", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 700, clientY: 40 });
		fireEvent.mouseMove(window, { clientX: 2400, clientY: 40 });
		fireEvent.mouseUp(window);

		// 按展开宽 680 会算成 220：钉住 clamp 用的是挂件自身宽
		expect(parseFloat(badge().style.left)).toBe(CHAT.width - BADGE.width);
		expect(savedPos().x).toBe(CHAT.width - BADGE.width);
	});

	test("拖动展开态面板也在聊天列内 clamp（宽高都用容器尺寸）", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();

		fireEvent.mouseDown(screen.getByTestId("tui-panel-header"), {
			clientX: 500,
			clientY: 300,
		});
		fireEvent.mouseMove(window, { clientX: 2400, clientY: 2400 });
		fireEvent.mouseUp(window);

		expect(parseFloat(expanded().style.left)).toBe(CHAT.width - EXPANDED.width);
		expect(parseFloat(expanded().style.top)).toBe(CHAT.height - EXPANDED.height);
		expect(savedRect().x).toBe(CHAT.width - EXPANDED.width);
		expect(savedRect().y).toBe(CHAT.height - EXPANDED.height);
	});

	test("胶囊态同样可拖，且与挂件共享同一份收起态位置", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));
		act(() => useTuiPanelStore.getState().collapseDeeper("s1"));

		// 胶囊复用挂件的默认 x（贴聊天列右上角）
		expect(parseFloat(pillBox().style.left)).toBe(collapsedDefaultX);

		fireEvent.mouseDown(pillBox(), { clientX: 800, clientY: 40 });
		fireEvent.mouseMove(window, { clientX: 750, clientY: 40 });
		fireEvent.mouseUp(window);

		expect(mode()).toBe("pill");
		expect(savedPos()).toEqual({ x: collapsedDefaultX - 50, y: 16 });
		// mouseup 补的 click 落在标题按钮上：拖动过就吃掉
		fireEvent.click(screen.getByTestId("tui-panel-pill"));
		expect(mode()).toBe("pill");
		// 没拖动的点击照常展开
		fireEvent.click(screen.getByTestId("tui-panel-pill"));
		expect(mode()).toBe("expanded");
	});

	test("挂件与胶囊共享收起态位置：拖完挂件再收成胶囊，位置跟着走", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 800, clientY: 40 });
		fireEvent.mouseMove(window, { clientX: -2400, clientY: -2400 });
		fireEvent.mouseUp(window);

		act(() => useTuiPanelStore.getState().collapseDeeper("s1"));
		expect(parseFloat(pillBox().style.left)).toBe(0);
		expect(parseFloat(pillBox().style.top)).toBe(0);
	});

	test("收起态位置独立持久化：重挂载后读回，不碰展开态的键", () => {
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		const { unmount } = renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		fireEvent.mouseDown(badge(), { clientX: 600, clientY: 40 });
		fireEvent.mouseMove(window, { clientX: 500, clientY: 60 });
		fireEvent.mouseUp(window);
		const moved = parseFloat(badge().style.left);
		expect(moved).toBe(collapsedDefaultX - 100);
		unmount();

		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));
		expect(parseFloat(badge().style.left)).toBe(moved);
		expect(parseFloat(badge().style.top)).toBe(36);
		expect(localStorage.getItem(LS_KEY)).toBeNull();
	});

	test("读回收起态位置：越界按挂件宽 clamp 回容器内", () => {
		localStorage.setItem(LS_POS, JSON.stringify({ x: 9999, y: -50 }));
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		expect(parseFloat(badge().style.left)).toBe(CHAT.width - BADGE.width);
		expect(parseFloat(badge().style.top)).toBe(0);
	});

	test("读回收起态位置：形状非法（缺字段/非数字）回落默认右上角", () => {
		localStorage.setItem(LS_POS, JSON.stringify({ x: 10 }));
		stubChatColumn(CHAT.width, CHAT.height);
		useTuiPanelStore.getState().open("s1", META);
		renderInChatColumn();
		act(() => useTuiPanelStore.getState().collapse("s1"));

		expect(parseFloat(badge().style.left)).toBe(collapsedDefaultX);
		expect(parseFloat(badge().style.top)).toBe(16);
	});
});

/**
 * 浮窗主题化（本组用例的由来）：三态外壳此前写死了暗色 hex（#101014/#1a1a21/#8b8b9a/#d2d2de），
 * 亮色主题下仍是黑底白字。改法：一律换成 styles.css 语义 token 对应的 Tailwind 类
 * （bg-canvas / bg-surface-elevated / text-primary / text-secondary / text-accent）。
 *
 * 断言口径：happy-dom 没有真实 CSS 计算，只能断言「类名命中语义类」+「内联样式里不留 hex」
 * ——后者正是这次要防的回归（把 hex 从内联样式搬进类名以外的任何地方都会被抓到）。
 * 帧里插件输出的 ANSI 前景/背景色由 AnsiText 自带内联样式，**不在此列**（终端语义，保持原样），
 * 所以只扫面板外壳元素自身，不扫帧行内部。
 */
describe("TuiPanel 浮窗主题化", () => {
	/** 内联样式里出现任何 hex 色值都算硬编码残留 */
	const HEX = /#[0-9a-fA-F]{3,8}/;
	const assertNoInlineHex = (el: HTMLElement) => {
		expect(el.getAttribute("style") ?? "").not.toMatch(HEX);
	};

	test("展开态：卡片/标题栏/内容区用主题类，内联样式无硬编码色", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore.getState().setFrame("s1", "p1", ["Objective"], null);
		render(<TuiPanel sessionId="s1" />);

		// 卡片：终端内容底色取最底层的 canvas，并补齐浮层描边（与仓库其他浮层一致）
		const box = screen.getByTestId("tui-panel-expanded");
		expect(box.className).toContain("bg-canvas");
		expect(box.className).toContain("border-hairline");
		assertNoInlineHex(box);

		// 标题栏：抬高一层的表面色
		const header = screen.getByTestId("tui-panel-header");
		expect(header.className).toContain("bg-surface-elevated");
		assertNoInlineHex(header);

		// 标题文字与两个按钮：次级文字色
		expect(screen.getByText(/pi-goal-x/).className).toContain("text-secondary");
		expect(screen.getByTitle("收起").className).toContain("text-secondary");
		expect(screen.getByTitle("取消该交互").className).toContain("text-secondary");

		// 内容区默认文字色：主文字色（帧里 ANSI 显式色仍由 AnsiText 覆盖）
		const b = body();
		expect(b.className).toContain("text-primary");
		assertNoInlineHex(b);
	});

	test("展开态：光标方块取主题文字色，不再写死 rgba 常量", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame("s1", "p1", ["aaa", "bb"], { row: 1, col: 3 });
		render(<TuiPanel sessionId="s1" />);

		const cursor = screen.getByTestId("tui-panel-cursor");
		expect(cursor.style.background).toContain("var(--text-primary)");
		// 保留原来的半透明（mix-blend-difference 下的反色强度靠它），只是颜色来源换成了主题变量
		expect(Number(cursor.style.opacity)).toBeCloseTo(0.75, 5);
		assertNoInlineHex(cursor);
	});

	test("挂件态：卡片与预览区用主题类", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore.getState().setFrame("s1", "p1", ["Objective"], null);
		render(<TuiPanel sessionId="s1" />);
		act(() => useTuiPanelStore.getState().collapse("s1"));

		const badge = screen.getByTestId("tui-panel-badge");
		expect(badge.className).toContain("bg-surface-elevated");
		assertNoInlineHex(badge);

		expect(screen.getByText(/pi-goal-x/).className).toContain("text-secondary");
		expect(screen.getByTitle("收成胶囊").className).toContain("text-secondary");

		// 预览区：与展开态内容区同一套底色/文字色
		const preview = badge.querySelector("div.whitespace-pre") as HTMLElement;
		expect(preview.className).toContain("bg-canvas");
		expect(preview.className).toContain("text-primary");
		assertNoInlineHex(preview);
	});

	test("胶囊态：容器与标题/取消按钮用主题类", () => {
		useTuiPanelStore.getState().open("s1", META);
		render(<TuiPanel sessionId="s1" />);
		act(() => useTuiPanelStore.getState().collapseDeeper("s1"));

		const pill = screen.getByTestId("tui-panel-pill");
		expect(pill.className).toContain("text-primary");
		assertNoInlineHex(pill);

		const box = pill.parentElement as HTMLElement;
		expect(box.className).toContain("bg-surface-elevated");
		assertNoInlineHex(box);

		expect(screen.getByTitle("取消该交互").className).toContain("text-secondary");
	});

	test("面板内 OSC 8 链接用语义 accent 类（沿用仓库链接口径）", () => {
		useTuiPanelStore.getState().open("s1", META);
		useTuiPanelStore
			.getState()
			.setFrame(
				"s1",
				"p1",
				["\u001b]8;;https://example.com\u0007文档\u001b]8;;\u0007"],
				null,
			);
		render(<TuiPanel sessionId="s1" />);

		const link = body().querySelector("a") as HTMLAnchorElement;
		expect(link.className).toContain("text-accent");
		assertNoInlineHex(link);
	});
});
