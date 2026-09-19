// DatePickerButton 组件测试：受控 props 契约（from/to 外部持有，onChange 上报）
// bun:test + @testing-library/react；DayPicker 日期格的 aria-label 由 zhCN locale 生成
import { describe, test, expect, afterAll, jest } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { DatePickerButton } from "../src/components/memory/DatePickerButton";

describe("DatePickerButton", () => {
	// 锚定系统时间到 2026-09：组件默认月取 new Date()，日期格 aria-label 含当月；不锚定则 2026-10 起用例必挂
	// 注意：锚定日不能是 1 日/15 日（当天格子 label 会带 zhCN 的「今天，」前缀，破坏 ^前缀查找），
	// 故选 9 月 8 日；Windows 下 Bun.setSystemTime 未实现，改用 bun:test 内建 jest 假时钟，语义等价
	jest.useFakeTimers();
	jest.setSystemTime(new Date("2026-09-08T00:00:00"));
	afterAll(() => {
		jest.useRealTimers(); // 还原真实时间，避免污染其他测试文件
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
});
