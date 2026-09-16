// togglePreservingViewport 单元测试：折叠/展开时的视口位置补偿逻辑。
// happy-dom 无真实布局（getBoundingClientRect 返回 0），通过可控 mock 模拟
// 「折叠 → 列表高度骤减 → scrollTop 被 clamp → 锚点视口位置漂移」场景。
// 补偿是延迟单次执行（delayMs 可注入），测试传 0 后用微任务等待回调。
import { test, expect, mock } from "bun:test";
import { togglePreservingViewport } from "../../src/components/blocks/toggleViewport";

interface ScrollerMock {
	el: HTMLElement;
	anchor: HTMLElement;
	/** anchor 当前视口 top（getBoundingClientRect mock 的返回值） */
	anchorTop: number;
	setScrollTop: (v: number) => void;
	/** 更新模拟的列表总高（模拟折叠后的新文档高度） */
	setScrollHeight: (v: number) => void;
}

/** 等待延迟补偿回调执行（delayMs=0 时 setTimeout(0) 仍异步） */
async function flushCompensation() {
	await new Promise((r) => setTimeout(r, 5));
}

/**
 * 构建 scroller[data-virtuoso-scroller] > anchor 结构。
 * scrollHeight 为只读 getter 用 defineProperty 覆写；scrollTop 用 accessor 覆写并
 * 模拟浏览器 clamp（0 ≤ scrollTop ≤ scrollHeight - clientHeight），保证 toggle 内
 * 直接写 scroller.scrollTop 与测试里的 setScrollTop 行为一致。
 */
function makeScroller(opts: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	anchorTop: number;
}): ScrollerMock {
	const el = document.createElement("div");
	el.setAttribute("data-virtuoso-scroller", "true");
	const anchor = document.createElement("button");
	el.appendChild(anchor);
	document.body.appendChild(el);
	let currentScrollTop = opts.scrollTop;
	let scrollHeight = opts.scrollHeight;
	Object.defineProperty(el, "scrollHeight", {
		get: () => scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: opts.clientHeight,
		configurable: true,
	});
	Object.defineProperty(el, "scrollTop", {
		get: () => currentScrollTop,
		set: (v: number) => {
			currentScrollTop = Math.max(
				0,
				Math.min(v, scrollHeight - opts.clientHeight),
			);
		},
		configurable: true,
	});
	const m: ScrollerMock = {
		el,
		anchor,
		anchorTop: opts.anchorTop,
		setScrollTop: (v: number) => {
			currentScrollTop = Math.max(
				0,
				Math.min(v, scrollHeight - opts.clientHeight),
			);
		},
		setScrollHeight: (v: number) => {
			scrollHeight = v;
		},
	};
	// 用 DOMRect 实例改 top（happy-dom 提供 DOMRect 构造器）
	anchor.getBoundingClientRect = () => new DOMRect(0, m.anchorTop);
	return m;
}

test("无 scroller 祖先：直接执行切换，不注册补偿", async () => {
	const orphan = document.createElement("button");
	document.body.appendChild(orphan);
	const apply = mock(() => {});
	togglePreservingViewport(orphan, apply, 0);
	expect(apply).toHaveBeenCalled();
	await flushCompensation();
});

test("贴底状态（距底 < 40px）：执行切换但不补偿，交给贴底跟随逻辑", async () => {
	const m = makeScroller({
		scrollTop: 2000,
		scrollHeight: 2500,
		clientHeight: 500,
		anchorTop: 100,
	});
	const apply = mock(() => {});
	togglePreservingViewport(m.anchor, apply, 0);
	expect(apply).toHaveBeenCalled();
	await flushCompensation();
	expect(m.el.scrollTop).toBe(2000);
	m.el.remove();
});

test("clamp 后锚点漂移：补偿 scrollTop 使锚点精确回位", async () => {
	// 折叠前：scrollTop=1500，锚点视口 top=100（文档位置 1600）
	const m = makeScroller({
		scrollTop: 1500,
		scrollHeight: 5000,
		clientHeight: 500,
		anchorTop: 100,
	});
	const apply = mock(() => {
		// 模拟折叠：列表总高 5000→2400，浏览器把 scrollTop clamp 到 maxScrollTop=1900
		m.setScrollHeight(2400);
		m.setScrollTop(1900);
		m.anchorTop = 1600 - 1900; // 锚点视口 top 100 → -300（顶出视口上方）
	});
	togglePreservingViewport(m.anchor, apply, 0);
	expect(apply).toHaveBeenCalled();
	await flushCompensation();
	// 帧 1：delta = -300 - 100 = -400 → scrollTop = 1900 - 400 = 1500
	expect(m.el.scrollTop).toBe(1500);
	m.el.remove();
});

test("连续校正无改善（锚点被 clamp 在文档边缘）：补偿到物理极限即止", async () => {
	const m = makeScroller({
		scrollTop: 1000,
		scrollHeight: 5000,
		clientHeight: 500,
		anchorTop: 100,
	});
	togglePreservingViewport(
		m.anchor,
		() => {
			// 折叠后剩余不足一屏：st 被 clamp 到 maxScrollTop=900
			m.setScrollHeight(1400);
			m.setScrollTop(900);
		},
		0,
	);
	await flushCompensation();
	// 锚点漂移恒 300（物理上限钳住无法回位）→ 补偿止步于 clamp 极限 900，
	// 不做额外滚动（外部滚动会触发 Virtuoso 视口重置，见 toggleViewport 注释）
	expect(m.el.scrollTop).toBe(900);
	m.el.remove();
});

test("非贴底且无漂移：补偿执行但不动 scrollTop", async () => {
	const m = makeScroller({
		scrollTop: 1000,
		scrollHeight: 5000,
		clientHeight: 500,
		anchorTop: 100,
	});
	togglePreservingViewport(
		m.anchor,
		() => {
			m.setScrollHeight(4000);
			m.setScrollTop(1000);
		},
		0,
	);
	m.anchorTop = 100; // 无漂移
	await flushCompensation();
	expect(m.el.scrollTop).toBe(1000);
	m.el.remove();
});

// Virtuoso 在内部布局收敛期间可能把视口重置到列表头（st≈0，e2e 实测）。
// 阶段 2 恢复：按折叠前记录的锚点文档位置把视口拉回。
test("Virtuoso 视口重置到列表头：按锚点文档位置恢复", async () => {
	const m = makeScroller({
		scrollTop: 1500,
		scrollHeight: 5000,
		clientHeight: 500,
		anchorTop: 100,
	});
	togglePreservingViewport(
		m.anchor,
		() => {
			// 折叠：总高骤减 → clamp 到 789；随后 Virtuoso 把视口重置到 0
			m.setScrollHeight(1291);
			m.setScrollTop(789);
			m.setScrollTop(0);
		},
		0,
	);
	await flushCompensation();
	// 阶段 2：beforeDocTop = 100 + 1500 = 1600 > 视口高 → 恢复 st = 1600 - 100 = 1500，
	// clamp 到 maxScrollTop = 1291 - 500 = 791
	expect(m.el.scrollTop).toBe(791);
	m.el.remove();
});
