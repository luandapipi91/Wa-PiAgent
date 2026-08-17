// ShareButton 交互测试：点击按钮 → 打开弹层 → 检查 token → 生成分享链接 →
// 显示 URL / 复制按钮 / 有效期；未配置 token 显示引导；复制走 util/clipboard。
// share-client 与 clipboard 整模块 mock（bun mock.module 路径须与组件 import 一致）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

const shareSettingsMock = mock(
	async () => ({ token: "edgeone-token", channel: "edgeone" }),
);
const shareUploadMock = mock(async () => ({}));
const copyMock = mock(async (..._args: any[]) => {});

mock.module("../../share-client", () => ({
	shareSettings: shareSettingsMock,
	shareUpload: shareUploadMock,
	saveShareSettings: async () => {},
}));
mock.module("../../util/clipboard", () => ({
	copyToClipboard: copyMock,
	copyImageToClipboard: async () => {},
}));

import { ShareButton } from "./ShareButton";

const PATHS = ["/proj/a.txt", "/proj/b.txt", "/proj/c.txt"];
const URL = "https://share.edgeone.app/s/xyz789";

beforeEach(() => {
	shareSettingsMock.mockReset();
	shareUploadMock.mockReset();
	copyMock.mockReset();
	shareSettingsMock.mockResolvedValue({
		token: "edgeone-token",
		channel: "edgeone",
	});
	shareUploadMock.mockResolvedValue({
		url: URL,
		expiresAt: Date.now() + 3 * 3600 * 1000,
		projectName: "proj",
		channel: "edgeone",
	});
});

test("点击按钮打开弹层：显示文件数与首几个文件名 + 生成按钮", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByText("3 个文件");
	expect(screen.getByTestId("share-result-modal")).toBeTruthy();
	expect(screen.getByText("a.txt")).toBeTruthy();
	expect(screen.getByText("b.txt")).toBeTruthy();
	expect(screen.getByText("c.txt")).toBeTruthy();
	expect(screen.getByTestId("share-generate-btn")).toBeTruthy();
});

test("生成分享链接：显示 URL + 复制按钮 + 「3 小时内有效」", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	expect(shareUploadMock).toHaveBeenCalledWith(PATHS, undefined);
	expect(screen.getByTestId("share-url").textContent).toContain(URL);
	expect(screen.getByTestId("share-copy-btn")).toBeTruthy();
	expect(screen.getByTestId("share-expires").textContent).toContain(
		"3 小时内有效",
	);
});

test("未配置 token：显示「请先在 设置 → 分享 配置 Token」且无生成按钮", async () => {
	shareSettingsMock.mockResolvedValue({ token: "", channel: "edgeone" });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-no-token");
	expect(screen.getByText("请先在 设置 → 分享 配置 Token")).toBeTruthy();
	expect(screen.queryByTestId("share-generate-btn")).toBeNull();
});

test("复制链接：copyToClipboard 收到分享 URL", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-copy-btn");
	fireEvent.click(screen.getByTestId("share-copy-btn"));
	await new Promise((r) => setTimeout(r, 10));
	expect(copyMock).toHaveBeenCalledWith(URL);
});
