// MultiSelect — 主题化多选下拉（替代「一长排复选框」的绑定区）。
//
// 关键契约：
//  1. 收起态单行摘要：已选项按「、」拼接，超出用 truncate 省略号；未选显示占位文案；
//  2. 摘要只按 options 顺序、忽略已失效的 id（清单里没有的选中值不进摘要）；
//  3. 展开面板 = 复选行（label + 描述 + 状态），点行切换但不收起（多选）；
//  4. 外部点击 / Esc 收起；disabled 时不展开。
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MultiSelect, type MultiSelectOption } from "./MultiSelect";

const OPTIONS: MultiSelectOption[] = [
	{ value: "kb_1", label: "产品知识库", description: "产品定价与规格", meta: "就绪" },
	{ value: "kb_2", label: "研发知识库", description: "架构决策记录", meta: "就绪" },
	{ value: "kb_3", label: "运营知识库", description: "活动复盘", meta: "索引完成后可检索" },
];

const renderSelect = (props: Partial<Parameters<typeof MultiSelect>[0]> = {}) =>
	render(
		<MultiSelect
			testId="kb-bind"
			ariaLabel="关联知识库"
			options={OPTIONS}
			selected={[]}
			onToggle={mock()}
			placeholder="选择知识库"
			{...props}
		/>,
	);

beforeEach(() => cleanup());

describe("MultiSelect 收起态摘要", () => {
	test("未选中显示占位文案（tertiary），且不带 truncate 以外的换行", () => {
		renderSelect();
		const summary = screen.getByTestId("kb-bind-summary");
		expect(summary.textContent).toBe("选择知识库");
		expect(summary.className).toContain("truncate");
		expect(summary.className).toContain("text-tertiary");
	});

	test("多选按「、」拼接成单行，靠 truncate 出省略号", () => {
		renderSelect({ selected: ["kb_1", "kb_2", "kb_3"] });
		const summary = screen.getByTestId("kb-bind-summary");
		expect(summary.textContent).toBe("产品知识库、研发知识库、运营知识库");
		// 单行省略：truncate（overflow-hidden + text-overflow ellipsis + whitespace-nowrap）
		expect(summary.className).toContain("truncate");
		expect(summary.className).toContain("min-w-0");
		expect(summary.className).toContain("text-primary");
	});

	test("摘要顺序跟 options 一致，忽略清单里已不存在的选中 id", () => {
		renderSelect({ selected: ["kb_2", "kb_gone", "kb_1"] });
		expect(screen.getByTestId("kb-bind-summary").textContent).toBe(
			"产品知识库、研发知识库",
		);
	});

	test("摘要挂 title：省略后悬停可看全量", () => {
		renderSelect({ selected: ["kb_1", "kb_2"] });
		expect(screen.getByTestId("kb-bind-summary").getAttribute("title")).toBe(
			"产品知识库、研发知识库",
		);
	});
});

describe("MultiSelect 展开面板", () => {
	test("默认收起；点触发器展开出复选行（名称/描述/状态）", () => {
		renderSelect();
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		const panel = screen.getByTestId("kb-bind-panel");
		expect(panel.textContent).toContain("产品知识库");
		expect(panel.textContent).toContain("产品定价与规格");
		expect(panel.textContent).toContain("索引完成后可检索");
		expect(screen.getByTestId("kb-bind-check-kb_2")).toBeTruthy();
	});

	test("已选项打勾；点行回调 onToggle 且面板保持展开（多选）", () => {
		const onToggle = mock();
		renderSelect({ selected: ["kb_1"], onToggle });
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		expect(
			(screen.getByTestId("kb-bind-check-kb_1") as HTMLInputElement).checked,
		).toBe(true);
		fireEvent.click(screen.getByTestId("kb-bind-check-kb_2"));
		expect(onToggle).toHaveBeenCalledWith("kb_2");
		expect(screen.getByTestId("kb-bind-panel")).toBeTruthy();
	});

	test("再次点触发器收起", () => {
		renderSelect();
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
	});

	test("Esc 收起，外部 mousedown 收起", () => {
		renderSelect();
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();

		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
	});

	test("Esc 不外泄给宿主弹窗（Modal 的 window 冒泡监听收不到）", () => {
		const hostClose = mock();
		window.addEventListener("keydown", hostClose);
		renderSelect();
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
		expect(hostClose).not.toHaveBeenCalled();
		window.removeEventListener("keydown", hostClose);
	});

	test("清单为空时不展开空面板（状态由宿主在触发器下方说明）", () => {
		renderSelect({ options: [] });
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
	});

	test("disabled：不展开面板", () => {
		renderSelect({ disabled: true });
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		expect(screen.queryByTestId("kb-bind-panel")).toBeNull();
	});

	test("hint 渲染在面板顶部（受限模式提示随面板出现）", () => {
		renderSelect({ hint: "绑定知识库将自动启用搜索工具" });
		expect(screen.queryByText(/自动启用搜索工具/)).toBeNull();
		fireEvent.click(screen.getByTestId("kb-bind-trigger"));
		expect(screen.getByTestId("kb-bind-hint").textContent).toContain(
			"自动启用搜索工具",
		);
	});
});
