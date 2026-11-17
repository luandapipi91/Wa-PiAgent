// OutputsCard 契约：一个外框卡片装多段正式输出，段间细虚线分割；
// 卡片自身不套二级气泡（不使用 rounded-lg 等气泡圆角/背景语义），避免双层边框。
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { OutputsCard } from "../../src/components/blocks/OutputsCard";

test("OutputsCard：外框卡片内装多段，段间有分割，不套内层气泡", () => {
	render(
		<OutputsCard>
			<div data-testid="seg-1">第一段</div>
			<div data-testid="seg-2">第二段</div>
		</OutputsCard>,
	);
	const card = screen.getByTestId("outputs-card");
	expect(card.contains(screen.getByTestId("seg-1"))).toBe(true);
	expect(card.contains(screen.getByTestId("seg-2"))).toBe(true);
	// 外框 + 段间分割
	expect(card.className).toContain("border-hairline");
	expect(card.className).toContain("[&>*+*]:border-t");
	// 不使用气泡圆角类，避免卡片内再套一层气泡边框
	expect(card.className).not.toContain("rounded-lg");
});
