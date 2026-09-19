// ProgressBar 组件测试：determinate 宽度 / indeterminate 动画节点 / 边界 clamp
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

test("determinate：percent 渲染对应宽度", () => {
	render(<ProgressBar percent={45} />);
	const fill = screen.getByTestId("progress-bar-fill");
	expect(fill.style.width).toBe("45%");
});

test("determinate：percent 越界 clamp 到 0-100", () => {
	const { unmount } = render(<ProgressBar percent={150} />);
	expect(screen.getByTestId("progress-bar-fill").style.width).toBe("100%");
	unmount();
	render(<ProgressBar percent={-5} />);
	expect(screen.getByTestId("progress-bar-fill").style.width).toBe("0%");
});

test("indeterminate：渲染滑动动画节点而非固定宽度", () => {
	render(<ProgressBar indeterminate />);
	expect(screen.getByTestId("progress-bar-indeterminate")).toBeTruthy();
	expect(screen.queryByTestId("progress-bar-fill")).toBeNull();
});
