import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

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
});

test("渲染界面主题分段控制器，默认选中「跟随系统」", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(screen.getByTestId("theme-mode-system")).toBeTruthy();
	expect(screen.getByTestId("theme-mode-system").dataset.active).toBe("true");
});

test("点击「深色」切换主题模式，data-theme 变为 dark", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.click(screen.getByTestId("theme-mode-dark"));
	expect(document.documentElement.dataset.theme).toBe("dark");
	expect(screen.getByTestId("theme-mode-dark").dataset.active).toBe("true");
	expect(screen.getByTestId("theme-mode-system").dataset.active).toBe("false");
});

test("渲染 6 个主题颜色圆点", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	const colors = ["green", "blue", "purple", "yellow", "orange", "red"];
	for (const c of colors) {
		expect(screen.getByTestId(`theme-color-${c}`)).toBeTruthy();
	}
});

test("默认选中绿色圆点", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(screen.getByTestId("theme-color-green").dataset.active).toBe("true");
});

test("点击蓝色圆点，data-accent 变为 blue", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.click(screen.getByTestId("theme-color-blue"));
	expect(document.documentElement.dataset.accent).toBe("blue");
	expect(screen.getByTestId("theme-color-blue").dataset.active).toBe("true");
	expect(screen.getByTestId("theme-color-green").dataset.active).toBe("false");
});

test("字号滑块：拖动即时生效，写入 store", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	render(<AppearanceSection />);
	const slider = screen.getByTestId("font-size-slider") as HTMLInputElement;
	expect(slider.value).toBe("16");
	fireEvent.change(slider, { target: { value: "20" } });
	expect(useUiPrefsStore.getState().fontSize).toBe(20);
});
