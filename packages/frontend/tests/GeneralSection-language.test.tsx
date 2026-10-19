import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "i18next";

// mock api-client：通用分区挂载时会 GET /api/settings/retry，保存时 PUT
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
 * 语言切换项（系统设置-通用）的组件契约（草稿态，保存后生效）：
 * - 渲染出 language-select 下拉，默认值为当前 store 语言
 * - select 改草稿值，但 store/i18n 不立即变化（关闭窗口还原）
 * - 点「保存」后：store.language 生效、i18n 实例语言变、界面文案变英文
 * - 切回中文：select 改回中文 + 保存 → 恢复中文文案
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

test("select 改英文但未保存：草稿值变，store/i18n 不变（关闭还原）", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	// select 改英文：草稿值变，但 store/i18n 不立即变
	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "en" },
	});
	const select = screen.getByTestId("language-select") as HTMLSelectElement;
	expect(select.value).toBe("en");
	expect(useUiPrefsStore.getState().language).toBe("zh");
	expect(i18n.language).toBe("zh");
	// 界面仍是中文
	expect(screen.getByText("自动重试")).toBeTruthy();
});

test("切换到英文 + 点保存：store + i18n + 界面文案变英文", async () => {
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
	// 点保存：语言随重试配置一起提交生效
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => expect(useUiPrefsStore.getState().language).toBe("en"));
	expect(i18n.language).toBe("en");
	// 中文「自动重试」应消失，英文 "Auto retry" 应出现
	await waitFor(() => expect(screen.getByText("Auto retry")).toBeTruthy());
	expect(screen.queryByText("自动重试")).toBeNull();
});

test("切回中文 + 保存：界面文案恢复中文", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	// 先切英文并保存
	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "en" },
	});
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => expect(i18n.language).toBe("en"));
	// 切回中文并保存
	fireEvent.change(screen.getByTestId("language-select"), {
		target: { value: "zh" },
	});
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => expect(i18n.language).toBe("zh"));
	expect(screen.getByText("自动重试")).toBeTruthy();
});
