import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// mock api-client：注入可断言的 get/put 行为
const apiCalls: { method: string; path: string; body?: any }[] = [];
let getResponse: any = { retry: { maxRetries: 3, baseDelayMs: 2000 } };
let putError: Error | null = null;

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			return Promise.resolve(getResponse);
		},
		post: () => Promise.resolve({}),
		put: (path: string, body?: any) => {
			apiCalls.push({ method: "put", path, body });
			return putError ? Promise.reject(putError) : Promise.resolve({});
		},
		del: () => Promise.resolve({}),
	},
}));

import { GeneralSection } from "../src/components/settings/GeneralSection";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
	apiCalls.length = 0;
	getResponse = { retry: { maxRetries: 3, baseDelayMs: 2000 } };
	putError = null;
	localStorage.clear();
	useUiPrefsStore.setState({ fontSize: 16 });
	useToastStore.setState({ toasts: [] });
});

test("文字大小滑块：显示当前字号，拖动即时更新 store 与界面缩放", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	const slider = screen.getByTestId("font-size-slider") as HTMLInputElement;
	expect(slider.value).toBe("16");
	expect(screen.getByTestId("font-size-value").textContent).toBe("16px");

	fireEvent.change(slider, { target: { value: "24" } });
	expect(useUiPrefsStore.getState().fontSize).toBe(24);
	expect(screen.getByTestId("font-size-value").textContent).toBe("24px");
	expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(
		"1.5",
	);
});

test("挂载时拉取当前配置并回填表单", async () => {
	getResponse = { retry: { maxRetries: 5, baseDelayMs: 3000 } };
	render(<GeneralSection />);
	await waitFor(() => {
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("5");
	});
	expect(
		(screen.getByTestId("retry-delay-input") as HTMLInputElement).value,
	).toBe("3"); // 3000ms → 3 秒
	expect(apiCalls.some((c) => c.path === "/api/settings/retry")).toBe(true);
});

test("修改后保存：秒换算为 ms 提交 PUT", async () => {
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	fireEvent.change(screen.getByTestId("retry-max-input"), {
		target: { value: "10" },
	});
	fireEvent.change(screen.getByTestId("retry-delay-input"), {
		target: { value: "1.5" },
	});
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => expect(screen.getByText("已保存")).toBeTruthy());
	const put = apiCalls.find((c) => c.method === "put");
	expect(put?.path).toBe("/api/settings/retry");
	expect(put?.body).toEqual({
		retry: { maxRetries: 10, baseDelayMs: 1500 },
		httpIdleTimeoutMs: 120000, // 默认 120s
	});
});

test("请求超时：加载 ms 换算为秒，保存时换算回 ms", async () => {
	getResponse = {
		retry: { maxRetries: 3, baseDelayMs: 2000 },
		httpIdleTimeoutMs: 60000, // 60s
	};
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("http-timeout-input") as HTMLInputElement).value,
		).toBe("60"),
	);
	fireEvent.change(screen.getByTestId("http-timeout-input"), {
		target: { value: "180" },
	});
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => expect(screen.getByText("已保存")).toBeTruthy());
	const put = apiCalls.find((c) => c.method === "put");
	expect(put?.body).toMatchObject({ httpIdleTimeoutMs: 180000 });
});

test("保存失败（如次数超过 10 被 kernel 拒绝）→ 用 toast 提示，不再显示 inline 报错", async () => {
	putError = new Error("重试次数需为 0-10 的整数");
	render(<GeneralSection />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("retry-max-input") as HTMLInputElement).value,
		).toBe("3"),
	);
	fireEvent.change(screen.getByTestId("retry-max-input"), {
		target: { value: "99" },
	});
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await waitFor(() => {
		// toast store 出现一条 error 条目，文案为后端错误
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(useToastStore.getState().toasts[0].type).toBe("error");
		expect(useToastStore.getState().toasts[0].message).toContain("0-10");
	});
	// 保存按钮旁不再渲染 inline 报错
	expect(screen.queryByTestId("retry-save-error")).toBeNull();
});
