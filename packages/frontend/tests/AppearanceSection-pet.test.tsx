// 外观 tab：桌面宠物开关（默认开、切换即时生效）
import { beforeEach, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { DESKTOP_PET_DEFAULT, useUiPrefsStore } from "../src/store/ui-prefs";

const calls: Array<[string, boolean]> = [];

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
	calls.length = 0;
	(window as any).waPiPet = {
		setEnabled: (v: boolean) => calls.push(["setEnabled", v]),
		celebrate: () => {},
		onEvent: () => () => {},
	};
	useUiPrefsStore.setState({
		desktopPet: DESKTOP_PET_DEFAULT,
		frogTaskDone: true,
		themeMode: "system",
		themeColor: "green",
		fontSize: 16,
		collapseProcessByDefault: true,
	});
});

test("外观 tab 渲染桌面宠物开关（默认开）", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(
		screen.getByTestId("desktop-pet-toggle").getAttribute("data-on"),
	).toBe("true");
});

test("切换桌面宠物开关：写 store + localStorage + 同步主进程，无需点保存", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	fireEvent.click(screen.getByTestId("desktop-pet-toggle"));
	expect(useUiPrefsStore.getState().desktopPet).toBe(false);
	expect(
		screen.getByTestId("desktop-pet-toggle").getAttribute("data-on"),
	).toBe("false");
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.desktopPet).toBe(false);
	expect(calls).toContainEqual(["setEnabled", false]);
});
