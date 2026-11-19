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
 * 等待「总高收敛重试」跑完：首帧读到的 scrollHeight 可能是切换前的旧值，
 * 露出新内容的动作要等布局稳定后才做（重试间隔 50ms），因此需要比 5ms 更长的窗口。
 * 250ms 仍在阶段 3（500ms 贴底解除）之前，不会把那条路径的副作用带进断言。
 *
 * 注意：只能用在「锚点位置随 scrollTop 真实变化」的 mock 上——老用例的 mock 锚点
 * 位置固定，多轮重试会一路累减到 0（那是 mock 的局限，不是实现的问题）。
 */
async function flushConverged() {
	await new Promise((r) => setTimeout(r, 250));
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

// 行为变更（2026-11-18，用户反馈）：贴底时展开「过程输出」会把卡片插在正在阅读的
// 正文上方，若按旧逻辑「贴底就不补偿」，正文会被顶出视区。现在贴底同样走锚点回位。
// 说明：本 mock 的 anchorTop 不随 scrollTop 变化，故这里只断言「切换被执行」；
// 真实的回位效果由 reply-display-mode.spec.ts 的 E2E 断言（锚点仍在视口内）。
test("贴底状态（距底 < 40px）：执行切换（补偿与否由锚点位移决定）", async () => {
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

// 回归（用户反馈）：贴底状态下展开「过程输出」，卡片插在正在阅读的正文上方。
// 用「锚点视口位置随 scrollTop 反向变化」的 mock 模拟真实布局：scrollTop 增大则锚点上移。
test("贴底状态下展开（上方插入内容）：按锚点回位，锚点视口位置不变", async () => {
	const el = document.createElement("div");
	el.setAttribute("data-virtuoso-scroller", "true");
	const anchor = document.createElement("button");
	el.appendChild(anchor);
	document.body.appendChild(el);
	let scrollTop = 860;
	let scrollHeight = 1362;
	const clientHeight = 502;
	const anchorDocTop = 1350; // 锚点文档绝对位置（固定）
	Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
	Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
	Object.defineProperty(el, "scrollTop", {
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.max(0, Math.min(v, scrollHeight - clientHeight));
		},
		configurable: true,
	});
	// 视口 top = 文档位置 - scrollTop（真实布局语义）
	anchor.getBoundingClientRect = () => new DOMRect(0, anchorDocTop - scrollTop);

	const beforeTop = anchor.getBoundingClientRect().top;
	togglePreservingViewport(
		anchor,
		() => {
			// 展开：上方插入 50px 卡片 → 文档位置下移 50、总高 +50
			scrollHeight = 1412;
			(anchor as any).__docTop = anchorDocTop + 50;
		},
		0,
	);
	// 让 getBoundingClientRect 用新文档位置
	anchor.getBoundingClientRect = () => new DOMRect(0, anchorDocTop + 50 - scrollTop);
	await flushCompensation();
	// 锚点视口位置应回到展开前的值
	expect(Math.abs(anchor.getBoundingClientRect().top - beforeTop)).toBeLessThanOrEqual(1);
	el.remove();
});

// ===== 展开后新内容必须进入视口（用户反馈：点开最后一条卡片看不到内容）=====
//
// 缺陷场景：卡片停在视口最底部，点开它 → 卡身整块长在视口下方。旧实现在锚点
// 视口位置不变时直接判定「已稳定」就收工，用户看到的是「点了没反应」。
// 期望：展开（内容增长）时，若锚点自身已在视口内但新内容溢出视口底部，
// 就把视口下移，让展开内容可见；折叠时不这么做（内容减少，保持阅读位置即可）。

/**
 * 构造与真实组件同构的布局：scroller > card（卡片盒）> button(锚点) + body（展开体）。
 * scrollTop 增大则视口内容整体上移；body 高度即「展开出来的内容」。
 * 与真实 DOM 一致：锚点的 parentElement 就是那张卡片的包围盒。
 */
function makeLayoutScroller(opts: {
	scrollTop: number;
	bodyHeight: number;
	clientHeight: number;
	anchorDocTop: number;
	anchorHeight?: number;
}) {
	const el = document.createElement("div");
	el.setAttribute("data-virtuoso-scroller", "true");
	const card = document.createElement("div");
	const anchor = document.createElement("button");
	const body = document.createElement("div");
	card.appendChild(anchor);
	card.appendChild(body);
	el.appendChild(card);
	document.body.appendChild(el);
	let scrollTop = opts.scrollTop;
	let bodyHeight = opts.bodyHeight;
	const clientHeight = opts.clientHeight;
	const anchorDocTop = opts.anchorDocTop;
	const anchorHeight = opts.anchorHeight ?? 30;
	// 文档总高：锚点前留空 + 卡片（头部 + body）+ 尾部余量
	const total = () => anchorDocTop + anchorHeight + bodyHeight + 200;
	Object.defineProperty(el, "scrollHeight", { get: () => total(), configurable: true });
	Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
	Object.defineProperty(el, "scrollTop", {
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.max(0, Math.min(v, total() - clientHeight));
		},
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight0", { value: 0, configurable: true });
	// 视口矩形：scroller 固定在文档 y=0..clientHeight
	el.getBoundingClientRect = () => new DOMRect(0, 0, 800, clientHeight);
	anchor.getBoundingClientRect = () => new DOMRect(0, anchorDocTop - scrollTop, 800, anchorHeight);
	// 卡片盒 = 锚点 + body
	card.getBoundingClientRect = () =>
		new DOMRect(0, anchorDocTop - scrollTop, 800, anchorHeight + bodyHeight);
	return {
		el,
		anchor,
		card,
		get scrollTop() {
			return scrollTop;
		},
		setBodyHeight: (h: number) => {
			bodyHeight = h;
		},
		/** 卡片（含展开体）底边在视口里的 y 坐标 */
		contentBottom: () => anchorDocTop + anchorHeight + bodyHeight - scrollTop,
	};
}

test("展开后内容溢出视口底部：视口下移让新内容可见", async () => {
	const m = makeLayoutScroller({
		scrollTop: 1000,
		bodyHeight: 0, // 折叠态：没有卡身
		clientHeight: 500,
		anchorDocTop: 1400, // 锚点视口 top = 400（贴近视口底部 500）
	});
	expect(m.contentBottom()).toBeLessThanOrEqual(500);

	togglePreservingViewport(m.anchor, () => m.setBodyHeight(400), 0);
	await flushConverged();
	// 展开出 400px 卡身 → 必须滚下去让它可见（而不是停在原地只保证锚点不动）
	expect(m.contentBottom()).toBeLessThanOrEqual(500 + 1);
	// 卡片头部仍不得被顶出视口上沿
	expect(m.anchor.getBoundingClientRect().top).toBeGreaterThanOrEqual(-1);

	m.el.remove();
});

test("折叠时不额外滚动（内容变少，保持阅读位置）", async () => {
	const m = makeLayoutScroller({
		scrollTop: 1000,
		bodyHeight: 400,
		clientHeight: 500,
		anchorDocTop: 1400,
	});
	const before = m.scrollTop;
	togglePreservingViewport(m.anchor, () => m.setBodyHeight(0), 0);
	await flushConverged();
	// 折叠不改变 scrollTop（锚点文档位置未变，不该为「让内容可见」再滚）
	expect(m.scrollTop).toBe(before);

	m.el.remove();
});

test("展开后内容本就在视口内：不做无谓滚动", async () => {
	const m = makeLayoutScroller({
		scrollTop: 1000,
		bodyHeight: 0,
		clientHeight: 500,
		anchorDocTop: 800, // 锚点视口 top = -200（已在视口上方）
	});
	const before = m.scrollTop;
	togglePreservingViewport(m.anchor, () => m.setBodyHeight(300), 0);
	await flushConverged();
	expect(m.scrollTop).toBe(before);

	m.el.remove();
});
