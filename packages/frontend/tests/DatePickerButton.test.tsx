// DatePickerButton 组件测试：受控 props 契约（from/to 外部持有，onChange 上报）
// bun:test + @testing-library/react；DayPicker 日期格的 aria-label 由 DayPicker locale 生成
import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { DatePickerButton } from "../src/components/memory/DatePickerButton";

describe("DatePickerButton", () => {
	// 锚定系统时间到 2026-09：组件默认月取 new Date()，日期格 aria-label 含当月；不锚定则 2026-10 起用例必挂
	// 注意：锚定日不能是 1 日/15 日（当天格子 label 会带 zhCN 的「今天，」前缀，破坏 ^前缀查找），
	// 故选 9 月 8 日；Windows 下 Bun.setSystemTime 未实现，改用 bun:test 内建 jest 假时钟，语义等价
	jest.useFakeTimers();
	jest.setSystemTime(new Date("2026-09-08T00:00:00"));
	// 锁定界面语言为 zh：测试环境 localStorage 为空、bun 的 navigator.language 可能是 en，
	// detectInitialLanguage 的初值不确定；运行时显式 changeLanguage（不依赖模块求值时序），
	// 保证前三个用例锚定的 zhCN aria-label 稳定
	beforeAll(async () => {
		await i18next.changeLanguage("zh");
	});
	afterAll(async () => {
		jest.useRealTimers(); // 还原真实时间，避免污染其他测试文件
		await i18next.changeLanguage("zh"); // 还原语言（en 用例切走了）
	});

	test("点击按钮弹出日历，选择范围后确定回调 YYYY-MM-DD", () => {
		let got: [string | null, string | null] = [null, null];
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={(f, t) => { got = [f, t]; }} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		expect(getByTestId("memory-date-pop")).toBeTruthy(); // 项目未装 jest-dom，不用 toBeInTheDocument
		// 点两个日期格（aria-label 由 zhCN locale 生成：「2026年9月1日 星期二」格式）
		const day = (label: string) =>
			getByTestId("memory-date-pop").querySelector(`button[aria-label^="${label}"]`)!;
		fireEvent.click(day("2026年9月1日"));
		fireEvent.click(day("2026年9月15日"));
		fireEvent.click(getByTestId("memory-date-ok"));
		expect(got[0]).toMatch(/^\d{4}-09-01$/);
		expect(got[1]).toMatch(/^\d{4}-09-15$/);
	});

	test("快捷片「近 7 天」直接填充并回调", () => {
		let got: [string | null, string | null] = [null, null];
		const { getByTestId, getByText } = render(
			<DatePickerButton from={null} to={null} onChange={(f, t) => { got = [f, t]; }} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		fireEvent.click(getByText("近 7 天"));
		fireEvent.click(getByTestId("memory-date-ok"));
		expect(got[0]).toBeTruthy();
		expect(got[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("清除按钮回调 (null, null)", () => {
		let got: [string | null, string | null] = ["2026-09-01", "2026-09-15"] as never;
		const { getByTestId } = render(
			<DatePickerButton from="2026-09-01" to="2026-09-15" onChange={(f, t) => { got = [f, t]; }} />,
		);
		fireEvent.click(getByTestId("memory-date-clear"));
		expect(got).toEqual([null, null]);
	});

	test("英文界面下日历月名/日期 label 跟随 enUS", async () => {
		await i18next.changeLanguage("en");
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		const pop = getByTestId("memory-date-pop");
		// 真实 label（探针实测）：grid aria-label 为 "September 2026"；
		// 日期格 aria-label 为 "Tuesday, September 1st, 2026" 格式（enUS 默认格式化）
		const grid = pop.querySelector("[role=grid]")!;
		expect(grid.getAttribute("aria-label")).toBe("September 2026");
		const sep1 = pop.querySelector('button[aria-label^="Tuesday, September 1st, 2026"]');
		expect(sep1).toBeTruthy();
	});
});

// 弹层边界（用户报「选择器超出边界」）：锚点在页面右上角时，弹层向右溢出被
// MemoryPage 根容器的 overflow:hidden 裁掉，底部同样被截。修法对齐项目既有范式
// （AgentDropdown）：portal 到 body 逃逸裁剪 + fixed 定位 + 右溢出左移 + 底部翻转。
describe("DatePickerButton 弹层边界", () => {
	const origW = window.innerWidth;
	const origH = window.innerHeight;
	const origBtnRect = HTMLButtonElement.prototype.getBoundingClientRect;
	const origDivRect = HTMLDivElement.prototype.getBoundingClientRect;

	afterEach(() => {
		HTMLButtonElement.prototype.getBoundingClientRect = origBtnRect;
		HTMLDivElement.prototype.getBoundingClientRect = origDivRect;
		Object.defineProperty(window, "innerWidth", { value: origW, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: origH, configurable: true });
	});

	/** happy-dom 无布局引擎，getBoundingClientRect 恒为 0 → 按原型分别注入按钮(pill)与弹层(div)矩形 */
	function setupGeom(o: {
		vw: number;
		vh: number;
		pillLeft: number;
		pillTop: number;
		popW: number;
		popH: number;
	}) {
		Object.defineProperty(window, "innerWidth", { value: o.vw, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: o.vh, configurable: true });
		const rect = (left: number, top: number, width: number, height: number) =>
			({
				left,
				top,
				width,
				height,
				right: left + width,
				bottom: top + height,
				x: left,
				y: top,
				toJSON: () => ({}),
			}) as DOMRect;
		const pill = rect(o.pillLeft, o.pillTop, 100, 30);
		const pop = rect(0, 0, o.popW, o.popH);
		HTMLButtonElement.prototype.getBoundingClientRect = () => pill;
		HTMLDivElement.prototype.getBoundingClientRect = () => pop;
	}

	test("弹层 portal 到 body，脱离 memory-page 的 overflow:hidden 裁剪", () => {
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		const pop = getByTestId("memory-date-pop");
		expect(pop.parentElement).toBe(document.body);
	});

	test("空间充足时贴按钮左缘、向下展开 6px", () => {
		setupGeom({ vw: 1600, vh: 1000, pillLeft: 100, pillTop: 100, popW: 508, popH: 400 });
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		const pop = getByTestId("memory-date-pop");
		expect(pop.style.left).toBe("100px");
		expect(pop.style.top).toBe("136px"); // pillTop 100 + 高 30 + 间距 6
	});

	test("右侧溢出时水平钳制进视口（不再超出窗口右边界）", () => {
		// 视口 1024：pill 左缘 900、弹层宽 508 → 900+508=1408 > 1024-8，应左移
		setupGeom({ vw: 1024, vh: 1000, pillLeft: 900, pillTop: 100, popW: 508, popH: 400 });
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		const pop = getByTestId("memory-date-pop");
		expect(pop.style.left).toBe("508px"); // 1024 - 8 - 508
		expect(parseInt(pop.style.left, 10) + 508).toBeLessThanOrEqual(1024 - 8);
	});

	test("底部空间不足时向上翻转（不再被下边界截断）", () => {
		// 视口高 500：pill 下缘 130 + 6 + 高 400 = 536 > 500-8 → 翻到 pill 上方
		setupGeom({ vw: 1600, vh: 500, pillLeft: 100, pillTop: 100, popW: 508, popH: 400 });
		const { getByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		const pop = getByTestId("memory-date-pop");
		// pillTop 100 - 高 400 - 间距 6 = -306 → 贴视口上缘 8
		expect(pop.style.top).toBe("8px");
	});

	test("点击弹层内部不关闭（弹层 portal 出 wrapRef 子树后的回归防线）", () => {
		const { getByTestId, queryByTestId } = render(
			<DatePickerButton from={null} to={null} onChange={() => {}} />,
		);
		fireEvent.click(getByTestId("memory-date-btn"));
		fireEvent.mouseDown(getByTestId("memory-date-pop"));
		expect(queryByTestId("memory-date-pop")).toBeTruthy();
		// 点击真正的组件外部仍要关闭
		fireEvent.mouseDown(document.body);
		expect(queryByTestId("memory-date-pop")).toBeNull();
	});
});
