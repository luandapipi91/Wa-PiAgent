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

test("浏览器启动（无 Electron 桥）：外观不渲染「桌面宠物」开关，其余设置项照常", async () => {
	// 浏览器模式没有 waPiPet 桥，桌宠建不了窗——该设置项不该出现（同「开机自启」的条件渲染范式）
	delete (window as any).waPiPet;
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(screen.queryByTestId("desktop-pet-toggle")).toBeNull();
	// 只隐藏桌宠这一项：任务完成动画与回复过程折叠仍在
	expect(screen.getByTestId("frog-task-done-toggle")).toBeTruthy();
	expect(screen.getByTestId("collapse-process-toggle")).toBeTruthy();
});

test("Electron 启动（有 waPiPet 桥）：外观渲染「桌面宠物」开关", async () => {
	const { AppearanceSection } = await import(
		"../src/components/settings/AppearanceSection"
	);
	render(<AppearanceSection />);
	expect(screen.getByTestId("desktop-pet-toggle")).toBeTruthy();
});
