import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useUiPrefsStore } from "../src/store/ui-prefs";

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
	// 显式重置 store 内存状态，避免测试间共享单例导致依赖执行顺序
	useUiPrefsStore.setState({
		themeMode: "system",
		themeColor: "green",
		fontSize: 16,
	});
});

test("主题控件是 select，渲染 6 个选项且默认「跟随系统」", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	const select = screen.getByTestId("theme-mode-select") as HTMLSelectElement;
	expect(select.tagName).toBe("SELECT");
	expect(select.value).toBe("system");
	const values = Array.from(select.options).map((o) => o.value);
	expect(values).toEqual([
		"system",
		"light",
		"dark",
		"newspaper",
		"pixel",
		"cyber",
	]);
});

test("选择「深色」后 data-theme 变为 dark", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.change(screen.getByTestId("theme-mode-select"), {
		target: { value: "dark" },
	});
	expect(document.documentElement.dataset.theme).toBe("dark");
});

test("选择「像素」后 data-theme 为 pixel", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.change(screen.getByTestId("theme-mode-select"), {
		target: { value: "pixel" },
	});
	expect(document.documentElement.dataset.theme).toBe("pixel");
	expect(useUiPrefsStore.getState().themeMode).toBe("pixel");
});

test("新主题下 6 个色点禁用，切回浅色后恢复", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.change(screen.getByTestId("theme-mode-select"), {
		target: { value: "cyber" },
	});
	for (const c of ["green", "blue", "purple", "yellow", "orange", "red"]) {
		expect(
			(screen.getByTestId(`theme-color-${c}`) as HTMLButtonElement).disabled
		).toBe(true);
	}
	fireEvent.change(screen.getByTestId("theme-mode-select"), {
		target: { value: "light" },
	});
	expect(
		(screen.getByTestId("theme-color-blue") as HTMLButtonElement).disabled
	).toBe(false);
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
	expect(screen.getByTestId("font-size-value").textContent).toBe("20px");
});
