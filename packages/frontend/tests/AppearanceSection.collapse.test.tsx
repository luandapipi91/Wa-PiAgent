import { beforeEach, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSection } from "../src/components/settings/AppearanceSection";
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({ collapseProcessByDefault: true });
});

test("外观页渲染「回复过程默认折叠」开关", () => {
	render(<AppearanceSection />);
	const toggle = screen.getByTestId("collapse-process-toggle");
	expect(toggle).toBeTruthy();
	expect(toggle.getAttribute("data-on")).toBe("true");
});

test("切换开关：关闭时 setCollapseProcessByDefault(false) 写入 store", () => {
	render(<AppearanceSection />);
	const toggle = screen.getByTestId("collapse-process-toggle");
	fireEvent.click(toggle);
	expect(useUiPrefsStore.getState().collapseProcessByDefault).toBe(false);
	expect(toggle.getAttribute("data-on")).toBe("false");
});

test("再次点击开关：重新开启（true）", () => {
	render(<AppearanceSection />);
	const toggle = screen.getByTestId("collapse-process-toggle");
	fireEvent.click(toggle);
	fireEvent.click(toggle);
	expect(useUiPrefsStore.getState().collapseProcessByDefault).toBe(true);
});
