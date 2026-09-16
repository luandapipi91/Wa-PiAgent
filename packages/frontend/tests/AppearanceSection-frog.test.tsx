// 任务完成青蛙动画开关：外观 tab（AppearanceSection）
import { beforeEach, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { FROG_TASK_DONE_DEFAULT, useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});
	document.documentElement.dataset.theme = "";
	document.documentElement.dataset.accent = "";
	localStorage.clear();
	useUiPrefsStore.setState({
		frogTaskDone: FROG_TASK_DONE_DEFAULT,
		themeMode: "system",
		themeColor: "green",
		fontSize: 16,
		collapseProcessByDefault: true,
	});
});

test("外观 tab 渲染任务完成动画开关（默认开）", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(
		screen.getByTestId("frog-task-done-toggle").getAttribute("data-on"),
	).toBe("true");
});

test("切换任务完成动画开关：即时写入 store 并持久化，无需点保存", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.click(screen.getByTestId("frog-task-done-toggle"));
	expect(useUiPrefsStore.getState().frogTaskDone).toBe(false);
	expect(
		screen.getByTestId("frog-task-done-toggle").getAttribute("data-on"),
	).toBe("false");
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.frogTaskDone).toBe(false);
});
