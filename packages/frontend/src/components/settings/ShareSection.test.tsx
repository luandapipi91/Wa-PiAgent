// ShareSection 设置面板测试：
// 1. 默认渲染：渠道选择（edgeone 选中）+ Token 输入框
// 2. 输入 Token 保存 → PUT /api/settings/share（断言 body.share.token / channel / accountId / customDomain）
// 3. 已保存 Token 时输入框脱敏展示（•••）+ 「修改」切换
// 4. 注册入口链接按语言分流（zh → /zh/products/pages；en → /products/pages）
// 5. 切换到 Cloudflare 渠道：显示 Account ID 输入框 + 注册链接 + 提示文案，保存带 accountId
// 6. 我的分享：列表渲染 / 删除 / 复制链接 / 立即部署 / pending 提示
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareSection } from "./ShareSection";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useShareProgressStore } from "../../store/share-progress";

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
const shareOpenFolderMock = mock();
const shareRenameMock = mock();
mock.module("../../share-client", () => ({
	shareList: shareListMock,
	shareDelete: shareDeleteMock,
	shareClear: shareClearMock,
	shareDeploy: shareDeployMock,
	shareRefreshLink: shareRefreshLinkMock,
	shareOpenFolder: shareOpenFolderMock,
	shareRename: shareRenameMock,
}));

const copyMock = mock();
mock.module("../../util/clipboard", () => ({
	copyToClipboard: copyMock,
	copyImageToClipboard: () => Promise.resolve(),
}));

const emptyList = {
	items: [],
	pending: 0,
	totalSize: 0,
	totalLimit: 0,
	workspaceDir: "/tmp/ws-test",
};

/** 渲染并切到「我的分享」tab（管理类用例的前置） */
async function renderSharesTab() {
	const r = render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-tab-shares"));
	await screen.findByTestId("share-manage");
	return r;
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ share: {} }));
	putMock.mockImplementation(async () => ({}));
	shareListMock.mockReset();
	shareDeleteMock.mockReset();
	shareClearMock.mockReset();
	shareRenameMock.mockReset();
	shareDeployMock.mockReset();
	shareRefreshLinkMock.mockReset();
	shareOpenFolderMock.mockReset();
	copyMock.mockReset();
	shareListMock.mockImplementation(async () => emptyList);
	shareDeleteMock.mockImplementation(async () => {});
	shareClearMock.mockImplementation(async () => {});
	shareDeployMock.mockImplementation(async () => {});
	shareOpenFolderMock.mockImplementation(async () => {});
	copyMock.mockImplementation(async () => {});
	useUiPrefsStore.setState({ language: "zh" });
	useShareProgressStore.setState({ phase: "idle", percent: 0 });
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
		share: {
			token: "edgeone-token-xyz",
			channel: "edgeone",
			accountId: "",
			customDomain: "",
		},
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
	expect(enLink.getAttribute("href")).toBe("https://edgeone.ai/products/pages");
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
	const { unmount } = await renderSharesTab();
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
	await renderSharesTab();
	expect(screen.getByText("暂无分享")).toBeTruthy();
	expect(screen.queryByTestId("share-clear")).toBeNull();
});

test("存储用量：totalLimit=0（云端无接口可查）时只显示已用量，不显示上限", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [],
		pending: 0,
		totalSize: 428000,
		totalLimit: 0,
		workspaceDir: "/tmp/ws-test",
	}));
	await renderSharesTab();
	// 只显示已用量「存储 418 KB」，不出现「/」上限或「不限」
	expect(screen.getByText(/存储 418 KB/)).toBeTruthy();
	expect(screen.queryByText(/不限/)).toBeNull();
	expect(screen.queryByText(/5.0 GB|100 MB/)).toBeNull();
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
	await renderSharesTab();
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
	await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	fireEvent.click(screen.getByTestId("share-copy-s1"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareRefreshLinkMock).toHaveBeenCalledWith("s1");
	expect(copyMock).toHaveBeenCalledWith("https://share.edgeone.app/s/xyz789");
	// 复制成功 toast 提示
	const { useToastStore } = await import("../../store/toast");
	expect(
		useToastStore.getState().toasts.some((t) => t.message === "已复制"),
	).toBe(true);
});

test("立即部署：pending > 0 显示提示；点击 share-deploy → shareDeploy 被调", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [],
		pending: 2,
		totalSize: 0,
		totalLimit: 104857600,
	}));
	await renderSharesTab();
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
		share: {
			token: "",
			channel: "edgeone",
			accountId: "",
			customDomain: "share.example.com",
		},
	});
});

test("tab 切换：默认分享设置，点「我的分享」切列表，互斥渲染", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 默认分享设置 tab：token 输入框可见，管理区不可见
	expect(screen.getByTestId("share-token-input")).toBeTruthy();
	expect(screen.queryByTestId("share-manage")).toBeNull();
	// 切到我的分享
	fireEvent.click(screen.getByTestId("share-tab-shares"));
	await screen.findByTestId("share-manage");
	expect(screen.queryByTestId("share-token-input")).toBeNull();
	// 切回分享设置
	fireEvent.click(screen.getByTestId("share-tab-settings"));
	await screen.findByTestId("share-token-input");
	expect(screen.queryByTestId("share-manage")).toBeNull();
});

test("打开分享文件夹：点击文件夹 icon → showItemInFolder 收到 workspaceDir", async () => {
	const showMock = mock(async () => true);
	(window as any).waPiApp = { showItemInFolder: showMock };
	try {
		shareListMock.mockImplementation(async () => ({
			...emptyList,
			workspaceDir: "/tmp/ws-test",
		}));
		await renderSharesTab();
		fireEvent.click(screen.getByTestId("share-open-folder"));
		await new Promise((r) => setTimeout(r, 10));
		expect(showMock).toHaveBeenCalledWith("/tmp/ws-test");
	} finally {
		delete (window as any).waPiApp;
	}
});

test("立即部署中显示进度条（uploading 阶段显示百分比文案）", async () => {
	// shareDeploy 挂起保持 deploying 态；模拟 kernel SSE 推送的 uploading 进度
	shareDeployMock.mockImplementation(() => new Promise(() => {}));
	useShareProgressStore.setState({ phase: "uploading", percent: 30 });
	await renderSharesTab();
	fireEvent.click(screen.getByTestId("share-deploy"));
	await screen.findByTestId("share-deploy-progress");
	expect(screen.getByTestId("share-deploy-progress-text").textContent).toContain(
		"30%",
	);
	expect(screen.getByTestId("progress-bar-fill").style.width).toBe("30%");
});

test("打开分享文件夹兜底：无 Electron 能力时调 kernel shareOpenFolder", async () => {
	// 不设置 window.waPiApp（浏览器/dev 场景）
	delete (window as any).waPiApp;
	shareListMock.mockImplementation(async () => ({
		...emptyList,
		workspaceDir: "/tmp/ws-test",
	}));
	await renderSharesTab();
	fireEvent.click(screen.getByTestId("share-open-folder"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareOpenFolderMock).toHaveBeenCalledTimes(1);
});

test("清空分享二次确认：弹窗确认后才调 shareClear", async () => {
	shareListMock.mockImplementation(async () => ({
		...emptyList,
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		totalSize: 2048,
	}));
	await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	// 点击清空 → 弹确认框，shareClear 未调
	fireEvent.click(screen.getByTestId("share-clear"));
	await screen.findByTestId("confirm-dialog");
	expect(shareClearMock).not.toHaveBeenCalled();
	// 取消 → 关闭弹窗不调
	fireEvent.click(screen.getByTestId("confirm-cancel"));
	await new Promise((r) => setTimeout(r, 10));
	expect(screen.queryByTestId("confirm-dialog")).toBeNull();
	expect(shareClearMock).not.toHaveBeenCalled();
	// 确认 → 调用并刷新
	fireEvent.click(screen.getByTestId("share-clear"));
	fireEvent.click(await screen.findByTestId("confirm-ok"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareClearMock).toHaveBeenCalledTimes(1);
});

test("我的分享：铅笔重命名 → 变 input → 回车保存调 shareRename", async () => {
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
	shareRenameMock.mockImplementation(async () => ({
		id: "s1",
		name: "新名字",
		files: ["index.html"],
		size: 2048,
		createdAt: 1780000000000,
	}));
	const { unmount } = await renderSharesTab();
	await screen.findByTestId("share-item-s1");

	// 点击铅笔 → input 出现（预填旧名）
	fireEvent.click(screen.getByTestId("share-rename-s1"));
	const input = screen.getByTestId("share-rename-input-s1") as HTMLInputElement;
	expect(input.value).toBe("proj-a");

	// 改值 + 回车 → 调 shareRename
	fireEvent.change(input, { target: { value: "新名字" } });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(shareRenameMock).toHaveBeenCalledWith("s1", "新名字");
	unmount();
});

test("可切换到 Cloudflare 渠道，显示 token 与 Account ID 输入，保存时带 accountId", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 渠道单选存在：edgeone（默认选中）与 cloudflare
	const edgeoneRadio = screen.getByTestId(
		"share-channel-edgeone",
	) as HTMLInputElement;
	const cfRadio = screen.getByTestId(
		"share-channel-cloudflare",
	) as HTMLInputElement;
	expect(edgeoneRadio.checked).toBe(true);
	expect(cfRadio.checked).toBe(false);
	// 默认 edgeone：无 Account ID 输入框
	expect(screen.queryByTestId("share-account-id-input")).toBeNull();
	// 切到 Cloudflare → 出现 Account ID 输入框 + 注册链接 + 提示文案
	fireEvent.click(cfRadio);
	expect(screen.getByTestId("share-account-id-input")).toBeTruthy();
	const cfLink = screen.getByTestId("share-cf-register-link");
	expect(cfLink.getAttribute("href")).toBe(
		"https://dash.cloudflare.com/sign-up",
	);
	expect(cfLink.textContent).toContain("注册 Cloudflare");
	expect(screen.getByText(/Cloudflare 分享链接永久公开/)).toBeTruthy();
	// 输入 token 与 accountId，保存 → PUT body 含 channel/token/accountId/customDomain
	fireEvent.change(screen.getByTestId("share-token-input"), {
		target: { value: "cf-token-abc" },
	});
	fireEvent.change(screen.getByTestId("share-account-id-input"), {
		target: { value: "cf-account-123" },
	});
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: {
			channel: "cloudflare",
			token: "cf-token-abc",
			accountId: "cf-account-123",
			customDomain: "",
		},
	});
});

test("我的分享：有未部署变更时按钮下方提示需部署生效", async () => {
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
		pending: 1,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	const { unmount } = await renderSharesTab();
	await screen.findByTestId("share-pending");
	// 按钮下方提示明确含「需部署生效」语义
	expect(screen.getByTestId("share-pending").textContent).toContain("未部署");
	unmount();
});
