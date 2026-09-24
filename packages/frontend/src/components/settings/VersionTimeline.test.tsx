import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { VersionTimeline } from "./VersionTimeline";
import versionHistory from "../../data/version-history.json";
import { countItems, type VersionEntry } from "../../util/version-history";

const entries = versionHistory as VersionEntry[];
/** 折叠态展示的条目数（跨分类累计）。刻意写字面量而非从实现导出：独立表达验收标准，实现改坏了测试才会红 */
const COLLAPSED_ITEMS = 4;
/** 数据驱动：找第一个条目数 > 4 的版本（折叠展开用例），发新版后不会腐坏 */
const big = entries.find((e) => countItems(e) > 4)!;

beforeEach(() => {
	localStorage.clear();
	cleanup();
});
afterEach(() => cleanup());

test("分栏渲染：左列版本列表 + 右列详情，最新版默认选中", () => {
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	const list = within(timeline).getByTestId("version-history-list");
	const detail = within(timeline).getByTestId("version-history-detail");
	expect(list).toBeTruthy();
	expect(detail).toBeTruthy();
	expect(within(list).getByText(`v${entries[0].version}`)).toBeTruthy();
	expect(within(detail).getByText(`v${entries[0].version}`)).toBeTruthy();
	// 详情默认折叠，分类标签属于被折叠的条目；先展开再断言，否则最新版条目变多后该用例会随发版腐坏
	const expand = within(detail).queryByTestId("expand-all");
	if (expand) fireEvent.click(expand);
	for (const category of Object.keys(entries[0].sections)) {
		expect(within(detail).getByText(category)).toBeTruthy();
	}
});

test("旧版本初始不展示内容，点击左列版本切换详情", () => {
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	expect(within(timeline).queryByText(/主会话回合看门狗/)).toBeNull();
	fireEvent.click(within(timeline).getByTestId("toggle-0.1.20"));
	expect(within(timeline).getByText(/主会话回合看门狗/)).toBeTruthy();
});

test("条目超 4 项时折叠为「展开全部 N 项」，点击后全部可见", () => {
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	fireEvent.click(within(timeline).getByTestId(`toggle-${big.version}`));
	const detail = within(timeline).getByTestId("version-history-detail");
	const total = countItems(big);
	expect(within(timeline).getByText(`展开全部 ${total} 项`)).toBeTruthy();
	// 折叠态可见条目恰为 4 条（跨分类累计，不是每个分类各 4 条）
	expect(within(detail).queryAllByRole("listitem")).toHaveLength(COLLAPSED_ITEMS);
	// 折叠态：某条靠后的条目不可见
	const allItems = Object.values(big.sections).flat() as string[];
	const lastItem = allItems[allItems.length - 1];
	expect(within(timeline).queryByText(lastItem)).toBeNull();
	fireEvent.click(within(timeline).getByTestId("expand-all"));
	expect(within(detail).queryAllByRole("listitem")).toHaveLength(total);
	expect(within(timeline).getByText(lastItem)).toBeTruthy();
	expect(within(timeline).getByText("收起")).toBeTruthy();
});

test("条目数不超过 4 的版本不出现展开按钮", () => {
	const small = entries.find((e) => countItems(e) > 0 && countItems(e) <= 4)!;
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	fireEvent.click(within(timeline).getByTestId(`toggle-${small.version}`));
	expect(within(timeline).queryByTestId("expand-all")).toBeNull();
});

test("maxEntries 截断：超出部分不渲染", () => {
	const latest = entries[0];
	const second = entries[1];
	const third = entries[2];
	const { container } = render(<VersionTimeline maxEntries={2} />);
	const timeline = within(container).getByTestId("version-timeline");
	const list = within(timeline).getByTestId("version-history-list");
	expect(within(list).getByText(`v${latest.version}`)).toBeTruthy();
	expect(within(list).getByText(`v${second.version}`)).toBeTruthy();
	expect(within(list).queryByText(`v${third.version}`)).toBeNull();
});
