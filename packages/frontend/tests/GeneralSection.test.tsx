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

beforeEach(() => {
	apiCalls.length = 0;
	getResponse = { retry: { maxRetries: 3, baseDelayMs: 2000 } };
	putError = null;
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
	});
});

test("保存失败（如次数超过 10 被 kernel 拒绝）→ 展示错误文案", async () => {
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
	await waitFor(() =>
		expect(screen.getByTestId("retry-save-error").textContent).toContain(
			"0-10",
		),
	);
});
