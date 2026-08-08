import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "i18next";

// mock api-client：通用分区挂载时会 GET /api/settings/retry
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ retry: { maxRetries: 3, baseDelayMs: 2000 } }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { GeneralSection } from "../src/components/settings/GeneralSection";
import { useUiPrefsStore } from "../src/store/ui-prefs";

/**
 * 语言切换项（系统设置-通用）的组件契约：
 * - 渲染出 language-select 下拉，默认值为当前 store 语言
 * - 切换到 en：store.language 变 en、i18n 实例语言变 en、界面文案变英文
 * - 切换回 zh：恢复中文文案
 */
beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({ language: "zh", fontSize: 16, exportTurns: 1 });
});

test("通用分区渲染「语言」下拉，默认 zh", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	const select = screen.getByTestId("language-select") as HTMLSelectElement;
	expect(select.value).toBe("zh");
	// 选项包含 中文 / English
	expect(screen.getByText("中文")).toBeTruthy();
	expect(screen.getByText("English")).toBeTruthy();
});

test("切换到英文：store + i18n + 界面文案同步变英文", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	// 切换前标题文案为中文
	expect(screen.getByText("自动重试")).toBeTruthy();

	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "en" },
	});
	await waitFor(() => expect(useUiPrefsStore.getState().language).toBe("en"));
	expect(i18n.language).toBe("en");
	// 中文「自动重试」应消失，英文 "Auto retry" 应出现
	expect(screen.queryByText("自动重试")).toBeNull();
	expect(screen.getByText("Auto retry")).toBeTruthy();
});

test("切换回中文：界面文案恢复中文", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "en" },
	});
	await waitFor(() => expect(i18n.language).toBe("en"));
	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "zh" },
	});
	await waitFor(() => expect(i18n.language).toBe("zh"));
	expect(screen.getByText("自动重试")).toBeTruthy();
});
