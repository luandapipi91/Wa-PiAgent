import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagnosticsSection } from "../src/components/settings/DiagnosticsSection";
import { useDiagnosticsStore } from "../src/store/diagnostics";

beforeEach(() => {
	useDiagnosticsStore.setState({ entries: [] });
});

test("空列表显示「暂无扩展错误」", () => {
	render(<DiagnosticsSection />);
	expect(screen.getByText("暂无扩展错误")).toBeTruthy();
});

test("渲染错误条目（时间/扩展/事件/错误），清空按钮清除全部", () => {
	useDiagnosticsStore.getState().add({
		extension: "pi-lens",
		event: "tool_call",
		error: "ENOENT: no such file",
	});
	useDiagnosticsStore.getState().add({
		extension: "pi-goal",
		event: "agent_end",
		error: "timeout",
	});
	render(<DiagnosticsSection />);
	const rows = screen.getAllByTestId("diag-row");
	expect(rows).toHaveLength(2);
	// 新条目在前
	expect(rows[0].textContent).toContain("pi-goal");
	expect(rows[1].textContent).toContain("ENOENT");

	fireEvent.click(screen.getByTestId("diag-clear-btn"));
	expect(useDiagnosticsStore.getState().entries).toHaveLength(0);
});
