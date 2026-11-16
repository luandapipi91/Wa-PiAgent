import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useUiPrefsStore, type ThemeMode } from "../../store/ui-prefs";
import { ThemePicker } from "./ThemePicker";

beforeEach(() => {
	localStorage.clear();
	document.documentElement.dataset.theme = "";
	useUiPrefsStore.setState({ themeMode: "system", themeColor: "green" });
});

test("渲染六张主题卡；当前主题标 data-active，但默认无 selected（保证强制选择可判定）", () => {
	render(<ThemePicker onConfirm={() => {}} />);
	for (const mode of ["system", "light", "dark", "newspaper", "pixel", "cyber"]) {
		expect(screen.getByTestId(`theme-card-${mode}`)).toBeTruthy();
	}
	// 当前生效主题可见，但不算用户已选：新手引导要求用户主动选一次才能下一步
	expect(screen.getByTestId("theme-card-system").dataset.active).toBe("true");
	expect(screen.getByTestId("theme-card-system").dataset.selected).toBe("false");
});

test("点卡片即生效：store 与 data-theme 同时变（刷新后不丢）", () => {
	render(<ThemePicker onConfirm={() => {}} />);
	fireEvent.click(screen.getByTestId("theme-card-pixel"));
	expect(useUiPrefsStore.getState().themeMode).toBe("pixel");
	expect(document.documentElement.dataset.theme).toBe("pixel");
});

test("确认回调返回选中主题，且主题已在点卡片时落库", () => {
	const seen: { mode?: ThemeMode } = {};
	render(
		<ThemePicker
			showConfirm
			onConfirm={(m) => {
				seen.mode = m;
			}}
		/>
	);
	fireEvent.click(screen.getByTestId("theme-card-cyber"));
	fireEvent.click(screen.getByTestId("theme-confirm"));
	expect(seen.mode).toBe("cyber");
	expect(useUiPrefsStore.getState().themeMode).toBe("cyber");
});

test("卸载（关闭弹窗）后保留已选主题，不回滚", () => {
	const { unmount } = render(<ThemePicker onConfirm={() => {}} />);
	fireEvent.click(screen.getByTestId("theme-card-newspaper"));
	unmount();
	expect(document.documentElement.dataset.theme).toBe("newspaper");
	expect(useUiPrefsStore.getState().themeMode).toBe("newspaper");
});

test("选中立即回调 onSelect（供新手引导判断能否下一步）", () => {
	const picked: string[] = [];
	render(<ThemePicker onConfirm={() => {}} onSelect={(m) => picked.push(m)} />);
	fireEvent.click(screen.getByTestId("theme-card-newspaper"));
	expect(picked).toEqual(["newspaper"]);
});

test("强调色按钮文字用 --on-accent，不写死 text-white", () => {
	render(<ThemePicker showConfirm onConfirm={() => {}} />);
	const confirm = screen.getByTestId("theme-confirm");
	expect(confirm.className).toContain("--on-accent");
	expect(confirm.className).not.toContain("text-white");
});
