// ShareSection 设置面板测试：
// 1. 默认渲染：渠道「腾讯 EdgeOne」（只读）+ Token 输入框
// 2. 输入 Token 保存 → PUT /api/settings/share（断言 body.share.token）
// 3. 已保存 Token 时输入框脱敏展示（•••）+ 「修改」切换
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareSection } from "./ShareSection";

const getMock = mock();
const putMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: putMock,
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ share: {} }));
	putMock.mockImplementation(async () => ({}));
});

test("默认渲染渠道「腾讯 EdgeOne」（只读）与 Token 输入框", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 渠道只读展示
	expect(screen.getByText("腾讯 EdgeOne")).toBeTruthy();
	// 无已保存 Token → 显示输入框
	const input = screen.getByTestId("share-token-input");
	expect(input).toBeTruthy();
	expect((input as HTMLInputElement).value).toBe("");
	// 无掩码展示
	expect(screen.queryByTestId("share-token-mask")).toBeNull();
});

test("输入 Token 保存 → PUT /api/settings/share（body.share.token）", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	const input = screen.getByTestId("share-token-input");
	fireEvent.change(input, { target: { value: "edgeone-token-xyz" } });
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: { token: "edgeone-token-xyz", channel: "edgeone" },
	});
});

test("已保存 Token 时输入框脱敏展示（•••）+「修改」切换", async () => {
	// mount 回填：GET /api/settings/share 返回已保存 token
	getMock.mockImplementation(async () => ({
		share: { token: "saved-secret-token", channel: "edgeone" },
	}));
	render(<ShareSection />);
	// 有已保存 token → 显示掩码而非输入框
	await screen.findByTestId("share-token-mask");
	expect(screen.getByText("••••••••")).toBeTruthy();
	expect(screen.queryByTestId("share-token-input")).toBeNull();
	// 点「修改」→ 切回输入框
	fireEvent.click(screen.getByTestId("share-token-modify"));
	expect(screen.getByTestId("share-token-input")).toBeTruthy();
	expect(screen.queryByTestId("share-token-mask")).toBeNull();
});
