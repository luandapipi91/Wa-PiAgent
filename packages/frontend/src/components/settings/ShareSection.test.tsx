// ShareSection 设置面板测试：
// 1. 默认渲染：渠道「腾讯 EdgeOne」（只读）+ Token 输入框
// 2. 输入 Token 保存 → PUT /api/settings/share（断言 body.share.token / customDomain）
// 3. 已保存 Token 时输入框脱敏展示（•••）+ 「修改」切换
// 4. 注册入口链接按语言分流（zh → /zh/products/pages；en → /products/pages）
// 5. 我的分享：列表渲染 / 删除 / 复制链接 / 立即部署 / pending 提示
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareSection } from "./ShareSection";
import { useUiPrefsStore } from "../../store/ui-prefs";

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

// share-client 整模块 mock：避免真实 transport 发请求
const shareListMock = mock();
const shareDeleteMock = mock();
const shareClearMock = mock();
const shareDeployMock = mock();
const shareRefreshLinkMock = mock();
mock.module("../../share-client", () => ({
	shareList: shareListMock,
	shareDelete: shareDeleteMock,
	shareClear: shareClearMock,
	shareDeploy: shareDeployMock,
	shareRefreshLink: shareRefreshLinkMock,
}));

const copyMock = mock();
mock.module("../../util/clipboard", () => ({
	copyToClipboard: copyMock,
	copyImageToClipboard: () => Promise.resolve(),
}));

const emptyList = { items: [], pending: 0, totalSize: 0, totalLimit: 0 };

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ share: {} }));
	putMock.mockImplementation(async () => ({}));
	shareListMock.mockReset();
	shareDeleteMock.mockReset();
	shareClearMock.mockReset();
	shareDeployMock.mockReset();
	shareRefreshLinkMock.mockReset();
	copyMock.mockReset();
	shareListMock.mockImplementation(async () => emptyList);
	shareDeleteMock.mockImplementation(async () => {});
	shareClearMock.mockImplementation(async () => {});
	shareDeployMock.mockImplementation(async () => {});
	copyMock.mockImplementation(async () => {});
	useUiPrefsStore.setState({ language: "zh" });
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
		share: { token: "edgeone-token-xyz", channel: "edgeone", customDomain: "" },
	});
});

test("已保存 Token 时输入框脱敏展示（•••）+「修改」切换", async () => {
	// mount 回填：GET /api/settings/share 返回 hasToken: true（token 不明文下发）
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "edgeone" },
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

test("注册入口链接按语言分流：zh → /zh/products/pages；en → /products/pages", async () => {
	const { unmount } = render(<ShareSection />);
	const zhLink = await screen.findByTestId("share-register-link");
	expect(zhLink.getAttribute("href")).toBe(
		"https://edgeone.ai/zh/products/pages",
	);
	expect(zhLink.getAttribute("target")).toBe("_blank");
	unmount();

	useUiPrefsStore.setState({ language: "en" });
	render(<ShareSection />);
	const enLink = await screen.findByTestId("share-register-link");
	expect(enLink.getAttribute("href")).toBe(
		"https://edgeone.ai/products/pages",
	);
});

test("我的分享：shareList 返回 2 条 → 渲染名称/大小；空列表显示 empty 文案", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
			{
				id: "s2",
				name: "proj-b",
				files: ["index.html", "a.js"],
				size: 2097152,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2099200,
		totalLimit: 104857600,
	}));
	const { unmount } = render(<ShareSection />);
	await screen.findByTestId("share-item-s1");
	expect(screen.getByTestId("share-item-s2")).toBeTruthy();
	expect(screen.getByText("proj-a")).toBeTruthy();
	expect(screen.getByText("proj-b")).toBeTruthy();
	// formatSize：2048 → 2 KB；2097152 → 2.0 MB
	expect(screen.getByText("2 KB")).toBeTruthy();
	expect(screen.getByText("2.0 MB")).toBeTruthy();
	// 非空列表显示「清空」按钮
	expect(screen.getByTestId("share-clear")).toBeTruthy();
	unmount();

	// 空列表 → empty 文案，无「清空」按钮
	shareListMock.mockImplementation(async () => emptyList);
	render(<ShareSection />);
	await screen.findByTestId("share-manage");
	expect(screen.getByText("暂无分享")).toBeTruthy();
	expect(screen.queryByTestId("share-clear")).toBeNull();
});

test("删除：点击 share-delete-<id> → shareDelete 被调 + 列表刷新", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	render(<ShareSection />);
	await screen.findByTestId("share-item-s1");
	// mount 时已调一次 shareList
	expect(shareListMock).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByTestId("share-delete-s1"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareDeleteMock).toHaveBeenCalledWith("s1");
	// 删除后重新拉取列表
	expect(shareListMock).toHaveBeenCalledTimes(2);
});

test("复制链接：点击 share-copy-<id> → shareRefreshLink 被调 + copyToClipboard 收到 url", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	shareRefreshLinkMock.mockImplementation(async () => ({
		url: "https://share.edgeone.app/s/xyz789",
		expiresAt: 1780010800000,
	}));
	render(<ShareSection />);
	await screen.findByTestId("share-item-s1");
	fireEvent.click(screen.getByTestId("share-copy-s1"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareRefreshLinkMock).toHaveBeenCalledWith("s1");
	expect(copyMock).toHaveBeenCalledWith("https://share.edgeone.app/s/xyz789");
});

test("立即部署：pending > 0 显示提示；点击 share-deploy → shareDeploy 被调", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [],
		pending: 2,
		totalSize: 0,
		totalLimit: 104857600,
	}));
	render(<ShareSection />);
	// pending 提示带插值计数
	const hint = await screen.findByTestId("share-pending");
	expect(hint.textContent).toContain("2");
	fireEvent.click(screen.getByTestId("share-deploy"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareDeployMock).toHaveBeenCalledTimes(1);
});

test("保存带 customDomain：输入域名点保存 → PUT body 含 customDomain", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.change(screen.getByTestId("share-domain-input"), {
		target: { value: "share.example.com" },
	});
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: { token: "", channel: "edgeone", customDomain: "share.example.com" },
	});
});
