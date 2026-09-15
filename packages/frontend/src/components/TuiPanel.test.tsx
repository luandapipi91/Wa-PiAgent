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
 * 面板布局桩：容器尺寸取展开浮窗的**实时内联样式**（拖动/缩放直接改它），
 * 文本区尺寸 = 容器尺寸 − 标题栏高度。
 * 必须区分容器与文本区——「按容器上报」正是要修的错（多算标题栏那 1 行）。
 */
function stubPanelLayout(headerHeight: number) {
	const original = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const probe = probeRect(this);
		if (probe) return probe;
		const boxEl = document.querySelector<HTMLElement>(
			'[data-testid="tui-panel-expanded"]',
		);
		const w = boxEl ? Number.parseFloat(boxEl.style.width) || 0 : 0;
		const h = boxEl ? Number.parseFloat(boxEl.style.height) || 0 : 0;
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
