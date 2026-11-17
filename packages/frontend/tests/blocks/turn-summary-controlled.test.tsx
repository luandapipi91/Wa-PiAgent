// TurnSummary 受控展开契约：完整输出模式需要由 MessageRow 同时控制摘要行与合并卡片，
// 因此 TurnSummary 必须支持可选的 open / onToggle；不传时保持原有内部 state 行为。
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TurnSummary } from "../../src/components/blocks/TurnSummary";

test("受控 open=true：children 可见，点击触发 onToggle 且不自换状态", () => {
	let called = 0;
	render(
		<TurnSummary
			steps={3}
			open
			onToggle={() => {
				called += 1;
			}}
		>
			<div>过程内容</div>
		</TurnSummary>,
	);
	expect(screen.getByText("过程内容")).toBeTruthy();
	fireEvent.click(screen.getByTestId("turn-summary"));
	expect(called).toBe(1);
	// 受控：状态由父组件决定，点击后仍保持展开
	expect(screen.getByText("过程内容")).toBeTruthy();
});

test("不传 open：保持原有内部状态行为（回归）", () => {
	render(
		<TurnSummary steps={3}>
			<div>过程内容</div>
		</TurnSummary>,
	);
	expect(screen.queryByText("过程内容")).toBeNull();
	fireEvent.click(screen.getByTestId("turn-summary"));
	expect(screen.getByText("过程内容")).toBeTruthy();
});
